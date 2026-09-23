// =====================================================================
// Integration Test: Пълен жизнен цикъл на качване и побитова идентичност
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { db } = require('../../src/common/db');
const { storageEngine } = require('../../src/services/storage/redundantStorageEngine');
const { computeSha256 } = require('../../src/common/crypto');

test('Жизнен цикъл на качване: INITIATED -> UPLOADING -> COMMITTED с побитова проверка', async () => {
  await db.init();

  // Създаване на тестов потребител
  const testUserId = 'test-user-upload-uuid-1';
  await db.query("DELETE FROM users WHERE id = $1", [testUserId]);
  await db.query(
    "INSERT INTO users (id, email, password_hash, full_name, role, quota_bytes, used_bytes) VALUES ($1, $2, $3, $4, 'user', 10485760, 0)",
    [testUserId, 'upload-test@tu-sofia.bg', 'hash', 'Upload Tester']
  );

  // 1. Инициализиране на качване (INITIATED)
  const fileContent = 'ТУ-София: Дипломна разработка 2026. Тестово съдържание за побитова проверка!';
  const fileBuffer = Buffer.from(fileContent, 'utf8');
  const expectedSize = fileBuffer.length;
  const expectedChecksum = computeSha256(fileBuffer);

  await db.query(
    `INSERT INTO upload_sessions (id, user_id, target_folder_id, filename, expected_size_bytes, mime_type, status, temp_storage_key)
     VALUES ($1, $2, NULL, $3, $4, 'text/plain', 'INITIATED', $5)`,
    ['upload-session-123', testUserId, 'diploma_test.txt', expectedSize, `temp/${testUserId}/upload-session-123_diploma_test.txt`]
  );

  const initSession = await db.queryOne('SELECT * FROM upload_sessions WHERE id = $1', ['upload-session-123']);
  assert.strictEqual(initSession.status, 'INITIATED');

  // 2. Стрийминг запис към възлите за съхранение (UPLOADING)
  const inputStream = Readable.from([fileBuffer]);
  const storageResult = await storageEngine.putObjectStream(initSession.temp_storage_key, inputStream);

  assert.strictEqual(storageResult.sizeBytes, expectedSize, 'Размерът трябва да съвпада');
  assert.strictEqual(storageResult.checksumSha256, expectedChecksum, 'SHA-256 трябва да съвпада точно');
  assert.ok(storageResult.healthyNodesCount >= 2, 'Трябва да е записано в активните възли с излишък');

  // 3. Финализиране (COMMITTED) и запис в метаданните
  const fileId = 'committed-file-uuid-1';
  const permanentKey = `objects/${testUserId}/${fileId}_diploma_test.txt`;

  // Преместване от temp към objects във възлите
  for (const nodeDir of storageEngine.getActiveNodes()) {
    const src = require('node:path').join(nodeDir, initSession.temp_storage_key);
    const dest = require('node:path').join(nodeDir, permanentKey);
    require('node:fs').mkdirSync(require('node:path').dirname(dest), { recursive: true });
    if (require('node:fs').existsSync(src)) {
      require('node:fs').renameSync(src, dest);
    }
  }

  await db.withTransaction(async () => {
    await db.query(
      `INSERT INTO files (id, owner_id, folder_id, name, size_bytes, mime_type, checksum_sha256, storage_key, version, etag)
       VALUES ($1, $2, NULL, 'diploma_test.txt', $3, 'text/plain', $4, $5, 1, $6)`,
      [fileId, testUserId, expectedSize, expectedChecksum, permanentKey, `"${expectedChecksum.slice(0, 16)}"`]
    );
    await db.query("UPDATE users SET used_bytes = used_bytes + $1 WHERE id = $2", [expectedSize, testUserId]);
  });

  // Проверка на квотата на потребителя
  const updatedUser = await db.queryOne("SELECT used_bytes FROM users WHERE id = $1", [testUserId]);
  assert.strictEqual(Number(updatedUser.used_bytes), expectedSize, 'Използваната квота трябва да се увеличи с точния брой байтове');

  // 4. Изтегляне със стрийминг и проверка за побитова идентичност
  const { stream } = storageEngine.getObjectStream(permanentKey);
  const downloadedChunks = [];
  for await (const chunk of stream) {
    downloadedChunks.push(chunk);
  }
  const downloadedBuffer = Buffer.concat(downloadedChunks);

  assert.strictEqual(downloadedBuffer.toString('utf8'), fileContent, 'Изтегленото съдържание трябва да е 100% идентично с първоначалното');
  assert.strictEqual(computeSha256(downloadedBuffer), expectedChecksum, 'Контролната сума на изтегления файл трябва да съвпада побитово');
});
