// =====================================================================
// API Gateway / Edge Service: Входна точка, маршрутизация и сигурност
// Защитена среда с глобален Error Handler, CSRF и CORS контрол
// =====================================================================

const http = require('node:http');
const url = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const { RateLimiter } = require('./rateLimiter');
const { createLogger } = require('../../common/logger');
const { defaultRegistry } = require('../../common/metrics');
const { generateUuid } = require('../../common/crypto');

// Импортиране на микросервизните приложения за гъвкаво директно или прокси изпълнение
const identityApp = require('../identity').app;
const metadataApp = require('../metadata').app;
const storageApp = require('../storage').app;
const sharingApp = require('../sharing').app;
const auditApp = require('../audit').app;
const { server: realtimeServer } = require('../realtime');

const logger = createLogger('api-gateway');
const PORT = parseInt(process.env.PORT_GATEWAY || '8080', 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || (process.env.NODE_ENV === 'production' ? 'http://localhost:8080' : '*');

const authRateLimiter = new RateLimiter(
  parseInt(process.env.RATE_LIMIT_AUTH_MAX || '15', 10),
  parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MS || '60000', 10)
);

const generalRateLimiter = new RateLimiter(
  parseInt(process.env.RATE_LIMIT_GENERAL_MAX || '200', 10),
  parseInt(process.env.RATE_LIMIT_GENERAL_WINDOW_MS || '60000', 10)
);

function applySecurityHeaders(req, res) {
  const origin = req.headers['origin'];
  const allowedOriginHeader = (ALLOWED_ORIGIN === '*' || origin === ALLOWED_ORIGIN) ? (origin || ALLOWED_ORIGIN) : ALLOWED_ORIGIN;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss: http: https:;");
  res.setHeader('Access-Control-Allow-Origin', allowedOriginHeader);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-ID, If-Match, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-ID, ETag, Content-Disposition, X-File-Checksum-SHA256');
}

function checkCsrfProtection(req) {
  const method = req.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return true;

  const origin = req.headers['origin'];
  if (origin && ALLOWED_ORIGIN !== '*' && origin !== ALLOWED_ORIGIN) {
    return false;
  }
  return true;
}

function serveStaticFile(req, res, filePath, contentType) {
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', contentType);
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Файлът не е намерен' } }));
  }
}

