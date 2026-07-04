/**
 * invoiceController.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Generates a printable PDF invoice (DOOARS GREEN FPO PAYMENT VOUCHER) for a
 * given MerchantTransaction, including all linked MerchantPayment records.
 *
 * Route:
 *   GET /api/merchant-transactions/:id/invoice
 *   GET /api/merchant-transactions/:id/invoice?format=html   (preview in browser)
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n === undefined || n === null) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtDateLong(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Convert a number to Indian number-words for the balance line */
function numberToWords(num) {
  const ones = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
                 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
                 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
  const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];

  if (num === 0) return 'RUPEES ZERO ONLY';

  function convert(n) {
    if (n < 20)   return ones[n];
    if (n < 100)  return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' HUNDRED' + (n % 100 ? ' ' + convert(n % 100) : '');
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
  // Use last 5 digits of transactionId or fallback to sequential
  if (txn.transactionId) {
    const digits = txn.transactionId.replace(/\D/g, '');
    return String(digits).slice(-5).padStart(5, '0');
  }
  return '00001';
}

// ── Build the HTML template ───────────────────────────────────────────────────
function buildInvoiceHtml(txn, payments) {
  const logoImg = LOGO_BASE64
    ? `<img src="${LOGO_BASE64}" alt="Dooars Green FPO Logo" class="logo-img" />`
    : `<div class="logo-placeholder">DOOARS<br>GREEN<br>FPO</div>`;

  const totalPaid    = payments.reduce((s, p) => s + p.amount, 0);
  const balance      = txn.balance;
  const invoiceNo    = invoiceNumber(txn);
  const invoiceDate  = fmtDateLong(txn.transactionDate);
  const isAdvBalance = balance < 0;

  // Build payment rows
  const paymentRows = payments.length === 0
    ? `<tr><td colspan="12" style="text-align:center;padding:12px;color:#888;">No payment records</td></tr>`
    : payments.map((p, i) => `
        <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
          <td>${fmtDate(p.paymentDate)}</td>
          <td colspan="6" style="text-align: right; padding-right: 15px; font-style: italic; color: #555;">Payment (${p.paymentMode || 'Cash'})</td>
          <td>${p.notes || '—'}</td>
          <td>—</td>
          <td>${p.paymentMode === 'Cash' ? fmt(p.amount) : '—'}</td>
          <td>—</td>
          <td>${fmt(p.amount)}</td>
        </tr>`).join('');

  const txnRow = `
    <tr class="row-even">
      <td>${fmtDate(txn.transactionDate)}</td>
      <td>${fmt(txn.grossQty)}</td>
      <td>${txn.lessPercent > 0 ? `${txn.lessPercent}%` : '—'}</td>
      <td>${fmt(txn.lessQty)}</td>
      <td>${txn.fineLeaf > 0 ? `${txn.fineLeaf}%` : '—'}</td>
      <td><strong>${fmt(txn.netQty)}</strong></td>
      <td>${fmt(txn.ratePerKg)}</td>
      <td>${fmt(txn.grossAmount)}</td>
      <td>${txn.teaType || '—'}</td>
      <td>${fmt(txn.netPayable)}</td>
      <td>${fmt(txn.advancePayment)}</td>
      <td><strong>${fmt(txn.finalPayable)}</strong></td>
    </tr>`;

  const totalRow = `
    <tr class="total-row">
      <td><strong>Total</strong></td>
      <td>${fmt(txn.grossQty)}</td>
      <td>—</td>
      <td>${fmt(txn.lessQty)}</td>
      <td>—</td>
      <td><strong>${fmt(txn.netQty)}</strong></td>
      <td>—</td>
      <td>${fmt(txn.grossAmount)}</td>
      <td>—</td>
      <td>${fmt(txn.netPayable)}</td>
      <td>${fmt(txn.advancePayment)}</td>
      <td class="total-amount">${fmt(txn.finalPayable)}</td>
    </tr>`;

  const balanceSection = balance !== 0 
    ? `<div class="balance-box">
         <div class="balance-label">${isAdvBalance ? 'ADVANCE BALANCE' : 'OUTSTANDING BALANCE'}</div>
         <div class="balance-value">${fmt(Math.abs(balance))}</div>
         <div class="amount-words">${numberToWords(Math.abs(balance))}</div>
       </div>` 
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>DOOARS GREEN FPO - Payment Voucher</title>
<style>
  /* ── Reset & Base ── */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
    color: #222;
    background: #fff;
    padding: 16px 20px;
  }

  /* ── Watermark ── */
  .watermark-bg {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-30deg);
    width: 460px;
    height: 460px;
    opacity: 0.1;
    z-index: -10;
    pointer-events: none;
  }
  .watermark-bg img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding-bottom: 10px;
    border-bottom: 2.5px solid #2d6a2d;
    margin-bottom: 12px;
    position: relative;
    z-index: 1;
  }
  .logo-img {
    width: 90px;
    height: 90px;
    object-fit: contain;
  }
  .logo-placeholder {
    width: 90px;
    height: 90px;
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
  .header-right {
    text-align: right;
  }
  .voucher-title {
    font-size: 15px;
    font-weight: 900;
    color: #2d6a2d;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .invoice-date {
    font-size: 13px;
    color: #333;
    margin: 3px 0;
  }
  .invoice-no {
    font-size: 14px;
    font-weight: 800;
    color: #1a1a1a;
    text-transform: uppercase;
  }

  /* ── Billed To ── */
  .billed-section {
    margin-bottom: 14px;
    position: relative;
    z-index: 1;
  }
  .billed-label {
    font-size: 12px;
    font-weight: 900;
    color: #2d6a2d;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .billed-name {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    color: #111;
  }
  .billed-detail {
    font-size: 11px;
    color: #444;
  }

  /* ── Divider ── */
  hr {
    border: none;
    border-top: 1.5px solid #2d6a2d;
    margin: 10px 0;
  }

  /* ── Table ── */
  .table-wrapper {
    position: relative;
    z-index: 1;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10.5px;
  }
  thead tr {
    background: #2d6a2d;
    color: #fff;
  }
  thead th {
    padding: 7px 5px;
    text-align: center;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.3px;
  }
  tbody td {
    padding: 6px 5px;
    text-align: center;
    border-bottom: 1px solid #e0e0e0;
  }
  .row-even { background: #fafafa; }
  .row-odd  { background: #f0f7f0; }

  /* Advance Balance row */
  .adv-row td {
    font-weight: 600;
    color: #444;
    border-bottom: 1px solid #ddd;
  }
  .adv-row .adv-label {
    text-align: left;
    padding-left: 8px;
    color: #555;
  }
  .adv-row .adv-value {
    color: #c0392b;
    font-weight: 700;
  }

  /* Total row */
  .total-row td {
    background: #f0f7f0;
    font-weight: 700;
    border-top: 2px solid #2d6a2d;
    border-bottom: 2px solid #2d6a2d;
    color: #1a1a1a;
  }
  .total-amount {
    color: #2d6a2d;
    font-size: 12px;
  }

  /* ── Balance Banner ── */
  .balance-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    background: #fff8ec;
    border: 1px solid #e8c95a;
    border-radius: 3px;
    margin: 10px 0;
    position: relative;
    z-index: 1;
  }
  .balance-label {
    font-weight: 800;
    font-size: 12px;
    color: #b8860b;
    text-transform: uppercase;
  }
  .balance-value {
    font-weight: 900;
    font-size: 13px;
    color: ${balance < 0 ? '#c0392b' : '#2d6a2d'};
  }

  /* ── Amount in Words ── */
  .amount-words {
    background: #f5fff5;
    border: 1.5px solid #2d6a2d;
    border-radius: 3px;
    padding: 8px 12px;
    font-size: 11.5px;
    font-weight: 800;
    color: #1a4f1a;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    margin: 10px 0;
    position: relative;
    z-index: 1;
  }

  /* ── Quality Note ── */
  .quality-note {
    margin: 12px 0;
    padding: 10px 12px;
    background: #fffdf5;
    border-left: 3px solid #e8c95a;
    font-size: 10.5px;
    position: relative;
    z-index: 1;
  }
  .quality-note p { font-weight: 700; margin-bottom: 5px; }
  .quality-note ul {
    margin-left: 16px;
    margin-bottom: 8px;
  }
  .quality-note li { margin-bottom: 3px; }
  .quality-note .gratitude {
    font-style: italic;
    color: #555;
    line-height: 1.5;
  }

  /* ── Footer ── */
  .footer-company {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1.5px solid #2d6a2d;
    position: relative;
    z-index: 1;
  }
  .footer-company .company-name {
    font-size: 13px;
    font-weight: 900;
    color: #2d6a2d;
    text-transform: uppercase;
  }
  .footer-company .contact {
    font-size: 10px;
    color: #444;
    margin-top: 2px;
  }

  /* ── Signatures ── */
  .signatures {
    display: flex;
    justify-content: space-between;
    margin-top: 40px;
    position: relative;
    z-index: 1;
  }
  .sig-block {
    text-align: center;
    width: 200px;
  }
  .sig-line {
    border-top: 1.5px solid #333;
    margin-bottom: 5px;
  }
  .sig-label {
    font-size: 11px;
    color: #333;
    font-weight: 600;
  }

  @media print {
    body { padding: 10px 15px; }
  }
</style>
</head>
<body>

<!-- ══ WATERMARK ═══════════════════════════════════════════════════════════════ -->
${LOGO_BASE64 ? `<div class="watermark-bg"><img src="${LOGO_BASE64}" alt="watermark" /></div>` : ''}

<!-- ══ HEADER ═══════════════════════════════════════════════════════════════ -->
<div class="header">
  <div class="logo-col">
    ${logoImg}
  </div>
  <div class="header-right">
    <div class="voucher-title">DOOARS GREEN FPO PAYMENT VOUCHER</div>
    <div class="invoice-date">${invoiceDate}</div>
    <div class="invoice-no">INVOICE NO. ${invoiceNo}</div>
  </div>
</div>

<!-- ══ BILLED TO ══════════════════════════════════════════════════════════════ -->
<div class="billed-section">
  <div class="billed-label">BILLED TO:</div>
  <div class="billed-name">${txn.merchantName || '—'}</div>
  <div class="billed-detail">V.NO &ndash; ${txn.transactionId || '—'}</div>
  <div class="billed-detail">DATE &ndash; ${fmtDate(txn.transactionDate)}</div>
</div>

<hr />

<!-- ══ TRANSACTION TABLE ═══════════════════════════════════════════════════════ -->
<div class="table-wrapper">
  <table>
    <thead>
      <tr>
        <th>DATE</th>
        <th>QTY (KG)</th>
        <th>LESS %</th>
        <th>LESS (KG)</th>
        <th>FINE LEAF %</th>
        <th>Net QTY</th>
        <th>RATE</th>
        <th>AMOUNT</th>
        <th>DESCRIPTION</th>
        <th>NET PAYABLE</th>
        <th>ADVANCE</th>
        <th>TOTAL</th>
      </tr>
    </thead>
    <tbody>


      <!-- Main transaction row -->
      ${txnRow}

      <!-- Payment rows -->
      ${paymentRows}

      <!-- Total -->
      ${totalRow}
    </tbody>
  </table>
</div>

<!-- ══ BALANCE ════════════════════════════════════════════════════════════════ -->
<div class="balance-row">
  <span class="balance-label">TOTAL FINAL AMOUNT:</span>
  <span class="balance-value">${fmt(txn.finalPayable)}</span>
</div>

<!-- ══ AMOUNT IN WORDS ════════════════════════════════════════════════════════ -->
<div class="amount-words">
  TOTAL AMOUNT &gt; ${numberToWords(txn.finalPayable)}
</div>
${txn.advancePayment > 0 ? `
<div class="amount-words" style="background: #fdf5f5; border-color: #c0392b; color: #a93226; margin-top: 6px;">
  TOTAL ADVANCE &gt; ${numberToWords(txn.advancePayment)}
</div>
` : ''}

<!-- ══ QUALITY NOTE ═══════════════════════════════════════════════════════════ -->
<div class="quality-note">
  <p>Please note the following quality deductions:</p>
  <ul>
    <li>Hand plucking: 2% deduction per delivery</li>
    <li>Machine plucking: 4% deduction per delivery</li>
    <li>Rainy days: deduction varies based on leaf moisture at the time of collection</li>
  </ul>
  <p class="gratitude">
    We are grateful for the trust and cooperation of every Small Tea Grower in our community.<br />
    Your commitment to quality green leaves strengthens all of us — thank you for being a vital part of this journey together.
  </p>
</div>

<hr />

<!-- ══ FOOTER COMPANY ══════════════════════════════════════════════════════════ -->
<div class="footer-company">
  <div class="company-name">DOOARS GREEN FPO</div>
  <div class="contact">Email &ndash; dooarsgreenfpo@gmail.com</div>
  <div class="contact">Cont &ndash; 9800415644, 8101507292, 8972495852, 8967829553</div>
</div>

<!-- ══ SIGNATURES ══════════════════════════════════════════════════════════════ -->
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

// ── Controller 1: single transaction ──────────────────────────────────────────
exports.generateInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const format  = (req.query.format || 'pdf').toLowerCase();   // 'pdf' | 'html'

    // Fetch transaction + all linked payments
    const [txn, payments] = await Promise.all([
      MerchantTransaction.findById(id).lean(),
      MerchantPayment.find({ transaction: id }).sort('paymentDate').lean(),
    ]);

    if (!txn) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const html = buildInvoiceHtml(txn, payments);

    // ── HTML preview (handy for debugging) ───────────────────────────────────
    if (format === 'html') {
      return res.setHeader('Content-Type', 'text/html').send(html);
    }

    // ── PDF generation ────────────────────────────────────────────────────────
    const buffer = await generatePdf(html);
    const safeFilename = `invoice-${txn.transactionId || id}-${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
    res.send(buffer);

  } catch (err) {
    console.error('[invoiceController.generateInvoice] Error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Failed to generate invoice: ' + err.message });
  }
};

// ── Build multi-transaction HTML (merchant + date range) ─────────────────────────
function buildMultiInvoiceHtml(merchantName, startDate, endDate, transactions, paymentsMap, standaloneAdvances) {
  const logoImg = LOGO_BASE64
    ? `<img src="${LOGO_BASE64}" alt="Dooars Green FPO Logo" class="logo-img" />`
    : `<div class="logo-placeholder">DOOARS<br>GREEN<br>FPO</div>`;

  const isSameDate = startDate === endDate;
  const invoiceDate = isSameDate ? fmtDateLong(startDate) : `${fmtDateLong(startDate)} - ${fmtDateLong(endDate)}`;
  const dateStr     = isSameDate ? fmtDate(startDate) : `${fmtDate(startDate)} to ${fmtDate(endDate)}`;

  // Totals across all transactions on that date
  const totals = transactions.reduce(
    (a, t) => ({
      grossQty:      a.grossQty      + (t.grossQty      || 0),
      lessQty:       a.lessQty       + (t.lessQty        || 0),
      grossAmount:   a.grossAmount   + (t.grossAmount    || 0),
      netPayable:    a.netPayable    + (t.netPayable      || 0),
      advancePayment: a.advancePayment + (t.advancePayment || 0),
      finalPayable:  a.finalPayable  + (t.finalPayable   || 0),
      balance:       a.balance       + (t.balance         || 0),
    }),
    { grossQty: 0, lessQty: 0, grossAmount: 0, netPayable: 0, advancePayment: 0, finalPayable: 0, balance: 0 }
  );

  // Invoice number from date: YYYYMMDD
  const d = new Date(endDate || startDate);
  const invoiceNo = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;

  // Build one row per transaction
  const txnRows = transactions.map((t, i) => {
    const payments = paymentsMap[t._id.toString()] || [];
    const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
    const paymentSubRows = payments.map((p) => `
      <tr class="row-even" style="font-style: italic; color: #444; background: #fafafa;">
        <td>${fmtDate(p.paymentDate)}</td>
        <td colspan="7" style="text-align: right; padding-right: 15px;">Payment (${p.paymentMode || 'Cash'})</td>
        <td>${p.notes || '—'}</td>
        <td>—</td>
        <td>—</td>
        <td style="color: #2d6a2d; font-weight: bold;">- ${fmt(p.amount)}</td>
      </tr>`).join('');

    return `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td>${fmtDate(t.transactionDate)}</td>
        <td>${fmt(t.grossQty)}</td>
        <td>${t.lessPercent > 0 ? `${t.lessPercent}%` : '—'}</td>
        <td>${fmt(t.lessQty)}</td>
        <td>${t.fineLeaf > 0 ? `${t.fineLeaf}%` : '—'}</td>
        <td><strong>${fmt(t.netQty)}</strong></td>
        <td>${fmt(t.ratePerKg)}</td>
        <td>${fmt(t.grossAmount)}</td>
        <td>${t.teaType || '—'}</td>
        <td>${fmt(t.netPayable)}</td>
        <td>${fmt(t.advancePayment)}</td>
        <td><strong>${fmt(t.finalPayable)}</strong></td>
      </tr>
      ${paymentSubRows}`;
  }).join('');

  // Standalone advance rows
  const advanceRows = (standaloneAdvances || []).map((a) => `
    <tr class="row-even" style="font-style: italic; color: #8b4513; background: #fff8ec;">
      <td>${fmtDate(a.advanceDate)}</td>
      <td colspan="6" style="text-align: right; padding-right: 15px; font-weight: bold;">ADVANCE GIVEN (${a.paymentMode || 'Cash'}) ${a.notes ? ' \u00B7 ' + a.notes : ''}</td>
      <td>${a.advanceId || ''}</td>
      <td>—</td>
      <td>—</td>
      <td style="color: #c0392b; font-weight: bold;">- ${fmt(a.amount)}</td>
    </tr>`).join('');

  // Sum of all payments made against these transactions
  const totalPaymentsMade = Object.values(paymentsMap).reduce(
    (sum, payments) => sum + payments.reduce((s, p) => s + p.amount, 0), 0
  );
  // Sum of standalone advances given in this period
  const totalStandaloneAdv = (standaloneAdvances || []).reduce((s, a) => s + a.amount, 0);
  // True net amount still owed after all payments + standalone advances
  const netFinalAmount = Math.max(0,
    Math.round((totals.finalPayable - totalPaymentsMade - totalStandaloneAdv) * 100) / 100
  );

  const totalBalance = totals.balance;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>DOOARS GREEN FPO - Payment Voucher</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
    color: #222;
    background: #fff;
    padding: 16px 20px;
  }
  .watermark-bg {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%) rotate(-30deg);
    width: 460px; height: 460px;
    opacity: 0.1;
    z-index: -10;
    pointer-events: none;
  }
  .watermark-bg img { width: 100%; height: 100%; object-fit: contain; }
  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding-bottom: 10px;
    border-bottom: 2.5px solid #2d6a2d;
    margin-bottom: 12px;
    position: relative; z-index: 1;
  }
  .logo-img { width: 90px; height: 90px; object-fit: contain; }
  .logo-placeholder {
    width: 90px; height: 90px;
    background: #2d6a2d; color: #fff;
    font-weight: bold; font-size: 10px;
    display: flex; align-items: center; justify-content: center;
    text-align: center; border-radius: 4px; line-height: 1.3;
  }
  .header-right { text-align: right; }
  .voucher-title { font-size: 15px; font-weight: 900; color: #2d6a2d; letter-spacing: 0.5px; text-transform: uppercase; }
  .invoice-date { font-size: 13px; color: #333; margin: 3px 0; }
  .invoice-no { font-size: 14px; font-weight: 800; color: #1a1a1a; text-transform: uppercase; }
  .billed-section { margin-bottom: 14px; position: relative; z-index: 1; }
  .billed-label { font-size: 12px; font-weight: 900; color: #2d6a2d; text-transform: uppercase; margin-bottom: 4px; }
  .billed-name { font-size: 13px; font-weight: 700; text-transform: uppercase; color: #111; }
  .billed-detail { font-size: 11px; color: #444; }
  hr { border: none; border-top: 1.5px solid #2d6a2d; margin: 10px 0; }
  .table-wrapper { position: relative; z-index: 1; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  thead tr { background: #2d6a2d; color: #fff; }
  thead th { padding: 7px 5px; text-align: center; font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.3px; }
  tbody td { padding: 6px 5px; text-align: center; border-bottom: 1px solid #e0e0e0; }
  .row-even { background: #fafafa; }
  .row-odd  { background: #f0f7f0; }
  .total-row td { background: #f0f7f0; font-weight: 700; border-top: 2px solid #2d6a2d; border-bottom: 2px solid #2d6a2d; color: #1a1a1a; }
  .total-amount { color: #2d6a2d; font-size: 12px; }
  .balance-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 10px; background: #fff8ec; border: 1px solid #e8c95a;
    border-radius: 3px; margin: 10px 0; position: relative; z-index: 1;
  }
  .balance-label { font-weight: 800; font-size: 12px; color: #b8860b; text-transform: uppercase; }
  .balance-value { font-weight: 900; font-size: 13px; color: ${totalBalance < 0 ? '#c0392b' : '#2d6a2d'}; }
  .amount-words {
    background: #f5fff5; border: 1.5px solid #2d6a2d; border-radius: 3px;
    padding: 8px 12px; font-size: 11.5px; font-weight: 800; color: #1a4f1a;
    text-transform: uppercase; letter-spacing: 0.3px; margin: 10px 0; position: relative; z-index: 1;
  }
  .quality-note { margin: 12px 0; padding: 10px 12px; background: #fffdf5; border-left: 3px solid #e8c95a; font-size: 10.5px; position: relative; z-index: 1; }
  .quality-note p { font-weight: 700; margin-bottom: 5px; }
  .quality-note ul { margin-left: 16px; margin-bottom: 8px; }
  .quality-note li { margin-bottom: 3px; }
  .quality-note .gratitude { font-style: italic; color: #555; line-height: 1.5; }
  .footer-company { margin-top: 8px; padding-top: 8px; border-top: 1.5px solid #2d6a2d; position: relative; z-index: 1; }
  .footer-company .company-name { font-size: 13px; font-weight: 900; color: #2d6a2d; text-transform: uppercase; }
  .footer-company .contact { font-size: 10px; color: #444; margin-top: 2px; }
  .signatures { display: flex; justify-content: space-between; margin-top: 40px; position: relative; z-index: 1; }
  .sig-block { text-align: center; width: 200px; }
  .sig-line { border-top: 1.5px solid #333; margin-bottom: 5px; }
  .sig-label { font-size: 11px; color: #333; font-weight: 600; }
  @media print { body { padding: 10px 15px; } }
</style>
</head>
<body>

${LOGO_BASE64 ? `<div class="watermark-bg"><img src="${LOGO_BASE64}" alt="watermark" /></div>` : ''}

<div class="header">
  <div class="logo-col">${logoImg}</div>
  <div class="header-right">
    <div class="voucher-title">DOOARS GREEN FPO PAYMENT VOUCHER</div>
    <div class="invoice-date">${invoiceDate}</div>
    <div class="invoice-no">INVOICE NO. ${invoiceNo}</div>
  </div>
</div>

<div class="billed-section">
  <div class="billed-label">BILLED TO:</div>
  <div class="billed-name">${merchantName}</div>
  <div class="billed-detail">DATE &ndash; ${dateStr}</div>
  <div class="billed-detail">TOTAL ENTRIES &ndash; ${transactions.length}</div>
</div>

<hr />

<div class="table-wrapper">
  <table>
    <thead>
      <tr>
        <th>DATE</th>
        <th>QTY (KG)</th>
        <th>LESS %</th>
        <th>LESS (KG)</th>
        <th>FINE LEAF %</th>
        <th>Net QTY</th>
        <th>RATE</th>
        <th>AMOUNT</th>
        <th>DESCRIPTION</th>
        <th>NET PAYABLE</th>
        <th>ADVANCE</th>
        <th>TOTAL</th>
      </tr>
    </thead>
    <tbody>


      ${txnRows}
      ${advanceRows}

      <tr class="total-row">
        <td><strong>Total</strong></td>
        <td>${fmt(totals.grossQty)}</td>
        <td>—</td>
        <td>${fmt(totals.lessQty)}</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>${fmt(totals.grossAmount)}</td>
        <td>—</td>
        <td>${fmt(totals.netPayable)}</td>
        <td>${fmt(totals.advancePayment)}</td>
        <td class="total-amount">${fmt(totals.finalPayable)}</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="balance-row" style="border-color: #2d6a2d; background: #f0f7f0;">
  <span class="balance-label" style="color: #1a5c1a;">GROSS PAYABLE (before advances):</span>
  <span class="balance-value" style="color: #1a5c1a;">${fmt(totals.finalPayable)}</span>
</div>
${totalPaymentsMade > 0 ? `<div class="balance-row" style="border-color: #2d6a2d; background: #f5fff5;">
  <span class="balance-label" style="color: #2d6a2d;">PAYMENTS MADE:</span>
  <span class="balance-value" style="color: #c0392b;">- ${fmt(totalPaymentsMade)}</span>
</div>` : ''}
${totalStandaloneAdv > 0 ? `<div class="balance-row" style="border-color: #e8a000; background: #fff8ec;">
  <span class="balance-label" style="color: #8b4513;">ADVANCE GIVEN:</span>
  <span class="balance-value" style="color: #c0392b;">- ${fmt(totalStandaloneAdv)}</span>
</div>` : ''}
<div class="balance-row">
  <span class="balance-label">NET AMOUNT PAYABLE:</span>
  <span class="balance-value">${fmt(netFinalAmount)}</span>
</div>

<div class="amount-words">
  NET PAYABLE &gt; ${numberToWords(netFinalAmount)}
</div>
${totals.advancePayment > 0 ? `
<div class="amount-words" style="background: #fdf5f5; border-color: #c0392b; color: #a93226; margin-top: 6px;">
  TOTAL ADVANCE &gt; ${numberToWords(totals.advancePayment)}
</div>
` : ''}

<div class="quality-note">
  <p>Please note the following quality deductions:</p>
  <ul>
    <li>Hand plucking: 2% deduction per delivery</li>
    <li>Machine plucking: 4% deduction per delivery</li>
    <li>Rainy days: deduction varies based on leaf moisture at the time of collection</li>
  </ul>
  <p class="gratitude">
    We are grateful for the trust and cooperation of every Small Tea Grower in our community.<br />
    Your commitment to quality green leaves strengthens all of us — thank you for being a vital part of this journey together.
  </p>
</div>

<hr />

<div class="footer-company">
  <div class="company-name">DOOARS GREEN FPO</div>
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
/**
 * GET /api/merchant-transactions/invoice/by-merchant-date
 * Query params:
 *   merchantName  (string, required)
 *   date          (ISO date string, optional)  e.g. "2025-09-19"
 *   startDate     (ISO date string, optional)
 *   endDate       (ISO date string, optional)
 *   format        'pdf' | 'html'  (default: pdf)
 */
exports.generateInvoiceByMerchantDate = async (req, res) => {
  try {
    const { merchantName, date, startDate, endDate, format = 'pdf' } = req.query;

    if (!merchantName) {
      return res.status(400).json({
        success: false,
        message: '`merchantName` query param is required',
      });
    }

    const finalStart = startDate || date;
    const finalEnd = endDate || date;

    if (!finalStart || !finalEnd) {
      return res.status(400).json({
        success: false,
        message: '`date` or `startDate` and `endDate` query params are required',
      });
    }

    // Build date range for the full day
    const MathStart = new Date(finalStart);
    MathStart.setHours(0, 0, 0, 0);
    const MathEnd   = new Date(finalEnd);
    MathEnd.setHours(23, 59, 59, 999);

    const transactions = await MerchantTransaction.find({
      merchantName: { $regex: new RegExp(`^${merchantName.trim()}$`, 'i') },
      transactionDate: { $gte: MathStart, $lte: MathEnd },
    }).sort('transactionDate').lean();

    if (transactions.length === 0) {
      const msgDate = (finalStart === finalEnd) ? finalStart : `${finalStart} to ${finalEnd}`;
      return res.status(404).json({
        success: false,
        message: `No transactions found for "${merchantName}" on ${msgDate}`,
      });
    }

    // Fetch all payments for these transactions in one query
    const txnIds = transactions.map((t) => t._id);
    const [allPayments, merchant] = await Promise.all([
      MerchantPayment.find({ transaction: { $in: txnIds } }).lean(),
      Merchant.findOne({ name: { $regex: new RegExp(`^${merchantName.trim()}$`, 'i') } }).lean(),
    ]);

    // Group payments by transactionId
    const paymentsMap = {};
    allPayments.forEach((p) => {
      const key = p.transaction.toString();
      if (!paymentsMap[key]) paymentsMap[key] = [];
      paymentsMap[key].push(p);
    });

    // Fetch standalone advance payments for this merchant in this date range
    let standaloneAdvances = [];
    if (merchant) {
      standaloneAdvances = await MerchantAdvance.find({
        merchant: merchant._id,
        advanceDate: { $gte: MathStart, $lte: MathEnd },
      }).sort('advanceDate').lean();
    }

    const html = buildMultiInvoiceHtml(merchantName, finalStart, finalEnd, transactions, paymentsMap, standaloneAdvances);

    // ── HTML preview ──────────────────────────────────────────────────────────
    if (format.toLowerCase() === 'html') {
      return res.setHeader('Content-Type', 'text/html').send(html);
    }

    // ── PDF via shared helper (production-safe) ──────────────────────────────
    const buffer = await generatePdf(html);
    const safeName = merchantName.replace(/\s+/g, '_').toUpperCase();
    const safeDate = (finalStart === finalEnd) ? finalStart.replace(/-/g, '') : `${finalStart.replace(/-/g, '')}_${finalEnd.replace(/-/g, '')}`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${safeName}-${safeDate}.pdf"`);
    res.send(buffer);

  } catch (err) {
    console.error('[invoiceController.generateInvoiceByMerchantDate] Error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to generate invoice: ' + err.message });
  }
};

