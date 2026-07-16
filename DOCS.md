# DOOARS GREEN FPO — Production Backend Documentation

> **Updated:** July 2026
> **Repository:** `teanest-backend`
> **Scope:** This repository contains the Express/MongoDB API. The React/Vite frontend mentioned below is deployed from a separate repository.

## Contents

1. [System overview](#system-overview)
2. [Quick start](#quick-start)
3. [Configuration](#configuration)
4. [Architecture and request lifecycle](#architecture-and-request-lifecycle)
5. [Authentication and tenancy](#authentication-and-tenancy)
6. [Domain model](#domain-model)
7. [API reference](#api-reference)
8. [CSV imports, invoices, and PDFs](#csv-imports-invoices-and-pdfs)
9. [Deployment](#deployment)
10. [Migrations and operations](#migrations-and-operations)
11. [Production risks and technical debt](#production-risks-and-technical-debt)

## System overview

DOOARS GREEN FPO manages tea-estate procurement, factory sales, labor, payments, buyer and supplier records, and PDF invoices.

```text
React/Vite frontend (separate repository)
             |
             v
Express API (this repository) ---> MongoDB Atlas
             |
             +-- Puppeteer + Chromium ---> PDF invoices
```

The backend uses Node.js, Express 4, Mongoose/MongoDB, JWT, bcrypt, `express-validator`, and Puppeteer Core. Docker uses Node 20 and a system Chromium installation.

### Important terminology

The similarly named resources below serve different business functions:

| API path | Model | Meaning |
|---|---|---|
| `/api/merchants` | `Merchant` | Leaf-supplier master data used for procurement |
| `/api/merchant-transactions` | `MerchantTransaction` | Individual leaf procurement transactions |
| `/api/merchant` | `TeaMerchant` | Tea batch/inventory records |
| `/api/factory` | `Factory` | Tea sales to buyers |

## Quick start

### Prerequisites

- Node.js 20 or newer
- A MongoDB Atlas connection
- Chromium/Chrome when generating PDFs locally

### Install and run

```bash
npm install
cp .env.example .env # Create manually; this repository does not currently include this file.
node server.js
```

`npm start` runs `nodemon server.js` and is intended for development. The application listens on `PORT` or, when it is absent, port `5000`.

Verify the service:

```bash
curl http://localhost:5000/
```

The root health endpoint is public. API endpoints are mounted under `/api`.

## Configuration

Secrets must be configured in the hosting provider; never commit `.env`.

| Variable | Required in production | Used for |
|---|---:|---|
| `MONGO_URI` | Yes | MongoDB connection |
| `JWT_SECRET` | Yes | Access-token signing and verification |
| `JWT_REFRESH_SECRET` | Yes | Refresh-token signing and verification |
| `NODE_ENV` | Yes | Production cookie and error-handling behavior |
| `ALLOWED_ORIGINS` | Yes | Comma-separated CORS allowlist |
| `PORT` | No | HTTP port; code defaults to `5000` |
| `PUPPETEER_EXECUTABLE_PATH` | Usually | System Chrome/Chromium path for containers |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | Container only | Avoids downloading a browser during install |
| `VERCEL` | Platform-provided | Prevents `app.listen()` for serverless execution |

The frontend’s separate deployment needs `VITE_API_BASE_URL` pointing to the backend `/api` base URL.

Access-token expiry is currently hard-coded to one hour and refresh-token expiry to seven days in `controllers/authController.js`; `JWT_ACCESS_EXPIRES_IN` and `JWT_REFRESH_EXPIRES_IN` are not read by the application.

## Architecture and request lifecycle

### Entry points

| File | Responsibility |
|---|---|
| `server.js` | Loads environment variables, connects MongoDB, starts the HTTP listener unless deployed on Vercel |
| `app.js` | Builds Express middleware, mounts routes, defines the health check, 404 handling, and error handling |
| `config/db.js` | Creates the Mongoose connection |
| `routes/index.js` | Mounts all API route groups |
| `middleware/auth.js` | Verifies bearer tokens and loads the current user |
| `middleware/errorHandler.js` | Emits consistent error responses |

### Middleware behavior

Requests pass through the following major controls:

1. Reverse-proxy trust, Helmet, CORS, JSON and URL-encoded body parsing (10 MB limit), cookie parsing, and Morgan logging.
2. A global 10-second response timeout.
3. A rate limit of 300 `/api` requests per two minutes.
4. Route-specific authentication and input validation.
5. The global 404 and error handlers.

The global timeout can be shorter than a slow Puppeteer rendering operation. Monitor invoice traffic and resource limits in production.

### Response conventions

Successful responses generally use:

```json
{ "success": true, "data": {} }
```

List responses may also include `pagination`. Validation and application errors generally use:

```json
{
  "success": false,
  "message": "Human-readable error",
  "errors": [{ "field": "grossQty", "message": "must be positive" }]
}
```

## Authentication and tenancy

### Token flow

1. `POST /api/auth/login` verifies the password.
2. The API returns an access JWT for the `Authorization: Bearer <token>` header and sets an httpOnly refresh-token cookie.
3. `POST /api/auth/refresh` rotates the refresh token and returns a new access token.
4. `POST /api/auth/logout` clears the cookie and removes the stored token hash.

Refresh tokens are hashed in MongoDB, rotated on refresh, and capped at five active sessions. A refresh-token mismatch clears a user’s sessions. Production cookies are secure and `sameSite: strict`.

All non-auth API routes require a bearer token through `routes/index.js`. Business records are normally filtered by `createdBy`, so each authenticated user accesses their own tenant data. Clients must send credentials where the refresh cookie is needed and must use an origin allowed by `ALLOWED_ORIGINS`.

`User` stores `Admin` and `Manager` roles, but the available `requireRole` middleware is not applied to the mounted routes. Roles therefore do not currently provide route-level authorization.

## Domain model

```text
User
 ├─ Merchant ──< MerchantTransaction ──< MerchantPayment
 │       ├─< MerchantAdvance
 │       └─< MerchantMasterPayment
 ├─ Buyer ──< Factory (embedded payments[])
 ├─ Labor
 ├─ Payment
 └─ TeaMerchant
```

| Model | Purpose |
|---|---|
| `User` | Accounts, hashed passwords, refresh-token hashes, roles |
| `Merchant` | Leaf supplier master; unique per `phone` and `createdBy` |
| `MerchantTransaction` | Leaf procurement, calculated payable amounts, transaction-level payments |
| `MerchantPayment` | Payment applied to one procurement transaction |
| `MerchantAdvance` | Supplier advance at merchant-master level |
| `MerchantMasterPayment` | Merchant-level payment |
| `Buyer` | Factory buyer master; unique per `phone` and `createdBy` |
| `Factory` | Sale to a buyer with embedded payment subdocuments |
| `Labor` | Worker record and paid/due state |
| `Payment` | General-purpose payment ledger |
| `TeaMerchant` | Tea batch/inventory record; distinct from supplier `Merchant` |

### Calculations

For `MerchantTransaction`:

```text
lessQty       = grossQty × lessPercent / 100
netQty        = grossQty − lessQty
grossAmount   = netQty × ratePerKg
labourAmount  = labourHeadCount × labourCharge
netPayable    = grossAmount − labourAmount
finalPayable  = netPayable − advancePayment
balance       = finalPayable − transaction payment total
```

For `Factory`:

```text
lessQuantity = totalQuantity × lessPercentage / 100
netQuantity  = totalQuantity − lessQuantity
totalAmount  = netQuantity × rate
due          = totalAmount − advance − sum(payments[].amount)
```

## API reference

All paths below are prefixed with `/api`. Unless explicitly noted, authentication is required.

### Public authentication routes

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Register an account |
| POST | `/auth/login` | Obtain access token and refresh cookie |
| POST | `/auth/refresh` | Rotate refresh token and issue access token |
| POST | `/auth/logout` | End the current refresh-token session |
| POST | `/auth/reset-password` | Reset a password |

### User profile

| Method | Path | Purpose |
|---|---|---|
| GET | `/users/me` | Read current user profile |
| PUT | `/users/me` | Update current user profile |
| PUT | `/users/change-password` | Change current user password |

### Supplier masters and payments

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/merchants` | List or find/create suppliers |
| GET | `/merchants/search?q=...` | Search suppliers |
| GET, PUT, DELETE | `/merchants/:id` | Read, update, or remove a supplier |
| GET, POST | `/merchants/:merchantId/advances` | List or create supplier advances |
| DELETE | `/merchants/:merchantId/advances/:advanceId` | Remove an advance |
| GET, POST | `/merchants/:merchantId/payments` | List or create supplier-level payments |
| DELETE | `/merchants/:merchantId/payments/:paymentId` | Remove a supplier-level payment |

### Procurement transactions

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/merchant-transactions` | List or create procurement transactions |
| GET | `/merchant-transactions/stats` | Procurement statistics |
| POST | `/merchant-transactions/import` | Parse uploaded CSV; supports preview |
| POST | `/merchant-transactions/import-confirm` | Confirm imported JSON rows |
| GET, PUT, DELETE | `/merchant-transactions/:id` | Read, update, or remove transaction |
| GET | `/merchant-transactions/:id/invoice?format=pdf\|html` | Generate one transaction invoice |
| GET | `/merchant-transactions/invoice/by-merchant-date` | Generate a multi-transaction merchant invoice |
| GET, POST | `/merchant-transactions/:txnId/payments` | List or create transaction payments |
| DELETE | `/merchant-transactions/:txnId/payments/:payId` | Remove a transaction payment |

`merchant-transactions` supports combined filtering including `search`, `phone`, `merchantName`, `teaType`, `startDate`, and `endDate`. Conditions combine as AND; search values are escaped before use in MongoDB regular expressions.

### Tea inventory, buyers, factory, labor, and ledger

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/merchant` | List or create `TeaMerchant` inventory records |
| GET | `/merchant/stats` | Tea inventory statistics |
| GET, PUT, DELETE | `/merchant/:id` | Manage a tea inventory record |
| GET, POST | `/buyers` | List or find/create buyers |
| GET | `/buyers/search` | Search buyers |
| GET, PUT, DELETE | `/buyers/:id` | Manage a buyer |
| GET, POST | `/factory` | List or create factory sales |
| GET | `/factory/stats` | Factory-sale statistics |
| GET, PUT, DELETE | `/factory/:id` | Manage a factory sale |
| POST | `/factory/:id/payments` | Add embedded sale payment |
| DELETE | `/factory/:id/payments/:paymentId` | Remove embedded sale payment |
| GET | `/factory/:id/invoice?format=pdf\|html` | Generate invoice for a sale |
| GET | `/factory/invoice/by-buyer` | Generate buyer invoice |
| GET, POST | `/labor` | List or create labor records |
| GET | `/labor/stats` | Labor statistics |
| GET, PUT, DELETE | `/labor/:id` | Manage labor record |
| PATCH | `/labor/:id/pay` | Toggle paid/due status |
| GET, POST | `/payments` | List or create general-ledger payments |
| GET | `/payments/stats` | General payment statistics |
| GET, PUT, DELETE | `/payments/:id` | Manage general payment |
| GET | `/dashboard` | Aggregated dashboard data |

## CSV imports, invoices, and PDFs

### CSV import

Upload a CSV file as multipart form data to `POST /api/merchant-transactions/import`. Use `?preview=true` to validate and preview parsed rows before submission. Confirm the accepted rows with `POST /api/merchant-transactions/import-confirm`.

The import process links or creates supplier masters using phone numbers. Treat imports as an operationally sensitive process: retain the source CSV, preview before confirmation, and validate balances after import.

### Invoice rendering

Invoice templates in `controllers/invoiceController.js` render HTML, then dynamically import `puppeteer-core` and launch Chromium. Browser resolution prefers the serverless Chromium package on Linux/serverless and otherwise uses `PUPPETEER_EXECUTABLE_PATH` or known platform paths.

Set `format=html` for markup inspection or `format=pdf` for an A4 PDF. `assets/logo.png` is embedded in invoice output. The code references `assets/fonts/NotoSans-Regular.ttf`; include that font in a deployment if reliable rupee-symbol rendering is required.

## Deployment

### Docker

The provided `Dockerfile` installs Chromium and its dependencies, sets `PUPPETEER_EXECUTABLE_PATH`, exposes port `8080`, and starts `node server.js`.

```bash
docker build -t dooars-green-api .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e NODE_ENV=production \
  -e MONGO_URI \
  -e JWT_SECRET \
  -e JWT_REFRESH_SECRET \
  -e ALLOWED_ORIGINS \
  dooars-green-api
```

### Railway/Nixpacks and Vercel

`nixpacks.toml` installs Chromium and starts `node server.js`, so Railway can deploy this repository directly after the production environment variables are set.

`server.js` exports the Express app when `VERCEL` is set, allowing a serverless deployment. No `vercel.json` is present; configure routing and serverless limits in the target platform if using this option. Puppeteer startup time and the global 10-second timeout make a long-lived container platform more suitable for dependable PDF generation.

### Production checklist

- Set unique, high-entropy JWT secrets; do not rely on code fallbacks.
- Configure exact frontend origins in `ALLOWED_ORIGINS`.
- Use TLS and `NODE_ENV=production`.
- Ensure MongoDB backups, least-privilege credentials, and network access restrictions.
- Confirm Chromium and the PDF font asset are available in the runtime image.
- Check `/` health, authenticated API access, refresh-cookie behavior, and a PDF invoice after deployment.

## Migrations and operations

Migration scripts are one-time administrative tools and require `MONGO_URI`:

| Script | Purpose |
|---|---|
| `scripts/migrate-createdBy.js` | Backfill tenant ownership and update legacy indexes |
| `scripts/migrate-merchants.js` | Link legacy transaction merchant names to supplier masters |
| `scripts/migrate-buyers.js` | Link legacy factory buyer names to buyer masters |

Back up MongoDB and test against a restored copy before running a migration. There are no automated tests or CI workflows in this repository, so production changes need a manual smoke test of authentication, tenant separation, CRUD, CSV import, and PDF generation.

## Production risks and technical debt

These are observations from the current implementation, not fixed by this documentation update:

| Priority | Finding | Impact |
|---|---|---|
| High | Registration is public and accepts a role; password reset is public and phone-based. | Account creation and password-reset abuse risk. |
| High | JWT fallback secret strings exist in code. | A misconfigured production deployment could use predictable signing keys. |
| High | CSV import references `utils/genTxnId`, but that module is absent. | Import confirmation can fail at runtime. |
| Medium | Single factory invoice lookup is not scoped by `createdBy`. | An authenticated user may access an invoice by another tenant’s record ID. |
| Medium | Roles are stored but no mounted route enforces them. | Admin/Manager does not currently enforce privilege boundaries. |
| Medium | The referenced Noto Sans font is missing from `assets/fonts`. | PDF currency glyphs may render incorrectly. |
| Medium | Global response timeout is 10 seconds. | PDF responses may be aborted under load. |
| Low | `merchantAdvanceRoutes.js` is not mounted and `html-pdf-node` is not imported. | Dead or misleading code/dependency. |
| Low | `PORT` defaults to `5000`, while Docker exposes `8080`. | Local/default port expectations differ. |

Address the high-priority findings before treating this service as hardened for new public users. Until then, restrict registration/reset access at the API gateway or application layer and continuously monitor authentication and invoice access logs.
