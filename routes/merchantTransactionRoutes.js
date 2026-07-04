const express = require('express');
const router = express.Router();
const ctrl        = require('../controllers/merchantTransactionController');
const invoiceCtrl = require('../controllers/invoiceController');
const { createRules, updateRules } = require('../validators/merchantTransactionValidator');

// ── Static named routes must come BEFORE /:id ─────────────────────────────────
router.get('/stats', ctrl.getStats);

// Invoice routes (before /:id so 'invoice' is not captured as an id param)
router.get('/invoice/by-merchant-date', invoiceCtrl.generateInvoiceByMerchantDate); // ← Multi-txn invoice by merchant+date
router.get('/', ctrl.getAll);

// ── Param routes ───────────────────────────────────────────────────────────────
router.get('/:id/invoice', invoiceCtrl.generateInvoice);  // ← Single txn invoice
router.get('/:id', ctrl.getById);
router.post('/', createRules, ctrl.create);
router.put('/:id', updateRules, ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