// ── Shared PDF helper — uses system Chromium installed via Dockerfile ──────────
async function generatePdf(html) {
  const puppeteer = require('puppeteer-core');

  // System chromium path set by Dockerfile ENV
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const buffer = await page.pdf({
      format: 'A4',
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
      printBackground: true,
    });
    return buffer;
  } finally {
    await browser.close();
  }
}

// ── Build Factory Invoice HTML ─────────────────────────────────────────────────
function buildFactoryInvoiceHtml(record) {
  const logoImg = LOGO_BASE64
    ? `<img src="${LOGO_BASE64}" alt="logo" class="logo-img" />`
    : `<div class="logo-placeholder">DOOARS<br>GREEN<br>FPO</div>`;

  const qty       = record.totalQuantity  || 0;
  const lessPct   = record.lessPercentage || 0;
  const lessQty   = parseFloat(((qty * lessPct) / 100).toFixed(2));
  const netQty    = parseFloat((qty - lessQty).toFixed(2));
  const fine      = record.fineLeaf       || 0;
  const rate      = record.rate           || 0;
  const totalAmt  = parseFloat((netQty * rate).toFixed(2));
  const advance   = record.advance        || 0;
  const totalPaid = (record.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const due       = parseFloat((totalAmt - advance - totalPaid).toFixed(2));
  const invoiceDate = fmtDateLong(record.date || record.createdAt);
  const invoiceNo   = String(record._id).slice(-6).toUpperCase();

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<title>Factory Invoice - ${record.buyerName || ''}</title>
<style>
* { margin:0;padding:0;box-sizing:border-box; }
body { font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#222;background:#fff;padding:16px 20px; }
.watermark-bg { position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);width:460px;height:460px;opacity:0.1;z-index:-10;pointer-events:none; }
.watermark-bg img { width:100%;height:100%;object-fit:contain; }
.header { display:flex;align-items:flex-start;justify-content:space-between;padding-bottom:10px;border-bottom:2.5px solid #2d6a2d;margin-bottom:12px;position:relative;z-index:1; }
.logo-img { width:90px;height:90px;object-fit:contain; }
.logo-placeholder { width:90px;height:90px;background:#2d6a2d;color:#fff;font-weight:bold;font-size:10px;display:flex;align-items:center;justify-content:center;text-align:center;border-radius:4px;line-height:1.3; }
.header-right { text-align:right; }
.voucher-title { font-size:15px;font-weight:900;color:#2d6a2d;letter-spacing:0.5px;text-transform:uppercase; }
.invoice-date { font-size:13px;color:#333;margin:3px 0; }
.invoice-no { font-size:14px;font-weight:800;color:#1a1a1a;text-transform:uppercase; }
.billed-section { margin-bottom:14px;position:relative;z-index:1; }
.billed-label { font-size:12px;font-weight:900;color:#2d6a2d;text-transform:uppercase;margin-bottom:4px; }
.billed-name { font-size:13px;font-weight:700;text-transform:uppercase;color:#111; }
.billed-detail { font-size:11px;color:#444; }
hr { border:none;border-top:1.5px solid #2d6a2d;margin:10px 0; }
.table-wrapper { position:relative;z-index:1;overflow-x:auto; }
table { width:100%;border-collapse:collapse;font-size:10.5px; }
thead tr { background:#2d6a2d;color:#fff; }
thead th { padding:8px 6px;text-align:center;font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:0.3px; }
tbody td { padding:7px 6px;text-align:center;border-bottom:1px solid #e0e0e0; }
.row-even { background:#fafafa; } .row-odd { background:#f0f7f0; }
.total-row td { background:#f0f7f0;font-weight:700;border-top:2px solid #2d6a2d;border-bottom:2px solid #2d6a2d; }
.total-amount { color:#2d6a2d;font-size:12px;font-weight:900; }
.summary-box { margin:14px 0;display:flex;flex-direction:column;gap:6px;position:relative;z-index:1; }
.summary-row { display:flex;justify-content:space-between;align-items:center;padding:6px 12px;border-radius:4px; }
.summary-row.gross   { background:#f0f7f0;border:1px solid #2d6a2d; }
.summary-row.advance { background:#fff8ec;border:1px solid #e8c95a; }
.summary-row.due-row { background:${due > 0 ? '#fff1f1' : '#f0fff0'};border:1px solid ${due > 0 ? '#c0392b' : '#2d6a2d'}; }
.summary-label { font-weight:700;font-size:11px;color:#333;text-transform:uppercase; }
.summary-value { font-weight:900;font-size:13px; }
.amount-words { background:#f5fff5;border:1.5px solid #2d6a2d;border-radius:3px;padding:8px 12px;font-size:11.5px;font-weight:800;color:#1a4f1a;text-transform:uppercase;letter-spacing:0.3px;margin:10px 0;position:relative;z-index:1; }
.footer-company { margin-top:8px;padding-top:8px;border-top:1.5px solid #2d6a2d;position:relative;z-index:1; }
.footer-company .company-name { font-size:13px;font-weight:900;color:#2d6a2d;text-transform:uppercase; }
.footer-company .contact { font-size:10px;color:#444;margin-top:2px; }
.signatures { display:flex;justify-content:space-between;margin-top:40px;position:relative;z-index:1; }
.sig-block { text-align:center;width:200px; }
.sig-line { border-top:1.5px solid #333;margin-bottom:5px; }
.sig-label { font-size:11px;color:#333;font-weight:600; }
@media print { body { padding:10px 15px; } }
</style></head><body>
${LOGO_BASE64 ? `<div class="watermark-bg"><img src="${LOGO_BASE64}" alt="watermark" /></div>` : ''}
<div class="header">
  <div class="logo-col">${logoImg}</div>
  <div class="header-right">
    <div class="voucher-title">DOOARS GREEN FPO &mdash; FACTORY INVOICE</div>
    <div class="invoice-date">${invoiceDate}</div>
    <div class="invoice-no">INVOICE NO. FCT-${invoiceNo}</div>
  </div>
</div>
<div class="billed-section">
  <div class="billed-label">BUYER / PARTY:</div>
  <div class="billed-name">${record.buyerName || '&mdash;'}</div>
  <div class="billed-detail">DATE &ndash; ${fmtDate(record.date)}</div>
  ${record.remarks ? `<div class="billed-detail">REMARKS &ndash; ${record.remarks}</div>` : ''}
</div>
<hr />
<div class="table-wrapper">
  <table>
    <thead><tr>
      <th style="text-align:center;width:40px;">Sl No.</th>
      <th style="text-align:center;">Date</th>
      <th style="text-align:center;">Tea Type</th>
      <th style="text-align:right;">Total QTY<br/>(kg)</th>
      <th style="text-align:right;">Less %</th>
      <th style="text-align:right;">Less QTY<br/>(kg)</th>
      <th style="text-align:right;">Net QNTY<br/>(kg)</th>
      <th style="text-align:right;">Fine %</th>
      <th style="text-align:right;">Rate<br/>(&#8377;/kg)</th>
      <th style="text-align:right;">Total AMT.<br/>(&#8377;)</th>
    </tr></thead>
    <tbody>
      <tr class="row-even">
        <td style="text-align:center;">1</td>
        <td style="text-align:center;">${fmtDate(record.date)}</td>
        <td style="text-align:center;font-weight:bold;color:#444;">${record.teaType || 'CTC'}</td>
        <td style="text-align:right;">${fmt(qty)}</td>
        <td style="text-align:right;">${lessPct > 0 ? lessPct + '%' : '&mdash;'}</td>
        <td style="text-align:right;">${fmt(lessQty)}</td>
        <td style="text-align:right;font-weight:bold;color:#2d6a2d;">${fmt(netQty)}</td>
        <td style="text-align:right;">${fine > 0 ? fine + '%' : '&mdash;'}</td>
        <td style="text-align:right;">${fmt(rate)}</td>
        <td style="text-align:right;font-weight:bold;">&#8377;${fmt(totalAmt)}</td>
      </tr>
      ${(record.payments || []).map(p => `
      <tr class="row-odd" style="font-style: italic; color: #444; background: #fafafa;">
        <td style="text-align:center;"></td>
        <td style="text-align:center;">${fmtDate(p.date)}</td>
        <td colspan="7" style="text-align: right; padding-right: 15px;">Payment (${p.mode || 'Cash'})</td>
        <td style="color: #2d6a2d; font-weight: bold; text-align:right;">- &#8377;${fmt(p.amount)}</td>
      </tr>`).join('')}
      <tr class="total-row">
        <td colspan="4" style="text-align:left;padding-left:8px;"><strong>GRAND TOTAL</strong></td>
        <td>&mdash;</td>
        <td style="text-align:right;"><strong>${fmt(lessQty)}</strong></td>
        <td style="text-align:right;"><strong>${fmt(netQty)}</strong></td>
        <td>&mdash;</td>
        <td>&mdash;</td>
        <td class="total-amount" style="text-align:right;">&#8377;${fmt(totalAmt)}</td>
      </tr>
    </tbody>
  </table>
</div>
<div class="summary-box">
  <div class="summary-row gross">
    <span class="summary-label">Total Amount</span>
    <span class="summary-value" style="color:#2d6a2d;">&#8377;${fmt(totalAmt)}</span>
  </div>
  ${advance > 0 ? `<div class="summary-row advance"><span class="summary-label">Advance Paid</span><span class="summary-value" style="color:#b8860b;">- &#8377;${fmt(advance)}</span></div>` : ''}
  ${totalPaid > 0 ? `<div class="summary-row advance"><span class="summary-label">Payments Received</span><span class="summary-value" style="color:#c0392b;">- &#8377;${fmt(totalPaid)}</span></div>` : ''}
  <div class="summary-row due-row">
    <span class="summary-label">${due > 0 ? 'Balance Due' : 'Status'}</span>
    <span class="summary-value" style="color:${due > 0 ? '#c0392b' : '#2d6a2d'};">${due > 0 ? '&#8377;' + fmt(due) : '&#10003; CLEARED'}</span>
  </div>
</div>
<div class="amount-words">TOTAL AMOUNT &gt; ${numberToWords(totalAmt)}</div>
<hr />
<div class="footer-company">
  <div class="company-name">DOOARS GREEN FPO</div>
  <div class="contact">Email &ndash; dooarsgreenfpo@gmail.com</div>
  <div class="contact">Cont &ndash; 9800415644, 8101507292, 8972495852, 8967829553</div>
</div>
<div class="signatures">
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Authorized By</div></div>
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Received By</div></div>
</div>
</body></html>`;
}

// ── Controller: Factory Invoice ────────────────────────────────────────────────
/**
 * GET /api/factory/:id/invoice
 * GET /api/factory/:id/invoice?format=html   (browser preview)
 * NEW function — does NOT modify any existing controller.
 */
exports.generateFactoryInvoice = async (req, res) => {
  try {
    const { id }  = req.params;
    const format  = (req.query.format || 'pdf').toLowerCase();
    const Factory = require('../models/Factory');

    console.log(`[invoiceController.generateFactoryInvoice] id=${id} format=${format}`);

    const record = await Factory.findById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Factory record not found' });
    }

    const html = buildFactoryInvoiceHtml(record.toObject({ virtuals: true }));

    if (format === 'html') {
      return res.setHeader('Content-Type', 'text/html').send(html);
    }

    const buffer    = await generatePdf(html);
    const safeBuyer = (record.buyerName || 'factory').replace(/\s+/g, '_').toUpperCase();
    const safeDate  = fmtDate(record.date).replace(/\//g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factory-invoice-${safeBuyer}-${safeDate}.pdf"`);
    res.send(buffer);

  } catch (err) {
    console.error('[invoiceController.generateFactoryInvoice] Error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Failed to generate factory invoice: ' + err.message });
  }
};

// ── Build Multi-Record Factory Invoice HTML ──────────────────────────────────
function buildMultiFactoryInvoiceHtml(buyerName, records) {
  const logoImg = LOGO_BASE64
    ? `<img src="${LOGO_BASE64}" alt="logo" class="logo-img" />`
    : `<div class="logo-placeholder">DOOARS<br>GREEN<br>FPO</div>`;

  const invoiceDate = fmtDateLong(new Date());
  
  let grandTotalQty = 0;
  let grandLessQty = 0;
  let grandNetQty = 0;
  let grandTotalAmt = 0;
  let grandAdvance = 0;
  let grandPaid = 0;

  const dataRows = records.map((record, i) => {
    const qty       = record.totalQuantity  || 0;
    const lessPct   = record.lessPercentage || 0;
    const lessQty   = parseFloat(((qty * lessPct) / 100).toFixed(2));
    const netQty    = parseFloat((qty - lessQty).toFixed(2));
    const fine      = record.fineLeaf       || 0;
    const rate      = record.rate           || 0;
    const totalAmt  = parseFloat((netQty * rate).toFixed(2));
    const advance   = record.advance        || 0;
    const totalPaid = (record.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    
    grandTotalQty += qty;
    grandLessQty += lessQty;
    grandNetQty += netQty;
    grandTotalAmt += totalAmt;
    grandAdvance += advance;
    grandPaid += totalPaid;

    // Create sub-rows for payments
    const payments = record.payments || [];
    const paymentRows = payments.map(p => `
      <tr class="row-even" style="font-style: italic; color: #444; background: #fafafa;">
        <td style="text-align:center;"></td>
        <td style="text-align:center;">${fmtDate(p.date)}</td>
        <td colspan="7" style="text-align: right; padding-right: 15px;">Payment (${p.mode || 'Cash'})</td>
        <td style="color: #2d6a2d; font-weight: bold; text-align:right;">- &#8377;${fmt(p.amount)}</td>
      </tr>
    `).join('');

    return `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td style="text-align:center;">${i + 1}</td>
        <td style="text-align:center;">${fmtDate(record.date)}</td>
        <td style="text-align:center;font-weight:bold;color:#444;">${record.teaType || 'CTC'}</td>
        <td style="text-align:right;">${fmt(qty)}</td>
        <td style="text-align:right;">${lessPct > 0 ? lessPct + '%' : '&mdash;'}</td>
        <td style="text-align:right;">${fmt(lessQty)}</td>
        <td style="text-align:right;font-weight:bold;color:#2d6a2d;">${fmt(netQty)}</td>
        <td style="text-align:right;">${fine > 0 ? fine + '%' : '&mdash;'}</td>
        <td style="text-align:right;">${fmt(rate)}</td>
        <td style="text-align:right;font-weight:bold;">&#8377;${fmt(totalAmt)}</td>
      </tr>
      ${paymentRows}
    `;
  }).join('');

  const due = parseFloat((grandTotalAmt - grandAdvance - grandPaid).toFixed(2));

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<title>Factory Statement - ${buyerName}</title>
<style>
* { margin:0;padding:0;box-sizing:border-box; }
body { font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#222;background:#fff;padding:16px 20px; }
.watermark-bg { position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);width:460px;height:460px;opacity:0.1;z-index:-10;pointer-events:none; }
.watermark-bg img { width:100%;height:100%;object-fit:contain; }
.header { display:flex;align-items:flex-start;justify-content:space-between;padding-bottom:10px;border-bottom:2.5px solid #2d6a2d;margin-bottom:12px;position:relative;z-index:1; }
.logo-img { width:90px;height:90px;object-fit:contain; }
.logo-placeholder { width:90px;height:90px;background:#2d6a2d;color:#fff;font-weight:bold;font-size:10px;display:flex;align-items:center;justify-content:center;text-align:center;border-radius:4px;line-height:1.3; }
.header-right { text-align:right; }
.voucher-title { font-size:15px;font-weight:900;color:#2d6a2d;letter-spacing:0.5px;text-transform:uppercase; }
.invoice-date { font-size:13px;color:#333;margin:3px 0; }
.invoice-no { font-size:14px;font-weight:800;color:#1a1a1a;text-transform:uppercase; }
.billed-section { margin-bottom:14px;position:relative;z-index:1; }
.billed-label { font-size:12px;font-weight:900;color:#2d6a2d;text-transform:uppercase;margin-bottom:4px; }
.billed-name { font-size:13px;font-weight:700;text-transform:uppercase;color:#111; }
hr { border:none;border-top:1.5px solid #2d6a2d;margin:10px 0; }
.table-wrapper { position:relative;z-index:1;overflow-x:auto; }
table { width:100%;border-collapse:collapse;font-size:10.5px; }
thead tr { background:#2d6a2d;color:#fff; }
thead th { padding:8px 6px;text-align:center;font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:0.3px; }
tbody td { padding:7px 6px;text-align:center;border-bottom:1px solid #e0e0e0; }
.row-even { background:#fafafa; } .row-odd { background:#f0f7f0; }
.total-row td { background:#f0f7f0;font-weight:700;border-top:2px solid #2d6a2d;border-bottom:2px solid #2d6a2d; }
.total-amount { color:#2d6a2d;font-size:12px;font-weight:900; }
.summary-box { margin:14px 0;display:flex;flex-direction:column;gap:6px;position:relative;z-index:1; }
.summary-row { display:flex;justify-content:space-between;align-items:center;padding:6px 12px;border-radius:4px; }
.summary-row.gross   { background:#f0f7f0;border:1px solid #2d6a2d; }
.summary-row.advance { background:#fff8ec;border:1px solid #e8c95a; }
.summary-row.due-row { background:${due > 0 ? '#fff1f1' : '#f0fff0'};border:1px solid ${due > 0 ? '#c0392b' : '#2d6a2d'}; }
.summary-label { font-weight:700;font-size:11px;color:#333;text-transform:uppercase; }
.summary-value { font-weight:900;font-size:13px; }
.amount-words { background:#f5fff5;border:1.5px solid #2d6a2d;border-radius:3px;padding:8px 12px;font-size:11.5px;font-weight:800;color:#1a4f1a;text-transform:uppercase;letter-spacing:0.3px;margin:10px 0;position:relative;z-index:1; }
.footer-company { margin-top:8px;padding-top:8px;border-top:1.5px solid #2d6a2d;position:relative;z-index:1; }
.footer-company .company-name { font-size:13px;font-weight:900;color:#2d6a2d;text-transform:uppercase; }
.footer-company .contact { font-size:10px;color:#444;margin-top:2px; }
.signatures { display:flex;justify-content:space-between;margin-top:40px;position:relative;z-index:1; }
.sig-block { text-align:center;width:200px; }
.sig-line { border-top:1.5px solid #333;margin-bottom:5px; }
.sig-label { font-size:11px;color:#333;font-weight:600; }
@media print { body { padding:10px 15px; } }
</style></head><body>
${LOGO_BASE64 ? `<div class="watermark-bg"><img src="${LOGO_BASE64}" alt="watermark" /></div>` : ''}
<div class="header">
  <div class="logo-col">${logoImg}</div>
  <div class="header-right">
    <div class="voucher-title">DOOARS GREEN FPO &mdash; FACTORY STATEMENT</div>
    <div class="invoice-date">${invoiceDate}</div>
  </div>
</div>
<div class="billed-section">
  <div class="billed-label">BUYER / PARTY:</div>
  <div class="billed-name">${buyerName}</div>
</div>
<hr />
<div class="table-wrapper">
  <table>
    <thead><tr>
      <th style="text-align:center;width:40px;">Sl No.</th>
      <th style="text-align:center;">Date</th>
      <th style="text-align:center;">Tea Type</th>
      <th style="text-align:right;">Total QTY<br/>(kg)</th>
      <th style="text-align:right;">Less %</th>
      <th style="text-align:right;">Less QTY<br/>(kg)</th>
      <th style="text-align:right;">Net QNTY<br/>(kg)</th>
      <th style="text-align:right;">Fine %</th>
      <th style="text-align:right;">Rate<br/>(&#8377;/kg)</th>
      <th style="text-align:right;">Total AMT.<br/>(&#8377;)</th>
    </tr></thead>
    <tbody>
      ${dataRows}
      <tr class="total-row">
        <td colspan="3" style="text-align:left;padding-left:8px;"><strong>GRAND TOTAL</strong></td>
        <td style="text-align:right;"><strong>${fmt(grandTotalQty)}</strong></td>
        <td>&mdash;</td>
        <td style="text-align:right;"><strong>${fmt(grandLessQty)}</strong></td>
        <td style="text-align:right;color:#2d6a2d;"><strong>${fmt(grandNetQty)}</strong></td>
        <td>&mdash;</td>
        <td>&mdash;</td>
        <td class="total-amount" style="text-align:right;">&#8377;${fmt(grandTotalAmt)}</td>
      </tr>
    </tbody>
  </table>
</div>
<div class="summary-box">
  <div class="summary-row gross">
    <span class="summary-label">Total Amount</span>
    <span class="summary-value" style="color:#2d6a2d;">&#8377;${fmt(grandTotalAmt)}</span>
  </div>
  ${grandAdvance > 0 ? `<div class="summary-row advance"><span class="summary-label">Advance Paid</span><span class="summary-value" style="color:#b8860b;">- &#8377;${fmt(grandAdvance)}</span></div>` : ''}
  ${grandPaid > 0 ? `<div class="summary-row advance"><span class="summary-label">Payments Received</span><span class="summary-value" style="color:#c0392b;">- &#8377;${fmt(grandPaid)}</span></div>` : ''}
  <div class="summary-row due-row">
    <span class="summary-label">${due > 0 ? 'Balance Due' : 'Status'}</span>
    <span class="summary-value" style="color:${due > 0 ? '#c0392b' : '#2d6a2d'};">${due > 0 ? '&#8377;' + fmt(due) : '&#10003; CLEARED'}</span>
  </div>
</div>
<div class="amount-words">TOTAL AMOUNT &gt; ${numberToWords(grandTotalAmt)}</div>
<hr />
<div class="footer-company">
  <div class="company-name">DOOARS GREEN FPO</div>
  <div class="contact">Email &ndash; dooarsgreenfpo@gmail.com</div>
  <div class="contact">Cont &ndash; 9800415644, 8101507292, 8972495852, 8967829553</div>
</div>
<div class="signatures">
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Authorized By</div></div>
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Received By</div></div>
</div>
</body></html>`;
}

// ── Controller: Factory Multi-Invoice By Buyer ─────────────────────────────────
exports.generateFactoryInvoiceByBuyer = async (req, res) => {
  try {
    const { buyerName } = req.query;
    const format = (req.query.format || 'pdf').toLowerCase();
    
    if (!buyerName) {
      return res.status(400).json({ success: false, message: 'buyerName is required' });
    }

    const Factory = require('../models/Factory');
    const records = await Factory.find({ 
      buyerName: { $regex: new RegExp(`^${buyerName.trim()}$`, 'i') } 
    }).sort('date').lean({ virtuals: true });

    if (!records || records.length === 0) {
      return res.status(404).json({ success: false, message: 'No records found for this buyer' });
    }

    const html = buildMultiFactoryInvoiceHtml(buyerName, records);

    if (format === 'html') {
      return res.setHeader('Content-Type', 'text/html').send(html);
    }

    const buffer = await generatePdf(html);
    const safeBuyer = buyerName.replace(/\s+/g, '_').toUpperCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factory-statement-${safeBuyer}-${Date.now()}.pdf"`);
    res.send(buffer);

  } catch (err) {
    console.error('[invoiceController.generateFactoryInvoiceByBuyer] Error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Failed to generate factory statement: ' + err.message });
  }
};
