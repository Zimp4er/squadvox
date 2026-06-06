#!/usr/bin/env node
// Генерирует SHA-256 хэш пароля для .env
// Использование: node scripts/hash-password.js МОЙ_ПАРОЛЬ
const crypto = require('crypto');
const password = process.argv[2];
if (!password) {
  console.error('Использование: node scripts/hash-password.js <пароль>');
  process.exit(1);
}
console.log(crypto.createHash('sha256').update(password).digest('hex'));
