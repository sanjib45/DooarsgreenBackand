const mongoose = require('mongoose');

/**
 * MerchantAdvance — records cash advances given to a farmer/merchant
 * BEFORE or OUTSIDE of a specific transaction. These are standalone
 * advance payments that reduce the farmer's total outstanding balance.
 */
const merchantAdvanceSchema = new mongoose.Schema(
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
      required: [true, 'Merchant name is required'],
      trim: true,
      index: true,
    },
    advanceId: {
      type: String,
      trim: true,
      uppercase: true,
    },
    amount: {
      type: Number,
      required: [true, 'Advance amount is required'],
      min: [1, 'Advance must be greater than 0'],
    },
    advanceDate: {
      type: Date,
      required: [true, 'Advance date is required'],
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

merchantAdvanceSchema.index({ createdBy: 1, advanceId: 1 }, { unique: true });
merchantAdvanceSchema.index({ merchant: 1, createdBy: 1, advanceDate: -1 });

module.exports = mongoose.model('MerchantAdvance', merchantAdvanceSchema);
