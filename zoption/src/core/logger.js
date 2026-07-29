// Winston, with a console transport that stays readable and file transports
// that keep a session's worth of history. Every state transition is logged here
// as well as written to the `events` table — the table is queryable, the file
// survives a database that is down.

const fs = require('fs');
const path = require('path');
const winston = require('winston');
const config = require('../config');

const logDir = path.join(__dirname, '..', '..', 'logs');
try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) { /* already there */ }

const consoleFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const extra = Object.keys(meta).length
    ? ' ' + JSON.stringify(meta, (_k, v) => (v instanceof Error ? v.message : v))
    : '';
  return `${timestamp} ${level.padEnd(5)} ${message}${extra}`;
});

const logger = winston.createLogger({
  level: config.isProd ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
        winston.format.colorize({ level: true }),
        consoleFormat,
      ),
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'zoption.log'),
      maxsize: 20 * 1024 * 1024,
      maxFiles: 10,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

module.exports = logger;
