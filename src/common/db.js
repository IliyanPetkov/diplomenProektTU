// =====================================================================
// Унифициран слой за достъп до данни (Database Layer with Migration Engine)
// Напълно асинхронен API (Uniform Async Database Access)
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PostgresWireClient } = require('./postgresClient');
const { createLogger } = require('./logger');

const logger = createLogger('database');

class DatabaseService {
  constructor() {
    this.sqliteDb = null;
    this.postgresClient = null;
    this.dialect = process.env.DB_DIALECT || 'sqlite';
    this.isInitialized = false;
    this.initPromise = null;
  }

  init(customPath = null) {
    if (this.isInitialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (this.dialect === 'postgres') {
        try {
          logger.info('Инициализиране на PostgreSQL връзка...');
          this.postgresClient = new PostgresWireClient();
          await this.postgresClient.connect();
          this.isInitialized = true;
          logger.info('Успешна връзка с PostgreSQL сървъра');
          await this.runMigrations();
          return;
        } catch (err) {
          if (process.env.NODE_ENV === 'production') {
            logger.error(`Критичен отказ: невъзможна връзка с PostgreSQL в продукционна среда: ${err.message}`);
            throw new Error(`PostgreSQL Connection Failed in Production: ${err.message}`);
          }
          logger.warn(`Неуспешна връзка с PostgreSQL (${err.message}). Превключване към SQLite локален режим.`);
          this.dialect = 'sqlite';
          this.postgresClient = null;
        }
      }

      // За локална среда и тестове използваме вградения SQLite драйвер в режим WAL
      const dbPath = customPath || process.env.DB_SQLITE_PATH || path.join(__dirname, '../../data/cloudfs.db');
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.sqliteDb = new DatabaseSync(dbPath);
      this.sqliteDb.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      this.isInitialized = true;
      logger.info('SQLite базата данни е успешно инициализирана', { path: dbPath });

      await this.runMigrations();
    })();

    return this.initPromise;
  }

  async runMigrations() {
    const migrationsDir = path.join(__dirname, '../../migrations');
    if (!fs.existsSync(migrationsDir)) return;

    const files = fs.readdirSync(migrationsDir).sort();
    for (const file of files) {
      if (file.endsWith('.sql')) {
        const fullPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(fullPath, 'utf8');
        try {
          if (this.dialect === 'postgres' && this.postgresClient) {
            await this.postgresClient.query(sql);
          } else if (this.sqliteDb) {
            this.sqliteDb.exec(sql);
          }
          logger.info(`Приложена миграция: ${file}`);
        } catch (err) {
          logger.error(`Грешка при прилагане на миграция ${file}`, { error: err.message });
          throw err;
        }
      }
    }
  }

  /**
   * Изпълнява параметризирана заявка асинхронно
   * @param {string} sql 
   * @param {Array} params 
   * @returns {Promise<Array<object>>} Редовете от резултата
   */
  async query(sql, params = []) {
    if (!this.isInitialized) {
      await this.init();
    }

    if (this.dialect === 'postgres' && this.postgresClient) {
      let interpolatedSql = sql;
      params.forEach((val, idx) => {
        const placeholder = `$${idx + 1}`;
        let safeVal;
        if (val === null || val === undefined) safeVal = 'NULL';
        else if (typeof val === 'number') safeVal = val;
        else safeVal = `'${String(val).replace(/'/g, "''")}'`;
        interpolatedSql = interpolatedSql.split(placeholder).join(safeVal);
      });
      return await this.postgresClient.query(interpolatedSql);
    }

    // Заместване на PostgreSQL $1, $2 маркери с ? за SQLite
    const convertedSql = sql.replace(/\$(\d+)/g, '?');

    try {
      const stmt = this.sqliteDb.prepare(convertedSql);
      const isSelect = /^\s*(SELECT|PRAGMA)/i.test(convertedSql) || /RETURNING\s+/i.test(convertedSql);
      if (isSelect) {
        return Promise.resolve(stmt.all(...params));
      } else {
        const info = stmt.run(...params);
        return Promise.resolve([{ changes: info.changes, lastInsertRowid: info.lastInsertRowid }]);
      }
    } catch (err) {
      logger.error('Грешка при изпълнение на SQL заявка', { sql: convertedSql, error: err.message });
      throw err;
    }
  }

  /**
   * Изпълнява заявка за единствен ред асинхронно
   * @param {string} sql 
   * @param {Array} params 
   * @returns {Promise<object|null>}
   */
  async queryOne(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows && rows.length > 0 ? rows[0] : null;
  }

  /**
   * Изпълнява транзакция
   * @param {Function} callback 
   */
  async withTransaction(callback) {
    if (!this.isInitialized) {
      await this.init();
    }

    if (this.dialect === 'postgres' && this.postgresClient) {
      await this.postgresClient.query('BEGIN');
      try {
        const result = await callback(this);
        await this.postgresClient.query('COMMIT');
        return result;
      } catch (err) {
        await this.postgresClient.query('ROLLBACK');
        throw err;
      }
    }

    this.sqliteDb.exec('BEGIN TRANSACTION;');
    try {
      const result = await callback(this);
      this.sqliteDb.exec('COMMIT;');
      return result;
    } catch (err) {
      this.sqliteDb.exec('ROLLBACK;');
      throw err;
    }
  }

  close() {
    if (this.postgresClient) {
      this.postgresClient.close();
      this.postgresClient = null;
    }
    if (this.sqliteDb) {
      this.sqliteDb.close();
      this.sqliteDb = null;
    }
    this.isInitialized = false;
    this.initPromise = null;
    logger.info('Връзката с базата данни е затворена');
  }
}

const dbInstance = new DatabaseService();

module.exports = {
  DatabaseService,
  db: dbInstance,
};
