const { body } = require('express-validator');

exports.createRules = [
  body('name')
    .trim()
    .notEmpty().withMessage('Merchant name is required')
    .isLength({ max: 100 }).withMessage('Name cannot exceed 100 characters'),
  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .isLength({ min: 6, max: 15 }).withMessage('Phone must be 6–15 characters'),
  body('address')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 }).withMessage('Address cannot exceed 200 characters'),
  body('notes')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 500 }).withMessage('Notes cannot exceed 500 characters'),
];

exports.updateRules = [
  body('name')
    .optional()
    .trim()
    .notEmpty().withMessage('Name cannot be empty')
    .isLength({ max: 100 }),
  body('phone')
    .optional()
    .trim()
    .isLength({ min: 6, max: 15 }).withMessage('Phone must be 6–15 characters'),
  body('address')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 }),
  body('notes')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 500 }),
];
