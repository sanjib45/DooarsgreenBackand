const { body } = require('express-validator');

const PAYMENT_TYPES = ['Salary', 'Advance', 'Bonus', 'Supplier', 'Other'];
const STATUSES = ['Pending', 'Completed', 'Failed'];

exports.createRules = [
  body('payeeName').trim().notEmpty().withMessage('Payee name is required'),
  body('paymentType').notEmpty().isIn(PAYMENT_TYPES).withMessage('Invalid payment type'),
  body('amount').isFloat({ min: 0 }).withMessage('Amount must be positive'),
  body('paymentDate').optional().isISO8601().withMessage('Valid payment date required'),
  body('status').optional().isIn(STATUSES).withMessage('Invalid status'),
  body('referenceId').optional().trim(),
];

exports.updateRules = [
  body('payeeName').optional().trim().notEmpty(),
  body('paymentType').optional().isIn(PAYMENT_TYPES),
  body('amount').optional().isFloat({ min: 0 }),
  body('status').optional().isIn(STATUSES),
];
