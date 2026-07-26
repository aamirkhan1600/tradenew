// Error handling. API routes get JSON, page routes get a rendered page, and
// nothing leaks a stack trace to a browser in production.

const logger = require('../../core/logger');
const { AppError } = require('../../core/errors');
const config = require('../../config');

function notFound(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found', message: `no route for ${req.method} ${req.path}` });
  }
  return res.status(404).render('error', {
    title: 'Not found', status: 404,
    message: 'That page does not exist.', detail: null, user: req.user || null,
  });
}

// eslint-disable-next-line no-unused-vars -- Express identifies this by arity
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const isOperational = err instanceof AppError;

  // Expected outcomes (a bad form, an expired session) are noise at error level.
  if (status >= 500 || !isOperational) {
    logger.error('http: request failed', {
      method: req.method, path: req.path, status,
      err: err.message, stack: err.stack, userId: req.user?.id,
    });
  } else {
    logger.warn('http: request rejected', {
      method: req.method, path: req.path, status, err: err.message, userId: req.user?.id,
    });
  }

  if (req.path.startsWith('/api/')) {
    return res.status(status).json({
      error: err.code || 'internal_error',
      message: status >= 500 && config.isProd ? 'Something went wrong.' : err.message,
      ...(err.meta && !config.isProd ? { meta: err.meta } : {}),
    });
  }

  if (status === 401) return res.redirect('/login');

  return res.status(status).render('error', {
    title: 'Error', status,
    message: status >= 500 && config.isProd ? 'Something went wrong.' : err.message,
    detail: config.isProd ? null : err.stack,
    user: req.user || null,
  });
}

// Wraps an async handler so a rejected promise reaches the error handler
// instead of hanging the request.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { notFound, errorHandler, wrap };
