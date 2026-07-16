const router = require('express').Router();
const {
  getAuthConfig,
  cookieCheck,
  registerUser,
  loginUser,
  refreshToken,
  logoutUser,
  resetPassword,
} = require('../controllers/authController');

router.get('/config',          getAuthConfig);   // public — register mode for UI
router.get('/cookie-check',    cookieCheck);     // public — post-deploy cookie probe
router.post('/register',       registerUser);
router.post('/login',          loginUser);
router.post('/refresh',        refreshToken);
router.post('/logout',         logoutUser);
router.post('/reset-password', resetPassword);

module.exports = router;
