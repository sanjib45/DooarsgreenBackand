# DOOARS GREEN FPO — System Documentation

> **Version:** 2.1 (Production)  
> **Updated:** July 2026  
> **Package:** `teanest-backend`  
> **Stack:** Node.js · Express · MongoDB Atlas · Puppeteer · `@sparticuz/chromium`

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Architecture](#2-architecture)
3. [Project Structure](#3-project-structure)
4. [Environment Variables](#4-environment-variables)
5. [Authentication](#5-authentication)
6. [API Routes Reference](#6-api-routes-reference)
7. [Data Models](#7-data-models)
8. [Business Calculations](#8-business-calculations)
9. [Filter System](#9-filter-system)
10. [PDF / Invoice Generation](#10-pdf--invoice-generation)
11. [Security](#11-security)
12. [MongoDB Index Strategy](#12-mongodb-index-strategy)
13. [Migration Scripts](#13-migration-scripts)
14. [Deployment Guide](#14-deployment-guide)
15. [Known Issues & Fixes](#15-known-issues--fixes)

---

## 1. Product Overview

**TEAnest** is the tea estate / FPO management backend for **DOOARS GREEN FPO (MCSL)**.

It manages:

| Domain | Purpose |
|---|---|
| **Merchant procurement** | Buy green leaf from farmers/merchants; track qty, rate, labour, advances, balance |
| **Factory sales** | Sell processed tea to buyers; track qty, rate, advances, embedded payments |
| **Merchant & buyer masters** | Per-user directories; find-or-create by phone |
| **Advances & payments** | Standalone merchant advances, per-txn payments, merchant-level bulk payments |
| **Labor** | Estate workforce with Due / Paid status |
| **General payments** | Salary / Advance / Bonus / Supplier ledger |
| **Dashboard** | KPIs, recent activity, top outstanding dues |
| **Invoices** | DOOARS GREEN FPO payment vouchers & factory statements (PDF / HTML) |

**Branding on PDFs:** DOOARS GREEN FPO / MCSL  
**GST:** `19AAIAD3091R1ZO`  
**Health check:** `GET /` → `{ success: true, project: "TEAnest", status: "running" }`

> This repository is the **backend API only**. The React (Vite) frontend is a separate project (typically deployed on Vercel) and talks to this API via `VITE_API_BASE_URL`.

---

## 2. Architecture

```
Browser (React / Vite frontend)
        │
        ▼
   Express API  (/api/*)  ── protect (JWT) ──▶  MongoDB Atlas
        │
        ├── Auth (access JWT + httpOnly refresh cookie)
        ├── CRUD + aggregations (scoped by createdBy)
        └── Puppeteer PDF
              ├── @sparticuz/chromium  (Linux / serverless)
              └── system Chromium     (Docker / Railway)
```

| Layer | Detail |
|---|---|
| **Entry** | `server.js` → connects DB, listens (skipped when `VERCEL` is set) |
| **App** | `app.js` — helmet, CORS, rate limit, morgan, 10s timeout, routes |
| **Default port** | `process.env.PORT \|\| 5000` (set `PORT=8080` in Docker/Railway) |
| **Multi-tenancy** | Nearly all queries filter `createdBy: req.user._id` |

---

## 3. Project Structure

```
teanest-backend/
├── server.js                 # Process entry, DB connect, listen
├── app.js                    # Express bootstrap (security + routes)
├── config/db.js              # Mongoose connection
├── assets/logo.png           # Invoice logo (embedded as base64)
├── controllers/              # Business logic
├── models/                   # Mongoose schemas
├── routes/                   # Express routers
├── middleware/               # auth (protect, requireRole), errorHandler
├── validators/               # express-validator rules
├── scripts/                  # One-off data migrations
├── Dockerfile                # Node 20 + system Chromium
└── nixpacks.toml             # Railway/Nixpacks Chromium setup
```

---

## 4. Environment Variables

### Backend (required in production)

| Variable | Required | Description |
|---|---|---|
| `PORT` | Recommended | Server port. Code default is **`5000`**. Docker/Railway usually set **`8080`**. |
| `NODE_ENV` | Yes | `production` or `development` (controls cookie `secure` + error stack) |
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `JWT_SECRET` | Yes | Access token signing secret |
| `JWT_REFRESH_SECRET` | Yes | Refresh token signing secret |
| `ALLOWED_ORIGINS` | Yes | Comma-separated frontend origins (default: `http://localhost:5173`) |
| `PUPPETEER_EXECUTABLE_PATH` | Optional | Chromium binary path (Docker/nixpacks set `/usr/bin/chromium`) |
| `VERCEL` | Optional | If set, skips `app.listen` (serverless export) |

### Not used by application code

| Variable | Note |
|---|---|
| `JWT_ACCESS_EXPIRES_IN` | Access TTL is hardcoded to **`1h`** in `authController.js` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh TTL is hardcoded to **`7d`** |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | Set in Docker/nixpacks only (not read in JS) |

### Frontend (separate repo)

| Variable | Required | Description |
|---|---|---|
| `VITE_API_BASE_URL` | Yes | Backend base URL ending in `/api` |

---

## 5. Authentication

### Flow

```
POST /api/auth/login  →  accessToken (JSON) + refreshToken (httpOnly cookie)
        │
        ▼
Authorization: Bearer <accessToken>  on all protected /api/* routes
        │
        ▼  (on 401 TOKEN_EXPIRED)
POST /api/auth/refresh  →  new accessToken + rotated refresh cookie
```

| Item | Value |
|---|---|
| Access token | JWT in response body; payload `{ id, role }`; expiry **`1h`** |
| Refresh token | Cookie name **`refreshToken`**; httpOnly; `sameSite: 'strict'`; `secure` in production; expiry **`7d`** |
| Refresh storage | SHA-256 hash in `user.refreshTokens[]`; max **5** sessions |
| Login identity | **phone + password** (not email) |
| Roles | `Admin` \| `Manager` (default `Manager`). `requireRole` exists but is **not applied** on any route today. |
| Password hashing | bcrypt cost **12** on register/reset |

### Auth endpoints (`/api/auth` — public)

| Method | Path | Description |
|---|---|---|
| POST | `/register` | Create user; returns accessToken + sets refresh cookie |
| POST | `/login` | Login by phone/password |
| POST | `/refresh` | Rotate refresh; return new accessToken |
| POST | `/logout` | Clear cookie + remove refresh hash |
| POST | `/reset-password` | Reset by phone + newPassword; invalidates all sessions |

### Protect middleware codes

| HTTP | `code` | Meaning |
|---|---|---|
| 401 | `NO_TOKEN` | Missing Bearer header |
| 401 | `TOKEN_EXPIRED` | Access JWT expired — call `/refresh` |
| 401 | `TOKEN_INVALID` | Bad signature / malformed |
| 401 | `USER_NOT_FOUND` | User deleted after token issued |

---

## 6. API Routes Reference

All business routes are under `/api` and rate-limited.  
Unless noted, routes require `protect` (Bearer access token).

### Users — `/api/users`

| Method | Path | Description |
|---|---|---|
| GET | `/me` | Current user profile |
| PUT | `/me` | Update name / phone |
| PUT | `/change-password` | Change password (current + new + confirm) |

### Merchant master — `/api/merchants`

| Method | Path | Description |
|---|---|---|
| GET | `/search?q=` | Autocomplete (top 15 by name/phone) |
| GET | `/` | Paginated list (`search`, `sort`, `page`, `limit`) |
| POST | `/` | Find-or-create by phone (per user) |
| GET | `/:id` | Get merchant + related txn summary |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |
| GET | `/:merchantId/advances` | List standalone advances |
| POST | `/:merchantId/advances` | Create advance (`ADV-…`) |
| DELETE | `/:merchantId/advances/:advanceId` | Delete advance |
| GET | `/:merchantId/payments` | List merchant-level bulk payments |
| POST | `/:merchantId/payments` | Create master payment (`PAY-…`) |
| DELETE | `/:merchantId/payments/:paymentId` | Delete master payment |

### Buyers — `/api/buyers`

| Method | Path | Description |
|---|---|---|
| GET | `/search` | Search buyers |
| GET | `/` | List buyers |
| GET | `/:id` | Get one |
| POST | `/` | Find-or-create by phone |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |

### Tea batches (legacy) — `/api/merchant`

Uses model `TeaMerchant` (harvest batches), not merchant master.

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Batch qty/value aggregates |
| GET | `/` | List (`teaType`, `search`, pagination) |
| POST | `/` | Create batch (`BTH-…`) |
| GET | `/:id` | Get one |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |

### Merchant transactions — `/api/merchant-transactions`

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Procurement aggregates |
| GET | `/invoice/by-merchant-date` | Multi-txn PDF/HTML voucher |
| GET | `/` | List / filter transactions |
| POST | `/import` | CSV import (`?preview=true` for dry-run) |
| POST | `/import-confirm` | Confirm JSON import of previewed rows |
| GET | `/:id/invoice` | Single-txn PDF/HTML |
| GET | `/:id` | Get one |
| POST | `/` | Create (`TXN-…`) |
| PUT | `/:id` | Update (+ recalculate) |
| DELETE | `/:id` | Delete |

**List query params** (AND logic, scoped by `createdBy`):

| Param | Description |
|---|---|
| `search` | Partial match on merchantName **OR** merchantPhone **OR** linked merchant |
| `phone` | Explicit phone filter |
| `merchantName` | Name-only filter |
| `teaType` | `Green Tea` \| `CTC` \| `Other` |
| `startDate` / `endDate` | ISO date range (endDate inclusive full day) |
| `sort` / `page` / `limit` | Sorting & pagination |

### Transaction payments — `/api/merchant-transactions/:txnId/payments`

| Method | Path | Description |
|---|---|---|
| GET | `/` | Payments for transaction |
| POST | `/` | Add payment; recalculates txn `balance` |
| DELETE | `/:payId` | Remove payment; recalculates balance |

### Factory sales — `/api/factory`

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Sales aggregates |
| GET | `/` | List (`search`, `name`, `phone`, `startDate`, `endDate`) |
| POST | `/` | Create sale |
| GET | `/invoice/by-buyer?buyerName=` | Multi-sale factory statement PDF/HTML |
| GET | `/:id/invoice` | Single factory invoice PDF/HTML |
| GET | `/:id` | Get one |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |
| POST | `/:id/payments` | Add embedded payment |
| DELETE | `/:id/payments/:paymentId` | Remove embedded payment |

### Labor — `/api/labor`

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Headcount / due / paid totals |
| GET | `/` | List (`role`, `paymentStatus`, `search`) |
| POST | `/` | Create worker |
| GET | `/:id` | Get one |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |
| PATCH | `/:id/pay` | Toggle `Due` ↔ `Paid` |

### General payments — `/api/payments`

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Aggregates |
| GET | `/` | List |
| POST | `/` | Create |
| GET | `/:id` | Get one |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |

### Dashboard — `/api/dashboard`

| Method | Path | Description |
|---|---|---|
| GET | `/` | KPIs, recent txns/sales, top due merchants/buyers (all scoped by `createdBy`) |

### Error response format

```json
{
  "success": false,
  "message": "Human-readable error",
  "errors": [{ "field": "grossQty", "message": "must be positive" }]
}
```

---

## 7. Data Models

### User
`name`, `phone` (unique), `password`, `role` (`Admin`|`Manager`), `refreshTokens[]`

### Merchant / Buyer
`createdBy` → User, `name`, `phone`, `address`, `notes`  
Phone unique **per user**: `{ phone, createdBy }`

### MerchantTransaction
Procurement record with denormalized `merchantName` / `merchantPhone`, `teaType`, quantities, rates, labour, advances, and persisted calculated fields (`lessQty`, `netQty`, `grossAmount`, `labourAmount`, `netPayable`, `finalPayable`, `balance`).

IDs: `TXN-…`

### MerchantPayment
Per-transaction payment. Modes: `Cash` | `Bank Transfer` | `Cheque` | `UPI` | `Other`

### MerchantAdvance
Merchant-level advance (not tied to a txn). IDs: `ADV-…`. Same payment modes.

### MerchantMasterPayment
Merchant-level bulk payment. IDs: `PAY-…`. Same payment modes.

### Factory
Sale to buyer: `buyerName`, `teaType` (default `CTC`), `totalQuantity`, `lessPercentage`, `rate`, `advance`, `fineLeaf`, embedded `payments[]` (`Cash`|`Online`|`Cheque`).

Virtuals: `lessQuantity`, `netQuantity`, `totalAmount`, `totalPaid`, `due`

### TeaMerchant (legacy batches)
`batchId` (unique), `teaType`, `quantity`, `unit`, `pricePerUnit`, `harvestDate`, `name`  
Virtual: `totalValue`

### Labor
`name`, `role` (`Plucker`|`Factory Worker`|`Supervisor`|`Maintenance`|`Other`), `headCount`, `laborCharge`, `totalPayable` (= headCount × laborCharge), `paymentStatus` (`Due`|`Paid`)

### Payment (general)
`payeeName`, `paymentType` (`Salary`|`Advance`|`Bonus`|`Supplier`|`Other`), `amount`, `status` (`Pending`|`Completed`|`Failed`)

---

## 8. Business Calculations

### Merchant transaction

```
lessQty       = grossQty × (lessPercent / 100)
netQty        = grossQty − lessQty
grossAmount   = netQty × ratePerKg
labourAmount  = labourHeadCount × labourCharge
netPayable    = grossAmount − labourAmount
finalPayable  = netPayable − advancePayment
balance       = finalPayable − Σ(MerchantPayment.amount)
```

Recalculated on `pre('save')` and `pre('findOneAndUpdate')` (update path merges existing doc + `$set` so partial updates do not zero out fields).

### Factory sale (virtuals)

```
lessQuantity = totalQuantity × (lessPercentage / 100)
netQuantity  = totalQuantity − lessQuantity
totalAmount  = netQuantity × rate
totalPaid    = Σ(payments.amount)
due          = totalAmount − advance − totalPaid
```

Negative balances are intentional when advances/payments exceed payable (PDFs show them accurately).

---

## 9. Filter System

Active filters combine with **AND** via `$and`, always scoped by `createdBy`:

```js
{
  $and: [
    { createdBy: userId },
    { $or: [
        { merchantName: /Ramesh/i },
        { merchantPhone: /Ramesh/i },
        { merchant: { $in: [...] } }
      ] },
    { teaType: 'Green Tea' },
    { transactionDate: { $gte: start, $lte: end } }
  ]
}
```

User input is escaped before regex use (ReDoS mitigation):

```js
const safe = input.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

---

## 10. PDF / Invoice Generation

### Endpoints

| Endpoint | Query | Output |
|---|---|---|
| `GET /api/merchant-transactions/:id/invoice` | `format=pdf\|html` | Single payment voucher |
| `GET /api/merchant-transactions/invoice/by-merchant-date` | `merchantName` (required); `date` **or** `startDate`+`endDate`; `format` | Multi-txn voucher (includes advances + master payments in range) |
| `GET /api/factory/:id/invoice` | `format` | Single factory invoice |
| `GET /api/factory/invoice/by-buyer` | `buyerName` (required); `format` | Factory statement for buyer |

Default format: **pdf**.

### Chromium resolution (`generatePdf`)

```
1. Non-Windows: try @sparticuz/chromium first
2. Else PUPPETEER_EXECUTABLE_PATH
3. Else platform defaults:
     Windows → Chrome install paths
     Linux   → /usr/bin/chromium-browser | chromium | google-chrome
4. puppeteer-core dynamic import (ESM)
5. page.setContent(html, { waitUntil: 'networkidle0' })
6. page.pdf({ format: 'A4', printBackground: true, margins… })
7. browser.close() in finally
```

### Invoice template notes

| Topic | Guidance |
|---|---|
| Rupee symbol | Use `&#x20B9;` (`const RS`) — not UTF-8 `₹` |
| Headers | `thead th { white-space: nowrap; }` + `<colgroup>` widths |
| Watermark | `position: fixed; z-index: 0; opacity: 0.07` — content at `z-index: 1` |
| Numbers | `text-align: right` (class `num`) |
| Logo | `assets/logo.png` embedded as base64 |

---

## 11. Security

| Measure | Implementation |
|---|---|
| Helmet | `helmet()` with `crossOriginResourcePolicy: 'cross-origin'` |
| Rate limiting | 300 req / 2 min on `/api` |
| CORS allowlist | Only `ALLOWED_ORIGINS`; `credentials: true` |
| Body limit | 10 mb JSON / urlencoded |
| Request timeout | 10 s → HTTP 503 |
| Input validation | `express-validator` on mutation routes |
| Regex sanitization | Filter strings escaped before MongoDB regex |
| JWT auth | Bearer access + httpOnly refresh rotation + reuse detection |
| Passwords | bcrypt |
| Data isolation | `createdBy` on domain models |
| Errors | Stack hidden when `NODE_ENV=production` |
| Async safety | `express-async-errors` |

### Production caveats

- `requireRole` is unused — Admin has no extra API powers.
- `POST /api/auth/reset-password` is unauthenticated (phone + newPassword only).
- Fallback JWT secrets exist if env vars are unset — always set secrets in production.

---

## 12. MongoDB Index Strategy

### MerchantTransaction
```
{ transactionId: 1 }                              // unique
{ createdBy: 1, merchantName: 1, transactionDate: -1 }
{ createdBy: 1, merchantPhone: 1, transactionDate: -1 }
{ createdBy: 1, merchant: 1, transactionDate: -1 }
{ createdBy: 1, transactionDate: -1 }
{ createdBy: 1, teaType: 1, transactionDate: -1 }
```

### Merchant / Buyer
```
{ name: 'text' }
{ phone: 1, createdBy: 1 }   // unique per user
{ createdBy: 1, name: 1 }
```

### Factory
```
{ createdBy: 1, buyer: 1, date: -1 }
{ createdBy: 1, date: -1 }
buyerName field index
```

### MerchantMasterPayment
```
{ merchant: 1, createdBy: 1, paymentDate: -1 }
```

### TeaMerchant
```
{ batchId: 1 }   // unique
```

---

## 13. Migration Scripts

Run with `MONGO_URI` set (e.g. `node scripts/migrate-merchants.js`):

| Script | Purpose |
|---|---|
| `scripts/migrate-merchants.js` | Create Merchant docs from txn names without refs; phone `LEGACY-00N`; link txns |
| `scripts/migrate-buyers.js` | Same for Factory `buyerName` → Buyer (`LEGACY-B00N`) |
| `scripts/migrate-createdBy.js` | Stamp `createdBy` on legacy docs; drop old global `phone_1` unique indexes |

`package.json` start script: `"start": "nodemon server.js"` (production Docker/nixpacks use `node server.js`).

---

## 14. Deployment Guide

### Railway (recommended backend)

`nixpacks.toml` installs Chromium and sets:

```
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

Required env vars:

```
PORT=8080
NODE_ENV=production
MONGO_URI=mongodb+srv://...
JWT_SECRET=<strong-secret>
JWT_REFRESH_SECRET=<strong-secret>
ALLOWED_ORIGINS=https://your-frontend.vercel.app
```

Start command: `node server.js`

### Docker

```dockerfile
FROM node:20-bookworm-slim
# Installs chromium + shared libs (see repo Dockerfile)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

Set `PORT=8080` in the container environment to match `EXPOSE`.

### Vercel (frontend — separate repo)

1. Connect the frontend project to Vercel  
2. Set `VITE_API_BASE_URL=https://your-backend.railway.app/api`  
3. Build: `npm run build` → output `dist`  
4. Ensure the frontend origin is listed in backend `ALLOWED_ORIGINS`

Backend can also export for Vercel serverless when `VERCEL` is set (`module.exports = app` from `server.js`).

---

## 15. Known Issues & Fixes

| Issue | Root Cause | Fix Applied |
|---|---|---|
| ₹ shows as `?` in PDF | UTF-8 literal in HTML | Use `&#x20B9;` HTML entity |
| Table headers wrap to 2 lines | No `white-space: nowrap` | Added to `thead th` + colgroup widths |
| Watermark blocks row backgrounds | `z-index: -10` on watermark | `fixed` + `z-index: 0`; content at `z-index: 1` |
| Puppeteer require() crash | puppeteer-core v21+ is ESM | `await import('puppeteer-core')` |
| Chrome path hardcoded to Windows | No multi-platform detection | Sparticuz → env → platform paths |
| Phone search not filtering | Only name searched | Denormalized `merchantPhone` + `$or` |
| AND filter broken | Params overwrote each other | `andConditions[]` → `{ $and: [...] }` |
| Update zeroed amounts / false "Paid" | `findOneAndUpdate` calc used only `$set` | Merge existing doc + update before `computeFields` |
| Negative balances floored to 0 | `Math.max(0, …)` on net final | Removed floor so PDFs show true overpayment |
| Global phone unique blocked multi-tenant | Old `{ phone: 1 }` unique | Compound `{ phone, createdBy }` + migration script |

### Orphan / legacy notes

- `routes/merchantAdvanceRoutes.js` exists but is **not mounted** — advances live under `/api/merchants/:merchantId/advances`.
- `html-pdf-node` is in `package.json` but unused; PDFs use Puppeteer.
- Frontend UI components are documented in the frontend repo, not here.
