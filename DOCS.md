# DOOARS GREEN FPO — System Documentation

> **Version:** 2.1 (Production)
> **Updated:** July 2026 — refreshed after full codebase audit
> **Stack:** Node.js · Express · MongoDB (Mongoose) · Puppeteer-core · JWT Auth
> **Repo scope:** This repository contains the **backend API only** (`teanest-backend`). The React/Vite frontend ("Dooars green frontend") is deployed separately and is **not** part of this repository.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Environment Variables](#2-environment-variables)
3. [Data Models](#3-data-models)
4. [Multi-Tenancy & Data Isolation](#4-multi-tenancy--data-isolation)
5. [Authentication & Session Management](#5-authentication--session-management)
6. [API Routes Reference](#6-api-routes-reference)
7. [Filter System](#7-filter-system)
8. [CSV Import Pipeline (Merchant Transactions)](#8-csv-import-pipeline-merchant-transactions)
9. [PDF Invoice Generation Flow](#9-pdf-invoice-generation-flow)
10. [Invoice Template Guide](#10-invoice-template-guide)
11. [Security](#11-security)
12. [MongoDB Index Strategy](#12-mongodb-index-strategy)
13. [One-Time Migration Scripts](#13-one-time-migration-scripts)
14. [Deployment Guide](#14-deployment-guide)
15. [Known Issues & Audit Findings](#15-known-issues--audit-findings)

---

## 1. Architecture Overview

```
Browser  ──▶  Vite (React, separate repo)  ──▶  Express API (this repo)  ──▶  MongoDB
                                                        │
                                                   Puppeteer-core (PDF)
                                                        │
                                          @sparticuz/chromium (serverless) OR
                                          system Chromium (Docker / Railway / local)
```

**Entry point:** `server.js` → boots `config/db.js` (Mongoose connect) → mounts `app.js` (Express app)
**App wiring:** `app.js` → security/parsing middleware → `routes/index.js` → per-resource routers → controllers → models
**Backend port:** `8080` in Docker/Railway, falls back to `process.env.PORT || 5000` in `server.js`
**Serverless-aware:** `server.js` skips `app.listen()` when `process.env.VERCEL` is set, exporting `app` instead (Vercel serverless function contract)

### Directory layout

| Path | Purpose |
|---|---|
| `app.js` | Express app bootstrap: helmet, CORS, body parsing, cookies, morgan logging, global timeout, rate limiting, route mounting, error handler |
| `server.js` | Process entry point: connects DB, starts HTTP listener (or exports app for Vercel) |
| `config/db.js` | Mongoose connection (`MONGO_URI`) |
| `models/` | 11 Mongoose schemas (see [§3](#3-data-models)) |
| `controllers/` | 14 controllers — one per resource, plus `invoiceController.js` (PDF generation) and `dashboardController.js` (aggregated KPIs) |
| `routes/` | Express routers, one per resource, wired together in `routes/index.js` |
| `middleware/` | `auth.js` (JWT `protect` + `requireRole`), `errorHandler.js` (global error formatter) |
| `validators/` | `express-validator` rule sets per resource |
| `scripts/` | One-off/idempotent data-migration scripts (not run automatically) |
| `assets/` | `logo.png` embedded (base64) into invoice PDFs |
| `Dockerfile` / `nixpacks.toml` | Container build definitions that install a system Chromium for Puppeteer |

### Request lifecycle

```
Request → helmet → CORS allowlist → JSON/urlencoded body parser → cookie-parser
        → morgan (colored logs) → 10s timeout guard → rate limiter (300 req / 2 min)
        → /api router → [protect JWT middleware, per-resource] → validators → controller
        → (success) res.json(...)  |  (error) next(err) → errorHandler → JSON error response
```

`express-async-errors` is required at the very top of `app.js`, so any `async` controller that throws is automatically forwarded to the error handler — no manual `try/catch { next(err) }` boilerplate is strictly required (though many controllers still do it defensively/inconsistently — see [§15](#15-known-issues--audit-findings)).

---

## 2. Environment Variables

### Backend (`.env`, loaded by both `app.js` and `server.js` via `dotenv`)

| Variable | Required | Default (if unset) | Description |
|---|---|---|---|
| `PORT` | No | `5000` (`8080` in Docker/Railway) | HTTP listen port |
| `NODE_ENV` | Recommended | — | `production` disables stack traces in error responses and enables secure cookies |
| `MONGO_URI` | **Yes** | — | MongoDB connection string; process exits if connection fails (`config/db.js`) |
| `JWT_SECRET` | **Yes** (has insecure fallback) | `'access_fallback_secret'` | Access-token signing secret |
| `JWT_REFRESH_SECRET` | **Yes** (has insecure fallback) | `'refresh_fallback_secret'` | Refresh-token signing secret |
| `ALLOWED_ORIGINS` | Recommended | `http://localhost:5173` | Comma-separated list of allowed CORS origins (frontend URLs) |
| `PUPPETEER_EXECUTABLE_PATH` | Optional | auto-detected | Explicit path to a Chrome/Chromium binary; overrides `@sparticuz/chromium` and platform auto-detection |
| `VERCEL` | Auto-set by Vercel | — | When present, `server.js` skips `app.listen()` (serverless mode) |

> **Note:** `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` are **not** read anywhere in the code — token lifetimes are hardcoded in `controllers/authController.js` (`ACCESS_EXPIRY = '1h'`, `REFRESH_EXPIRY = '7d'`). If your deployment config sets these env vars expecting them to take effect, they are currently ignored (see [§15](#15-known-issues--audit-findings)).

### Frontend (separate repo — for reference only)

| Variable | Description |
|---|---|
| `VITE_API_BASE_URL` | Backend API base URL, e.g. `https://your-backend.railway.app/api` |

---

## 3. Data Models

All models except `User` include a required `createdBy` (ObjectId → `User`) field used for per-tenant data isolation (see [§4](#4-multi-tenancy--data-isolation)).

| Model | File | Purpose |
|---|---|---|
| `User` | `models/User.js` | Login identity (`phone` + hashed `password`), `role` (`Admin`\|`Manager`), array of hashed `refreshTokens` for session rotation |
| `Merchant` | `models/Merchant.js` | Master record for a tea-leaf supplier ("farmer/merchant"): `name`, `phone` (unique **per user**), `address`, `notes` |
| `MerchantTransaction` | `models/MerchantTransaction.js` | A single leaf-procurement transaction against a `Merchant`. Stores raw inputs (`grossQty`, `lessPercent`, `ratePerKg`, `labourHeadCount`, `labourCharge`, `advancePayment`) plus **persisted derived fields** recalculated on every save/update (see calculation chain below) |
| `MerchantPayment` | `models/MerchantPayment.js` | An individual payment recorded against one `MerchantTransaction`; reduces that transaction's `balance` |
| `MerchantAdvance` | `models/MerchantAdvance.js` | A standalone cash advance to a merchant, **not tied to any specific transaction** — reduces the merchant's aggregate outstanding balance on the dashboard/statement |
| `MerchantMasterPayment` | `models/MerchantMasterPayment.js` | A direct/bulk payment to a merchant at the **merchant level** (not per-transaction) — e.g. a weekly lump-sum settlement |
| `Buyer` | `models/Buyer.js` | Master record for a factory tea buyer: `name`, `phone` (unique **per user**), `address`, `notes` |
| `Factory` | `models/Factory.js` | A factory tea sale to a `Buyer`. Stores raw inputs (`totalQuantity`, `lessPercentage`, `rate`, `advance`, embedded `payments[]`) and exposes **virtuals** (`lessQuantity`, `netQuantity`, `totalAmount`, `totalPaid`, `due`) computed on read, not persisted |
| `Labor` | `models/Labor.js` | Estate workforce/labor-gang entry: `role`, `headCount`, `laborCharge` (per head), derived `totalPayable`, `paymentStatus` (`Due`\|`Paid`) toggled via a dedicated endpoint |
| `Payment` | `models/Payment.js` | Generic standalone payment ledger (`payeeName`, `paymentType`: Salary/Advance/Bonus/Supplier/Other, `status`: Pending/Completed/Failed) — independent of the merchant/factory payment flows above |
| `TeaMerchant` | `models/TeaMerchant.js` | **Legacy/parallel model** — a simple tea-batch ledger (`batchId`, `quantity`, `pricePerUnit`, virtual `totalValue`). Served by `/api/merchant` + `merchantController.js`. Functionally unrelated to `Merchant`/`MerchantTransaction` despite the similar name — see [§15](#15-known-issues--audit-findings) |

### MerchantTransaction calculation chain

All derived fields are **stored** (not virtual) so they remain queryable/aggregatable, and are recomputed automatically by Mongoose hooks on both `.save()` and `findOneAndUpdate()`:

```
lessQty      = grossQty * (lessPercent / 100)
netQty       = grossQty - lessQty
grossAmount  = netQty * ratePerKg
labourAmount = labourHeadCount * labourCharge
netPayable   = grossAmount - labourAmount
finalPayable = netPayable - advancePayment
balance      = finalPayable - Σ(MerchantPayment.amount for this transaction)
```

`balance` is **not floored at zero** — a merchant who was overpaid (advances/payments exceed what's owed) will show a negative balance, which is intentional (fixed in commit `072dd3c`, documented in [§15](#15-known-issues--audit-findings) history).

The `pre('findOneAndUpdate')` hook explicitly merges the **existing document** with the incoming `$set` payload before recomputing, specifically to avoid a historical bug where a partial update (e.g. only changing `notes`) would zero out all derived fields because `computeFields()` received `undefined` for `grossQty`, `ratePerKg`, etc.

### Factory virtuals

Unlike `MerchantTransaction`, `Factory` computes `lessQuantity`, `netQuantity`, `totalAmount`, `totalPaid`, and `due` as **Mongoose virtuals** (not persisted), exposed via `toJSON`/`toObject({ virtuals: true })`. All virtuals use `|| 0` / `|| []` fallbacks so pre-existing documents created under older schema versions never throw.

---

## 4. Multi-Tenancy & Data Isolation

The application is **multi-tenant**: every logged-in user (`User`) only ever sees data they created. This was introduced in commit `37d89c6` ("implement multi-tenancy data isolation") and is enforced **at the controller/query level**, not via a MongoDB row-level-security feature — i.e. every controller is individually responsible for scoping its queries with `{ createdBy: req.user._id }`.

Key implications:

- **Phone uniqueness is per-user, not global.** `Merchant` and `Buyer` both use a compound unique index `{ phone: 1, createdBy: 1 }` — two different users can each register a merchant/buyer with the same phone number, and it's treated as two independent tenant records.
- **Every list/read/write controller must explicitly filter by `createdBy`.** This was audited resource-by-resource; one gap was found — see the `generateFactoryInvoice` finding in [§15](#15-known-issues--audit-findings).
- **Migration required** for any data created before multi-tenancy was introduced — see `scripts/migrate-createdBy.js` in [§13](#13-one-time-migration-scripts).
- **Legacy data placeholder phones** — `scripts/migrate-buyers.js` and `scripts/migrate-merchants.js` backfill `LEGACY-###` phone numbers for buyers/merchants that existed only as free-text name strings before their master records existed; these need manual correction with real numbers post-migration.

---

## 5. Authentication & Session Management

Implemented in `controllers/authController.js` + `middleware/auth.js`. Stateless JWT access tokens combined with a stateful, rotating refresh-token allowlist stored on the `User` document.

| Token | Lifetime | Transport | Storage |
|---|---|---|---|
| **Access token** | `1h` (hardcoded `ACCESS_EXPIRY`) | Returned in JSON response body, sent by client as `Authorization: Bearer <token>` | Not persisted server-side (stateless JWT) |
| **Refresh token** | `7d` (hardcoded `REFRESH_EXPIRY`) | Set as an `httpOnly`, `sameSite: strict` cookie (`secure` when `NODE_ENV=production`) | SHA-256 hash stored in `user.refreshTokens[]` |

### Flow

1. **Register/Login** (`POST /api/auth/register` / `/login`) — issues both tokens; the refresh token's hash is pushed onto `user.refreshTokens`, capped at **5 concurrent sessions** (oldest evicted via `.slice(-5)`).
2. **Access to protected routes** — `middleware/auth.js`'s `protect` verifies the access token, re-fetches the user from the DB (so a deleted/disabled user is rejected even with a still-valid token), and attaches `req.user`.
3. **Refresh** (`POST /api/auth/refresh`) — reads the refresh cookie, verifies signature/expiry, confirms the token's hash is still present in `user.refreshTokens` (replay/reuse detection), then **rotates**: issues a new access+refresh pair, removes the old hash, appends the new one.
   - If the presented refresh token's hash is **not** found in `user.refreshTokens` (i.e. it was already rotated out or never issued), **all sessions for that user are invalidated** — a defense against stolen/replayed refresh tokens.
4. **Logout** (`POST /api/auth/logout`) — removes just that session's hash and clears the cookie.
5. **Reset Password** (`POST /api/auth/reset-password`) — re-hashes the password and clears **all** `refreshTokens` (forces re-login everywhere).

Error codes returned by `protect` for the frontend to distinguish: `NO_TOKEN`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `USER_NOT_FOUND` (all HTTP 401). The frontend is expected to call `/api/auth/refresh` automatically on a `TOKEN_EXPIRED` response.

`requireRole(...roles)` exists in `middleware/auth.js` for role-gating (`Admin` / `Manager`) but is **not currently applied to any route** — all authenticated users have equal access regardless of role today.

---

## 6. API Routes Reference

All routes are mounted under `/api` (see `app.js`: `app.use('/api', limiter, routes)`). Every router except `/api/auth` is wrapped in the `protect` JWT middleware (`routes/index.js`).

### Auth — `/api/auth` (public)

| Method | Path | Description |
|---|---|---|
| POST | `/register` | Create user, issue tokens |
| POST | `/login` | Authenticate, issue tokens |
| POST | `/refresh` | Rotate access+refresh token pair using the httpOnly cookie |
| POST | `/logout` | Invalidate current session |
| POST | `/reset-password` | Reset password by phone, invalidate all sessions |

### Users — `/api/users`

| Method | Path | Description |
|---|---|---|
| GET | `/me` | Current user profile |
| PUT | `/me` | Update name/phone |
| PUT | `/change-password` | Change password (requires current password) |

### Merchants (master) — `/api/merchants`

| Method | Path | Description |
|---|---|---|
| GET | `/search?q=` | Top-15 autocomplete by name/phone |
| GET | `/` | List, paginated, `?search=` |
| GET | `/:id` | Detail + aggregated transaction stats |
| POST | `/` | `findOrCreate` — 400 if phone already exists for this user |
| PUT | `/:id` | Update; cascades `name` change into linked `MerchantTransaction.merchantName` |
| DELETE | `/:id` | Blocked (409) if linked transactions exist |
| GET / POST | `/:merchantId/advances` | Standalone advances for a merchant |
| DELETE | `/:merchantId/advances/:advanceId` | Remove an advance |
| GET / POST | `/:merchantId/payments` | Merchant-level (non-transaction) payments |
| DELETE | `/:merchantId/payments/:paymentId` | Remove a merchant-level payment |

### Buyers — `/api/buyers`

| Method | Path | Description |
|---|---|---|
| GET | `/search?q=` | Top-15 autocomplete by name/phone |
| GET | `/` | List, paginated, `?search=` |
| GET | `/:id` | Detail + aggregated factory stats |
| POST | `/` | `findOrCreate` — returns existing buyer if phone matches (unlike Merchant, this **updates** the name on the existing record rather than rejecting) |
| PUT | `/:id` | Update; cascades `name` into linked `Factory.buyerName` |
| DELETE | `/:id` | Blocked (409) if linked factory records exist |

### Merchant Transactions — `/api/merchant-transactions`

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Summary + by-tea-type breakdown + 5 most recent |
| GET | `/invoice/by-merchant-date?merchantName=&date=\|startDate=&endDate=&format=pdf\|html` | Combined statement across a date range, including advances + master payments |
| GET | `/` | List with combined AND filters (see [§7](#7-filter-system)) |
| POST | `/import?preview=true\|false` | Upload CSV (`multipart/form-data`, field `file`) — preview or direct-insert (see [§8](#8-csv-import-pipeline-merchant-transactions)) |
| POST | `/import-confirm` | Insert a confirmed JSON array (`{ items: [...] }`) from the preview step |
| GET | `/:id/invoice?format=pdf\|html` | Single-transaction voucher PDF/HTML |
| GET | `/:id` | Detail |
| POST | `/` | Create — auto-generates `transactionId`, auto-links/creates `Merchant` by phone |
| PUT | `/:id` | Update — recalculates all derived fields + balance |
| DELETE | `/:id` | Delete — cascades delete of related `MerchantPayment`s |
| GET / POST | `/:txnId/payments` | Payments against a transaction; rejects if already fully paid or amount exceeds remaining balance |
| DELETE | `/:txnId/payments/:payId` | Remove a payment; recalculates transaction balance |

### Factory (sales to buyers) — `/api/factory`

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Aggregate revenue/advance/paid/due |
| GET | `/` | List with combined AND filters (see [§7](#7-filter-system)) |
| POST | `/` | Create |
| GET | `/invoice/by-buyer?buyerName=&format=` | Multi-record statement for a buyer (scoped by `createdBy`) |
| GET | `/:id/invoice?format=` | Single-record invoice — **⚠ not scoped by `createdBy`**, see [§15](#15-known-issues--audit-findings) |
| GET | `/:id` | Detail |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |
| POST | `/:id/payments` | Append an embedded payment |
| DELETE | `/:id/payments/:paymentId` | Remove an embedded payment |

### Labor — `/api/labor`

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Totals + breakdown by role |
| GET | `/` | List, filters: `role`, `paymentStatus`, `search` |
| POST | `/` | Create — server computes `totalPayable = headCount * laborCharge` |
| GET | `/:id` | Detail |
| PUT | `/:id` | Update — recomputes `totalPayable` |
| DELETE | `/:id` | Delete |
| PATCH | `/:id/pay` | Toggle `paymentStatus` between `Due` ⇄ `Paid` |

### Payments (generic ledger) — `/api/payments`

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Totals + breakdown by `paymentType` |
| GET | `/` | List, filters: `paymentType`, `status`, `search` |
| POST / GET /:id / PUT /:id / DELETE /:id | Standard CRUD |

### Dashboard — `/api/dashboard`

| Method | Path | Description |
|---|---|---|
| GET | `/` | Single aggregated payload: KPIs, merchant/factory stats, 8 most recent records of each, top-5 due merchants, top-5 due buyers — all scoped to `req.user._id` (see `dashboardController.js`) |

### Legacy — `/api/merchant` (TeaMerchant model — see [§15](#15-known-issues--audit-findings))

| Method | Path | Description |
|---|---|---|
| GET | `/stats` | Batch totals + breakdown by tea type |
| GET | `/` | List, filters: `teaType`, `search` |
| POST / GET /:id / PUT /:id / DELETE /:id | Standard CRUD for `TeaMerchant` batches |

### Standard error response format (all resources)

```json
{
  "success": false,
  "message": "Human-readable error",
  "errors": [{ "field": "grossQty", "message": "must be positive" }]
}
```

---

## 7. Filter System

`merchant-transactions`, `factory`, `buyers`, and `labor` list endpoints support combined filters that AND together. The two most complex (`merchant-transactions`, `factory`) build an explicit `$and` array to avoid the historical bug where multiple `filter.x = ...` assignments silently overwrote one another:

```js
// Example: search="Ramesh" AND teaType="Green Tea" AND date range
{
  $and: [
    { createdBy: userId },
    { $or: [{ merchantName: /Ramesh/i }, { merchantPhone: /Ramesh/i }, { merchant: { $in: [...] } }] },
    { teaType: 'Green Tea' },
    { transactionDate: { $gte: start, $lte: end } }
  ]
}
```

| Resource | Supported params |
|---|---|
| `merchant-transactions` | `search` (name OR phone), `merchantName`, `phone`, `teaType`, `startDate`, `endDate` |
| `factory` | `search` (buyerName OR linked buyer phone), `name`, `phone`, `startDate`, `endDate` |
| `buyers` | `search` (name OR phone) |
| `labor` | `role`, `paymentStatus`, `search` (name) |

All active filters are always additionally scoped by `{ createdBy: userId }` (see [§4](#4-multi-tenancy--data-isolation)).

All user-supplied search strings are escaped before being used to build a `RegExp`, to prevent regex-injection/ReDoS:

```js
const safe = input.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

An explicit `phone` filter with no matching merchant/buyer **short-circuits to an empty result set** rather than falling through to return unfiltered data.

---

## 8. CSV Import Pipeline (Merchant Transactions)

`POST /api/merchant-transactions/import` (multipart file upload, `multer` in-memory storage) and `POST /api/merchant-transactions/import-confirm` (JSON body) implement a two-step import flow intended to let the frontend show a preview/edit screen before committing:

1. **Preview** — `POST /import?preview=true` parses the CSV (`csv-parser`, strips BOM/zero-width chars from headers, trims values), validates required columns (`merchantName`, `teaType`, `grossQty`, `ratePerKg`), and returns `{ preview: validRows, errors }` **without writing to the database**.
2. **User reviews/edits** in the frontend.
3. **Confirm** — `POST /import-confirm` with `{ items: [...] }` performs the actual inserts: for each row, auto-links or auto-creates a `Merchant` by phone, computes derived fields via `MerchantTransaction.computeFields()`, generates a `transactionId`, and creates the document. Returns `207 Multi-Status` if some rows failed, `200` if all succeeded.

There is also a **direct-insert fallback** path (`POST /import` **without** `?preview=true`) that performs the same insert logic in one request — intended for callers that bypass the preview step.

> **⚠ Both the direct-insert fallback and `/import-confirm` currently crash** — they call `require('../utils/genTxnId')()`, but no `utils/` directory exists in this repository. This makes every row fail with an unhandled `MODULE_NOT_FOUND` error. See [§15](#15-known-issues--audit-findings) for the fix.

---

## 9. PDF Invoice Generation Flow

Implemented in `controllers/invoiceController.js` (~1,440 lines — HTML template builders + `generatePdf()`).

```
generatePdf(html) called
  1. Dynamic-import puppeteer-core (required — puppeteer-core v21+ is ESM-only,
     `require()` would throw)
  2. Resolve Chromium executable, in priority order:
     a. Non-Windows platforms: try @sparticuz/chromium (serverless-optimized binary)
     b. PUPPETEER_EXECUTABLE_PATH env var
     c. Windows: search common Chrome/Chromium install paths
     d. Linux: search /usr/bin/chromium-browser, /usr/bin/chromium, /usr/bin/google-chrome
  3. puppeteer.launch({ headless: 'shell', args: [...sparticuz or hardcoded no-sandbox flags] })
  4. page.setViewport({ width: 794, height: 1123 })   // A4 @ 96dpi
  5. page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 })
  6. page.pdf({ format: 'A4', printBackground: true, margin: {10mm/8mm} })
  7. Buffer.from(pdfData)   // puppeteer-core v25+ returns Uint8Array, not Buffer
  8. browser.close() in a finally block — always runs, even on error
```

`headless: 'shell'` (rather than `true`/`'new'`) was specifically chosen to bypass a D-Bus/display-server crash previously seen on Railway (commit `3bdea56`).

### Invoice endpoints and their HTML builders

| Endpoint | Builder function | Notes |
|---|---|---|
| `GET /merchant-transactions/:id/invoice` | `buildInvoiceHtml` | Single transaction voucher |
| `GET /merchant-transactions/invoice/by-merchant-date` | `buildMultiInvoiceHtml` | Multi-transaction statement; interleaves payment rows, standalone advance rows, and merchant-master-payment rows chronologically; shows column averages (avg less %, avg rate, avg labour charge) in the total row |
| `GET /factory/:id/invoice` | (single-record factory template) | **Not scoped by `createdBy`** — see [§15](#15-known-issues--audit-findings) |
| `GET /factory/invoice/by-buyer` | `buildMultiFactoryInvoiceHtml` | Multi-record buyer statement, scoped by `createdBy` |

Every generator accepts `?format=pdf` (default) or `?format=html` — `html` is primarily useful for visually debugging the template without round-tripping through Puppeteer.

---

## 10. Invoice Template Guide

### Rupee Symbol
Use `&#x20B9;` (stored as `const RS` in `invoiceController.js`) — **not** the raw UTF-8 `₹` literal, which historically rendered as `?`/tofu in some PDF engines.

### Font embedding for the ₹ glyph
The controller attempts to embed `assets/fonts/NotoSans-Regular.ttf` as a base64 `data:` URI (so serverless/minimal Linux containers without system fonts still render `₹` correctly), falling back silently (`try/catch`) to a Google Fonts `@import` + system sans-serif stack if the file is missing.
> **Note:** as of this audit, `assets/fonts/` does not exist in the repository — only `assets/logo.png` is present. The Google Fonts `@import` fallback is therefore always what actually renders today; this works but depends on network access to `fonts.googleapis.com` at PDF-render time (see [§15](#15-known-issues--audit-findings)).

### Header Single-Line Fix
```css
thead th { white-space: nowrap; }
```

### Watermark Fix
```css
.watermark-bg {
  position: fixed;   /* NOT absolute */
  z-index: 0;         /* NOT -10 */
  opacity: 0.07;
  pointer-events: none;
}
/* All content: z-index: 1 to appear above watermark */
```

### Column Alignment
- Numbers: `text-align: right` (class `num`)
- Text: `text-align: left` (class `left`)
- Table uses `table-layout: fixed` for predictable, proportional column widths

---

## 11. Security

| Measure | Implementation |
|---|---|
| Helmet headers | `helmet()` in `app.js`, with `crossOriginResourcePolicy: 'cross-origin'` so the logo/assets can be fetched cross-origin |
| Rate limiting | 300 requests / 2 minutes per client, via `express-rate-limit`, applied to the entire `/api` router |
| Global request timeout | 10s → `503` JSON response (`app.js`) |
| CORS allowlist | Only origins in `ALLOWED_ORIGINS` accepted; `credentials: true` so the httpOnly refresh cookie can be sent cross-site |
| Input validation | `express-validator` rule sets on all mutation routes (create/update) for most resources |
| Regex sanitization | All filter strings escaped before use in a MongoDB `RegExp` (prevents ReDoS / regex injection) |
| Password hashing | `bcryptjs`, cost factor 12 (auth controller) or 10 (`userController.changePassword` — inconsistent, see [§15](#15-known-issues--audit-findings)) |
| JWT auth | Short-lived access token (Bearer header) + httpOnly, `sameSite: strict` refresh cookie with hash-based rotation and reuse detection |
| Session cap | Max 5 concurrent refresh sessions per user; oldest evicted |
| Data isolation | Every resource query scoped by `createdBy` (multi-tenant) — see [§4](#4-multi-tenancy--data-isolation) for the one known gap |
| No stack traces in prod | `errorHandler` omits `err.stack` from the response when `NODE_ENV=production` |
| Mongoose error normalization | `ValidationError` → 400, `CastError` (bad ObjectId) → 400, duplicate key (`11000`) → 409, JWT errors → 401 |

---

## 12. MongoDB Index Strategy

Every collection with tenant data has a compound index leading with `createdBy` so per-user queries stay index-covered as data grows.

### MerchantTransaction
```
{ createdBy: 1, merchantName: 1, transactionDate: -1 }
{ createdBy: 1, merchantPhone: 1, transactionDate: -1 }
{ createdBy: 1, merchant: 1, transactionDate: -1 }
{ createdBy: 1, transactionDate: -1 }
{ createdBy: 1, teaType: 1, transactionDate: -1 }
{ transactionId: 1 }   // unique, global (not per-user)
```

### Merchant
```
{ name: 'text' }                       // text search — global, not user-scoped
{ phone: 1, createdBy: 1 }             // unique per user
{ createdBy: 1, name: 1 }
```

### Buyer
```
{ name: 'text' }
{ phone: 1, createdBy: 1 }             // unique per user
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

### User
```
{ phone: 1 }   // unique (implicit — global login identity, not tenant-scoped)
```

> Every other tenant-scoped model (`MerchantAdvance`, `MerchantPayment`, `Labor`, `Payment`, `TeaMerchant`) declares a single-field `createdBy` index (via `index: true` on the schema path) but no compound index combining `createdBy` with the fields most commonly filtered/sorted on (e.g. `paymentStatus`, `role`, `paymentDate`). This is acceptable at current data volumes but worth revisiting if those collections grow large — see [§15](#15-known-issues--audit-findings).

---

## 13. One-Time Migration Scripts

Located in `scripts/`. These are **not** run automatically on deploy — they must be invoked manually, once, against the production database when the corresponding feature shipped.

| Script | When to run | What it does |
|---|---|---|
| `migrate-createdBy.js` | After deploying multi-tenancy (commit `37d89c6`) | Backfills `createdBy` on every existing document across 9 collections to a single hardcoded `OWNER_USER_ID`; drops the old global-unique `phone_1` indexes on `merchants`/`buyers` so the new per-user compound indexes can take over. **Requires editing `OWNER_USER_ID` in the file before running.** |
| `migrate-merchants.js` | After introducing the `Merchant` master model | Groups existing `MerchantTransaction.merchantName` strings (case-insensitively), creates a `Merchant` doc per unique name with a placeholder `LEGACY-###` phone, and links each transaction's `merchant` field. Placeholder phones must be corrected manually afterward. |
| `migrate-buyers.js` | After introducing the `Buyer` master model | Same pattern as above, but for `Factory.buyerName` → `Buyer` linking (placeholder `LEGACY-B###` phones). |

Run with: `node scripts/<script-name>.js` (loads `.env` via `dotenv` relative to the script's own directory).

---

## 14. Deployment Guide

### Railway / Nixpacks (recommended for backend)

`nixpacks.toml` installs a full Chromium dependency chain (`chromium`, font libs, X11 shared libs) and hardcodes the start command:

```toml
[start]
cmd = "node server.js"

[variables]
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = "true"
PUPPETEER_EXECUTABLE_PATH = "/usr/bin/chromium"
```

Required env vars on the Railway dashboard:
```
PORT=8080
NODE_ENV=production
MONGO_URI=mongodb+srv://...
JWT_SECRET=<strong-secret>
JWT_REFRESH_SECRET=<strong-secret>
ALLOWED_ORIGINS=https://your-frontend.vercel.app
```
(`PUPPETEER_EXECUTABLE_PATH` is already set by `nixpacks.toml`'s `[variables]` block.)

### Docker

```dockerfile
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ...
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
```

### Vercel (serverless) or any platform without a system Chromium

Rely on `@sparticuz/chromium` (already a production dependency) — `generatePdf()` auto-detects and uses it on any non-Windows platform when `PUPPETEER_EXECUTABLE_PATH` is not set. No extra config needed beyond the standard env vars in [§2](#2-environment-variables).

### Vercel (frontend, separate repo)
1. Connect the frontend repo to Vercel
2. Set `VITE_API_BASE_URL=https://your-backend.railway.app/api`
3. Build command: `npm run build`, Output: `dist`

### ⚠ `npm start` caveat
`package.json`'s `start` script is `nodemon server.js`, but `nodemon` is a **devDependency**. Both `Dockerfile` and `nixpacks.toml` bypass this entirely by invoking `node server.js` directly, so production deploys via those paths are unaffected. If you ever deploy to a platform that defaults to running `npm start` with a `--production`/`--omit=dev` install, the process will fail to start (`nodemon: not found`). Recommended fix: add a separate `"serve": "node server.js"` script (or swap `start`/`dev`) so the production entry point never depends on a dev-only tool.

---

## 15. Known Issues & Audit Findings

The table below combines the previously-documented fix history with new findings from a full-codebase audit (July 2026). Items marked **NEW** were not previously documented and have not yet been fixed in code — they are recorded here as the direct output of "analyze the whole application" so they can be triaged.

| Issue | Root Cause | Status |
|---|---|---|
| ₹ shows as `?` in PDF | UTF-8 literal in HTML | ✅ Fixed — use `&#x20B9;` HTML entity |
| Table headers wrap to 2 lines | No `white-space: nowrap` | ✅ Fixed — added to `thead th` + fixed `<colgroup>` widths |
| Watermark blocks row backgrounds | `z-index: -10` on watermark | ✅ Fixed — `position: fixed` + `z-index: 0`; content promoted to `z-index: 1` |
| Puppeteer `require()` crash | `puppeteer-core` v21+ is ESM-only | ✅ Fixed — use `await import('puppeteer-core')` |
| Chrome path hardcoded to Windows | No multi-platform detection | ✅ Fixed — platform-aware path resolution + `PUPPETEER_EXECUTABLE_PATH` support + `@sparticuz/chromium` |
| Puppeteer headless crash on Railway | D-Bus/display-server dependency in `headless: true/'new'` | ✅ Fixed — switched to `headless: 'shell'` |
| Phone search not filtering | Only `merchantName` was searched | ✅ Fixed — denormalized `merchantPhone` field + `$or` across name/phone/merchant-ID |
| AND filter broken | Multiple `filter.x = ...` assignments overwrote each other | ✅ Fixed — refactored to `andConditions[]` → `{ $and: [...] }` |
| Negative balances floored to 0 | `Math.max(0, ...)` on `netFinalAmount` | ✅ Fixed — removed flooring so overpayment correctly shows as a negative balance |
| **CSV "confirm import" and direct-insert fallback crash** | `merchantTransactionController.js` (`importCsv` non-preview branch and `importJsonConfirm`) call `require('../utils/genTxnId')()`, but no `utils/` directory exists anywhere in the repo | ❌ **NEW — open bug.** Every row will fail with `MODULE_NOT_FOUND`. The controller already defines an equivalent local `genTxnId()` helper at the top of the file — the fix is to call that instead of the missing module. |
| **Factory single-invoice endpoint is not tenant-scoped** | `invoiceController.generateFactoryInvoice` calls `Factory.findById(id)` with no `createdBy` filter, unlike every other factory/merchant endpoint | ❌ **NEW — open bug / data-isolation gap.** Any authenticated user who can guess or observe another tenant's Factory record `_id` can download that tenant's invoice PDF via `GET /api/factory/:id/invoice`. `GET /api/factory/invoice/by-buyer` (the multi-record variant) is correctly scoped — only the single-record path is affected. |
| **"Total labour charges" KPIs are always zero** | Two independent bugs: (1) `merchantTransactionController.getStats` aggregates a non-existent field `$laborCharges` (schema has `labourAmount`/`totalLaborCharges`, not `laborCharges`); (2) `dashboardController` correctly aggregates `$totalLaborCharges`, but that schema field is never populated by `computeFields()` (only `labourAmount` is) — it sits at its default of `0` forever | ❌ **NEW — reporting-only bug.** Does not affect `finalPayable`/`balance` correctness (those correctly subtract `labourAmount`); only the standalone "total labour charges" statistic shown in `/stats` and `/dashboard` is wrong. |
| **`routes/merchantAdvanceRoutes.js` is dead code** | `routes/merchantMasterRoutes.js` implements the identical `/:merchantId/advances` endpoints inline (importing `merchantAdvanceController` directly) instead of mounting this router file | ❌ **NEW — cleanup opportunity.** The file is never `require()`'d from anywhere; safe to delete or wire in properly to avoid confusion/drift between the two copies of the same route definitions. |
| **Two unrelated "merchant" concepts share confusingly similar names** | `Merchant`/`MerchantTransaction` (the real, actively-used leaf-procurement system, mounted at `/api/merchants` and `/api/merchant-transactions`) vs. `TeaMerchant` (a simple, apparently-legacy batch ledger, mounted at `/api/merchant`, singular) | ❌ **NEW — maintainability risk.** No code cross-references `TeaMerchant` from the main merchant/transaction/invoice/dashboard flows, suggesting it predates or was superseded by the current model. Recommend confirming with the frontend whether `/api/merchant` is still consumed, and archiving/removing it if not. |
| **`bcryptjs` cost factor is inconsistent** | `authController.js` hashes with `bcrypt.hash(password, 12)`; `userController.changePassword` hashes with `bcrypt.genSalt(10)` | ⚠️ **NEW — minor inconsistency.** Both are reasonable cost factors; recommend unifying on one constant to avoid confusion. |
| **`JWT_*_EXPIRES_IN` env vars are unused** | `authController.js` hardcodes `'1h'`/`'7d'` instead of reading `process.env.JWT_ACCESS_EXPIRES_IN`/`JWT_REFRESH_EXPIRES_IN` | ⚠️ **NEW — config drift risk.** If these env vars are set in a deployment's dashboard expecting them to configure token lifetime, they currently have no effect. |
| **`npm start` depends on a devDependency** | `package.json`'s `start` script is `nodemon server.js`; `nodemon` is in `devDependencies` | ⚠️ **NEW — deployment risk**, mitigated today because `Dockerfile`/`nixpacks.toml` both call `node server.js` directly instead of `npm start`. See [§14](#14-deployment-guide). |
| **British vs. American spelling inconsistency for "labour"/"labor"** | `MerchantTransaction` uses `labour*` (British); `Labor` model, `Payment.paymentType`, and route names use `labor*`/`Labor` (American) | ℹ️ **NEW — cosmetic**, but was a contributing factor in the `laborCharges` field-name bug above; worth standardizing on one spelling going forward. |
