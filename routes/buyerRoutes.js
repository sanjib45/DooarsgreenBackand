const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/buyerController');
const { createRules, updateRules } = require('../validators/buyerValidator');
const { protect } = require('../middleware/auth');

router.use(protect);
router.get('/search', ctrl.search);
router.get('/',       ctrl.getAll);
router.get('/:id',    ctrl.getById);
router.post('/',      createRules, ctrl.findOrCreate);
router.put('/:id',    updateRules, ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
