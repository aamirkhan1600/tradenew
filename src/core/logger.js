// Structured logging. Console in dev, JSON files in production, with the
// process role (app / engine) stamped on every line so two tails can be told
// apart when they're interleaved.

const path = require('path');
const fs = require('fs');
const winston = require('winston');
const config = require('../config');

const logDir = path.join(__dirname, '..', '..', 'logs');
try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) { /* best effort */ }

const role = process.env.APP_ROLE || 'app';

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const rest = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} ${level} [${role}] ${message}${rest}`;
  }),
);

const logger = winston.createLogger({
  level: config.isProd ? 'info' : 'debug',
  defaultMeta: { role },
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: path.join(logDir, `${role}.log`),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
  ],
});

// A one-line, greppable trace of the strategy's decisions. Kept separate from
// logger.info so an operator can follow a live run with
//   tail -f logs/engine.log | grep FLOW
logger.flow = (message, meta = {}) => logger.info(`FLOW ${message}`, meta);

module.exports = logger;
