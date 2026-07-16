# DOOARS GREEN / TEAnest Backend Documentation

> Code-derived production reference for this repository
> Reviewed: 16 July 2026
> Application version: `1.0.0`

## 1. Scope

This repository contains the Node.js backend for the DOOARS GREEN / TEAnest tea-estate management application. It provides authentication, user-isolated business data, procurement and factory-sale records, payments, labor records, dashboard reporting, CSV import, and invoice generation.

The frontend is not part of this repository. Any React/Vite component names, frontend deployment details, or `VITE_*` variables must be documented in the frontend repository.

### Technology

- Node.js 20 in the supplied Docker image
- Express 4
- MongoDB with Mongoose 7
- JWT access and refresh tokens
- Puppeteer Core with Chromium for PDF invoices
- `express-validator` for request validation
- Multer and `csv-parser` for CSV imports

There are currently no automated tests, lint command, CI workflow, OpenAPI specification, seed scripts, or committed environment template.

## 2. Architecture

```text
Frontend / API client
   │
   │ HTTPS
   │ Authorization: Bearer <access-token>
   │ refreshToken httpOnly cookie for auth refresh/logout
   ▼
server.js
   ├── connectDB() ────────────────────────────────── MongoDB
   └── app.js
       ├── global middleware
       ├── /api rate limiter
       └── routes/index.js
           └── routes/* → controllers/* → models/*
                                      │
                                      └── Puppeteer + Chromium → PDF
```

The application is a monolithic REST API with route, controller, and Mongoose model layers.

### Request lifecycle

`app.js` applies middleware in this order:

1. Helmet security headers and one trusted reverse proxy
2. Credentialed CORS with an origin allowlist
3. JSON and URL-encoded parsing, each limited to 10 MB
4. Cookie parsing
5. Morgan request logging
6. A 10-second response timeout
7. A rate limiter on `/api`: 300 requests per two minutes
8. API routes
9. Root health response, 404 handler, then global error handler

All API groups except `/api/auth` require a valid access token. Controllers generally isolate records using `createdBy: req.user._id`.

## 3. Repository map

```text
app.js                 Express application and global middleware
server.js              Database connection and HTTP process entry point
config/db.js            MongoDB connection
routes/                 Endpoint definitions
controllers/            Request and business logic
models/                 Mongoose schemas, indexes, and calculation hooks
validators/             express-validator rules
middleware/auth.js      Bearer-token authentication and role guard
middleware/errorHandler.js
scripts/                One-time legacy-data migrations
Dockerfile              Node 20 + system Chromium image
nixpacks.toml           Railway/Nixpacks build and Chromium setup
```

`routes/merchantAdvanceRoutes.js` is not mounted. Merchant advance routes are instead declared in `merchantMasterRoutes.js`.

## 4. Runtime and configuration

### Environment variables

| Variable | Production requirement | Runtime behavior |
|---|---:|---|
| `MONGO_URI` | Required | MongoDB connection string. Startup exits if connection fails. |
| `JWT_SECRET` | Required | Signs/verifies one-hour access tokens. Code has an insecure development fallback. |
| `JWT_REFRESH_SECRET` | Required | Signs seven-day refresh tokens. Code has an insecure development fallback. |
| `NODE_ENV` | Required | Set to `production` for secure cookies and hidden stack traces. |
| `ALLOWED_ORIGINS` | Required for browser clients | Comma-separated exact origins. Defaults to `http://localhost:5173`. |
| `PORT` | Platform-dependent | HTTP port; defaults to `5000`. |
| `PUPPETEER_EXECUTABLE_PATH` | Recommended outside serverless | Explicit Chromium executable path. Docker/Nixpacks use `/usr/bin/chromium`. |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | Build-time optional | Docker/Nixpacks set it to `true`. |
| `VERCEL` | Vercel only | Prevents `app.listen`; `server.js` still exports the Express app. |

`JWT_ACCESS_EXPIRES_IN` and `JWT_REFRESH_EXPIRES_IN` are not implemented. Token lifetimes are hardcoded to one hour and seven days in `controllers/authController.js`.

Never deploy with missing JWT secrets: the built-in fallback values are public source code and provide no meaningful protection.

### Local development

Create an untracked `.env`:

