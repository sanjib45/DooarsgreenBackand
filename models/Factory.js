const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  date:   { type: Date, required: true, default: Date.now },
  amount: { type: Number, required: true, min: 0 },
  mode:   { type: String, enum: ['Cash', 'Online', 'Cheque'], default: 'Online' },
}, { _id: true });

const factorySchema = new mongoose.Schema({
  date:            { type: Date, default: Date.now },
  buyer:           { type: mongoose.Schema.Types.ObjectId, ref: 'Buyer', index: true },
  buyerName:       { type: String, required: [true, 'Buyer name is required'], trim: true, index: true },
  totalQuantity:   { type: Number, required: [true, 'Total quantity is required'], min: 0 },
  lessPercentage:  { type: Number, min: 0, default: 0 },
  rate:            { type: Number, required: [true, 'Rate is required'], min: 0 },
  advance:         { type: Number, default: 0, min: 0 },
  fineLeaf:        { type: Number, min: 0, max: 100, default: 0 },
  payments:        { type: [paymentSchema], default: [] },
  dueDate:         { type: Date },
  remarks:         { type: String, trim: true, maxlength: 500 },
}, { timestamps: true });

factorySchema.index({ buyer: 1, date: -1 });
factorySchema.index({ date: -1 });

// ── Virtuals ────────────────────────────────────────────────
// All virtuals use safe fallbacks (|| 0, || []) so that OLD MongoDB
// documents (created with the previous schema) never throw a TypeError.

// Virtual: LESS QNTY = totalQuantity * lessPercentage / 100
factorySchema.virtual('lessQuantity').get(function () {
  const tq = parseFloat(this.totalQuantity) || 0;
  const lp = parseFloat(this.lessPercentage) || 0;
  return parseFloat(((tq * lp) / 100).toFixed(2));
});

// Virtual: NET QNTY = totalQuantity - lessQuantity
factorySchema.virtual('netQuantity').get(function () {
  const tq = parseFloat(this.totalQuantity) || 0;
  return parseFloat((tq - this.lessQuantity).toFixed(2));
});

// Virtual: TOTAL AMOUNT = netQuantity * rate
factorySchema.virtual('totalAmount').get(function () {
  const r = parseFloat(this.rate) || 0;
  return parseFloat((this.netQuantity * r).toFixed(2));
});

// Virtual: TOTAL PAID = sum of all payment amounts
// IMPORTANT: use (this.payments || []) — old documents may have payments=undefined
factorySchema.virtual('totalPaid').get(function () {
  const payments = this.payments || [];
  const sum = payments.reduce((acc, p) => acc + (parseFloat(p.amount) || 0), 0);
  return parseFloat(sum.toFixed(2));
});

// Virtual: DUE = totalAmount - advance - totalPaid
factorySchema.virtual('due').get(function () {
  const adv = parseFloat(this.advance) || 0;
  return parseFloat((this.totalAmount - adv - this.totalPaid).toFixed(2));
});

factorySchema.set('toJSON', { virtuals: true });
factorySchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Factory', factorySchema);
