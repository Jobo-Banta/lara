# LARA engineering baseline

Synthetic-data development only. The implementation authority is [the development plan](docs/development/README.md); current gate evidence is in [P00 review](docs/development/P00-REVIEW.md).

## Prerequisites

Node 24.16.0, pnpm 9.15.5, Python 3.12, Git, and a dedicated Supabase demo project. Allow 4 CPU, 8 GB RAM and 20 GB disk. CI separately tests PostgreSQL 18; the configured Supabase project uses PostgreSQL 17.6.

## Clean checkout

1. Clone https://github.com/Jobo-Banta/lara and run `pnpm install --frozen-lockfile`.
2. Copy `.env.example` to ignored `.env.local`. Supply the project's owner connection, runtime database connection, OIDC issuer/client credentials, callback and Supabase publishable key. Never commit this file.
3. Run `node scripts/provision-roles.mjs` to create missing runtime and migrator roles and store generated local connections. Existing passwords are preserved.
4. Run `pnpm setup`, then `pnpm db:migrate`. For an existing operator-owned installation, run `node scripts/assign-migrator.mjs` once.
5. Set `DEMO_DATABASE_CONFIRMED=true` in the ignored file and run `pnpm db:seed:demo`. The mode and database marker must both identify a demo target.
6. Run `pnpm dev`. This starts the API, checks readiness, then starts the worker and web application. Open http://localhost:3000.
7. Create an auto-confirmed Supabase Auth demo user, complete sign-in and consent, then assign its verified subject with `node scripts/provision-demo-subject.mjs <subject>`. Each subject receives an empty isolated workspace; canonical fixtures are never implicitly shared.

## Verification

Run `pnpm verify`, `pnpm exec playwright install chromium`, `pnpm test:e2e`, `pnpm test:database`, `pnpm test:isolation` and `pnpm test:restore`. Database tests use transient synthetic records and rollback-only restoration. Browser smoke uses an isolated port and fake identity settings, without invoking the real provider.

`pnpm db:backup:snapshot` exports engineering fixtures into ignored local storage. `pnpm db:restore:snapshot` rehearses restoration and rolls back; it is not disaster-recovery provisioning for Supabase Auth or an entire cluster.

## Operating boundary

Keep operator credentials outside deployed runtime containers. Supply API, worker and web only their necessary environment variables. Container targets are `api`, `worker` and `web`; migration is an operator job. Demo reset and production onboarding remain disabled until their respective module gates pass. Local logs are the operator's monitoring surface; no external alert destination is claimed.

The repository is public by explicit owner exception. A passing build is not a release: required checks, artifact delivery and signed-tag evidence must be recorded before P00 is marked shipped.
