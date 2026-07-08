const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Owner user reference is required'],
    index: true,
  },
  payeeName: { type: String, required: [true, 'Payee name is required'], trim: true },
  paymentType: { type: String, required: [true, 'Payment type is required'], enum: ['Salary', 'Advance', 'Bonus', 'Supplier', 'Other'] },
  amount: { type: Number, required: [true, 'Amount is required'], min: 0 },
  paymentDate: { type: Date, required: [true, 'Payment date is required'], default: Date.now },
  status: { type: String, enum: ['Pending', 'Completed', 'Failed'], default: 'Pending' },
  referenceId: { type: String, trim: true },
  notes: { type: String, maxlength: 500 }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
