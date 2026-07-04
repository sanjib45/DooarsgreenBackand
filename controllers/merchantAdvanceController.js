const MerchantAdvance = require('../models/MerchantAdvance');
const Merchant = require('../models/Merchant');
const mongoose = require('mongoose');

function genAdvanceId() {
  return 'ADV-' + Date.now().toString().slice(-7) + Math.floor(Math.random() * 9 + 1);
}

// ── GET /api/merchants/:merchantId/advances ────────────────────────────────────
exports.getForMerchant = async (req, res) => {
  try {
    const { merchantId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(merchantId)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID' });
    }

    const advances = await MerchantAdvance.find({ merchant: merchantId })
      .sort('-advanceDate')
      .lean();

    const totalAdvance = advances.reduce((s, a) => s + a.amount, 0);

    res.json({
      success: true,
      data: {
        advances,
        totalAdvance: Math.round(totalAdvance * 100) / 100,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/merchants/:merchantId/advances ───────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { merchantId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(merchantId)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID' });
    }

    const merchant = await Merchant.findById(merchantId).lean();
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    const { amount, advanceDate, paymentMode, notes } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const advance = await MerchantAdvance.create({
      merchant: merchantId,
      merchantName: merchant.name,
      advanceId: genAdvanceId(),
      amount: Number(amount),
      advanceDate: advanceDate || new Date(),
      paymentMode: paymentMode || 'Cash',
      notes: notes || '',
    });

    res.status(201).json({ success: true, data: advance });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Advance ID conflict, please retry' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/merchants/:merchantId/advances/:advanceId ──────────────────────
exports.remove = async (req, res) => {
  try {
    const { merchantId, advanceId } = req.params;
    const advance = await MerchantAdvance.findOneAndDelete({
      _id: advanceId,
      merchant: merchantId,
    });
    if (!advance) {
      return res.status(404).json({ success: false, message: 'Advance not found' });
    }
    res.json({ success: true, message: 'Advance deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
