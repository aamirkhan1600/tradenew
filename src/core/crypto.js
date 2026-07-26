// Secrets at rest, and password hashing.
//
// Broker tokens are AES-256-GCM encrypted with TOKEN_ENC_KEY. Passwords use
// scrypt with a per-password salt — deliberately not bcrypt, which is a native
// module that has to compile; scrypt ships in Node's standard library and is
// memory-hard, which is what matters here.

const crypto = require('crypto');
const config = require('../config');

const KEY = Buffer.from(config.tokenEncKey, 'hex');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ------------------------------------------------------------ encryption -- */
// Layout: base64( iv[12] | authTag[16] | ciphertext )
function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const buf = Buffer.from(blob, 'base64');
    if (buf.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch (_) {
    // A rotated or mistyped TOKEN_ENC_KEY makes every stored token unreadable.
    // Returning null lets the caller report "not connected" and prompt a fresh
    // login, which is the correct recovery — throwing would break the page.
    return null;
  }
}

/* -------------------------------------------------------------- passwords -- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  try {
    const dk = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'),
      Buffer.from(hashHex, 'hex').length, { N: Number(N), r: Number(r), p: Number(p) });
    // Constant-time compare so a response-timing oracle can't leak the hash.
    return crypto.timingSafeEqual(dk, Buffer.from(hashHex, 'hex'));
  } catch (_) {
    return false;
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { encrypt, decrypt, hashPassword, verifyPassword, sha256, randomId };
