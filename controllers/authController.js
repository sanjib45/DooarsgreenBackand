/**
 * Auth Controller
 * ─────────────────────────────────────────────────────────────
 * Access Token  → 1h JWT in JSON body
 * Refresh Token → 7d JWT in httpOnly cookie + sha256 in user.refreshTokens[]
 *
 * Register policy (production):
 *   - Default: DISABLED
 *   - ALLOW_PUBLIC_REGISTER=true → open register
 *   - INVITE_CODE=<secret>       → invite-only (body.inviteCode required)
 * Development: open unless REGISTER_DISABLED=true
 */
const crypto  = require('crypto');
const User    = require('../models/User');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { getRefreshCookieOptions, getClearRefreshCookieOptions } = require('../utils/cookieOptions');

const ACCESS_SECRET  = process.env.JWT_SECRET         || 'access_fallback_secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh_fallback_secret';
const ACCESS_EXPIRY  = '1h';
const REFRESH_EXPIRY = '7d';
const MAX_SESSIONS   = 5;

const signAccess = (id, role) =>
  jwt.sign({ id, role }, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRY });

const signRefresh = (id) =>
  jwt.sign({ id }, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRY });

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const safeUser = (user) => ({
  _id:   user._id,
  name:  user.name,
  phone: user.phone,
  role:  user.role,
});

/** @returns {'public'|'invite'|'disabled'} */
function getRegisterMode() {
  if (process.env.ALLOW_PUBLIC_REGISTER === 'true') return 'public';
  if (process.env.INVITE_CODE && String(process.env.INVITE_CODE).trim()) return 'invite';
  if (process.env.NODE_ENV === 'production') return 'disabled';
  if (process.env.REGISTER_DISABLED === 'true') return 'disabled';
  return 'public'; // local/dev convenience
}

// ── GET /api/auth/config — public, no secrets ──────────────────────────────
exports.getAuthConfig = async (_req, res) => {
  res.json({
    success: true,
    data: {
      registerMode: getRegisterMode(),
      // Helps ops verify CORS + cookie setup after deploy
      cookieSameSite: getRefreshCookieOptions().sameSite,
      cookieSecure:   getRefreshCookieOptions().secure,
    },
  });
};

// ── GET /api/auth/cookie-check — verifies refresh cookie is arriving ───────
exports.cookieCheck = async (req, res) => {
  const hasCookie = Boolean(req.cookies?.refreshToken);
  res.json({
    success: true,
    data: {
      hasRefreshCookie: hasCookie,
      message: hasCookie
        ? 'Refresh cookie received — cross-origin cookie setup looks OK'
        : 'No refresh cookie — login first, or check SameSite=None, Secure, ALLOWED_ORIGINS, withCredentials',
    },
  });
};

