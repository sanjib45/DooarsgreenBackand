# DOOARS GREEN FPO — System Documentation

> **Version:** 2.0 (Production)  
> **Updated:** July 2026  
> **Stack:** Node.js · Express · MongoDB Atlas · Puppeteer · React (Vite)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Environment Variables](#2-environment-variables)
3. [API Routes Reference](#3-api-routes-reference)
4. [Filter System](#4-filter-system)
5. [PDF Generation Flow](#5-pdf-generation-flow)
6. [Invoice Template Guide](#6-invoice-template-guide)
7. [Security](#7-security)
8. [MongoDB Index Strategy](#8-mongodb-index-strategy)
9. [Frontend Components](#9-frontend-components)
10. [Deployment Guide](#10-deployment-guide)
11. [Known Issues & Fixes](#11-known-issues--fixes)

---

## 1. Architecture Overview

```
Browser  ──▶  Vite (React)  ──▶  Express API  ──▶  MongoDB Atlas
                                      │
                                 Puppeteer (PDF)
                                      │
                               @sparticuz/chromium (Serverless)
```

**Backend port:** `8080` (configured via `PORT` env var)  
**Frontend:** Deployed to Vercel  
**Backend:** Deployable to Railway / Render / Docker / Vercel Serverless

---

## 2. Environment Variables

### Backend

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | Server port (default `8080`) |
| `NODE_ENV` | Yes | `production` or `development` |
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `JWT_SECRET` | Yes | Access token secret |
| `JWT_REFRESH_SECRET` | Yes | Refresh token secret |
| `JWT_ACCESS_EXPIRES_IN` | Yes | e.g. `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Yes | e.g. `7d` |
| `ALLOWED_ORIGINS` | Yes | Comma-separated frontend URLs |
| `PUPPETEER_EXECUTABLE_PATH` | Optional | Path to Chrome/Chromium binary |

### Frontend

| Variable | Required | Description |
|---|---|---|
| `VITE_API_BASE_URL` | Yes | Backend API URL |

---

## 3. API Routes Reference

### Merchant Transactions (`/api/merchant-transactions`)

**GET Query Params — all combine with AND logic:**

| Param | Description |
|---|---|
| `search` | Partial match on merchantName **OR** merchantPhone |
| `phone` | Explicit phone filter |
| `merchantName` | Name only filter |
| `teaType` | `Green Tea`, `CTC`, or `Other` |
| `startDate` | ISO date range start |
| `endDate` | ISO date range end (inclusive full day) |

**Invoice endpoints:**
```
GET /api/merchant-transactions/:id/invoice?format=pdf|html
GET /api/merchant-transactions/invoice/by-merchant-date?merchantName=...&startDate=...&endDate=...
```

### Factory (`/api/factory`)

**GET Query Params — all combine with AND logic:**

| Param | Description |
|---|---|
| `search` | Partial match on buyerName **OR** buyer phone |
| `name` | buyerName only |
| `phone` | Buyer phone only |
| `startDate` | Date range start |
| `endDate` | Date range end |

**Invoice endpoints:**
```
GET /api/factory/:id/invoice?format=pdf|html
GET /api/factory/invoice/by-buyer?buyerName=...
```

### Error Response Format

```json
{
  "success": false,
  "message": "Human-readable error",
  "errors": [{ "field": "grossQty", "message": "must be positive" }]
}
```

---

## 4. Filter System

All active filters combine with **AND logic** using `$and`:

```js
// Example: search="Ramesh" AND teaType="Green Tea" AND date range
{
  $and: [
    { $or: [{ merchantName: /Ramesh/i }, { merchantPhone: /Ramesh/i }, { merchant: { $in: [...] } }] },
    { teaType: 'Green Tea' },
    { transactionDate: { $gte: start, $lte: end } }
  ]
}
```

All user input is sanitized before regex use to prevent ReDoS:
```js
const safe = input.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

---

## 5. PDF Generation Flow

```
generatePdf(html) called
  1. Resolve Chromium path:
     a. PUPPETEER_EXECUTABLE_PATH env var (Railway/Docker)
     b. @sparticuz/chromium (Vercel Serverless)
     c. Windows: C:\Program Files\Google\Chrome\...
     d. Linux: /usr/bin/chromium-browser
  2. puppeteer.launch({ headless: 'new', args: [...no-sandbox flags] })
  3. page.setContent(html, { waitUntil: 'networkidle0' })
  4. page.pdf({ format: 'A4', printBackground: true })
  5. Return Buffer.from(pdfData)
  6. browser.close() (in finally block — always runs)
```

---

## 6. Invoice Template Guide

### Rupee Symbol
Use `&#x20B9;` (stored as `const RS` in invoiceController.js) — NOT the UTF-8 `₹` literal.

### Header Single-Line Fix
```css
thead th { white-space: nowrap; }
```

### Watermark Fix
```css
.watermark-bg {
  position: fixed;   /* NOT absolute */
  z-index: 0;        /* NOT -10 */
  opacity: 0.07;
}
/* All content: z-index: 1 to appear above watermark */
```

### Column Alignment
- Numbers: `text-align: right` (class `num`)
- Text: `text-align: left` (class `left`)
- Table uses `<colgroup>` for proportional width control

---

## 7. Security

| Measure | Implementation |
|---|---|
| Helmet headers | `helmet()` in app.js |
| Rate limiting | 300 req/2min via `express-rate-limit` |
| CORS allowlist | Only `ALLOWED_ORIGINS` accepted |
| Input validation | `express-validator` on all mutation routes |
| Regex sanitization | All filter strings escaped before MongoDB regex |
| JWT auth | httpOnly refresh cookie + short-lived access token |
| No stack in prod | errorHandler hides stack when `NODE_ENV=production` |

---

## 8. MongoDB Index Strategy

### MerchantTransaction
```
{ merchantName: 1, transactionDate: -1 }
{ merchantPhone: 1, transactionDate: -1 }
{ merchant: 1, transactionDate: -1 }
{ transactionDate: -1 }
{ teaType: 1, transactionDate: -1 }
{ transactionId: 1 }   // unique
```

### Merchant
```
{ name: 'text' }   // text search
{ phone: 1 }       // unique
```

### Factory
```
{ buyer: 1, date: -1 }
{ date: -1 }
{ buyerName: 1 }
```

---

## 9. Frontend Components

| Component | Purpose |
|---|---|
| `MerchantTableFilters` | Name+phone search, date preset, tea type — with Clear All button |
| `MerchantTransactionTable` | Paginated table with edit/delete/detail |
| `MerchantTransactionForm` | Create/edit with live field calculations |
| `MerchantProfileDrawer` | Merchant history + invoice generation |
| `BuyerHistoryDrawer` | Buyer history + factory invoice |
| `SearchableSelect` | Async autocomplete for Merchant/Buyer selection |
| `ConfirmationModal` | Reusable delete confirm |
| `CustomDateRangeModal` | Date range picker |

---

## 10. Deployment Guide

### Railway (recommended for backend)

```bash
# Required env vars on Railway dashboard:
PORT=8080
NODE_ENV=production
MONGO_URI=mongodb+srv://...
JWT_SECRET=<strong-secret>
JWT_REFRESH_SECRET=<strong-secret>
ALLOWED_ORIGINS=https://your-frontend.vercel.app
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

### Docker
```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y chromium --no-install-recommends
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

### Vercel (frontend)
1. Connect `Dooars greenfrontend` to Vercel
2. Set `VITE_API_BASE_URL=https://your-backend.railway.app/api`
3. Build command: `npm run build`, Output: `dist`

---

## 11. Known Issues & Fixes

| Issue | Root Cause | Fix Applied |
|---|---|---|
| ₹ shows as `?` in PDF | UTF-8 literal in HTML | Use `&#x20B9;` HTML entity |
| Table headers wrap to 2 lines | No `white-space: nowrap` | Added to `thead th` + colgroup widths |
| Watermark blocks row backgrounds | `z-index: -10` on watermark | Changed to `fixed` + `z-index: 0`; content at `z-index: 1` |
| Puppeteer require() crash | puppeteer-core v21+ is ESM | Use `await import('puppeteer-core')` |
| Chrome path hardcoded to Windows | No multi-platform detection | Platform-aware path resolution + env var support |
| Phone search not filtering | Only name was searched | Denormalized `merchantPhone` field + `$or` across name, phone, merchant ID |
| AND filter broken | Multiple params overwrote each other | Refactored to `andConditions[]` → `{ $and: [...] }` |
| Negative balance shown as `0` on merchant PDFs | `Math.max(0, ...)` floored `netFinalAmount` whenever advances/payments exceeded the gross payable | Removed the `Math.max(0, ...)` clamp so `netFinalAmount` can render negative values in `buildMultiInvoiceHtml` (`controllers/invoiceController.js`) |
| Merchant invoice TOTAL row missing avg LESS%, RATE, L.RATE, NET QTY | Total reducer in `buildMultiInvoiceHtml` didn't accumulate `netQty`, `labourHeadCount`, `labourAmount`, `lessPercent`, `ratePerKg`, `labourCharge` | Extended the totals reducer and derived `avgLessPercent`, `avgRate`, `avgLabourCharge` (division by transaction count) so every TOTAL row column is populated |
