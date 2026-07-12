/**
 * invoiceController.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Generates printable PDF invoices (DOOARS GREEN FPO PAYMENT VOUCHER).
 *
 * FIXES in this version:
 *  ✅ ₹ symbol: use &#x20B9; HTML entity (safe across all PDF renderers)
 *  ✅ Table headers: all single-line with white-space:nowrap
 *  ✅ Column alignment: numbers right-aligned, text center/left
 *  ✅ Watermark: uses fixed positioning with pointer-events:none, no bg interference
 *  ✅ Puppeteer: production-safe, no hardcoded paths, supports local + Vercel/Railway
 *  ✅ Indian number formatting: en-IN locale with proper ₹ prefix
 */

const fs   = require('fs');
const path = require('path');
const MerchantTransaction = require('../models/MerchantTransaction');
const MerchantPayment     = require('../models/MerchantPayment');
const MerchantAdvance     = require('../models/MerchantAdvance');
const Merchant            = require('../models/Merchant');

// ── Logo: embed as base64 so it works regardless of server CWD ────────────────
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');
let LOGO_BASE64 = '';
try {
  const buf = fs.readFileSync(LOGO_PATH);
  LOGO_BASE64 = `data:image/png;base64,${buf.toString('base64')}`;
} catch (_) {
  // Logo file not found — invoice will render without it
}

// ── Font: embed Noto Sans as base64 so the ₹ glyph ALWAYS renders in PDFs ─────
// Serverless/minimal Linux containers (Vercel, Railway, @sparticuz/chromium)
// usually have NO system fonts installed. "Arial/Helvetica" then silently falls
// back to a generic sans-serif that often lacks the Indian Rupee glyph (U+20B9),
// so ₹ shows as blank/tofu in the exported PDF even though it works locally.
// Embedding the font directly in the HTML via a data: URI removes that
// dependency on the host machine entirely — it will always render, everywhere.
const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf');
let FONT_BASE64 = '';
try {
  const fontBuf = fs.readFileSync(FONT_PATH);
  FONT_BASE64 = `data:font/ttf;base64,${fontBuf.toString('base64')}`;
} catch (_) {
  // Font file not found — invoice will fall back to system fonts (₹ may not render)
}

// ── RUPEE SYMBOL — safe HTML entity ──────────────────────────────────────────
// &#x20B9; is the Unicode Indian Rupee sign — renders correctly in all PDF engines
const RS = '&#x20B9;';

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Format number in Indian locale (e.g. 1,23,456.78)
 * Returns '—' for null/undefined/NaN
 */
function fmt(n) {
  if (n === undefined || n === null || isNaN(Number(n))) return '&mdash;';
  return Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function fmtDate(d) {
  if (!d) return '&mdash;';
  return new Date(d).toLocaleDateString('en-IN', {
    day:   '2-digit',
    month: '2-digit',
    year:  'numeric',
  });
}

// Compact date for narrow table cells (dd/mm/yy) — prevents truncation
function fmtDateShort(d) {
  if (!d) return '&mdash;';
  return new Date(d).toLocaleDateString('en-IN', {
    day:   '2-digit',
    month: '2-digit',
    year:  '2-digit',
  });
}

function fmtDateLong(d) {
  if (!d) return '&mdash;';
  return new Date(d).toLocaleDateString('en-IN', {
    day:   'numeric',
    month: 'long',
    year:  'numeric',
  });
}

/** Convert a number to Indian number-words for the balance line */
function numberToWords(num) {
  const ones = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
                 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
                 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
  const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];

  if (!num || isNaN(Number(num))) return 'RUPEES ZERO ONLY';
  if (Number(num) === 0) return 'RUPEES ZERO ONLY';

  function convert(n) {
    if (n < 20)      return ones[n];
    if (n < 100)     return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    if (n < 1000)    return ones[Math.floor(n / 100)] + ' HUNDRED' + (n % 100 ? ' ' + convert(n % 100) : '');
    if (n < 100000)  return convert(Math.floor(n / 1000)) + ' THOUSAND' + (n % 1000 ? ' ' + convert(n % 1000) : '');
    if (n < 10000000) return convert(Math.floor(n / 100000)) + ' LAKH' + (n % 100000 ? ' ' + convert(n % 100000) : '');
    return convert(Math.floor(n / 10000000)) + ' CRORE' + (n % 10000000 ? ' ' + convert(n % 10000000) : '');
  }

  const absNum = Math.abs(Math.round(num));
  const words  = convert(absNum).trim();
  return (num < 0 ? 'MINUS ' : '') + 'RUPEES ' + words + ' ONLY';
}

// ── Generate invoice number from transactionId ────────────────────────────────
function invoiceNumber(txn) {
  if (txn.transactionId) {
    const digits = txn.transactionId.replace(/\D/g, '');
    return String(digits).slice(-5).padStart(5, '0');
  }
  return '00001';
}

