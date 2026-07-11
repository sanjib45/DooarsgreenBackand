const Merchant            = require('../models/Merchant');
const MerchantTransaction = require('../models/MerchantTransaction');
const mongoose            = require('mongoose');
const { validationResult } = require('express-validator');

// ── Helper: validate ObjectId ────────────────────────────────────────────────
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// ── GET /api/merchants/search?q=... ──────────────────────────────────────────
// Fast search for the dropdown autocomplete — returns top 15 matches
// SCOPED: only returns merchants created by the logged-in user
exports.search = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { q = '' } = req.query;
    if (!q.trim()) {
      const recent = await Merchant.find({ createdBy: userId }).sort('-createdAt').limit(15).lean();
      return res.json({ success: true, data: recent });
    }

    // Case-insensitive regex search on name OR phone
    const regex = new RegExp(q.trim(), 'i');
    const results = await Merchant.find({
      createdBy: userId,
      $or: [{ name: regex }, { phone: regex }],
    })
      .sort('name')
      .limit(15)
      .lean();

    res.json({ success: true, data: results });
  } catch (err) { next(err); }
};

// ── GET /api/merchants ───────────────────────────────────────────────────────
// SCOPED: only returns merchants created by the logged-in user
exports.getAll = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { search, sort = 'name', page = 1, limit = 50 } = req.query;
    const filter = { createdBy: userId };
    if (search) {
      const regex = new RegExp(search.trim(), 'i');
      filter.$or = [{ name: regex }, { phone: regex }];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      Merchant.find(filter).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      Merchant.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) { next(err); }
};

// ── GET /api/merchants/:id ───────────────────────────────────────────────────
// SCOPED: only returns if merchant belongs to the logged-in user
exports.getById = async (req, res, next) => {
  try {
    const userId = req.user._id;
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID format' });
    }

    const merchant = await Merchant.findOne({ _id: req.params.id, createdBy: userId }).lean();
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    // Also fetch aggregate stats for this merchant (scoped to user)
    const txnStats = await MerchantTransaction.aggregate([
      { $match: { merchant: merchant._id, createdBy: userId } },
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalNetQty:       { $sum: '$netQty' },
          totalGrossAmount:  { $sum: '$grossAmount' },
          totalFinalPayable: { $sum: '$finalPayable' },
          totalBalance:      { $sum: '$balance' },
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        ...merchant,
        stats: txnStats[0] || {
          totalTransactions: 0, totalNetQty: 0,
          totalGrossAmount: 0, totalFinalPayable: 0, totalBalance: 0,
        },
      },
    });
  } catch (err) { next(err); }
};

// ── POST /api/merchants — findOrCreate ───────────────────────────────────────
// If phone exists for THIS user → return existing merchant.
// If not → create new merchant owned by THIS user.
// SCOPED: phone uniqueness is per-user, not global
exports.findOrCreate = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const userId = req.user._id;
    const { name, phone, address, notes } = req.body;

    // Check if merchant with this phone already exists FOR THIS USER
    const existing = await Merchant.findOne({ phone: phone.trim(), createdBy: userId });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'This phone number is already registered with another merchant. Please use a different phone number.',
      });
    }

    // Create new merchant owned by this user
    const merchant = await Merchant.create({
      createdBy: userId,
      name: name.trim(),
      phone: phone.trim(),
      address: address?.trim() || '',
      notes: notes?.trim() || '',
    });

    res.status(201).json({
      success: true,
      data: merchant,
      isNew: true,
      message: 'New merchant created',
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A merchant with this phone number already exists in your account.',
      });
    }
    next(err);
  }
};

// ── PUT /api/merchants/:id ───────────────────────────────────────────────────
// SCOPED: only updates if merchant belongs to the logged-in user
exports.update = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const userId = req.user._id;
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID format' });
    }

    const merchant = await Merchant.findOneAndUpdate(
      { _id: req.params.id, createdBy: userId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    // Also update the denormalized merchantName in all linked transactions (scoped)
    await MerchantTransaction.updateMany(
      { merchant: merchant._id, createdBy: userId },
      { $set: { merchantName: merchant.name } }
    );

    res.json({ success: true, data: merchant });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Another merchant with this phone number already exists in your account.',
      });
    }
    next(err);
  }
};

// ── DELETE /api/merchants/:id ────────────────────────────────────────────────
// SCOPED: only deletes if merchant belongs to the logged-in user
exports.remove = async (req, res, next) => {
  try {
    const userId = req.user._id;
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID format' });
    }

    // Check for linked transactions (scoped)
    const txnCount = await MerchantTransaction.countDocuments({ merchant: req.params.id, createdBy: userId });
    if (txnCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete — this merchant has ${txnCount} linked transaction(s). Delete or reassign them first.`,
      });
    }

    const merchant = await Merchant.findOneAndDelete({ _id: req.params.id, createdBy: userId });
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    res.json({ success: true, message: `Merchant "${merchant.name}" deleted successfully` });
  } catch (err) { next(err); }
};
