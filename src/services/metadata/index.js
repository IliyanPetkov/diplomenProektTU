// =====================================================================
// File Metadata & Hierarchy Microservice
// Порт: 8082 | Отговорности: Йерархия на папки, версии, кошче, квоти
// =====================================================================

const { MicroserviceApp } = require('../../common/httpServer');
const { db } = require('../../common/db');
const { generateUuid } = require('../../common/crypto');
const { validateFilename, validateFolderName } = require('../../common/validator');
const { auditClient } = require('../../common/auditClient');
const { storageEngine } = require('../storage/redundantStorageEngine');
const {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  PreconditionFailedError,
} = require('../../common/errors');

const http = require('node:http');

const app = new MicroserviceApp('metadata-service');
const PORT = parseInt(process.env.PORT_METADATA || '8082', 10);

// Помощна функция за проверка на права на собственик или администратор
function requireOwnerOrAdmin(resource, user, resourceName = 'ресурс') {
  if (!resource) {
    throw new NotFoundError(`${resourceName} не беше открит`);
  }
  if (resource.owner_id !== user.sub && user.role !== 'admin') {
    throw new ForbiddenError(`Нямате права за достъп до този ${resourceName}`);
  }
}

// Помощна функция за излъчване на realtime събитие (локално или през HTTP към Realtime Service)
function emitRealtimeEvent(event) {
  try {
    const { realtimeHub } = require('../realtime/hub');
    if (realtimeHub && typeof realtimeHub.broadcastEvent === 'function') {
      realtimeHub.broadcastEvent(event);
      return;
    }
  } catch (e) {}

  const host = process.env.REALTIME_HOST || 'realtime-service';
  const port = parseInt(process.env.PORT_REALTIME || '8085', 10);
  const data = JSON.stringify(event);

  const req = http.request({
    hostname: host,
    port,
    path: '/events/broadcast',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
    timeout: 2000,
  }, () => {});

  req.on('error', () => {});
  req.write(data);
  req.end();
}

// 1. Списък с папки и файлове в текуща папка (или главна папка root)
app.get('/contents', async ({ user, query }) => {
  const folderId = query.folderId || null;
  const sortBy = ['name', 'size_bytes', 'updated_at'].includes(query.sortBy) ? query.sortBy : 'name';
  const order = query.order === 'desc' ? 'DESC' : 'ASC';

  let currentFolder = null;
  let breadcrumbs = [];

  if (folderId) {
    currentFolder = await db.queryOne('SELECT * FROM folders WHERE id = $1 AND is_deleted = 0', [folderId]);
    if (!currentFolder) throw new NotFoundError('Папката не беше намерена');
    if (currentFolder.owner_id !== user.sub && user.role !== 'admin') {
      throw new ForbiddenError('Нямате достъп до тази папка');
    }

    let curr = currentFolder;
    while (curr) {
      breadcrumbs.unshift({ id: curr.id, name: curr.name });
      if (curr.parent_id) {
        curr = await db.queryOne('SELECT * FROM folders WHERE id = $1 AND is_deleted = 0', [curr.parent_id]);
      } else {
        curr = null;
      }
    }
  }

  const foldersQuery = folderId
    ? `SELECT id, name, created_at, updated_at FROM folders WHERE owner_id = $1 AND parent_id = $2 AND is_deleted = 0 ORDER BY ${sortBy === 'size_bytes' ? 'name' : sortBy} ${order}`
    : `SELECT id, name, created_at, updated_at FROM folders WHERE owner_id = $1 AND parent_id IS NULL AND is_deleted = 0 ORDER BY ${sortBy === 'size_bytes' ? 'name' : sortBy} ${order}`;

  const folders = await db.query(foldersQuery, folderId ? [user.sub, folderId] : [user.sub]);

  const filesQuery = folderId
    ? `SELECT id, name, size_bytes, mime_type, checksum_sha256, version, etag, updated_at, created_at 
       FROM files 
       WHERE owner_id = $1 AND folder_id = $2 AND is_deleted = 0 
       ORDER BY ${sortBy} ${order}`
    : `SELECT id, name, size_bytes, mime_type, checksum_sha256, version, etag, updated_at, created_at 
       FROM files 
       WHERE owner_id = $1 AND folder_id IS NULL AND is_deleted = 0 
       ORDER BY ${sortBy} ${order}`;

  const files = await db.query(filesQuery, folderId ? [user.sub, folderId] : [user.sub]);
  const userInfo = await db.queryOne('SELECT quota_bytes, used_bytes FROM users WHERE id = $1', [user.sub]);

  return {
    currentFolder,
    breadcrumbs,
    folders,
    files: files.map(f => ({
      ...f,
      sizeBytes: Number(f.size_bytes),
      checksumSha256: f.checksum_sha256,
      updatedAt: f.updated_at,
      createdAt: f.created_at,
    })),
    quota: {
      usedBytes: Number(userInfo?.used_bytes || 0),
      totalBytes: Number(userInfo?.quota_bytes || 104857600),
      percentage: userInfo ? Math.min(100, Math.round((Number(userInfo.used_bytes) / Number(userInfo.quota_bytes)) * 100)) : 0,
    }
  };
}, { authRequired: true });

