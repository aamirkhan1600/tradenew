// Authentication: a signed JWT in an httpOnly cookie.
//
// httpOnly means page scripts cannot read the token, so an XSS bug cannot walk
// off with a session. SameSite=Lax blocks the cross-site form posts that would
// otherwise make CSRF possible on the state-changing routes.

const jwt = require('jsonwebtoken');
const config = require('../../config');
const repo = require('../../repositories');
const { AuthError } = require('../../core/errors');

const COOKIE = 'session';

function issue(res, user) {
  const token = jwt.sign(
    { sub: String(user.id), email: user.email, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn });

  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !config.allowInsecureCookies,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
  return token;
}

function clear(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function readToken(req) {
  const fromCookie = req.cookies?.[COOKIE];
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Populates req.user, or leaves it null. Never rejects — the two guards below
// decide what to do about an anonymous request.
async function loadUser(req, _res, next) {
  req.user = null;
  const token = readToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await repo.users.findById(payload.sub);
    if (user && user.status === 'ACTIVE') {
      req.user = { id: Number(user.id), email: user.email, role: user.role, fullName: user.full_name };
    }
  } catch (_) {
    // Expired or tampered — treated the same as no token at all.
  }
  return next();
}

// API routes answer 401 in JSON; a redirect would be parsed as a successful
// response by fetch() and produce a confusing "unexpected token <" error.
function apiAuth(req, _res, next) {
  if (!req.user) return next(new AuthError());
  return next();
}

// Page routes send the browser to the login screen.
function pageAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  return next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new AuthError());
    if (!roles.includes(req.user.role)) return next(new AuthError('insufficient role'));
    return next();
  };
}

module.exports = { COOKIE, issue, clear, loadUser, apiAuth, pageAuth, requireRole };