```dotenv
MONGO_URI=mongodb+srv://...
JWT_SECRET=<long-random-secret>
JWT_REFRESH_SECRET=<different-long-random-secret>
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:5173
PORT=5000
PUPPETEER_EXECUTABLE_PATH=/path/to/chromium
```

Then:

```bash
npm install
npm start
```

`npm start` runs `nodemon server.js`. For production, run `node server.js`, as the Docker and Nixpacks definitions do.

### Health check

`GET /` does not require authentication:

```json
{
  "success": true,
  "project": "TEAnest",
  "status": "running"
}
```

This confirms the Express process can answer; it does not verify database or Chromium readiness.

## 5. Authentication and data isolation

### Session flow

1. `POST /api/auth/register` or `/login` returns an access token in JSON.
2. The server also sets `refreshToken` as an HTTP-only cookie.
3. Protected calls send `Authorization: Bearer <access-token>`.
4. `POST /api/auth/refresh` rotates the refresh token and returns a new access token.
5. `POST /api/auth/logout` removes the current refresh-token hash and clears the cookie.

Access tokens last one hour. Refresh tokens last seven days. Refresh-token SHA-256 hashes are stored on the user, with at most five active sessions. Reuse of an already-rotated token invalidates all stored sessions.

The refresh cookie uses:

- `httpOnly: true`
- `sameSite: strict`
- `secure: true` only when `NODE_ENV=production`
- `path: /`

Cross-site frontend/backend deployments must verify that `SameSite=Strict` fits the actual domain topology. Browser clients must enable credentials when calling refresh or logout.

Authentication failures may include:

| Code | Meaning |
|---|---|
| `NO_TOKEN` | Bearer token missing |
| `TOKEN_EXPIRED` | Access token expired |
| `TOKEN_INVALID` | Token malformed or signature invalid |
| `USER_NOT_FOUND` | Token user no longer exists |

### Authorization model

Users have `Admin` or `Manager` roles. A `requireRole()` guard exists, but no route currently uses it; both roles therefore have the same API permissions.

Most domain controllers scope reads and writes by the logged-in user's `createdBy` value. Merchant and buyer phone uniqueness is also per user. This is application-level isolation rather than a separate database per tenant.

## 6. API conventions

- Base path: `/api`
- Protected requests: `Authorization: Bearer <token>`
- JSON success responses generally use `{ "success": true, "data": ... }`
- Paginated lists generally add `pagination: { total, page, pages }`
- Validation and error response shapes are not perfectly uniform across controllers
- Invalid routes return HTTP 404
- The global timeout returns HTTP 503 after 10 seconds
- Rate limiting returns HTTP 429
- Partial CSV imports may return HTTP 207

Typical global error:

```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    {
      "field": "grossQty",
      "message": "Gross quantity cannot be negative",
      "value": -1
    }
  ]
}
```

The global handler maps Mongoose validation and cast errors to 400, duplicate keys to 409, and JWT errors to 401. Some controllers catch errors directly, so not every failure passes through this normalization.

## 7. Endpoint reference

All routes below use the `/api` prefix. Only authentication routes are public.

### Authentication and user

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Register and create a session |
| POST | `/auth/login` | Authenticate and create a session |
| POST | `/auth/refresh` | Rotate refresh cookie and issue access token |
| POST | `/auth/logout` | Revoke current refresh session |
| POST | `/auth/reset-password` | Reset by phone and invalidate sessions |
| GET | `/users/me` | Current profile |
| PUT | `/users/me` | Update name/phone |
| PUT | `/users/change-password` | Change password |

### Merchant master: `/merchants`

This module represents tea-leaf suppliers.

| Method | Path | Purpose |
|---|---|---|
| GET | `/merchants/search?q=` | Autocomplete |
| GET | `/merchants` | List; `search`, `sort`, `page`, `limit` |
| POST | `/merchants` | Create or resolve merchant according to controller rules |
| GET | `/merchants/:id` | Detail and transaction summary |
| PUT | `/merchants/:id` | Update; name changes propagate to linked transactions |
| DELETE | `/merchants/:id` | Delete only when no linked transactions exist |
| GET/POST | `/merchants/:merchantId/advances` | List/create standalone advances |
| DELETE | `/merchants/:merchantId/advances/:advanceId` | Delete an advance |
| GET/POST | `/merchants/:merchantId/payments` | List/create merchant-level payments |
| DELETE | `/merchants/:merchantId/payments/:paymentId` | Delete merchant-level payment |

