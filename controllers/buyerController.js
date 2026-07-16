const Buyer   = require('../models/Buyer');
const Factory = require('../models/Factory');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// GET /api/buyers/search?q= — SCOPED by createdBy
exports.search = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { q = '' } = req.query;
    const regex = q.trim() ? new RegExp(q.trim(), 'i') : /.*/;
    const results = await Buyer.find({ createdBy: userId, $or: [{ name: regex }, { phone: regex }] })
      .sort('name').limit(15).lean();
    res.json({ success: true, data: results });
  } catch (err) { next(err); }
};

// GET /api/buyers — SCOPED by createdBy
exports.getAll = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { search, sort = 'name', page = 1, limit = 50 } = req.query;
    const filter = { createdBy: userId };
    if (search) { const r = new RegExp(search.trim(), 'i'); filter.$or = [{ name: r }, { phone: r }]; }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      Buyer.find(filter).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      Buyer.countDocuments(filter),
    ]);
    res.json({ success: true, data: items, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) { next(err); }
};

// GET /api/buyers/:id — SCOPED by createdBy
exports.getById = async (req, res, next) => {
  try {
    const userId = req.user._id;
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid buyer ID format' });
    const buyer = await Buyer.findOne({ _id: req.params.id, createdBy: userId }).lean();
    if (!buyer) return res.status(404).json({ success: false, message: 'Buyer not found' });
    const stats = await Factory.aggregate([
      { $match: { buyer: buyer._id, createdBy: userId } },
      { $group: { _id: null, totalRecords: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' }, totalDue: { $sum: '$due' } } },
    ]);
    res.json({ success: true, data: { ...buyer, stats: stats[0] || { totalRecords: 0, totalAmount: 0, totalDue: 0 } } });
  } catch (err) { next(err); }
};

// POST /api/buyers — findOrCreate — SCOPED by createdBy
// Phone uniqueness is per-user, not global
exports.findOrCreate = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const userId = req.user._id;
    const { name, phone, address, notes } = req.body;
    const existing = await Buyer.findOne({ phone: phone.trim(), createdBy: userId });
    if (existing) {
      if (name && name.trim() !== existing.name) { existing.name = name.trim(); await existing.save(); }
      return res.status(200).json({ success: true, data: existing, isNew: false, message: 'Existing buyer returned' });
    }
    if (/^(NO-PHONE-|LEGACY)/i.test(String(phone).trim())) {
      return res.status(400).json({
        success: false,
        message: 'Placeholder phone numbers are not allowed. Enter a real phone number.',
      });
    }
    const buyer = await Buyer.create({
      createdBy: userId,
      name: name.trim(),
      phone: phone.trim(),
      address: address?.trim() || '',
      notes: notes?.trim() || '',
    });
    res.status(201).json({ success: true, data: buyer, isNew: true, message: 'New buyer created' });
  } catch (err) { next(err); }
};

// PUT /api/buyers/:id — SCOPED by createdBy
exports.update = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const userId = req.user._id;
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid buyer ID format' });
    const buyer = await Buyer.findOneAndUpdate(
      { _id: req.params.id, createdBy: userId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!buyer) return res.status(404).json({ success: false, message: 'Buyer not found' });
    // Update denormalized buyerName in factory records (scoped)
    await Factory.updateMany({ buyer: buyer._id, createdBy: userId }, { $set: { buyerName: buyer.name } });
    res.json({ success: true, data: buyer });
  } catch (err) { next(err); }
};

// DELETE /api/buyers/:id — SCOPED by createdBy
exports.remove = async (req, res, next) => {
  try {
    const userId = req.user._id;
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid buyer ID format' });
    const count = await Factory.countDocuments({ buyer: req.params.id, createdBy: userId });
    if (count > 0) return res.status(409).json({ success: false, message: `Cannot delete — buyer has ${count} linked record(s)` });
    const buyer = await Buyer.findOneAndDelete({ _id: req.params.id, createdBy: userId });
    if (!buyer) return res.status(404).json({ success: false, message: 'Buyer not found' });
    res.json({ success: true, message: `Buyer "${buyer.name}" deleted` });
  } catch (err) { next(err); }
};
