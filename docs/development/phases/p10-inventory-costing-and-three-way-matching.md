# P10 Inventory costing and three way matching

**Depends on:** P06; P09 for FX items. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Perpetual inventory for supported trading goods: warehouses, receipts/issues/transfers, valuation, count, batch/serial and landed cost with complete stock-to-ledger reconciliation.

## User flow and states

PO → receive goods → value receipt → match supplier invoice/receipt/PO → approved variance → post. Issue/sale consumes valuation layers; transfer preserves value. Count freeze/cutoff → observed quantity → review variance → adjustment. Landed cost allocates approved charges to receipts and remaining/sold quantities.

## Data and migration contract

items(sku,uom,stock_account,cogs_account,cost_method,tracking), warehouses(code,branch), stock_movements(item,warehouse,type,qty,date,source_doc), valuation_layers(receipt_id,qty_remaining,unit_cost,currency), stock_allocations(issue_id,layer_id,qty,cost), count_sessions/lines(expected,observed), lot_serials, landed_cost_runs(method,charge,allocations), and goods_receipts/lines.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Item/entity cost method FIFO or moving weighted average, selected before first movement. No negative stock in initial production profile. FIFO consumes oldest received layer ordered effective date then immutable receipt ID; weighted average recalculates after each receipt including approved costs, with residual carried to final issue. Lock item/warehouse aggregates in sorted order. Backdated movements before a closed inventory period blocked; open-period backdating requires deterministic recost preview and linked adjustment for affected issues, not silent rewriting. Transfer conserves quantity/value and recognizes no profit. Count variance posts stock gain/loss with independent approval. Landed cost allocate by value/quantity/weight approved method; round residual deterministically; sold portion to COGS, remaining to inventory. Three-way tolerances never waive missing mandated receipt evidence.

## Screens and interaction

Stock card, movement and valuation layers; receipt/matching workbench; count entry/review; landed-cost preview; inventory book and year-end export; stock/GL differences with source links.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P10 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P10-T01: AC-09 plus two-layer FIFO, weighted average and partial return cases.
- P10-T02: Concurrent issues cannot consume same stock or produce negative quantity.
- P10-T03: Transfer total value conserved; serial cannot exist in two warehouses.
- P10-T04: Count/landed cost journals reconcile to valuation and control account exactly.
- P10-T05: Backdated open-period receipt triggers approved recost; locked period rejects.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Opening stock import requires quantity/value per item/location and reconciled GL opening; source inventory ownership transfers at cutoff. Cost method changes after activity are blocked absent a separately reviewed conversion.

## Activation and release

Controller signs costing method, unit conversions, cutoff, negative-stock policy and opening count. Goods profiles cannot be enabled until stock/GL/AR/AP and applicable inventory outputs pass. Rollback stops movements, not valuation evidence.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
