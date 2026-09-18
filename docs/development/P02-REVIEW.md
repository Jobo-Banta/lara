# P02 implementation review — 19 September 2026

P02 is in progress, not released. Build-order steps 1 (contracts and migrations), 2 (domain rules), 3 (API, jobs and adapters), 4 (user journeys) and 5 (acceptance and operations) are implemented. Nothing in this phase is activated for any live tenant.

## P02-01 contracts and migrations

Migration `0009_p02_workspace_schema.sql` creates the production `lara` schema tables from the shared data contract and the P02 specification:

- Organization and security: `tenants` (immutable demo/live mode), `entities`, `branches`, `books`, `principals` (revocation version), `roles`, `memberships`, `delegation`, `approval_policies`, `capability_activations`, `onboarding_checks`, `settings_versions`.
- Parties and evidence: `party` (normalized search name, merge link), `party_roles`, `party_bank_accounts`, `evidence`, `evidence_links`.
- Work: `tasks`, `task_comments`, `obligations`, `approval_requests`, `approval_decisions`.
- Durable operations: `command_receipts`, `outbox_events`, `inbox_receipts`, `jobs`, `audit_chain_heads`, `audit_events`.
- Definitions seeded from the reviewed contracts: 291 `permission_definitions`, 15 `capability_definitions` with their dependency graph, 9 `role_templates`. No tenant, party or rule data is seeded.

Database-enforced rules: composite tenant/entity foreign keys; CHECK-constrained statuses matching the published state machines; server-managed `version`/`updated_at`; membership changes increment the principal revocation version; role and delegation permissions must be published codes; approved policy, settings, bank-account and approval-request content is immutable; maker-checker on approval decisions and every `approved_by`; evidence identity immutability and state machine; one active task per source/kind/cause; obligation uniqueness and retained completion evidence; live entity activation requires a registration profile and passed onboarding checks; capability activation requires active dependencies; audit events receive their sequence, previous hash and hash inside a per-entity chain-head lock and are append-only for every role; outbox rows only record publication; job transitions follow the published machine and workers claim across tenants with `SKIP LOCKED`.

Row-level security is forced on every tenant table, including for the table owner; runtime roles see only the tenant bound through `lara.tenant_id`. No runtime role holds DELETE. A table owner or superuser can remove append-only rows only after setting `lara.maintenance = 'teardown'`, which runtime roles cannot satisfy.

`@lara/contracts` compiles the reviewed OpenAPI schemas with Ajv (2020-12) and exposes operation metadata (permission, scope, required headers, input/response schema, list paging), route matching, typed field errors, the error-code to HTTP status map and the published state machines. Controllers in P02-03 must use it rather than restating payload shapes.

## Verification

- `scripts/test-p02-schema.mjs` (also part of `scripts/ci-database.mjs` for the fresh and upgrade databases): 15 groups against real PostgreSQL covering seeds, owner and runtime RLS isolation, revocation versions, roles, approval policies, decisions, evidence, tasks, obligations, party invariants, activation gates, the audit chain, receipts/outbox/inbox/jobs and the audit reader. Test tenants are removed afterwards.
- `tests/contracts.test.mjs`: every operation has a published permission and compilable schemas; P02 header conventions; route matching; input/response validation; request examples; state machine helper.
- `scripts/test-foundation-db.mjs` fresh, upgrade, no-op and checksum paths; `scripts/test-restore.mjs` snapshot includes the new tables.
- Applied to the engineering Supabase database on 19 September 2026 (PostgreSQL 17.6). CI runs the same migration on PostgreSQL 18.

## P02-02 domain and rules

`@lara/domain` implements the P02 state and calculation rules over the schema, in plain ESM modules the API and worker share:

- `core`: typed `DomainError` with the contract status map, canonical content hashing, tenant-bound transactions with serialization retry, the idempotent command envelope (receipt reserved and finalized in the same transaction; replay returns the committed response; a different request on the same key is `IDEMPOTENCY_CONFLICT`), audit and outbox writers, cursor paging.
- `identity`: principal resolution by OIDC issuer/subject, actor context (permissions from approved roles through active memberships and delegations; entity scope), roles with versioned re-approval, memberships and revocation, and `assertJobStillAuthorized` comparing a job's stored revocation version with the principal's current one (CORE-14).
- `organization`: tenant provisioning, entities with material-change detection (content version and hash), activation blockers (legal name, PHP, fiscal year, time zone, one active branch, an independent controller, live-tenant profile and onboarding gates), request/approve activation as separate principals binding the content version, branches, settings versions approved by hash with supersession, capability activation with evidence and independent approval.
- `parties`: AES-256-GCM field encryption for tax identifiers with masked display, identity-status rules without dummy identifiers, one identity task per party, additive roles, normalized search and reviewed merge as an archived alias link.
- `evidence`: register (quarantine, tenant-private object key), complete (checksum, size and sniffed type must match; mismatches persist as `rejected` and store nothing), scan job and scan outcome through `Scanner`/`EvidenceStore` adapters, content streaming only for available evidence.
- `workflow`: tasks deduplicated per source/kind/cause, assignment and waiting states, resolution that links evidence and passes the related onboarding check, comments, obligations instantiated once per kind/period/profile with retained completion, and the shared approval request/decision engine.

