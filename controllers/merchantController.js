const TeaMerchant = require('../models/TeaMerchant');
const { validationResult } = require('express-validator');

// GET /api/merchant
exports.getAll = async (req, res) => {
  try {
    const { teaType, sort = '-createdAt', page = 1, limit = 20, search } = req.query;
    const filter = {};
    if (teaType) filter.teaType = teaType;
    if (search) filter.name = { $regex: search, $options: 'i' };
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      TeaMerchant.find(filter).sort(sort).skip(skip).limit(parseInt(limit)),
      TeaMerchant.countDocuments(filter),
    ]);
    res.json({ success: true, data: items, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// GET /api/merchant/stats
exports.getStats = async (req, res) => {
  try {
    const [summary, byType] = await Promise.all([
      TeaMerchant.aggregate([{ $group: { _id: null, totalBatches: { $sum: 1 }, totalQuantity: { $sum: '$quantity' }, totalValue: { $sum: { $multiply: ['$quantity','$pricePerUnit'] } }, avgPrice: { $avg: '$pricePerUnit' } } }]),
      TeaMerchant.aggregate([{ $group: { _id: '$teaType', count: { $sum: 1 }, totalQty: { $sum: '$quantity' } } }, { $sort: { totalQty: -1 } }]),
    ]);
    res.json({ success: true, data: { summary: summary[0] || { totalBatches:0, totalQuantity:0, totalValue:0, avgPrice:0 }, byType } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// GET /api/merchant/:id
exports.getById = async (req, res) => {
  try {
    const item = await TeaMerchant.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// POST /api/merchant
exports.create = async (req, res) => {
  if (!req.body.batchId) {
    req.body.batchId = 'BTH-' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 10);
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const item = await TeaMerchant.create(req.body);
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'Batch ID already exists' });
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/merchant/:id
exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const item = await TeaMerchant.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// DELETE /api/merchant/:id
exports.remove = async (req, res) => {
  try {
    const item = await TeaMerchant.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
