// =====================================================================
// Security Regression Test: IDOR, Path Traversal, Rate Limiting и Токени
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../../src/common/db');
const { app: storageApp } = require('../../src/services/storage');
const { app: metadataApp } = require('../../src/services/metadata');
const { RateLimiter } = require('../../src/services/gateway/rateLimiter');
const { ForbiddenError, ValidationError } = require('../../src/common/errors');

test('Защита от IDOR/BOLA: Потребител B не може да изтегли или изтрие чужд файл', async () => {
  db.init();

  const victimUserId = 'victim-user-uuid';
  const attackerUserId = 'attacker-user-uuid';
  db.query("DELETE FROM users WHERE id IN ($1, $2)", [victimUserId, attackerUserId]);

  db.query("INSERT INTO users (id, email, password_hash, full_name, role) VALUES ($1, 'victim@tu-sofia.bg', 'h', 'Victim', 'user')", [victimUserId]);
  db.query("INSERT INTO users (id, email, password_hash, full_name, role) VALUES ($1, 'attacker@tu-sofia.bg', 'h', 'Attacker', 'user')", [attackerUserId]);

  const confidentialFileId = 'confidential-file-uuid';
  db.query(
    "INSERT INTO files (id, owner_id, name, size_bytes, mime_type, checksum_sha256, storage_key, version, etag) VALUES ($1, $2, 'confidential_exam.pdf', 1024, 'application/pdf', 'hash', 'key', 1, 'etag')",
    [confidentialFileId, victimUserId]
  );

  // 1. Атакуващият се опитва да изтегли файла (IDOR четене)
  await assert.rejects(
    async () => {
      await storageApp.routes.find(r => r.pattern.test('/download/' + confidentialFileId) && r.method === 'GET').handler({
        user: { sub: attackerUserId, role: 'user' },
        params: { fileId: confidentialFileId },
        res: { setHeader: () => {}, writeHead: () => {} },
        req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
        correlationId: 'idor-read-attempt',
      });
    },
    ForbiddenError,
    'Опит за четене на чужд файл без споделяне трябва да хвърля ForbiddenError (403)'
  );

  // 2. Атакуващият се опитва да премести файла в кошчето (IDOR изтриване)
  await assert.rejects(
    async () => {
      await metadataApp.routes.find(r => r.pattern.test('/files/' + confidentialFileId) && r.method === 'DELETE').handler({
        user: { sub: attackerUserId, role: 'user' },
        params: { id: confidentialFileId },
        req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
        correlationId: 'idor-delete-attempt',
      });
    },
    ForbiddenError,
    'Опит за изтриване на чужд файл трябва да хвърля ForbiddenError (403)'
  );
});

test('Rate Limiter: Ограничаване при превишаване на лимита на заявките', () => {
  const limiter = new RateLimiter(5, 60000); // 5 заявки на минута
  const ip = '192.168.1.50';

  // Първите 5 заявки трябва да са разрешени
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(limiter.isAllowed(ip), true, `Заявка ${i + 1} трябва да е позволена`);
  }

  // 6-тата заявка в същата минута трябва да бъде блокирана
  assert.strictEqual(limiter.isAllowed(ip), false, '6-тата заявка трябва да бъде отхвърлена (Rate Limit Exceeded)');
});
