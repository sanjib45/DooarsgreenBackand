/**
 * Date-range helpers for India (IST, UTC+05:30).
 *
 * Problem this solves:
 *   - Clients send calendar days as `YYYY-MM-DD` (no time / no zone).
 *   - `new Date('2026-07-16')` is UTC midnight.
 *   - Mixing that with `setHours()` (server-local) or `setUTCHours()`
 *     shifts the window and drops "today" rows for IST users.
 *
 * Rule: a business day filter always means the full IST calendar day.
 */

const IST_OFFSET = '+05:30';

/**
 * Build inclusive Mongo date filter from optional YYYY-MM-DD strings.
 * @param {string|undefined} startDate
 * @param {string|undefined} endDate
 * @returns {{ $gte?: Date, $lte?: Date } | null}
 */
function buildDayRangeFilter(startDate, endDate) {
  if (!startDate && !endDate) return null;

  const filter = {};
  if (startDate) {
    filter.$gte = startOfDayIST(startDate);
  }
  if (endDate) {
    filter.$lte = endOfDayIST(endDate);
  }
  return filter;
}

/** @param {string} ymd YYYY-MM-DD */
function startOfDayIST(ymd) {
  const day = normalizeYmd(ymd);
  return new Date(`${day}T00:00:00.000${IST_OFFSET}`);
}

/** @param {string} ymd YYYY-MM-DD */
function endOfDayIST(ymd) {
  const day = normalizeYmd(ymd);
  return new Date(`${day}T23:59:59.999${IST_OFFSET}`);
}

/**
 * Accepts YYYY-MM-DD or an ISO datetime; returns YYYY-MM-DD for day math.
 * @param {string} value
 */
function normalizeYmd(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('Date value must be a string');
  }
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // ISO / datetime-local → take the calendar date part the client intended
  const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  // Fallback: format in IST so server TZ does not matter
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

module.exports = {
  buildDayRangeFilter,
  startOfDayIST,
  endOfDayIST,
  normalizeYmd,
};
