# P00 implementation review — 18 September 2026

## Scope and approved exceptions

The owner explicitly approved retaining the public GitHub repository Jobo-Banta/lara on 18 September 2026. This supersedes the P00 private-repository requirement. It does not authorize publishing credentials or bypassing required checks.

Supabase is the requested database platform. The inspected instance runs PostgreSQL 17.6; the specification requests PostgreSQL 18 in CI. The difference remains visible rather than treated as a passing compatibility check.

## Verified improvements

- Missing runtime configuration now prevents API startup. Migration credentials are not required by runtime configuration.
- Generated session secret in ignored .env.local; removed the hard-coded session fallback. Callback now verifies nonce and subject.
- Database client connections verify TLS using the packaged public Supabase CA. Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt. Supabase guidance: https://supabase.com/docs/guides/platform/ssl-enforcement.
- Migration runner extracted for rollback-only PostgreSQL rehearsals. Actual SQL replayed in fresh namespaces; initial-to-current upgrade, repeated no-op, changed checksum rejection and failed-version rollback passed.
- Actual runtime connection was denied CREATE SCHEMA. No existing application data changed during rehearsal.
- Migration 0005 grants only SELECT on migration metadata to API/worker for schema-aware readiness.
- Isolated API smoke test: liveness 200, readiness 200 in demo mode, anonymous version endpoint 401.
- Six foundation tests pass. Production build, type checking and tracker check pass.
- Asset manifest derives from source files and no longer hashes itself. Repeated builds produce identical manifests.
- CI uses a cross-platform Python wrapper and includes foundation tests, tracker checks, build, source asset drift, specification and tracker unit tests.
- Release checker fails when verification fails or P00 tickets are incomplete.
- The previous no-op reset endpoint no longer reports success: it returns 501 until a session-scoped reset is implemented.

## Outstanding acceptance work

| Ticket | Actual remaining work |
| --- | --- |
| P00-01 | Clean-clone full-stack bootstrap, worker/toolchain manifest and runtime/image pinning. setup validates existing credentials but does not provision all dependencies. |
| P00-02 | Startup missing-secret gate now verified. Secret-manager integration and key rotation remain outside the tested local-file baseline. |
| P00-03 | Script migrator/runtime role provisioning; test genuine clean/prior-release databases in CI. Current rehearsal isolates schemas in one rollback-only Supabase transaction. |
| P00-04 | Complete OIDC provider login proof, server-to-server authenticated scoped API identity, tenant policies and cross-tenant negative tests. Nine existing demo tables lack RLS. Non-superuser roles alone do not prove isolation. |
| P00-05 | Publish and run CI, enforce required checks on main, add dependency/secret/image scans and contract-generation drift evidence. Remote had no main branch when inspected. |
| P00-06 | Enforce dedicated demo target identity and per-session entitlement. Mode guards alone are insufficient. Production registration guard is implemented; reset remains intentionally unavailable. |
| P00-07 | Authenticated version response, structured operational events, telemetry/alert routing and negative readiness recovery. Anonymous version denial alone is not a finished authenticated endpoint. |
| P00-08 | Broader backup/restore rehearsal with nonempty fixtures, reproducible artifact delivery, signed release tag and release gate report. Prior metadata-only snapshot with zero seed rows is insufficient evidence for a shipped baseline. |

No P00 release is attested. Previous in-review labels are not proof of completed acceptance. This report distinguishes code fixes from gates that still require implementation.

## Repeatable commands

- pnpm setup — generate missing local defaults/secret and validate supplied connection and OIDC settings.
- pnpm verify — foundation tests, tracker consistency, type/build checks.
- node scripts/test-foundation-db.mjs — real PostgreSQL rollback-only migration and runtime DDL test.
- node scripts/test-api-readiness.mjs — isolated API readiness smoke.
- node scripts/audit-foundation-db.mjs — read-only role/migration/RLS audit; local result under .local/verification.
- pnpm release:check — fail closed on incomplete tickets; never deploys or attests a release.

Keep credentials in ignored .env.local. Migration commands accept MIGRATION_DATABASE_URL or the existing SUPABASE_OWNER_DATABASE_URL; only operators run them. Runtime uses DATABASE_URL. Run API and web with pnpm api and pnpm dev in separate terminals.
