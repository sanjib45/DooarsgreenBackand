const { body } = require('express-validator');

const PAYMENT_MODES = ['Cash', 'Online', 'Cheque'];

exports.createRules = [
  body('date').optional({ checkFalsy: true }).isISO8601().withMessage('Valid sale date required'),
  body('buyerName').trim().notEmpty().withMessage('Buyer name is required'),
  body('totalQuantity').isFloat({ min: 0.001 }).withMessage('Total quantity must be a positive number'),
  // lessPercentage is optional (defaults to 0); when present must be 0–100
  body('lessPercentage').optional({ checkFalsy: true }).isFloat({ min: 0, max: 100 }).withMessage('Less percentage must be between 0 and 100'),
  body('rate').isFloat({ min: 0.001 }).withMessage('Rate must be a positive number'),
  body('advance').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Advance must be a positive number'),
  // dueDate is optional; if provided must be ISO8601 — empty string is OK
  body('dueDate').optional({ checkFalsy: true }).isISO8601().withMessage('Valid due date required'),
  body('remarks').optional({ checkFalsy: true }).isString().isLength({ max: 500 }),
];

exports.updateRules = [
  body('date').optional({ checkFalsy: true }).isISO8601(),
  body('buyerName').optional().trim().notEmpty(),
  body('totalQuantity').optional().isFloat({ min: 0 }),
  body('lessPercentage').optional({ checkFalsy: true }).isFloat({ min: 0, max: 100 }),
  body('rate').optional().isFloat({ min: 0 }),
  body('advance').optional({ checkFalsy: true }).isFloat({ min: 0 }),
  body('dueDate').optional({ checkFalsy: true }).isISO8601(),
  body('remarks').optional({ checkFalsy: true }).isString().isLength({ max: 500 }),
];

exports.paymentRules = [
  body('date').optional({ checkFalsy: true }).isISO8601().withMessage('Valid payment date required'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Payment amount must be positive'),
  body('mode').isIn(PAYMENT_MODES).withMessage(`Payment mode must be one of: ${PAYMENT_MODES.join(', ')}`),
];
