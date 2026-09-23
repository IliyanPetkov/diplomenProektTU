// =====================================================================
// Object Storage Microservice & Upload Lifecycle Engine
// Порт: 8083 | Стрийминг без буфериране в RAM, SHA-256 хеширане и излишък
// =====================================================================

const { MicroserviceApp } = require('../../common/httpServer');
const { db } = require('../../common/db');
const { storageEngine } = require('./redundantStorageEngine');
const { generateUuid } = require('../../common/crypto');
const { auditClient } = require('../../common/auditClient');
const { defaultRegistry } = require('../../common/metrics');
const {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  QuotaExceededError,
  AppError,
} = require('../../common/errors');

const app = new MicroserviceApp('storage-service');
const PORT = parseInt(process.env.PORT_STORAGE || '8083', 10);

// 1. Инициализиране на качване (Upload Lifecycle: INITIATED)
app.post('/upload/init', async ({ user, body, req, correlationId }) => {
  const filename = (body.filename || '').trim();
  const expectedSize = parseInt(body.sizeBytes, 10);
  const mimeType = body.mimeType || 'application/octet-stream';
  const targetFolderId = body.folderId || null;

  if (!filename || isNaN(expectedSize) || expectedSize < 0) {
    throw new AppError('Невалидно име или размер на файла', 400, 'VALIDATION_ERROR');
  }

  // Проверка на потребителската дискова квота
  const userInfo = await db.queryOne('SELECT quota_bytes, used_bytes FROM users WHERE id = $1', [user.sub]);
  if (!userInfo) throw new NotFoundError('Потребителят не съществува');

  const availableBytes = Number(userInfo.quota_bytes) - Number(userInfo.used_bytes);
  if (expectedSize > availableBytes) {
    await auditClient.log({
      actorId: user.sub,
      actorRole: user.role,
      action: 'UPLOAD_QUOTA_EXCEEDED',
      targetType: 'file',
      result: 'FAILURE',
      ipAddress: req.socket.remoteAddress,
      correlationId,
      details: { filename, expectedSize, availableBytes }
    });
    throw new QuotaExceededError(`Недостатъчно свободно дисково пространство. Налични: ${(availableBytes / (1024*1024)).toFixed(2)} MB`);
  }

  const uploadId = generateUuid();
  const tempStorageKey = `temp/${user.sub}/${uploadId}_${filename}`;

  await db.query(
    `INSERT INTO upload_sessions (id, user_id, target_folder_id, filename, expected_size_bytes, mime_type, status, temp_storage_key)
     VALUES ($1, $2, $3, $4, $5, $6, 'INITIATED', $7)`,
    [uploadId, user.sub, targetFolderId, filename, expectedSize, mimeType, tempStorageKey]
  );

  return {
    uploadId,
    tempStorageKey,
    status: 'INITIATED',
    expectedSizeBytes: expectedSize,
  };
}, { authRequired: true });

