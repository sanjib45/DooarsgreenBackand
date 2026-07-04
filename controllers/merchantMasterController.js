const Merchant            = require('../models/Merchant');
const MerchantTransaction = require('../models/MerchantTransaction');
const mongoose            = require('mongoose');
const { validationResult } = require('express-validator');

// ── Helper: validate ObjectId ────────────────────────────────────────────────
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// ── GET /api/merchants/search?q=... ──────────────────────────────────────────
// Fast search for the dropdown autocomplete — returns top 15 matches
exports.search = async (req, res, next) => {
  try {
    const { q = '' } = req.query;
    if (!q.trim()) {
      const recent = await Merchant.find({}).sort('-createdAt').limit(15).lean();
      return res.json({ success: true, data: recent });
    }

    // Case-insensitive regex search on name OR phone
    const regex = new RegExp(q.trim(), 'i');
    const results = await Merchant.find({
      $or: [{ name: regex }, { phone: regex }],
    })
      .sort('name')
      .limit(15)
      .lean();

    res.json({ success: true, data: results });
  } catch (err) { next(err); }
};

// ── GET /api/merchants ───────────────────────────────────────────────────────
exports.getAll = async (req, res, next) => {
  try {
    const { search, sort = 'name', page = 1, limit = 50 } = req.query;
    const filter = {};
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
exports.getById = async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID format' });
    }

    const merchant = await Merchant.findById(req.params.id).lean();
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    // Also fetch aggregate stats for this merchant
    const txnStats = await MerchantTransaction.aggregate([
      { $match: { merchant: merchant._id } },
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
// If phone exists → return existing merchant.
// If not → create new merchant.
exports.findOrCreate = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { name, phone, address, notes } = req.body;

    // Check if merchant with this phone already exists
    const existing = await Merchant.findOne({ phone: phone.trim() });
    if (existing) {
      // Optionally update name/address if provided differently
      let updated = false;
      if (name && name.trim() !== existing.name) {
        existing.name = name.trim();
        updated = true;
      }
      if (address !== undefined && address !== existing.address) {
        existing.address = address;
        updated = true;
      }
      if (notes !== undefined && notes !== existing.notes) {
        existing.notes = notes;
        updated = true;
      }
      if (updated) await existing.save();

      return res.status(200).json({
        success: true,
        data: existing,
        isNew: false,
        message: 'Existing merchant found and returned',
      });
    }

    // Create new merchant
    const merchant = await Merchant.create({
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
  } catch (err) { next(err); }
};

// ── PUT /api/merchants/:id ───────────────────────────────────────────────────
exports.update = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID format' });
    }

    const merchant = await Merchant.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    // Also update the denormalized merchantName in all linked transactions
    await MerchantTransaction.updateMany(
      { merchant: merchant._id },
      { $set: { merchantName: merchant.name } }
    );

    res.json({ success: true, data: merchant });
  } catch (err) { next(err); }
};

// ── DELETE /api/merchants/:id ────────────────────────────────────────────────
exports.remove = async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid merchant ID format' });
    }

    // Check for linked transactions
    const txnCount = await MerchantTransaction.countDocuments({ merchant: req.params.id });
    if (txnCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete — this merchant has ${txnCount} linked transaction(s). Delete or reassign them first.`,
      });
    }

    const merchant = await Merchant.findByIdAndDelete(req.params.id);
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    res.json({ success: true, message: `Merchant "${merchant.name}" deleted successfully` });
  } catch (err) { next(err); }
};
