const router = require('express').Router();
const ctrl   = require('../controllers/laborController');
const { createRules, updateRules } = require('../validators/laborValidator');

router.get('/stats', ctrl.getStats);
router.route('/')
  .get(ctrl.getAll)
  .post(createRules, ctrl.create);

router.route('/:id')
  .get(ctrl.getById)
  .put(updateRules, ctrl.update)
  .delete(ctrl.remove);

// Toggle payment status: Due → Paid → Due
router.patch('/:id/pay', ctrl.togglePay);

module.exports = router;
