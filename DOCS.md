# DOOARS GREEN FPO — System Documentation

> **Version:** 2.1 (Production)  
> **Updated:** July 2026  
> **Repository:** `teanest-backend` (Express API)  
> **Stack:** Node.js · Express · MongoDB Atlas · Puppeteer · React (Vite) frontend (separate repo)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Structure](#2-project-structure)
3. [Environment Variables](#3-environment-variables)
4. [Authentication](#4-authentication)
5. [Data Isolation](#5-data-isolation)
6. [Data Models & Relationships](#6-data-models--relationships)
7. [Business Logic & Calculations](#7-business-logic--calculations)
8. [API Routes Reference](#8-api-routes-reference)
9. [Filter System](#9-filter-system)
10. [Payment Flows](#10-payment-flows)
11. [PDF Generation & Invoices](#11-pdf-generation--invoices)
12. [CSV Import](#12-csv-import)
13. [Dashboard](#13-dashboard)
14. [Security](#14-security)
15. [MongoDB Index Strategy](#15-mongodb-index-strategy)
16. [Migration Scripts](#16-migration-scripts)
17. [Frontend (Separate Repo)](#17-frontend-separate-repo)
18. [Deployment Guide](#18-deployment-guide)
19. [Known Issues & Fixes](#19-known-issues--fixes)

---

## 1. Architecture Overview

```
Browser  ──▶  Vite (React)  ──▶  Express API (/api)  ──▶  MongoDB Atlas
                                      │
                                 Puppeteer (PDF)
                                      │
                               @sparticuz/chromium (serverless)
                               /usr/bin/chromium (Docker/Railway)
```

| Component | Details |
|---|---|
| **Backend** | Node.js 20, Express 4, Mongoose 7 |
| **Default port** | `5000` in code; set `PORT=8080` in production |
| **API prefix** | `/api` (rate-limited, JWT-protected except auth) |
| **Health check** | `GET /` → `{ success: true, project: "TEAnest", status: "running" }` |
| **Frontend** | Deployed separately (e.g. Vercel) — connects via `VITE_API_BASE_URL` |
| **Backend deploy** | Railway / Render / Docker / Vercel Serverless |

### Domain Modules

The system manages a tea estate / FPO operation across these domains:

| Module | Purpose |
|---|---|
| **Merchant Master** | Leaf suppliers (farmers) — identity by phone per user |
| **Merchant Transactions** | Leaf procurement records with auto-calculated amounts |
| **Merchant Payments** | Per-transaction payment tracking |
| **Merchant Advances** | Standalone cash advances to merchants |
| **Merchant Master Payments** | Bulk/weekly payments at merchant level |
| **Buyers** | Factory sale customers |
| **Factory** | Tea sales to buyers with embedded payments |
| **Labor** | Worker payroll tracking |
| **General Payments** | Misc ledger (salary, bonus, supplier, etc.) |
| **TeaMerchant** | Legacy tea batch inventory (separate from procurement) |
| **Dashboard** | Aggregated KPIs in a single request |

---

## 2. Project Structure

```
/workspace
├── app.js                  # Express bootstrap (security, CORS, rate limit, routes)
├── server.js               # DB connect + HTTP listen (skipped on Vercel)
├── config/db.js            # MongoDB connection
├── middleware/
│   ├── auth.js             # JWT protect + requireRole (role guard unused)
│   └── errorHandler.js     # Global error formatting
├── models/                 # Mongoose schemas (11 models)
├── controllers/            # Business logic (14 controllers)
├── routes/                 # Route definitions (mounted at /api)
├── validators/             # express-validator rules
├── scripts/                # One-time migration scripts
├── assets/logo.png         # Invoice watermark/logo
├── Dockerfile              # Production container with Chromium
├── nixpacks.toml           # Railway/Nixpacks build config
└── DOCS.md                 # This file
```

---

## 3. Environment Variables

### Backend (Required)

| Variable | Required | Description |
|---|---|---|
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `JWT_SECRET` | Yes | Access token signing secret |
| `JWT_REFRESH_SECRET` | Yes | Refresh token signing secret |
| `NODE_ENV` | Yes | `production` or `development` |
| `ALLOWED_ORIGINS` | Yes | Comma-separated frontend URLs (default: `http://localhost:5173`) |

### Backend (Optional)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | HTTP listen port (use `8080` in Docker/Railway) |
| `PUPPETEER_EXECUTABLE_PATH` | auto-detected | Chromium binary path (`/usr/bin/chromium` in Docker) |
| `VERCEL` | — | When set, `server.js` skips `listen()` (serverless export) |

> **Note:** Access token expiry is **hardcoded to `1h`** and refresh to **`7d`** in `authController.js`. The env vars `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` are **not read** by the current code.

### Frontend (Separate Repo)

| Variable | Required | Description |
|---|---|---|
| `VITE_API_BASE_URL` | Yes | Backend API base URL, e.g. `https://api.example.com/api` |

---

## 4. Authentication

### Token Flow

```
Register/Login
  → accessToken in JSON response body (Authorization: Bearer ...)
  → refreshToken in httpOnly cookie (sameSite: strict, secure in production)

Access token expires (1h)
  → Frontend calls POST /api/auth/refresh (cookie sent automatically)
  → New accessToken returned; refresh token rotated

Logout
  → POST /api/auth/logout clears cookie + removes token hash from DB
```

### Auth Endpoints (Public — no JWT)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Register user; returns access token + refresh cookie |
| POST | `/api/auth/login` | Login by phone/password |
| POST | `/api/auth/refresh` | Rotate refresh token; return new access token |
| POST | `/api/auth/logout` | Clear session |
| POST | `/api/auth/reset-password` | Reset password by phone; invalidates all sessions |

### JWT Details

| Setting | Value |
|---|---|
| Access expiry | `1h` (hardcoded) |
| Refresh expiry | `7d` (hardcoded) |
| Max concurrent sessions | 5 per user |
| Refresh storage | SHA-256 hash in `user.refreshTokens[]` |
| Cookie | `httpOnly`, `sameSite: 'strict'`, `secure` in production |
| Password hashing | bcrypt, cost factor 12 |

### Roles

The `User` model has `role: 'Admin' | 'Manager'`, and `requireRole()` middleware exists in `middleware/auth.js`. **Neither is enforced on any route** — all authenticated users have identical API access. Data is isolated by `createdBy`, not by role.

### Protected Route Pattern

All routes under `/api` except `/api/auth/*` require:

```
Authorization: Bearer <accessToken>
```

401 responses include a `code` field: `NO_TOKEN`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, or `USER_NOT_FOUND`.

---

## 5. Data Isolation

Every business record is scoped to the logged-in user via `createdBy: ObjectId → User`.

- All list, search, aggregate, and dashboard queries filter by `req.user._id`
- Phone uniqueness on Merchant/Buyer is **per user** (`{ phone, createdBy }` compound unique index)
- Two users can each have a merchant with the same phone number
- Migration script `scripts/migrate-createdBy.js` backfills `createdBy` on legacy data

---

## 6. Data Models & Relationships

```
User
 ├── Merchant (master) ──┬── MerchantTransaction ── MerchantPayment
 │                        ├── MerchantAdvance
 │                        └── MerchantMasterPayment
 ├── Buyer ── Factory (embedded payments[])
 ├── Labor
 ├── Payment (general ledger)
 └── TeaMerchant (batch inventory)
```

### User

| Field | Type | Notes |
|---|---|---|
| `name` | String | required |
| `phone` | String | required, globally unique |
| `password` | String | bcrypt hashed |
| `role` | enum | `Admin` \| `Manager`, default `Manager` |
| `refreshTokens` | [String] | SHA-256 hashes, max 5 |

### Merchant (leaf suppliers)

| Field | Type | Notes |
|---|---|---|
| `createdBy` | ObjectId → User | required |
| `name` | String | required, max 100 |
| `phone` | String | required, unique per user |
| `address`, `notes` | String | optional |

**Create behavior:** POST rejects duplicate phone for the same user (409). Unlike Buyers, this is **not** find-or-create.

### MerchantTransaction (leaf procurement)

| Field | Type | Notes |
|---|---|---|
| `transactionId` | String | unique, auto-generated `TXN-...` |
| `merchant` | ObjectId → Merchant | auto-linked by phone on create |
| `merchantName`, `merchantPhone` | String | denormalized for fast filtering |
| `teaType` | enum | `Green Tea`, `CTC`, `Other` |
| `transactionDate` | Date | |
| **Inputs** | | `grossQty`, `lessPercent`, `fineLeaf`, `ratePerKg`, `labourHeadCount`, `labourCharge`, `advancePayment` |
| **Calculated** | | `lessQty`, `netQty`, `grossAmount`, `labourAmount`, `netPayable`, `finalPayable`, `balance` |

### MerchantPayment (per-transaction)

| Field | Type | Notes |
|---|---|---|
| `transaction` | ObjectId → MerchantTransaction | required |
| `merchant` | ObjectId → Merchant | denormalized |
| `paymentId` | String | unique, `PAY-...` |
| `amount` | Number | min 1 |
| `paymentDate` | Date | |
| `paymentMode` | enum | `Cash`, `Bank Transfer`, `Cheque`, `UPI`, `Other` |

### MerchantAdvance (standalone)

Cash given to a merchant outside specific transactions. Does **not** update transaction `balance` fields directly; subtracted in dashboard and multi-invoice totals.

### MerchantMasterPayment (merchant-level)

Bulk/weekly payments at merchant level, not tied to a transaction. Same dashboard/invoice treatment as standalone advances.

### Buyer

| Field | Type | Notes |
|---|---|---|
| `createdBy`, `name`, `phone`, `address`, `notes` | | phone unique per user |

**Create behavior:** find-or-create by phone — returns existing buyer if phone matches.

### Factory (sales to buyers)

| Field | Type | Notes |
|---|---|---|
| `buyer` | ObjectId → Buyer | optional link |
| `buyerName` | String | required, denormalized |
| `teaType` | String | default `CTC` |
| `totalQuantity`, `lessPercentage`, `rate`, `advance`, `fineLeaf` | Number | |
| `payments` | embedded[] | `{ date, amount, mode }` — modes: `Cash`, `Online`, `Cheque` |
| `dueDate`, `remarks` | | |

**Virtuals (computed, not stored):** `lessQuantity`, `netQuantity`, `totalAmount`, `totalPaid`, `due`

### Labor

| Field | Type | Notes |
|---|---|---|
| `name`, `role` | String | role enum in validator |
| `headCount`, `laborCharge` | Number | `totalPayable = headCount × laborCharge` |
| `joinDate` | Date | |
| `paymentStatus` | enum | `Due` \| `Paid` |
| `notes` | String | |

### Payment (general ledger)

| Field | Type | Notes |
|---|---|---|
| `payeeName` | String | |
| `paymentType` | enum | `Salary`, `Advance`, `Bonus`, `Supplier`, `Other` |
| `amount`, `paymentDate` | | |
| `status` | enum | `Pending`, `Completed`, `Failed` |
| `referenceId`, `notes` | String | |

### TeaMerchant (batch inventory — legacy module)

Separate from procurement transactions. Tracks tea batches with `batchId`, `quantity`, `pricePerUnit`, `harvestDate`. Virtual: `totalValue = quantity × pricePerUnit`.

---

## 7. Business Logic & Calculations

### Merchant Transaction Calculation Chain

```
lessQty      = grossQty × (lessPercent / 100)
netQty       = grossQty - lessQty
grossAmount  = netQty × ratePerKg
labourAmount = labourHeadCount × labourCharge
netPayable   = grossAmount - labourAmount
finalPayable = netPayable - advancePayment
balance      = finalPayable - sum(MerchantPayment.amount)
```

- All calculated fields are **persisted** (not virtual) for aggregation/reporting
- `pre('save')` and `pre('findOneAndUpdate')` hooks recalculate on every write
- On partial updates, existing document values are merged with incoming data before recalculation (prevents zeroing out amounts)

### Factory Virtual Calculations

```
lessQuantity = totalQuantity × lessPercentage / 100
netQuantity  = totalQuantity - lessQuantity
totalAmount  = netQuantity × rate
totalPaid    = sum(payments[].amount)
due          = totalAmount - advance - totalPaid
```

### Multi-Invoice Net Payable (merchant)

```
netFinalAmount = sum(finalPayable)
               - sum(transaction payments in range)
               - sum(standalone advances in range)
               - sum(master payments in range)
```

### Dashboard Merchant Due

```
totalMerchantDue = sum(transaction balances) - sum(standalone advances)
```

---

## 8. API Routes Reference

**Base:** `/api` · **Auth:** JWT required except `/api/auth/*`

### Users — `/api/users`

| Method | Path | Purpose |
|---|---|---|
| GET | `/me` | Current user profile |
| PUT | `/me` | Update name/phone |
| PUT | `/change-password` | Change password (requires current password) |

### Merchants — `/api/merchants`

| Method | Path | Purpose |
|---|---|---|
| GET | `/search?q=` | Autocomplete (top 15 by name/phone) |
| GET | `/` | Paginated list (`search`, `sort`, `page`, `limit`) |
| GET | `/:id` | Detail + aggregated transaction stats |
| POST | `/` | Create merchant (rejects duplicate phone) |
| PUT | `/:id` | Update; propagates `merchantName` to linked transactions |
| DELETE | `/:id` | Delete if no linked transactions |
| GET | `/:merchantId/advances` | List standalone advances + total |
| POST | `/:merchantId/advances` | Create standalone advance |
| DELETE | `/:merchantId/advances/:advanceId` | Delete advance |
| GET | `/:merchantId/payments` | List merchant-level payments + total |
| POST | `/:merchantId/payments` | Create merchant-level payment |
| DELETE | `/:merchantId/payments/:paymentId` | Delete merchant-level payment |

### Buyers — `/api/buyers`

| Method | Path | Purpose |
|---|---|---|
| GET | `/search?q=` | Autocomplete search |
| GET | `/` | Paginated list |
| GET | `/:id` | Detail + factory stats |
| POST | `/` | Find-or-create by phone |
| PUT | `/:id` | Update; propagates `buyerName` to factory records |
| DELETE | `/:id` | Delete if no linked factory records |

### Merchant Transactions — `/api/merchant-transactions`

| Method | Path | Purpose |
|---|---|---|
| GET | `/stats` | Summary, by tea type, 5 recent |
| GET | `/` | List with AND filters (see §9) |
| POST | `/` | Create (auto-links/creates Merchant by phone) |
| POST | `/import` | CSV upload (`?preview=true` for preview only) |
| POST | `/import-confirm` | Confirm JSON array from preview |
| GET | `/:id` | Get one |
| PUT | `/:id` | Update with recalculated fields |
| DELETE | `/:id` | Delete + cascade delete payments |
| GET | `/:id/invoice` | Single invoice (`?format=pdf\|html`) |
| GET | `/invoice/by-merchant-date` | Multi-txn invoice by merchant + date range |

**GET list query params:** `search`, `phone`, `merchantName`, `teaType`, `startDate`, `endDate`, `sort`, `page`, `limit`

### Transaction Payments — `/api/merchant-transactions/:txnId/payments`

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Payments + summary (`finalPayable`, `totalPaid`, `remainingBalance`) |
| POST | `/` | Record payment (validates ≤ remaining balance) |
| DELETE | `/:payId` | Delete payment; recalculates balance |

### Factory — `/api/factory`

| Method | Path | Purpose |
|---|---|---|
| GET | `/stats` | Sales totals, advance, paid, due |
| GET | `/` | List with AND filters (see §9) |
| POST | `/` | Create sale record |
| GET | `/:id` | Get one |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |
| POST | `/:id/payments` | Add embedded payment |
| DELETE | `/:id/payments/:paymentId` | Remove embedded payment |
| GET | `/:id/invoice` | Single factory invoice (`?format=pdf\|html`) |
| GET | `/invoice/by-buyer` | Multi-record statement (`buyerName`, `?format=`) |

**GET list query params:** `search`, `name`, `phone`, `startDate`, `endDate`, `sort`, `page`, `limit`

### Labor — `/api/labor`

| Method | Path | Purpose |
|---|---|---|
| GET | `/stats` | Worker counts, due/paid totals, by role |
| GET | `/` | List (`role`, `paymentStatus`, `search`, pagination) |
| POST | `/` | Create worker |
| GET | `/:id` | Get one |
| PUT | `/:id` | Update |
| PATCH | `/:id/pay` | Toggle `paymentStatus` Due ↔ Paid |
| DELETE | `/:id` | Delete |

### General Payments — `/api/payments`

| Method | Path | Purpose |
|---|---|---|
| GET | `/stats` | Totals by payment type |
| GET | `/` | List (`paymentType`, `status`, `search`) |
| POST | `/` | Create |
| GET | `/:id` | Get one |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |

### Tea Batches — `/api/merchant`

Legacy tea batch inventory (not leaf procurement).

| Method | Path | Purpose |
|---|---|---|
| GET | `/stats` | Batch aggregates by tea type |
| GET | `/` | List (`teaType`, `search`, pagination) |
| POST | `/` | Create batch (auto-generates `batchId`) |
| GET | `/:id` | Get one |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |

### Dashboard — `/api/dashboard`

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Single aggregated dashboard payload (see §13) |

### Error Response Format

```json
{
  "success": false,
  "message": "Human-readable error",
  "errors": [{ "field": "grossQty", "message": "must be positive" }]
}
```

| Status | When |
|---|---|
| 400 | Validation error, invalid ObjectId |
| 401 | Missing/expired/invalid JWT |
| 403 | Role denied (middleware exists but unused) |
| 404 | Resource not found |
| 409 | Duplicate key (e.g. phone already exists) |
| 429 | Rate limit exceeded (300 req / 2 min) |
| 500 | Server error (no stack trace in production) |
| 503 | Request timeout (10s global limit) |

---

## 9. Filter System

All active filters combine with **AND logic** using `$and`. User input is sanitized before regex use to prevent ReDoS:

```js
const safe = input.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

### Merchant Transactions

| Param | Description |
|---|---|
| `search` | Partial match on `merchantName` OR `merchantPhone` OR linked merchant ID |
| `phone` | Explicit phone filter |
| `merchantName` | Name only filter |
| `teaType` | `Green Tea`, `CTC`, or `Other` |
| `startDate` | ISO date range start |
| `endDate` | ISO date range end (inclusive full day) |

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

### Factory

| Param | Description |
|---|---|
| `search` | Partial match on `buyerName` OR buyer phone |
| `name` | `buyerName` only |
| `phone` | Buyer phone only |
| `startDate` | Date range start |
| `endDate` | Date range end |

---

## 10. Payment Flows

The system has **five distinct payment mechanisms**:

### A. In-Transaction Advance (`advancePayment` field)

Stored on `MerchantTransaction`. Reduces `finalPayable` in the calculation chain.

### B. Per-Transaction Payments (`MerchantPayment`)

- Route: `/api/merchant-transactions/:txnId/payments`
- Validates amount ≤ remaining `finalPayable - totalPaid`
- Updates `MerchantTransaction.balance` on create/delete
- Cascade-deleted when parent transaction is deleted
- Modes: `Cash`, `Bank Transfer`, `Cheque`, `UPI`, `Other`

### C. Standalone Advances (`MerchantAdvance`)

- Route: `/api/merchants/:merchantId/advances`
- Cash given outside specific transactions
- Does **not** update transaction `balance` fields
- Subtracted in dashboard `totalMerchantDue` and multi-invoice `netFinalAmount`

### D. Merchant Master Payments (`MerchantMasterPayment`)

- Route: `/api/merchants/:merchantId/payments`
- Bulk/weekly payments at merchant level
- Same dashboard/invoice treatment as standalone advances

### E. Factory Embedded Payments

- Route: `/api/factory/:id/payments`
- Stored as subdocuments in `Factory.payments[]`
- Modes: `Cash`, `Online`, `Cheque`
- Due = `totalAmount - advance - sum(payments)`

### F. General Payments (`Payment` model)

- Route: `/api/payments`
- Independent payroll/misc ledger
- Types: `Salary`, `Advance`, `Bonus`, `Supplier`, `Other`

---

## 11. PDF Generation & Invoices

### Endpoints

```
GET /api/merchant-transactions/:id/invoice?format=pdf|html
GET /api/merchant-transactions/invoice/by-merchant-date?merchantName=...&startDate=...&endDate=...&format=
GET /api/factory/:id/invoice?format=pdf|html
GET /api/factory/invoice/by-buyer?buyerName=...&format=
```

### PDF Pipeline (`generatePdf` in `invoiceController.js`)

```
1. Dynamic import puppeteer-core (ESM compatibility)
2. Resolve Chromium path:
   a. @sparticuz/chromium (non-Windows / serverless)
   b. PUPPETEER_EXECUTABLE_PATH env var (Docker/Railway)
   c. Platform defaults (Windows Chrome, Linux chromium)
3. puppeteer.launch({ headless: 'shell', args: [...no-sandbox flags] })
4. page.setContent(html, { waitUntil: 'networkidle0' })
5. page.pdf({ format: 'A4', printBackground: true })
6. Return Buffer; browser.close() in finally block
```

### Invoice Template Rules

| Rule | Implementation |
|---|---|
| Rupee symbol | Use `&#x20B9;` HTML entity (`const RS`) — NOT UTF-8 `₹` literal |
| Header wrapping | `thead th { white-space: nowrap; }` |
| Watermark | `position: fixed; z-index: 0; opacity: 0.07` — content at `z-index: 1` |
| Column alignment | Numbers: `text-align: right` (`.num`); Text: `.left` |
| Table widths | `<colgroup>` for proportional control |
| Number format | Indian locale (`en-IN`) with number-to-words |
| Logo | `assets/logo.png` embedded as base64 |

---

## 12. CSV Import

Bulk import merchant transactions from CSV files.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/merchant-transactions/import` | Upload CSV (`multipart/form-data`, field: `file`) |
| POST | `/api/merchant-transactions/import-confirm` | Confirm previewed rows as JSON array |

- Add `?preview=true` to import endpoint to validate without saving
- Uses `multer` (memory storage) + `csv-parser`
- Auto-links/creates Merchant records by phone during import

> **Known bug:** `import-confirm` and non-preview import call `require('../utils/genTxnId')()` which does not exist. The local `genTxnId()` function in the controller is used for normal creates but not for import paths.

---

## 13. Dashboard

**`GET /api/dashboard`** returns a single payload:

```json
{
  "kpi": {
    "totalMerchantTxns", "totalProcuredQty", "totalMerchantDue",
    "totalFactorySales", "totalSoldQty", "totalFactoryDue",
    "totalRevenue", "totalProcurementAmt"
  },
  "merchantStats": { "totals for transactions, balances, advances, labor" },
  "factoryStats": { "sales, amounts, advance, paid, due" },
  "recentMerchant": [ "last 8 transactions" ],
  "recentFactory": [ "last 8 sales with computed virtuals" ],
  "dueMerchants": [ "top 5 by net due after standalone advances" ],
  "dueBuyers": [ "top 5 by aggregated factory due" ]
}
```

All queries are scoped by `req.user._id` (`createdBy`).

---

## 14. Security

| Measure | Implementation |
|---|---|
| Helmet headers | `helmet()` in `app.js` |
| Rate limiting | 300 req / 2 min via `express-rate-limit` on `/api` |
| CORS allowlist | Only `ALLOWED_ORIGINS` accepted; `credentials: true` |
| Input validation | `express-validator` on mutation routes |
| Regex sanitization | All filter strings escaped before MongoDB regex |
| JWT auth | httpOnly refresh cookie + Bearer access token |
| Request timeout | 10s global → 503 response |
| No stack in prod | `errorHandler` hides stack when `NODE_ENV=production` |
| Trust proxy | `app.set('trust proxy', 1)` for correct client IP behind reverse proxy |
| Async safety | `express-async-errors` wraps all async controllers |

---

## 15. MongoDB Index Strategy

All business indexes include `createdBy` for per-user query performance.

### MerchantTransaction

```
{ createdBy: 1, merchantName: 1, transactionDate: -1 }
{ createdBy: 1, merchantPhone: 1, transactionDate: -1 }
{ createdBy: 1, merchant: 1, transactionDate: -1 }
{ createdBy: 1, transactionDate: -1 }
{ createdBy: 1, teaType: 1, transactionDate: -1 }
{ transactionId: 1 }   // unique
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

```
{ createdBy: 1, buyer: 1, date: -1 }
{ createdBy: 1, date: -1 }
```

### MerchantMasterPayment

```
{ merchant: 1, createdBy: 1, paymentDate: -1 }
```

---

## 16. Migration Scripts

One-time scripts in `scripts/`. Run with `node scripts/<name>.js` (requires `.env` with `MONGO_URI`).

| Script | Purpose |
|---|---|
| `migrate-merchants.js` | Link unlinked transactions to Merchant docs; creates merchants with placeholder phones (`LEGACY-001`, etc.) |
| `migrate-buyers.js` | Link unlinked Factory records to Buyer docs; placeholder phones (`LEGACY-B001`, etc.) |
| `migrate-createdBy.js` | Assign `createdBy` to all docs missing it across 9 collections; drops old global phone indexes; recreates compound indexes |

> Older migration scripts (`migrate-merchants.js`, `migrate-buyers.js`) do not set `createdBy`. Run `migrate-createdBy.js` after them.

---

## 17. Frontend (Separate Repo)

The React/Vite frontend is deployed separately (e.g. Vercel). Key integration points:

| Concern | Detail |
|---|---|
| API base URL | `VITE_API_BASE_URL` env var |
| Auth | Store `accessToken` in memory/state; send as `Authorization: Bearer` |
| Token refresh | On 401, call `POST /api/auth/refresh` (cookie sent automatically) |
| CORS | Frontend origin must be in backend `ALLOWED_ORIGINS` |

### Known Frontend Components

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

## 18. Deployment Guide

### Railway (Recommended)

```bash
# Required env vars:
PORT=8080
NODE_ENV=production
MONGO_URI=mongodb+srv://...
JWT_SECRET=<strong-secret>
JWT_REFRESH_SECRET=<strong-secret>
ALLOWED_ORIGINS=https://your-frontend.vercel.app
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

Uses `nixpacks.toml` for Chromium + font dependencies. Start command: `node server.js`.

### Docker

```dockerfile
FROM node:20-bookworm-slim
# Installs chromium + required libs
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
EXPOSE 8080
CMD ["node", "server.js"]
```

Build and run:

```bash
docker build -t teanest-backend .
docker run -p 8080:8080 --env-file .env teanest-backend
```

### Vercel Serverless

- `server.js` exports `app` and skips `listen()` when `VERCEL` env is set
- Uses `@sparticuz/chromium` for PDF generation
- Set all required env vars in Vercel dashboard

### Vercel (Frontend)

1. Connect frontend repo to Vercel
2. Set `VITE_API_BASE_URL=https://your-backend.railway.app/api`
3. Build command: `npm run build`, Output: `dist`

---

## 19. Known Issues & Fixes

### Resolved

| Issue | Root Cause | Fix Applied |
|---|---|---|
| ₹ shows as `?` in PDF | UTF-8 literal in HTML | Use `&#x20B9;` HTML entity |
| Table headers wrap to 2 lines | No `white-space: nowrap` | Added to `thead th` + colgroup widths |
| Watermark blocks row backgrounds | `z-index: -10` on watermark | Changed to `fixed` + `z-index: 0`; content at `z-index: 1` |
| Puppeteer require() crash | puppeteer-core v21+ is ESM | Use `await import('puppeteer-core')` |
| Chrome path hardcoded to Windows | No multi-platform detection | Platform-aware path resolution + env var support |
| Phone search not filtering | Only name was searched | Denormalized `merchantPhone` field + `$or` across name, phone, merchant ID |
| AND filter broken | Multiple params overwrote each other | Refactored to `andConditions[]` → `{ $and: [...] }` |
| Partial update zeroed amounts | `findOneAndUpdate` used only `$set` fields | Merge existing doc with update before recalculation |

### Open / Outstanding

| Issue | Impact | Notes |
|---|---|---|
| CSV import `genTxnId` path | Import confirm crashes | Calls `require('../utils/genTxnId')()` which does not exist; local function in controller is not used |
| Factory single invoice scoping | Potential data leak | `generateFactoryInvoice` uses `findById` without `createdBy` check |
| Buyer stats aggregation | Incorrect stats | `getById` sums `$totalAmount` and `$due` — virtual fields not stored in MongoDB |
| Merchant txn stats | Incorrect labor total | Aggregates `$laborCharges` field which does not exist (should be `labourAmount`) |
| `requireRole` unused | No role enforcement | Admin/Manager distinction has no API effect |
| `merchantAdvanceRoutes.js` orphaned | Dead code | Routes duplicated in `merchantMasterRoutes.js` |
| `html-pdf-node` dependency | Unused package | Listed in `package.json` but not imported anywhere |
| JWT expiry env vars | Docs/code mismatch | `JWT_ACCESS_EXPIRES_IN` not read; hardcoded to `1h` |
| Auth controller comment | Misleading | Header says 15 min access token; code uses `1h` |
