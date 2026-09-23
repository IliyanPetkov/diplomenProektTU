// =====================================================================
// Background Service: Reconciliation & Cleanup Worker
// Почистване на прекъснати качвания и сирачни обекти (Orphan Reconciliation)
// =====================================================================

const { db } = require('../../common/db');
const { storageEngine } = require('../storage/redundantStorageEngine');
const { createLogger } = require('../../common/logger');
const { defaultRegistry } = require('../../common/metrics');

const logger = createLogger('cleanup-worker');

async function runCleanupJob(maxAgeMinutes = 60) {
  logger.info('Стартиране на фонова задача за почистване и реконсилиация...');
  let cleanedSessionsCount = 0;
  let deletedOrphansCount = 0;

  try {
    await db.init();

    // 1. Откриване на изоставени или прекъснати upload сесии
    const cutoffTime = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
    const staleSessions = await db.query(
      `SELECT id, temp_storage_key, filename, user_id 
       FROM upload_sessions 
       WHERE status IN ('INITIATED', 'UPLOADING') AND created_at < $1`,
      [cutoffTime]
    );

    for (const s of staleSessions) {
      logger.warn(`Почистване на прекъсната сесия за качване: ${s.id} (${s.filename})`);
      // Изтриване на временния файл от възлите за съхранение
      storageEngine.deleteObject(s.temp_storage_key);

      // Маркиране на сесията като прекратена
      await db.query("UPDATE upload_sessions SET status = 'ABORTED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [s.id]);
      cleanedSessionsCount += 1;
    }

    logger.info(`Приключи почистването на сесии. Прекратени изоставени сесии: ${cleanedSessionsCount}`);
    return { cleanedSessionsCount, deletedOrphansCount };
  } catch (err) {
    logger.error('Грешка по време на изпълнение на cleanup job', { error: err.message });
    defaultRegistry.incCounter('background_job_failures_total', { job: 'cleanup_worker' });
    throw err;
  }
}

/**
 * Стартира периодичен scheduler за фоново почистване
 * @param {number} intervalMinutes 
 * @returns {NodeJS.Timeout}
 */
function startCleanupScheduler(intervalMinutes = 15) {
  logger.info(`Стартиран периодичен Cleanup планировчик (интервал: ${intervalMinutes} мин)`);
  // Първоначално почистване след 5 секунди
  setTimeout(() => runCleanupJob().catch(() => {}), 5000).unref();

  const timer = setInterval(() => {
    runCleanupJob().catch(() => {});
  }, intervalMinutes * 60 * 1000);

  if (timer.unref) {
    timer.unref();
  }
  return timer;
}

if (require.main === module) {
  runCleanupJob()
    .then(res => {
      logger.info('Cleanup задачата приключи успешно', res);
      process.exit(0);
    })
    .catch(() => process.exit(1));
}

module.exports = { runCleanupJob, startCleanupScheduler };
