const Payment = require('../models/Payment');
const { validationResult } = require('express-validator');

// GET /api/payments — SCOPED by createdBy
exports.getAll = async (req, res) => {
  try {
    const userId = req.user._id;
    const { paymentType, status, search, sort = '-createdAt', page = 1, limit = 20 } = req.query;
    const filter = { createdBy: userId };
    if (paymentType) filter.paymentType = paymentType;
    if (status) filter.status = status;
    if (search) filter.payeeName = { $regex: search, $options: 'i' };
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      Payment.find(filter).sort(sort).skip(skip).limit(parseInt(limit)),
      Payment.countDocuments(filter),
    ]);
    res.json({ success: true, data: items, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// GET /api/payments/stats — SCOPED by createdBy
exports.getStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const [summary, byType] = await Promise.all([
      Payment.aggregate([
        { $match: { createdBy: userId } },
        { $group: { _id: null, totalTransactions: { $sum: 1 }, totalAmount: { $sum: '$amount' } } }
      ]),
      Payment.aggregate([
        { $match: { createdBy: userId } },
        { $group: { _id: '$paymentType', totalAmount: { $sum: '$amount' } } },
        { $sort: { totalAmount: -1 } },
      ]),
    ]);
    res.json({ success: true, data: { summary: summary[0] || { totalTransactions: 0, totalAmount: 0 }, byType } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// GET /api/payments/:id — SCOPED by createdBy
exports.getById = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await Payment.findOne({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// POST /api/payments — SCOPED: stamps createdBy
exports.create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const userId = req.user._id;
    const item = await Payment.create({ ...req.body, createdBy: userId });
    res.status(201).json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// PUT /api/payments/:id — SCOPED by createdBy
exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const userId = req.user._id;
    const item = await Payment.findOneAndUpdate(
      { _id: req.params.id, createdBy: userId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// DELETE /api/payments/:id — SCOPED by createdBy
exports.remove = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await Payment.findOneAndDelete({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
