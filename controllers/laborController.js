const Labor = require('../models/Labor');
const { validationResult } = require('express-validator');

// ── GET /api/labor ────────────────────────────────────────────────────────────
// SCOPED: only returns labors created by the logged-in user
exports.getAll = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      role,
      paymentStatus,
      search,
      sort = '-createdAt',
      page = 1,
      limit = 50,
    } = req.query;

    const filter = { createdBy: userId };
    if (role)          filter.role          = role;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (search)        filter.name          = { $regex: search, $options: 'i' };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      Labor.find(filter).sort(sort).skip(skip).limit(parseInt(limit)),
      Labor.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/labor/stats ──────────────────────────────────────────────────────
// SCOPED: all aggregations filtered by createdBy
exports.getStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const [summary, byRole] = await Promise.all([
      Labor.aggregate([
        { $match: { createdBy: userId } },
        {
          $group: {
            _id: null,
            totalWorkers:  { $sum: 1 },
            dueWorkers:    { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Due'] }, 1, 0] } },
            paidWorkers:   { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, 1, 0] } },
            totalDue:      { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Due'] }, { $ifNull: ['$totalPayable', { $multiply: [{ $ifNull: ['$headCount', 1] }, '$laborCharge'] }] }, 0] } },
            totalCharge:   { $sum: { $ifNull: ['$totalPayable', { $multiply: [{ $ifNull: ['$headCount', 1] }, '$laborCharge'] }] } },
          },
        },
      ]),
      Labor.aggregate([
        { $match: { createdBy: userId } },
        { $group: { _id: '$role', count: { $sum: 1 }, totalCharge: { $sum: { $ifNull: ['$totalPayable', { $multiply: [{ $ifNull: ['$headCount', 1] }, '$laborCharge'] }] } } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        summary: summary[0] || {
          totalWorkers: 0, dueWorkers: 0, paidWorkers: 0,
          totalDue: 0, totalCharge: 0,
        },
        byRole,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/labor/:id ────────────────────────────────────────────────────────
// SCOPED by createdBy
exports.getById = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await Labor.findOne({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/labor ───────────────────────────────────────────────────────────
// SCOPED: stamps createdBy
exports.create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const userId = req.user._id;
    const body = { ...req.body, createdBy: userId };
    
    // Explicitly compute totalPayable
    const hc = Number(body.headCount) || 1;
    const lc = Number(body.laborCharge) || 0;
    body.totalPayable = hc * lc;

    const item = await Labor.create(body);
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/labor/:id ────────────────────────────────────────────────────────
// SCOPED by createdBy
exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const userId = req.user._id;
    const body = { ...req.body };

    const hc = Number(body.headCount) || 1;
    const lc = Number(body.laborCharge) || 0;
    body.totalPayable = hc * lc;

    const item = await Labor.findOneAndUpdate(
      { _id: req.params.id, createdBy: userId },
      body,
      { new: true, runValidators: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/labor/:id/pay ──────────────────────────────────────────────────
// Toggles paymentStatus: 'Due' → 'Paid', 'Paid' → 'Due' — SCOPED by createdBy
exports.togglePay = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await Labor.findOne({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });

    item.paymentStatus = item.paymentStatus === 'Paid' ? 'Due' : 'Paid';
    await item.save();

    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/labor/:id ─────────────────────────────────────────────────────
// SCOPED by createdBy
exports.remove = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await Labor.findOneAndDelete({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
