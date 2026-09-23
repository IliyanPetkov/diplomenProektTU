// =====================================================================
// Realtime Hub: Централен диспечер на събития за синхронизация в реално време
// =====================================================================

const { EventEmitter } = require('node:events');
const { defaultRegistry } = require('../../common/metrics');
const { createLogger } = require('../../common/logger');

const logger = createLogger('realtime-hub');

class RealtimeHub extends EventEmitter {
  constructor() {
    super();
    this.eventSequence = 0;
    this.eventBuffer = []; // Пръстеновиден буфер за последните 200 събития за reconnect replay
    this.maxBufferSize = 200;
    this.clients = new Map(); // clientId -> { userId, res, lastEventId }
  }

  addClient(clientId, userId, res) {
    this.clients.set(clientId, { userId, res, connectedAt: Date.now() });
    defaultRegistry.incGauge('active_realtime_connections', { service: 'realtime-service' });
    logger.info(`Клиент ${clientId} се свърза за потребител ${userId}`, { activeClients: this.clients.size });
  }

  removeClient(clientId) {
    if (this.clients.has(clientId)) {
      this.clients.delete(clientId);
      defaultRegistry.decGauge('active_realtime_connections', { service: 'realtime-service' });
      logger.info(`Клиент ${clientId} прекрати връзката`, { activeClients: this.clients.size });
    }
  }

  /**
   * Излъчва събитие към всички активни сесии на съответния потребител (или глобално)
   * @param {object} eventData 
   */
  broadcastEvent(eventData) {
    this.eventSequence += 1;
    const fullEvent = {
      id: this.eventSequence,
      timestamp: new Date().toISOString(),
      ...eventData,
    };

    // Запис в буфера за възстановяване
    this.eventBuffer.push(fullEvent);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer.shift();
    }

    const payload = `id: ${fullEvent.id}\nevent: ${fullEvent.type || 'message'}\ndata: ${JSON.stringify(fullEvent)}\n\n`;

    for (const [clientId, client] of this.clients.entries()) {
      // Изпращаме само към сесиите на засегнатия потребител или ако е глобално събитие
      if (!fullEvent.userId || fullEvent.userId === client.userId) {
        try {
          client.res.write(payload);
        } catch (err) {
          logger.warn(`Неуспешно изпращане към клиент ${clientId}`, { error: err.message });
          this.removeClient(clientId);
        }
      }
    }
  }

  /**
   * Преиграва пропуснати събития след `lastEventId` за надеждно възстановяване
   * @param {number} lastEventId 
   * @param {string} userId 
   * @param {http.ServerResponse} res 
   */
  replayMissedEvents(lastEventId, userId, res) {
    const missed = this.eventBuffer.filter(e => e.id > lastEventId && (!e.userId || e.userId === userId));
    for (const ev of missed) {
      const payload = `id: ${ev.id}\nevent: ${ev.type || 'message'}\ndata: ${JSON.stringify(ev)}\n\n`;
      res.write(payload);
    }
  }
}

const realtimeHub = new RealtimeHub();

module.exports = {
  RealtimeHub,
  realtimeHub,
};
