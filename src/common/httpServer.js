// =====================================================================
// Лека и надеждна HTTP микросервисна инфраструктура (Native HTTP Server)
// =====================================================================

const http = require('node:http');
const url = require('node:url');
const { createLogger } = require('./logger');
const { defaultRegistry } = require('./metrics');
const { AppError, NotFoundError } = require('./errors');
const { verifyJwt } = require('./jwt');

/**
 * Чете тялото на заявката като Buffer или JSON
 * @param {http.IncomingMessage} req 
 * @param {number} maxBytes 
 * @returns {Promise<Buffer>}
 */
function readRequestBody(req, maxBytes = 10485760) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new AppError('Превишен максимален размер на тялото на заявката', 413, 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

class MicroserviceApp {
  constructor(serviceName) {
    this.serviceName = serviceName;
    this.logger = createLogger(serviceName);
    this.routes = []; // { method, pattern, handler, authRequired, roles }
    this.server = null;
  }

  use(method, pathPattern, handler, options = {}) {
    const regexPattern = new RegExp('^' + pathPattern.replace(/:([a-zA-Z0-9_]+)/g, '(?<$1>[^/]+)') + '$');
    this.routes.push({
      method: method.toUpperCase(),
      pattern: regexPattern,
      handler,
      authRequired: options.authRequired || false,
      roles: options.roles || [],
      rawBody: options.rawBody || false,
    });
  }

  get(path, handler, options) { this.use('GET', path, handler, options); }
  post(path, handler, options) { this.use('POST', path, handler, options); }
  put(path, handler, options) { this.use('PUT', path, handler, options); }
  patch(path, handler, options) { this.use('PATCH', path, handler, options); }
  delete(path, handler, options) { this.use('DELETE', path, handler, options); }

  async handleRequest(req, res) {
    const startTime = process.hrtime();
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();
    const correlationId = req.headers['x-correlation-id'] || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    res.setHeader('X-Correlation-ID', correlationId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // Стандартни Health Checks и Prometheus Metrics за всеки микросервис
    if (pathname === '/health/live') {
      res.writeHead(200);
      return res.end(JSON.stringify({ status: 'UP', service: this.serviceName, timestamp: new Date().toISOString() }));
    }

    if (pathname === '/health/ready') {
      res.writeHead(200);
      return res.end(JSON.stringify({ status: 'READY', service: this.serviceName, timestamp: new Date().toISOString() }));
    }

    if (pathname === '/metrics') {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.writeHead(200);
      return res.end(defaultRegistry.toPrometheusFormat());
    }

    // Търсене на маршрут
    let matchedRoute = null;
    let params = {};

    for (const route of this.routes) {
      if (route.method === method || (route.method === 'ALL')) {
        const match = pathname.match(route.pattern);
        if (match) {
          matchedRoute = route;
          params = match.groups || {};
          break;
        }
      }
    }

    if (!matchedRoute) {
      defaultRegistry.incCounter('http_requests_total', { service: this.serviceName, method, status: 404 });
      res.writeHead(404);
      return res.end(JSON.stringify(new NotFoundError(`Маршрутът ${method} ${pathname} не е намерен`).toJSON()));
    }

    // Аутентикация и роли
    let user = null;
    if (matchedRoute.authRequired) {
      const authHeader = req.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Липсва валиден Bearer токен' } }));
      }
      try {
        const token = authHeader.slice(7);
        user = verifyJwt(token);
        if (matchedRoute.roles.length > 0 && !matchedRoute.roles.includes(user.role)) {
          res.writeHead(403);
          return res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Нямате необходимите роли за операцията' } }));
        }
      } catch (err) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: err.message } }));
      }
    }

    // Четене на тяло
    let body = null;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      if (!matchedRoute.rawBody) {
        try {
          const rawBuffer = await readRequestBody(req);
          if (rawBuffer.length > 0) {
            const contentType = req.headers['content-type'] || '';
            if (contentType.includes('application/json')) {
              body = JSON.parse(rawBuffer.toString('utf8'));
            } else {
              body = rawBuffer;
            }
          } else {
            body = {};
          }
        } catch (err) {
          const status = err.statusCode || 400;
          res.writeHead(status);
          return res.end(JSON.stringify({ error: { code: err.code || 'BAD_REQUEST', message: err.message } }));
        }
      }
    }

    const context = {
      req,
      res,
      params,
      query: parsedUrl.query,
      body,
      user,
      correlationId,
      logger: this.logger,
    };

    try {
      const result = await matchedRoute.handler(context);
      const [diffSec, diffNano] = process.hrtime(startTime);
      const durationSec = diffSec + diffNano / 1e9;

      const statusCode = res.statusCode || (result === undefined ? 204 : 200);
      defaultRegistry.incCounter('http_requests_total', { service: this.serviceName, method, status: statusCode });
      defaultRegistry.observeHistogram('http_request_duration_seconds', { service: this.serviceName, method }, durationSec);

      if (!res.writableEnded) {
        res.writeHead(statusCode);
        res.end(result !== undefined ? JSON.stringify(result) : null);
      }
    } catch (err) {
      const [diffSec, diffNano] = process.hrtime(startTime);
      const durationSec = diffSec + diffNano / 1e9;
      const status = err.statusCode || 500;

      defaultRegistry.incCounter('http_requests_total', { service: this.serviceName, method, status });
      defaultRegistry.observeHistogram('http_request_duration_seconds', { service: this.serviceName, method }, durationSec);

      this.logger.error(`Грешка при обработка на заявка ${method} ${pathname}`, {
        error: err.message,
        code: err.code,
        status,
      }, correlationId);

      if (!res.writableEnded) {
        res.writeHead(status);
        res.end(JSON.stringify({
          error: {
            code: err.code || 'INTERNAL_ERROR',
            message: err.message || 'Възникна вътрешна системна грешка',
            details: err.details || null,
          }
        }));
      }
    }
  }

  listen(port, callback) {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    const shutdown = (sig) => {
      this.logger.info(`Получен сигнал ${sig}. Спиране на ${this.serviceName}...`);
      this.close().then(() => {
        this.logger.info(`${this.serviceName} е спрян успешно.`);
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 8000).unref();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
    return this.server.listen(port, callback);
  }

  close() {
    if (this.server) {
      return new Promise((resolve) => this.server.close(resolve));
    }
    return Promise.resolve();
  }
}

module.exports = {
  MicroserviceApp,
  readRequestBody,
};
