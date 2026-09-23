// =====================================================================
// Скрипт за качване и тестване на 3 реални файла за 3 отделни потребителя
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { computeSha256 } = require('../src/common/crypto');
const { server } = require('../src/services/gateway');
const { db } = require('../src/common/db');

// Хелпър за изпълнение на заявки към Gateway без мрежов сокет (sandboxed)
class MockRequest extends Readable {
  constructor(options = {}) {
    super();
    this.method = (options.method || 'GET').toUpperCase();
    this.url = options.path || '/';
    this.headers = options.headers || {};
    this.socket = { remoteAddress: '127.0.0.1' };
    const body = options.body;
    if (body) {
      if (Buffer.isBuffer(body)) {
        this.push(body);
      } else if (typeof body === 'string') {
        this.push(Buffer.from(body));
      } else {
        this.push(Buffer.from(JSON.stringify(body)));
      }
    }
    this.push(null);
  }
}

class MockResponse extends require('node:events').EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
  }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  getHeader(name) { return this.headers[name.toLowerCase()]; }
  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
  }
  write(chunk) {
    if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }
  end(chunk) {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this.emit('finish');
  }
  get body() {
    const raw = Buffer.concat(this.chunks).toString('utf8');
    try { return JSON.parse(raw); } catch { return raw; }
  }
  get rawBuffer() {
    return Buffer.concat(this.chunks);
  }
}

function dispatchRequest(options) {
  return new Promise((resolve) => {
    const req = new MockRequest(options);
    const res = new MockResponse();
    res.on('finish', () => resolve(res));
    server.emit('request', req, res);
  });
}

async function loginUser(email, password) {
  const res = await dispatchRequest({
    path: '/api/v1/auth/login',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Неуспешен вход за ${email}: ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.accessToken,
    user: res.body.user,
  };
}

async function uploadFileForUser(token, filePath, customName = null) {
  const originalBuffer = fs.readFileSync(filePath);
  const filename = customName || path.basename(filePath);
  const sizeBytes = originalBuffer.length;
  const originalSha256 = computeSha256(originalBuffer);

  // 1. Инициализиране на качването
  const initRes = await dispatchRequest({
    path: '/api/v1/upload/init',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
    },
    body: {
      filename,
      sizeBytes,
      mimeType: filename.endsWith('.py') ? 'text/x-python' : (filename.endsWith('.jpg') ? 'image/jpeg' : 'text/plain'),
    },
  });

  if (initRes.statusCode !== 200) {
    throw new Error(`Upload Init грешка: ${JSON.stringify(initRes.body)}`);
  }
  const uploadId = initRes.body.uploadId;

  // 2. Поточен ъплоуд
  const streamRes = await dispatchRequest({
    path: `/api/v1/upload/${uploadId}/stream`,
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'authorization': `Bearer ${token}`,
    },
    body: originalBuffer,
  });

  if (streamRes.statusCode !== 200) {
    throw new Error(`Upload Stream грешка: ${JSON.stringify(streamRes.body)}`);
  }
  assert.strictEqual(streamRes.body.checksumSha256, originalSha256, 'SHA-256 при стрийминга трябва да съвпада точно');

  // 3. Финализиране (Commit)
  const commitRes = await dispatchRequest({
    path: `/api/v1/upload/${uploadId}/commit`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
    },
    body: {
      sizeBytes,
      checksumSha256: originalSha256,
    },
  });

  if (commitRes.statusCode !== 200) {
    throw new Error(`Upload Commit грешка: ${JSON.stringify(commitRes.body)}`);
  }

  const fileId = commitRes.body.fileId;

  // 4. Тест за изтегляне и побитова проверка
  const downloadRes = await dispatchRequest({
    path: `/api/v1/download/${fileId}`,
    method: 'GET',
    headers: {
      'authorization': `Bearer ${token}`,
    },
  });

  assert.strictEqual(downloadRes.statusCode, 200, 'Свалянето трябва да е успешно (HTTP 200)');
  const downloadedBuffer = downloadRes.rawBuffer;
  const downloadedSha256 = computeSha256(downloadedBuffer);

  assert.strictEqual(downloadedBuffer.length, sizeBytes, 'Размерът на изтегления файл трябва да съвпада точно');
  assert.strictEqual(downloadedSha256, originalSha256, 'Побитовият SHA-256 хеш трябва да е 100% идентичен');

  return {
    fileId,
    filename,
    sizeBytes,
    sha256: originalSha256,
    downloadedSha256,
    healthyNodesCount: streamRes.body.healthyNodesCount,
  };
}

