const mongoose = require('mongoose');

/**
 * MerchantMasterPayment — records a direct payment made to a merchant.
 * This is a merchant-level payment (not tied to a specific transaction),
 * used to track weekly or bulk payments for leaf procurement.
 */
const merchantMasterPaymentSchema = new mongoose.Schema(
  {
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Owner user reference is required'],
      index: true,
    },
    merchant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Merchant',
      required: [true, 'Merchant reference is required'],
      index: true,
    },
    merchantName: {
      type: String,
      trim: true,
    },
    paymentId: {
      type: String,
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

merchantMasterPaymentSchema.index({ createdBy: 1, paymentId: 1 }, { unique: true });
merchantMasterPaymentSchema.index({ merchant: 1, createdBy: 1, paymentDate: -1 });

module.exports = mongoose.model('MerchantMasterPayment', merchantMasterPaymentSchema);
