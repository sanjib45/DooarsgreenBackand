const Factory = require('../models/Factory');
const Buyer   = require('../models/Buyer');
const { validationResult } = require('express-validator');
const { buildDayRangeFilter } = require('../utils/dateRange');

const isPlaceholderPhone = (phone) => /^(NO-PHONE-|LEGACY|NEEDS-PHONE-)/i.test(String(phone || '').trim());

async function linkOrCreateBuyer(userId, body) {
  const buyerId = body.buyer || body.buyerId;
  if (buyerId) {
    const buyer = await Buyer.findOne({ _id: buyerId, createdBy: userId }).lean();
    if (!buyer) {
      const err = new Error('Selected buyer was not found');
      err.status = 404;
      throw err;
    }
    return buyer;
  }

  const buyerName = String(body.buyerName || '').trim();
  const buyerPhone = String(body.buyerPhone || body.buyerObj?.phone || '').trim();
  if (!buyerName || !buyerPhone) {
    const err = new Error('Buyer must be linked. Select an existing buyer or enter a real phone number.');
    err.status = 400;
    throw err;
  }
  if (isPlaceholderPhone(buyerPhone)) {
    const err = new Error('Placeholder phone numbers are not allowed. Enter a real phone number.');
    err.status = 400;
    throw err;
  }

  let buyer = await Buyer.findOne({ phone: buyerPhone, createdBy: userId });
  if (!buyer) {
    buyer = await Buyer.create({
      createdBy: userId,
      name: buyerName,
      phone: buyerPhone,
    });
  }
  return buyer;
}

/**
 * GET /api/factory
 * Supports combined AND filtering — ALL QUERIES SCOPED BY createdBy
 *   search    – partial, case-insensitive match on buyerName OR buyer.phone
 *   name      – filter by buyerName only
 *   phone     – filter by linked buyer phone only
 *   startDate / endDate – inclusive date range on `date` field
 */
exports.getAll = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      search, name, phone,
      startDate, endDate,
      sort = '-date',
      page = 1, limit = 50,
    } = req.query;

    // Always scope by user
    const andConditions = [{ createdBy: userId }];

    // ── Name / phone search ──────────────────────────────────────────────────
    if (search && search.trim()) {
      const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

      // Find buyer IDs whose phone matches the search term (scoped)
      const matchedBuyers = await Buyer.find({ phone: regex, createdBy: userId }).select('_id').lean();
      const buyerIds = matchedBuyers.map(b => b._id);

      const orClause = [{ buyerName: regex }];
      if (buyerIds.length > 0) orClause.push({ buyer: { $in: buyerIds } });

      andConditions.push({ $or: orClause });
    }

    // Explicit name filter (additive)
    if (name && name.trim()) {
      andConditions.push({
        buyerName: { $regex: name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
      });
    }

    // Explicit phone filter — look up buyers with this phone first (scoped)
    if (phone && phone.trim()) {
      const phoneRegex = new RegExp(phone.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const matchedByPhone = await Buyer.find({ phone: phoneRegex, createdBy: userId }).select('_id').lean();
      const ids = matchedByPhone.map(b => b._id);
      if (ids.length > 0) {
        andConditions.push({ buyer: { $in: ids } });
      } else {
        // Phone not found → return empty result (don't skip filter)
        return res.json({
          success: true, data: [],
          pagination: { total: 0, page: parseInt(page), pages: 0 },
        });
      }
    }

    // ── Date range filter (full IST calendar days) ───────────────────────────
    const dateFilter = buildDayRangeFilter(startDate, endDate);
    if (dateFilter) {
      andConditions.push({ date: dateFilter });
    }

    const filter = { $and: andConditions };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      Factory.find(filter).populate('buyer', 'name phone').sort(sort).skip(skip).limit(parseInt(limit)).lean({ virtuals: true }),
      Factory.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error('[factoryController.getAll]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/factory/stats — SCOPED by createdBy
exports.getStats = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const result = await Factory.aggregate([
      { $match: { createdBy: userId } },
      {
        $group: {
          _id: null,
          totalRecords: { $sum: 1 },
          totalFactoryAmount: {
            $sum: {
              $multiply: [
                { $subtract: ['$totalQuantity', { $multiply: ['$totalQuantity', { $divide: ['$lessPercentage', 100] }] }] },
                '$rate',
              ],
            },
          },
          totalAdvance: { $sum: '$advance' },
        },
      },
    ]);
    const base = result[0] || { totalRecords: 0, totalFactoryAmount: 0, totalAdvance: 0 };

    // Payments are embedded — still need to load for totals, but limit fields (scoped)
    const paymentAgg = await Factory.aggregate([
      { $match: { createdBy: userId } },
      { $unwind: { path: '$payments', preserveNullAndEmptyArrays: true } },
      { $group: { _id: null, totalPaid: { $sum: '$payments.amount' } } },
    ]);
    const totalPaid = paymentAgg[0]?.totalPaid || 0;
    const totalDue  = Math.round((base.totalFactoryAmount - base.totalAdvance - totalPaid) * 100) / 100;

    res.json({
      success: true,
      data: {
        totalRecords:       base.totalRecords,
        totalFactoryAmount: Math.round(base.totalFactoryAmount * 100) / 100,
        totalAdvance:       Math.round(base.totalAdvance * 100) / 100,
        totalPaid:          Math.round(totalPaid * 100) / 100,
        totalDue,
      },
    });
  } catch (err) { next(err); }
};


// GET /api/factory/:id — SCOPED by createdBy
exports.getById = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await Factory.findOne({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Sale record not found' });
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// POST /api/factory — SCOPED: stamps createdBy
exports.create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const userId = req.user._id;
    const buyer = await linkOrCreateBuyer(userId, req.body);
    const item = await Factory.create({
      ...req.body,
      buyer: buyer._id,
      buyerName: buyer.name,
      createdBy: userId,
    });
    res.status(201).json({ success: true, data: item });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
};

// PUT /api/factory/:id — SCOPED by createdBy
exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const userId = req.user._id;
    const existing = await Factory.findOne({ _id: req.params.id, createdBy: userId }).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Sale record not found' });
    const merged = { ...existing, ...req.body };
    const buyer = await linkOrCreateBuyer(userId, merged);
    const item = await Factory.findOneAndUpdate(
      { _id: req.params.id, createdBy: userId },
      { ...req.body, buyer: buyer._id, buyerName: buyer.name },
      { new: true, runValidators: true }
    );
    res.json({ success: true, data: item });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
};

// DELETE /api/factory/:id — SCOPED by createdBy
exports.remove = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await Factory.findOneAndDelete({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Sale record not found' });
    res.json({ success: true, message: 'Sale record deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// POST /api/factory/:id/payments — add a payment entry — SCOPED by createdBy
exports.addPayment = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const userId = req.user._id;
    const item = await Factory.findOne({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Sale record not found' });

    item.payments.push({
      date:   req.body.date   || new Date(),
      amount: req.body.amount,
      mode:   req.body.mode,
    });
    await item.save();
    res.status(201).json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// DELETE /api/factory/:id/payments/:paymentId — remove a specific payment — SCOPED
exports.removePayment = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await Factory.findOne({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Sale record not found' });

    const paymentIndex = item.payments.findIndex(p => p._id.toString() === req.params.paymentId);
    if (paymentIndex === -1) return res.status(404).json({ success: false, message: 'Payment not found' });

    item.payments.splice(paymentIndex, 1);
    await item.save();
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
