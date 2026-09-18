# P17 Local operations feature releases

**Depends on:** P07/P09/P11/P16 as specified. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Independently shipped P17A leases, P17B statutory discounts, P17C marketplace/POS, P17D payroll remittance/import and P17E local obligations. Complete each enabled feature; the phase is not complete until its selected feature releases pass.

## User flow and states

Each feature captures source once, validates profile/evidence, independently approves consequential effects, posts through shared services, reconciles and exports evidence. No separate posting engine or agent per industry.

## Data and migration contract

P17A lease_contracts(party,term_start/end,deposit,advance,escalation_json,withholding_profile), lease_events; P17B discount_eligibility(party,category,evidence,expiry) and discount_lines(document,basis,rate,exemption_profile); P17C payout_batches(channel,source_id,gross,fees,withholding,net), pos_closings(machine,shift,readings); P17D payroll_batches(source,period,counts,totals,hash), employee_tax_records(restricted), remittance_records(agency,period,amount,evidence); P17E local_obligations(authority,kind,property_ref?,due,amount,evidence).

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

P17A covers lessor billing, deposits, advances, escalation and approved tax treatment; deposits remain liabilities until approved application/refund. Lessee right-of-use/liability measurement requires an approved accounting profile and golden schedule before enabling that distinct feature; it is not inferred from recurring rent. P17B profile determines category/eligible goods/services/base/discount/exemption and required identity evidence; rates never hard-coded globally, no unauthorized ID exposure. P17C gross sales minus fees minus withholding/other explicit deductions equals payout; reconcile to imported sales to avoid reposting revenue. POS X/Z closure references unique machine/shift and match deposits. P17D imports payroll journals and required 2316/1601-C/SSS/PhilHealth/Pag-IBIG data with restricted permissions, reconciles source totals, does not calculate full payroll. P17E deadlines/amounts follow reviewed local authority profile; payment is standard AP/treasury evidence, not automatic government filing.

## Screens and interaction

Feature-specific contract/eligibility/payout/payroll/import screens reuse document review, tasks, calendar and evidence; identity fields masked by role. Each feature displays its authoritative source and unsupported variants.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P17 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P17-T01: P17A escalation boundary and deposit application do not recognize revenue twice; schedule sums correctly.
- P17-T02: P17B eligible/ineligible, expired evidence and mixed lines follow approved golden cases.
- P17-T03: P17C gross-to-net reconciliation explains every fee/tax; replay never duplicates sale/payout.
- P17-T04: P17D payroll/employee tax totals tie and unauthorized user cannot view individual data.
- P17-T05: P17E complete obligation requires payment/filing evidence applicable to that authority.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Each feature has its own additive migration and entitlement, source mapping version and opening import. No catch-all JSON posting from external channels. Existing source-owner boundaries transferred only at signed cutoff.

## Activation and release

Per-feature authority/provider/accounting examples and source formats reviewed before activation. Without these, existing product still ships; unsupported feature remains disabled and not marked done. Rollback pauses only affected adapter/scheduler and reconciles pending effects.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
