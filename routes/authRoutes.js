const router = require('express').Router();
const {
  registerUser,
  loginUser,
  refreshToken,
  logoutUser,
  resetPassword,
} = require('../controllers/authController');

router.post('/register',       registerUser);
router.post('/login',          loginUser);
router.post('/refresh',        refreshToken);  // issues new accessToken using httpOnly cookie
router.post('/logout',         logoutUser);    // clears cookie + DB hash
router.post('/reset-password', resetPassword);

module.exports = router;
