// =====================================================================
// Identity & Access Management (IAM) Microservice
// Порт: 8081 | Отговорности: Автентикация, Сесии, Потребителски профили
// =====================================================================

const { MicroserviceApp } = require('../../common/httpServer');
const { db } = require('../../common/db');
const { hashPassword, verifyPassword, generateRandomToken, computeSha256, generateUuid } = require('../../common/crypto');
const { signJwt } = require('../../common/jwt');
const { validateEmail, validatePassword } = require('../../common/validator');
const { auditClient } = require('../../common/auditClient');
const {
  UnauthorizedError,
  ConflictError,
  NotFoundError,
} = require('../../common/errors');

const app = new MicroserviceApp('identity-service');
const PORT = parseInt(process.env.PORT_IDENTITY || '8081', 10);

// 1. Регистрация на нов потребител
app.post('/register', async ({ body, req, correlationId }) => {
  const email = validateEmail(body.email);
  const password = validatePassword(body.password);
  const fullName = (body.fullName || body.full_name || 'Потребител').trim();

  const existing = await db.queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    await auditClient.log({
      action: 'USER_REGISTER_FAILED',
      targetType: 'user',
      result: 'FAILURE',
      ipAddress: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      correlationId,
      details: { email, reason: 'Email already in use' }
    });
    throw new ConflictError('Потребител с този имейл вече съществува');
  }

  const userId = generateUuid();
  const passwordHash = await hashPassword(password);
  const defaultQuota = parseInt(process.env.DEFAULT_USER_QUOTA_BYTES || '104857600', 10); // 100 MB

  await db.query(
    `INSERT INTO users (id, email, password_hash, full_name, role, quota_bytes, used_bytes)
     VALUES ($1, $2, $3, $4, 'user', $5, 0)`,
    [userId, email, passwordHash, fullName, defaultQuota]
  );

  await auditClient.log({
    actorId: userId,
    actorRole: 'user',
    action: 'USER_REGISTER',
    targetType: 'user',
    targetId: userId,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
    details: { email, fullName }
  });

  // Създаване на сесия и refresh token за автоматичен незабавен вход
  const sessionId = generateUuid();
  const rawRefreshToken = generateRandomToken(48);
  const refreshTokenHash = computeSha256(rawRefreshToken);
  const refreshExpSec = parseInt(process.env.JWT_REFRESH_EXPIRATION_SEC || '604800', 10); // 7 дни
  const expiresAt = new Date(Date.now() + refreshExpSec * 1000).toISOString();

  await db.query(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, user_agent, ip_address, is_revoked, expires_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [sessionId, userId, refreshTokenHash, req.headers['user-agent'] || '', req.socket.remoteAddress || '', expiresAt]
  );

  const accessTokenExpSec = parseInt(process.env.JWT_ACCESS_EXPIRATION_SEC || '900', 10); // 15 мин
  const userPayload = {
    id: userId,
    email,
    fullName,
    role: 'user',
    quotaBytes: defaultQuota,
    usedBytes: 0,
  };

  const accessToken = signJwt(
    {
      sub: userId,
      email,
      role: 'user',
      fullName,
      sessionId,
    },
    process.env.JWT_SECRET,
    accessTokenExpSec
  );

  return {
    ...userPayload,
    accessToken,
    refreshToken: rawRefreshToken,
    user: userPayload,
  };
});

