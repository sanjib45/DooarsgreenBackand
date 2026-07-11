const { body } = require('express-validator');

const TEA_TYPES = ['Green Tea', 'CTC', 'Other'];

exports.createRules = [
  body('merchantName').trim().notEmpty().withMessage('Merchant name is required'),
  body('teaType').notEmpty().isIn(TEA_TYPES).withMessage('Invalid tea type'),
  body('transactionDate').optional().isISO8601().withMessage('Valid date required'),
  body('grossQty').isFloat({ min: 0 }).withMessage('Gross quantity must be a positive number'),
  body('lessPercent').optional().isFloat({ min: 0, max: 100 }).withMessage('Less % must be between 0–100'),
  body('ratePerKg').isFloat({ min: 0 }).withMessage('Rate per kg must be a positive number'),
  body('labourHeadCount').optional().isInt({ min: 0 }).withMessage('Labour head count must be a non-negative integer'),
  body('labourCharge').optional().isFloat({ min: 0 }).withMessage('Labour charge must be positive'),
  body('advancePayment').optional().isFloat({ min: 0 }).withMessage('Advance payment must be positive'),
  body('notes').optional().isLength({ max: 500 }),
];

exports.updateRules = [
  body('merchantName').optional().trim().notEmpty(),
  body('teaType').optional().isIn(TEA_TYPES),
  body('transactionDate').optional().isISO8601(),
  body('grossQty').optional().isFloat({ min: 0 }),
  body('lessPercent').optional().isFloat({ min: 0, max: 100 }),
  body('ratePerKg').optional().isFloat({ min: 0 }),
  body('labourHeadCount').optional().isInt({ min: 0 }),
  body('labourCharge').optional().isFloat({ min: 0 }),
  body('advancePayment').optional().isFloat({ min: 0 }),
  body('notes').optional().isLength({ max: 500 }),
];
