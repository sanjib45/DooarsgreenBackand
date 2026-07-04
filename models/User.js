const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true },
  phone:         { type: String, required: true, unique: true, trim: true },
  password:      { type: String, required: true },
  role:          { type: String, enum: ['Admin', 'Manager'], default: 'Manager' },
  // ── Refresh token rotation ─────────────────────────────────────────────────
  // Stores hashed refresh tokens. Limited to 5 active sessions at once.
  refreshTokens: { type: [String], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