### Buyers: `/buyers`

| Method | Path | Purpose |
|---|---|---|
| GET | `/buyers/search?q=` | Autocomplete |
| GET | `/buyers` | List; `search`, `sort`, `page`, `limit` |
| POST | `/buyers` | Find or create by phone |
| GET/PUT/DELETE | `/buyers/:id` | Detail, update, delete |

Buyer deletion is blocked while linked factory records exist.

### Procurement transactions: `/merchant-transactions`

| Method | Path | Purpose |
|---|---|---|
| GET | `/merchant-transactions/stats` | Procurement summary |
| GET | `/merchant-transactions` | Filtered paginated list |
| POST | `/merchant-transactions` | Create |
| GET/PUT/DELETE | `/merchant-transactions/:id` | Detail, update, delete |
| POST | `/merchant-transactions/import?preview=true` | Preview uploaded CSV (`file` field) |
| POST | `/merchant-transactions/import` | Parse and import uploaded CSV |
| POST | `/merchant-transactions/import-confirm` | Import `{ "items": [...] }` |
| GET | `/merchant-transactions/:id/invoice?format=pdf\|html` | Single voucher |
| GET | `/merchant-transactions/invoice/by-merchant-date` | Merchant statement |

List filters combine with AND logic:

| Query | Behavior |
|---|---|
| `search` | Partial merchant name or phone |
| `merchantName` | Partial merchant name |
| `phone` | Partial phone through merchant and denormalized transaction phone |
| `teaType` | Exact `Green Tea`, `CTC`, or `Other` |
| `startDate`, `endDate` | Inclusive transaction-date range |
| `sort` | Mongoose sort expression; default `-transactionDate` |
| `page`, `limit` | Default `1`, `20` |

The multi-transaction invoice accepts `merchantName`, either `date` or `startDate`/`endDate`, and `format`.

Deleting a transaction also deletes its linked transaction payments.

### Transaction payments

| Method | Path | Purpose |
|---|---|---|
| GET | `/merchant-transactions/:txnId/payments` | Payments and balance summary |
| POST | `/merchant-transactions/:txnId/payments` | Add payment |
| DELETE | `/merchant-transactions/:txnId/payments/:payId` | Remove payment |

Payment creation rejects an amount larger than the remaining transaction balance.

### Factory sales: `/factory`

| Method | Path | Purpose |
|---|---|---|
| GET | `/factory/stats` | Factory totals |
| GET | `/factory` | Filtered paginated list |
| POST | `/factory` | Create sale |
| GET/PUT/DELETE | `/factory/:id` | Detail, update, delete |
| POST | `/factory/:id/payments` | Add embedded payment |
| DELETE | `/factory/:id/payments/:paymentId` | Remove embedded payment |
| GET | `/factory/:id/invoice?format=pdf\|html` | Single invoice |
| GET | `/factory/invoice/by-buyer?buyerName=...&format=pdf\|html` | Buyer statement |

List filters `search`, `name`, `phone`, `startDate`, and `endDate` combine with AND logic. Pagination defaults to page 1 and limit 50; sort defaults to `-date`.

### Tea inventory batches: `/merchant`

