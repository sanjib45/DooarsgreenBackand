# DOOARS GREEN FPO — System Documentation

> **Version:** 2.2 (Production)  
> **Updated:** July 17, 2026  
> **Stack:** Node.js · Express · MongoDB Atlas · Puppeteer · React 18 (Vite) · Tailwind CSS

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Repository Layout](#2-repository-layout)
3. [Environment Variables](#3-environment-variables)
4. [Backend — Bootstrap & Security](#4-backend--bootstrap--security)
5. [Auth System](#5-auth-system)
6. [API Routes Reference](#6-api-routes-reference)
7. [Data Models](#7-data-models)
8. [Filter System](#8-filter-system)
9. [PDF Generation & Invoices](#9-pdf-generation--invoices)
10. [Invoice Template Guide](#10-invoice-template-guide)
11. [Frontend — App Structure](#11-frontend--app-structure)
12. [Frontend — Pages & Features](#12-frontend--pages--features)
13. [Frontend — Components](#13-frontend--components)
14. [Frontend — API Client](#14-frontend--api-client)
15. [MongoDB Index Strategy](#15-mongodb-index-strategy)
16. [Migration Scripts](#16-migration-scripts)
17. [Deployment Guide](#17-deployment-guide)
18. [Known Issues & Fixes](#18-known-issues--fixes)
19. [Production Deploy Checklist](#19-production-deploy-checklist)
20. [Production Risks & API Smoke Tests](#20-production-risks--api-smoke-tests)

---

## 1. Architecture Overview

```
Browser  ──▶  Vite (React SPA)  ──▶  Express API (/api)  ──▶  MongoDB Atlas
   │                                      │
   │                                 Puppeteer (PDF)
   │                                      │
localStorage                         @sparticuz/chromium
(accessToken)                        (Serverless / Railway)
```

| Layer | Location | Port / Host |
|---|---|---|
| Frontend | `Dooars greenfrontend` | Vite `5173` (dev) · Vercel (prod) |
| Backend | `DooarsGreenbackend` | `PORT` env (default `5000` in `server.js`; often `8080` in deploy) |
| Database | MongoDB Atlas | via `MONGO_URI` |

**Multi-tenant isolation:** Every business record is scoped by `createdBy` → `User._id`. Dashboard, lists, and invoices all respect this.

**Two “merchant” concepts (important):**

| API path | Model | Meaning |
|---|---|---|
| `/api/merchants` | `Merchant` | Procurement suppliers (master) — used by UI |
| `/api/merchant` | `TeaMerchant` | Tea batch / harvest records — API exists; **UI does not use it** |
| `/api/merchant-transactions` | `MerchantTransaction` | Leaf procurement transactions — main Merchant page |

---

## 2. Repository Layout

```
New folder/
├── DooarsGreenbackend/          # Express API
│   ├── server.js                # Entry: connect DB → listen
│   ├── app.js                   # Express bootstrap, CORS, rate limit
│   ├── config/db.js
│   ├── middleware/              # auth.js, errorHandler.js
│   ├── models/                  # 11 Mongoose models
│   ├── controllers/
│   ├── routes/
│   ├── validators/
│   ├── scripts/                 # One-time migrations
│   └── assets/                  # logo, fonts for PDF
│
└── Dooars greenfrontend/        # React SPA
    ├── src/
    │   ├── App.jsx              # Router + ProtectedRoute
    │   ├── api/                 # Axios modules
    │   ├── pages/
    │   └── components/
    ├── vite.config.js           # Dev proxy → :8080
    └── vercel.json              # SPA rewrite
```

---

## 3. Environment Variables

### Backend

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | Server port (`server.js` default `5000`) |
| `NODE_ENV` | Yes | `production` or `development` |
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `JWT_SECRET` | Yes | Access token secret |
| `JWT_REFRESH_SECRET` | Yes | Refresh token secret |
| `ALLOWED_ORIGINS` | Yes | Comma-separated frontend URLs (exact Vercel URL, no trailing slash) |
| `ALLOW_PUBLIC_REGISTER` | No | `true` to allow open registration in production |
| `INVITE_CODE` | No | If set (and public register off), registration requires this invite code |
| `REGISTER_DISABLED` | No | `true` to disable register even in development |
| `PUPPETEER_EXECUTABLE_PATH` | Optional | Path to Chrome/Chromium binary |
| `VERCEL` | Optional | If set, skips `app.listen()` (serverless export) |

> Note: Access token expiry is currently **hardcoded to `1h`** and refresh to **`7d`** in `authController` (not driven by `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` env vars even if present).

### Frontend

| Variable | Required | Description |
|---|---|---|
| `VITE_API_BASE_URL` | Yes | Backend API URL (e.g. `https://api.example.com/api`) |
| `VITE_APP_NAME` | No | Present in `.env`; not used in source |
| `VITE_APP_VERSION` | No | Present in `.env`; not used in source |

**Dev defaults:** Axios falls back to `http://localhost:5005/api` if `VITE_API_BASE_URL` is unset. Vite proxy maps `/api` → `http://localhost:8080`. Align these ports with your running backend.

---

## 4. Backend — Bootstrap & Security

### Bootstrap (`server.js` → `app.js`)

1. Load `.env`, connect MongoDB (`config/db.js`)
2. `express-async-errors` wraps async controllers
3. Helmet, CORS with credentials, cookie-parser, JSON body (10mb)
4. Morgan colored request logs
5. Global **10s** request timeout → `503`
6. Rate limit on `/api`: **300 req / 2 min**
7. Health: `GET /` → `{ project: 'TEAnest', status: 'running' }`
8. Global `errorHandler`

### Security measures

| Measure | Implementation |
|---|---|
| Helmet headers | `helmet()` with `crossOriginResourcePolicy: cross-origin` |
| Rate limiting | `express-rate-limit` — 300 / 2 min |
| CORS allowlist | Only `ALLOWED_ORIGINS`; `credentials: true` |
| Input validation | `express-validator` on mutation routes |
| Regex sanitization | Filter strings escaped before MongoDB `$regex` |
| JWT auth | Bearer access token + httpOnly refresh cookie |
| No stack in prod | `errorHandler` hides stack when `NODE_ENV=production` |

### Error response format

```json
{
  "success": false,
  "message": "Human-readable error",
  "errors": [{ "field": "grossQty", "message": "must be positive" }]
}
```

Mapped statuses: Validation/Cast `400`, duplicate key `409`, JWT errors `401`, else `500`.

---

## 5. Auth System

### Tokens

| Token | Delivery | Expiry | Payload |
|---|---|---|---|
| Access | JSON `data.accessToken` | ~1h | `{ id, role }` |
| Refresh | httpOnly cookie `refreshToken` | 7d | `{ id }` |

- Refresh hashes (SHA256) stored on `User.refreshTokens[]` (max **5** sessions)
- Refresh rotates on every `/auth/refresh`; replay of an old refresh clears all sessions
- Cookie: `httpOnly`, `sameSite: 'strict'`, `secure` in production

### Endpoints (`/api/auth` — public)

| Method | Path | Purpose |
|---|---|---|
| POST | `/register` | Create user + issue tokens |
| POST | `/login` | Phone + password |
| POST | `/refresh` | Rotate via refresh cookie |
| POST | `/logout` | Clear cookie + remove hash |
| POST | `/reset-password` | `{ phone, newPassword }` — clears all sessions |

### Middleware

- `protect` — requires `Authorization: Bearer <accessToken>`; loads `req.user`
- `requireRole(...roles)` — exported but **not used** on any route
- User roles: `Admin` | `Manager` (default `Manager`) — not enforced in routing

### Frontend auth flow

1. Login/register → store `accessToken` + `user` in `localStorage`
2. `ProtectedRoute` checks `localStorage.accessToken` only
3. Axios request interceptor attaches Bearer token
4. On `401` + `TOKEN_EXPIRED` → silent `POST /auth/refresh` with credentials, retry queue
5. Other 401 → soft logout → redirect `/login`

---

## 6. API Routes Reference

All routes below are under `/api`. Except `/auth/*`, all mounts use `protect`.

### Auth — `/auth`

| Method | Path | Controller |
|---|---|---|
| POST | `/register` | `registerUser` |
| POST | `/login` | `loginUser` |
| POST | `/refresh` | `refreshToken` |
| POST | `/logout` | `logoutUser` |
| POST | `/reset-password` | `resetPassword` |

### Merchant master — `/merchants`

| Method | Path | Notes |
|---|---|---|
| GET | `/search` | Autocomplete |
| GET | `/` | List |
| POST | `/` | Find-or-create (`merchantMasterValidator`) |
| GET | `/:id` | Detail |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |
| GET/POST | `/:merchantId/advances` | Standalone advances |
| DELETE | `/:merchantId/advances/:advanceId` | |
| GET/POST | `/:merchantId/payments` | Merchant-level (bulk) payments |
| DELETE | `/:merchantId/payments/:paymentId` | |

### Buyers — `/buyers`

| Method | Path | Notes |
|---|---|---|
| GET | `/search`, `/`, `/:id` | |
| POST | `/` | Find-or-create |
| PUT | `/:id` | |
| DELETE | `/:id` | |

### Tea batches — `/merchant` (TeaMerchant; unused by current UI)

| Method | Path |
|---|---|
| GET | `/stats`, `/`, `/:id` |
| POST | `/` |
| PUT | `/:id` |
| DELETE | `/:id` |

### Merchant transactions — `/merchant-transactions`

| Method | Path | Notes |
|---|---|---|
| GET | `/stats` | Aggregates |
| GET | `/` | Filtered list (see [Filter System](#8-filter-system)) |
| POST | `/` | Create |
| GET | `/:id` | Detail |
| PUT | `/:id` | Update |
| DELETE | `/:id` | Delete |
| POST | `/import` | CSV upload (`multer`) |
| POST | `/import-confirm` | Confirm import JSON |
| GET | `/:id/invoice` | PDF/HTML invoice |
| GET | `/invoice/by-merchant-date` | Multi-txn voucher |

**Nested payments** — `/merchant-transactions/:txnId/payments`

| Method | Path |
|---|---|
| GET | `/` |
| POST | `/` |
| DELETE | `/:payId` |

### Factory — `/factory`

| Method | Path | Notes |
|---|---|---|
| GET | `/stats`, `/`, `/:id` | |
| POST | `/` | |
| PUT | `/:id` | |
| DELETE | `/:id` | |
| POST | `/:id/payments` | Embedded payment |
| DELETE | `/:id/payments/:paymentId` | |
| GET | `/:id/invoice` | PDF/HTML |
| GET | `/invoice/by-buyer` | Buyer-scoped voucher |

**Factory list filters:** `search`, `name`, `phone`, `startDate`, `endDate` (AND logic).

### Labor — `/labor`

| Method | Path |
|---|---|
| GET | `/stats`, `/`, `/:id` |
| POST | `/` |
| PUT | `/:id` |
| PATCH | `/:id/pay` | Toggle Due ↔ Paid |
| DELETE | `/:id` |

### General payments — `/payments`

Expense ledger (Salary / Advance / Bonus / Supplier / Other) — full CRUD + `/stats`.

### Dashboard — `/dashboard`

| Method | Path |
|---|---|
| GET | `/` | KPIs, recent records, top due merchants/buyers |

### Users — `/users`

| Method | Path |
|---|---|
| GET | `/me` | Profile |
| PUT | `/me` | Update profile |
| PUT | `/change-password` | Change password |

> `routes/merchantAdvanceRoutes.js` exists but is **not mounted**; advances are nested under `/merchants/:id/advances`.

---

## 7. Data Models

All business models include `createdBy` → `User` for isolation.

| Model | Collection | Purpose |
|---|---|---|
| `User` | `users` | Auth; `phone` unique; roles Admin/Manager; refresh token hashes |
| `Merchant` | `merchants` | Supplier master (name, phone, address) |
| `MerchantTransaction` | `merchanttransactions` | Procurement txn; auto-calcs net qty, payable, balance |
| `MerchantPayment` | `merchantpayments` | Payment against a transaction |
| `MerchantAdvance` | `merchantadvances` | Standalone advance to merchant |
| `MerchantMasterPayment` | `merchantmasterpayments` | Merchant-level bulk payment |
| `TeaMerchant` | `teamerchants` | Harvest/batch records |
| `Buyer` | `buyers` | Factory buyer master |
| `Factory` | `factories` | Factory sales; embedded `payments[]`; virtuals for due |
| `Labor` | `labors` | Workforce; Due/Paid status |
| `Payment` | `payments` | General expense payments |

### MerchantTransaction calculation fields

Inputs: `grossQty`, `lessPercent`, `fineLeaf`, `ratePerKg`, `labourHeadCount`, `labourCharge`, `advancePayment`  
Derived: `lessQty`, `netQty`, `grossAmount`, `labourAmount`, `totalLaborCharges`, `netPayable`, `finalPayable`, `balance`

### Three payment layers (merchants)

1. **Transaction payments** — `MerchantPayment` (tied to one txn; updates `balance`)
2. **Merchant master payments** — `MerchantMasterPayment` (bulk / weekly)
3. **Advances** — `MerchantAdvance` (standalone cash advance)

---

## 8. Filter System

Active filters combine with **AND** via `$and`.

### Merchant transactions query params

| Param | Description |
|---|---|
| `search` | Partial match on `merchantName` **OR** `merchantPhone` (and related merchant IDs) |
| `phone` | Explicit phone filter |
| `merchantName` | Name-only filter |
| `teaType` | `Green Tea`, `CTC`, or `Other` |
| `startDate` / `endDate` | Inclusive date range on `transactionDate` |

### Factory query params

| Param | Description |
|---|---|
| `search` | Buyer name **OR** phone |
| `name` | `buyerName` only |
| `phone` | Buyer phone only |
| `startDate` / `endDate` | Date range on `date` |

### ReDoS-safe regex

```js
const safe = input.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
```

---

## 9. PDF Generation & Invoices

**Controller:** `controllers/invoiceController.js`  
**Engine:** `puppeteer-core` + `@sparticuz/chromium` (or local Chrome via `PUPPETEER_EXECUTABLE_PATH`)

### Endpoints

```
GET /api/merchant-transactions/:id/invoice?format=pdf|html
GET /api/merchant-transactions/invoice/by-merchant-date?merchantName=...&startDate=...&endDate=...
GET /api/factory/:id/invoice?format=pdf|html
GET /api/factory/invoice/by-buyer?buyerName=...
```

### Flow

```
generatePdf(html)
  1. Resolve Chromium:
     a. PUPPETEER_EXECUTABLE_PATH
     b. @sparticuz/chromium (serverless)
     c. Windows Chrome / Linux chromium-browser
  2. puppeteer.launch({ headless: 'new', no-sandbox args })
  3. page.setContent(html, { waitUntil: 'networkidle0' })
  4. page.pdf({ format: 'A4', printBackground: true })
  5. Return Buffer; browser.close() in finally
```

Multi-merchant vouchers aggregate transactions, transaction payments, advances, and master payments for the date range.

---

## 10. Invoice Template Guide

### Rupee symbol
Use `&#x20B9;` (`const RS` in invoiceController) — not UTF-8 `₹`.

### Header single-line

```css
thead th { white-space: nowrap; }
```

### Watermark

```css
.watermark-bg {
  position: fixed;   /* NOT absolute */
  z-index: 0;        /* NOT -10 */
  opacity: 0.07;
}
/* Content at z-index: 1 */
```

### Alignment
- Numbers: `text-align: right` (`.num`)
- Text: `text-align: left` (`.left`)
- Prefer `<colgroup>` for column widths

Assets: `assets/logo.png`, `assets/fonts/NotoSans-Regular.ttf` (base64-embedded).

---

## 11. Frontend — App Structure

| Item | Detail |
|---|---|
| Framework | React 18.3 + Vite 5.4 |
| Routing | React Router DOM 7 (`BrowserRouter`) |
| Styling | Tailwind 3.4 + custom tea/green theme (`style.css`) |
| HTTP | Axios via `src/api/client.js` |
| Toasts | `react-hot-toast` |
| State | **No Context/Redux** — page-local `useState` / `useEffect`; auth in `localStorage` |

### Routes (`App.jsx`)

| Path | Access | Page |
|---|---|---|
| `/login` | Public | `LoginPage` |
| `/register` | Public | `RegisterPage` |
| `/forgot-password` | Public | `ForgotPasswordPage` |
| `/` | Protected | Redirect → `/dashboard` |
| `/dashboard` | Protected | `DashboardPage` |
| `/merchant` | Protected | `MerchantPage` |
| `/labor` | Protected | `LaborPage` |
| `/factory` | Protected | `FactoryPage` |
| `/payments` | Protected | `PaymentsPage` |
| `*` | — | Redirect → `/login` |

Protected shell: `Layout` (header + collapsible sidebar + `<Outlet />`).

---

## 12. Frontend — Pages & Features

### Dashboard (`/dashboard`)
- Single `GET /dashboard`
- KPI cards: procurement, factory revenue, merchant due, factory due
- Due alerts (top merchants/buyers)
- Recent procurement & factory tables

### Merchant (`/merchant`)
- CRUD procurement transactions (`merchantTxnAPI`)
- Live client-side `compute()` for payable preview
- Filters: search, tea type, date presets (`MerchantTableFilters`)
- `SearchableSelect` + `merchantMasterAPI` (find-or-create)
- `MerchantProfileDrawer`: history, advances, master payments, invoices
- CSV import via `CsvImportModal`

### Labor (`/labor`)
- CRUD workers; role / payment-status filters
- Toggle Due ↔ Paid via `PATCH /labor/:id/pay`
- Stats: due/paid counts and amounts

### Factory (`/factory`)
- CRUD sales; buyer autocomplete (`buyerAPI`)
- Embedded payment modal; `BuyerHistoryDrawer` + invoices
- Date filters and CSV import (page-local)

### Payments (`/payments`)
- General expense ledger (Salary, Advance, Bonus, Supplier, Other)
- Search + type filter + stats

### Settings (modal in Layout)
- Profile (`GET/PUT /users/me`) and change password — no admin user-management page

---

## 13. Frontend — Components

| Component | Purpose |
|---|---|
| `Layout` / `Sidebar` / `Logo` | App shell & navigation |
| `SettingsModal` | Profile + password |
| `ConfirmationModal` | Delete / logout confirm |
| `SearchableSelect` | Debounced autocomplete + find-or-create |
| `CsvImportModal` | Merchant CSV import |
| `MerchantTableFilters` | Search, date preset, tea type, Clear All |
| `MerchantTransactionTable` | List with edit/delete |
| `MerchantTransactionForm` | Create/edit + live calculations |
| `MerchantStatCards` | Merchant KPIs |
| `MerchantProfileDrawer` | Merchant history + invoices |
| `CustomDateRangeModal` | From/to date picker |
| `BuyerHistoryDrawer` | Buyer sales history + invoice |

**Legacy / unused (do not rely on):** `Header.jsx`, `TransactionDetailModal.jsx`, `PlaceholderPages.jsx`, `merchantApi.js` (TeaMerchant `/merchant` API).

---

## 14. Frontend — API Client

| Module | Backend base | Used by |
|---|---|---|
| `authApi.js` | `/auth`, `/users` | Login, register, settings |
| `dashboardApi.js` | `/dashboard` | Dashboard |
| `merchantMasterApi.js` | `/merchants` | Merchant page / drawer |
| `merchantTransactionApi.js` | `/merchant-transactions` | Merchant page |
| `buyerApi.js` | `/buyers` | Factory page |
| `factoryApi.js` | `/factory` | Factory page |
| `laborApi.js` | `/labor` | Labor page |
| `paymentsApi.js` | `/payments` | Payments page |
| `merchantApi.js` | `/merchant` | **Unused in UI** |

Client defaults: 15s timeout, `withCredentials: true`, Bearer from `localStorage`, silent refresh on `TOKEN_EXPIRED`.

---

## 15. MongoDB Index Strategy

### MerchantTransaction
```
{ createdBy: 1, merchantName: 1, transactionDate: -1 }
{ createdBy: 1, merchantPhone: 1, transactionDate: -1 }
{ createdBy: 1, merchant: 1, transactionDate: -1 }
{ createdBy: 1, transactionDate: -1 }
{ createdBy: 1, teaType: 1, transactionDate: -1 }
{ createdBy: 1, transactionId: 1 }   // unique per user
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
```

### MerchantMasterPayment
```
{ createdBy: 1, paymentId: 1 }       // unique per user
{ merchant: 1, createdBy: 1, paymentDate: -1 }
```

### MerchantPayment / MerchantAdvance
```
{ createdBy: 1, paymentId: 1 }       // transaction payments, unique per user
{ createdBy: 1, advanceId: 1 }       // advances, unique per user
{ createdBy: 1, transaction: 1, paymentDate: -1 }
{ merchant: 1, createdBy: 1, advanceDate: -1 }
```

---

## 16. Migration Scripts

| Script | Purpose |
|---|---|
| `scripts/migrate-createdBy.js` | Assign `createdBy` on legacy docs; drop old global phone unique indexes. Set `OWNER_USER_ID`. |
| `scripts/migrate-merchants.js` | Create `Merchant` docs from txn `merchantName`; link refs; placeholder phones `LEGACY-001` |
| `scripts/migrate-buyers.js` | Create `Buyer` docs from factory `buyerName`; link refs; placeholder phones `LEGACY-B001` |
| `scripts/cleanup-placeholders-orphans.js` | Find/fix placeholder phones and delete merchant advance/master-payment orphans |
| `scripts/repair-db-relationships.js` | Drop old global ID indexes, create per-user indexes, relink merchant/buyer refs, recalc balances |

Run against the same `MONGO_URI` as the app. One-time / ops use only.

---

## 17. Deployment Guide

### Railway (backend)

```bash
PORT=8080
NODE_ENV=production
MONGO_URI=mongodb+srv://...
JWT_SECRET=<strong-secret>
JWT_REFRESH_SECRET=<strong-secret>
ALLOWED_ORIGINS=https://your-frontend.vercel.app
# Register: omit both for disabled; or set INVITE_CODE=secret; or ALLOW_PUBLIC_REGISTER=true
INVITE_CODE=your-private-invite
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

### Post-deploy: verify refresh cookie (Vercel → Railway)

1. Open the Vercel app, log in once.
2. DevTools → Application → Cookies → confirm `refreshToken` on the **API** host (Railway), `Secure`, `HttpOnly`, `SameSite=None`.
3. Call `GET {API}/api/auth/cookie-check` from the browser console with credentials, or wait for access token expiry and confirm silent refresh (no forced logout).
4. If cookie missing: check `ALLOWED_ORIGINS` matches the exact Vercel origin (https, no trailing slash) and frontend uses `withCredentials: true`.

### Cleanup placeholders / orphans

```bash
cd DooarsGreenbackend
node scripts/cleanup-placeholders-orphans.js          # dry-run
node scripts/cleanup-placeholders-orphans.js --apply  # write
node scripts/repair-db-relationships.js               # dry-run relationship/index repair
node scripts/repair-db-relationships.js --apply        # write relationship/index repair
```

### Docker (backend)

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

1. Connect `Dooars greenfrontend`
2. Set `VITE_API_BASE_URL=https://your-backend.example.com/api`
3. Build: `npm run build` · Output: `dist`
4. `vercel.json` rewrites all paths to `/index.html` for SPA routing

Ensure backend `ALLOWED_ORIGINS` includes the Vercel domain (CORS + cookies).

---

## 18. Known Issues & Fixes

| Issue | Root Cause | Fix Applied |
|---|---|---|
| ₹ shows as `?` in PDF | UTF-8 literal in HTML | Use `&#x20B9;` HTML entity |
| Table headers wrap to 2 lines | No `white-space: nowrap` | Added to `thead th` + colgroup widths |
| Watermark blocks row backgrounds | `z-index: -10` on watermark | `fixed` + `z-index: 0`; content at `z-index: 1` |
| Puppeteer `require()` crash | puppeteer-core v21+ is ESM | `await import('puppeteer-core')` |
| Chrome path Windows-only | No multi-platform detection | Env var + platform-aware resolution |
| Phone search not filtering | Only name searched | Denormalized `merchantPhone` + `$or` |
| AND filters broken | Params overwrote each other | `andConditions[]` → `{ $and: [...] }` |
| Dev port mismatch | Proxy `:8080` vs axios default `:5005` | Set `VITE_API_BASE_URL` to the live backend `/api` URL |
| Global transaction/payment ID uniqueness | Unique indexes were not scoped by user | Per-user unique indexes + repair script |
| Missing merchant/buyer refs | Some writes only stored denormalized names | Controllers now require/link master records; repair script relinks old records |
| Placeholder phones | UI created `NO-PHONE-*` merchants | Placeholder phones blocked; cleanup script marks old ones |
| Concurrent payments | Balance could be stale during simultaneous writes | Payment add/remove uses MongoDB transactions and scoped recalculation |

### Current gaps (by design / incomplete)

| Gap | Notes |
|---|---|
| Roles unused | `Admin` / `Manager` exist; `requireRole` never applied |
| `/api/merchant` unused in UI | TeaMerchant batches have API but no page |
| No users admin UI | Only self profile/password in Settings |
| Buyers have no dedicated page | Managed only inside Factory flow |
| Orphan route file | `merchantAdvanceRoutes.js` not mounted (advances live under `/merchants`) |
| Slow page load / many API calls | Double-fetch loops, no search debounce | Stable callbacks, debounced search, stats decoupled |
| Table text/buttons split on small screen | No `min-width` / `nowrap` on Labor etc. | `min-w-*` tables + horizontal scroll |

---

## 19. Production Deploy Checklist

Use this **exact order** when pushing `main` and deploying. Skipping DB repair before deploy can cause **500 errors** on create (duplicate index / unique key).

### Phase 0 — Before you push

- [ ] **Backup MongoDB Atlas** (snapshot or export) — mandatory before index scripts
- [ ] Confirm `.env` secrets are **not** committed (only set in Railway / Vercel dashboard)
- [ ] Generate strong `JWT_SECRET` and `JWT_REFRESH_SECRET` (32+ random chars each)
- [ ] Note your exact URLs:
  - Frontend: `https://your-app.vercel.app` (no trailing `/`)
  - Backend: `https://your-api.railway.app` (API calls use `.../api`)

### Phase 1 — Database (run once against production `MONGO_URI`)

From your machine or Railway one-off shell (with production `MONGO_URI` in `.env`):

```bash
cd DooarsGreenbackend

# 1) Dry-run first — read output, no writes
node scripts/cleanup-placeholders-orphans.js
node scripts/repair-db-relationships.js

# 2) Apply only after reviewing dry-run
node scripts/cleanup-placeholders-orphans.js --apply
node scripts/repair-db-relationships.js --apply
```

What this fixes on live data:
- Drops old global `transactionId_1` / `paymentId_1` indexes (would block creates for 2nd user)
- Creates per-user unique indexes
- Relinks orphan merchant/buyer refs where possible
- Recalculates transaction `balance` from payments

### Phase 2 — Deploy backend (Railway)

**Required environment variables:**

```bash
PORT=8080
NODE_ENV=production
MONGO_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/<db>?retryWrites=true&w=majority
JWT_SECRET=<generate-strong-random-64-chars>
JWT_REFRESH_SECRET=<generate-different-strong-random-64-chars>
ALLOWED_ORIGINS=https://your-app.vercel.app
INVITE_CODE=<your-private-invite-code>
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

**Do NOT set** `ALLOW_PUBLIC_REGISTER=true` in production unless you want anyone to sign up.

**Register modes:**

| Env | Who can register |
|---|---|
| *(none of register vars)* | Nobody (login only) |
| `INVITE_CODE=secret` | Only with invite code in register form |
| `ALLOW_PUBLIC_REGISTER=true` | Anyone (not recommended) |

**Verify backend after deploy:**

```bash
# Health
curl https://your-api.railway.app/

# Auth config (public)
curl https://your-api.railway.app/api/auth/config
# Expect: registerMode, cookieSameSite: "none", cookieSecure: true
```

### Phase 3 — Deploy frontend (Vercel)

**Required environment variable (Production):**

```bash
VITE_API_BASE_URL=https://your-api.railway.app/api
```

Important: must end with `/api` — not just the domain root.

**Vercel settings:**
- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Root directory: `Dooars greenfrontend` (if monorepo)

Redeploy frontend **after** backend env is live (Vite bakes `VITE_*` at build time).

### Phase 4 — Post-deploy smoke test (15 min)

See [Section 20](#20-production-risks--api-smoke-tests) for full API list.

Quick manual checks:
1. Login with existing user (phone + password)
2. Open each section: Dashboard, Merchant, Labor, Factory, Payments
3. Merchant → View Details → add payment → table balance updates
4. Labor → filter “Today” → shows today’s records (IST)
5. Wait 1h or shorten token in dev — confirm session does not kick you out (refresh cookie)
6. Download one PDF invoice

### Phase 5 — Rollback plan

| If this breaks | Rollback |
|---|---|
| Frontend UI only | Redeploy previous Vercel deployment (instant) |
| Backend API | Redeploy previous Railway deployment |
| DB indexes corrupted | Restore Atlas snapshot; re-run repair dry-run |

---

## 20. Production Risks & API Smoke Tests

### Critical risks if misconfigured

| Risk | Symptom | Fix |
|---|---|---|
| Missing `JWT_SECRET` | Weak auth; tokens guessable | Set strong secrets; **never rely on `access_fallback_secret`** |
| Wrong `ALLOWED_ORIGINS` | CORS error, login works but API fails | Exact Vercel URL, `https`, no trailing slash |
| Missing `VITE_API_BASE_URL` | Frontend calls `localhost:5005` | Set on Vercel, rebuild |
| Skipped `repair-db-relationships.js` | `E11000 duplicate key` on txn/payment create | Run repair script `--apply` |
| `ALLOW_PUBLIC_REGISTER=true` | Random users can register | Remove; use `INVITE_CODE` only |
| Password reset (no OTP) | Anyone with phone can reset account | Disable route or add OTP later |
| PDF timeout (10s) | Invoice download 503 on cold start | Retry; or increase timeout in `app.js` for invoice routes only |
| Merchant without linked phone | Cannot add advance/payment in drawer | Link merchant with real phone via Merchant form |
| MongoDB not replica set | Payment add fails with transaction error | Use **MongoDB Atlas** (replica set by default) |

### Security — acceptable for now vs must-fix later

| Item | Production status |
|---|---|
| `createdBy` data isolation | OK — scoped on all business APIs |
| JWT + httpOnly refresh cookie | OK — if env secrets set |
| Register disabled / invite | OK — if `INVITE_CODE` set |
| Password reset with phone only | **Risk** — add OTP before public launch |
| Roles (`Admin`/`Manager`) | Not enforced — low risk for single-org use |
| Rate limit 300/2min | OK for small team |

### API smoke test matrix

All protected routes need header: `Authorization: Bearer <accessToken>`

| Module | Method | Endpoint | Test |
|---|---|---|---|
| Health | GET | `/` | `{ success: true, status: 'running' }` |
| Auth | GET | `/api/auth/config` | `registerMode`, cookie flags |
| Auth | POST | `/api/auth/login` | Returns `accessToken` + sets cookie |
| Auth | GET | `/api/auth/cookie-check` | `hasRefreshCookie: true` after login |
| Auth | POST | `/api/auth/refresh` | New `accessToken` (cookie) |
| Users | GET | `/api/users/me` | Profile JSON |
| Dashboard | GET | `/api/dashboard` | KPIs + recent rows |
| Merchants master | GET | `/api/merchants/search?q=` | Array |
| Merchants master | POST | `/api/merchants` | Find-or-create |
| Merchant txn | GET | `/api/merchant-transactions` | List + filters |
| Merchant txn | GET | `/api/merchant-transactions/stats` | Summary |
| Merchant txn | POST | `/api/merchant-transactions` | Create (needs merchant phone) |
| Merchant txn pay | POST | `/api/merchant-transactions/:id/payments` | Add payment |
| Merchant advances | GET | `/api/merchants/:id/advances` | List |
| Factory | GET | `/api/factory` | List |
| Factory | POST | `/api/factory` | Create (needs buyer link) |
| Buyers | GET | `/api/buyers/search?q=` | Array |
| Labor | GET | `/api/labor` | List |
| Labor | PATCH | `/api/labor/:id/pay` | Toggle Due/Paid |
| Payments | GET | `/api/payments` | Expense ledger |
| Invoice | GET | `/api/merchant-transactions/:id/invoice` | PDF blob |
| Invoice | GET | `/api/factory/:id/invoice` | PDF blob |

### What changed in this release (safe to deploy)

| Area | Change | Breaks existing data? |
|---|---|---|
| Dates (IST) | Today filter + datetime save | No — improves accuracy |
| Auth cookies | `SameSite=None` for Vercel↔Railway | No — fixes logout after 1h |
| Register | Disabled by default in prod | No — existing users unaffected |
| API performance | Debounce search, fewer duplicate calls | No |
| Table UI | Horizontal scroll, no wrap | No |
| DB indexes | Per-user unique IDs | **Run repair script first** |
| Placeholder phones | Blocked on new creates | Old `NO-PHONE-*` need cleanup script |
| Payment transactions | MongoDB session for atomic balance | Requires Atlas replica set |

### Expected behavior after deploy

- Existing users log in normally
- All sections load with **fewer** network requests than before
- “Today” date filter shows correct IST day
- Tables scroll horizontally on mobile instead of breaking layout
- New merchants/buyers require **real phone numbers**
- Register page hidden unless `INVITE_CODE` or public register enabled

### If something fails in production

1. Browser DevTools → **Network** tab → note failing URL + status code
2. Railway logs → search for `[merchantTransactionController` or stack trace
3. Common fixes:
   - `401` → cookie/CORS → check `ALLOWED_ORIGINS`, login again
   - `403` on register → expected; use invite or create user in DB
   - `409` duplicate key → run `repair-db-relationships.js --apply`
   - `400` placeholder phone → enter real phone on merchant/buyer
   - `503` timeout → PDF or slow query; retry

---
