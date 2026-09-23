// =====================================================================
// API Test: Споделяне (Sharing) и Публични връзки (Public Links)
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../../src/common/db');
const { app: sharingApp } = require('../../src/services/sharing');
const { NotFoundError } = require('../../src/common/errors');

test('Споделяне към регистриран потребител и отнемане на права', async () => {
  await db.init();

  const grantorId = 'grantor-uuid-1';
  const granteeId = 'grantee-uuid-2';
  await db.query("DELETE FROM users WHERE id IN ($1, $2)", [grantorId, granteeId]);

  await db.query("INSERT INTO users (id, email, password_hash, full_name, role) VALUES ($1, 'prof@tu-sofia.bg', 'h', 'Prof', 'user')", [grantorId]);
  await db.query("INSERT INTO users (id, email, password_hash, full_name, role) VALUES ($1, 'assistant@tu-sofia.bg', 'h', 'Assistant', 'user')", [granteeId]);

  const fileId = 'shared-file-uuid-1';
  await db.query(
    "INSERT INTO files (id, owner_id, name, size_bytes, mime_type, checksum_sha256, storage_key, version, etag) VALUES ($1, $2, 'shared_doc.pdf', 1024, 'application/pdf', 'hash', 'key', 1, 'etag')",
    [fileId, grantorId]
  );

  // 1. Създаване на споделяне към асистента с права editor
  const share = await sharingApp.routes.find(r => r.pattern.test('/shares') && r.method === 'POST').handler({
    user: { sub: grantorId, role: 'user' },
    body: { fileId, granteeEmail: 'assistant@tu-sofia.bg', permission: 'editor' },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-share-1',
  });

  assert.strictEqual(share.permission, 'editor');
  assert.strictEqual(share.granteeEmail, 'assistant@tu-sofia.bg');

  // 2. Проверка в списъка със споделени ресурси за асистента
  const sharedWithAssistant = await sharingApp.routes.find(r => r.pattern.test('/shares') && r.method === 'GET').handler({
    user: { sub: granteeId, role: 'user' },
    query: {},
  });
  assert.strictEqual(sharedWithAssistant.sharedWithMe.length, 1);
  assert.strictEqual(sharedWithAssistant.sharedWithMe[0].name, 'shared_doc.pdf');

  // 3. Отнемане на споделянето
  await sharingApp.routes.find(r => r.pattern.test('/shares/' + share.id) && r.method === 'DELETE').handler({
    user: { sub: grantorId, role: 'user' },
    params: { id: share.id },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-revoke-share',
  });

  const checkRevoked = await db.queryOne("SELECT id FROM shares WHERE id = $1", [share.id]);
  assert.strictEqual(checkRevoked, null, 'Споделянето трябва да е изтрито');
});

test('Публичен линк с парола, валидност и деактивиране', async () => {
  await db.init();

  const ownerId = 'link-owner-uuid';
  const fileId = 'link-file-uuid';
  await db.query("DELETE FROM users WHERE id = $1", [ownerId]);
  await db.query("INSERT INTO users (id, email, password_hash, full_name, role) VALUES ($1, 'owner@tu-sofia.bg', 'h', 'Owner', 'user')", [ownerId]);
  await db.query("INSERT INTO files (id, owner_id, name, size_bytes, mime_type, checksum_sha256, storage_key, version, etag) VALUES ($1, $2, 'public_notes.txt', 512, 'text/plain', 'h', 'k', 1, 'e')", [fileId, ownerId]);

  // 1. Създаване на защитен публичен линк с парола
  const publicLink = await sharingApp.routes.find(r => r.pattern.test('/public-links') && r.method === 'POST').handler({
    user: { sub: ownerId, role: 'user' },
    body: { fileId, password: 'LinkSecretPassword123!', expiresInHours: 24 },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-public-link',
  });

  assert.ok(publicLink.token);
  assert.strictEqual(publicLink.hasPassword, true);

  // 2. Достъп до метаданните на публичния линк
  const publicView = await sharingApp.routes.find(r => r.pattern.test('/public/' + publicLink.token) && r.method === 'GET').handler({
    params: { token: publicLink.token },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-pub-view',
  });
  assert.strictEqual(publicView.filename, 'public_notes.txt');
  assert.strictEqual(publicView.isProtected, true);

  // 3. Отнемане (Revocation) на публичния линк
  await sharingApp.routes.find(r => r.pattern.test('/public-links/' + publicLink.id) && r.method === 'DELETE').handler({
    user: { sub: ownerId, role: 'user' },
    params: { id: publicLink.id },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-revoke-pub',
  });

  // Опит за достъп след отнемане трябва да хвърли NotFoundError
  await assert.rejects(
    async () => {
      await sharingApp.routes.find(r => r.pattern.test('/public/' + publicLink.token) && r.method === 'GET').handler({
        params: { token: publicLink.token },
        req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
        correlationId: 'corr-revoked-access',
      });
    },
    NotFoundError,
    'Отнетият публичен линк трябва да хвърля NotFoundError (невалиден)'
  );
});