Verification: `scripts/test-p02-domain.mjs` (10 groups against real PostgreSQL through the runtime role, also in CI for fresh and upgrade databases) covers P02-T01 isolation, P02-T02 revocation of a queued export, P02-T03 settings approval binding, P02-T04 single task per check resolved with evidence, P02-T05 checksum/executable/infected rejection, entity activation maker-checker, party rules and merge, obligations and command replay. `tests/domain.test.mjs` covers hashing, error translation, paging, type sniffing and field encryption.

Architecture note: ADR 001 names NestJS and Vitest; P00 and P01 shipped a plain Node HTTP API with `node:test`, and P02 follows the shipped code. Adopting the framework is a separate decision for the owner, not something to change mid-phase.

## P02-03 API, jobs and adapters

The `/v1` surface in `apps/api/src/workspace-api.mjs` routes every request through the reviewed contract (`findOperation`), so unknown paths are 404 and operations of later phases answer `FEATURE_NOT_ENABLED`. The tenant comes from `lara.principal_directory` (migration 0010: an issuer/subject → tenant map maintained by trigger), never from the body; accounts in several tenants name one with `X-Tenant-Id`. Header conventions are enforced from the contract: `X-Entity-Id` for entity scope (out-of-scope entities read as not found), `Idempotency-Key` for POST (428 when missing), `If-Match` for PATCH and `{id}` actions (428/412 with `resourceVersion`), ETag on resources. Bodies are validated with `@lara/contracts` into typed field errors. Commands run through the domain envelope so replay is exact and a different request on the same key is 409. Per-principal token buckets return 429 with `Retry-After`; the limits are configuration (`RATE_LIMIT_*`). A connection pool serves `/v1`.

Evidence: `POST /evidence/uploads` registers the quarantined record and returns the local-stream upload URL; `PUT /v1/evidence/{id}/content` stages bytes; `POST /evidence/{id}/complete` verifies checksum, size and sniffed type (a mismatch commits the `rejected` state and returns 422) and queues the scan job; `GET /evidence/{id}/content` streams only available content to a current member. `POST /exports` queues a scoped job; `GET /jobs/{id}` and `GET /commands/{key}` answer within scope.

Worker (`apps/worker/src/main.mjs`): claims jobs with `SKIP LOCKED` under a 60 s lease renewed every 20 s, retries infrastructure failures at 1 s/5 s/30 s/2 m/10 m, dead-letters with an owned high-severity task, and treats authorization and rule failures as final. Handlers: `evidence.scan` (fixture scanner, disposal of infected content) and `export.tasks|masters|evidence_manifest` (revocation recheck through `assertJobStillAuthorized`, snapshot at the recorded cutoff, CSV or JSON, checksummed and stored as restricted evidence so downloads keep rechecking membership). Adapters: filesystem evidence store and fixture scanner for local/demo; production composition fails closed until the S3-compatible store and a real scanner are configured.

Verification: `scripts/test-p02-api.mjs` (in CI for fresh and upgrade databases) runs the API and worker as processes and covers session context, routing and gating, header conventions, idempotent replay and conflict, validation errors, cross-tenant isolation, two-principal activation, the full evidence path including a rejected checksum, tasks, exports with the revocation denial (CORE-14), command lookup and the 429 path on a low-limit instance. Unit tests cover the token bucket. `scripts/test-api-readiness.mjs` now derives the expected schema version from the migrations directory.

Not yet: approval-policy endpoints return `FEATURE_NOT_ENABLED` until the ledger approval routing (P03) consumes them; delegation has no endpoint in the reviewed contract; the S3 evidence store and a production scanner adapter are qualification items for release.

## P02-04 user journeys