// 2. Вход (Login) и издаване на токени
app.post('/login', async ({ body, req, correlationId }) => {
  const email = validateEmail(body.email);
  const password = body.password || '';

  const user = await db.queryOne(
    'SELECT id, email, password_hash, full_name, role, quota_bytes, used_bytes FROM users WHERE email = $1',
    [email]
  );

  if (!user) {
    await auditClient.log({
      action: 'LOGIN_FAILURE',
      targetType: 'user',
      result: 'FAILURE',
      ipAddress: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      correlationId,
      details: { email, reason: 'User not found' }
    });
    throw new UnauthorizedError('Грешен имейл адрес или парола');
  }

  const isMatch = await verifyPassword(password, user.password_hash);
  if (!isMatch) {
    await auditClient.log({
      actorId: user.id,
      actorRole: user.role,
      action: 'LOGIN_FAILURE',
      targetType: 'user',
      targetId: user.id,
      result: 'FAILURE',
      ipAddress: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      correlationId,
      details: { email, reason: 'Invalid password' }
    });
    throw new UnauthorizedError('Грешен имейл адрес или парола');
  }

  // Създаване на сесия и refresh token
  const sessionId = generateUuid();
  const rawRefreshToken = generateRandomToken(48);
  const refreshTokenHash = computeSha256(rawRefreshToken);
  const refreshExpSec = parseInt(process.env.JWT_REFRESH_EXPIRATION_SEC || '604800', 10); // 7 дни
  const expiresAt = new Date(Date.now() + refreshExpSec * 1000).toISOString();

  await db.query(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, user_agent, ip_address, is_revoked, expires_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6)`,
    [sessionId, user.id, refreshTokenHash, req.headers['user-agent'] || '', req.socket.remoteAddress || '', expiresAt]
  );

  const accessTokenExpSec = parseInt(process.env.JWT_ACCESS_EXPIRATION_SEC || '900', 10); // 15 мин
  const accessToken = signJwt(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      fullName: user.full_name,
      sessionId,
    },
    process.env.JWT_SECRET,
    accessTokenExpSec
  );

  await auditClient.log({
    actorId: user.id,
    actorRole: user.role,
    action: 'LOGIN_SUCCESS',
    targetType: 'session',
    targetId: sessionId,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
    details: { email: user.email }
  });

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    sessionId,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      quotaBytes: Number(user.quota_bytes),
      usedBytes: Number(user.used_bytes),
    }
  };
});

// 3. Изход (Logout)
app.post('/logout', async ({ user, body, req, correlationId }) => {
  const sessionId = body?.sessionId || user?.sessionId;
  if (sessionId) {
    await db.query('UPDATE sessions SET is_revoked = 1 WHERE id = $1', [sessionId]);
  }

  await auditClient.log({
    actorId: user?.sub || null,
    actorRole: user?.role || null,
    action: 'LOGOUT',
    targetType: 'session',
    targetId: sessionId || null,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
  });

  return { message: 'Успешен изход от системата' };
}, { authRequired: true });

// 4. Обновяване на токен (Refresh)
app.post('/refresh', async ({ body, correlationId }) => {
  const rawToken = body?.refreshToken;
  if (!rawToken) {
    throw new UnauthorizedError('Липсва refresh token');
  }

  const tokenHash = computeSha256(rawToken);
  const session = await db.queryOne(
    `SELECT s.id, s.user_id, s.is_revoked, s.expires_at, u.email, u.full_name, u.role, u.quota_bytes, u.used_bytes
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.refresh_token_hash = $1`,
    [tokenHash]
  );

  if (!session || session.is_revoked === 1) {
    throw new UnauthorizedError('Невалидна или отнета сесия');
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw new UnauthorizedError('Изтекла сесия. Моля, влезте отново.');
  }

  const accessTokenExpSec = parseInt(process.env.JWT_ACCESS_EXPIRATION_SEC || '900', 10);
  const accessToken = signJwt(
    {
      sub: session.user_id,
      email: session.email,
      role: session.role,
      fullName: session.full_name,
      sessionId,
    },
    process.env.JWT_SECRET,
    accessTokenExpSec
  );

  return {
    accessToken,
    sessionId: session.id,
    user: {
      id: session.user_id,
      email: session.email,
      fullName: session.full_name,
      role: session.role,
      quotaBytes: Number(session.quota_bytes),
      usedBytes: Number(session.used_bytes),
    }
  };
});

// 5. Текущ профил (Get Me)
app.get('/me', async ({ user }) => {
  const profile = await db.queryOne(
    'SELECT id, email, full_name, role, quota_bytes, used_bytes, created_at FROM users WHERE id = $1',
    [user.sub]
  );
  if (!profile) {
    throw new NotFoundError('Потребителският профил не е намерен');
  }

  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    role: profile.role,
    quotaBytes: Number(profile.quota_bytes),
    usedBytes: Number(profile.used_bytes),
    createdAt: profile.created_at,
  };
}, { authRequired: true });

// 6. Списък с активни сесии на потребителя
app.get('/sessions', async ({ user }) => {
  const sessions = await db.query(
    `SELECT id, user_agent, ip_address, is_revoked, expires_at, created_at
     FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
    [user.sub]
  );
  return sessions.map(s => ({
    id: s.id,
    userAgent: s.user_agent,
    ipAddress: s.ip_address,
    isRevoked: Boolean(s.is_revoked),
    expiresAt: s.expires_at,
    createdAt: s.created_at,
    isCurrent: s.id === user.sessionId,
  }));
}, { authRequired: true });

// 7. Инвалидиране/отнемане на сесия
app.delete('/sessions/:id', async ({ user, params, correlationId, req }) => {
  const session = await db.queryOne('SELECT id, user_id FROM sessions WHERE id = $1', [params.id]);
  if (!session) {
    throw new NotFoundError('Сесията не е намерена');
  }

  if (session.user_id !== user.sub && user.role !== 'admin') {
    throw new UnauthorizedError('Нямате право да прекратявате чужди сесии');
  }

  await db.query('UPDATE sessions SET is_revoked = 1 WHERE id = $1', [params.id]);

  await auditClient.log({
    actorId: user.sub,
    actorRole: user.role,
    action: 'SESSION_REVOKED',
    targetType: 'session',
    targetId: params.id,
    result: 'SUCCESS',
    ipAddress: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    correlationId,
  });

  return { message: 'Сесията е прекратена успешно' };
}, { authRequired: true });

// 8. Списък с потребители (за споделяне)
app.get('/users', async ({ user }) => {
  const users = await db.query(
    'SELECT id, email, full_name FROM users WHERE id != $1 ORDER BY email ASC',
    [user.sub]
  );
  return users.map(u => ({ id: u.id, email: u.email, fullName: u.full_name }));
}, { authRequired: true });

if (require.main === module) {
  (async () => {
    await db.init();
    app.listen(PORT, () => {
      app.logger.info(`Identity Service стартира на порт ${PORT}`);
    });
  })().catch(err => {
    app.logger.error('Грешка при стартиране на Identity Service', { error: err.message });
    process.exit(1);
  });
}

module.exports = { app };
