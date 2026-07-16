const MerchantPayment = require('../models/MerchantPayment');
const MerchantTransaction = require('../models/MerchantTransaction');
const { validationResult } = require('express-validator');
const mongoose = require('mongoose');

function genPaymentId() {
  return `PAY-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// ── GET /api/merchant-transactions/:txnId/payments ───────────────────────────
// Returns all payments + transaction summary — SCOPED by createdBy
exports.getForTransaction = async (req, res) => {
  try {
    const userId = req.user._id;
    const { txnId } = req.params;

    const [transaction, payments] = await Promise.all([
      MerchantTransaction.findOne({ _id: txnId, createdBy: userId }),
      MerchantPayment.find({ transaction: txnId, createdBy: userId }).sort('-paymentDate'),
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
// SCOPED: stamps createdBy and verifies transaction ownership
exports.create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const session = await mongoose.startSession();
  try {
    const userId = req.user._id;
    const { txnId } = req.params;
    let responsePayload;

    await session.withTransaction(async () => {
      const transaction = await MerchantTransaction.findOne({ _id: txnId, createdBy: userId }).session(session);
      if (!transaction) {
        const err = new Error('Transaction not found');
        err.status = 404;
        throw err;
      }

      const existingPayments = await MerchantPayment.find({ transaction: txnId, createdBy: userId }).session(session);
      const totalAlreadyPaid = existingPayments.reduce((sum, p) => sum + p.amount, 0);
      const remaining = Math.round((transaction.finalPayable - totalAlreadyPaid) * 100) / 100;

      if (remaining <= 0) {
        const err = new Error('Transaction is already fully paid');
        err.status = 400;
        throw err;
      }

      const amount = Number(req.body.amount);
      if (amount > remaining) {
        const err = new Error(`Payment amount (₹${amount}) exceeds remaining balance (₹${remaining})`);
        err.status = 400;
        throw err;
      }

      const [payment] = await MerchantPayment.create([{
        ...req.body,
        amount,
        createdBy: userId,
        paymentId: genPaymentId(),
        transaction: txnId,
        merchant: transaction.merchant,
      }], { session });

      const newTotalPaid = totalAlreadyPaid + payment.amount;
      const newBalance = Math.round((transaction.finalPayable - newTotalPaid) * 100) / 100;

      await MerchantTransaction.updateOne(
        { _id: txnId, createdBy: userId },
        { $set: { balance: newBalance } },
        { session }
      );

      responsePayload = {
        payment,
        summary: {
          finalPayable: transaction.finalPayable,
          totalPaid: Math.round(newTotalPaid * 100) / 100,
          remainingBalance: newBalance,
          isPaidFull: newBalance <= 0,
        },
      };
    });

    res.status(201).json({
      success: true,
      data: responsePayload.payment,
      summary: responsePayload.summary,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Payment ID already exists' });
    }
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
};

// ── DELETE /api/merchant-transactions/:txnId/payments/:payId ─────────────────
// SCOPED: only deletes if payment belongs to the logged-in user
exports.remove = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const userId = req.user._id;

    await session.withTransaction(async () => {
      const payment = await MerchantPayment.findOneAndDelete({
        _id: req.params.payId,
        transaction: req.params.txnId,
        createdBy: userId,
      }).session(session);
      if (!payment) {
        const err = new Error('Payment not found');
        err.status = 404;
        throw err;
      }

      const transaction = await MerchantTransaction.findOne({ _id: req.params.txnId, createdBy: userId }).session(session);
      if (transaction) {
        const existingPayments = await MerchantPayment.find({ transaction: req.params.txnId, createdBy: userId }).session(session);
        const totalPaid = existingPayments.reduce((sum, p) => sum + p.amount, 0);
        const balance = Math.round((transaction.finalPayable - totalPaid) * 100) / 100;
        await MerchantTransaction.updateOne(
          { _id: req.params.txnId, createdBy: userId },
          { $set: { balance } },
          { session }
        );
      }
    });

    res.json({ success: true, message: 'Payment deleted' });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally {
    session.endSession();
  }
};
