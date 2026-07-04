const MerchantTransaction = require('../models/MerchantTransaction');
const MerchantPayment     = require('../models/MerchantPayment');
const { validationResult } = require('express-validator');


// ── Utility ───────────────────────────────────────────────────────────────────
function genTxnId() {
  return 'TXN-' + Date.now().toString().slice(-7) + Math.floor(Math.random() * 9 + 1);
}

// ── GET /api/merchant-transactions ────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const {
      merchantName, teaType,
      sort = '-transactionDate',
      page = 1, limit = 20,
      search,
      startDate, endDate,
    } = req.query;

    const filter = {};
    if (teaType) filter.teaType = teaType;
    if (merchantName) filter.merchantName = { $regex: merchantName, $options: 'i' };
    if (search) filter.merchantName = { $regex: search, $options: 'i' };
    if (startDate || endDate) {
      filter.transactionDate = {};
      if (startDate) filter.transactionDate.$gte = new Date(startDate);
      if (endDate) {
        // Include the full end day by setting time to 23:59:59.999
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.transactionDate.$lte = end;
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      MerchantTransaction.find(filter).sort(sort).skip(skip).limit(parseInt(limit)),
      MerchantTransaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/merchant-transactions/stats ──────────────────────────────────────
exports.getStats = async (req, res) => {
  try {
    const [summary, byType, recent] = await Promise.all([
      MerchantTransaction.aggregate([
        {
          $group: {
            _id: null,
            totalTransactions: { $sum: 1 },
            totalGrossQty: { $sum: '$grossQty' },
            totalNetQty: { $sum: '$netQty' },
            totalGrossAmount: { $sum: '$grossAmount' },
            totalLaborCharges: { $sum: '$laborCharges' },
            totalAdvance: { $sum: '$advancePayment' },
            totalBalance: { $sum: '$balance' },
          },
        },
      ]),
      MerchantTransaction.aggregate([
        { $group: { _id: '$teaType', count: { $sum: 1 }, totalQty: { $sum: '$netQty' }, totalAmount: { $sum: '$finalPayable' } } },
        { $sort: { totalAmount: -1 } },
      ]),
      MerchantTransaction.find().sort('-transactionDate').limit(5).select('transactionId merchantName netQty finalPayable transactionDate'),
    ]);

    res.json({
      success: true,
      data: {
        summary: summary[0] || {
          totalTransactions: 0, totalGrossQty: 0, totalNetQty: 0,
          totalGrossAmount: 0, totalLaborCharges: 0, totalAdvance: 0, totalBalance: 0,
        },
        byType,
        recent,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/merchant-transactions/:id ────────────────────────────────────────
exports.getById = async (req, res) => {
  try {
    const item = await MerchantTransaction.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Transaction not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/merchant-transactions ───────────────────────────────────────────
exports.create = async (req, res) => {
  // Auto-generate transactionId if not provided
  if (!req.body.transactionId) {
    req.body.transactionId = genTxnId();
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    // Inject calculated fields before save (pre-save hook also does this, double-safe)
    const calc = MerchantTransaction.computeFields(req.body);
    const item = await MerchantTransaction.create({ ...req.body, ...calc });
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Transaction ID already exists' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/merchant-transactions/:id ────────────────────────────────────────────────────
exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    // Fetch existing doc so we can fill in any fields the request doesn't touch
    const existing = await MerchantTransaction.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Transaction not found' });

    // Merge existing values + incoming changes, then recalculate all derived fields
    const merged = { ...existing, ...req.body };
    const calc   = MerchantTransaction.computeFields(merged);

    // ── Explicitly compute balance ─────────────────────────────────────────
    // We must do this here (not rely solely on the model hook) because:
    //  • The model’s pre('findOneAndUpdate') hook is a safety net but can miss
    //    edge cases depending on Mongoose internals.
    //  • balance = finalPayable − total of all MerchantPayment records.
    //    If advancePayment or qty/rate changes, finalPayable changes, so
    //    balance must be recomputed against the real payment history.
    const payments  = await MerchantPayment.find({ transaction: req.params.id }).lean();
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const balance   = Math.round((calc.finalPayable - totalPaid) * 100) / 100;

    const item = await MerchantTransaction.findByIdAndUpdate(
      req.params.id,
      { ...req.body, ...calc, balance },   // balance is always explicit here
      { new: true, runValidators: true }
    );

    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/merchant-transactions/:id ─────────────────────────────────────
exports.remove = async (req, res) => {
  try {
    const item = await MerchantTransaction.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Transaction not found' });
    res.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