// 2. Стрийминг качване на данни към излишъка (Upload Lifecycle: UPLOADING)
app.put('/upload/:uploadId/stream', async ({ user, params, req, res, correlationId }) => {
  const uploadSession = await db.queryOne('SELECT * FROM upload_sessions WHERE id = $1', [params.uploadId]);
  if (!uploadSession) throw new NotFoundError('Сесията за качване не е намерена');
  if (uploadSession.user_id !== user.sub && user.role !== 'admin') {
    throw new ForbiddenError('Нямате достъп до тази сесия за качване');
  }

  if (uploadSession.status !== 'INITIATED' && uploadSession.status !== 'UPLOADING') {
    throw new AppError(`Сесията е в невалидно състояние за качване: ${uploadSession.status}`, 409, 'INVALID_STATE');
  }

  await db.query("UPDATE upload_sessions SET status = 'UPLOADING', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [params.uploadId]);

  // Записваме стрийма през излишъка
  const result = await storageEngine.putObjectStream(uploadSession.temp_storage_key, req);

  defaultRegistry.incCounter('uploads_total', { service: 'storage-service', status: 'streaming_done' });
  defaultRegistry.incCounter('bytes_uploaded_total', { service: 'storage-service' }, result.sizeBytes);

  return {
    uploadId: params.uploadId,
    actualSizeBytes: result.sizeBytes,
    checksumSha256: result.checksumSha256,
    healthyNodesCount: result.healthyNodesCount,
    status: 'READY_TO_COMMIT',
  };
}, { authRequired: true, rawBody: true });

// 3. Финализиране на качване (Upload Lifecycle: COMMITTED)
app.post('/upload/:uploadId/commit', async ({ user, params, body, req, correlationId }) => {
  const session = await db.queryOne('SELECT * FROM upload_sessions WHERE id = $1', [params.uploadId]);
  if (!session) throw new NotFoundError('Сесията за качване не е намерена');
  if (session.user_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  const checksum = body.checksumSha256;
  const actualSize = parseInt(body.sizeBytes, 10);
  if (!checksum || isNaN(actualSize) || actualSize <= 0) {
    throw new AppError('Липсва контролна сума или валиден размер за потвърждение', 400, 'MISSING_DATA');
  }

  // Постоянният storage ключ
  const permanentKey = `objects/${user.sub}/${session.id}_${session.filename}`;

  // Преместване на обекта в постоянна локация през файловата система
  const activeNodes = storageEngine.getActiveNodes();
  for (const nodeDir of activeNodes) {
    const src = require('node:path').join(nodeDir, session.temp_storage_key);
    const dest = require('node:path').join(nodeDir, permanentKey);
    const destDir = require('node:path').dirname(dest);
    if (!require('node:fs').existsSync(destDir)) {
      require('node:fs').mkdirSync(destDir, { recursive: true });
    }
    if (require('node:fs').existsSync(src)) {
      require('node:fs').renameSync(src, dest);
    }
  }

  let fileId;
  let newVersion = 1;
  const etag = `"${checksum.slice(0, 16)}"`;
  let wasExisting = false;

  await db.withTransaction(async () => {
    // Проверка за съществуващ файл ВЪТРЕ в транзакцията за предотвратяване на race condition
    const existingFile = await db.queryOne(
      `SELECT id, version, size_bytes, storage_key, checksum_sha256 
       FROM files 
       WHERE owner_id = $1 AND (folder_id IS $2 OR folder_id = $2) AND name = $3 AND is_deleted = 0`,
      [user.sub, session.target_folder_id, session.filename]
    );

    if (existingFile) {
      wasExisting = true;
      fileId = existingFile.id;
      newVersion = existingFile.version + 1;

      // Запазване на предишната версия в file_versions
      await db.query(
        `INSERT INTO file_versions (id, file_id, version_number, size_bytes, checksum_sha256, storage_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [generateUuid(), fileId, existingFile.version, existingFile.size_bytes, existingFile.checksum_sha256, existingFile.storage_key, user.sub]
      );

      // Актуализиране на файла с новата версия с оптимистично заключване (WHERE version = expected)
      const updateResult = await db.query(
        `UPDATE files 
         SET size_bytes = $1, checksum_sha256 = $2, storage_key = $3, version = $4, etag = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $6 AND version = $7`,
        [actualSize, checksum, permanentKey, newVersion, etag, fileId, existingFile.version]
      );

      if (updateResult[0]?.changes === 0) {
        throw new ConflictError('Конфликт на конкурентност: файлът е бил модифициран от паралелна заявка');
      }

      // Актуализиране на използваната квота (разлика)
      const sizeDiff = actualSize - Number(existingFile.size_bytes);
      await db.query('UPDATE users SET used_bytes = used_bytes + $1 WHERE id = $2', [sizeDiff, user.sub]);
    } else {
      fileId = generateUuid();
      await db.query(
        `INSERT INTO files (id, owner_id, folder_id, name, size_bytes, mime_type, checksum_sha256, storage_key, version, etag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)`,
        [fileId, user.sub, session.target_folder_id, session.filename, actualSize, session.mime_type, checksum, permanentKey, etag]
      );

      await db.query('UPDATE users SET used_bytes = used_bytes + $1 WHERE id = $2', [actualSize, user.sub]);
    }

    await db.query("UPDATE upload_sessions SET status = 'COMMITTED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [session.id]);
  });

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: wasExisting ? 'FILE_UPDATE_VERSION' : 'FILE_UPLOAD',
    targetType: 'file',
    targetId: fileId,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
    details: { filename: session.filename, sizeBytes: actualSize, version: newVersion, checksum }
  });

  return {
    fileId,
    name: session.filename,
    sizeBytes: actualSize,
    checksumSha256: checksum,
    version: newVersion,
    etag,
    status: 'COMMITTED',
  };
}, { authRequired: true });

// 4. Прекъсване/отказване на качване (Upload Lifecycle: ABORTED)
app.post('/upload/:uploadId/abort', async ({ user, params, correlationId, req }) => {
  const session = await db.queryOne('SELECT * FROM upload_sessions WHERE id = $1', [params.uploadId]);
  if (!session) throw new NotFoundError('Сесията не съществува');
  if (session.user_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  storageEngine.deleteObject(session.temp_storage_key);
  await db.query("UPDATE upload_sessions SET status = 'ABORTED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [session.id]);

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'UPLOAD_ABORTED',
    targetType: 'upload_session',
    targetId: session.id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    correlationId,
    details: { filename: session.filename }
  });

  return { message: 'Сесията за качване е прекъсната и временните данни са изтрити' };
}, { authRequired: true });

// 5. Поточно сваляне на файл с верификация (Streaming Download)
app.get('/download/:fileId', async ({ user, params, res, req, correlationId }) => {
  const file = await db.queryOne('SELECT * FROM files WHERE id = $1 AND is_deleted = 0', [params.fileId]);
  if (!file) throw new NotFoundError('Файлът не съществува');

  // Проверка за права (собственик, споделен или публичен линк)
  let hasAccess = file.owner_id === user.sub || user.role === 'admin';
  if (!hasAccess) {
    const share = await db.queryOne(
      'SELECT id FROM shares WHERE file_id = $1 AND grantee_id = $2',
      [file.id, user.sub]
    );
    if (share) hasAccess = true;
  }

  if (!hasAccess) {
    await auditClient.log({
      actorId: user.sub,
      actorRole: user.role,
      action: 'DOWNLOAD_DENIED',
      targetType: 'file',
      targetId: file.id,
      result: 'FAILURE',
      ipAddress: req.socket.remoteAddress,
      correlationId,
    });
    throw new ForbiddenError('Нямате права за изтегляне на този файл');
  }

  const { stream } = storageEngine.getObjectStream(file.storage_key);

  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', file.size_bytes);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
  res.setHeader('ETag', file.etag);
  res.setHeader('X-File-Checksum-SHA256', file.checksum_sha256);
  res.writeHead(200);

  defaultRegistry.incCounter('downloads_total', { service: 'storage-service', status: '200' });
  defaultRegistry.incCounter('bytes_downloaded_total', { service: 'storage-service' }, Number(file.size_bytes));

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'FILE_DOWNLOAD',
    targetType: 'file',
    targetId: file.id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
    details: { filename: file.name, sizeBytes: file.size_bytes }
  });

  return new Promise((resolve, reject) => {
    stream.pipe(res);
    stream.on('error', reject);
    res.on('finish', resolve);
  });
}, { authRequired: true });

// 6. Статус на възлите за съхранение (Storage Redundancy Health)
app.get('/storage/nodes', async () => {
  return {
    redundancyMode: 'Multi-Volume Multi-Node Erasure/Mirroring',
    nodes: storageEngine.getNodeStatus(),
  };
});

// 7. Демонстрационни симулации за отказ и възстановяване на възел
app.post('/storage/nodes/:nodeId/fault', async ({ params, user, correlationId }) => {
  if (user && user.role !== 'admin') throw new ForbiddenError('Само администратори могат да управляват възлите');
  const ok = storageEngine.disableNode(params.nodeId);
  return { success: ok, message: `Симулиран отказ на възел ${params.nodeId}`, nodes: storageEngine.getNodeStatus() };
}, { authRequired: true, roles: ['admin'] });

app.post('/storage/nodes/:nodeId/restore', async ({ params, user, correlationId }) => {
  if (user && user.role !== 'admin') throw new ForbiddenError('Само администратори могат да възстановяват възлите');
  const ok = storageEngine.enableNode(params.nodeId);
  return { success: ok, message: `Възстановен възел ${params.nodeId}`, nodes: storageEngine.getNodeStatus() };
}, { authRequired: true, roles: ['admin'] });

if (require.main === module) {
  (async () => {
    await db.init();
    app.listen(PORT, () => {
      app.logger.info(`Storage Service стартира на порт ${PORT}`);
    });
  })().catch(err => {
    app.logger.error('Грешка при стартиране на Storage Service', { error: err.message });
    process.exit(1);
  });
}

module.exports = { app };
