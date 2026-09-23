// =====================================================================
// Audit Service: Защитен одит лог и анализ на сигурността
// =====================================================================

const { MicroserviceApp } = require('../../common/httpServer');
const { db } = require('../../common/db');
const { auditClient } = require('../../common/auditClient');
const { ForbiddenError } = require('../../common/errors');

const app = new MicroserviceApp('audit-service');
const PORT = parseInt(process.env.PORT_AUDIT || '8086', 10);

// 1. Извличане на одитния журнал с филтрация (Само за администратори)
app.get('/logs', async ({ user, query }) => {
  if (user.role !== 'admin') {
    throw new ForbiddenError('Достъпът до одитния журнал е разрешен само за администратори');
  }

  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);

  const whereClauses = [];
  const params = [];

  if (query.action) {
    params.push(query.action);
    whereClauses.push(`action = $${params.length}`);
  }

  if (query.actorId) {
    params.push(query.actorId);
    whereClauses.push(`actor_id = $${params.length}`);
  }

  if (query.result) {
    params.push(query.result);
    whereClauses.push(`result = $${params.length}`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = `
    SELECT id, actor_id, actor_role, action, target_type, target_id, result, ip_address, user_agent, correlation_id, details, timestamp
    FROM audit_logs
    ${whereSql}
    ORDER BY timestamp DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const logs = await db.query(sql, params);
  const totalCountRow = await db.queryOne(`SELECT count(*) as total FROM audit_logs ${whereSql}`, params);

  return {
    total: totalCountRow ? totalCountRow.total : logs.length,
    limit,
    offset,
    logs: logs.map(l => {
      let parsedDetails = null;
      try {
        parsedDetails = l.details ? JSON.parse(l.details) : null;
      } catch (e) {
        parsedDetails = l.details;
      }
      return {
        id: l.id,
        actorId: l.actor_id,
        actorRole: l.actor_role,
        action: l.action,
        targetType: l.target_type,
        targetId: l.target_id,
        result: l.result,
        ipAddress: l.ip_address,
        userAgent: l.user_agent,
        correlationId: l.correlation_id,
        details: parsedDetails,
        timestamp: l.timestamp,
      };
    }),
  };
}, { authRequired: true, roles: ['admin'] });

// 2. Статистика за администраторския дашборд
app.get('/stats', async ({ user }) => {
  if (user.role !== 'admin') throw new ForbiddenError('Административен достъп');

  const totalUsers = await db.queryOne("SELECT count(*) as count FROM users");
  const totalFiles = await db.queryOne("SELECT count(*) as count, coalesce(sum(size_bytes), 0) as total_size FROM files WHERE is_deleted = 0");
  const recentLogins = await db.queryOne("SELECT count(*) as count FROM audit_logs WHERE action = 'LOGIN_SUCCESS'");
  const failedLogins = await db.queryOne("SELECT count(*) as count FROM audit_logs WHERE action = 'LOGIN_FAILURE'");

  return {
    usersCount: totalUsers?.count || 0,
    filesCount: totalFiles?.count || 0,
    totalStorageBytes: totalFiles?.total_size || 0,
    successfulLogins: recentLogins?.count || 0,
    failedLogins: failedLogins?.count || 0,
  };
}, { authRequired: true, roles: ['admin'] });

// 3. Вътрешен ендпоинт за запис на одитни събития от други услуги
app.post('/log', async ({ body }) => {
  await auditClient.log(body);
  return { success: true };
});

if (require.main === module) {
  (async () => {
    await db.init();
    app.listen(PORT, () => {
      app.logger.info(`Audit Service стартира на порт ${PORT}`);
    });
  })().catch(err => {
    app.logger.error('Грешка при стартиране на Audit Service', { error: err.message });
    process.exit(1);
  });
}

module.exports = { app };
