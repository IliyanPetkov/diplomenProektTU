// =====================================================================
// Rate Limiter: Ограничаване честотата на заявките (Sliding Window Bucket)
// С защита от изчерпване на паметта (Memory DoS Protection)
// =====================================================================

class RateLimiter {
  constructor(maxRequests = 100, windowMs = 60000, maxClients = 10000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxClients = maxClients;
    this.clients = new Map(); // key -> [timestamps]

    // Периодично почистване на стари записи
    this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  isAllowed(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.clients.get(key);
    if (!timestamps) {
      // Защита от препълване на паметта с милиони фалшиви IP адреси
      if (this.clients.size >= this.maxClients) {
        const firstKey = this.clients.keys().next().value;
        this.clients.delete(firstKey);
      }
      timestamps = [];
      this.clients.set(key, timestamps);
    }

    // Премахване на заявки извън текущия времеви прозорец
    while (timestamps.length > 0 && timestamps[0] < windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    for (const [key, timestamps] of this.clients.entries()) {
      while (timestamps.length > 0 && timestamps[0] < windowStart) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.clients.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.clients.clear();
  }
}

module.exports = { RateLimiter };
