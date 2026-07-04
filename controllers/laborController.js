const Labor = require('../models/Labor');
const { validationResult } = require('express-validator');

// ── GET /api/labor ────────────────────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const {
      role,
      paymentStatus,
      search,
      sort = '-createdAt',
      page = 1,
      limit = 50,
    } = req.query;

    const filter = {};
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
exports.getStats = async (req, res) => {
  try {
    const [summary, byRole] = await Promise.all([
      Labor.aggregate([
        {
          $group: {
            _id: null,
            totalWorkers:  { $sum: 1 },
            dueWorkers:    { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Due'] }, 1, 0] } },
            paidWorkers:   { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, 1, 0] } },
            totalDue:      { $sum: { $cond: [{ $eq: ['$paymentStatus', 'Due'] }, '$laborCharge', 0] } },
            totalCharge:   { $sum: '$laborCharge' },
          },
        },
      ]),
      Labor.aggregate([
        { $group: { _id: '$role', count: { $sum: 1 }, totalCharge: { $sum: '$laborCharge' } } },
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
exports.getById = async (req, res) => {
  try {
    const item = await Labor.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/labor ───────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const item = await Labor.create(req.body);
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/labor/:id ────────────────────────────────────────────────────────
exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const item = await Labor.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/labor/:id/pay ──────────────────────────────────────────────────
// Toggles paymentStatus: 'Due' → 'Paid', 'Paid' → 'Due'
exports.togglePay = async (req, res) => {
  try {
    const item = await Labor.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });

    item.paymentStatus = item.paymentStatus === 'Paid' ? 'Due' : 'Paid';
    await item.save();

    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/labor/:id ─────────────────────────────────────────────────────
exports.remove = async (req, res) => {
  try {
    const item = await Labor.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
