# P02 implementation review — 19 September 2026

P02 is in progress, not released. Only the first build-order step (typed contracts, SQL migrations and permission/capability definitions) is implemented. No P02 screen, controller or job exists yet, and nothing in this phase is activated for any tenant.

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

## Open for later P02 tickets

- P02-02: domain services for the state and calculation rules (content hash and content version management, approval routing, party merge, obligation instantiation from versioned templates), with real transaction tests.
- P02-03: `/v1` controllers using `@lara/contracts`, idempotent command receipts, outbox publication, evidence upload/scan adapter and export jobs with revocation rechecks.
- P02-04: the workspace UI journey; P02-05 acceptance, runbooks and load; P02-06 release. Registration profile and retention policy tables are referenced by id but defined in their owning phases.
