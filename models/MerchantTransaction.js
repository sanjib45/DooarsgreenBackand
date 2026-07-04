const mongoose = require('mongoose');

/**
 * MerchantTransaction — tracks a single tea procurement transaction.
 *
 * Calculation chain (all stored, not virtual, for queryability):
 *   lessQty           = grossQty * (lessPercent / 100)
 *   netQty            = grossQty - lessQty
 *   grossAmount       = netQty * ratePerKg
 *   totalLaborCharges = laborCount * laborChargePerWorker
 *   netPayable        = grossAmount - totalLaborCharges
 *   finalPayable      = netPayable - advancePayment
 *   balance           = finalPayable  (positive = still owed, negative = overpaid)
 */
const merchantTransactionSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────
    transactionId: {
      type: String,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    merchant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      index: true,
    },
    merchantName: {
      type: String,
      required: [true, 'Merchant name is required'],
      trim: true,
      index: true,
    },
    teaType: {
      type: String,
      required: [true, 'Tea type is required'],
      enum: ['Green Tea', 'CTC', 'Other'],
    },
    transactionDate: {
      type: Date,
      required: [true, 'Transaction date is required'],
      default: Date.now,
    },

    // ── Raw inputs ────────────────────────────────────────
    grossQty: {
      type: Number,
      required: [true, 'Gross quantity is required'],
      min: [0, 'Gross quantity cannot be negative'],
    },
    lessPercent: {
      type: Number,
      required: [true, 'Less % is required'],
      min: [0, 'Less % cannot be negative'],
      max: [100, 'Less % cannot exceed 100'],
      default: 0,
    },
    fineLeaf: {
      type: Number,
      min: [0, 'Fine leaf % cannot be negative'],
      max: [100, 'Fine leaf % cannot exceed 100'],
      default: 0,
    },
    ratePerKg: {
      type: Number,
      required: [true, 'Rate per kg is required'],
      min: [0, 'Rate cannot be negative'],
    },
    laborCount: {
      type: Number,
      default: 0,
      min: [0, 'Labor count cannot be negative'],
    },
    laborChargePerWorker: {
      type: Number,
      default: 0,
      min: [0, 'Labor charge per worker cannot be negative'],
    },
    advancePayment: {
      type: Number,
      default: 0,
      min: [0, 'Advance payment cannot be negative'],
    },

    // ── Calculated fields (persisted for reporting) ───────
    lessQty:           { type: Number, default: 0 },
    netQty:            { type: Number, default: 0 },
    grossAmount:       { type: Number, default: 0 },
    totalLaborCharges: { type: Number, default: 0 },
    netPayable:        { type: Number, default: 0 },
    finalPayable:      { type: Number, default: 0 },
    balance:           { type: Number, default: 0 },

    notes: { type: String, maxlength: 500, trim: true },
  },
  { timestamps: true }
);

// ── Pre-save hook: auto-calculate all derived fields ──────────────────────────
merchantTransactionSchema.pre('save', async function (next) {
  this._recalculate();
  
  if (!this.isNew) {
    const MerchantPayment = mongoose.model('MerchantPayment');
    const payments = await MerchantPayment.find({ transaction: this._id });
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    this.balance = Math.round((this.finalPayable - totalPaid) * 100) / 100;
  } else {
    this.balance = this.finalPayable;
  }
  next();
});

/**
 * pre('findOneAndUpdate') — fires for findByIdAndUpdate calls.
 *
 * BUG FIXED: the old version called computeFields(data) where `data` was only
 * the $set portion of the update — missing fields like grossQty would be
 * undefined → coerced to 0 → all derived amounts became 0 → balance = 0 → "Paid".
 *
 * FIX: always merge the EXISTING document with the incoming update first,
 * so computeFields always has every field it needs.
 */
merchantTransactionSchema.pre('findOneAndUpdate', async function (next) {
  try {
    const update = this.getUpdate();
    // Mongoose wraps plain objects in $set; support both forms
    const data = (update && update.$set) ? update.$set : update;
    if (!data) return next();

    // Fetch the current document so we can fill in any fields not present
    // in the partial update (prevents 0-value computation)
    const docToUpdate = await this.model.findOne(this.getQuery()).lean();
    if (!docToUpdate) return next();

    // Merge: existing values as base, incoming update as override
    const merged = { ...docToUpdate, ...data };
    const calc = computeFields(merged);

    // Write recalculated fields back into the $set so MongoDB stores them
    Object.assign(data, calc);

    // Recompute balance = finalPayable − all payments recorded so far
    const MerchantPayment = mongoose.model('MerchantPayment');
    const payments = await MerchantPayment.find({ transaction: docToUpdate._id }).lean();
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    data.balance = round2(calc.finalPayable - totalPaid);
  } catch (e) {
    // Never block the update — log and continue
    console.error('[MerchantTransaction pre(findOneAndUpdate)]', e.message);
  }

  next();
});

// ── Helper: pure calculation function ────────────────────────────────────────
function computeFields(d) {
  const grossQty             = Number(d.grossQty)             || 0;
  const lessPercent          = Number(d.lessPercent)          || 0;
  const ratePerKg            = Number(d.ratePerKg)            || 0;
  const laborCount           = Number(d.laborCount)           || 0;
  const laborChargePerWorker = Number(d.laborChargePerWorker) || 0;
  const advancePayment       = Number(d.advancePayment)       || 0;

  const lessQty           = round2(grossQty * (lessPercent / 100));
  const netQty            = round2(grossQty - lessQty);
  const grossAmount       = round2(netQty * ratePerKg);
  const totalLaborCharges = round2(laborCount * laborChargePerWorker);
  const netPayable        = round2(grossAmount - totalLaborCharges);
  const finalPayable      = round2(netPayable - advancePayment);

  return { lessQty, netQty, grossAmount, totalLaborCharges, netPayable, finalPayable };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

merchantTransactionSchema.methods._recalculate = function () {
  const calc = computeFields(this);
  Object.assign(this, calc);
};

// Expose helper for controller use (create/update without save)
merchantTransactionSchema.statics.computeFields = computeFields;

// ── Compound indexes for fast queries ─────────────────────────────────────────
merchantTransactionSchema.index({ merchant: 1, transactionDate: -1 });
merchantTransactionSchema.index({ transactionDate: -1 });

module.exports = mongoose.model('MerchantTransaction', merchantTransactionSchema);
