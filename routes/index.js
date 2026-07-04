const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');

router.use('/auth', require('./authRoutes'));
router.use('/merchants', protect, require('./merchantMasterRoutes'));
router.use('/buyers', protect, require('./buyerRoutes'));
router.use('/merchant', protect, require('./merchantRoutes'));
router.use('/merchant-transactions', protect, require('./merchantTransactionRoutes'));
router.use('/merchant-transactions/:txnId/payments', protect, require('./merchantPaymentRoutes'));
router.use('/labor', protect, require('./laborRoutes'));
router.use('/factory', protect, require('./factoryRoutes'));
router.use('/payments', protect, require('./paymentRoutes'));
router.use('/dashboard', protect, require('./dashboardRoutes'));
router.use('/users', protect, require('./userRoutes'));

module.exports = router;