// 2. Създаване на папка
app.post('/folders', async ({ user, body, req, correlationId }) => {
  const name = validateFolderName(body.name);
  const parentId = body.parentId || null;

  if (parentId) {
    const parent = await db.queryOne('SELECT id, owner_id FROM folders WHERE id = $1 AND is_deleted = 0', [parentId]);
    if (!parent) throw new NotFoundError('Родителската папка не съществува');
    if (parent.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();
  }

  const duplicate = parentId
    ? await db.queryOne('SELECT id FROM folders WHERE owner_id = $1 AND parent_id = $2 AND name = $3 AND is_deleted = 0', [user.sub, parentId, name])
    : await db.queryOne('SELECT id FROM folders WHERE owner_id = $1 AND parent_id IS NULL AND name = $2 AND is_deleted = 0', [user.sub, name]);

  if (duplicate) {
    throw new ConflictError(`Вече съществува папка с име "${name}" на това ниво`);
  }

  const folderId = generateUuid();
  await db.query(
    'INSERT INTO folders (id, owner_id, parent_id, name) VALUES ($1, $2, $3, $4)',
    [folderId, user.sub, parentId, name]
  );

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'FOLDER_CREATE',
    targetType: 'folder',
    targetId: folderId,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
    details: { name, parentId }
  });

  emitRealtimeEvent({
    type: 'FOLDER_CREATED',
    userId: user.sub,
    folderId,
    name,
    parentId,
  });

  return { id: folderId, name, parentId };
}, { authRequired: true });

// 3. Преименуване или преместване на папка
app.patch('/folders/:id', async ({ user, params, body, req, correlationId }) => {
  const folder = await db.queryOne('SELECT * FROM folders WHERE id = $1 AND is_deleted = 0', [params.id]);
  if (!folder) throw new NotFoundError('Папката не е намерена');
  if (folder.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  const newName = body.name ? validateFolderName(body.name) : folder.name;
  const newParentId = body.parentId !== undefined ? body.parentId : folder.parent_id;

  if (newParentId === folder.id) {
    throw new ConflictError('Папка не може да бъде преместена в самата себе си');
  }

  await db.query(
    'UPDATE folders SET name = $1, parent_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
    [newName, newParentId, folder.id]
  );

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'FOLDER_UPDATE',
    targetType: 'folder',
    targetId: folder.id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
    details: { oldName: folder.name, newName, oldParent: folder.parent_id, newParent: newParentId }
  });

  emitRealtimeEvent({ type: 'FOLDER_UPDATED', userId: user.sub, folderId: folder.id, name: newName });

  return { id: folder.id, name: newName, parentId: newParentId };
}, { authRequired: true });

// 4. Soft delete на папка (Кошче)
app.delete('/folders/:id', async ({ user, params, req, correlationId }) => {
  const folder = await db.queryOne('SELECT * FROM folders WHERE id = $1 AND is_deleted = 0', [params.id]);
  if (!folder) throw new NotFoundError('Папката не е намерена');
  if (folder.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  await db.query("UPDATE folders SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = $1", [folder.id]);

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'FOLDER_TRASH',
    targetType: 'folder',
    targetId: folder.id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
    details: { name: folder.name }
  });

  emitRealtimeEvent({ type: 'FOLDER_DELETED', userId: user.sub, folderId: folder.id });

  return { message: 'Папката е преместена в кошчето' };
}, { authRequired: true });

