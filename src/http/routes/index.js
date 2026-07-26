// Route table. Pages render EJS; /api/* returns JSON. Both are behind the same
// session cookie, and every state-changing route is a POST/PUT/DELETE so a
// stray GET can never move money.

const express = require('express');
const rateLimit = require('express-rate-limit');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/errors');
const authController = require('../controllers/authController');
const brokerController = require('../controllers/brokerController');
const strategyController = require('../controllers/strategyController');

const router = express.Router();

// Credential endpoints get a tighter limit than the rest — they are the ones
// worth brute-forcing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 600,          // the dashboard polls once a second
  standardHeaders: true, legacyHeaders: false,
});

/* ------------------------------------------------------------- public --- */
router.get('/login', wrap(authController.showLogin));
router.post('/login', authLimiter, wrap(authController.login));
router.post('/register', authLimiter, wrap(authController.register));
router.post('/logout', authController.logout);
router.get('/logout', authController.logout);

router.get('/health', wrap(async (_req, res) => {
  const db = require('../../core/db');
  const ok = await db.healthCheck().catch(() => false);
  res.status(ok ? 200 : 503).json({ ok, service: 'premium-range-trader' });
}));

/* -------------------------------------------------------------- pages --- */
router.get('/', auth.pageAuth, wrap(strategyController.dashboardPage));
router.get('/strategies', auth.pageAuth, wrap(strategyController.strategiesPage));
router.get('/trades', auth.pageAuth, wrap(strategyController.tradesPage));
router.get('/events', auth.pageAuth, wrap(strategyController.eventsPage));
router.get('/brokers', auth.pageAuth, wrap(brokerController.page));

/* ---------------------------------------------------------------- api --- */
const api = express.Router();
api.use(apiLimiter, auth.apiAuth);

// live
api.get('/live', wrap(strategyController.liveStatus));
api.post('/halt', wrap(strategyController.setHalt));

// brokers
api.get('/brokers', wrap(brokerController.status));
api.post('/brokers/zerodha/credentials', authLimiter, wrap(brokerController.saveKiteCredentials));
api.post('/brokers/zerodha/connect', authLimiter, wrap(brokerController.connectKite));
api.post('/brokers/zerodha/verify', wrap(brokerController.verifyKite));
api.post('/brokers/zerodha/disconnect', wrap(brokerController.disconnectKite));
api.post('/brokers/kotak/connect', authLimiter, wrap(brokerController.connectKotak));
api.post('/brokers/kotak/disconnect', wrap(brokerController.disconnectKotak));
api.post('/instruments/sync', wrap(brokerController.syncInstruments));
api.get('/instruments/bridge', wrap(brokerController.bridgeHealth));

// strategies
api.get('/strategies', wrap(strategyController.list));
api.post('/strategies', wrap(strategyController.create));
api.get('/strategies/economics', wrap(strategyController.economics));
api.get('/strategies/:id', wrap(strategyController.get));
api.put('/strategies/:id', wrap(strategyController.update));
api.delete('/strategies/:id', wrap(strategyController.remove));
api.post('/strategies/:id/toggle', wrap(strategyController.toggle));
api.post('/strategies/:id/square-off', wrap(strategyController.squareOff));

// reporting
api.get('/trades', wrap(strategyController.trades));
api.get('/events', wrap(strategyController.events));
api.get('/orders', wrap(strategyController.orders));
api.get('/report', wrap(strategyController.report));

router.use('/api', api);

module.exports = router;
