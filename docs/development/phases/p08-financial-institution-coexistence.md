# P08 Financial institution coexistence

**Depends on:** P07. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

A specific signed bank/FI pilot with canonical source journal and balance feeds, account mappings, branch roll-up and applicable GRT/final withholding/DST. Core banking, valuation, lending and ECL calculations remain in named authoritative systems.

## User flow and states

Source file/API batch → authenticate/checksum/control totals → stage rows → mapping validation → approve → post once → reconcile source balances and tax events → branch/entity close. Missing source batch creates blocking task. Corrected source batch is a linked reversal/replacement, not overwrite.

## Data and migration contract

source_systems(code,owner,granularity,cutoff_timezone), source_ownership, source_batches/rows, mapping_versions(source_account,target_account,dimensions,tax_profile), expected_batches(source,period,deadline), source_balance_snapshots(account,currency,balance,cutoff), tax_instrument_facts(instrument_ref,type,maturity,amount,income_category,event_date), and branch_rollups with reconciliation manifests.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Canonical journal feed columns: external_batch_id, external_line_id, accounting_date, book_code, branch_code, account_code, currency, debit, credit, source_document_ref, dimensions, tax_event_ref optional. Manifest includes count, debit/credit totals, currency totals and SHA-256. Reject partial commit of a declared atomic batch. Summarized posting requires durable underlying detail reference and control totals. Tax profiles classify bank income/instrument facts through reviewed effective rules; no inferred universal VAT/GRT treatment. Due-to/due-from interbranch pairs reconcile, with asymmetric batch timing visible. Separate currencies/FCDU/trust required by pilot block activation until P09 or remain completely outside LARA ownership with verified interfaces.

## Screens and interaction

Source ownership matrix; batch monitor/error workbench; mapping diff preview; branch reconciliation and missing-feed dashboard; institution tax worksheet with instrument/source drill-through; read-only examiner scope.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P08 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P08-T01: Duplicate batch 100 times yields one journal; same ID changed checksum conflicts.
- P08-T02: Missing or late batch blocks affected close, not unrelated entity.
- P08-T03: Source detail/control totals mismatch cannot be approved silently.
- P08-T04: Interbranch pair appears in branch books and cancels in entity roll-up without cross-entity consolidation.
- P08-T05: Each enabled GRT/DST/final withholding rule has advisor-signed boundary-date/maturity golden cases.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Add canonical feed and rule fact tables; require effective source ownership before ingestion. Transition from manual imports at documented cutoff; detect duplicate source ranges across both routes.

## Activation and release

Named design partner signs entity/books/currency/tax/feed matrix and representative parallel month. Required FX/separate-book obligations pull in P09. Reuse bank adapters only after measured volume/recovery tests. No universal-bank replacement claim. Rollback stops source acceptance at a durable watermark and reconciles any in-flight batch.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
