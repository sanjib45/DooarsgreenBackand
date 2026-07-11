const mongoose = require('mongoose');

/**
 * Labor — tracks estate workforce with payment status.
 *
 * Changes from original:
 *  - Removed: contact, dailyWage, status (Active/Inactive/On Leave)
 *  - Added:   laborCharge  — amount owed to this worker for the current period
 *  - Added:   paymentStatus — 'Due' (unpaid) | 'Paid' (settled)
 *
 * Toggling paymentStatus is done via PATCH /api/labor/:id/pay
 */
const laborSchema = new mongoose.Schema({
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Owner user reference is required'],
    index: true,
  },
  name:          { type: String, required: [true, 'Name is required'], trim: true },
  role:          { type: String, required: [true, 'Role is required'], enum: ['Plucker', 'Factory Worker', 'Supervisor', 'Maintenance', 'Other'] },
  headCount:     { type: Number, required: [true, 'Head count is required'], min: [1, 'Head count must be at least 1'], default: 1 },
  laborCharge:   { type: Number, required: [true, 'Labor charge per head is required'], min: [0, 'Labor charge cannot be negative'], default: 0 },
  totalPayable:  { type: Number, default: 0 },
  joinDate:      { type: Date, required: [true, 'Join date is required'], default: Date.now },
  paymentStatus: { type: String, enum: ['Due', 'Paid'], default: 'Due' },
  notes:         { type: String, maxlength: 500 },
}, { timestamps: true });

laborSchema.pre('save', function(next) {
  this.totalPayable = this.headCount * this.laborCharge;
  next();
});

// NOTE: totalPayable is computed in the controller before all create/update calls.
// The pre-save hook above handles it for .save() calls (e.g. togglePay).

module.exports = mongoose.model('Labor', laborSchema);
