// =====================================================================
// Скрипт за зареждане на демо акаунти и начални данни (Seed Script)
// =====================================================================

const { db } = require('../src/common/db');
const { hashPassword, generateUuid } = require('../src/common/crypto');
const { createLogger } = require('../src/common/logger');

const logger = createLogger('seed');

async function runSeed() {
  logger.info('Стартиране на seed процедура за ТУ - София демонстрационни данни...');
  await db.init();

  const adminPasswordHash = await hashPassword('AdminPassword123!');
  const studentPasswordHash = await hashPassword('StudentPass123!');
  const colleaguePasswordHash = await hashPassword('ColleaguePass123!');

  const adminId = '11111111-1111-4111-8111-111111111111';
  const studentId = '22222222-2222-4222-8222-222222222222';
  const colleagueId = '33333333-3333-4333-8333-333333333333';

  // 1. Потребители
  const users = [
    {
      id: adminId,
      email: 'admin@tu-sofia.bg',
      password_hash: adminPasswordHash,
      full_name: 'Системен Администратор',
      role: 'admin',
      quota_bytes: 1073741824, // 1 GB
    },
    {
      id: studentId,
      email: 'student@tu-sofia.bg',
      password_hash: studentPasswordHash,
      full_name: 'Дипломант',
      role: 'user',
      quota_bytes: 104857600, // 100 MB
    },
    {
      id: colleagueId,
      email: 'colleague@tu-sofia.bg',
      password_hash: colleaguePasswordHash,
      full_name: 'Колега',
      role: 'user',
      quota_bytes: 104857600, // 100 MB
    }
  ];

  for (const u of users) {
    const existing = await db.queryOne('SELECT id FROM users WHERE email = $1', [u.email]);
    if (!existing) {
      await db.query(
        `INSERT INTO users (id, email, password_hash, full_name, role, quota_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [u.id, u.email, u.password_hash, u.full_name, u.role, u.quota_bytes]
      );
      logger.info(`Създаден потребител: ${u.email} (${u.role})`);
    }
  }

  // 2. Демо папки за студента
  const sampleFolders = [
    { id: generateUuid(), name: 'Дипломна работа - Документация', owner_id: studentId, parent_id: null },
    { id: generateUuid(), name: 'Програмен код и Скриптове', owner_id: studentId, parent_id: null },
    { id: generateUuid(), name: 'Архиви и Ресурси', owner_id: studentId, parent_id: null },
  ];

  for (const f of sampleFolders) {
    const existing = await db.queryOne(
      'SELECT id FROM folders WHERE owner_id = $1 AND name = $2 AND is_deleted = 0',
      [f.owner_id, f.name]
    );
    if (!existing) {
      await db.query(
        'INSERT INTO folders (id, owner_id, parent_id, name) VALUES ($1, $2, $3, $4)',
        [f.id, f.owner_id, f.parent_id, f.name]
      );
      logger.info(`Създадена начална папка: "${f.name}"`);
    }
  }

  logger.info('Seed процедурата завърши успешно!');
}

if (require.main === module) {
  runSeed().catch(err => {
    logger.error('Грешка при изпълнение на seed', { error: err.message });
    process.exit(1);
  });
}

module.exports = { runSeed };
