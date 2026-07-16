/**
 * Shared cookie options for the refreshToken httpOnly cookie.
 *
 * Vercel (frontend) + Railway (API) are cross-site:
 *   - Production MUST use SameSite=None + Secure, or the browser
 *     will not send the cookie on axios refresh calls.
 *   - clearCookie MUST use the same path/sameSite/secure or the
 *     cookie is not removed in Chromium.
 */
function getRefreshCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure:   isProd,
    maxAge:   7 * 24 * 60 * 60 * 1000,
    path:     '/',
  };
}

/** Options for clearing the cookie (omit maxAge). */
function getClearRefreshCookieOptions() {
  const { httpOnly, sameSite, secure, path } = getRefreshCookieOptions();
  return { httpOnly, sameSite, secure, path };
}

module.exports = { getRefreshCookieOptions, getClearRefreshCookieOptions };
