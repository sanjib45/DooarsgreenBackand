const MerchantTransaction = require('../models/MerchantTransaction');
const MerchantPayment     = require('../models/MerchantPayment');
const Merchant            = require('../models/Merchant');
const { validationResult } = require('express-validator');

// ── Utility ───────────────────────────────────────────────────────────────────
function genTxnId() {
  return 'TXN-' + Date.now().toString().slice(-7) + Math.floor(Math.random() * 9 + 1);
}

/**
 * GET /api/merchant-transactions
 * Combined AND filter support — ALL QUERIES SCOPED BY createdBy
 *   search    – partial case-insensitive match on merchantName OR merchantPhone
 *   phone     – explicit phone filter (looks up Merchant, then filters by merchantId)
 *   teaType   – exact match
 *   startDate / endDate – inclusive date range
 */
exports.getAll = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      merchantName, teaType, search, phone,
      sort = '-transactionDate',
      page = 1, limit = 20,
      startDate, endDate,
    } = req.query;

    // Always scope by user
    const andConditions = [{ createdBy: userId }];

    // ── Tea type filter ──────────────────────────────────────────────────────
    if (teaType && teaType.trim()) {
      andConditions.push({ teaType });
    }

    // ── Merchant name filter (explicit) ──────────────────────────────────────
    if (merchantName && merchantName.trim()) {
      andConditions.push({
        merchantName: {
          $regex: merchantName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i',
        },
      });
    }

    // ── Combined search: name OR phone ───────────────────────────────────────
    if (search && search.trim()) {
      const searchRegex = new RegExp(
        search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'
      );

      // Find merchants whose phone matches (scoped to user)
      const matchedMerchants = await Merchant.find({ phone: searchRegex, createdBy: userId }).select('_id').lean();
      const merchantIds = matchedMerchants.map(m => m._id);

      const orClauses = [
        { merchantName: searchRegex },
        { merchantPhone: searchRegex },
      ];
      if (merchantIds.length > 0) {
        orClauses.push({ merchant: { $in: merchantIds } });
      }

      andConditions.push({ $or: orClauses });
    }

    // ── Explicit phone filter ────────────────────────────────────────────────
    if (phone && phone.trim()) {
      const phoneRegex = new RegExp(
        phone.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'
      );
      const matchedByPhone = await Merchant.find({ phone: phoneRegex, createdBy: userId }).select('_id').lean();
      const ids = matchedByPhone.map(m => m._id);

      if (ids.length > 0) {
        andConditions.push({
          $or: [
            { merchant: { $in: ids } },
            { merchantPhone: phoneRegex },
          ],
        });
      } else {
        // No merchant found with this phone — short circuit
        return res.json({
          success: true,
          data: [],
          pagination: { total: 0, page: parseInt(page), pages: 0 },
        });
      }
    }

    // ── Date range filter ────────────────────────────────────────────────────
    if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.$lte = end;
      }
      andConditions.push({ transactionDate: dateFilter });
    }

    const filter = { $and: andConditions };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      MerchantTransaction.find(filter).sort(sort).skip(skip).limit(parseInt(limit)).lean(),
      MerchantTransaction.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error('[merchantTransactionController.getAll]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/merchant-transactions/stats ──────────────────────────────────────
// SCOPED: all aggregations filtered by createdBy
exports.getStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const [summary, byType, recent] = await Promise.all([
      MerchantTransaction.aggregate([
        { $match: { createdBy: userId } },
        {
          $group: {
            _id: null,
            totalTransactions: { $sum: 1 },
            totalGrossQty: { $sum: '$grossQty' },
            totalNetQty: { $sum: '$netQty' },
            totalGrossAmount: { $sum: '$grossAmount' },
            totalLaborCharges: { $sum: '$laborCharges' },
            totalAdvance: { $sum: '$advancePayment' },
            totalBalance: { $sum: '$balance' },
          },
        },
      ]),
      MerchantTransaction.aggregate([
        { $match: { createdBy: userId } },
        { $group: { _id: '$teaType', count: { $sum: 1 }, totalQty: { $sum: '$netQty' }, totalAmount: { $sum: '$finalPayable' } } },
        { $sort: { totalAmount: -1 } },
      ]),
      MerchantTransaction.find({ createdBy: userId }).sort('-transactionDate').limit(5).select('transactionId merchantName netQty finalPayable transactionDate'),
    ]);

    res.json({
      success: true,
      data: {
        summary: summary[0] || {
          totalTransactions: 0, totalGrossQty: 0, totalNetQty: 0,
          totalGrossAmount: 0, totalLaborCharges: 0, totalAdvance: 0, totalBalance: 0,
        },
        byType,
        recent,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/merchant-transactions/:id ────────────────────────────────────────
// SCOPED: only returns if transaction belongs to the logged-in user
exports.getById = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await MerchantTransaction.findOne({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Transaction not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/merchant-transactions ───────────────────────────────────────────
// SCOPED: stamps createdBy on creation
exports.create = async (req, res) => {
  // Auto-generate transactionId if not provided
  if (!req.body.transactionId) {
    req.body.transactionId = genTxnId();
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const userId = req.user._id;

    // ── Auto-link or auto-create Merchant Master ──
    let mId = req.body.merchant || req.body.merchantId;
    if (!mId && req.body.merchantPhone) {
      const phoneClean = req.body.merchantPhone.trim();
      let merchant = await require('../models/Merchant').findOne({ phone: phoneClean, createdBy: userId });
      if (!merchant) {
        merchant = await require('../models/Merchant').create({
          createdBy: userId,
          name: req.body.merchantName.trim(),
          phone: phoneClean,
        });
      }
      mId = merchant._id;
    }
    if (mId) req.body.merchant = mId;

    // Inject calculated fields before save (pre-save hook also does this, double-safe)
    const calc = MerchantTransaction.computeFields(req.body);
    const item = await MerchantTransaction.create({ ...req.body, ...calc, createdBy: userId });
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Transaction ID already exists' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/merchant-transactions/:id ────────────────────────────────────────────────────
// SCOPED: only updates if transaction belongs to the logged-in user
exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const userId = req.user._id;
    // Fetch existing doc so we can fill in any fields the request doesn't touch
    const existing = await MerchantTransaction.findOne({ _id: req.params.id, createdBy: userId }).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Transaction not found' });

    // Merge existing values + incoming changes, then recalculate all derived fields
    const merged = { ...existing, ...req.body };

    // ── Auto-link or auto-create Merchant Master if missing ──
    let mId = merged.merchant || merged.merchantId;
    if (!mId && merged.merchantPhone) {
      const phoneClean = merged.merchantPhone.trim();
      let merchant = await require('../models/Merchant').findOne({ phone: phoneClean, createdBy: userId });
      if (!merchant) {
        merchant = await require('../models/Merchant').create({
          createdBy: userId,
          name: merged.merchantName.trim(),
          phone: phoneClean,
        });
      }
      merged.merchant = merchant._id;
      req.body.merchant = merchant._id; // Ensure it gets updated in DB
    }

    const calc   = MerchantTransaction.computeFields(merged);

    // ── Explicitly compute balance ─────────────────────────────────────────
    const payments  = await MerchantPayment.find({ transaction: req.params.id, createdBy: userId }).lean();
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const balance   = Math.round((calc.finalPayable - totalPaid) * 100) / 100;

    const item = await MerchantTransaction.findOneAndUpdate(
      { _id: req.params.id, createdBy: userId },
      { ...req.body, ...calc, balance },   // balance is always explicit here
      { new: true, runValidators: true }
    );

    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/merchant-transactions/:id ─────────────────────────────────────
// SCOPED: only deletes if transaction belongs to the logged-in user
exports.remove = async (req, res) => {
  try {
    const userId = req.user._id;
    const item = await MerchantTransaction.findOneAndDelete({ _id: req.params.id, createdBy: userId });
    if (!item) return res.status(404).json({ success: false, message: 'Transaction not found' });

    // Also clean up related payments
    await MerchantPayment.deleteMany({ transaction: req.params.id, createdBy: userId });

    res.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
// ── POST /api/merchant-transactions/import ────────────────────────────────────
// Handles CSV file upload either for Preview (returns parsed data) or Direct Import
exports.importCsv = async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

  const csv = require('csv-parser');
  const { Readable } = require('stream');
  
  const results = [];
  const errors = [];
  const validRows = [];
  const isPreview = req.query.preview === 'true';

  const stream = Readable.from(req.file.buffer);

  stream
    .pipe(csv({
      mapHeaders: ({ header }) => header.trim().replace(/^[\uFEFF\u200B]+/, ''),
      mapValues: ({ value }) => typeof value === 'string' ? value.trim() : value
    }))
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      let rowIndex = 1; // accounting for header

      for (const row of results) {
        rowIndex++;
        try {
          if (!row.merchantName) throw new Error('merchantName is required');
          if (!row.teaType) throw new Error('teaType is required');
          if (!row.grossQty) throw new Error('grossQty is required');
          if (!row.ratePerKg) throw new Error('ratePerKg is required');

          const payload = {
            merchantName: row.merchantName,
            merchantPhone: row.merchantPhone || undefined,
            teaType: row.teaType || 'Green Tea',
            transactionDate: row.transactionDate ? new Date(row.transactionDate) : new Date(),
            grossQty: Number(row.grossQty),
            lessPercent: Number(row.lessPercent) || 0,
            fineLeaf: Number(row.fineLeaf) || 0,
            ratePerKg: Number(row.ratePerKg),
            labourHeadCount: Number(row.labourHeadCount) || 0,
            labourCharge: Number(row.labourCharge) || 0,
            advancePayment: Number(row.advancePayment) || 0,
            notes: row.notes || ''
          };

          if (isNaN(payload.grossQty) || payload.grossQty <= 0) throw new Error('Invalid grossQty');
          if (isNaN(payload.ratePerKg) || payload.ratePerKg <= 0) throw new Error('Invalid ratePerKg');

          validRows.push(payload);
        } catch (err) {
          errors.push({ row: rowIndex, error: err.message, data: row });
        }
      }

      // If just preview mode, return immediately
      if (isPreview) {
        return res.status(200).json({
          success: true,
          message: 'CSV parsed for preview',
          preview: validRows,
          errors
        });
      }

      // Otherwise, we do direct insertion (Fallback if they bypass preview)
      let insertedCount = 0;
      const userId = req.user._id;
      for (const payload of validRows) {
        try {
          // Auto-link/create Merchant Master
          let mId = undefined;
          if (payload.merchantPhone) {
            const phoneClean = payload.merchantPhone;
            let merchant = await require('../models/Merchant').findOne({ phone: phoneClean, createdBy: userId });
            if (!merchant) {
              merchant = await require('../models/Merchant').create({
                createdBy: userId,
                name: payload.merchantName,
                phone: phoneClean,
              });
            }
            mId = merchant._id;
          }
          if (mId) payload.merchant = mId;
          
          payload.transactionId = require('../utils/genTxnId')();
          const calc = MerchantTransaction.computeFields(payload);
          await MerchantTransaction.create({ ...payload, ...calc, createdBy: userId });
          insertedCount++;
        } catch(err) {
          errors.push({ error: err.message, type: 'DB_INSERT' });
        }
      }

      if (errors.length > 0) {
        return res.status(207).json({
          success: insertedCount > 0,
          message: insertedCount > 0 ? `Imported ${insertedCount} records with some errors.` : 'Invalid data in CSV',
          insertedCount,
          errors
        });
      }

      res.status(200).json({
        success: true,
        message: 'CSV imported successfully',
        insertedCount
      });
    });
};

// ── POST /api/merchant-transactions/import/confirm ────────────────────────────
// Accepts the confirmed JSON array from the preview screen
exports.importJsonConfirm = async (req, res) => {
  if (!req.user || !req.user._id) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const items = req.body.items;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Invalid payload: items array is required' });
  }

  const errors = [];
  let insertedCount = 0;
  const userId = req.user._id;

  for (const row of items) {
    try {
      let mId = undefined;
      if (row.merchantPhone) {
        let merchant = await require('../models/Merchant').findOne({ phone: row.merchantPhone, createdBy: userId });
        if (!merchant) {
          merchant = await require('../models/Merchant').create({
            createdBy: userId,
            name: row.merchantName,
            phone: row.merchantPhone,
          });
        }
        mId = merchant._id;
      }
      
      const payload = { ...row };
      // Ensure date is correctly instantiated
      payload.transactionDate = new Date(payload.transactionDate);
      if (mId) payload.merchant = mId;
      
      payload.transactionId = require('../utils/genTxnId')();
      const calc = MerchantTransaction.computeFields(payload);
      
      await MerchantTransaction.create({ ...payload, ...calc, createdBy: userId });
      insertedCount++;
    } catch(err) {
      errors.push(err.message);
    }
  }

  if (errors.length > 0) {
    return res.status(207).json({ success: insertedCount > 0, insertedCount, errors });
  }
  res.status(200).json({ success: true, message: 'Records confirmed & imported successfully', insertedCount });
};