// ── SHARED CSS — injected into every invoice template ────────────────────────
const SHARED_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;700;800;900&display=swap');

  /* ── Reset & Base ── */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Noto Sans', Arial, Helvetica, sans-serif;
    font-size: 10.5px;
    color: #222;
    background: #fff;
    padding: 14px 18px;
    position: relative;
  }

  /* ── Watermark: fixed behind all content, never blocks row bg ── */
  .watermark-bg {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-30deg);
    width: 420px;
    height: 420px;
    opacity: 0.07;
    z-index: 0;
    pointer-events: none;
  }
  .watermark-bg img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* ── All content sits above watermark ── */
  .header, .billed-section, .table-wrapper,
  .balance-row, .amount-words, .quality-note,
  .footer-company, .signatures, .summary-box {
    position: relative;
    z-index: 1;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding-bottom: 10px;
    border-bottom: 2.5px solid #2d6a2d;
    margin-bottom: 12px;
  }
  .logo-img {
    width: 80px;
    height: 80px;
    object-fit: contain;
  }
  .logo-placeholder {
    width: 80px;
    height: 80px;
    background: #2d6a2d;
    color: #fff;
    font-weight: bold;
    font-size: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    border-radius: 4px;
    line-height: 1.3;
  }
  .header-center { flex: 1; text-align: center; padding: 0 12px; }
  .company-main  {
    font-size: 16px;
    font-weight: 900;
    color: #2d6a2d;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .company-sub {
    font-size: 9.5px;
    color: #555;
    margin-top: 3px;
    font-weight: 600;
  }
  .header-right { text-align: right; min-width: 160px; }
  .voucher-title {
    font-size: 13px;
    font-weight: 900;
    color: #2d6a2d;
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }
  .invoice-date {
    font-size: 11px;
    color: #444;
    margin: 3px 0;
  }
  .invoice-no {
    font-size: 12px;
    font-weight: 800;
    color: #1a1a1a;
    text-transform: uppercase;
  }

  /* ── Billed To ── */
  .billed-section { margin-bottom: 12px; }
  .billed-label {
    font-size: 11px;
    font-weight: 900;
    color: #2d6a2d;
    text-transform: uppercase;
    margin-bottom: 3px;
  }
  .billed-name {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    color: #111;
  }
  .billed-detail { font-size: 10.5px; color: #444; }

  /* ── Divider ── */
  hr { border: none; border-top: 1.5px solid #2d6a2d; margin: 8px 0; }

  /* ── Table ── */
  .table-wrapper { overflow-x: auto; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10.5px;
    table-layout: fixed;
  }
  colgroup col { /* override per-table */  }

  thead tr { background: #2d6a2d; color: #fff; }
  thead th {
    padding: 6px 2px;
    text-align: center;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 8.3px;
    letter-spacing: 0;
    line-height: 1.2;
    white-space: nowrap;       /* CRITICAL: header stays on ONE line — labels are kept short enough to fit */
    overflow: hidden;          /* safety net only; short labels + sized columns mean this should never trigger */
    text-overflow: clip;
  }
  /* Right-align numeric headers */
  thead th.num { text-align: right; padding-right: 6px; }

  tbody td {
    padding: 5px 4px;
    text-align: center;
    border-bottom: 1px solid #e8e8e8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  tbody td.num  { text-align: right; padding-right: 6px; }
  tbody td.left { text-align: left;  padding-left:  6px; }

  .row-even { background: #fff; }
  .row-odd  { background: #f0f7f0; }

  /* Total row */
  .total-row td {
    background: #e8f5e8;
    font-weight: 700;
    border-top: 2px solid #2d6a2d;
    border-bottom: 2px solid #2d6a2d;
    color: #1a1a1a;
  }
  .total-amount {
    color: #1a5c1a;
    font-size: 11px;
  }

  /* ── Balance Banner ── */
  .balance-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    background: #fff8ec;
    border: 1.5px solid #e8c95a;
    border-radius: 4px;
    margin: 8px 0;
  }
  .balance-label {
    font-weight: 800;
    font-size: 11px;
    color: #b8860b;
    text-transform: uppercase;
  }
  .balance-value-positive { font-weight: 900; font-size: 12px; color: #1a5c1a; }
  .balance-value-negative { font-weight: 900; font-size: 12px; color: #c0392b; }

  /* ── Amount in Words ── */
  .amount-words {
    background: #f5fff5;
    border: 1.5px solid #2d6a2d;
    border-radius: 4px;
    padding: 7px 10px;
    font-size: 11px;
    font-weight: 800;
    color: #1a4f1a;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    margin: 8px 0;
  }

  /* ── Quality Note ── */
  .quality-note {
    margin: 10px 0;
    padding: 8px 10px;
    background: #fffdf5;
    border-left: 3px solid #e8c95a;
    font-size: 10px;
  }
  .quality-note p { font-weight: 700; margin-bottom: 4px; }
  .quality-note ul { margin-left: 14px; margin-bottom: 6px; }
  .quality-note li { margin-bottom: 2px; }
  .quality-note .gratitude { font-style: italic; color: #555; line-height: 1.4; }

  /* ── Footer ── */
  .footer-company {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1.5px solid #2d6a2d;
  }
  .footer-company .co-name {
    font-size: 12px;
    font-weight: 900;
    color: #2d6a2d;
    text-transform: uppercase;
  }
  .footer-company .contact { font-size: 9.5px; color: #555; margin-top: 1px; }

  /* ── Signatures ── */
  .signatures {
    display: flex;
    justify-content: space-between;
    margin-top: 36px;
  }
  .sig-block { text-align: center; width: 180px; }
  .sig-line  { border-top: 1.5px solid #333; margin-bottom: 4px; }
  .sig-label { font-size: 10px; color: #333; font-weight: 600; }

  /* ── Summary box (factory invoices) ── */
  .summary-box { margin: 12px 0; display: flex; flex-direction: column; gap: 5px; }
  .summary-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 10px;
    border-radius: 4px;
  }
  .summary-row.gross   { background: #f0f7f0; border: 1px solid #2d6a2d; }
  .summary-row.advance { background: #fff8ec; border: 1px solid #e8c95a; }
  .summary-label { font-weight: 700; font-size: 10.5px; color: #333; text-transform: uppercase; }
  .summary-value { font-weight: 900; font-size: 12px; }

  @media print {
    body { padding: 8px 12px; }
  }
`;

// ── Build single-transaction invoice HTML ─────────────────────────────────────
function buildInvoiceHtml(txn, payments) {
  const logoImg = LOGO_BASE64
    ? `<img src="${LOGO_BASE64}" alt="Dooars Green FPO Logo" class="logo-img" />`
    : `<div class="logo-placeholder">DOOARS<br>GREEN<br>FPO</div>`;

  const totalPaid   = payments.reduce((s, p) => s + p.amount, 0);
  const balance     = txn.balance;
  const invoiceNo   = invoiceNumber(txn);
  const invoiceDate = fmtDateLong(txn.transactionDate);
  const isNegBal    = balance < 0;

  // Payment rows
  const paymentRows = payments.length === 0
    ? `<tr><td colspan="13" style="text-align:center;padding:12px;color:#888;">No payment records</td></tr>`
    : payments.map((p, i) => `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td class="left">${fmtDateShort(p.paymentDate)}</td>
        <td colspan="9" style="text-align:right;padding-right:10px;font-style:italic;color:#555;">
          Payment (${p.paymentMode || 'Cash'})${p.notes ? ' &middot; ' + p.notes : ''}
        </td>
        <td class="num">&mdash;</td>
        <td class="num">&mdash;</td>
        <td class="num" style="color:#1a5c1a;font-weight:bold;">-${RS}${fmt(p.amount)}</td>
      </tr>`).join('');

  const txnRow = `
    <tr class="row-even">
      <td class="left">${fmtDateShort(txn.transactionDate)}</td>
      <td class="num">${fmt(txn.grossQty)}</td>
      <td class="num">${txn.lessPercent > 0 ? `${txn.lessPercent}%` : '&mdash;'}</td>
      <td class="num">${fmt(txn.lessQty)}</td>
      <td class="num"><strong>${fmt(txn.netQty)}</strong></td>
      <td class="num">${RS}${fmt(txn.ratePerKg)}</td>
      <td class="num">${txn.labourHeadCount > 0 ? txn.labourHeadCount : '&mdash;'}</td>
      <td class="num">${txn.labourCharge > 0 ? `${RS}${fmt(txn.labourCharge)}` : '&mdash;'}</td>
      <td class="num" style="color:#c0392b;">${txn.labourAmount > 0 ? `-${RS}${fmt(txn.labourAmount)}` : '&mdash;'}</td>
      <td class="num">${RS}${fmt(txn.grossAmount)}</td>
      <td class="num">${RS}${fmt(txn.netPayable)}</td>
      <td class="num">${txn.advancePayment > 0 ? `${RS}${fmt(txn.advancePayment)}` : '&mdash;'}</td>
      <td class="num"><strong>${RS}${fmt(txn.finalPayable)}</strong></td>
    </tr>`;

  const totalRow = `
    <tr class="total-row">
      <td class="left"><strong>TOTAL</strong></td>
      <td class="num">${fmt(txn.grossQty)}</td>
      <td class="num">&mdash;</td>
      <td class="num">${fmt(txn.lessQty)}</td>
      <td class="num"><strong>${fmt(txn.netQty)}</strong></td>
      <td class="num">&mdash;</td>
      <td class="num">${txn.labourHeadCount > 0 ? txn.labourHeadCount : '&mdash;'}</td>
      <td class="num">&mdash;</td>
      <td class="num" style="color:#c0392b;">${txn.labourAmount > 0 ? `-${RS}${fmt(txn.labourAmount)}` : '&mdash;'}</td>
      <td class="num">${RS}${fmt(txn.grossAmount)}</td>
      <td class="num">${RS}${fmt(txn.netPayable)}</td>
      <td class="num">${txn.advancePayment > 0 ? `${RS}${fmt(txn.advancePayment)}` : '&mdash;'}</td>
      <td class="num total-amount">${RS}${fmt(txn.finalPayable)}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>DOOARS GREEN FPO  - Payment Voucher</title>
<style>${SHARED_CSS}</style>
</head>
<body>

<!-- Watermark -->
${LOGO_BASE64 ? `<div class="watermark-bg"><img src="${LOGO_BASE64}" alt="watermark" /></div>` : ''}

<!-- Header -->
<div class="header">
  <div class="logo-col">${logoImg}</div>
  <div class="header-center">
    <div class="company-main" style="line-height:1.2;">DOOARS GREEN FPO<br><span style="font-size:12px;">MCSL</span></div>
    <div class="company-sub" style="line-height:1.4;">GST NO - 19AAIAD3091R1ZO<br>REG NO- 7/Jal 2022-23 Dated 20.12.2022</div>
  </div>
  <div class="header-right">
    <div class="voucher-title">Payment Voucher</div>
    <div class="invoice-date">${invoiceDate}</div>
    <div class="invoice-no">No. ${invoiceNo}</div>
  </div>
</div>

<!-- Billed To -->
<div class="billed-section">
  <div class="billed-label">Billed To:</div>
  <div class="billed-name">${txn.merchantName || '&mdash;'}</div>
  <div class="billed-detail">V.NO &ndash; ${txn.transactionId || '&mdash;'}</div>
  <div class="billed-detail">DATE &ndash; ${fmtDate(txn.transactionDate)}</div>
</div>

<hr />

<!-- Transaction Table -->
<div class="table-wrapper">
  <table>
    <colgroup>
      <col style="width:8%">
      <col style="width:7%">
      <col style="width:6%">
      <col style="width:8%">
      <col style="width:7%">
      <col style="width:7%">
      <col style="width:6%">
      <col style="width:6%">
      <col style="width:6%">
      <col style="width:11%">
      <col style="width:8%">
      <col style="width:8%">
      <col style="width:12%">
    </colgroup>
    <thead>
      <tr>
        <th class="left">DATE</th>
        <th class="num">QTY</th>
        <th class="num">LESS%</th>
        <th class="num">L.KG</th>
        <th class="num">NET KG</th>
        <th class="num">RATE</th>
        <th class="num">L.CNT</th>
        <th class="num">L.RATE</th>
        <th class="num">L.COST</th>
        <th class="num">AMOUNT</th>
        <th class="num">NETPAY</th>
        <th class="num">ADV</th>
        <th class="num">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${txnRow}
      ${paymentRows}
      ${totalRow}
    </tbody>
  </table>
</div>

<!-- Balance -->
<div class="balance-row">
  <span class="balance-label">TOTAL FINAL AMOUNT:</span>
  <span class="${balance < 0 ? 'balance-value-negative' : 'balance-value-positive'}">${RS}${fmt(txn.finalPayable)}</span>
</div>

<!-- Amount in Words -->
<div class="amount-words">
  TOTAL AMOUNT &rarr; ${numberToWords(txn.finalPayable)}
</div>
${txn.advancePayment > 0 ? `
<div class="amount-words" style="background:#fdf5f5;border-color:#c0392b;color:#a93226;margin-top:5px;">
  TOTAL ADVANCE &rarr; ${numberToWords(txn.advancePayment)}
</div>` : ''}

<!-- Quality Note -->
<div class="quality-note">
  <p>Please note the following quality deductions:</p>
  <ul>
    <li>Hand plucking: 2% deduction per delivery</li>
    <li>Machine plucking: 4% deduction per delivery</li>
    <li>Rainy days: deduction varies based on leaf moisture at the time of collection</li>
  </ul>
  <p class="gratitude">
    We are grateful for the trust and cooperation of every Small Tea Grower in our community.<br />
    Your commitment to quality green leaves strengthens all of us &mdash; thank you for being a vital part of this journey together.
  </p>
</div>

<hr />

<!-- Footer -->
<div class="footer-company">
  <div class="co-name">DOOARS GREEN FPO</div>
  <div class="contact">Email &ndash; dooarsgreenfpo@gmail.com</div>
  <div class="contact">Cont &ndash; 9800415644, 8101507292, 8972495852, 8967829553</div>
</div>

<!-- Signatures -->
<div class="signatures">
  <div class="sig-block">
    <div class="sig-line"></div>
    <div class="sig-label">Authorized By</div>
  </div>
  <div class="sig-block">
    <div class="sig-line"></div>
    <div class="sig-label">Received By</div>
  </div>
</div>

</body>
</html>`;
}

// ── Controller 1: single transaction — SCOPED by createdBy ───────────────────
exports.generateInvoice = async (req, res) => {
  try {
    const userId = req.user._id;
    const { id } = req.params;
    const format  = (req.query.format || 'pdf').toLowerCase();

    const [txn, payments] = await Promise.all([
      MerchantTransaction.findOne({ _id: id, createdBy: userId }).lean(),
      MerchantPayment.find({ transaction: id, createdBy: userId }).sort('paymentDate').lean(),
    ]);

    if (!txn) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const html = buildInvoiceHtml(txn, payments);

    if (format === 'html') {
      return res.setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    }

    const buffer = await generatePdf(html);
    const safeFilename = `invoice-${txn.transactionId || id}-${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
    res.send(buffer);

  } catch (err) {
    console.error('[invoiceController.generateInvoice] Error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to generate invoice: ' + err.message });
  }
};

// ── Build multi-transaction HTML (merchant + date range) ──────────────────────
function buildMultiInvoiceHtml(merchantName, startDate, endDate, transactions, paymentsMap, standaloneAdvances, masterPayments = []) {
  const logoImg = LOGO_BASE64
    ? `<img src="${LOGO_BASE64}" alt="Dooars Green FPO Logo" class="logo-img" />`
    : `<div class="logo-placeholder">DOOARS<br>GREEN<br>FPO</div>`;

  const isSameDate  = startDate === endDate;
  const invoiceDate = isSameDate
    ? fmtDateLong(startDate)
    : `${fmtDateLong(startDate)} &ndash; ${fmtDateLong(endDate)}`;
  const dateStr = isSameDate
    ? fmtDate(startDate)
    : `${fmtDate(startDate)} to ${fmtDate(endDate)}`;

  // Summation across all transactions
  const totals = transactions.reduce((a, t) => ({
    grossQty:       a.grossQty       + (t.grossQty       || 0),
    lessQty:        a.lessQty        + (t.lessQty         || 0),
    grossAmount:    a.grossAmount    + (t.grossAmount     || 0),
    netPayable:     a.netPayable     + (t.netPayable      || 0),
    advancePayment: a.advancePayment + (t.advancePayment  || 0),
    finalPayable:   a.finalPayable   + (t.finalPayable    || 0),
    balance:        a.balance        + (t.balance          || 0),
  }), { grossQty: 0, lessQty: 0, grossAmount: 0, netPayable: 0, advancePayment: 0, finalPayable: 0, balance: 0 });

  const d = new Date(endDate || startDate);
  const invoiceNo = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;

  // Build rows
  const txnRows = transactions.map((t, i) => {
    const pmts = paymentsMap[t._id.toString()] || [];
    const paymentSubRows = pmts.map((p) => `
      <tr class="row-even" style="font-style:italic;color:#555;">
        <td class="left">${fmtDateShort(p.paymentDate)}</td>
        <td colspan="9" style="text-align:right;padding-right:10px;">
          Payment (${p.paymentMode || 'Cash'})${p.notes ? ' &middot; ' + p.notes : ''}
        </td>
        <td class="num">&mdash;</td>
        <td class="num">&mdash;</td>
        <td class="num" style="color:#1a5c1a;font-weight:bold;">-${RS}${fmt(p.amount)}</td>
      </tr>`).join('');

    return `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td class="left">${fmtDateShort(t.transactionDate)}</td>
        <td class="num">${fmt(t.grossQty)}</td>
        <td class="num">${t.lessPercent > 0 ? `${t.lessPercent}%` : '&mdash;'}</td>
        <td class="num">${fmt(t.lessQty)}</td>
        <td class="num"><strong>${fmt(t.netQty)}</strong></td>
        <td class="num">${RS}${fmt(t.ratePerKg)}</td>
        <td class="num">${t.labourHeadCount > 0 ? t.labourHeadCount : '&mdash;'}</td>
        <td class="num">${t.labourCharge > 0 ? `${RS}${fmt(t.labourCharge)}` : '&mdash;'}</td>
        <td class="num" style="color:#c0392b;">${t.labourAmount > 0 ? `-${RS}${fmt(t.labourAmount)}` : '&mdash;'}</td>
        <td class="num">${RS}${fmt(t.grossAmount)}</td>
        <td class="num">${RS}${fmt(t.netPayable)}</td>
        <td class="num">${t.advancePayment > 0 ? `${RS}${fmt(t.advancePayment)}` : '&mdash;'}</td>
        <td class="num"><strong>${RS}${fmt(t.finalPayable)}</strong></td>
      </tr>
      ${paymentSubRows}`;
  }).join('');

  // Standalone advance rows
  const advanceRows = (standaloneAdvances || []).map((a) => `
    <tr class="row-even" style="font-style:italic;color:#8b4513;background:#fff8ec;">
      <td class="left">${fmtDateShort(a.advanceDate)}</td>
      <td colspan="9" style="text-align:right;padding-right:10px;font-weight:bold;">
        ADVANCE GIVEN  (${a.paymentMode || 'Cash'})${a.notes ? ' &middot; ' + a.notes : ''}
      </td>
      <td class="num">&mdash;</td>
      <td class="num">&mdash;</td>
      <td class="num" style="color:#c0392b;font-weight:bold;">-${RS}${fmt(a.amount)}</td>
    </tr>`).join('');

  // Master payment rows
  const masterPaymentRows = (masterPayments || []).map((m) => `
    <tr class="row-even" style="font-style:italic;color:#1a5c1a;background:#f0f7f0;">
      <td class="left">${fmtDateShort(m.paymentDate)}</td>
      <td colspan="9" style="text-align:right;padding-right:10px;font-weight:bold;">
        PAYMENT TO MERCHANT (${m.paymentMode || 'Cash'})${m.notes ? ' &middot; ' + m.notes : ''}
      </td>
      <td class="num">&mdash;</td>
      <td class="num">&mdash;</td>
      <td class="num" style="color:#1a5c1a;font-weight:bold;">-${RS}${fmt(m.amount)}</td>
    </tr>`).join('');

  const totalPaymentsMade = Object.values(paymentsMap).reduce(
    (sum, pmts) => sum + pmts.reduce((s, p) => s + p.amount, 0), 0
  );
  const totalStandaloneAdv = (standaloneAdvances || []).reduce((s, a) => s + a.amount, 0);
  const totalMasterPayments = (masterPayments || []).reduce((s, m) => s + m.amount, 0);
  
  const netFinalAmount = Math.round((totals.finalPayable - totalPaymentsMade - totalStandaloneAdv - totalMasterPayments) * 100) / 100;
  const totalBalance = totals.balance;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>DOOARS GREEN FPO - Payment Voucher</title>
<style>${SHARED_CSS}</style>
</head>
<body>

${LOGO_BASE64 ? `<div class="watermark-bg"><img src="${LOGO_BASE64}" alt="watermark" /></div>` : ''}

<div class="header">
  <div class="logo-col">${logoImg}</div>
  <div class="header-center">
    <div class="company-main" style="line-height:1.2;">DOOARS GREEN FPO<br><span style="font-size:12px;">MCSL</span></div>
    <div class="company-sub" style="line-height:1.4;">GST NO - 19AAIAD3091R1ZO<br>REG NO- 7/Jal 2022-23 Dated 20.12.2022</div>
  </div>
  <div class="header-right">
    <div class="voucher-title">Payment Voucher</div>
    <div class="invoice-date">${invoiceDate}</div>
    <div class="invoice-no">No. ${invoiceNo}</div>
  </div>
</div>

<div class="billed-section">
  <div class="billed-label">Billed To:</div>
  <div class="billed-name">${merchantName}</div>
  <div class="billed-detail">DATE &ndash; ${dateStr}</div>
  <div class="billed-detail">TOTAL ENTRIES &ndash; ${transactions.length}</div>
</div>

<hr />

<div class="table-wrapper">
  <table>
    <colgroup>
      <col style="width:8%">
      <col style="width:7%">
      <col style="width:6%">
      <col style="width:8%">
      <col style="width:7%">
      <col style="width:7%">
      <col style="width:6%">
      <col style="width:6%">
      <col style="width:6%">
      <col style="width:11%">
      <col style="width:8%">
      <col style="width:8%">
      <col style="width:12%">
    </colgroup>
    <thead>
      <tr>
        <th class="left">DATE</th>
        <th class="num">QTY</th>
        <th class="num">LESS%</th>
        <th class="num">L.KG</th>
        <th class="num">NET KG</th>
        <th class="num">RATE</th>
        <th class="num">L.CNT</th>
        <th class="num">L.RATE</th>
        <th class="num">L.COST</th>
        <th class="num">AMOUNT</th>
        <th class="num">NETPAY</th>
        <th class="num">ADV</th>
        <th class="num">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${txnRows}
      ${advanceRows}
      ${masterPaymentRows}
      <tr class="total-row">
        <td class="left"><strong>TOTAL</strong></td>
        <td class="num">${fmt(totals.grossQty)}</td>
        <td class="num">&mdash;</td>
        <td class="num">${fmt(totals.lessQty)}</td>
        <td class="num">&mdash;</td>
        <td class="num">&mdash;</td>
        <td class="num">&mdash;</td>
        <td class="num">&mdash;</td>
        <td class="num">&mdash;</td>
        <td class="num">${RS}${fmt(totals.grossAmount)}</td>
        <td class="num">${RS}${fmt(totals.netPayable)}</td>
        <td class="num">${totals.advancePayment > 0 ? `${RS}${fmt(totals.advancePayment)}` : '&mdash;'}</td>
        <td class="num total-amount">${RS}${fmt(totals.finalPayable)}</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="balance-row" style="border-color:#2d6a2d;background:#f0f7f0;">
  <span class="balance-label" style="color:#1a5c1a;">GROSS PAYABLE (before advances):</span>
  <span class="balance-value-positive">${RS}${fmt(totals.finalPayable)}</span>
</div>
${totalPaymentsMade > 0 ? `<div class="balance-row" style="border-color:#2d6a2d;background:#f5fff5;">
  <span class="balance-label" style="color:#2d6a2d;">TRANSACTION PAYMENTS:</span>
  <span class="balance-value-negative">-${RS}${fmt(totalPaymentsMade)}</span>
</div>` : ''}
${totalStandaloneAdv > 0 ? `<div class="balance-row" style="border-color:#e8a000;background:#fff8ec;">
  <span class="balance-label" style="color:#8b4513;">ADVANCE GIVEN:</span>
  <span class="balance-value-negative">-${RS}${fmt(totalStandaloneAdv)}</span>
</div>` : ''}
${totalMasterPayments > 0 ? `<div class="balance-row" style="border-color:#2d6a2d;background:#f0f7f0;">
  <span class="balance-label" style="color:#1a5c1a;">PAYMENTS TO MERCHANT:</span>
  <span class="balance-value-negative">-${RS}${fmt(totalMasterPayments)}</span>
</div>` : ''}
<div class="balance-row">
  <span class="balance-label">NET AMOUNT PAYABLE:</span>
  <span class="${netFinalAmount > 0 ? 'balance-value-positive' : 'balance-value-negative'}">${RS}${fmt(netFinalAmount)}</span>
</div>

<div class="amount-words">
  NET PAYABLE &rarr; ${numberToWords(netFinalAmount)}
</div>
${totals.advancePayment > 0 ? `
<div class="amount-words" style="background:#fdf5f5;border-color:#c0392b;color:#a93226;margin-top:5px;">
  TOTAL ADVANCE &rarr; ${numberToWords(totals.advancePayment)}
</div>` : ''}

<div class="quality-note">
  <p>Please note the following quality deductions:</p>
  <ul>
    <li>Hand plucking: 2% deduction per delivery</li>
    <li>Machine plucking: 4% deduction per delivery</li>
    <li>Rainy days: deduction varies based on leaf moisture at the time of collection</li>
  </ul>
  <p class="gratitude">
    We are grateful for the trust and cooperation of every Small Tea Grower in our community.<br />
    Your commitment to quality green leaves strengthens all of us &mdash; thank you for being a vital part of this journey together.
  </p>
</div>

<hr />

<div class="footer-company">
  <div class="co-name">DOOARS GREEN FPO</div>
  <div class="contact">Email &ndash; dooarsgreenfpo@gmail.com</div>
  <div class="contact">Cont &ndash; 9800415644, 8101507292, 8972495852, 8967829553</div>
</div>

<div class="signatures">
  <div class="sig-block">
    <div class="sig-line"></div>
    <div class="sig-label">Authorized By</div>
  </div>
  <div class="sig-block">
    <div class="sig-line"></div>
    <div class="sig-label">Received By</div>
  </div>
</div>

</body>
</html>`;
}

// ── Controller 2: all transactions for a merchant on a given date / range ────────
// SCOPED by createdBy — users can only generate invoices for their own data
exports.generateInvoiceByMerchantDate = async (req, res) => {
  try {
    const userId = req.user._id;
    const { merchantName, date, startDate, endDate, format = 'pdf' } = req.query;

    if (!merchantName) {
      return res.status(400).json({ success: false, message: '`merchantName` query param is required' });
    }

    const finalStart = startDate || date;
    const finalEnd   = endDate   || date;

    if (!finalStart || !finalEnd) {
      return res.status(400).json({
        success: false,
        message: '`date` or `startDate` and `endDate` query params are required',
      });
    }

    const rangeStart = new Date(finalStart);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd   = new Date(finalEnd);
    rangeEnd.setHours(23, 59, 59, 999);

    const transactions = await MerchantTransaction.find({
      createdBy: userId,
      merchantName:    { $regex: new RegExp(`^${merchantName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      transactionDate: { $gte: rangeStart, $lte: rangeEnd },
    }).sort('transactionDate').lean();

    if (transactions.length === 0) {
      const msgDate = (finalStart === finalEnd) ? finalStart : `${finalStart} to ${finalEnd}`;
      return res.status(404).json({
        success: false,
        message: `No transactions found for "${merchantName}" on ${msgDate}`,
      });
    }

    const txnIds = transactions.map((t) => t._id);
    const [allPayments, merchant] = await Promise.all([
      MerchantPayment.find({ transaction: { $in: txnIds }, createdBy: userId }).lean(),
      Merchant.findOne({
        createdBy: userId,
        name: { $regex: new RegExp(`^${merchantName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      }).lean(),
    ]);

    const paymentsMap = {};
    allPayments.forEach((p) => {
      const key = p.transaction.toString();
      if (!paymentsMap[key]) paymentsMap[key] = [];
      paymentsMap[key].push(p);
    });

    let standaloneAdvances = [];
    let masterPayments = [];
    if (merchant) {
      const p1 = MerchantAdvance.find({
        createdBy: userId,
        merchant:    merchant._id,
        advanceDate: { $gte: rangeStart, $lte: rangeEnd },
      }).sort('advanceDate').lean();
      
      const p2 = require('../models/MerchantMasterPayment').find({
        createdBy: userId,
        merchant:    merchant._id,
        paymentDate: { $gte: rangeStart, $lte: rangeEnd },
      }).sort('paymentDate').lean();
      
      [standaloneAdvances, masterPayments] = await Promise.all([p1, p2]);
    }

    const html = buildMultiInvoiceHtml(merchantName, finalStart, finalEnd, transactions, paymentsMap, standaloneAdvances, masterPayments);

    if (format.toLowerCase() === 'html') {
      return res.setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    }

    const buffer    = await generatePdf(html);
    const safeName  = merchantName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    const safeDate  = (finalStart === finalEnd)
      ? finalStart.replace(/-/g, '')
      : `${finalStart.replace(/-/g, '')}_${finalEnd.replace(/-/g, '')}`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${safeName}-${safeDate}.pdf"`);
    res.send(buffer);

  } catch (err) {
    console.error('[invoiceController.generateInvoiceByMerchantDate] Error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to generate invoice: ' + err.message });
  }
};

// ── Production-safe PDF helper ────────────────────────────────────────────────
/**
 * Generates a PDF from HTML using puppeteer-core.
 */
async function generatePdf(html) {
  const { default: puppeteer } = await import('puppeteer-core');

  let executablePath = null;
  let launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--disable-extensions',
    '--font-render-hinting=none',
  ];
  let headlessMode = 'shell';

  // Always use sparticuz automatically on Linux/Serverless environments.
  const isServerless = process.platform !== 'win32';

  if (!executablePath && isServerless) {
    try {
      const sparticuz = (await import('@sparticuz/chromium')).default;
      executablePath  = await sparticuz.executablePath();
      launchArgs      = sparticuz.args;
      headlessMode    = sparticuz.headless;
      console.log('[generatePdf] Using @sparticuz/chromium at:', executablePath);
    } catch (err) {
      console.error('[generatePdf] sparticuz failed to load:', err);
    }
  }

  // Fallback to Env variable or Platform defaults
  if (!executablePath) {
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
    
    if (!executablePath) {
      if (process.platform === 'win32') {
        const winPaths = [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files\\Chromium\\Application\\chromium.exe',
        ];
        executablePath = winPaths.find(p => {
          try { require('fs').accessSync(p); return true; } catch { return false; }
        }) || winPaths[0];
      } else {
        const linuxPaths = [
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/usr/bin/google-chrome',
        ];
        executablePath = linuxPaths.find(p => {
          try { require('fs').accessSync(p); return true; } catch { return false; }
        }) || '/usr/bin/chromium';
      }
    }
    console.log('[generatePdf] Using platform default Chromium at:', executablePath);
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: headlessMode,
    args:     launchArgs,
  });

  try {
    const page = await browser.newPage();
    // Set viewport to A4 dimensions
    await page.setViewport({ width: 794, height: 1123 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdfData = await page.pdf({
      format:          'A4',
      printBackground: true,   // CRITICAL: renders background colors
      margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
    });
    // puppeteer-core v25+ returns Uint8Array — wrap in Buffer for Express
    return Buffer.from(pdfData);
  } finally {
    await browser.close();
  }
}

// ── Build Factory Invoice HTML ─────────────────────────────────────────────────
function buildFactoryInvoiceHtml(record) {
  const logoImg = LOGO_BASE64
    ? `<img src="${LOGO_BASE64}" alt="logo" class="logo-img" />`
    : `<div class="logo-placeholder">DOOARS<br>GREEN<br>FPO</div>`;

  const qty      = record.totalQuantity  || 0;
  const lessPct  = record.lessPercentage || 0;
  const lessQty  = parseFloat(((qty * lessPct) / 100).toFixed(2));
  const netQty   = parseFloat((qty - lessQty).toFixed(2));
  const fine     = record.fineLeaf       || 0;
  const rate     = record.rate           || 0;
  const totalAmt = parseFloat((netQty * rate).toFixed(2));
  const advance  = record.advance        || 0;
  const totalPaid = (record.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const due      = parseFloat((totalAmt - advance - totalPaid).toFixed(2));
  const invoiceDate = fmtDateLong(record.date || record.createdAt);
  const invoiceNo   = String(record._id).slice(-6).toUpperCase();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Factory Invoice - ${record.buyerName || ''}</title>
<style>${SHARED_CSS}
  /* Factory-specific overrides */
  .due-row-pos { background:#f0fff0; border:1px solid #2d6a2d; }
  .due-row-neg { background:#fff1f1; border:1px solid #c0392b; }
</style>
</head>
<body>

${LOGO_BASE64 ? `<div class="watermark-bg"><img src="${LOGO_BASE64}" alt="watermark" /></div>` : ''}

<div class="header">
  <div class="logo-col">${logoImg}</div>
  <div class="header-center">
    <div class="company-main" style="line-height:1.2;">DOOARS GREEN FPO<br><span style="font-size:12px;">MCSL</span></div>
    <div class="company-sub" style="line-height:1.4;">GST NO - 19AAIAD3091R1ZO<br>REG NO- 7/Jal 2022-23 Dated 20.12.2022</div>
  </div>
  <div class="header-right">
    <div class="voucher-title">Factory Invoice</div>
    <div class="invoice-date">${invoiceDate}</div>
    <div class="invoice-no">No. FCT-${invoiceNo}</div>
  </div>
</div>

<div class="billed-section">
  <div class="billed-label">Buyer / Party:</div>
  <div class="billed-name">${record.buyerName || '&mdash;'}</div>
  <div class="billed-detail">DATE &ndash; ${fmtDate(record.date)}</div>
  ${record.remarks ? `<div class="billed-detail">REMARKS &ndash; ${record.remarks}</div>` : ''}
</div>

<hr />

<div class="table-wrapper">
  <table>
    <colgroup>
      <col style="width:5%">
      <col style="width:9%">
      <col style="width:10%">
      <col style="width:10%">
      <col style="width:7%">
      <col style="width:10%">
      <col style="width:10%">
      <col style="width:7%">
      <col style="width:11%">
      <col style="width:11%">
    </colgroup>
    <thead>
      <tr>
        <th>SL</th>
        <th>DATE</th>
        <th>TEA TYPE</th>
        <th class="num">TOTAL QTY (KG)</th>
        <th class="num">LESS%</th>
        <th class="num">LESS QTY (KG)</th>
        <th class="num">NET QTY (KG)</th>
        <th class="num">FINE%</th>
        <th class="num">RATE (${RS}/KG)</th>
        <th class="num">TOTAL AMT (${RS})</th>
      </tr>
    </thead>
    <tbody>
      <tr class="row-even">
        <td>1</td>
        <td>${fmtDate(record.date)}</td>
        <td style="font-weight:bold;color:#444;">${record.teaType || 'CTC'}</td>
        <td class="num">${fmt(qty)}</td>
        <td class="num">${lessPct > 0 ? lessPct + '%' : '&mdash;'}</td>
        <td class="num">${fmt(lessQty)}</td>
        <td class="num" style="font-weight:bold;color:#1a5c1a;">${fmt(netQty)}</td>
        <td class="num">${fine > 0 ? fine + '%' : '&mdash;'}</td>
        <td class="num">${RS}${fmt(rate)}</td>
        <td class="num" style="font-weight:bold;">${RS}${fmt(totalAmt)}</td>
      </tr>
      ${(record.payments || []).map(p => `
      <tr class="row-odd" style="font-style:italic;color:#555;">
        <td></td>
        <td>${fmtDate(p.date)}</td>
        <td colspan="7" style="text-align:right;padding-right:10px;">Payment (${p.mode || 'Cash'})</td>
        <td class="num" style="color:#1a5c1a;font-weight:bold;">-${RS}${fmt(p.amount)}</td>
      </tr>`).join('')}
      <tr class="total-row">
        <td colspan="4" class="left"><strong>GRAND TOTAL</strong></td>
        <td>&mdash;</td>
        <td class="num"><strong>${fmt(lessQty)}</strong></td>
        <td class="num"><strong>${fmt(netQty)}</strong></td>
        <td>&mdash;</td>
        <td>&mdash;</td>
        <td class="num total-amount">${RS}${fmt(totalAmt)}</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="summary-box">
  <div class="summary-row gross">
    <span class="summary-label">Total Amount</span>
    <span class="summary-value" style="color:#1a5c1a;">${RS}${fmt(totalAmt)}</span>
  </div>
  ${advance > 0 ? `<div class="summary-row advance"><span class="summary-label">Advance Paid</span><span class="summary-value" style="color:#b8860b;">-${RS}${fmt(advance)}</span></div>` : ''}
  ${totalPaid > 0 ? `<div class="summary-row advance"><span class="summary-label">Payments Received</span><span class="summary-value" style="color:#c0392b;">-${RS}${fmt(totalPaid)}</span></div>` : ''}
  <div class="summary-row ${due > 0 ? 'due-row-neg' : 'due-row-pos'}">
    <span class="summary-label">${due > 0 ? 'Balance Due' : 'Status'}</span>
    <span class="summary-value" style="color:${due > 0 ? '#c0392b' : '#1a5c1a'};">${due > 0 ? RS + fmt(due) : '&#10003; CLEARED'}</span>
  </div>
</div>

<div class="amount-words">TOTAL AMOUNT &rarr; ${numberToWords(totalAmt)}</div>

<hr />

<div class="footer-company">
  <div class="co-name">DOOARS GREEN FPO</div>
  <div class="contact">Email &ndash; dooarsgreenfpo@gmail.com</div>
  <div class="contact">Cont &ndash; 9800415644, 8101507292, 8972495852, 8967829553</div>
</div>

<div class="signatures">
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Authorized By</div></div>
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Received By</div></div>
</div>

</body>
</html>`;
}

// ── Controller: Factory Invoice ────────────────────────────────────────────────
exports.generateFactoryInvoice = async (req, res) => {
  try {
    const { id }  = req.params;
    const format  = (req.query.format || 'pdf').toLowerCase();
    const Factory = require('../models/Factory');

    const record = await Factory.findById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Factory record not found' });
    }

    const html = buildFactoryInvoiceHtml(record.toObject({ virtuals: true }));

    if (format === 'html') {
      return res.setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    }

    const buffer    = await generatePdf(html);
    const safeBuyer = (record.buyerName || 'factory').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    const safeDate  = fmtDate(record.date).replace(/\//g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factory-invoice-${safeBuyer}-${safeDate}.pdf"`);
    res.send(buffer);

  } catch (err) {
    console.error('[invoiceController.generateFactoryInvoice] Error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Failed to generate factory invoice: ' + err.message });
  }
};

// ── Build Multi-Record Factory Invoice HTML ───────────────────────────────────
function buildMultiFactoryInvoiceHtml(buyerName, records) {
  const logoImg = LOGO_BASE64
    ? `<img src="${LOGO_BASE64}" alt="logo" class="logo-img" />`
    : `<div class="logo-placeholder">DOOARS<br>GREEN<br>FPO</div>`;

  const invoiceDate = fmtDateLong(new Date());

  let grandTotalQty = 0, grandLessQty = 0, grandNetQty = 0;
  let grandTotalAmt = 0, grandAdvance = 0, grandPaid = 0;

  const dataRows = records.map((record, i) => {
    const qty      = record.totalQuantity  || 0;
    const lessPct  = record.lessPercentage || 0;
    const lessQty  = parseFloat(((qty * lessPct) / 100).toFixed(2));
    const netQty   = parseFloat((qty - lessQty).toFixed(2));
    const fine     = record.fineLeaf       || 0;
    const rate     = record.rate           || 0;
    const totalAmt = parseFloat((netQty * rate).toFixed(2));
    const advance  = record.advance        || 0;
    const totalPaid = (record.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

    grandTotalQty += qty;
    grandLessQty  += lessQty;
    grandNetQty   += netQty;
    grandTotalAmt += totalAmt;
    grandAdvance  += advance;
    grandPaid     += totalPaid;

    const paymentRows = (record.payments || []).map(p => `
      <tr class="row-even" style="font-style:italic;color:#555;">
        <td></td>
        <td>${fmtDate(p.date)}</td>
        <td colspan="7" style="text-align:right;padding-right:10px;">Payment (${p.mode || 'Cash'})</td>
        <td class="num" style="color:#1a5c1a;font-weight:bold;">-${RS}${fmt(p.amount)}</td>
      </tr>`).join('');

    return `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td style="text-align:center;">${i + 1}</td>
        <td>${fmtDate(record.date)}</td>
        <td style="font-weight:bold;color:#444;">${record.teaType || 'CTC'}</td>
        <td class="num">${fmt(qty)}</td>
        <td class="num">${lessPct > 0 ? lessPct + '%' : '&mdash;'}</td>
        <td class="num">${fmt(lessQty)}</td>
        <td class="num" style="font-weight:bold;color:#1a5c1a;">${fmt(netQty)}</td>
        <td class="num">${fine > 0 ? fine + '%' : '&mdash;'}</td>
        <td class="num">${RS}${fmt(rate)}</td>
        <td class="num" style="font-weight:bold;">${RS}${fmt(totalAmt)}</td>
      </tr>
      ${paymentRows}`;
  }).join('');

  const due = parseFloat((grandTotalAmt - grandAdvance - grandPaid).toFixed(2));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Factory Statement - ${buyerName}</title>
<style>${SHARED_CSS}
  .due-row-pos { background:#f0fff0; border:1px solid #2d6a2d; }
  .due-row-neg { background:#fff1f1; border:1px solid #c0392b; }
</style>
</head>
<body>

${LOGO_BASE64 ? `<div class="watermark-bg"><img src="${LOGO_BASE64}" alt="watermark" /></div>` : ''}

<div class="header">
  <div class="logo-col">${logoImg}</div>
  <div class="header-center">
    <div class="company-main" style="line-height:1.2;">DOOARS GREEN FPO<br><span style="font-size:12px;">MCSL</span></div>
    <div class="company-sub" style="line-height:1.4;">GST NO - 19AAIAD3091R1ZO<br>REG NO- 7/Jal 2022-23 Dated 20.12.2022</div>
  </div>
  <div class="header-right">
    <div class="voucher-title">Factory Statement</div>
    <div class="invoice-date">${invoiceDate}</div>
  </div>
</div>

<div class="billed-section">
  <div class="billed-label">Buyer / Party:</div>
  <div class="billed-name">${buyerName}</div>
</div>

<hr />

<div class="table-wrapper">
  <table>
    <colgroup>
      <col style="width:5%">
      <col style="width:9%">
      <col style="width:10%">
      <col style="width:10%">
      <col style="width:7%">
      <col style="width:10%">
      <col style="width:10%">
      <col style="width:7%">
      <col style="width:11%">
      <col style="width:11%">
    </colgroup>
    <thead>
      <tr>
        <th>SL</th>
        <th>DATE</th>
        <th>TEA TYPE</th>
        <th class="num">TOTAL QTY (KG)</th>
        <th class="num">LESS%</th>
        <th class="num">LESS QTY (KG)</th>
        <th class="num">NET QTY (KG)</th>
        <th class="num">FINE%</th>
        <th class="num">RATE (${RS}/KG)</th>
        <th class="num">TOTAL AMT (${RS})</th>
      </tr>
    </thead>
    <tbody>
      ${dataRows}
      <tr class="total-row">
        <td colspan="3" class="left"><strong>GRAND TOTAL</strong></td>
        <td class="num"><strong>${fmt(grandTotalQty)}</strong></td>
        <td>&mdash;</td>
        <td class="num"><strong>${fmt(grandLessQty)}</strong></td>
        <td class="num" style="color:#1a5c1a;"><strong>${fmt(grandNetQty)}</strong></td>
        <td>&mdash;</td>
        <td>&mdash;</td>
        <td class="num total-amount">${RS}${fmt(grandTotalAmt)}</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="summary-box">
  <div class="summary-row gross">
    <span class="summary-label">Total Amount</span>
    <span class="summary-value" style="color:#1a5c1a;">${RS}${fmt(grandTotalAmt)}</span>
  </div>
  ${grandAdvance > 0 ? `<div class="summary-row advance"><span class="summary-label">Advance Paid</span><span class="summary-value" style="color:#b8860b;">-${RS}${fmt(grandAdvance)}</span></div>` : ''}
  ${grandPaid    > 0 ? `<div class="summary-row advance"><span class="summary-label">Payments Received</span><span class="summary-value" style="color:#c0392b;">-${RS}${fmt(grandPaid)}</span></div>` : ''}
  <div class="summary-row ${due > 0 ? 'due-row-neg' : 'due-row-pos'}">
    <span class="summary-label">${due > 0 ? 'Balance Due' : 'Status'}</span>
    <span class="summary-value" style="color:${due > 0 ? '#c0392b' : '#1a5c1a'};">${due > 0 ? RS + fmt(due) : '&#10003; CLEARED'}</span>
  </div>
</div>

<div class="amount-words">TOTAL AMOUNT &rarr; ${numberToWords(grandTotalAmt)}</div>

<hr />

<div class="footer-company">
  <div class="co-name">DOOARS GREEN FPO</div>
  <div class="contact">Email &ndash; dooarsgreenfpo@gmail.com</div>
  <div class="contact">Cont &ndash; 9800415644, 8101507292, 8972495852, 8967829553</div>
</div>

<div class="signatures">
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Authorized By</div></div>
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Received By</div></div>
</div>

</body>
</html>`;
}

// ── Controller: Factory Multi-Invoice By Buyer ─────────────────────────────────
// SCOPED by createdBy — users can only generate invoices for their own data
exports.generateFactoryInvoiceByBuyer = async (req, res) => {
  try {
    const userId = req.user._id;
    const { buyerName } = req.query;
    const format = (req.query.format || 'pdf').toLowerCase();

    if (!buyerName) {
      return res.status(400).json({ success: false, message: 'buyerName is required' });
    }

    const Factory = require('../models/Factory');
    const records = await Factory.find({
      createdBy: userId,
      buyerName: { $regex: new RegExp(`^${buyerName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    }).sort('date').lean({ virtuals: true });

    if (!records || records.length === 0) {
      return res.status(404).json({ success: false, message: 'No records found for this buyer' });
    }

    const html = buildMultiFactoryInvoiceHtml(buyerName, records);

    if (format === 'html') {
      return res.setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    }

    const buffer    = await generatePdf(html);
    const safeBuyer = buyerName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factory-statement-${safeBuyer}-${Date.now()}.pdf"`);
    res.send(buffer);

  } catch (err) {
    console.error('[invoiceController.generateFactoryInvoiceByBuyer] Error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Failed to generate factory statement: ' + err.message });
  }
};