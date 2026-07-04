const mongoose = require('mongoose');

/**
 * Merchant — master entity for tea leaf suppliers.
 *
 * Identity rule:
 *   • phone is UNIQUE — one phone number = one merchant
 *   • same name + same phone → same merchant (reuse)
 *   • same name + different phone → different merchant
 */
const merchantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Merchant name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      unique: true,
      trim: true,
      maxlength: [15, 'Phone number is too long'],
    },
    address: {
      type: String,
      trim: true,
      maxlength: [200, 'Address cannot exceed 200 characters'],
      default: '',
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'Notes cannot exceed 500 characters'],
      default: '',
    },
  },
  { timestamps: true }
);

// ── Indexes ────────────────────────────────────────────────
merchantSchema.index({ name: 'text' });           // Text search for dropdown
merchantSchema.index({ phone: 1 }, { unique: true }); // Fast lookup + uniqueness

module.exports = mongoose.model('Merchant', merchantSchema);
