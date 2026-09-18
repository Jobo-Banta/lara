# P03 General ledger and close

**Depends on:** P02. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Production PHP management books with manual journals, controlled source imports, periods, report snapshots and a complete supported close. No sales/AP control subledgers are falsely claimed before their modules.

## User flow and states

Draft journal → submit → independent approval → post. Original → reversal request → approval → new reversing entry. Period open → soft_closed → required reconciliation/substantiation complete → locked. Reopen, if allowed, creates a new close version and reports; old snapshot remains.

## Data and migration contract

Shared ledger tables plus account_dimension_rules(account_id,dimension_type,required), substantiations(period_id,account_id,preparer,reviewer,evidence_id,state), statement_mappings(account_id,statement,line_code,version), journal_templates(code,lines,effective_from), and source_control_balances(batch_id,control_account_id,detail_total). Import staged rows contain source key, account/date/debit/credit/branch/dimensions and evidence.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Enforce shared PostingService algorithm, not UI-only checks. Require leaf active account and mandatory dimensions. Openings must tie detail to control accounts, including AR/AP if imported from retained sources. Reject overlapping opening loads. Trial balance sums posted functional lines by approved date/cutoff. Balance sheet follows account category/mapping; income statement sums revenue/expense; retained earnings close transfers income/expense balances exactly once per fiscal year and records links. Basic report labels are management statements until applicable presentation/disclosures are approved. Manual schedule imports support accruals/depreciation; no hidden asset engine.

## Screens and interaction

Chart tree with cycle prevention; journal editor with running debit/credit difference and source preview; import staging/errors; general journal/ledger drill-down; trial balance/basic statements; close checklist and account support view; correction preview. Lock/adjustment actions show impact and reasons.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P03 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P03-T01: Execute balanced/unbalanced, period-race, immutable-write and retry cases CORE-01–09.
- P03-T02: Import openings twice; second command returns prior result; changed source hash conflicts.
- P03-T03: Trial balance and statements reconcile to lines before/after reversal; original report checksum unchanged.
- P03-T04: Attempt control-account manual journal and posting to frozen/inactive/nonleaf account; reject.
- P03-T05: Close year twice; one retained-earnings effect; new-year opening and prior-year snapshot consistent.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Add ledger/document/period tables and mandatory deferred balance enforcement. Existing P02 data preserved. Backfill no financial records automatically; create books/accounts through approved setup. Test old app compatibility during migration.

## Activation and release

Controller signs account mapping, openings, source ownership and close rehearsal. This is a scoped ledger capability; statutory CAS replacement requires P07 and all customer dependencies. Disable new posting for rollback; use forward correction for committed entries.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
