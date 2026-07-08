const mongoose = require('mongoose');

/**
 * Merchant — master entity for tea leaf suppliers.
 *
 * Identity rule:
 *   • phone is UNIQUE per user — { phone, createdBy } compound uniqueness
 *   • same name + same phone + same user → same merchant (reuse)
 *   • same name + different phone → different merchant
 *   • same phone + different user → different merchant (data isolation)
 */
const merchantSchema = new mongoose.Schema(
  {
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner user reference is required'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Merchant name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
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
merchantSchema.index({ name: 'text' });                           // Text search for dropdown
merchantSchema.index({ phone: 1, createdBy: 1 }, { unique: true }); // Per-user phone uniqueness
merchantSchema.index({ createdBy: 1, name: 1 });                  // Fast user-scoped name lookup

module.exports = mongoose.model('Merchant', merchantSchema);
