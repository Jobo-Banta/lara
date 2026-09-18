# P15 Intercompany and consolidation

**Depends on:** P09/P11. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Group reporting from approved entity snapshots, paired intercompany transactions, eliminations and translation. Consolidation creates a separate reporting book, never rewrites subsidiary ledgers.

## User flow and states

Define group ownership/reporting currency → approve entity mappings → paired intercompany drafts accepted per entity → post in each entity with tracked pair state → freeze entity closes → translate → propose eliminations → review → consolidated snapshot.

## Data and migration contract

groups(reporting_currency), group_members(entity,ownership_pct,effective_dates,method), group_account_mappings, intercompany_pairs(source_doc,target_doc,state,shared_reference), consolidation_runs(period,member_snapshot_ids,rate_set,state), elimination_entries(run_id,accounts,amount,reason,evidence), translation_adjustments(run_id,source,policy,amount).

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Cross-entity commands are a saga with separately authorized local transactions; no claim of atomic remote approval. Pair stays pending/exception until both sides reconcile; failed second side never silently rolls back issued first side. Full consolidation for controlled wholly-owned pilot entities first; partial ownership/equity-method requires an explicit approved extension before activation. Translate balance sheet at closing rates and income/expenses under approved period-average or transaction-rate policy; opening equity/historical reserves and translation reserve preserve approved basis. Never sum mixed currencies directly. Eliminations tie counterparties/references and show unresolved differences; no blanket elimination to force balance.

## Screens and interaction

Group setup and mapping; pair exceptions; member-close readiness; translation/rate preview; elimination worksheet; consolidated statements with member/elimination drill-down.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P15 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P15-T01: Two-entity balanced fixture consolidates and eliminates reciprocal AR/AP and revenue/expense once.
- P15-T02: Missing second-side approval remains exception; no fabricated journal.
- P15-T03: FX translation difference recorded in approved reserve account with traceable rate.
- P15-T04: Rerun same member snapshots yields same result/hash; new snapshot creates new version.
- P15-T05: Group reviewer cannot mutate subsidiary books without separate entity authority.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Create group reporting schema and scoped permissions, retain entity keys. Existing interbranch roll-up is not converted to intercompany. No ownership assumptions for prior periods.

## Activation and release

Controller approves ownership/method, mappings, rate policies and complete statement presentation. Unsupported minority/equity method blocks that member. Rollback leaves subsidiaries unchanged; supersede group snapshots.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
