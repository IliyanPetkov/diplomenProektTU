// =====================================================================
// Sharing Service: Споделяне към потребители и защитени публични връзки
// =====================================================================

const { MicroserviceApp } = require('../../common/httpServer');
const { db } = require('../../common/db');
const { generateRandomToken, generateUuid, hashPassword, verifyPassword } = require('../../common/crypto');
const { auditClient } = require('../../common/auditClient');
const { storageEngine } = require('../storage/redundantStorageEngine');
const {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ValidationError,
  UnauthorizedError,
} = require('../../common/errors');

const app = new MicroserviceApp('sharing-service');
const PORT = parseInt(process.env.PORT_SHARING || '8084', 10);

// 1. Споделяне на файл или папка към регистриран потребител
app.post('/shares', async ({ user, body, req, correlationId }) => {
  const { fileId, folderId, granteeEmail, permission } = body;

  if (!fileId && !folderId) {
    throw new ValidationError('Трябва да посочите fileId или folderId');
  }
  if (!['viewer', 'editor'].includes(permission)) {
    throw new ValidationError('Невалидни права (разрешени са "viewer" или "editor")');
  }

  const queryTerm = (granteeEmail || '').trim();
  if (!queryTerm) {
    throw new ValidationError('Моля, въведете имейл или потребител за споделяне');
  }

  const grantee = await db.queryOne(
    `SELECT id, email, full_name 
     FROM users 
     WHERE LOWER(email) = LOWER($1) 
        OR LOWER(email) LIKE LOWER($1 || '@%') 
        OR LOWER(full_name) = LOWER($1)
     LIMIT 1`,
    [queryTerm]
  );

  if (!grantee) {
    throw new NotFoundError(`Потребителят "${granteeEmail}" не беше намерен в системата`);
  }
  if (grantee.id === user.sub) {
    throw new ConflictError('Не можете да споделите ресурс със себе си');
  }

  // Проверка за собственост на ресурса
  let resourceName = 'файл';
  if (fileId) {
    const file = await db.queryOne('SELECT id, owner_id, name FROM files WHERE id = $1 AND is_deleted = 0', [fileId]);
    if (!file) throw new NotFoundError('Файлът не съществува');
    if (file.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();
    resourceName = file.name;
  }

  // Проверка за съществуващо споделяне
  const existingShare = fileId
    ? await db.queryOne('SELECT id FROM shares WHERE file_id = $1 AND grantee_id = $2', [fileId, grantee.id])
    : await db.queryOne('SELECT id FROM shares WHERE folder_id = $1 AND grantee_id = $2', [folderId, grantee.id]);

  let shareId;
  if (existingShare) {
    shareId = existingShare.id;
    await db.query('UPDATE shares SET permission = $1 WHERE id = $2', [permission, shareId]);
  } else {
    shareId = generateUuid();
    await db.query(
      `INSERT INTO shares (id, file_id, folder_id, grantor_id, grantee_id, permission)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [shareId, fileId || null, folderId || null, user.sub, grantee.id, permission]
    );
  }

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'SHARE_CREATE',
    targetType: fileId ? 'file' : 'folder',
    targetId: fileId || folderId,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    correlationId,
    details: { granteeEmail: grantee.email, granteeName: grantee.full_name, permission }
  });

  return { id: shareId, granteeEmail: grantee.email, granteeName: grantee.full_name, permission, resourceName };
}, { authRequired: true });

// 2. Списък с активни споделяния за конкретен файл или папка
app.get('/shares', async ({ user, query }) => {
  const { fileId, folderId } = query;
  if (!fileId && !folderId) {
    // Всички ресурси, споделени С МЕН (Shared with me)
    const sharedWithMe = await db.query(
      `SELECT s.id as share_id, s.permission, s.created_at, f.id as file_id, f.name, f.size_bytes, f.mime_type, f.checksum_sha256, f.version, f.updated_at, u.email as owner_email, u.full_name as owner_name
       FROM shares s
       JOIN files f ON s.file_id = f.id
       JOIN users u ON f.owner_id = u.id
       WHERE s.grantee_id = $1 AND f.is_deleted = 0
       ORDER BY s.created_at DESC`,
      [user.sub]
    );
    return { sharedWithMe };
  }

  // Споделяния за даден файл
  const shares = await db.query(
    `SELECT s.id, s.permission, s.created_at, u.email as grantee_email, u.full_name as grantee_name
     FROM shares s
     JOIN users u ON s.grantee_id = u.id
     WHERE s.file_id = $1 AND s.grantor_id = $2`,
    [fileId, user.sub]
  );

  // Публични връзки за този файл
  const publicLinks = await db.query(
    `SELECT id, token, expires_at, download_count, is_revoked, (password_hash IS NOT NULL) as is_protected, created_at
     FROM public_links
     WHERE file_id = $1 AND creator_id = $2 AND is_revoked = 0`,
    [fileId, user.sub]
  );

  return {
    userShares: shares,
    publicLinks: publicLinks.map(p => ({ ...p, isProtected: Boolean(p.is_protected) })),
  };
}, { authRequired: true });

// 3. Отнемане на споделяне към потребител
app.delete('/shares/:id', async ({ user, params, req, correlationId }) => {
  const share = await db.queryOne('SELECT * FROM shares WHERE id = $1', [params.id]);
  if (!share) throw new NotFoundError('Споделянето не е открито');
  if (share.grantor_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  await db.query('DELETE FROM shares WHERE id = $1', [params.id]);

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'SHARE_REVOKED',
    targetType: share.file_id ? 'file' : 'folder',
    targetId: share.file_id || share.folder_id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    correlationId,
    details: { shareId: params.id }
  });

  return { message: 'Споделянето е отнето успешно' };
}, { authRequired: true });

// 4. Генериране на публичен линк за споделяне (Public Share Link)
app.post('/public-links', async ({ user, body, req, correlationId }) => {
  const { fileId, folderId, password, expiresInHours } = body;
  if (!fileId && !folderId) throw new ValidationError('Липсва fileId или folderId');

  // Проверка за собственост
  if (fileId) {
    const file = await db.queryOne('SELECT id, owner_id FROM files WHERE id = $1 AND is_deleted = 0', [fileId]);
    if (!file) throw new NotFoundError('Файлът не съществува');
    if (file.owner_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();
  }

  const token = generateRandomToken(32);
  const passwordHash = password ? await hashPassword(password) : null;
  const expiresAt = expiresInHours
    ? new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString()
    : null;

  const linkId = generateUuid();
  await db.query(
    `INSERT INTO public_links (id, file_id, folder_id, creator_id, token, password_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [linkId, fileId || null, folderId || null, user.sub, token, passwordHash, expiresAt]
  );

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'PUBLIC_LINK_CREATE',
    targetType: fileId ? 'file' : 'folder',
    targetId: fileId || folderId,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    correlationId,
    details: { hasPassword: Boolean(password), expiresAt }
  });

  return {
    id: linkId,
    token,
    expiresAt,
    hasPassword: Boolean(password),
    url: `/share/${token}`,
  };
}, { authRequired: true });

// 5. Отнемане на публичен линк (Revoke Public Link)
app.delete('/public-links/:id', async ({ user, params, req, correlationId }) => {
  const link = await db.queryOne('SELECT * FROM public_links WHERE id = $1', [params.id]);
  if (!link) throw new NotFoundError('Публичният линк не е открит');
  if (link.creator_id !== user.sub && user.role !== 'admin') throw new ForbiddenError();

  await db.query('UPDATE public_links SET is_revoked = 1 WHERE id = $1', [params.id]);

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'PUBLIC_LINK_REVOKED',
    targetType: link.file_id ? 'file' : 'folder',
    targetId: link.file_id || link.folder_id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    correlationId,
    details: { linkId: params.id }
  });

  return { message: 'Публичният линк е деактивиран' };
}, { authRequired: true });

