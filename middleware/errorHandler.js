/**
 * Global Error Handler Middleware
 * ──────────────────────────────────────────────────
 * Catches all errors passed via next(err) and returns
 * a consistent JSON response.
 */
const mongoose = require('mongoose');

module.exports = function errorHandler(err, req, res, _next) {
  // ── Default values ───────────────────────────────
  let status  = err.statusCode || err.status || 500;
  let message = err.message || 'Internal server error';
  let errors  = null;

  // ── Mongoose Validation Error → 400 ──────────────
  if (err instanceof mongoose.Error.ValidationError) {
    status  = 400;
    message = 'Validation failed';
    errors  = Object.values(err.errors).map(e => ({
      field: e.path,
      message: e.message,
      value: e.value,
    }));
  }

  // ── Mongoose CastError (invalid ObjectId) → 400 ──
  if (err instanceof mongoose.Error.CastError) {
    status  = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  }

  // ── Mongo duplicate key (E11000) → 409 ───────────
  if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    message = `Duplicate value for '${field}'. This ${field} already exists.`;
  }

  // ── JWT errors → 401 ────────────────────────────
  if (err.name === 'JsonWebTokenError') {
    status  = 401;
    message = 'Invalid authentication token';
  }
  if (err.name === 'TokenExpiredError') {
    status  = 401;
    message = 'Authentication token has expired. Please login again.';
  }

  // ── Log in development ──────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    console.error(`[ERROR ${status}] ${req.method} ${req.originalUrl}:`, err.message);
  }

  // ── Send response ───────────────────────────────
  const body = { success: false, message };
  if (errors) body.errors = errors;

  // In production, don't leak stack traces
  if (process.env.NODE_ENV !== 'production' && status === 500) {
    body.stack = err.stack;
  }

  res.status(status).json(body);
};
