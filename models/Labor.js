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
  name:          { type: String, required: [true, 'Name is required'], trim: true },
  role:          { type: String, required: [true, 'Role is required'], enum: ['Plucker', 'Factory Worker', 'Supervisor', 'Maintenance', 'Other'] },
  laborCharge:   { type: Number, required: [true, 'Labor charge is required'], min: [0, 'Labor charge cannot be negative'], default: 0 },
  joinDate:      { type: Date, required: [true, 'Join date is required'], default: Date.now },
  paymentStatus: { type: String, enum: ['Due', 'Paid'], default: 'Due' },
  notes:         { type: String, maxlength: 500 },
}, { timestamps: true });

module.exports = mongoose.model('Labor', laborSchema);