// ── Register ───────────────────────────────────────────────────────────────
exports.registerUser = async (req, res) => {
  const mode = getRegisterMode();
  if (mode === 'disabled') {
    return res.status(403).json({
      success: false,
      code: 'REGISTER_DISABLED',
      message: 'Public registration is disabled. Contact your admin for access.',
    });
  }
  if (mode === 'invite') {
    const expected = String(process.env.INVITE_CODE).trim();
    const provided = String(req.body.inviteCode || '').trim();
    if (!provided || provided !== expected) {
      return res.status(403).json({
        success: false,
        code: 'INVALID_INVITE',
        message: 'A valid invite code is required to register',
      });
    }
  }

  const { name, phone, password } = req.body;
  if (!name?.trim() || !phone?.trim() || !password) {
    return res.status(400).json({ success: false, message: 'Name, phone and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  }

  const exists = await User.findOne({ phone: phone.trim() });
  if (exists) {
    return res.status(409).json({ success: false, message: 'Phone number already registered' });
  }

  const hashed = await bcrypt.hash(password, 12);
  const user   = await User.create({
    name: name.trim(),
    phone: phone.trim(),
    password: hashed,
    role: 'Manager', // never accept role from client
  });

  const accessToken  = signAccess(user._id, user.role);
  const refreshToken = signRefresh(user._id);
  user.refreshTokens = [hashToken(refreshToken)];
  await user.save();

  res.cookie('refreshToken', refreshToken, getRefreshCookieOptions());
  res.status(201).json({
    success: true,
    data: { user: safeUser(user), accessToken },
  });
};

// ── Login ──────────────────────────────────────────────────────────────────
exports.loginUser = async (req, res) => {
  const { phone, password } = req.body;

  const user = await User.findOne({ phone });
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid phone or password' });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ success: false, message: 'Invalid phone or password' });
  }

  const accessToken  = signAccess(user._id, user.role);
  const refreshToken = signRefresh(user._id);

  const hashed = hashToken(refreshToken);
  user.refreshTokens.push(hashed);
  if (user.refreshTokens.length > MAX_SESSIONS) {
    user.refreshTokens = user.refreshTokens.slice(-MAX_SESSIONS);
  }
  await user.save();

  res.cookie('refreshToken', refreshToken, getRefreshCookieOptions());
  res.json({
    success: true,
    data: { user: safeUser(user), accessToken },
  });
};

// ── Refresh Access Token ───────────────────────────────────────────────────
exports.refreshToken = async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) {
    return res.status(401).json({
      success: false,
      code: 'NO_REFRESH_COOKIE',
      message: 'No refresh token provided',
    });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, REFRESH_SECRET);
  } catch {
    res.clearCookie('refreshToken', getClearRefreshCookieOptions());
    return res.status(401).json({
      success: false,
      code: 'REFRESH_INVALID',
      message: 'Refresh token invalid or expired — please login again',
    });
  }

  const user = await User.findById(decoded.id);
  if (!user) {
    return res.status(401).json({ success: false, message: 'User not found' });
  }

  const hashed = hashToken(token);
  if (!user.refreshTokens.includes(hashed)) {
    user.refreshTokens = [];
    await user.save();
    res.clearCookie('refreshToken', getClearRefreshCookieOptions());
    return res.status(401).json({
      success: false,
      code: 'REFRESH_REUSE',
      message: 'Refresh token reuse detected — all sessions invalidated',
    });
  }

  const newAccessToken  = signAccess(user._id, user.role);
  const newRefreshToken = signRefresh(user._id);
  const newHashed       = hashToken(newRefreshToken);

  user.refreshTokens = user.refreshTokens
    .filter(h => h !== hashed)
    .concat(newHashed)
    .slice(-MAX_SESSIONS);
  await user.save();

  res.cookie('refreshToken', newRefreshToken, getRefreshCookieOptions());
  res.json({ success: true, data: { accessToken: newAccessToken } });
};

// ── Logout ─────────────────────────────────────────────────────────────────
exports.logoutUser = async (req, res) => {
  const token = req.cookies?.refreshToken;

  if (token) {
    try {
      const decoded = jwt.verify(token, REFRESH_SECRET);
      const user    = await User.findById(decoded.id);
      if (user) {
        const hashed = hashToken(token);
        user.refreshTokens = user.refreshTokens.filter(h => h !== hashed);
        await user.save();
      }
    } catch {
      // still clear cookie
    }
  }

  res.clearCookie('refreshToken', getClearRefreshCookieOptions());
  res.json({ success: true, message: 'Logged out successfully' });
};

// ── Reset Password ─────────────────────────────────────────────────────────
// NOTE: Still phone-only (no OTP). Treat as temporary; secure with OTP next.
exports.resetPassword = async (req, res) => {
  const { phone, newPassword } = req.body;

  const user = await User.findOne({ phone });
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  user.password      = await bcrypt.hash(newPassword, 12);
  user.refreshTokens = [];
  await user.save();

  res.clearCookie('refreshToken', getClearRefreshCookieOptions());
  res.json({ success: true, message: 'Password reset successful — please login again' });
};
