// =====================================================================
// Главен стартиращ файл за цялостната система (Main Application Runner)
// =====================================================================

const { db } = require('./common/db');
const { server: gatewayServer } = require('./services/gateway');
const { startCleanupScheduler } = require('./services/background/cleanup');
const { createLogger } = require('./common/logger');

const logger = createLogger('main-runner');
const PORT = parseInt(process.env.PORT_GATEWAY || '8080', 10);

async function bootstrap() {
  logger.info('Инициализиране на Облачна информационна система CloudFS (ТУ - София)...');

  // 1. Инициализация на базата данни и изпълнение на миграциите
  await db.init();

  // 2. Стартиране на периодичния фонов планировчик за почистване (всеки 15 мин)
  const cleanupTimer = startCleanupScheduler(15);

  // 3. Стартиране на API Gateway (включващ всички микросервизни маршрути)
  gatewayServer.listen(PORT, () => {
    logger.info(`=====================================================================`);
    logger.info(`CloudFS е достъпен на: http://localhost:${PORT}`);
    logger.info(`Метрики (Prometheus): http://localhost:${PORT}/metrics`);
    logger.info(`Health check:         http://localhost:${PORT}/health/live`);
    logger.info(`=====================================================================`);
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Получен сигнал за спиране. Извършване на graceful shutdown...');
    clearInterval(cleanupTimer);
    gatewayServer.close(() => {
      db.close();
      logger.info('Сървърът и базата данни са затворени коректно. Изход.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  bootstrap().catch(err => {
    logger.error('Критична грешка при стартиране на системата', { error: err.message });
    process.exit(1);
  });
}

module.exports = { bootstrap };