This singular route uses the `TeaMerchant` model and is distinct from supplier master `/merchants`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/merchant/stats` | Batch statistics |
| GET | `/merchant` | List; `teaType`, `search`, `sort`, `page`, `limit` |
| POST | `/merchant` | Create batch |
| GET/PUT/DELETE | `/merchant/:id` | Detail, update, delete |

### Labor: `/labor`

| Method | Path | Purpose |
|---|---|---|
| GET | `/labor/stats` | Labor totals by payment state and role |
| GET | `/labor` | List; `role`, `paymentStatus`, `search`, `sort`, `page`, `limit` |
| POST | `/labor` | Create |
| GET/PUT/DELETE | `/labor/:id` | Detail, update, delete |
| PATCH | `/labor/:id/pay` | Toggle `Due` and `Paid` |

### General payments: `/payments`

This is a generic payee ledger, separate from merchant transaction, merchant master, and factory payments.

| Method | Path | Purpose |
|---|---|---|
| GET | `/payments/stats` | Payment totals |
| GET | `/payments` | List; `paymentType`, `status`, `search`, `sort`, `page`, `limit` |
| POST | `/payments` | Create |
| GET/PUT/DELETE | `/payments/:id` | Detail, update, delete |

### Dashboard

`GET /dashboard` returns a user-scoped payload containing:

- top-level KPIs
- procurement and factory summaries
- eight recent merchant transactions
- eight recent factory records
- top five merchants with due balances
- top five buyers with due balances

## 8. Data model and calculations

| Model | Purpose |
|---|---|
| `User` | Login identity, role, hashed refresh sessions |
| `Merchant` | Supplier master |
| `MerchantTransaction` | Tea procurement transaction |
| `MerchantPayment` | Payment against one procurement transaction |
| `MerchantAdvance` | Standalone supplier advance |
| `MerchantMasterPayment` | Supplier-level payment |
| `Buyer` | Factory buyer master |
| `Factory` | Tea sale with embedded payments |
| `TeaMerchant` | Tea inventory/batch record |
| `Labor` | Labor work and payment state |
| `Payment` | General payment ledger |

### Procurement calculation

Calculated values are rounded to two decimal places and stored:

```text
lessQty      = grossQty × lessPercent / 100
netQty       = grossQty - lessQty
grossAmount  = netQty × ratePerKg
labourAmount = labourHeadCount × labourCharge
netPayable   = grossAmount - labourAmount
finalPayable = netPayable - advancePayment
balance      = finalPayable - linked MerchantPayment total
```

### Factory calculation

Factory values are Mongoose virtuals:

```text
lessQuantity = totalQuantity × lessPercentage / 100
netQuantity  = totalQuantity - lessQuantity
totalAmount  = netQuantity × rate
totalPaid    = sum(payments.amount)
due          = totalAmount - advance - totalPaid
```

Because these are virtuals, aggregation controllers reproduce the formulas when calculating statistics.

### Index strategy

Frequently queried business indexes begin with `createdBy`. Merchant and buyer use compound unique phone/owner indexes. Transaction IDs, batch IDs, and several payment IDs are globally unique rather than unique per owner.

Do not remove or rebuild production indexes without inspecting actual MongoDB index state and taking a backup.

## 9. CSV import

Merchant transaction CSV upload uses in-memory Multer storage and expects multipart field `file`.

Supported flow:

1. Upload to `/merchant-transactions/import?preview=true`.
2. Review returned valid rows and row-level errors.
3. Send accepted rows to `/merchant-transactions/import-confirm`.

Important limits:

- No Multer upload-size limit is configured.
- No MIME or file-extension allowlist is configured.
- Parsing and writes happen during the HTTP request.
- The global response timeout is 10 seconds.
- Direct and confirmed imports currently reference missing `utils/genTxnId`; imports without a supplied `transactionId` can fail at runtime.

## 10. Invoice and PDF generation

The invoice controller supports HTML for inspection and PDF through `puppeteer-core`.

Chromium resolution includes an explicit `PUPPETEER_EXECUTABLE_PATH`, system browser locations, and `@sparticuz/chromium` for serverless environments. Docker and Nixpacks install system Chromium at `/usr/bin/chromium`.

The controller expects:

- `assets/logo.png`
- `assets/fonts/NotoSans-Regular.ttf`

Neither asset is currently tracked in this repository. Generation has fallbacks, but branding and rupee-glyph rendering may degrade.

PDF rendering runs inline. Puppeteer allows operations longer than the application's 10-second response timeout, so complex invoices can produce a 503 even while browser work continues.

## 11. Deployment

### Docker

```bash
docker build -t teanest-backend .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e NODE_ENV=production \
  -e MONGO_URI='mongodb+srv://...' \
  -e JWT_SECRET='...' \
  -e JWT_REFRESH_SECRET='...' \
  -e ALLOWED_ORIGINS='https://app.example.com' \
  teanest-backend
