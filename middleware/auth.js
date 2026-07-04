/**
 * JWT Authentication Middleware
 * ──────────────────────────────────────────────────────────────
 * Verifies short-lived ACCESS token from Authorization header.
 * Attaches req.user = { id, role, name, phone } on success.
 *
 * The frontend should automatically call POST /auth/refresh
 * using the httpOnly refresh token cookie when a 401 is received.
 */
const jwt  = require('jsonwebtoken');
const User = require('../models/User');

const ACCESS_SECRET = process.env.JWT_SECRET || 'access_fallback_secret';

const protect = async (req, res, next) => {
  try {
    // ── 1. Extract Bearer token ──────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        code:    'NO_TOKEN',
        message: 'Not authorized — no token provided',
      });
    }

    const token   = authHeader.split(' ')[1];

    // ── 2. Verify access token ───────────────────────────────────
    let decoded;
    try {
      decoded = jwt.verify(token, ACCESS_SECRET);
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
      return res.status(401).json({
        success: false,
        code,
        message: code === 'TOKEN_EXPIRED'
          ? 'Access token expired'
          : 'Invalid token',
      });
    }

    // ── 3. Confirm user still exists ────────────────────────────
    const user = await User.findById(decoded.id).select('-password -refreshTokens').lean();
    if (!user) {
      return res.status(401).json({
        success: false,
        code:    'USER_NOT_FOUND',
        message: 'Not authorized — user no longer exists',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Authentication error' });
  }
};

// ── Role-based guard ────────────────────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied — requires role: ${roles.join(' or ')}`,
    });
  }
  next();
};

module.exports = { protect, requireRole };
