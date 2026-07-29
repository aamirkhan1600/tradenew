// AES-256-GCM for the broker session tokens at rest.
//
// MPIN and TOTP are never encrypted here because they are never stored: they are
// forwarded to Kotak once and discarded. Encrypting a second factor at rest
// would defeat the point of having one.

const crypto = require('crypto');
const config = require('../config');

const KEY = Buffer.from(config.tokenEncKey, 'hex');
const IV_BYTES = 12;
const PREFIX = 'v1';

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(payload) {
  if (payload == null || payload === '') return null;
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('encrypted value is malformed or was written with a different scheme');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// Decrypt without throwing. A token that cannot be decrypted is a token we do
// not have — the caller re-logs in rather than crashing the engine, because a
// rotated TOKEN_ENC_KEY should not take the process down.
function tryDecrypt(payload) {
  try { return decrypt(payload); } catch (_) { return null; }
}

module.exports = { encrypt, decrypt, tryDecrypt };
