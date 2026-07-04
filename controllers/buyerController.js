const Buyer   = require('../models/Buyer');
const Factory = require('../models/Factory');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// GET /api/buyers/search?q=
exports.search = async (req, res, next) => {
  try {
    const { q = '' } = req.query;
    const regex = q.trim() ? new RegExp(q.trim(), 'i') : /.*/;
    const results = await Buyer.find({ $or: [{ name: regex }, { phone: regex }] })
      .sort('name').limit(15).lean();
    res.json({ success: true, data: results });
  } catch (err) { next(err); }
};

// GET /api/buyers
exports.getAll = async (req, res, next) => {
  try {
    const { search, sort = 'name', page = 1, limit = 50 } = req.query;
    const filter = {};
    if (search) { const r = new RegExp(search.trim(), 'i'); filter.$or = [{ name: r }, { phone: r }]; }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      Buyer.find(filter).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      Buyer.countDocuments(filter),
    ]);
    res.json({ success: true, data: items, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) { next(err); }
};

// GET /api/buyers/:id
exports.getById = async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid buyer ID format' });
    const buyer = await Buyer.findById(req.params.id).lean();
    if (!buyer) return res.status(404).json({ success: false, message: 'Buyer not found' });
    const stats = await Factory.aggregate([
      { $match: { buyer: buyer._id } },
      { $group: { _id: null, totalRecords: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' }, totalDue: { $sum: '$due' } } },
    ]);
    res.json({ success: true, data: { ...buyer, stats: stats[0] || { totalRecords: 0, totalAmount: 0, totalDue: 0 } } });
  } catch (err) { next(err); }
};

// POST /api/buyers — findOrCreate
exports.findOrCreate = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { name, phone, address, notes } = req.body;
    const existing = await Buyer.findOne({ phone: phone.trim() });
    if (existing) {
      if (name && name.trim() !== existing.name) { existing.name = name.trim(); await existing.save(); }
      return res.status(200).json({ success: true, data: existing, isNew: false, message: 'Existing buyer returned' });
    }
    const buyer = await Buyer.create({ name: name.trim(), phone: phone.trim(), address: address?.trim() || '', notes: notes?.trim() || '' });
    res.status(201).json({ success: true, data: buyer, isNew: true, message: 'New buyer created' });
  } catch (err) { next(err); }
};

// PUT /api/buyers/:id
exports.update = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid buyer ID format' });
    const buyer = await Buyer.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!buyer) return res.status(404).json({ success: false, message: 'Buyer not found' });
    await Factory.updateMany({ buyer: buyer._id }, { $set: { buyerName: buyer.name } });
    res.json({ success: true, data: buyer });
  } catch (err) { next(err); }
};

// DELETE /api/buyers/:id
exports.remove = async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid buyer ID format' });
    const count = await Factory.countDocuments({ buyer: req.params.id });
    if (count > 0) return res.status(409).json({ success: false, message: `Cannot delete — buyer has ${count} linked record(s)` });
    const buyer = await Buyer.findByIdAndDelete(req.params.id);
    if (!buyer) return res.status(404).json({ success: false, message: 'Buyer not found' });
    res.json({ success: true, message: `Buyer "${buyer.name}" deleted` });
  } catch (err) { next(err); }
};
