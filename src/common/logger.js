// =====================================================================
// Структуриран JSON логер (Structured Logging with Masking)
// =====================================================================

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'token',
  'refresh_token',
  'authorization',
  'cookie',
  'set-cookie',
  'secret',
  'secret_key',
  'access_key',
]);

function maskSensitiveData(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(maskSensitiveData);
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '***MASKED***';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = maskSensitiveData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

class Logger {
  constructor(serviceName = 'cloudfs-service') {
    this.serviceName = serviceName;
  }

  _log(level, message, metadata = {}, correlationId = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      service: this.serviceName,
      correlation_id: correlationId || metadata.correlationId || null,
      message,
      metadata: maskSensitiveData(metadata),
    };

    const serialized = JSON.stringify(entry);
    if (level === 'error') {
      process.stderr.write(serialized + '\n');
    } else {
      process.stdout.write(serialized + '\n');
    }
  }

  info(message, metadata, correlationId) {
    this._log('info', message, metadata, correlationId);
  }

  warn(message, metadata, correlationId) {
    this._log('warn', message, metadata, correlationId);
  }

  error(message, metadata, correlationId) {
    this._log('error', message, metadata, correlationId);
  }

  debug(message, metadata, correlationId) {
    if (process.env.LOG_LEVEL === 'debug') {
      this._log('debug', message, metadata, correlationId);
    }
  }
}

function createLogger(serviceName) {
  return new Logger(serviceName);
}

module.exports = {
  Logger,
  createLogger,
  maskSensitiveData,
};
