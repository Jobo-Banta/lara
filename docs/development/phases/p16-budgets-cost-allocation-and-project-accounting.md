# P16 Budgets cost allocation and project accounting

**Depends on:** P10/P11. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Budget control, cost allocation, project revenue/cost views and progress/retention billing tied to normal documents. This is not a manufacturing or full construction scheduling system.

## User flow and states

Budget version draft → review → activate; requisition/PO reserves commitment → bill consumes → cancellation releases. Allocation run previews source pools/drivers → approval → entries. Project contract → approved milestone/progress → billing with advance recoupment/retention → release retention when evidenced.

## Data and migration contract

budgets(period,version,currency,status), budget_lines(account,dimension,amount), commitments(source,amount,state), allocation_rules(source_filter,drivers,targets,effective_dates), allocation_runs(source_cutoff,rule_version,lines,entry_ids), projects(code,customer,contract_value,currency,status), milestones(project,amount,certified_value,evidence), retention_items(invoice,rate,held,released,due_condition), project_contract_versions.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Availability = approved budget − actual eligible spend − open commitments, with no double counting when a PO becomes a bill. Lock budget bucket during reservation; warn/block policy and authorized override retained. Allocation driver total must be positive; allocated rounded amounts sum exactly to source pool, residual to stable target ordering. Project billing cannot exceed approved certified/billable amount except reviewed change order. Retention separates due-now AR and retention receivable using approved account mapping; advance recoupment consumes documented advances, not revenue twice. Profitability uses posted cost/revenue with clear work-in-progress exclusions.

## Screens and interaction

Budget vs actual/commitment drill-down; approval override; allocation preview/differences; project contract/milestones, progress billing and retention aging/release.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P16 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P16-T01: Two simultaneous commitments cannot overspend blocking budget.
- P16-T02: PO→bill conversion consumes commitment without double counting.
- P16-T03: Allocation residual preserves exact pool and no duplicate rerun.
- P16-T04: Progress invoice recoups advance/holds retention and release settles correct control account.
- P16-T05: Change order version and approval visible; past billing unchanged.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Initialize budgets and project openings through reviewed imports with no retroactive automatic reservations. Tag historical transactions only through approved reporting dimensions without modifying posted facts.

## Activation and release

Finance approves budget basis, drivers, project accounting/retention profiles and contract evidence. Rollback stops new reservations/runs, reconciles existing commitments; posted project documents remain.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
