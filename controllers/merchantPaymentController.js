const MerchantPayment = require('../models/MerchantPayment');
const MerchantTransaction = require('../models/MerchantTransaction');
const { validationResult } = require('express-validator');

function genPaymentId() {
  return 'PAY-' + Date.now().toString().slice(-7) + Math.floor(Math.random() * 9 + 1);
}

// ── GET /api/merchant-transactions/:txnId/payments ───────────────────────────
// Returns all payments + transaction summary
exports.getForTransaction = async (req, res) => {
  try {
    const { txnId } = req.params;

    const [transaction, payments] = await Promise.all([
      MerchantTransaction.findById(txnId),
      MerchantPayment.find({ transaction: txnId }).sort('-paymentDate'),
    ]);

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const remainingBalance = Math.round((transaction.finalPayable - totalPaid) * 100) / 100;

    res.json({
      success: true,
      data: {
        transaction,
        payments,
        summary: {
          finalPayable: transaction.finalPayable,
          totalPaid: Math.round(totalPaid * 100) / 100,
          remainingBalance,
          isPaidFull: remainingBalance <= 0,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/merchant-transactions/:txnId/payments ──────────────────────────
exports.create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { txnId } = req.params;

    const transaction = await MerchantTransaction.findById(txnId);
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    // Check total paid so far
    const existingPayments = await MerchantPayment.find({ transaction: txnId });
    const totalAlreadyPaid = existingPayments.reduce((sum, p) => sum + p.amount, 0);
    const remaining = Math.round((transaction.finalPayable - totalAlreadyPaid) * 100) / 100;

    if (remaining <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Transaction is already fully paid',
      });
    }

    if (req.body.amount > remaining) {
      return res.status(400).json({
        success: false,
        message: `Payment amount (₹${req.body.amount}) exceeds remaining balance (₹${remaining})`,
      });
    }

    const payment = await MerchantPayment.create({
      ...req.body,
      paymentId: genPaymentId(),
      transaction: txnId,
      merchant: transaction.merchant,
    });

    // Recalculate remaining after this payment
    const newTotalPaid = totalAlreadyPaid + payment.amount;
    const newBalance = Math.round((transaction.finalPayable - newTotalPaid) * 100) / 100;

    // Save the new balance to the transaction model
    transaction.balance = newBalance;
    await transaction.save();

    res.status(201).json({
      success: true,
      data: payment,
      summary: {
        finalPayable: transaction.finalPayable,
        totalPaid: Math.round(newTotalPaid * 100) / 100,
        remainingBalance: newBalance,
        isPaidFull: newBalance <= 0,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Payment ID already exists' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/merchant-transactions/:txnId/payments/:payId ─────────────────
exports.remove = async (req, res) => {
  try {
    const payment = await MerchantPayment.findOneAndDelete({
      _id: req.params.payId,
      transaction: req.params.txnId,
    });
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    // Recalculate and update the transaction balance
    const transaction = await MerchantTransaction.findById(req.params.txnId);
    if (transaction) {
      const existingPayments = await MerchantPayment.find({ transaction: req.params.txnId });
      const totalPaid = existingPayments.reduce((sum, p) => sum + p.amount, 0);
      transaction.balance = Math.round((transaction.finalPayable - totalPaid) * 100) / 100;
      await transaction.save();
    }

    res.json({ success: true, message: 'Payment deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
