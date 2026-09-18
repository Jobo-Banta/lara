# P11 Assets recurring work and recognition schedules

**Depends on:** P03/P05; P09 for FX. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Asset register/lifecycle and deterministic schedules for depreciation, prepayments, deferred revenue, recurring draft invoices/journals and employee deductions. Distinct accounting semantics share execution infrastructure.

## User flow and states

Capitalization draft from bill/CIP → approve asset and in-service date → schedule preview → approve → monthly execution → reconcile. Transfer/split/merge/disposal/impairment creates approved linked event. Schedule modification creates prospective version; prior postings remain immutable.

## Data and migration contract

assets(tag,class,cost,residual,useful_life_months,in_service_date,location,custodian,status), asset_components(parent_id,cost,life), asset_events(kind,effective_date,amount,source), recognition_schedules(kind,basis,start,end,method,policy_version,state), schedule_lines(period,amount,account_mapping,posted_entry_id), schedule_versions, and book_tax_layers(asset,book_value,tax_value,rule_version).

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Initial depreciation convention monthly from in-service month, no partial-month proration unless approved policy explicitly selects daily actual/actual. Straight-line amount=(cost−residual)/months, rounded each period with final residual adjustment. Declining balance applies approved rate to opening carrying amount, floored at residual; sum-of-years uses approved annual weights then documented monthly allocation. Useful life/method changes prospective from approved effective period, no rewrite. Disposal removes cost/accumulated depreciation and recognizes proceeds difference. Split/merge conserves total gross cost and accumulated depreciation. CIP depreciates only after in-service transfer. Prepayment/deferred revenue schedules allocate recognition over approved service periods. Jobs create drafts or use approved deterministic schedule authority; AI never posts. Unique schedule/version/period prevents rerun duplicates.

## Screens and interaction

Asset register/detail, schedule preview, depreciation run/review, capitalization/CIP, disposal calculation, book/tax comparison; recurring work calendar and failed period tasks.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P11 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P11-T01: AC-08 plus residual/final-month, method-change and leap-year daily policy cases.
- P11-T02: Duplicate schedule run posts once and locked period creates task instead of bypass.
- P11-T03: Split/merge cost and depreciation conserved; disposal gain/loss correct.
- P11-T04: Deferred revenue schedule total equals contract amount with final rounding residue.
- P11-T05: Book/tax schedule versions reconcile independently and changes are reproducible.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Import reconciled cost/accumulated depreciation/remaining-life per asset and disable overlapping retained-source schedule ownership. No automatic catch-up posting during migration.

## Activation and release

Controller approves asset classes, recognition methods, opening register, impairment/revaluation journals and disclosure/report boundary. Scheduled posting authority is explicit and revocable; all generated entries remain traceable. Rollback pauses scheduler and reconciles its last committed period.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