// 5. Метаданни за конкретен файл
app.get('/files/:id', async ({ user, params }) => {
  const file = await db.queryOne('SELECT * FROM files WHERE id = $1 AND is_deleted = 0', [params.id]);
  if (!file) throw new NotFoundError('Файлът не е намерен');
  if (file.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  return {
    id: file.id,
    name: file.name,
    sizeBytes: Number(file.size_bytes),
    mimeType: file.mime_type,
    checksumSha256: file.checksum_sha256,
    version: file.version,
    etag: file.etag,
    folderId: file.folder_id,
    createdAt: file.created_at,
    updatedAt: file.updated_at,
  };
}, { authRequired: true });

// 6. Преименуване или преместване на файл с Optimistic Concurrency Control (ETag/Version)
app.patch('/files/:id', async ({ user, params, body, req, correlationId }) => {
  const file = await db.queryOne('SELECT * FROM files WHERE id = $1 AND is_deleted = 0', [params.id]);
  if (!file) throw new NotFoundError('Файлът не е намерен');
  if (file.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  const ifMatch = req.headers['if-match'];
  if (ifMatch && ifMatch !== file.etag && ifMatch !== `"${file.etag}"`) {
    throw new PreconditionFailedError(`Файлът е бил модифициран от друг процес (Очакван ETag: ${file.etag})`);
  }

  const newName = body.name ? validateFilename(body.name) : file.name;
  const newFolderId = body.folderId !== undefined ? body.folderId : file.folder_id;

  const duplicate = newFolderId
    ? await db.queryOne('SELECT id FROM files WHERE owner_id = $1 AND folder_id = $2 AND name = $3 AND id != $4 AND is_deleted = 0', [user.sub, newFolderId, newName, file.id])
    : await db.queryOne('SELECT id FROM files WHERE owner_id = $1 AND folder_id IS NULL AND name = $2 AND id != $3 AND is_deleted = 0', [user.sub, newName, file.id]);

  if (duplicate) {
    throw new ConflictError(`Вече съществува файл с име "${newName}" в целевата папка`);
  }

  await db.query(
    'UPDATE files SET name = $1, folder_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
    [newName, newFolderId, file.id]
  );

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'FILE_UPDATE',
    targetType: 'file',
    targetId: file.id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
    details: { oldName: file.name, newName, oldFolder: file.folder_id, newFolder: newFolderId }
  });

  emitRealtimeEvent({ type: 'FILE_UPDATED', userId: user.sub, fileId: file.id, name: newName });

  return { id: file.id, name: newName, folderId: newFolderId };
}, { authRequired: true });

// 7. Soft Delete на файл (Кошче)
app.delete('/files/:id', async ({ user, params, req, correlationId }) => {
  const file = await db.queryOne('SELECT * FROM files WHERE id = $1 AND is_deleted = 0', [params.id]);
  if (!file) throw new NotFoundError('Файлът не е намерен');
  if (file.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  await db.query("UPDATE files SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = $1", [file.id]);

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'FILE_TRASH',
    targetType: 'file',
    targetId: file.id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
    details: { name: file.name }
  });

  emitRealtimeEvent({ type: 'FILE_DELETED', userId: user.sub, fileId: file.id });

  return { message: 'Файлът е преместен в кошчето' };
}, { authRequired: true });

// 8. Кошче: Списък с изтрити елементи
app.get('/trash', async ({ user }) => {
  const trashedFiles = await db.query(
    'SELECT id, name, size_bytes, deleted_at, mime_type FROM files WHERE owner_id = $1 AND is_deleted = 1 ORDER BY deleted_at DESC',
    [user.sub]
  );
  const trashedFolders = await db.query(
    'SELECT id, name, deleted_at FROM folders WHERE owner_id = $1 AND is_deleted = 1 ORDER BY deleted_at DESC',
    [user.sub]
  );
  return {
    files: trashedFiles.map(f => ({ ...f, sizeBytes: Number(f.size_bytes), deletedAt: f.deleted_at })),
    folders: trashedFolders.map(f => ({ ...f, deletedAt: f.deleted_at })),
  };
}, { authRequired: true });