async function runThreeFilesTest() {
  console.log('=====================================================================');
  console.log('ТЕСТ: Качване и верификация на 3 отделни реални файла за 3 потребителя');
  console.log('=====================================================================\n');

  // 1. Инициализиране на базата данни и схемите
  await db.init();
  console.log('✓ Базата данни е стартирана и инициализирана успешно.\n');

  // Дефиниране на трите реални файла от Downloads
  const file1Path = path.resolve('/Users/pc/Downloads/classroom25Jun.txt');
  const file2Path = path.resolve('/Users/pc/Downloads/analyze_duecos.py');
  const file3Path = path.resolve('/Users/pc/Downloads/sign.jpg');

  assert.ok(fs.existsSync(file1Path), `Файл 1 не съществува: ${file1Path}`);
  assert.ok(fs.existsSync(file2Path), `Файл 2 не съществува: ${file2Path}`);
  assert.ok(fs.existsSync(file3Path), `Файл 3 не съществува: ${file3Path}`);

  // 2. Вход на тримата потребители
  console.log('1. Автентикация на 3-те потребителя:');
  const user1 = await loginUser('admin@tu-sofia.bg', 'AdminPassword123!');
  console.log(`   ✓ Потребител 1 (Администратор): ${user1.user.fullName} (${user1.user.email}) - Токен получен`);

  const user2 = await loginUser('student@tu-sofia.bg', 'StudentPass123!');
  console.log(`   ✓ Потребител 2 (Студент):       ${user2.user.fullName} (${user2.user.email}) - Токен получен`);

  const user3 = await loginUser('colleague@tu-sofia.bg', 'ColleaguePass123!');
  console.log(`   ✓ Потребител 3 (Колега):        ${user3.user.fullName} (${user3.user.email}) - Токен получен\n`);

  // 3. Качване на Файл 1 за Потребител 1 (Admin)
  console.log('2. Качване на Файл 1 за Потребител 1 (admin@tu-sofia.bg):');
  console.log(`   Оригинален път: ${file1Path}`);
  const result1 = await uploadFileForUser(user1.token, file1Path);
  console.log(`   ✓ Файл: "${result1.filename}" (${result1.sizeBytes} байта)`);
  console.log(`   ✓ SHA-256 хеш: ${result1.sha256}`);
  console.log(`   ✓ Записан с излишък върху ${result1.healthyNodesCount} дискови възела`);
  console.log(`   ✓ Изтеглен обратно: Побитово съвпадение 100% OK!\n`);

  // 4. Качване на Файл 2 за Потребител 2 (Student)
  console.log('3. Качване на Файл 2 за Потребител 2 (student@tu-sofia.bg):');
  console.log(`   Оригинален път: ${file2Path}`);
  const result2 = await uploadFileForUser(user2.token, file2Path);
  console.log(`   ✓ Файл: "${result2.filename}" (${result2.sizeBytes} байта)`);
  console.log(`   ✓ SHA-256 хеш: ${result2.sha256}`);
  console.log(`   ✓ Записан с излишък върху ${result2.healthyNodesCount} дискови възела`);
  console.log(`   ✓ Изтеглен обратно: Побитово съвпадение 100% OK!\n`);

  // 5. Качване на Файл 3 за Потребител 3 (Colleague)
  console.log('4. Качване на Файл 3 за Потребител 3 (colleague@tu-sofia.bg):');
  console.log(`   Оригинален път: ${file3Path}`);
  const result3 = await uploadFileForUser(user3.token, file3Path);
  console.log(`   ✓ Файл: "${result3.filename}" (${result3.sizeBytes} байта)`);
  console.log(`   ✓ SHA-256 хеш: ${result3.sha256}`);
  console.log(`   ✓ Записан с излишък върху ${result3.healthyNodesCount} дискови възела`);
  console.log(`   ✓ Изтеглен обратно: Побитово съвпадение 100% OK!\n`);

  // 6. Проверка на изолацията (IDOR тест между 3-мата потребители)
  console.log('5. Проверка на изолацията и правата за достъп (IDOR тест):');
  // Студентът се опитва да изтегли файла на Колегата без споделяне
  const idorRes = await dispatchRequest({
    path: `/api/v1/download/${result3.fileId}`,
    method: 'GET',
    headers: { 'authorization': `Bearer ${user2.token}` },
  });
  assert.strictEqual(idorRes.statusCode, 403, 'Студентът не трябва да може да тегли чужд файл без споделяне (HTTP 403)');
  console.log('   ✓ Изолация потвърдена: Студентът получи HTTP 403 Forbidden при опит за достъп до файла на Колегата.');

  // 7. Споделяне на Файл 2 от Студент към Колега и валидиране на достъпа
  console.log('\n6. Споделяне на Файл 2 (student -> colleague):');
  const shareRes = await dispatchRequest({
    path: '/api/v1/shares',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${user2.token}`,
    },
    body: {
      fileId: result2.fileId,
      granteeEmail: 'colleague@tu-sofia.bg',
      permission: 'viewer',
    },
  });
  assert.strictEqual(shareRes.statusCode, 200);
  console.log(`   ✓ Файлът "${result2.filename}" беше споделен успешно с colleague@tu-sofia.bg.`);

  // Сега Колегата изтегля споделения файл
  const colleagueDownloadRes = await dispatchRequest({
    path: `/api/v1/download/${result2.fileId}`,
    method: 'GET',
    headers: { 'authorization': `Bearer ${user3.token}` },
  });
  assert.strictEqual(colleagueDownloadRes.statusCode, 200);
  assert.strictEqual(computeSha256(colleagueDownloadRes.rawBuffer), result2.sha256);
  console.log('   ✓ Колегата изтегли успешно споделения файл с перфектно побитово съвпадение на SHA-256!\n');

  // 8. Проверка на одитния журнал
  console.log('7. Проверка на одитния журнал (Audit Service):');
  const auditRes = await dispatchRequest({
    path: '/api/v1/audit/logs?limit=10',
    method: 'GET',
    headers: { 'authorization': `Bearer ${user1.token}` }, // Само admin може да чете одит лога
  });
  assert.strictEqual(auditRes.statusCode, 200);
  const actions = auditRes.body.logs.map(l => l.action);
  console.log(`   ✓ Регистрирани последни действия в одитния лог: ${actions.slice(0, 5).join(', ')}`);

  console.log('\n=====================================================================');
  console.log('🎉 РЕЗУЛТАТ: Всички 3 файла са качени, записани с излишък, изтеглени,');
  console.log('   верифицирани с SHA-256 и правата за споделяне са потвърдени 100%!');
  console.log('=====================================================================\n');
}

if (require.main === module) {
  runThreeFilesTest().catch(err => {
    console.error('Грешка при теста:', err);
    process.exit(1);
  });
}

module.exports = { runThreeFilesTest };
