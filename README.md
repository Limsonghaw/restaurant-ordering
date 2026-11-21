# Restaurant QR Ordering

A table-side QR ordering prototype for restaurants. Customers scan a QR code on the table to browse the menu and place orders. Store staff manage the menu, live orders, tables, and bills from a back-office console.

The interface is in Simplified Chinese. Prices use Malaysian Ringgit (MYR), including optional service charge and SST.

## Live demo

[https://songhaw-ordering.s020611h.workers.dev](https://songhaw-ordering.s020611h.workers.dev)

The hosted site runs on Cloudflare Workers and uses the Supabase data source. The home page asks you to scan a table QR code, or you can open the store console (login required).

### Store console demo login

[Open the demo login](https://songhaw-ordering.s020611h.workers.dev/login)

- Email: `restaurantorderingdemo@gmail.com`
- Password: `427YHT8niiZEzhp`

These credentials are provided for public demo access. Use fictional information only.

The in-browser mock tables such as `/t/demo-a1` work only in local mock mode, not on this hosted site.

## Features

**Customer**

- Open a table menu by scanning that table's QR code (`/t/[code]`)
- Browse and search dishes by category, including sold-out and hidden items
- Add items to a cart, with optional notes, then review a price quote (subtotal, service charge, SST)
- Place an order and follow its status: waiting for staff confirmation, accepted, or served

**Store console**

- Register and log in with email or a Malaysian phone number, and reset a password
- Live order board, with realtime updates: accept an order, mark it served, cancel it, or reject it and block the device; pause or resume accepting orders
- Menu management: categories and dishes, hide or mark sold out, reorder, and upload images
- Tables and QR codes: add, rename, enable, disable, or delete tables; rotate a table QR; download or print QR codes
- Bills: review open and paid bills, and mark a table as paid (this clears the table)
- Order history and daily totals
- Store settings: name, logo, address, opening hours, whether the store is accepting orders, service charge, and SST
- Blocked-client list (device or IP), with the option to unblock

## Tech stack

- Next.js, React, and TypeScript
- Tailwind CSS
- Supabase (Postgres, Auth, Realtime, and Storage)
- Vitest
- GitHub Actions
- Cloudflare Workers (via Vinext)
- Cloudflare Turnstile for bot checks (when configured)
- Optional Twilio Verify for SMS and Upstash Redis for rate limiting

The app requires Node.js 22 or newer. CI uses Node.js 24.

## Project structure

```text
app/                  Routes: customer (/t/[code]), store console, auth, and APIs
lib/data/             Data access (mock or Supabase)
lib/ui/               Customer, store, and auth UI
lib/supabase/         Supabase clients and customer API helpers
supabase/             Database migrations and database tests
tests/                Vitest unit tests
.github/workflows/    CI workflow
cloudflare.config.ts  Cloudflare Workers deploy config
```

## Getting started

Install dependencies and start a local preview with the default mock data source. No database or real secrets are required for this mode.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000). In mock mode, the home page links to a sample table at `/t/demo-a1`, and a mock control panel is available for trying different states.

`NEXT_PUBLIC_DATA_SOURCE` must be set to `mock` or `supabase`. The default in `.env.example` is `mock`. To run against a local or hosted Supabase project, set it to `supabase` and fill in the other variables from `.env.example`. A detailed local Supabase walkthrough is in [docs/local-run-windows.md](docs/local-run-windows.md).

Useful variables:

- `NEXT_PUBLIC_DATA_SOURCE` — `mock` or `supabase`
- `NEXT_PUBLIC_SITE_URL` — site origin, with no trailing slash
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and optional `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
- `NEXT_PUBLIC_AUTH_SMS_ALLOWED_COUNTRIES` — default `MY`
- `CUSTOMER_API_DATABASE_URL` and `CUSTOMER_DB_SSL` — required for the customer API in Supabase mode
- `QR_SIGNING_SECRET`, `CLIENT_HASH_SECRET`, and `DEVICE_COOKIE_SECRET`
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — rate limiting in hosted environments
- `TWILIO_ACCOUNT_SID`, `TWILIO_VERIFY_SERVICE_SID`, and `TWILIO_AUTH_TOKEN` — SMS via Twilio Verify, when enabled
- `TRUST_LOCAL_IP` and `LOCAL_MEMORY_RATE_LIMIT` — local development only; do not set these in hosted environments

`NEXT_PUBLIC_` values are exposed to the browser. Keep server secrets out of those variables and out of git. A full commented list is in [`.env.example`](.env.example).

Checks and production build:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Database tests (the second command needs a local Supabase instance):

```sh
npm run test:db:unit
npm run test:db
```

## CI

On every push and pull request, GitHub Actions runs two jobs:

- **check:** install dependencies, then `npm run lint`, `npm run typecheck`, and `npm test`. It builds once with `NEXT_PUBLIC_DATA_SOURCE=supabase` and checks that mock-only code is not left in the production output, then builds again with `NEXT_PUBLIC_DATA_SOURCE=mock`.
- **database:** run `npm run test:db:unit`, start a local Supabase database, and run `npm run test:db`.

CI uses Node.js 24. The production build in CI uses placeholder public values, not real secrets.

## Deployment

The live demo is a Cloudflare Worker named `songhaw-ordering`. Production is configured to use `NEXT_PUBLIC_DATA_SOURCE=supabase`.

```sh
npm run build:vinext
npm run deploy:vinext
```

For a local Workers-style preview, `npm run dev:vinext` serves the Vinext build on port 3001. Keep Cloudflare local secrets in `.dev.vars` and do not commit that file.

## AI-assisted development

This project was built with AI assistance. Song Haw specified the features and directed OpenAI Codex, which generated the code. He reviewed the output, debugged it, and acceptance-tested each feature.

## Status and limitations

This is a prototype (version 0.1.0 in `package.json`), not a production restaurant system.

- There is no online payment integration. Staff collect payment in person, then mark the bill as paid in the store console.
- The user interface is in Simplified Chinese only.
- Platform admin pages (`/admin/stores` and `/admin/mfa`) are still placeholders.
- SMS is limited to the countries in `NEXT_PUBLIC_AUTH_SMS_ALLOWED_COUNTRIES` (default: Malaysia).
- Mock demo tables such as `demo-a1` are only available when `NEXT_PUBLIC_DATA_SOURCE=mock`.

## License

MIT. See [LICENSE](LICENSE).

## Author

Lim Song Haw  
[limsonghaw.pages.dev](https://limsonghaw.pages.dev)
