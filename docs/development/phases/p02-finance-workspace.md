# P02 Finance workspace

**Depends on:** P01. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

A production work and evidence workspace with organization setup, parties, access, approvals, tasks and obligations. No financial posting is enabled yet.

## User flow and states

Organization draft → validate → independently approve activation; invite user → accept OIDC invitation → scoped membership. Party draft → identity/evidence checks → active. Upload → quarantine → scan → available. Task open → assigned/in_progress → resolved, or waiting_for_information with owner and due date retained.

## Data and migration contract

Use organization/security tables in the shared data contract. Add settings_versions(entity_id,kind,version,payload_hash,approved_by,effective_at), delegation(principal_id,delegate_id,permission_scope,valid_from,valid_to,approved_by), and onboarding_checks(entity_id,check_code,status,evidence_id). Membership changes increment revocation version. No cross-entity bank-account or branch FK.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Setup requires legal name, base currency PHP, fiscal-year start, timezone, at least one branch and an independent controller. Tax/permit fields may remain pending while only workspace capability is active. Validate identity applicability without filling fake TINs. Party merge is a reviewed alias/link operation, never destructive replacement of posted snapshots. One identity can have roles but AR/AP balances never net automatically. Obligations instantiate from versioned templates; changes preserve prior completion evidence.

## Screens and interaction

Settings setup wizard with resume; company/branch/party lists and detail; membership and approval policy screens; My work with filtered owner/due/status views; evidence preview and comments; obligation calendar. Audit view shows actor, action, time and evidence. Display missing activation blockers next to each capability.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P02 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P02-T01: Create a second tenant and prove all API/search/evidence/count surfaces isolated (CORE-08).
- P02-T02: Change a membership and deny an already queued export after revocation (CORE-14).
- P02-T03: Approve an unchanged settings version using another principal; material change invalidates it.
- P02-T04: Resolve a missing-evidence task and update related checks without duplicate tasks.
- P02-T05: Upload mismatched checksum, executable disguised as PDF and infected fixture; none becomes available.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Create tenant-owned tables, composite scoped FKs, RLS and immutable audit. Seed only permission definitions and role templates; no live tenant/party/rule data. Existing demo data remains in its own database.

## Activation and release

Workspace owner accepts roles, object-storage scanning, retention policy and audit export. Financial capabilities remain disabled. Rollback disables workspace writes but preserves evidence/read access.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
