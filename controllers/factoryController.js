const Factory = require('../models/Factory');
const { validationResult } = require('express-validator');

// GET /api/factory — list all with optional search/pagination
exports.getAll = async (req, res) => {
  try {
    const { search, startDate, endDate, sort = '-date', page = 1, limit = 50 } = req.query;
    const filter = {};
    if (search) filter.buyerName = { $regex: search, $options: 'i' };

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) {
        const ed = new Date(endDate);
        ed.setUTCHours(23, 59, 59, 999);
        filter.date.$lte = ed;
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      Factory.find(filter).sort(sort).skip(skip).limit(parseInt(limit)),
      Factory.countDocuments(filter),
    ]);
    res.json({ success: true, data: items, pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// GET /api/factory/stats
exports.getStats = async (req, res, next) => {
  try {
    const result = await Factory.aggregate([
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

    // Payments are embedded — still need to load for totals, but limit fields
    const paymentAgg = await Factory.aggregate([
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


// GET /api/factory/:id
exports.getById = async (req, res) => {
  try {
    const item = await Factory.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Sale record not found' });
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// POST /api/factory
exports.create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const item = await Factory.create(req.body);
    res.status(201).json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// PUT /api/factory/:id
exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const item = await Factory.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ success: false, message: 'Sale record not found' });
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// DELETE /api/factory/:id
exports.remove = async (req, res) => {
  try {
    const item = await Factory.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Sale record not found' });
    res.json({ success: true, message: 'Sale record deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// POST /api/factory/:id/payments — add a payment entry to a sale record
exports.addPayment = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const item = await Factory.findById(req.params.id);
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

// DELETE /api/factory/:id/payments/:paymentId — remove a specific payment
exports.removePayment = async (req, res) => {
  try {
    const item = await Factory.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Sale record not found' });

    const paymentIndex = item.payments.findIndex(p => p._id.toString() === req.params.paymentId);
    if (paymentIndex === -1) return res.status(404).json({ success: false, message: 'Payment not found' });

    item.payments.splice(paymentIndex, 1);
    await item.save();
    res.json({ success: true, data: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
