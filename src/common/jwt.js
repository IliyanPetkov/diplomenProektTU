// =====================================================================
// JWT (JSON Web Token) Имплементация с HMAC-SHA256
// =====================================================================

const crypto = require('node:crypto');
const { UnauthorizedError } = require('./errors');

const DEFAULT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'tu_sofia_kst_default_jwt_secret_key_minimum_32_bytes_2026');

if (!DEFAULT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('Критична грешка при стартиране: Липсва задължителната конфигурационна променлива JWT_SECRET в продукционна среда!');
}

function base64UrlEncode(str) {
  return Buffer.from(str).toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

/**
 * Генерира подписан JWT токен
 * @param {object} payload 
 * @param {string} [secret] 
 * @param {number} [expiresInSec] 
 * @returns {string}
 */
function signJwt(payload, secret = DEFAULT_SECRET, expiresInSec = 900) {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSec,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('base64url');

  return `${dataToSign}.${signature}`;
}

/**
 * Верифицира JWT токен и връща декодирания payload
 * @param {string} token 
 * @param {string} [secret] 
 * @returns {object}
 */
function verifyJwt(token, secret = DEFAULT_SECRET) {
  if (!token || typeof token !== 'string') {
    throw new UnauthorizedError('Липсва автентикационен токен');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedError('Невалиден формат на JWT токен');
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('base64url');

  try {
    const sigA = Buffer.from(signature, 'utf8');
    const sigB = Buffer.from(expectedSignature, 'utf8');
    if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
      throw new UnauthorizedError('Невалиден подпис на токена');
    }
  } catch (err) {
    throw new UnauthorizedError('Грешка при валидация на подписа');
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (e) {
    throw new UnauthorizedError('Невалидно съдържание на JWT payload');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new UnauthorizedError('Токенът е с изтекъл срок на валидност');
  }

  return payload;
}

module.exports = {
  signJwt,
  verifyJwt,
};
