// =====================================================================
// Криптографски модул и функции за сигурност (Cryptography & Security)
// =====================================================================

const crypto = require('node:crypto');
const { Transform } = require('node:stream');

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';
const SALT_BYTES = 16;

/**
 * Хешира парола чрез PBKDF2-HMAC-SHA512 с уникална криптографска сол
 * @param {string} password
 * @returns {Promise<string>} Формат: salt$hash$iterations
 */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
    crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}$${derivedKey.toString('hex')}$${PBKDF2_ITERATIONS}`);
    });
  });
}

/**
 * Верифицира парола спрямо съхранен хеш чрез константно време за сравнение
 * @param {string} password 
 * @param {string} storedHash 
 * @returns {Promise<boolean>}
 */
function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    if (!storedHash || typeof storedHash !== 'string') return resolve(false);
    const parts = storedHash.split('$');
    if (parts.length !== 3) return resolve(false);

    const [salt, originalHash, iterationsStr] = parts;
    const iterations = parseInt(iterationsStr, 10) || PBKDF2_ITERATIONS;

    crypto.pbkdf2(password, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST, (err, derivedKey) => {
      if (err) return reject(err);
      try {
        const origBuf = Buffer.from(originalHash, 'hex');
        const match = crypto.timingSafeEqual(derivedKey, origBuf);
        resolve(match);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * Генерира криптографски сигурен псевдослучаен токен
 * @param {number} bytes 
 * @returns {string} Hex низ
 */
function generateRandomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Генерира UUID v4
 * @returns {string}
 */
function generateUuid() {
  return crypto.randomUUID();
}

/**
 * Изчислява SHA-256 хеш за низ или Buffer
 * @param {string|Buffer} data 
 * @returns {string}
 */
function computeSha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Стрийминг трансформация за изчисление на SHA-256 и броене на байтове без претоварване на RAM
 */
class HashPassThroughStream extends Transform {
  constructor(options = {}) {
    super(options);
    this.hash = crypto.createHash('sha256');
    this.totalBytes = 0;
  }

  _transform(chunk, encoding, callback) {
    this.totalBytes += chunk.length;
    this.hash.update(chunk);
    this.push(chunk);
    callback();
  }

  getSha256Digest() {
    return this.hash.digest('hex');
  }

  getTotalBytes() {
    return this.totalBytes;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateRandomToken,
  generateUuid,
  computeSha256,
  HashPassThroughStream,
};
