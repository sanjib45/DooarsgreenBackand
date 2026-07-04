const router = require('express').Router();
const { 
  getUserProfile, 
  updateUserProfile, 
  changePassword 
} = require('../controllers/userController');
const { updateProfileRules, changePasswordRules } = require('../validators/userValidator');

router.get('/me', getUserProfile);
router.put('/me', updateProfileRules, updateUserProfile);
router.put('/change-password', changePasswordRules, changePassword);

module.exports = router;
