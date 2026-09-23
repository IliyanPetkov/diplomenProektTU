// =====================================================================
// Failure & Reconciliation Test: Прекъснати качвания и фоново почистване
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../../src/common/db');
const { runCleanupJob } = require('../../src/services/background/cleanup');
const { storageEngine } = require('../../src/services/storage/redundantStorageEngine');

test('Фонова реконсилиация: Почистване на прекъсната сесия за качване и временни файлове', async () => {
  await db.init();

  const userId = 'cleanup-user-uuid';
  const uploadId = 'abandoned-upload-uuid';
  const tempKey = `temp/${userId}/${uploadId}_large_archive.zip`;

  await db.query("DELETE FROM users WHERE id = $1", [userId]);
  await db.query("INSERT INTO users (id, email, password_hash, full_name, role) VALUES ($1, 'cleanup@tu-sofia.bg', 'h', 'Cleanup', 'user')", [userId]);

  // Създаване на изоставен временен файл във възлите
  for (const nodeDir of storageEngine.getActiveNodes()) {
    const fullPath = path.join(nodeDir, tempKey);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, 'Недовършено съдържание на прекъснато качване');
    assert.strictEqual(fs.existsSync(fullPath), true);
  }

  // Запис на сесия със статус UPLOADING и старо време на създаване (преди 2 часа)
  const oldTimestamp = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  await db.query("DELETE FROM upload_sessions WHERE id = $1", [uploadId]);
  await db.query(
    `INSERT INTO upload_sessions (id, user_id, filename, expected_size_bytes, mime_type, status, temp_storage_key, created_at)
     VALUES ($1, $2, 'large_archive.zip', 10485760, 'application/zip', 'UPLOADING', $3, $4)`,
    [uploadId, userId, tempKey, oldTimestamp]
  );

  // Изпълнение на задачата за почистване (за сесии по-стари от 60 минути)
  const report = await runCleanupJob(60);

  assert.ok(report.cleanedSessionsCount >= 1, 'Трябва да е почистена поне една изоставена сесия');

  // Проверка на състоянието в базата данни
  const updatedSession = await db.queryOne("SELECT status FROM upload_sessions WHERE id = $1", [uploadId]);
  assert.strictEqual(updatedSession.status, 'ABORTED', 'Статусът трябва да е променен на ABORTED');

  // Проверка дали временните файлове са изтрити от дисковите възли
  for (const nodeDir of storageEngine.getActiveNodes()) {
    const fullPath = path.join(nodeDir, tempKey);
    assert.strictEqual(fs.existsSync(fullPath), false, `Временният файл ${fullPath} трябва да бъде изтрит`);
  }
});
