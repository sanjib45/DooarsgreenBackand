# DOOARS GREEN FPO — System Documentation

> **Version:** 2.1 (Production)  
> **Updated:** July 2026  
> **Stack:** Node.js · Express · MongoDB Atlas · Puppeteer · React (Vite)  
> **Package name:** `teanest-backend`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Environment Variables](#2-environment-variables)
3. [Data Isolation](#3-data-isolation)
4. [API Routes Reference](#4-api-routes-reference)
5. [Filter System](#5-filter-system)
6. [Merchant Transaction Calculations](#6-merchant-transaction-calculations)
7. [PDF Generation Flow](#7-pdf-generation-flow)
8. [Invoice Template Guide](#8-invoice-template-guide)
9. [Security](#9-security)
10. [MongoDB Index Strategy](#10-mongodb-index-strategy)
11. [Frontend Components](#11-frontend-components)
12. [Deployment Guide](#12-deployment-guide)
13. [Migration Scripts](#13-migration-scripts)
14. [Known Issues & Fixes](#14-known-issues--fixes)

---

## 1. Architecture Overview

```
Browser  ──▶  Vite (React)  ──▶  Express API  ──▶  MongoDB Atlas
                                      │
                                 Puppeteer (PDF)
                                      │
                               @sparticuz/chromium (non-Windows / serverless)
```

**Backend port:** `process.env.PORT` (default `5000` in `server.js`; Docker/Nixpacks typically set `8080`)  
**Frontend:** Deployed to Vercel  
**Backend:** Deployable to Railway / Render / Docker / Nixpacks / Vercel Serverless (`VERCEL` skips `app.listen`)

---

## 2. Environment Variables

### Backend (read by application code)

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default `5000`) |
| `NODE_ENV` | Yes in prod | `production` enables secure cookies and hides error stacks |
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `JWT_SECRET` | Yes | Access token secret (fallback exists but is unsafe) |
| `JWT_REFRESH_SECRET` | Yes | Refresh token secret (fallback exists but is unsafe) |
| `ALLOWED_ORIGINS` | Yes in prod | Comma-separated frontend URLs (default `http://localhost:5173`) |
| `PUPPETEER_EXECUTABLE_PATH` | Optional | Fallback Chromium path after `@sparticuz/chromium` |
| `VERCEL` | Auto on Vercel | When set, server does not call `app.listen()` |

**Token expiry is hardcoded** in `authController.js` (not env-driven):

- Access token: `1h`
- Refresh token: `7d`

### Deployment-only (Docker / Nixpacks)

| Variable | Description |
|---|---|
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | Skip bundling Chromium during `npm install` |
| `PUPPETEER_EXECUTABLE_PATH` | System Chromium path (`/usr/bin/chromium`) |

### Frontend

| Variable | Required | Description |
|---|---|---|
| `VITE_API_BASE_URL` | Yes | Backend API URL (include `/api` if that is how the client is configured) |

---

## 3. Data Isolation

Almost every business model includes:

```js
createdBy: ObjectId  // ref User, required, indexed
```

Protected controllers scope reads and writes by `req.user._id`. Merchant phone uniqueness is **per user** (`{ phone, createdBy }`), not global.

---

## 4. API Routes Reference

All routes except `/api/auth/*` require a Bearer access token (`protect` middleware).

Mounted in `routes/index.js`:

| Mount | Auth |
|---|---|
| `/api/auth` | Public |
| `/api/merchants` | Protected |
| `/api/buyers` | Protected |
| `/api/merchant` | Protected (legacy TeaMerchant batches) |
| `/api/merchant-transactions` | Protected |
| `/api/merchant-transactions/:txnId/payments` | Protected |
| `/api/labor` | Protected |
| `/api/factory` | Protected |
| `/api/payments` | Protected |
| `/api/dashboard` | Protected |
| `/api/users` | Protected |

### Auth (`/api/auth`)

| Method | Path | Body / notes |
|---|---|---|
| `POST` | `/register` | `name`, `phone`, `password`, `role` → user + `accessToken`; sets `refreshToken` cookie |
| `POST` | `/login` | `phone`, `password` → user + `accessToken`; sets `refreshToken` cookie |
| `POST` | `/refresh` | Uses httpOnly `refreshToken` cookie; rotates refresh token |
| `POST` | `/logout` | Clears refresh cookie and stored token hash |
| `POST` | `/reset-password` | `phone`, `newPassword`; clears all refresh sessions for that user |

Refresh-token details:

- Stored as SHA-256 hashes on `User.refreshTokens`
- Max **5** sessions per user
- Reuse detection clears all sessions
- Cookie: `httpOnly`, `sameSite: 'strict'`, `secure` in production, `maxAge` 7 days

### Users (`/api/users`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/me` | Current user |
| `PUT` | `/me` | Update `name`, `phone` |
| `PUT` | `/change-password` | `currentPassword`, `newPassword`, `confirmPassword` |

### Merchants (`/api/merchants`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/search?q=` | Empty `q` → recent 15; else name **OR** phone |
| `GET` | `/` | `search`, `sort`, `page`, `limit` |
| `GET` | `/:id` | Includes aggregate merchant stats |
| `POST` | `/` | `name`, `phone`, `address`, `notes` |
| `PUT` | `/:id` | Also updates denormalized `merchantName` on linked transactions |
| `DELETE` | `/:id` | Blocked if linked transactions exist |
| `GET/POST` | `/:merchantId/advances` | Merchant-level advances |
| `DELETE` | `/:merchantId/advances/:advanceId` | |
| `GET/POST` | `/:merchantId/payments` | Merchant-level (master) payments |
| `DELETE` | `/:merchantId/payments/:paymentId` | |

Advance / master-payment body fields: `amount`, `advanceDate` or `paymentDate`, `paymentMode`, `notes`.

### Buyers (`/api/buyers`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/search?q=` | Name **OR** phone |
| `GET` | `/` | `search`, `sort`, `page`, `limit` |
| `GET` | `/:id` | Includes factory stats |
| `POST` | `/` | `name`, `phone`, `address`, `notes` |
| `PUT` | `/:id` | Also updates denormalized `buyerName` on Factory records |
| `DELETE` | `/:id` | Blocked if linked factory records exist |

### Legacy TeaMerchant batches (`/api/merchant`)

Separate from merchant master. Model: `TeaMerchant`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/stats` | |
| `GET` | `/` | `teaType`, `sort`, `page`, `limit`, `search` |
| `GET` | `/:id` | |
| `POST` | `/` | `batchId`, `name`, `teaType`, `quantity`, `unit`, `pricePerUnit`, `harvestDate`, `notes` |
| `PUT` | `/:id` | |
| `DELETE` | `/:id` | |

### Merchant Transactions (`/api/merchant-transactions`)

**GET list query params** (combine with **AND**):

| Param | Description |
|---|---|
| `search` | Partial match on `merchantName` **OR** denormalized `merchantPhone` **OR** linked merchant IDs by phone |
| `phone` | Explicit phone filter |
| `merchantName` | Name-only filter |
| `teaType` | e.g. `Green Tea`, `CTC`, `Other` |
| `startDate` / `endDate` | ISO date range (`endDate` inclusive full day) |
| `sort`, `page`, `limit` | Pagination / sort |

| Method | Path | Notes |
|---|---|---|
| `GET` | `/stats` | |
| `GET` | `/` | Filtered list |
| `POST` | `/import` | Multipart `file`; `?preview=true` for dry-run |
| `POST` | `/import-confirm` | Body `{ items: [...] }` |
| `GET` | `/:id` | |
| `POST` | `/` | Create |
| `PUT` | `/:id` | Update |
| `DELETE` | `/:id` | |

**Invoice endpoints:**

```
GET /api/merchant-transactions/:id/invoice?format=pdf|html
GET /api/merchant-transactions/invoice/by-merchant-date?merchantName=...&date=YYYY-MM-DD&format=pdf|html
GET /api/merchant-transactions/invoice/by-merchant-date?merchantName=...&startDate=...&endDate=...&format=pdf|html
```

### Transaction payments (`/api/merchant-transactions/:txnId/payments`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Transaction + payments + summary |
| `POST` | `/` | `amount`, `paymentDate`, `paymentMode`, `notes` |
| `DELETE` | `/:payId` | |

Payment modes: `Cash`, `Bank Transfer`, `Cheque`, `UPI`, `Other`. Rejected if transaction already paid or amount exceeds remaining balance.

### Labor (`/api/labor`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/stats` | |
| `GET` | `/` | `role`, `paymentStatus`, `search`, `sort`, `page`, `limit` |
| `GET` | `/:id` | |
| `POST` | `/` | `name`, `role`, `headCount`, `laborCharge`, `joinDate`, `paymentStatus`, `notes` |
| `PUT` | `/:id` | |
| `DELETE` | `/:id` | |
| `PATCH` | `/:id/pay` | Toggles `Due` ↔ `Paid` |

### Factory (`/api/factory`)

**GET list query params** (combine with **AND**):

| Param | Description |
|---|---|
| `search` | Partial match on `buyerName` **OR** linked Buyer phone |
| `name` | `buyerName` only |
| `phone` | Buyer phone only |
| `startDate` / `endDate` | Date range |
| `sort`, `page`, `limit` | Pagination / sort |

| Method | Path | Notes |
|---|---|---|
| `GET` | `/stats` | |
| `GET` | `/` | Filtered list |
| `POST` | `/` | `date`, `buyerName`, `teaType`, `totalQuantity`, `lessPercentage`, `rate`, `advance`, `fineLeaf`, `dueDate`, `remarks` |
| `GET` | `/:id` | |
| `PUT` | `/:id` | |
| `DELETE` | `/:id` | |
| `POST` | `/:id/payments` | `date`, `amount`, `mode` (`Cash` / `Online` / `Cheque`) |
| `DELETE` | `/:id/payments/:paymentId` | |

**Invoice endpoints:**

```
GET /api/factory/:id/invoice?format=pdf|html
GET /api/factory/invoice/by-buyer?buyerName=...&format=pdf|html
```

### General payments (`/api/payments`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/stats` | |
| `GET` | `/` | `paymentType`, `status`, `search`, `sort`, `page`, `limit` |
| `GET` | `/:id` | |
| `POST` | `/` | `payeeName`, `paymentType`, `amount`, `paymentDate`, `status`, `referenceId`, `notes` |
| `PUT` | `/:id` | |
| `DELETE` | `/:id` | |

### Dashboard (`/api/dashboard`)

```
GET /api/dashboard
```

Returns: `kpi`, `merchantStats`, `factoryStats`, `recentMerchant`, `recentFactory`, `dueMerchants`, `dueBuyers`.

### Error response format

```json
{
  "success": false,
  "message": "Human-readable error",
  "errors": [{ "field": "grossQty", "message": "must be positive" }]
}
```

---

## 5. Filter System

Merchant transactions and factory list endpoints combine active filters with **AND** via `$and`, and escape user input before regex use:

```js
const safe = input.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

Example (merchant transactions):

```js
{
  $and: [
    { createdBy: userId },
    { $or: [{ merchantName: /Ramesh/i }, { merchantPhone: /Ramesh/i }, { merchant: { $in: [...] } }] },
    { teaType: 'Green Tea' },
    { transactionDate: { $gte: start, $lte: end } }
  ]
}
```

**Caveat:** Several other search endpoints (`/api/merchants`, `/api/buyers`, `/api/payments`, `/api/labor`, `/api/merchant`) still build regex from input without the same escape helper. Treat sanitization as implemented on merchant-transaction and factory filters, not globally.

---

## 6. Merchant Transaction Calculations

Stored (not virtual) derived fields on `MerchantTransaction`:

```
lessQty      = grossQty * (lessPercent / 100)
netQty       = grossQty - lessQty
grossAmount  = netQty * ratePerKg
labourAmount = labourHeadCount * labourCharge
netPayable   = grossAmount - labourAmount
finalPayable = netPayable - advancePayment
balance      = finalPayable - totalPaid
```

`balance` may be **negative** (overpayment / advances exceeding gross). There is **no** `Math.max(0, …)` clamp.

Multi-merchant invoice net amount:

```
netFinalAmount =
  totals.finalPayable
  - transactionPayments
  - standaloneAdvances
  - masterPaymentsToMerchant
```

Negative values are allowed and rendered as negative amounts; `numberToWords()` prefixes `MINUS`.

---

## 7. PDF Generation Flow

```
generatePdf(html) called
  1. Dynamic import puppeteer-core
  2. Resolve Chromium path:
     a. Non-Windows: try @sparticuz/chromium first
     b. Else / fallback: PUPPETEER_EXECUTABLE_PATH
     c. Windows: Chrome install paths
     d. Linux: /usr/bin/chromium, chromium-browser, google-chrome, …
  3. puppeteer.launch({ headless: 'shell' | sparticuz.headless, args })
  4. page.setViewport({ width: 794, height: 1123 })
  5. page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 })
  6. page.pdf({ format: 'A4', printBackground: true, margins 10/10/8/8 mm })
  7. Return Buffer.from(pdfData)
  8. browser.close() in finally
```

---

## 8. Invoice Template Guide

### Assets

| Path | Purpose |
|---|---|
| `assets/logo.png` | Header logo + watermark (base64-embedded when present) |
| `assets/fonts/NotoSans-Regular.ttf` | Optional embedded font for reliable `₹` glyph on serverless |

Watermark renders only when the logo asset loads successfully.

### Rupee Symbol

Use `&#x20B9;` (stored as `const RS` in `invoiceController.js`) — not a raw UTF-8 `₹` literal in HTML that may fail without a font covering U+20B9.

### Merchant invoice columns

`DATE · QTY · LESS% · L.KG · NET KG · RATE · L.CNT · L.RATE · L.COST · AMOUNT · NETPAY · ADV · TOTAL`

### TOTAL row (multi-transaction merchant invoice)

Averages shown on the TOTAL row (recent fix):

| Column | Value |
|---|---|
| `LESS%` | `avgLessPercent` |
| `RATE` | `avgRate` |
| `L.RATE` | `avgLabourCharge` |

Single-transaction invoices show `-` for those average columns on the TOTAL row.

### Header / watermark CSS

```css
thead th { white-space: nowrap; }

.watermark-bg {
  position: fixed;   /* NOT absolute */
  z-index: 0;        /* NOT -10 */
  opacity: 0.07;
}
/* Content sections: z-index: 1 above watermark */
```

### Column alignment

- Numbers: `text-align: right` (class `num`)
- Text: `text-align: left` (class `left`)
- Tables use `<colgroup>` for proportional widths totaling 100%

---

## 9. Security

| Measure | Implementation |
|---|---|
| Helmet headers | `helmet({ crossOriginResourcePolicy: 'cross-origin' })` |
| Trust proxy | `app.set('trust proxy', 1)` |
| Rate limiting | 300 req / 2 min on `/api` via `express-rate-limit` |
| CORS allowlist | `ALLOWED_ORIGINS`; credentials enabled; no-`Origin` allowed |
| Body limits | JSON / urlencoded `10mb` |
| Request timeout | 10s global → `503` |
| Input validation | `express-validator` on most CRUD mutation routes (auth routes validate manually) |
| Regex sanitization | Merchant-transaction + factory list filters escaped |
| JWT auth | Bearer access token + httpOnly refresh cookie |
| Refresh storage | SHA-256 hashed; max 5 sessions; rotation + reuse detection |
| No stack in prod | `errorHandler` hides stack when `NODE_ENV=production` |

`requireRole()` exists in middleware but is not currently applied to any route.

---

## 10. MongoDB Index Strategy

### User

- `phone` unique (schema field)

### MerchantTransaction

Field indexes: `createdBy`, `transactionId` (unique), `merchant`, `merchantName`, `merchantPhone`

```
{ createdBy: 1, merchantName: 1, transactionDate: -1 }
{ createdBy: 1, merchantPhone: 1, transactionDate: -1 }
{ createdBy: 1, merchant: 1, transactionDate: -1 }
{ createdBy: 1, transactionDate: -1 }
{ createdBy: 1, teaType: 1, transactionDate: -1 }
```

### Merchant

```
{ name: 'text' }
{ phone: 1, createdBy: 1 }   // unique per user
{ createdBy: 1, name: 1 }
```

### Buyer

```
{ name: 'text' }
{ phone: 1, createdBy: 1 }   // unique per user
{ createdBy: 1, name: 1 }
```

### Factory

Field indexes: `createdBy`, `buyer`, `buyerName`

```
{ createdBy: 1, buyer: 1, date: -1 }
{ createdBy: 1, date: -1 }
```

### MerchantPayment

Field indexes: `createdBy`, `transaction`, `merchant`, `paymentId` (unique)

### MerchantMasterPayment

Field indexes: `createdBy`, `merchant`, `paymentId` (unique)

```
{ merchant: 1, createdBy: 1, paymentDate: -1 }
```

### MerchantAdvance

Field indexes: `createdBy`, `merchant`, `merchantName`, `advanceId` (unique)

### TeaMerchant

Field indexes: `createdBy`, `batchId` (unique)

### Labor / Payment

Field indexes: `createdBy`

---

## 11. Frontend Components

| Component | Purpose |
|---|---|
| `MerchantTableFilters` | Name+phone search, date preset, tea type — with Clear All |
| `MerchantTransactionTable` | Paginated table with edit/delete/detail |
| `MerchantTransactionForm` | Create/edit with live field calculations |
| `MerchantProfileDrawer` | Merchant history + invoice generation |
| `BuyerHistoryDrawer` | Buyer history + factory invoice |
| `SearchableSelect` | Async autocomplete for Merchant/Buyer selection |
| `ConfirmationModal` | Reusable delete confirm |
| `CustomDateRangeModal` | Date range picker |

---

## 12. Deployment Guide

Production start command (Docker / Nixpacks):

```bash
node server.js
```

`npm start` runs `nodemon server.js` and is intended for local development (nodemon is a devDependency).

### Railway / Nixpacks (recommended for backend)

`nixpacks.toml`:

- Setup installs system Chromium + shared libraries
- Build: `npm install --production`
- Start: `node server.js`
- Sets `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` and `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`

Required env vars on the host:

```bash
PORT=8080
NODE_ENV=production
MONGO_URI=mongodb+srv://...
JWT_SECRET=<strong-secret>
JWT_REFRESH_SECRET=<strong-secret>
ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

### Docker

Matches `Dockerfile` (`node:20-bookworm-slim` + system Chromium):

```dockerfile
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

### Vercel (frontend)

1. Connect the frontend repo to Vercel
2. Set `VITE_API_BASE_URL` to the backend API base
3. Build command: `npm run build`, Output: `dist`

---

## 13. Migration Scripts

Located under `scripts/`:

| Script | Purpose |
|---|---|
| `migrate-createdBy.js` | Backfill `createdBy` on existing docs (contains a hard-coded owner user id — update before running) |
| `migrate-merchants.js` | Legacy merchant master migration |
| `migrate-buyers.js` | Legacy buyer master migration |

Review scripts carefully before running in production; older migrations may predate the required `createdBy` schema field.

---

## 14. Known Issues & Fixes

| Issue | Root Cause | Fix / Status |
|---|---|---|
| ₹ shows as `?` / blank in PDF | Missing font coverage for U+20B9 | Use `&#x20B9;`; optionally embed Noto Sans |
| Table headers wrap to 2 lines | No `white-space: nowrap` | Added on `thead th` + colgroup widths |
| Watermark blocks row backgrounds | `z-index: -10` on watermark | `position: fixed` + `z-index: 0`; content at `z-index: 1` |
| Puppeteer `require()` crash | `puppeteer-core` v21+ is ESM | `await import('puppeteer-core')` |
| Chrome path hardcoded to Windows | No multi-platform detection | Sparticuz → env → platform paths |
| Phone search not filtering | Only name searched | Denormalized `merchantPhone` + `$or` |
| AND filter broken | Params overwrote each other | `andConditions[]` → `{ $and: [...] }` |
| Multi-invoice TOTAL LESS%/RATE/L.RATE empty or wrong | Totals row lacked averages | TOTAL row uses `avgLessPercent`, `avgRate`, `avgLabourCharge` |
| Negative net payable floored to 0 | `Math.max(0, …)` on invoice net | Removed clamp; negatives display; words use `MINUS` |
| CSV import may fail at runtime | Import paths `require('../utils/genTxnId')` but `utils/` is missing | Direct create uses in-controller `genTxnId`; import paths need the same fix |
| Single-invoice balance banner | CSS class uses `txn.balance` but amount shows `txn.finalPayable` | Documented display inconsistency — verify before relying on remaining-balance UX |
| Unsanitized regex on some search routes | Escape helper not applied everywhere | Sanitized on merchant-txn + factory lists; other routes still raw |
| `merchantAdvanceRoutes.js` unmounted | Advances wired via `merchantMasterRoutes` | Prefer `/api/merchants/:id/advances` |
