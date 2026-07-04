const router = require('express').Router();
const ctrl = require('../controllers/factoryController');
const { createRules, updateRules, paymentRules } = require('../validators/factoryValidator');

router.get('/stats', ctrl.getStats);
router.route('/').get(ctrl.getAll).post(createRules, ctrl.create);
router.route('/:id').get(ctrl.getById).put(updateRules, ctrl.update).delete(ctrl.remove);
router.post('/:id/payments', paymentRules, ctrl.addPayment);
router.delete('/:id/payments/:paymentId', ctrl.removePayment);

module.exports = router;
