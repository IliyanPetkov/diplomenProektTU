// =====================================================================
// Unit Test: Криптография, Хеширане и JWT Токени
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { hashPassword, verifyPassword, computeSha256, HashPassThroughStream, generateRandomToken } = require('../../src/common/crypto');
const { signJwt, verifyJwt } = require('../../src/common/jwt');
const { UnauthorizedError } = require('../../src/common/errors');

test('PBKDF2 Хеширане и верификация на пароли', async () => {
  const plainPassword = 'MySecretPassword2026!';
  const hash = await hashPassword(plainPassword);

  assert.ok(hash.includes('$'), 'Хешът трябва да съдържа разделители за сол, хеш и итерации');
  const isValid = await verifyPassword(plainPassword, hash);
  assert.strictEqual(isValid, true, 'Валидната парола трябва да съвпада');

  const isInvalid = await verifyPassword('WrongPassword123!', hash);
  assert.strictEqual(isInvalid, false, 'Грешната парола трябва да бъде отхвърлена');
});

test('SHA-256 стрийминг изчисление без зареждане на целия файл в RAM', async () => {
  const content = 'Това е тестов стрийминг низ за проверка на SHA-256 контролна сума.';
  const expectedHash = computeSha256(content);

  const inputStream = Readable.from([Buffer.from(content)]);
  const hashStream = new HashPassThroughStream();

  let receivedChunks = [];
  hashStream.on('data', chunk => receivedChunks.push(chunk));

  await pipeline(inputStream, hashStream);

  const calculatedHash = hashStream.getSha256Digest();
  const totalBytes = hashStream.getTotalBytes();

  assert.strictEqual(calculatedHash, expectedHash, 'Изчисленият хеш през потока трябва да съвпада с очаквания');
  assert.strictEqual(totalBytes, Buffer.byteLength(content), 'Преброените байтове трябва да са точни');
  assert.strictEqual(Buffer.concat(receivedChunks).toString('utf8'), content, 'Данните не трябва да бъдат повредени при преминаване през потока');
});

test('JWT подписване, валидация и проверка за изтичане', () => {
  const secret = 'test_jwt_secret_key_32_bytes_long_minimum!';
  const payload = { sub: 'user-123', email: 'test@tu-sofia.bg', role: 'user' };

  const token = signJwt(payload, secret, 3600);
  const decoded = verifyJwt(token, secret);

  assert.strictEqual(decoded.sub, 'user-123');
  assert.strictEqual(decoded.email, 'test@tu-sofia.bg');
  assert.strictEqual(decoded.role, 'user');
  assert.ok(decoded.exp > Math.floor(Date.now() / 1000));

  // Тест с манипулиран токен (tampering)
  const parts = token.split('.');
  const tamperedToken = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'admin-999', role: 'admin' })).toString('base64url')}.${parts[2]}`;
  assert.throws(() => verifyJwt(tamperedToken, secret), UnauthorizedError, 'Манипулираният токен трябва да хвърли UnauthorizedError');

  // Тест с изтекъл токен
  const expiredToken = signJwt(payload, secret, -10); // изтекъл преди 10 секунди
  assert.throws(() => verifyJwt(expiredToken, secret), UnauthorizedError, 'Изтеклият токен трябва да хвърли UnauthorizedError');
});