// 6. Достъп до публичен линк от неавтентикиран външен посетител (Public View)
app.get('/public/:token', async ({ params, req, correlationId }) => {
  const link = await db.queryOne(
    `SELECT pl.*, f.name, f.size_bytes, f.mime_type 
     FROM public_links pl
     JOIN files f ON pl.file_id = f.id
     WHERE pl.token = $1 AND f.is_deleted = 0`,
    [params.token]
  );

  if (!link || link.is_revoked === 1) {
    throw new NotFoundError('Връзката за споделяне е невалидна или е била отнета');
  }

  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
    throw new ForbiddenError('Срокът на валидност на тази връзка е изтекъл');
  }

  return {
    token: link.token,
    filename: link.name,
    sizeBytes: Number(link.size_bytes),
    mimeType: link.mime_type,
    isProtected: Boolean(link.password_hash),
    expiresAt: link.expires_at,
  };
});

// 7. Сваляне на файл през публичен линк (със защитна проверка за парола) - POST & GET
const handlePublicDownload = async ({ params, body, query, res, req, correlationId }) => {
  const link = await db.queryOne(
    `SELECT pl.*, f.name, f.size_bytes, f.mime_type, f.storage_key, f.checksum_sha256, f.etag
     FROM public_links pl
     JOIN files f ON pl.file_id = f.id
     WHERE pl.token = $1 AND f.is_deleted = 0`,
    [params.token]
  );

  if (!link || link.is_revoked === 1) {
    throw new NotFoundError('Връзката за споделяне е невалидна или е била отнета');
  }

  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
    throw new ForbiddenError('Срокът на валидност на тази връзка е изтекъл');
  }

  if (link.password_hash) {
    const enteredPassword = (body && body.password) ? body.password : (query && query.password ? query.password : '');
    const match = await verifyPassword(enteredPassword, link.password_hash);
    if (!match) {
      await auditClient.log({
        action: 'PUBLIC_LINK_WRONG_PASSWORD',
        targetType: 'public_link',
        targetId: link.id,
        result: 'FAILURE',
        ipAddress: req.socket.remoteAddress,
        correlationId,
      });
      throw new UnauthorizedError('Грешна парола за достъп до споделения файл');
    }
  }

  // Увеличаване на брояча за изтегляния
  await db.query('UPDATE public_links SET download_count = download_count + 1 WHERE id = $1', [link.id]);

  const { stream } = storageEngine.getObjectStream(link.storage_key);

  res.setHeader('Content-Type', link.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', link.size_bytes);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(link.name)}"`);
  res.setHeader('ETag', link.etag);
  res.setHeader('X-File-Checksum-SHA256', link.checksum_sha256);
  res.writeHead(200);

  await auditClient.log({
    action: 'PUBLIC_FILE_DOWNLOAD',
    targetType: 'file',
    targetId: link.file_id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    correlationId,
    details: { filename: link.name, token: link.token }
  });

  return new Promise((resolve, reject) => {
    stream.pipe(res);
    stream.on('error', reject);
    res.on('finish', resolve);
  });
};

app.post('/public/:token/download', handlePublicDownload);
app.get('/public/:token/download', handlePublicDownload);

if (require.main === module) {
  (async () => {
    await db.init();
    app.listen(PORT, () => {
      app.logger.info(`Sharing Service стартира на порт ${PORT}`);
    });
  })().catch(err => {
    app.logger.error('Грешка при стартиране на Sharing Service', { error: err.message });
    process.exit(1);
  });
}

module.exports = { app };
