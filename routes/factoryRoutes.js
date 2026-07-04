const router = require('express').Router();
const ctrl = require('../controllers/factoryController');
const invoiceCtrl = require('../controllers/invoiceController');
const { createRules, updateRules, paymentRules } = require('../validators/factoryValidator');

router.get('/stats', ctrl.getStats);
router.route('/').get(ctrl.getAll).post(createRules, ctrl.create);

// ── Invoice routes — MUST be before /:id so 'invoice' is not captured as an id ──
router.get('/invoice/by-buyer', invoiceCtrl.generateFactoryInvoiceByBuyer);
router.get('/:id/invoice', invoiceCtrl.generateFactoryInvoice);

router.route('/:id').get(ctrl.getById).put(updateRules, ctrl.update).delete(ctrl.remove);
router.post('/:id/payments', paymentRules, ctrl.addPayment);
router.delete('/:id/payments/:paymentId', ctrl.removePayment);

module.exports = router;
