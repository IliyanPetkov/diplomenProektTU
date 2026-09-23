// =====================================================================
// Стандартизирани системни грешки (Application Error Hierarchy)
// =====================================================================

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      }
    };
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Неоторизиран достъп') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Нямате права за тази операция') {
    super(message, 403, 'FORBIDDEN');
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Търсеният ресурс не беше открит') {
    super(message, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Конфликт при изпълнение на операцията', details = null) {
    super(message, 409, 'CONFLICT', details);
  }
}

class PreconditionFailedError extends AppError {
  constructor(message = 'Оптимистично заключване: версията на файла е променена (ETag mismatch)') {
    super(message, 412, 'PRECONDITION_FAILED');
  }
}

class QuotaExceededError extends AppError {
  constructor(message = 'Превишена потребителска квота за съхранение') {
    super(message, 413, 'QUOTA_EXCEEDED');
  }
}

class RateLimitExceededError extends AppError {
  constructor(message = 'Прекалено много заявки. Моля, опитайте отново по-късно.') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PreconditionFailedError,
  QuotaExceededError,
  RateLimitExceededError,
};
