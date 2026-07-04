const express  = require('express');
const router   = express.Router();
const ctrl     = require('../controllers/dashboardController');

// GET /api/dashboard
router.get('/', ctrl.getDashboard);

module.exports = router;
