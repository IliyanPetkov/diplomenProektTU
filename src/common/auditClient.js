// =====================================================================
// Клиент за одитния лог (Audit Log Client - Append-Only)
// =====================================================================

const { db } = require('./db');
const { generateUuid } = require('./crypto');
const { createLogger, maskSensitiveData } = require('./logger');

const logger = createLogger('audit-client');

class AuditClient {
  /**
   * Записва събитие в одитния журнал
   * @param {object} param0
   */
  async log({
    actorId = null,
    actorRole = null,
    action,
    targetType,
    targetId = null,
    result = 'SUCCESS',
    ipAddress = null,
    userAgent = null,
    correlationId = null,
    details = {},
  }) {
    const id = generateUuid();
    const sanitizedDetails = JSON.stringify(maskSensitiveData(details));

    const sql = `
      INSERT INTO audit_logs (
        id, actor_id, actor_role, action, target_type, target_id,
        result, ip_address, user_agent, correlation_id, details, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
    `;

    try {
      await db.query(sql, [
        id,
        actorId,
        actorRole,
        action,
        targetType,
        targetId,
        result,
        ipAddress,
        userAgent,
        correlationId,
        sanitizedDetails,
      ]);
      logger.debug('Записано одитно събитие', { action, actorId, targetId }, correlationId);
    } catch (err) {
      logger.error('Грешка при запис в одитния журнал', { error: err.message }, correlationId);
    }
  }
}

const auditClient = new AuditClient();

module.exports = {
  AuditClient,
  auditClient,
};
