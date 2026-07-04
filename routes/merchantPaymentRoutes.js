const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to access :txnId
const { body } = require('express-validator');
const ctrl = require('../controllers/merchantPaymentController');

const paymentRules = [
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be greater than 0'),
  body('paymentDate').optional().isISO8601().withMessage('Valid date required'),
  body('paymentMode').optional().isIn(['Cash', 'Bank Transfer', 'Cheque', 'UPI', 'Other']),
  body('notes').optional().isLength({ max: 500 }),
];

router.get('/', ctrl.getForTransaction);
router.post('/', paymentRules, ctrl.create);
router.delete('/:payId', ctrl.remove);

module.exports = router;
