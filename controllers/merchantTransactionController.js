const MerchantTransaction = require('../models/MerchantTransaction');
const MerchantPayment     = require('../models/MerchantPayment');
const Merchant            = require('../models/Merchant');
const { validationResult } = require('express-validator');

// ── Utility ───────────────────────────────────────────────────────────────────
function genTxnId() {
  return 'TXN-' + Date.now().toString().slice(-7) + Math.floor(Math.random() * 9 + 1);
}

/**
 * GET /api/merchant-transactions
 * Combined AND filter support — ALL QUERIES SCOPED BY createdBy
 *   search    – partial case-insensitive match on merchantName OR merchantPhone
 *   phone     – explicit phone filter (looks up Merchant, then filters by merchantId)
 *   teaType   – exact match
 *   startDate / endDate – inclusive date range
 */
exports.getAll = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      merchantName, teaType, search, phone,
      sort = '-transactionDate',
      page = 1, limit = 20,
      startDate, endDate,
    } = req.query;

    // Always scope by user
    const andConditions = [{ createdBy: userId }];

    // ── Tea type filter ──────────────────────────────────────────────────────
    if (teaType && teaType.trim()) {
      andConditions.push({ teaType });
    }

    // ── Merchant name filter (explicit) ──────────────────────────────────────
    if (merchantName && merchantName.trim()) {
      andConditions.push({
        merchantName: {
          $regex: merchantName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i',
        },
      });
    }

    // ── Combined search: name OR phone ───────────────────────────────────────
    if (search && search.trim()) {
      const searchRegex = new RegExp(
        search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'
      );

      // Find merchants whose phone matches (scoped to user)
      const matchedMerchants = await Merchant.find({ phone: searchRegex, createdBy: userId }).select('_id').lean();
      const merchantIds = matchedMerchants.map(m => m._id);

      const orClauses = [
        { merchantName: searchRegex },
        { merchantPhone: searchRegex },
      ];
      if (merchantIds.length > 0) {
        orClauses.push({ merchant: { $in: merchantIds } });
      }

      andConditions.push({ $or: orClauses });
    }

    // ── Explicit phone filter ────────────────────────────────────────────────
    if (phone && phone.trim()) {
      const phoneRegex = new RegExp(
        phone.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'
      );
      const matchedByPhone = await Merchant.find({ phone: phoneRegex, createdBy: userId }).select('_id').lean();
      const ids = matchedByPhone.map(m => m._id);

      if (ids.length > 0) {
        andConditions.push({
          $or: [
            { merchant: { $in: ids } },
            { merchantPhone: phoneRegex },
          ],
        });
      } else {
        // No merchant found with this phone — short circuit
        return res.json({
          success: true,
          data: [],
          pagination: { total: 0, page: parseInt(page), pages: 0 },
        });
      }
    }

    // ── Date range filter ────────────────────────────────────────────────────
    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.$lte = end;
      }
      andConditions.push({ transactionDate: dateFilter });
    }

    const filter = { $and: andConditions };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      MerchantTransaction.find(filter).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      MerchantTransaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error('[merchantTransactionController.getAll]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/merchant-transactions/stats ──────────────────────────────────────
// SCOPED: all aggregations filtered by createdBy
exports.getStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const [summary, byType, recent] = await Promise.all([
      MerchantTransaction.aggregate([
        { $match: { createdBy: userId } },
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
        { $match: { createdBy: userId } },
        { $group: { _id: '$teaType', count: { $sum: 1 }, totalQty: { $sum: '$netQty' }, totalAmount: { $sum: '$finalPayable' } } },
        { $sort: { totalAmount: -1 } },
      ]),
      MerchantTransaction.find({ createdBy: userId }).sort('-transactionDate').limit(5).select('transactionId merchantName netQty finalPayable transactionDate'),
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
// SCOPED: only returns if transaction belongs to the logged-in user
exports.getById = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await MerchantTransaction.findOne({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Transaction not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/merchant-transactions ───────────────────────────────────────────
// SCOPED: stamps createdBy on creation
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
    const userId = req.user._id;
    // Inject calculated fields before save (pre-save hook also does this, double-safe)
    const calc = MerchantTransaction.computeFields(req.body);
    const item = await MerchantTransaction.create({ ...req.body, ...calc, createdBy: userId });
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Transaction ID already exists' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/merchant-transactions/:id ────────────────────────────────────────────────────
// SCOPED: only updates if transaction belongs to the logged-in user
exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const userId = req.user._id;
    // Fetch existing doc so we can fill in any fields the request doesn't touch
    const existing = await MerchantTransaction.findOne({ _id: req.params.id, createdBy: userId }).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Transaction not found' });

    // Merge existing values + incoming changes, then recalculate all derived fields
    const merged = { ...existing, ...req.body };
    const calc   = MerchantTransaction.computeFields(merged);

    // ── Explicitly compute balance ─────────────────────────────────────────
    const payments  = await MerchantPayment.find({ transaction: req.params.id, createdBy: userId }).lean();
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const balance   = Math.round((calc.finalPayable - totalPaid) * 100) / 100;

    const item = await MerchantTransaction.findOneAndUpdate(
      { _id: req.params.id, createdBy: userId },
      { ...req.body, ...calc, balance },   // balance is always explicit here
      { new: true, runValidators: true }
    );

    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/merchant-transactions/:id ─────────────────────────────────────
// SCOPED: only deletes if transaction belongs to the logged-in user
exports.remove = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await MerchantTransaction.findOneAndDelete({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Transaction not found' });

    // Also clean up related payments
    await MerchantPayment.deleteMany({ transaction: req.params.id, createdBy: userId });

    res.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
