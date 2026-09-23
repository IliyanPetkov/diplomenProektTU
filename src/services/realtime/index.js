// =====================================================================
// Realtime Service: SSE и WebSocket потоци за синхронизация
// =====================================================================

const http = require('node:http');
const url = require('node:url');
const { realtimeHub } = require('./hub');
const { verifyJwt } = require('../../common/jwt');
const { defaultRegistry } = require('../../common/metrics');
const { createLogger } = require('../../common/logger');

const logger = createLogger('realtime-service');
const PORT = parseInt(process.env.PORT_REALTIME || '8085', 10);

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Health checks
  if (pathname === '/health/live' || pathname === '/health/ready') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'UP', service: 'realtime-service' }));
  }

  if (pathname === '/metrics') {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.writeHead(200);
    return res.end(defaultRegistry.toPrometheusFormat());
  }

  // Вътрешен endpoint за излъчване на събития от други микросервиси
  if (pathname === '/events/broadcast' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => bodyStr += chunk);
    req.on('end', () => {
      try {
        const eventData = JSON.parse(bodyStr);
        realtimeHub.broadcastEvent(eventData);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, eventId: realtimeHub.eventSequence }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // SSE Stream Endpoint: GET /events
  if (pathname === '/events') {
    // Извличане на токен от query параметър (?token=...) или Authorization header
    let token = parsedUrl.query.token;
    if (!token && req.headers['authorization']) {
      const authHeader = req.headers['authorization'];
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
    }

    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Липсва автентикационен токен за realtime връзка' }));
    }

    let user;
    try {
      user = verifyJwt(token);
    } catch (err) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Невалиден или изтекъл токен' }));
    }

    // Установяване на SSE хедъри
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    realtimeHub.addClient(clientId, user.sub, res);

    // Първоначално heartbeat събитие
    res.write(`: connected as ${user.email} (${user.sub})\n\n`);

    // Проверка за Last-Event-ID за преиграване на изпуснати събития
    const lastEventId = parseInt(req.headers['last-event-id'] || parsedUrl.query.lastEventId || '0', 10);
    if (lastEventId > 0) {
      realtimeHub.replayMissedEvents(lastEventId, user.sub, res);
    }

    // Keep-alive пинг на всеки 25 секунди
    const keepAliveInterval = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch (e) {
        clearInterval(keepAliveInterval);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAliveInterval);
      realtimeHub.removeClient(clientId);
    });

    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

if (require.main === module) {
  server.listen(PORT, () => {
    logger.info(`Realtime Service стартира на порт ${PORT}`);
  });
}

module.exports = { server };
