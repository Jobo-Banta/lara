# P14 implementation review — 21 September 2026

P14 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain and authorization rules), 3 (API), 4 (user journeys) and 5 (acceptance and operations) are implemented; no `firm_workspace` capability is activated for a live client and no firm operates a real client.

## P14-01 contracts and migration

Contracts: the 10 P14 operations (`/firm-mandates` create/list/get/edit/approve/revoke, `/firm-assignments` create/list/get/edit) and their schemas were already in the reviewed OpenAPI; the `firm_mandate.*` and `firm_assignment.*` permissions and the `firm_workspace` capability (depends on `compliance`) were seeded by `0009`. Under the phase rule that screens may add read/list and versioned-mutation operations, eight tenant-scoped operations were added and the catalog regenerated (402 operations): `POST /firms` and `GET /firms` (the firm record in its own organization), `POST /firms/{id}/staff` and `GET /firms/{id}/staff`, `GET /firm/clients` (the caller's delegated scopes), `GET /firm/rollup` (the deadline and exception roll-up per client scope), `GET /firm/snapshots` and `POST /firm/bulk-reminders` (per-client fan-out). `validate_specifications` passes.

Migration `0029_p14_firm_workspace.sql`:

- `firms` (one per organization, owner, commercial plan metadata) and `firm_staff` (partner | manager | staff, one row per principal) in the firm's tenant.
- `client_mandates` in the client tenant (firm id and snapshotted name, entity ids, permissions, validity within the row, evidence, draft → approved → revoked | expired; approver ≠ drafter; one live mandate per firm; an approved mandate never widens) and `client_assignments` (the delegated principal in the client tenant bound to one mandate with an entity and permission subset; active | revoked).
- `aggregate_snapshots` in the firm tenant keyed by actor, scope hash and mandate.
- Restricted authorization functions (SECURITY DEFINER, executable by the API role only): `firm_scopes(issuer, subject)` resolves the caller's own identity to its active assignments under approved, unexpired mandates across client tenants; `firm_aggregate(issuer, subject, tenant, entity)` computes counts and per-currency open items only for a scope the identity holds and only with the reads it carries; `firm_invalidate_snapshots(mandate)` deletes the firm's snapshots for a mandate of the current (client) tenant; `firm_identity(firm, principal)` and `firm_lookup(firm)` give a client the minimum it needs to seat a delegate.
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api`.

Verification: `scripts/test-p14-schema.mjs` (4 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the five new tables.

## P14-02 domain and authorization rules

`packages/domain/src/firm.mjs` with the delegated scope in `identity.actorContext`:

- Firm registration (one per organization) and staff enrolment by the owner or a partner; a firm identity reaches no client by itself.
- Mandates are granted inside the client by its own principals (a delegate never grants, edits, approves or revokes one): the firm resolved by id through the restricted lookup, permissions checked against the definitions with security, membership, activation, mandate and tool-grant authorities never delegable, entities within the granter's scope, expiry within a year, evidence available; approval by a second principal seats the firm owner as the first delegate with the full mandate; an approved mandate never widens.
- Assignments are made in the client by a delegate holding `firm_assignment.create` under its own mandate for the firm's active staff, as a subset of the mandate's permissions and entities; the delegated principal is the staff member's identity resolved in the client tenant — one principal per identity, so a direct member and a delegate are the same principal and maker-checker holds either way (P14-T04).
- `identity.actorContext` gives a principal without membership or portal scope the delegated scope of its active assignment under an approved, unexpired mandate: the subset the mandate still carries and the mandate's entities; a direct member keeps its membership (P14-T02).
- Client scopes and the roll-up come from `firm_scopes` and `firm_aggregate` for the caller's own identity; the roll-up returns one labelled row per client scope with its counts and open items per currency, never a combined total, and snapshots each row under its mandate (P14-T05). Bulk reminders fan out per client in their own savepoints under the delegate's identity and tenant, drafting a reminder for each overdue customer and reporting an independent outcome per client (P14-T03).
- Revocation ends every assignment, bumps the delegates' revocation version (sessions and queued jobs fail their recheck), deletes the firm's snapshots for the mandate across tenants and drops the client from every scope list (P14-T01).

Verification: `scripts/test-p14-domain.mjs` (7 groups) covers P14-T01–T05.

## P14-03 API

All 10 operations plus the eight additions are served by `apps/api/src/workspace-api.mjs`; the client context is the `X-Tenant-Id` header the existing multi-tenant resolution already binds to committed identities.

Verification: `scripts/test-p14-api.mjs` (4 groups, API as a process, in CI): the firm and staff over HTTP, a mandate granted, approved and listed, the partner's client scopes and roll-up, the client context header, an assignment and the staff member's fenced scope, revocation, 404s and later-phase gates.

## P14-04 user journeys

`apps/web/src/app/_components/workspace-firm.tsx`: `/firm` in the firm's organization (the firm record and staff, the assigned-client list with the client switcher, the roll-up labelled by entity and currency, bulk reminders with per-client outcomes) and `/firm/mandates` in a client (mandates drafted, approved and revoked; assignments by the delegate). The client context is carried on every call by the workspace kit and shown in the header with a way to leave it. The capabilities screen offers the activation; the navigation gained the Group placeholder (P15).

Verification: `tests/browser/workspace.spec.mjs` firm journey on the production composition — a firm registered by the partner in its own organization, a mandate drafted by the client preparer on the engagement letter and approved by the controller, the client appearing in the partner's assigned-client list and roll-up, the client opened with the explicit context, the revocation ending it, WCAG checks (also in CI).

## P14-05 acceptance and operations

Acceptance: P14-T01–T05 in `scripts/test-p14-domain.mjs` and `scripts/test-p14-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P14-RUNBOOK.md` covers activation gates, working in a client, the roll-up and bulk actions, revocation and the rollback rule (revoke mandates; direct memberships untouched).

## Open items for the owner

- No seeded role template holds `firm_mandate.create/edit/revoke` or `firm_assignment.create`; clients and firms create the relations and partner roles (tests and the journey do).
- Firm staff are enrolled by principal id; a directory picker arrives with the firm plan's commercial metadata.
- The roll-up counts tasks, obligations, periods and open items; deadlines from the compliance calendar per client are the next increment.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
