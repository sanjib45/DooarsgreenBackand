const mongoose = require('mongoose');

/**
 * MerchantPayment — records individual payments against a MerchantTransaction.
 * After each payment, the parent transaction's `balance` is recalculated.
 */
const merchantPaymentSchema = new mongoose.Schema(
  {
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MerchantTransaction',
      required: [true, 'Transaction reference is required'],
      index: true,
    },
    merchant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: [true, 'Merchant reference is required'],
      index: true,
    },
    paymentId: {
      type: String,
      unique: true,
      trim: true,
      uppercase: true,
    },
    amount: {
      type: Number,
      required: [true, 'Payment amount is required'],
      min: [1, 'Payment must be greater than 0'],
    },
    paymentDate: {
      type: Date,
      required: [true, 'Payment date is required'],
      default: Date.now,
    },
    paymentMode: {
      type: String,
      enum: ['Cash', 'Bank Transfer', 'Cheque', 'UPI', 'Other'],
      default: 'Cash',
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MerchantPayment', merchantPaymentSchema);
