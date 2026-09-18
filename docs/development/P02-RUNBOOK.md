# P02 finance workspace runbook

Operator procedures for the workspace release. Every procedure names the evidence to preserve, the permitted actions, the prohibited shortcuts and how recovery is verified. Direct edits to `lara.*` tables are prohibited in every procedure; the database rejects application-role deletes and audit mutations, and an operator who bypasses that must record a reviewed incident.

## Start, stop and readiness

- Start: web (`node apps/web/server.js` in the image), API (`node apps/api/src/server.mjs`), worker (`node apps/worker/src/main.mjs`). Required environment is validated at boot by `packages/config/src/env.mjs`; a missing or unsafe value fails before listening. `FIELD_ENCRYPTION_KEY` (32 bytes) is required for party identifiers; `OBJECT_ADAPTER`/`OBJECT_BUCKET` select the evidence store; `SCANNER_ADAPTER` selects the scanner (the fixture scanner refuses to start outside local/demo).
- Readiness: API `GET /health/ready` requires the latest migration; web `GET /api/health/ready` proxies it. Worker readiness is the `heartbeat` log line every 30 s.
- Stop: SIGTERM. The worker finishes the running job or lets its lease expire (60 s); another worker resumes the job. Never kill mid-transaction with the database unreachable and then restart without checking `lara.jobs` for `running` rows with expired leases (they are reclaimed automatically).
- Evidence to preserve: boot logs (`safeConfigError` output only, never secrets), `x-trace-id` of failing requests.

## Deploy and rollback

1. Record RG-01–08 evidence and the schema range (this release requires migrations through `0011`).
2. Take the recovery checkpoint (`scripts/test-restore.mjs` snapshot format; Supabase PITR for hosted).
3. Apply migrations with the migrator role: `pnpm db:migrate` (`MIGRATION_DATABASE_URL`). Migrations are additive; `0009`–`0011` never drop financial data.
4. Deploy images in any order; old and new API versions coexist on the same schema.
5. Verify readiness and run a read/write smoke: `GET /v1/me` as a provisioned principal and one `POST /v1/tasks` with a fresh `Idempotency-Key` on a synthetic entity.
6. Rollback: redeploy the previous images within the schema range. Do not down-migrate. If a migration itself failed, see below.

## Failed migration

`applyMigrations` runs each file inside one transaction under an advisory lock; a failure leaves no version row (`scripts/test-foundation-db.mjs` proves this). Read the error, fix forward with a new file, rerun. A checksum mismatch means an applied file was edited: restore the original file content; never edit `schema_migrations`.

## Queue replay and dead letter

- Inspect: `select id,kind,state,attempt,error_code,run_after,lease_owner from lara.jobs where state in ('retry_wait','dead_letter','running')` as the audit reader.
- Retry schedule is fixed (1 s, 5 s, 30 s, 2 m, 10 m); after five attempts the job is `dead_letter` and a high-severity task `dead_letter` is opened on the entity for its owner.
- Replay: only through an authorized command that re-enqueues the work (`POST /v1/exports` again, or re-`complete` an upload after a new registration). Dead-letter rows are history; do not flip their state by hand.
- Authorization failures (`FORBIDDEN`, `STATE_CONFLICT`, `VALIDATION_FAILED`) are final and are not retried; the requester must act again with current access.

## Restore

`scripts/test-restore.mjs` rehearses snapshot integrity and row-count/hash verification for every `lara` table including the P02 set. After a real restore: run the rehearsal against the restored database, verify `lara.audit_events` chains recompute (`scripts/test-p02-schema.mjs` group 13 shows the query), invalidate sessions by rotating `SESSION_SECRET` per `SESSION-KEY-ROTATION.md`, and confirm `lara.jobs` running rows are reclaimed. Evidence objects live in the object store keyed by `object_key`; a restored database older than the store keeps working because keys are immutable.

## Scope revocation

Revocation is a command (`POST /v1/memberships/{id}/revoke`) by a security administrator. It increments the principal's revocation version, so sessions lose permissions on the next request (authorization is not cached beyond the request), queued exports fail with `FORBIDDEN` when the worker rechecks, and downloads are refused. Already downloaded files cannot be recalled; record that in the incident. To disable an account entirely set `lara.principals.status='disabled'` through the same administrative path (an operation for this is not yet in the reviewed contract; until then it is a migrator-role change recorded as an incident).

## Evidence scan failure

Symptoms: evidence stuck in `scanning`, worker log `job_retry_wait`/`job_dead_letter` for `evidence.scan`. Check the scanner adapter health and the object store. Content in `scanning` is never served. After the scanner recovers, the job resumes automatically from `retry_wait`; if dead-lettered, the uploader registers the upload again (the old record stays `scanning` until the operator rejects it through a reviewed correction). Infected content is disposed and the record is `rejected` with the reason.

## Export failure

`POST /v1/exports` returns a job; `GET /v1/jobs/{id}` shows `failed` with `error_code`. `FORBIDDEN` means access changed after queueing (intended). `VALIDATION_FAILED` on row limits means the scope must be narrowed. Infrastructure errors retry on the fixed schedule. Completed exports are restricted evidence with a SHA-256; the download endpoint rechecks membership on every call.

## Provider outage

P02 has no external provider on an enabled path. Object store unavailability surfaces as `DEPENDENCY_UNAVAILABLE` (503) on uploads and downloads and as job retries; nothing is lost because registration and completion are separate steps. Do not switch adapters in production without the qualification gate in `07-security-and-operations.md`.

## Module-specific corrections

- Activation was approved in error: a material edit to the entity returns it to `draft` and invalidates approvals; request activation again.
- Wrong party merged: merges are alias links (`merged_into`) with the source archived; correct by editing the target and, if needed, creating a new party. Nothing is rewritten in history.
- Settings approved with the wrong payload: save a new draft (next version number), have a different principal approve it; the prior version becomes `superseded`.
- Tenant provisioning error: `scripts/provision-workspace-tenant.mjs` is additive; a wrongly named tenant is renamed through a reviewed migrator change. Test tenants are removed with `scripts/cleanup-test-tenants.mjs` (engineering databases only).

## Escalation

Posting or integrity violation: none possible in P02 (no ledger). Tenant disclosure: Sev1 per `07-security-and-operations.md`. Queue stalled (`oldest pending > 5 min`): operations. Evidence scan backlog: operations, with the uploader informed. Owners record the incident with the trace ids and the `lara.audit_events` sequence range affected.
