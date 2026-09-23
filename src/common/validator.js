// =====================================================================
// Модул за валидация на входните данни (Input Validation & Sanitization)
// =====================================================================

const { ValidationError } = require('./errors');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DANGEROUS_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/;

function validateEmail(email) {
  if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
    throw new ValidationError('Невалиден формат на имейл адрес');
  }
  return email.trim().toLowerCase();
}

function validatePassword(password) {
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('Паролата трябва да съдържа минимум 8 символа');
  }
  return password;
}

function validateFilename(name) {
  if (!name || typeof name !== 'string') {
    throw new ValidationError('Името на файла е задължително');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 255) {
    throw new ValidationError('Името на файла трябва да бъде между 1 и 255 символа');
  }
  // Защита от Path Traversal и опасни символи
  if (trimmed.includes('..') || DANGEROUS_FILENAME_CHARS.test(trimmed)) {
    throw new ValidationError('Името на файла съдържа забранени символи или опит за path traversal');
  }
  return trimmed;
}

function validateFolderName(name) {
  if (!name || typeof name !== 'string') {
    throw new ValidationError('Името на папката е задължително');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new ValidationError('Името на папката трябва да бъде между 1 и 128 символа');
  }
  if (trimmed.includes('..') || DANGEROUS_FILENAME_CHARS.test(trimmed)) {
    throw new ValidationError('Името на папката съдържа забранени символи или опит за path traversal');
  }
  return trimmed;
}

function validateUuid(id, fieldName = 'Идентификатор') {
  if (!id || typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new ValidationError(`${fieldName} трябва да бъде валиден UUID`);
  }
  return id;
}

module.exports = {
  validateEmail,
  validatePassword,
  validateFilename,
  validateFolderName,
  validateUuid,
};