// 9. Възстановяване от кошчето (Restore)
app.post('/trash/restore/:type/:id', async ({ user, params, req, correlationId }) => {
  const { type, id } = params;

  if (type === 'file') {
    const file = await db.queryOne('SELECT * FROM files WHERE id = $1 AND is_deleted = 1', [id]);
    if (!file) throw new NotFoundError('Файлът не е открит в кошчето');
    if (file.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

    await db.query("UPDATE files SET is_deleted = 0, deleted_at = NULL WHERE id = $1", [id]);

    await auditClient.log({
      actorId: user.sub,
      actorRole: user.role,
      action: 'FILE_RESTORE',
      targetType: 'file',
      targetId: id,
      result: 'SUCCESS',
      ipAddress: req.socket.remoteAddress,
      correlationId,
      details: { name: file.name }
    });

    emitRealtimeEvent({ type: 'FILE_RESTORED', userId: user.sub, fileId: id });
    return { message: 'Файлът е възстановен успешно' };
  } else if (type === 'folder') {
    const folder = await db.queryOne('SELECT * FROM folders WHERE id = $1 AND is_deleted = 1', [id]);
    if (!folder) throw new NotFoundError('Папката не е открита в кошчето');
    if (folder.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

    await db.query("UPDATE folders SET is_deleted = 0, deleted_at = NULL WHERE id = $1", [id]);

    await auditClient.log({
      actorId: user.sub,
      actorRole: user.role,
      action: 'FOLDER_RESTORE',
      targetType: 'folder',
      targetId: id,
      result: 'SUCCESS',
      ipAddress: req.socket.remoteAddress,
      correlationId,
      details: { name: folder.name }
    });

    emitRealtimeEvent({ type: 'FOLDER_RESTORED', userId: user.sub, folderId: id });
    return { message: 'Папката е възстановена успешно' };
  }

  throw new NotFoundError('Невалиден тип ресурс');
}, { authRequired: true });

// 10. Окончателно изтриване от кошчето (Permanent Delete)
app.delete('/trash/permanent/:type/:id', async ({ user, params, req, correlationId }) => {
  const { type, id } = params;

  if (type === 'file') {
    const file = await db.queryOne('SELECT * FROM files WHERE id = $1 AND is_deleted = 1', [id]);
    if (!file) throw new NotFoundError('Файлът не е открит в кошчето');
    if (file.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

    storageEngine.deleteObject(file.storage_key);

    const versions = await db.query('SELECT storage_key FROM file_versions WHERE file_id = $1', [id]);
    for (const v of versions) {
      storageEngine.deleteObject(v.storage_key);
    }

    await db.withTransaction(async () => {
      await db.query('DELETE FROM files WHERE id = $1', [id]);
      await db.query('UPDATE users SET used_bytes = MAX(0, used_bytes - $1) WHERE id = $2', [file.size_bytes, user.sub]);
    });

    await auditClient.log({
      actorId: user.sub,
      actorRole: user.role,
      action: 'FILE_PERMANENT_DELETE',
      targetType: 'file',
      targetId: id,
      result: 'SUCCESS',
      ipAddress: req.socket.remoteAddress,
      correlationId,
      details: { name: file.name, freedBytes: file.size_bytes }
    });

    return { message: 'Файлът е изтрит окончателно' };
  } else if (type === 'folder') {
    const folder = await db.queryOne('SELECT * FROM folders WHERE id = $1 AND is_deleted = 1', [id]);
    if (!folder) throw new NotFoundError('Папката не е открита');
    if (folder.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

    await db.query('DELETE FROM folders WHERE id = $1', [id]);

    await auditClient.log({
      actorId: user.sub,
      actorRole: user.role,
      action: 'FOLDER_PERMANENT_DELETE',
      targetType: 'folder',
      targetId: id,
      result: 'SUCCESS',
      ipAddress: req.socket.remoteAddress,
      correlationId,
      details: { name: folder.name }
    });

    return { message: 'Папката е изтрита окончателно' };
  }

  throw new NotFoundError('Невалиден тип ресурс');
}, { authRequired: true });

// 11. История на версиите за файл
app.get('/files/:id/versions', async ({ user, params }) => {
  const file = await db.queryOne('SELECT * FROM files WHERE id = $1 AND is_deleted = 0', [params.id]);
  if (!file) throw new NotFoundError('Файлът не съществува');
  if (file.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  const versions = await db.query(
    'SELECT id, version_number, size_bytes, checksum_sha256, created_at FROM file_versions WHERE file_id = $1 ORDER BY version_number DESC',
    [file.id]
  );

  return {
    currentVersion: {
      version: file.version,
      sizeBytes: Number(file.size_bytes),
      checksumSha256: file.checksum_sha256,
      etag: file.etag,
      updatedAt: file.updated_at,
    },
    previousVersions: versions.map(v => ({
      id: v.id,
      versionNumber: v.version_number,
      sizeBytes: Number(v.size_bytes),
      checksumSha256: v.checksum_sha256,
      createdAt: v.created_at,
    })),
  };
}, { authRequired: true });

// 12. Възстановяване на по-стара версия като активна
app.post('/files/:id/versions/:versionId/restore', async ({ user, params, req, correlationId }) => {
  const file = await db.queryOne('SELECT * FROM files WHERE id = $1 AND is_deleted = 0', [params.id]);
  if (!file) throw new NotFoundError('Файлът не е намерен');
  if (file.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  const targetVersion = await db.queryOne(
    'SELECT * FROM file_versions WHERE id = $1 AND file_id = $2',
    [params.versionId, file.id]
  );
  if (!targetVersion) throw new NotFoundError('Посочената версия не е намерена');

  const newVersionNumber = file.version + 1;
  const newEtag = `"${targetVersion.checksum_sha256.slice(0, 16)}"`;

  await db.withTransaction(async () => {
    await db.query(
      `INSERT INTO file_versions (id, file_id, version_number, size_bytes, checksum_sha256, storage_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [generateUuid(), file.id, file.version, file.size_bytes, file.checksum_sha256, file.storage_key, user.sub]
    );

    await db.query(
      `UPDATE files 
       SET size_bytes = $1, checksum_sha256 = $2, storage_key = $3, version = $4, etag = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [targetVersion.size_bytes, targetVersion.checksum_sha256, targetVersion.storage_key, newVersionNumber, newEtag, file.id]
    );

    const diff = Number(targetVersion.size_bytes) - Number(file.size_bytes);
    await db.query('UPDATE users SET used_bytes = used_bytes + $1 WHERE id = $2', [diff, user.sub]);
  });

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'VERSION_RESTORE',
    targetType: 'file',
    targetId: file.id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    correlationId,
    details: { restoredVersion: targetVersion.version_number, newVersion: newVersionNumber }
  });

  emitRealtimeEvent({ type: 'FILE_VERSION_RESTORED', userId: user.sub, fileId: file.id, version: newVersionNumber });

  return { message: `Версия #${targetVersion.version_number} е възстановена успешно като версия #${newVersionNumber}` };
}, { authRequired: true });

// 13. Търсене на файлове и папки
app.get('/search', async ({ user, query }) => {
  const q = (query.q || '').trim();
  if (!q) return { files: [], folders: [] };

  const pattern = `%${q}%`;
  const files = await db.query(
    'SELECT id, name, size_bytes, mime_type, updated_at, folder_id FROM files WHERE owner_id = $1 AND name LIKE $2 AND is_deleted = 0',
    [user.sub, pattern]
  );
  const folders = await db.query(
    'SELECT id, name, updated_at, parent_id FROM folders WHERE owner_id = $1 AND name LIKE $2 AND is_deleted = 0',
    [user.sub, pattern]
  );

  return {
    query: q,
    files: files.map(f => ({ ...f, sizeBytes: Number(f.size_bytes) })),
    folders,
  };
}, { authRequired: true });

// 14. Глобален регистър на всички файлове в системата (само за Администратори)
app.get('/admin/files', async ({ user }) => {
  if (user.role !== 'admin') {
    throw new ForbiddenError('Само системни администратори имат достъп до глобалния регистър на файлове');
  }

  const files = await db.query(
    `SELECT 
       f.id, 
       f.name, 
       f.size_bytes, 
       f.mime_type, 
       f.checksum_sha256, 
       f.version, 
       f.is_deleted, 
       f.created_at, 
       f.updated_at, 
       f.owner_id, 
       u.email as owner_email, 
       u.full_name as owner_name,
       fo.name as folder_name
     FROM files f
     JOIN users u ON f.owner_id = u.id
     LEFT JOIN folders fo ON f.folder_id = fo.id
     ORDER BY f.created_at DESC`
  );

  return {
    files: files.map(f => ({
      id: f.id,
      name: f.name,
      sizeBytes: Number(f.size_bytes),
      mimeType: f.mime_type,
      checksumSha256: f.checksum_sha256,
      version: f.version,
      isDeleted: Boolean(f.is_deleted),
      createdAt: f.created_at,
      updatedAt: f.updated_at,
      ownerId: f.owner_id,
      ownerEmail: f.owner_email,
      ownerName: f.owner_name,
      folderName: f.folder_name || 'Главна директория (Root)',
    }))
  };
}, { authRequired: true });

if (require.main === module) {
  (async () => {
    await db.init();
    app.listen(PORT, () => {
      app.logger.info(`File Metadata Service стартира на порт ${PORT}`);
    });
  })().catch(err => {
    app.logger.error('Грешка при стартиране на Metadata Service', { error: err.message });
    process.exit(1);
  });
}

module.exports = { app };