```

The image exposes 8080, while application code defaults to 5000. Set `PORT=8080` explicitly.

### Railway / Nixpacks

`nixpacks.toml` installs Chromium and starts `node server.js`. Configure all production variables in the platform. Use the provider-supplied `PORT` when present.

### Vercel/serverless

The application exports Express and skips listening when `VERCEL` is set. However, no Vercel routing configuration is tracked here, and MongoDB connection behavior, package size, Chromium startup time, and the 10-second application timeout must be validated before treating this as a supported production target.

### Production checklist

- Back up MongoDB and verify restore procedures.
- Set strong, distinct JWT secrets; never rely on source fallbacks.
- Set `NODE_ENV=production`.
- Set exact HTTPS frontend origins in `ALLOWED_ORIGINS`.
- Verify refresh cookies in the real frontend/backend domain topology.
- Verify the effective listening port.
- Exercise HTML and PDF invoice endpoints.
- Verify required invoice assets and Chromium path.
- Confirm legacy records have correct `createdBy` ownership.
- Inspect MongoDB indexes after migrations.
- Monitor 401, 429, 503, and 5xx rates.

## 12. Migrations

Scripts under `scripts/` are manual, one-time tools:

| Script | Purpose |
|---|---|
| `migrate-merchants.js` | Create/link merchant masters from legacy transaction names |
| `migrate-buyers.js` | Create/link buyer masters from legacy factory names |
| `migrate-createdBy.js` | Assign ownership and replace old global phone indexes |

These scripts mutate production data and have no dry-run or rollback mode. Before running:

1. Take and verify a database backup.
2. Read the entire script.
3. Confirm `MONGO_URI` points to the intended database.
4. For `migrate-createdBy.js`, replace and verify its hardcoded owner user ID.
5. Run in a staging clone first.
6. Validate counts, ownership, references, and indexes afterward.

## 13. Observability and troubleshooting

Available:

- Morgan HTTP logs
- console startup/database/PDF messages
- root process health response
- development-only server error logging

Not available:

- structured logs or request IDs
- metrics, tracing, or APM
- error reporting service
- database-aware readiness check
- alert definitions

| Symptom | Check |
|---|---|
| Process exits at startup | `MONGO_URI`, network access, Atlas allowlist, credentials |
| Browser CORS failure | Exact origin in comma-separated `ALLOWED_ORIGINS` |
| API 401 | Bearer token and auth error code; then refresh-cookie flow |
| Refresh cookie missing | HTTPS, credentials mode, `SameSite`, domain topology |
| API 429 | 300 requests/two-minute application limit |
| API 503 | Handler exceeded 10 seconds; inspect PDF, CSV, and dashboard work |
| Duplicate-key 409 | Existing global IDs or MongoDB index state |
| PDF launch error | Chromium installation and `PUPPETEER_EXECUTABLE_PATH` |
| Missing logo/rupee glyph | Add and deploy expected invoice assets |

## 14. Verified production risks

These are current code behaviors, not hypothetical recommendations:

### Critical

1. `POST /api/auth/reset-password` is public and resets a password using only `phone` and `newPassword`. Anyone who knows a registered phone number can take over that account.
2. Registration accepts `role` from the request body. A caller can request the `Admin` role.
3. JWT secrets silently fall back to known strings if production configuration is missing.
4. The single factory invoice handler loads a record by ID without a `createdBy` condition, allowing an authenticated user who knows another record ID to access it.

### High

1. Role-based authorization is not applied to any route.
2. CSV confirmation/direct import can call a missing `utils/genTxnId` module.
3. In-memory CSV upload has no explicit file-size or type restriction.
4. PDF generation, CSV processing, and dashboard aggregation are synchronous request work constrained by a 10-second timeout.
5. Some free-text search paths build unescaped regular expressions, creating avoidable regex performance risk.

### Operational and data consistency

1. Merchant liabilities are represented by transaction payments, transaction advances, standalone advances, and merchant-level payments. Not every report reconciles every category identically.
2. `change-password` does not clear existing refresh sessions, while reset-password does.
3. The transaction model's payment lookup hooks do not always include `createdBy`, although payment queries use the transaction reference.
4. IDs such as `transactionId` and `batchId` are globally unique across users.
5. There is no automated regression suite or CI gate.
6. `npm start` depends on the development-only `nodemon` package.

Prioritize account recovery, registration privilege control, mandatory secrets, and factory invoice ownership before lower-risk cleanup.

## 15. Documentation maintenance

Update this file when routes, environment variables, token/cookie behavior, calculations, deployment definitions, or migrations change. Use application code as the source of truth and keep frontend-specific documentation in the frontend repository.
