// =====================================================================
// Unit Test: Валидация на входни данни и защита от Path Traversal
// =====================================================================

const test = require('node:test');
const assert = require('node:assert');
const { validateEmail, validatePassword, validateFilename, validateFolderName } = require('../../src/common/validator');
const { ValidationError } = require('../../src/common/errors');

test('Валидация на имейл адреси', () => {
  assert.strictEqual(validateEmail('student@tu-sofia.bg'), 'student@tu-sofia.bg');
  assert.strictEqual(validateEmail('  TEST@DOMAIN.COM  '), 'test@domain.com');

  assert.throws(() => validateEmail('invalid-email'), ValidationError);
  assert.throws(() => validateEmail('missing@tld'), ValidationError);
  assert.throws(() => validateEmail(''), ValidationError);
});

test('Валидация на пароли', () => {
  assert.strictEqual(validatePassword('StrongPass123!'), 'StrongPass123!');
  assert.throws(() => validatePassword('short'), ValidationError);
  assert.throws(() => validatePassword(''), ValidationError);
});

test('Защита от Path Traversal и опасни символи в имена на файлове', () => {
  // Валидни имена
  assert.strictEqual(validateFilename('document.pdf'), 'document.pdf');
  assert.strictEqual(validateFilename('diploma_v1.0.tar.gz'), 'diploma_v1.0.tar.gz');

  // Опити за Path Traversal атаки
  assert.throws(() => validateFilename('../etc/passwd'), ValidationError);
  assert.throws(() => validateFilename('..\\windows\\system32'), ValidationError);
  assert.throws(() => validateFilename('folder/../../file.txt'), ValidationError);
  assert.throws(() => validateFilename('file\x00.exe'), ValidationError);
  assert.throws(() => validateFilename('file<bad>.txt'), ValidationError);
  assert.throws(() => validateFilename(''), ValidationError);
});

test('Защита от Path Traversal в имена на папки', () => {
  assert.strictEqual(validateFolderName('Projects'), 'Projects');
  assert.throws(() => validateFolderName('../HackDir'), ValidationError);
  assert.throws(() => validateFolderName('dir/sub'), ValidationError);
  assert.throws(() => validateFolderName(''), ValidationError);
});
