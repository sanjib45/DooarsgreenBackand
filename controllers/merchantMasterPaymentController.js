const MerchantMasterPayment = require('../models/MerchantMasterPayment');
const Merchant = require('../models/Merchant');
const mongoose = require('mongoose');

function genPaymentId() {
  return 'PAY-' + Date.now().toString().slice(-7) + Math.floor(Math.random() * 9 + 1);
}

// ── GET /api/merchants/:merchantId/payments ────────────────────────────────────
// SCOPED: only returns payments for this user's merchant
exports.getForMerchant = async (req, res) => {
  try {
    const userId = req.user._id;
    const { merchantId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(merchantId)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID' });
    }

    // Verify merchant belongs to this user
    const merchant = await Merchant.findOne({ _id: merchantId, createdBy: userId }).lean();
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    const payments = await MerchantMasterPayment.find({ merchant: merchantId, createdBy: userId })
      .sort('-paymentDate')
      .lean();

    const totalPaid = payments.reduce((s, p) => s + p.amount, 0);

    res.json({
      success: true,
      data: {
        payments,
        totalPaid: Math.round(totalPaid * 100) / 100,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/merchants/:merchantId/payments ───────────────────────────────────
// SCOPED: stamps createdBy and verifies merchant ownership
exports.create = async (req, res) => {
  try {
    const userId = req.user._id;
    const { merchantId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(merchantId)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID' });
    }

    // Verify merchant belongs to this user
    const merchant = await Merchant.findOne({ _id: merchantId, createdBy: userId }).lean();
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    const { amount, paymentDate, paymentMode, notes } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    const payment = await MerchantMasterPayment.create({
      createdBy: userId,
      merchant: merchantId,
      merchantName: merchant.name,
      paymentId: genPaymentId(),
      amount: Number(amount),
      paymentDate: paymentDate || new Date(),
      paymentMode: paymentMode || 'Cash',
      notes: notes || '',
    });

    res.status(201).json({ success: true, data: payment });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Payment ID conflict, please retry' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/merchants/:merchantId/payments/:paymentId ──────────────────────
// SCOPED: only deletes if payment belongs to the logged-in user
exports.remove = async (req, res) => {
  try {
    const userId = req.user._id;
    const { merchantId, paymentId } = req.params;
    const payment = await MerchantMasterPayment.findOneAndDelete({
      _id: paymentId,
      merchant: merchantId,
      createdBy: userId,
    });
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    res.json({ success: true, message: 'Payment deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
