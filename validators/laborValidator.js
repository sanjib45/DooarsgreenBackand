const { body } = require('express-validator');

const ROLES           = ['Plucker', 'Factory Worker', 'Supervisor', 'Maintenance', 'Other'];
const PAYMENT_STATUSES = ['Due', 'Paid'];

exports.createRules = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('role').notEmpty().isIn(ROLES).withMessage('Invalid role'),
  body('laborCharge').isFloat({ min: 0 }).withMessage('Labor charge must be a positive number'),
  body('joinDate').optional().isISO8601().withMessage('Valid join date required'),
  body('paymentStatus').optional().isIn(PAYMENT_STATUSES).withMessage('Invalid payment status'),
  body('notes').optional().trim().isLength({ max: 500 }),
];

exports.updateRules = [
  body('name').optional().trim().notEmpty(),
  body('role').optional().isIn(ROLES),
  body('laborCharge').optional().isFloat({ min: 0 }),
  body('joinDate').optional().isISO8601(),
  body('paymentStatus').optional().isIn(PAYMENT_STATUSES),
  body('notes').optional().trim().isLength({ max: 500 }),
];
