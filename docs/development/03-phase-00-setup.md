# Phase 0 engineering baseline

**Release:** `0.0.1` engineering baseline. **Users:** developers/operators. **Definition of done:** another developer can clone, configure, migrate, seed, run and test on a clean machine using the documented commands. These commands are implementation requirements; they are not claimed to exist in the current documentation-only workspace.

## Repository contract

Use the existing LARA workspace as the repository root. Do not overwrite existing documents or local changes. Create a private remote under the DCP account supplied by its owner; local development and CI-template creation do not depend on remote availability. Default branch `main`, short feature branches `feat/<ticket>-<slug>`, PR review, squash merge and signed release tags. Do not create branches/remotes as part of this specification task.

```text
apps/web/src/{app,components,features,lib}
apps/api/src/{modules,bootstrap}
apps/worker/src/{handlers,scheduler}
packages/domain/src/<module>
packages/contracts/{openapi,schemas,generated}
packages/database/{migrations,seeds,src}
packages/ui/src
packages/testing/{fixtures,accounting,e2e}
infra/{compose,containers,deployment,monitoring}
scripts/{bootstrap,verify,release}
docs/development
.github/workflows/{ci,release}.yml
```

`domain` cannot import web, controllers or provider SDKs. Module repository interfaces live with domain/application code; adapters live in API/worker infrastructure. Contract generation is one-way from reviewed OpenAPI/types to clients; CI fails on generated drift. Dependencies shared by API and worker have one version.

## Design assets and build visibility

Implement [UI design and asset packaging](12-design-and-assets.md) in the baseline: shared theme scaffolding, deterministic copy from the approved Ledger-L kit to `apps/web/public/assets/lara/`, provenance checks and asset validation in CI. Preserve the supplied guide and branding sources. Register [build tracking](13-build-tracking.md) in the contributor workflow and run `python scripts/build_status.py check` in CI. Phase 0 may wrap the independent tracker utility in documented `pnpm status:*` commands. P00-01 owns packaging and P00-05 owns CI enforcement. The existing tracker is a delivery utility and does not satisfy the application baseline gate.

## Environments and configuration

| Key | Required behavior |
| --- | --- |
| `LARA_MODE` | `local`, `demo`, `staging`, `production`; validated enum, no permissive fallback |
| `APP_BASE_URL`, `API_INTERNAL_URL` | Explicit allowlisted origin and private backend; reject wildcard production origins |
| `DATABASE_URL` | Runtime non-owner role; TLS required outside local Compose |
| `MIGRATION_DATABASE_URL` | CI/operator only; absent from application containers |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Issuer discovery validated; secret from vault, never committed |
| `SESSION_SECRET_REF` | Secret-manager reference; rotation with previous verification key overlap |
| `OBJECT_ADAPTER`, `OBJECT_BUCKET`, `OBJECT_REGION` | `filesystem` only local/demo; production uses qualified private storage |
| `MAIL_ADAPTER` | Local mail sink or qualified provider; no real mail from demo |
| `EINVOICE_ADAPTER`, `AI_ADAPTER` | `disabled`, `fixture` or qualified provider; `fixture` rejected in production |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Telemetry collector; redact tokens, invoice payloads and personal data |
| `DEMO_RESET_ENABLED` | Allowed only for demo DB and demo-host entitlement |
| `RULE_PROFILE_ID` | Approved immutable profile in live use; fixture-only profile in demo |

Validate configuration at startup; fail with a secret-free reason when invalid. `.env.example` contains variable names and local instructions, not usable production credentials. Generate local credentials during bootstrap and store in ignored files. `.gitignore` must cover `.env*` except examples, generated credentials, local uploads, DB volumes, coverage and reports. Preserve the current graft ignores.

## Database and migration rules

Create `lara_local`, `lara_test`, `lara_demo`; production has a separate cluster/account boundary from demo. Schemas are module-owned; demo uses only `demo`. Migration metadata: `schema_migrations(version text PK, sha256 char(64), applied_at timestamptz, release text)`. Runner obtains one advisory lock, checks prior checksums, applies each file in a transaction unless explicitly marked nontransactional with a recovery procedure, records it and releases lock. No edited applied migration, automatic `synchronize`, or destructive reset against production URLs.

Roles: `lara_migrator` owns schemas; `lara_api` reads/writes authorized domain tables and calls approved posting functions; `lara_worker` has job/outbox and scoped domain access; `lara_audit_reader` reads authorized evidence only. Secret provisioning and SQL grants must be scripted. Runtime cannot alter tables, bypass RLS or mutate immutable journals/audit events. Verify grants in automated tests.

Initial live tenant provisioning is an audited operator procedure, not anonymous registration: verify the customer setup request, provision an isolated tenant, bind two verified OIDC subjects for administration and independent approval, and record the bootstrap evidence. Subsequent role/settings changes follow normal approval. No default shared admin password or automatic production owner from an email domain. P00 supplies the procedure/tool boundary; P02 implements the tenant bootstrap transaction and onboarding checklist.

## Required developer commands

| Command | Observable result |
| --- | --- |
| `pnpm setup` | Validates tools/config, generates local secrets, starts dependencies and prints next steps |
| `pnpm db:migrate` | Applies checked migrations to explicitly selected database; prints versions only |
| `pnpm db:seed:demo` | Synthetic fixtures; refuses any non-demo target |
| `pnpm dev` | Runs web/API/worker with dependency health checks |
| `pnpm verify` | Lint, types, unit/integration tests, contract drift and build |
| `pnpm test:e2e` | Starts isolated test database and seeded browser suite |
| `pnpm test:accounting` | Executes the canonical posting cases against PostgreSQL |
| `pnpm release:check` | Runs gates and emits release manifest; never deploys implicitly |

Use Node-based scripts for cross-platform commands; avoid shell-specific environment syntax. Developers on Windows may use Docker Desktop/WSL2; CI uses Linux containers. Document resource baseline: 4 CPU, 8 GB RAM and 20 GB free disk for local work, then measure actual usage. These are setup targets, not production sizing.

## CI and deployment

Every PR: frozen install; formatting/lint/type check; contract/schema validation; tests against PostgreSQL 18; migration clean/prior-version tests; dependency/secret scan; web/API/worker builds; browser smoke; image vulnerability scan. Required checks block merge. Never expose production secrets to forked PRs.

Release workflow takes a reviewed tag, builds once, emits SBOM/image digests, deploys staging, runs smoke and migration rehearsal, then requires the release owner to activate production. Registry and cloud credentials are protected environment secrets. Rollout uses health/readiness endpoints and rolling replacement; migrations follow expand/backfill/contract. P00 delivers deployment templates and a working local/demo deployment target, not an invented DCP cloud account.

Endpoints: `GET /health/live` checks process only; `GET /health/ready` checks DB/schema compatibility and required configuration without credentials; authenticated `/ops/version` exposes commit, build and schema versions. Dependency errors produce degraded readiness, structured logs and a trace ID.

## P00 acceptance

P00-T01 clean clone reaches the login page and API readiness through documented steps. P00-T02 missing secret fails safely. P00-T03 rerun migration is a no-op and altered checksum fails. P00-T04 runtime role cannot bypass tenant policies or alter schema. P00-T05 clean and previous-release databases migrate. P00-T06 demo seeding refuses production. P00-T07 CI failure blocks release. P00-T08 restore local backup and verify metadata/fixture counts. Ship tagged infrastructure with instructions and evidence for all eight cases.
