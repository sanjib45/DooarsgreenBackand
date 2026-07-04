const express = require('express');
const router  = express.Router({ mergeParams: true }); // inherit :merchantId from parent
const ctrl    = require('../controllers/merchantAdvanceController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.route('/')
  .get(ctrl.getForMerchant)   // GET  /api/merchants/:merchantId/advances
  .post(ctrl.create);         // POST /api/merchants/:merchantId/advances

router.delete('/:advanceId', ctrl.remove); // DELETE /api/merchants/:merchantId/advances/:advanceId

module.exports = router;
