const { body } = require('express-validator');

const TEA_TYPES = ['Green Tea','CTC','Other'];

exports.createRules = [
  body('batchId').optional().trim().isLength({ min:3, max:20 }),
  body('name').trim().notEmpty().withMessage('Name required'),
  body('teaType').notEmpty().isIn(TEA_TYPES).withMessage('Invalid tea type'),
  body('quantity').isFloat({ min: 0 }).withMessage('Quantity must be positive'),
  body('pricePerUnit').isFloat({ min: 0 }).withMessage('Price must be positive'),
  body('harvestDate').isISO8601().withMessage('Valid harvest date required'),
];

exports.updateRules = [
  body('name').optional().trim().notEmpty(),
  body('teaType').optional().isIn(TEA_TYPES),
  body('quantity').optional().isFloat({ min: 0 }),
  body('pricePerUnit').optional().isFloat({ min: 0 }),
];
