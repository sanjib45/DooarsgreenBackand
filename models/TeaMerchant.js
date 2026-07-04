const mongoose = require('mongoose');

const teaMerchantSchema = new mongoose.Schema({
  batchId: { type: String, required: [true, 'Batch ID required'], unique: true, trim: true, uppercase: true },
  teaType: { type: String, required: [true, 'Tea type required'], enum: ['Green Tea','CTC','Other'] },
  quantity: { type: Number, required: [true, 'Quantity required'], min: 0 },
  unit: { type: String, default: 'kg', enum: ['kg','g','lb'] },
  pricePerUnit: { type: Number, required: [true, 'Price required'], min: 0 },
  harvestDate: { type: Date, required: [true, 'Harvest date required'] },

  name: { type: String, required: [true, 'Name required'], trim: true },
  notes: { type: String, maxlength: 500 },
}, { timestamps: true });

teaMerchantSchema.virtual('totalValue').get(function () {
  return this.quantity * this.pricePerUnit;
});
teaMerchantSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('TeaMerchant', teaMerchantSchema);
