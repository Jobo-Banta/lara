# P14 Accounting firm multi client workspace

**Depends on:** P07/P13. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Firm users can operate explicitly delegated client scopes through one login, with assignments, deadlines and readiness views. Client books and permissions remain isolated.

## User flow and states

Firm organization → client invitation/delegation → authorized staff assignment → explicit client context → task/action → client audit record. Revoke client mandate → invalidate staff/session/jobs and hide aggregates.

## Data and migration contract

firms(name,owner), firm_staff(principal,role,status), client_mandates(firm,tenant,entity,permissions,valid_from/to,approver,state), client_assignments(mandate,staff,scope), aggregate_snapshots(firm,actor,scope_hash,as_of,counts). Cross-tenant references live in a restricted authorization service, not unrestricted financial joins.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Firm identity does not automatically access clients. Resolve each mandate then execute client-scoped queries; aggregate only permitted counts/amounts and label currency/entity. No client financial data in global caches without scope/revocation keys. Bulk operation fan-out creates separate per-client commands and approvals; no implicit cross-company posting. Maker-checker applies within each client, including firm staff. Billing/commercial firm plan is configurable metadata, not accounting authorization.

## Screens and interaction

Client switcher with persistent context; assigned-client list; deadline/exception roll-up; staff assignment and mandate evidence; client-scoped deep links. Never show combined unlabeled monetary totals across currencies.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P14 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P14-T01: Remove one mandate and immediately invalidate cached counts/exports for that client.
- P14-T02: User assigned client A only cannot search/client-switch to B.
- P14-T03: Bulk reminder/action produces independent per-client outcomes without data leakage.
- P14-T04: Same user maker/approver through firm and direct membership remains prohibited.
- P14-T05: Different currency aggregates remain separated and traceable.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Add firm authorization records; existing tenant memberships unchanged until client accepts a mandate. No automatic affiliation inferred from domains/emails.

## Activation and release

Each client signs permission/expiry boundaries; security adversarial tests cover counts and cross-client jobs. Rollback disables aggregation but preserves each valid direct client scope.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
