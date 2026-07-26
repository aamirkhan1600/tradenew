// Registration, login, logout.
//
// The first account created becomes the OWNER; after that, self-registration is
// closed. This is a single-operator trading system — an open sign-up form on
// something that places live orders is a liability, not a feature.

const crypto = require('../../core/crypto');
const repo = require('../../repositories');
const auth = require('../middleware/auth');
const logger = require('../../core/logger');

async function showLogin(req, res) {
  if (req.user) return res.redirect('/');
  const isFirstRun = (await repo.users.count()) === 0;
  return res.render('login', { title: 'Sign in', error: null, isFirstRun, user: null });
}

async function login(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const isFirstRun = (await repo.users.count()) === 0;

  const fail = (message) => res.status(401).render('login', {
    title: 'Sign in', error: message, isFirstRun, user: null,
  });

  if (!email || !password) return fail('Email and password are required.');

  const user = await repo.users.findByEmail(email);
  // The same message for an unknown email and a wrong password: distinguishing
  // them tells an attacker which accounts exist.
  if (!user || !crypto.verifyPassword(password, user.password_hash)) {
    logger.warn('auth: failed login', { email });
    return fail('Invalid email or password.');
  }
  if (user.status !== 'ACTIVE') return fail('This account is disabled.');

  auth.issue(res, user);
  await repo.users.touchLogin(user.id);
  logger.info('auth: signed in', { userId: user.id, email });
  return res.redirect('/');
}

async function register(req, res) {
  const existing = await repo.users.count();
  if (existing > 0) {
    return res.status(403).render('login', {
      title: 'Sign in', isFirstRun: false, user: null,
      error: 'Registration is closed — this system already has an owner.',
    });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const fullName = String(req.body?.fullName || '').trim() || null;

  const fail = (message) => res.status(400).render('login', {
    title: 'Sign in', error: message, isFirstRun: true, user: null,
  });

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter a valid email address.');
  if (password.length < 10) return fail('Use a password of at least 10 characters.');

  const id = await repo.users.create({ email, password, fullName, role: 'OWNER' });
  const user = await repo.users.findById(id);
  auth.issue(res, user);
  logger.info('auth: owner account created', { userId: id, email });
  return res.redirect('/brokers');
}

function logout(_req, res) {
  auth.clear(res);
  return res.redirect('/login');
}

module.exports = { showLogin, login, register, logout };
