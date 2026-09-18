# P04 Sales invoicing and receivables

**Depends on:** P03. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Complete service invoicing and collections for the enabled PHP tax profile, including advances, credits, aging and delivery evidence. Tax computation kernel ships here as a dependency; official reporting-required profiles stay blocked until P07.

## User flow and states

Direct invoice or approved quotation/order → draft → validate → submit/approve where policy requires → issue/post once → deliver → allocate receipts → settled. Quote/order conversion uses immutable source link and remaining billable quantity/value. Credit references original and reverses only eligible amounts. Customer advance is separately posted and later applied.

## Data and migration contract

documents/lines/relations, series/number_events, open_items, settlements/allocations, tax_rule_versions/events, plus payment_terms(id,installments_json), credit_limits(party_id,currency,limit,policy_version), deliveries(document_id,recipient_hash,template_version,state,provider_reference), party_snapshot(document_id,immutable_json). Tax fields are server-computed snapshots. Due schedule stores amount/date per installment; sum equals receivable.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Tax kernel supports percentage-of-approved-base VAT/zero/exempt and withholding classification through approved versioned profiles. For exclusive price: line net = round(quantity×unit_price−discount, currency scale); tax = round(net×rate, scale); gross=net+tax. Inclusive price: gross=round(quantity×unit_price−discount); net=round(gross/(1+rate)); tax=gross−net. Mixed lines summed, never classify by header alone. Profile selects line or document rounding; document method allocates residual by largest fractional remainder then line number. No live profile without signed examples. Credit limit uses open posted AR plus reserved approved orders; override independently approved. Apply payments with ordered locks, no negative outstanding. Reprints preserve number and snapshot. Buyer delivery does not imply reporting acceptance.

## Screens and interaction

Invoice list/editor/timeline, optional quotations/orders, customer aging and statement, credit preview, advances and allocation workbench. Four statuses always separate. Payment links, recurring subscriptions, statutory discounts and portals are later disabled capabilities.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P04 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P04-T01: AC-01/02/05/06 exact postings and open balances; input totals cannot override server tax.
- P04-T02: Concurrent issuance yields unique numbers; crash/retry allocates once and explains unused numbers.
- P04-T03: Credit more than eligible original or allocate same receipt twice fails.
- P04-T04: Mixed inclusive/exclusive lines follow profile golden rounding cases, including 0.01 residual.
- P04-T05: Reporting-required customer attempts activation before P07; blocked despite working invoice demo.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Add sales/tax kernel tables and approved profile registry with draft-only reference fixtures. Never activate sample rates in a live tenant. Backfill existing parties with customer role only through explicit onboarding.

## Activation and release

Advisor/controller approves invoice profile, templates, series, tax examples and customer eligibility; required external authorizations and reporting adapter must exist. Delivery adapter qualified. Rollback halts new issuance but keeps copies/corrections/evidence available.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