const server = http.createServer(async (req, res) => {
  const startTime = process.hrtime();
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const clientIp = req.socket.remoteAddress || '127.0.0.1';
  const correlationId = req.headers['x-correlation-id'] || `gw-${Date.now()}-${generateUuid().slice(0, 8)}`;

  req.headers['x-correlation-id'] = correlationId;
  applySecurityHeaders(req, res);
  res.setHeader('X-Correlation-ID', correlationId);

  try {
    // 1. CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // 2. CSRF валидация за променящи състоянието заявки
    if (!checkCsrfProtection(req)) {
      logger.warn(`Отхвърлена заявка с невалиден Origin (CSRF): ${req.headers['origin']}`, { correlationId });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'CSRF_BLOCKED', message: 'Неразрешен крос-домейн източник' } }));
    }

    // 3. Health checks & Metrics
    if (pathname === '/health/live' || pathname === '/health/ready') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'UP', service: 'api-gateway', timestamp: new Date().toISOString() }));
    }

    if (pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      return res.end(defaultRegistry.toPrometheusFormat());
    }

    // 4. Rate Limiter проверка
    const isAuthEndpoint = pathname.startsWith('/api/v1/auth/login') || pathname.startsWith('/api/v1/auth/register');
    const limiter = isAuthEndpoint ? authRateLimiter : generalRateLimiter;

    if (!limiter.isAllowed(clientIp)) {
      logger.warn(`Превишен Rate Limit от IP: ${clientIp} за ${pathname}`, { correlationId });
      defaultRegistry.incCounter('http_requests_total', { service: 'api-gateway', method: req.method, status: 429 });
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Прекалено много заявки от вашия IP адрес. Моля, изчакайте минута преди нов опит.',
        }
      }));
    }

    // 5. Маршрутизация към Identity Service
    if (pathname.startsWith('/api/v1/auth')) {
      const strippedPath = pathname.replace('/api/v1/auth', '') || '/';
      req.url = strippedPath + (parsedUrl.search || '');
      return await identityApp.handleRequest(req, res);
    }
    if (pathname.startsWith('/api/v1/users')) {
      const strippedPath = pathname.replace('/api/v1', '') || '/';
      req.url = strippedPath + (parsedUrl.search || '');
      return await identityApp.handleRequest(req, res);
    }

    // 6. Маршрутизация към Metadata Service
    if (
      pathname.startsWith('/api/v1/folders') ||
      pathname.startsWith('/api/v1/files') ||
      pathname.startsWith('/api/v1/contents') ||
      pathname.startsWith('/api/v1/trash') ||
      pathname.startsWith('/api/v1/search') ||
      pathname.startsWith('/api/v1/admin/files')
    ) {
      const strippedPath = pathname.replace('/api/v1', '');
      req.url = strippedPath + (parsedUrl.search || '');
      return await metadataApp.handleRequest(req, res);
    }

    // 7. Маршрутизация към Storage Service
    if (
      pathname.startsWith('/api/v1/upload') ||
      pathname.startsWith('/api/v1/download') ||
      pathname.startsWith('/api/v1/storage')
    ) {
      const strippedPath = pathname.replace('/api/v1', '');
      req.url = strippedPath + (parsedUrl.search || '');
      return await storageApp.handleRequest(req, res);
    }

    // 8. Маршрутизация към Sharing Service
    if (
      pathname.startsWith('/api/v1/shares') ||
      pathname.startsWith('/api/v1/public-links') ||
      pathname.startsWith('/api/v1/public')
    ) {
      const strippedPath = pathname.replace('/api/v1', '');
      req.url = strippedPath + (parsedUrl.search || '');
      return await sharingApp.handleRequest(req, res);
    }

    // 9. Маршрутизация към Realtime Service (SSE)
    if (pathname === '/events' || pathname.startsWith('/api/v1/realtime')) {
      return realtimeServer.emit('request', req, res);
    }

    // 10. Маршрутизация към Audit Service
    if (pathname.startsWith('/api/v1/audit')) {
      const strippedPath = pathname.replace('/api/v1/audit', '') || '/';
      req.url = strippedPath + (parsedUrl.search || '');
      return await auditApp.handleRequest(req, res);
    }

    // 11. Обслужване на статичния Frontend UI
    const frontendDir = path.join(__dirname, '../../frontend');

    if (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/share/')) {
      return serveStaticFile(req, res, path.join(frontendDir, 'index.html'), 'text/html; charset=utf-8');
    }

    if (pathname === '/styles.css') {
      return serveStaticFile(req, res, path.join(frontendDir, 'styles.css'), 'text/css; charset=utf-8');
    }

    if (pathname === '/app.js') {
      return serveStaticFile(req, res, path.join(frontendDir, 'app.js'), 'application/javascript; charset=utf-8');
    }

    // 404 за непознати маршрути
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Няма намерен маршрут за ${req.method} ${pathname}` } }));
  } catch (criticalErr) {
    logger.error('Критична необработена грешка в Gateway', { error: criticalErr.message, stack: criticalErr.stack }, correlationId);
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL_GATEWAY_ERROR', message: 'Възникна вътрешна грешка в API Gateway' } }));
    }
  }
});

// Graceful shutdown за Gateway
function handleShutdownSignal(signal) {
  logger.info(`Получен ${signal}. Стартиране на graceful shutdown на API Gateway...`);
  server.close(() => {
    logger.info('API Gateway сървърът е спрян успешно.');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Принудително прекратяване след timeout при shutdown');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

if (require.main === module) {
  server.listen(PORT, () => {
    logger.info(`API Gateway успешно стартира на http://localhost:${PORT}`);
  });
}

module.exports = { server };
