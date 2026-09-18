# P09 Multiple currencies and separate books

**Depends on:** P08. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Transaction/functional currency accounting with controlled rates, realized/unrealized FX and separately permissioned book partitions, including approved RBU/FCDU/trust source boundaries. It does not implement investment/loan/trust instrument engines.

## User flow and states

Approve rate version → enter foreign-currency document → snapshot conversion → post both amounts → settle at approved rate → post realized FX. Period-end revaluation preview → approve → post once → optional next-period reversal. Separate books → reconciled management combination, distinct from group consolidation.

## Data and migration contract

fx_rates, currency_metadata(code,minor_units), revaluation_runs(book_id,period,rate_set,method,state,entry_ids), fx_open_item_layers(open_item_id,txn_remaining,func_carrying), book_links(source_book,target_view,translation_policy), and book_access. Each journal records one transaction currency and one functional currency; translated adjustments use functional amounts with explicit purpose.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Store original functional carrying value and remaining transaction currency per open item. Partial settlement consumes proportional carrying value with final allocation absorbing rounding. Realized gain/loss is functional cash equivalent minus consumed carrying value with sign by AR/AP direction. Revalue eligible monetary open balances at approved closing rate; difference posts to unrealized FX account, tied to rate set and prior carrying amount. Never revalue all asset/equity accounts blindly. Missing rate blocks, not defaults to 1. Functional-currency change is a separately reviewed migration, not a settings edit. Trust and institutional books cannot mix postings; combined management view labels basis and exclusions.

## Screens and interaction

Rate import/review; transaction and functional side-by-side values; revaluation preview/difference; book selector and access; source/account reconciliation per book.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P09 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P09-T01: AC-10 and partial settlement leave exact remaining foreign/functional balances.
- P09-T02: Run same revaluation twice and get one effect; new rate set requires linked adjustment.
- P09-T03: Unavailable rate, inverted pair mistake and unauthorized book access rejected.
- P09-T04: Reversal retains original rate and amounts; not recalculated at today’s rate.
- P09-T05: RBU/FCDU/trust partitions reconcile independently and combined view does not double count.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Backfill original P03–P08 entries with transaction=functional PHP and rate=1 reference; never change posted values. Add FX fields/constraints additively; verify totals before enabling non-PHP.

## Activation and release

Controller approves monetary-account classification, FX sources, functional currencies, book boundaries and tax/report interactions. Required separate-book reports tested. Rollback disables new FX activity but retains native-currency history/report access.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
