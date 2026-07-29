// JWT in an httpOnly cookie. Single-operator app: there is one account, created
// on first use, and nothing here is multi-tenant.

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../../config');
const db = require('../../core/db');
const { AuthError } = require('../../core/errors');

const COOKIE = 'zoption_token';

// scrypt, not a bare hash. The parameters are the Node defaults, which are
// sized for an interactive login.
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  // Constant-time: a timing oracle on a login is cheap to avoid.
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issue(res, user) {
  const token = jwt.sign({ sub: user.id, email: user.email }, config.jwt.secret,
    { expiresIn: config.jwt.expiresIn });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !config.allowInsecureCookies,
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clear(res) {
  res.clearCookie(COOKIE);
}

function readUser(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (_) {
    return null;
  }
}

// API routes: 401 as JSON.
function requireAuth(req, res, next) {
  const user = readUser(req);
  if (!user) return next(new AuthError());
  req.user = user;
  return next();
}

// Page routes: redirect to the login form.
function requirePage(req, res, next) {
  const user = readUser(req);
  if (!user) return res.redirect('/login');
  req.user = user;
  return next();
}

// Attaches the user when present without demanding one.
function optional(req, _res, next) {
  req.user = readUser(req);
  next();
}

async function findOrCreateUser(email, password) {
  const existing = await db.queryOne('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  if (existing) return existing;
  // First run: the first credentials offered become the account. A single-user
  // tool behind a login prompt does not need a registration flow, but it does
  // need to not be open.
  const count = await db.queryOne('SELECT COUNT(*) AS n FROM users');
  if (count.n > 0) return null;
  const res = await db.query('INSERT INTO users (email, password_hash) VALUES (?, ?)',
    [email, hashPassword(password)]);
  return db.queryOne('SELECT * FROM users WHERE id = ?', [res.insertId]);
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, issue, clear,
  requireAuth, requirePage, optional, readUser, findOrCreateUser,
};
