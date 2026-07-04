const { body } = require('express-validator');
const rules = [
  body('name').trim().notEmpty().withMessage('Buyer name is required').isLength({ max: 100 }),
  body('phone').trim().notEmpty().withMessage('Phone is required').isLength({ min: 6, max: 15 }).withMessage('Phone must be 6–15 chars'),
  body('address').optional({ checkFalsy: true }).trim().isLength({ max: 200 }),
  body('notes').optional({ checkFalsy: true }).trim().isLength({ max: 500 }),
];
exports.createRules = rules;
exports.updateRules = rules.map(r => r.optional());
