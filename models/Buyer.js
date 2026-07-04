const mongoose = require('mongoose');

const buyerSchema = new mongoose.Schema(
  {
    name:    { type: String, required: [true, 'Buyer name is required'], trim: true, maxlength: 100 },
    phone:   { type: String, required: [true, 'Phone number is required'], unique: true, trim: true, maxlength: 15 },
    address: { type: String, trim: true, maxlength: 200, default: '' },
    notes:   { type: String, trim: true, maxlength: 500, default: '' },
  },
  { timestamps: true }
);

buyerSchema.index({ name: 'text' });
buyerSchema.index({ phone: 1 }, { unique: true });

module.exports = mongoose.model('Buyer', buyerSchema);
