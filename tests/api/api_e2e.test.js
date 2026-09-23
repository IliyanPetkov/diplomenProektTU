// =====================================================================
// API E2E Test: Автентикация, Папки, Файлове, Версии, Кошче и Одит
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../../src/common/db');
const { app: identityApp } = require('../../src/services/identity');
const { app: metadataApp } = require('../../src/services/metadata');
const { PreconditionFailedError } = require('../../src/common/errors');

test('API E2E: Регистрация, Вход, Сесии и Профил', async () => {
  await db.init();

  const testEmail = `e2e_user_${Date.now()}@tu-sofia.bg`;
  const registerResult = await identityApp.routes.find(r => r.pattern.test('/register') && r.method === 'POST').handler({
    body: { email: testEmail, password: 'StrongPassword2026!', fullName: 'E2E Тестов Студент' },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-reg-1',
  });

  assert.strictEqual(registerResult.email, testEmail);
  assert.strictEqual(registerResult.role, 'user');

  // Вход
  const loginResult = await identityApp.routes.find(r => r.pattern.test('/login') && r.method === 'POST').handler({
    body: { email: testEmail, password: 'StrongPassword2026!' },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-login-1',
  });

  assert.ok(loginResult.accessToken);
  assert.ok(loginResult.refreshToken);
  assert.strictEqual(loginResult.user.email, testEmail);

  // Текущ профил (Get Me)
  const meResult = await identityApp.routes.find(r => r.pattern.test('/me') && r.method === 'GET').handler({
    user: { sub: registerResult.id, role: 'user' },
  });

  assert.strictEqual(meResult.id, registerResult.id);
  assert.strictEqual(meResult.email, testEmail);
});

test('API E2E: Папки, Йерархия, Файлови операции, Версиониране и Кошче', async () => {
  await db.init();
  const userId = 'e2e-files-user-uuid';
  await db.query("DELETE FROM users WHERE id = $1", [userId]);
  await db.query(
    "INSERT INTO users (id, email, password_hash, full_name, role, quota_bytes, used_bytes) VALUES ($1, $2, 'h', 'User', 'user', 104857600, 0)",
    [userId, 'e2e_files@tu-sofia.bg']
  );
  const user = { sub: userId, role: 'user' };

  // 1. Създаване на главна папка
  const folder1 = await metadataApp.routes.find(r => r.pattern.test('/folders') && r.method === 'POST').handler({
    user,
    body: { name: 'Дипломна Папка' },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-folder-1',
  });
  assert.strictEqual(folder1.name, 'Дипломна Папка');

  // 2. Създаване на подпапка (йерархия)
  const subFolder = await metadataApp.routes.find(r => r.pattern.test('/folders') && r.method === 'POST').handler({
    user,
    body: { name: 'Глава 1', parentId: folder1.id },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-subfolder-1',
  });
  assert.strictEqual(subFolder.parentId, folder1.id);

  // 3. Добавяне на файл
  const fileId = 'e2e-file-123';
  await db.query(
    `INSERT INTO files (id, owner_id, folder_id, name, size_bytes, mime_type, checksum_sha256, storage_key, version, etag)
     VALUES ($1, $2, $3, 'thesis.docx', 2048, 'application/vnd.word', 'sha256hash111', 'obj/1', 1, '"etag111"')`,
    [fileId, userId, folder1.id]
  );

  // 4. Проверка на оптимистично заключване при промяна на файл (ETag / If-Match)
  await assert.rejects(
    async () => {
      await metadataApp.routes.find(r => r.pattern.test('/files/' + fileId) && r.method === 'PATCH').handler({
        user,
        params: { id: fileId },
        body: { name: 'thesis_new.docx' },
        req: { socket: { remoteAddress: '127.0.0.1' }, headers: { 'if-match': '"wrong-stale-etag"' } },
        correlationId: 'corr-etag-conflict',
      });
    },
    PreconditionFailedError,
    'При несъвпадащ If-Match трябва да се хвърли PreconditionFailedError (412)'
  );

  // Успешна промяна с правилен ETag
  const renameResult = await metadataApp.routes.find(r => r.pattern.test('/files/' + fileId) && r.method === 'PATCH').handler({
    user,
    params: { id: fileId },
    body: { name: 'thesis_updated.docx' },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: { 'if-match': '"etag111"' } },
    correlationId: 'corr-rename-ok',
  });
  assert.strictEqual(renameResult.name, 'thesis_updated.docx');

  // 5. Преместване в кошчето (Soft Delete)
  await metadataApp.routes.find(r => r.pattern.test('/files/' + fileId) && r.method === 'DELETE').handler({
    user,
    params: { id: fileId },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-trash',
  });

  const trashedFile = await db.queryOne("SELECT is_deleted FROM files WHERE id = $1", [fileId]);
  assert.strictEqual(trashedFile.is_deleted, 1, 'Файлът трябва да е маркиран като изтрит');

  // 6. Възстановяване от кошчето (Restore)
  await metadataApp.routes.find(r => r.pattern.test('/trash/restore/file/' + fileId) && r.method === 'POST').handler({
    user,
    params: { type: 'file', id: fileId },
    req: { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
    correlationId: 'corr-restore',
  });

  const restoredFile = await db.queryOne("SELECT is_deleted FROM files WHERE id = $1", [fileId]);
  assert.strictEqual(restoredFile.is_deleted, 0, 'Файлът трябва да е възстановен');

  // 7. Проверка на одитния журнал (Audit Verification)
  const auditLogs = await db.query("SELECT action, correlation_id FROM audit_logs WHERE actor_id = $1", [userId]);
  const actions = auditLogs.map(l => l.action);
  assert.ok(actions.includes('FOLDER_CREATE'), 'Одитният журнал трябва да съдържа създаването на папка');
  assert.ok(actions.includes('FILE_TRASH'), 'Одитният журнал трябва да съдържа преместването в кошче');
  assert.ok(actions.includes('FILE_RESTORE'), 'Одитният журнал трябва да съдържа възстановяването');
});
