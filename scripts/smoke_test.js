// =====================================================================
// End-to-End Smoke Test: Цялостен потребителски сценарий и верификация
// (Съвместим със sandboxed среда без външен мрежов достъп)
// =====================================================================

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const { computeSha256 } = require('../src/common/crypto');
const { server } = require('../src/services/gateway');
const { db } = require('../src/common/db');

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

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name) {
    return this.headers[name.toLowerCase()];
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [k, v] of Object.entries(headers)) {
      this.setHeader(k, v);
    }
  }

  write(chunk) {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return true;
  }

  end(chunk) {
    if (chunk) {
      this.write(chunk);
    }
    this.writableEnded = true;
    this.emit('finish');
  }

  pipe(dest) {
    // Поддръжка за pipe към mock streams
    const buf = Buffer.concat(this.chunks);
    dest.write(buf);
    dest.end();
  }

  get body() {
    const raw = Buffer.concat(this.chunks).toString('utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  get rawBody() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function dispatchGatewayRequest(options) {
  return new Promise((resolve) => {
    const req = new MockRequest(options);
    const res = new MockResponse();
    res.on('finish', () => {
      resolve(res);
    });
    server.emit('request', req, res);
  });
}

async function runSmokeTest() {
  console.log('--- Стартиране на End-to-End Smoke Test ---');
  db.init();

  // 1. Health checks
  const health = await dispatchGatewayRequest({ path: '/health/live', method: 'GET' });
  assert.strictEqual(health.statusCode, 200);
  assert.strictEqual(health.body.status, 'UP');
  console.log('✓ Health check /health/live: OK');

  // 2. Вход със seeded студентски акаунт
  const loginRes = await dispatchGatewayRequest({
    path: '/api/v1/auth/login',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { email: 'student@tu-sofia.bg', password: 'StudentPass123!' },
  });

  assert.strictEqual(loginRes.statusCode, 200);
  const token = loginRes.body.accessToken;
  assert.ok(token, 'Трябва да получим валиден JWT Bearer токен');
  console.log('✓ Вход на студент (student@tu-sofia.bg): Успешен');

  // 3. Създаване на папка
  const folderRes = await dispatchGatewayRequest({
    path: '/api/v1/folders',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
    },
    body: { name: 'Дипломна Папка ' + Date.now() },
  });

  assert.strictEqual(folderRes.statusCode, 200);
  const folderId = folderRes.body.id;
  console.log(`✓ Създадена тестова папка: ID=${folderId}`);

  // 4. Инициализиране на качване (upload/init)
  const testFileContent = 'ТЕСТОВО СЪДЪРЖАНИЕ ЗА ДИПЛОМНА РАБОТА ТУ - СОФИЯ 2026';
  const testFileBuffer = Buffer.from(testFileContent, 'utf8');
  const testChecksum = computeSha256(testFileBuffer);

  const initRes = await dispatchGatewayRequest({
    path: '/api/v1/upload/init',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
    },
    body: {
      filename: 'diploma_smoke.txt',
      sizeBytes: testFileBuffer.length,
      mimeType: 'text/plain',
      folderId,
    },
  });

  assert.strictEqual(initRes.statusCode, 200);
  const uploadId = initRes.body.uploadId;
  console.log(`✓ Инициализирано качване: UploadId=${uploadId}`);

  // 5. Поточен ъплоуд (upload/stream)
  const streamRes = await dispatchGatewayRequest({
    path: `/api/v1/upload/${uploadId}/stream`,
    method: 'PUT',
    headers: {
      'content-type': 'text/plain',
      'authorization': `Bearer ${token}`,
    },
    body: testFileBuffer,
  });

  assert.strictEqual(streamRes.statusCode, 200);
  assert.strictEqual(streamRes.body.checksumSha256, testChecksum);
  console.log(`✓ Поточно качен файл с изчислен SHA-256: ${testChecksum.slice(0, 16)}...`);

  // 6. Финализиране (upload/commit)
  const commitRes = await dispatchGatewayRequest({
    path: `/api/v1/upload/${uploadId}/commit`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
    },
    body: {
      sizeBytes: testFileBuffer.length,
      checksumSha256: testChecksum,
    },
  });

  assert.strictEqual(commitRes.statusCode, 200);
  const fileId = commitRes.body.fileId;
  console.log(`✓ Успешно потвърден файл: FileId=${fileId}`);

  // 7. Изтегляне и побитова проверка на съдържанието
  const downloadRes = await dispatchGatewayRequest({
    path: `/api/v1/download/${fileId}`,
    method: 'GET',
    headers: {
      'authorization': `Bearer ${token}`,
    },
  });

  assert.strictEqual(downloadRes.statusCode, 200);
  assert.strictEqual(downloadRes.rawBody, testFileContent);
  assert.strictEqual(computeSha256(downloadRes.rawBody), testChecksum);
  console.log('✓ Изтегленият файл е 100% идентичен побитово!');

  // 8. Проверка на Prometheus метриките
  const metricsRes = await dispatchGatewayRequest({
    path: '/metrics',
    method: 'GET',
  });

  assert.strictEqual(metricsRes.statusCode, 200);
  assert.ok(metricsRes.rawBody.includes('http_requests_total'));
  assert.ok(metricsRes.rawBody.includes('uploads_total'));
  console.log('✓ Prometheus метриките са налични и отразяват реални заявки');

  console.log('\n======================================================');
  console.log('🎉 ВСИЧКИ СТЪПКИ ОТ SMOKE ТЕСТА ЗАВЪРШИХА УСПЕШНО!');
  console.log('======================================================\n');
}

if (require.main === module) {
  runSmokeTest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Smoke тестът се провали:', err);
      process.exit(1);
    });
}

module.exports = { runSmokeTest };