Composition: pages render per request (`force-dynamic`) through `Composition`, which selects the synthetic `DemoWorkspace` only when `LARA_MODE=demo` and the production `Workspace` otherwise; the demo adapter is unreachable from a production composition. The BFF proxies `/api/v1/*` to the API with the signed identity, forwarding only the contract headers (`X-Entity-Id`, `X-Tenant-Id`, `Idempotency-Key`, `If-Match`, `Content-Type`) and passing back ETag, content type and disposition for downloads.

Screens (`apps/web/src/app/_components/workspace.tsx`): overview with activation state, counts and capability list; My work with owner/status/due filters in the URL, assignment from the entity's memberships and task detail (start, wait for information with a due date, resolve with available evidence, comments); parties directory with normalized search, role filter, create, detail edit with `If-Match`, masked tax identifier and archive; evidence upload (browser-side SHA-256, register, stream, complete) with status polling and authorized download; obligations calendar grouped by month with completion bound to available evidence; setup checklist (organization, branches, members and roles, activation request/approval) that resumes from server state; roadmap panels for modules of later releases; explicit forbidden, unknown-account, stale-version (draft kept, reload) and retry states. Every command reuses its idempotency key on retry.

Contract additions made under the P02 rule that screens may add read/list endpoints to the reviewed OpenAPI before implementation (owner review requested): `GET /evidence` (EvidenceResourceList, `status` filter) and declared list filters on `GET /tasks` (`ownerId`, `status`, `dueBefore`, `sourceId`), `GET /parties` (`q`, `role`, `status`), `GET /obligations` (`status`, `from`, `to`) plus the `state` selector on `PATCH /tasks/{id}`. The operations catalog and generated contract were regenerated (348 operations).

Operator provisioning: `scripts/provision-workspace-tenant.mjs` creates a tenant, its first principals (controller and security administrator must differ) and approved role templates so people can sign in and complete setup; it is also the CI fixture for the production-composition browser tests.

Verification: `tests/browser/workspace.spec.mjs` runs against `LARA_MODE=local` servers (API 4015, web 3016) provisioned by `scripts/test-demo-browser.mjs` locally and by `scripts/ci-database.mjs` in CI: setup checklist with the independent-controller blocker, membership grant, self-approval refusal and approval by another principal; party creation raising one identity task, controller assignment, evidence upload through scan, resolution with evidence, known identity masked; stale-version recovery between two users; obligations completion with evidence; forbidden, roadmap and unknown-account states; WCAG 2.1 A/AA scans at 1440 and 390 and keyboard reach. Findings fixed on the way: activation re-request collided with the approval-request unique key (migration 0011 makes it pending-only and requests idempotent), tenant-wide memberships were missing from entity listings, and editing a known party required re-entering its tax identifier.

Known gaps for the owner: no reviewed operation lists task comments (comments made in the session are shown; persisted ones are not listed), no invitation operation exists (principals are created by operator provisioning or by an existing tenant login), the audit view needs a reviewed read operation, and approval-policy screens wait for the routing that arrives with the ledger.

## P02-05 acceptance and operations

- Runbooks: `P02-RUNBOOK.md` covers start/stop/readiness, deploy/rollback, failed migration, queue replay and dead letter, restore, scope revocation, evidence scan failure, export failure, provider outage, module corrections and escalation, each with evidence to preserve and prohibited actions.
- Security negative matrix additions: cursors now bind tenant, entity and filter set (a cursor reused under another filter or with a forged scope is refused, `scripts/test-p02-api.mjs`); the identity check reports its rejection reason outside production and tolerates bounded clock skew on the upper bound (a 1 ms clock-read difference between the BFF and API processes rejected fresh tokens intermittently; `tests/identity.test.mjs`).
- Load: `scripts/test-p02-load.mjs` measures p50/p95/max and errors for reads, commands and a mixed profile through the HTTP API; CI asserts p95 under 2 s and command p95 under 1 s on its local database. Against the remote engineering database from a developer machine the run reports (concurrency 4): reads p95 1.47 s, commands p95 1.94 s, mixed p95 1.46 s, zero errors — network-bound, reported not asserted.
- Regression: the P00 and P01 suites (foundation, workflow, demo browser, accessibility) run unchanged alongside the P02 suites in CI for both fresh and upgrade databases; restore rehearsal covers all P02 tables.

## Open for later P02 tickets

- Outbox publication to consumers (notifications) is pending a consumer; events are written and published_at stays null until one exists.
- P02-06 release: RG-01–08 evidence record, per-profile activation decision and tagged deployment are owner actions; the first live activation additionally needs the S3-compatible evidence store and a production scanner adapter qualified, and the owner's review of the contract additions. Registration profile and retention policy tables are referenced by id but defined in their owning phases.
