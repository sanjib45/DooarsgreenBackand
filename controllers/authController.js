/**
 * Auth Controller
 * ─────────────────────────────────────────────────────────────
 * Access Token  → 15 min, signed JWT, sent in JSON body
 * Refresh Token → 7 days, signed JWT, stored in httpOnly cookie
 *                 AND its sha256 hash stored in user.refreshTokens[]
 *
 * Token Rotation: every /refresh call issues a NEW refresh token
 * and invalidates the old one (prevents replay attacks).
 *
 * Max Sessions: 5 concurrent refresh tokens per user.
 * If exceeded, oldest is evicted automatically.
 */
const crypto  = require('crypto');
const User    = require('../models/User');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

// ── Constants ──────────────────────────────────────────────────────────────
const ACCESS_SECRET  = process.env.JWT_SECRET         || 'access_fallback_secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh_fallback_secret';
const ACCESS_EXPIRY  = '1h';   // 1 hour — practical for a field app
const REFRESH_EXPIRY = '7d';
const REFRESH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS   = 5;

// ── Helpers ────────────────────────────────────────────────────────────────
const signAccess = (id, role) =>
  jwt.sign({ id, role }, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRY });

const signRefresh = (id) =>
  jwt.sign({ id }, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRY });

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure:   process.env.NODE_ENV === 'production',
  maxAge:   REFRESH_EXPIRY_MS,
  path:     '/',
};

const safeUser = (user) => ({
  _id:   user._id,
  name:  user.name,
  phone: user.phone,
  role:  user.role,
});

// ── Register ───────────────────────────────────────────────────────────────
exports.registerUser = async (req, res) => {
  const { name, phone, password, role } = req.body;

  const exists = await User.findOne({ phone });
  if (exists)
    return res.status(409).json({ success: false, message: 'Phone number already registered' });

  const hashed = await bcrypt.hash(password, 12);
  const user   = await User.create({ name, phone, password: hashed, role });

  const accessToken  = signAccess(user._id, user.role);
  const refreshToken = signRefresh(user._id);

  // Store hashed refresh token
  user.refreshTokens = [hashToken(refreshToken)];
  await user.save();

  res.cookie('refreshToken', refreshToken, cookieOptions);
  res.status(201).json({
    success: true,
    data: { user: safeUser(user), accessToken },
  });
};

// ── Login ──────────────────────────────────────────────────────────────────
exports.loginUser = async (req, res) => {
  const { phone, password } = req.body;

  const user = await User.findOne({ phone });
  if (!user)
    return res.status(401).json({ success: false, message: 'Invalid phone or password' });

  const match = await bcrypt.compare(password, user.password);
  if (!match)
    return res.status(401).json({ success: false, message: 'Invalid phone or password' });

  const accessToken  = signAccess(user._id, user.role);
  const refreshToken = signRefresh(user._id);

  // ── Token rotation: keep latest MAX_SESSIONS hashes ───────────────────
  const hashed = hashToken(refreshToken);
  user.refreshTokens.push(hashed);
  if (user.refreshTokens.length > MAX_SESSIONS) {
    user.refreshTokens = user.refreshTokens.slice(-MAX_SESSIONS);
  }
  await user.save();

  res.cookie('refreshToken', refreshToken, cookieOptions);
  res.json({
    success: true,
    data: { user: safeUser(user), accessToken },
  });
};

// ── Refresh Access Token ───────────────────────────────────────────────────
exports.refreshToken = async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token)
    return res.status(401).json({ success: false, message: 'No refresh token provided' });

  // Verify signature and expiry
  let decoded;
  try {
    decoded = jwt.verify(token, REFRESH_SECRET);
  } catch {
    res.clearCookie('refreshToken', { path: '/' });
    return res.status(401).json({ success: false, message: 'Refresh token invalid or expired — please login again' });
  }

  // Confirm the hashed token exists in the DB (replay detection)
  const user = await User.findById(decoded.id);
  if (!user)
    return res.status(401).json({ success: false, message: 'User not found' });

  const hashed = hashToken(token);
  if (!user.refreshTokens.includes(hashed)) {
    // Possible token theft — invalidate all sessions
    user.refreshTokens = [];
    await user.save();
    res.clearCookie('refreshToken', { path: '/' });
    return res.status(401).json({ success: false, message: 'Refresh token reuse detected — all sessions invalidated' });
  }

  // ── Issue new tokens (rotation) ────────────────────────────────────────
  const newAccessToken  = signAccess(user._id, user.role);
  const newRefreshToken = signRefresh(user._id);
  const newHashed       = hashToken(newRefreshToken);

  // Replace old hash with new one
  user.refreshTokens = user.refreshTokens
    .filter(h => h !== hashed)
    .concat(newHashed)
    .slice(-MAX_SESSIONS);
  await user.save();

  res.cookie('refreshToken', newRefreshToken, cookieOptions);
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
      // Token malformed or expired — still clear the cookie
    }
  }

  res.clearCookie('refreshToken', { path: '/' });
  res.json({ success: true, message: 'Logged out successfully' });
};

// ── Reset Password ─────────────────────────────────────────────────────────
exports.resetPassword = async (req, res) => {
  const { phone, newPassword } = req.body;

  const user = await User.findOne({ phone });
  if (!user)
    return res.status(404).json({ success: false, message: 'User not found' });

  user.password      = await bcrypt.hash(newPassword, 12);
  user.refreshTokens = []; // Invalidate all existing sessions on password reset
  await user.save();

  res.clearCookie('refreshToken', { path: '/' });
  res.json({ success: true, message: 'Password reset successful — please login again' });
};
