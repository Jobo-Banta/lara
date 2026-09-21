# P10 implementation review — 20 September 2026

P10 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain and costing rules), 3 (API and jobs), 4 (user journeys) and 5 (acceptance and operations) are implemented; no `inventory` capability is activated for a live entity, no opening stock is imported outside test tenants and no goods profile is enabled for a customer.

## P10-01 contracts and migration

Contracts: the 24 P10 operations (`/items` create/list/get/edit, `/stock-movements` create/list/get/edit/submit/approve/post, `/stock-counts` create/list/get/edit/approve/post, `/landed-costs` create/list/get/edit/preview/approve/post) and their schemas were already in the reviewed OpenAPI; the `item.*`, `stock_movement.*`, `stock_count.*` and `landed_cost.*` permissions and the `inventory` capability (depends on `treasury`) were seeded by `0009`. Under the phase rule that screens may add read/list operations, six reads were added and the catalog regenerated (375 operations): `GET /warehouses`, `GET /stock-card` (`itemId`, `warehouseId`), `GET /inventory-valuation` (`bookId`, `asOf`), `GET /stock-movements/{id}/recost`, `GET /stock-counts/{id}/lines` and `GET /landed-costs/{id}/lines`. `validate_specifications` passes.

Migration `0025_p10_inventory_schema.sql`:

- `warehouses` (code unique per entity, branch) and `items` (SKU unique per entity, unit, cost method `fifo | moving_average`, tracking `none | batch | serial`, distinct stock and cost of sales accounts).
- `stock_movements` (receipt | issue | transfer | return | adjustment; draft → submitted → approved → posted | rejected; approver ≠ preparer; transfers name a different destination; content frozen once submitted and immutable once posted; recost entry and preview) and `stock_movement_lines` (positive quantity, unit cost on receipts, lot or serial, posted cost; frozen once submitted).
- `stock_balances` (one row per item and warehouse, quantity ≥ 0 at the database, no value without quantity), `valuation_layers` (one per receipt line with received and remaining quantities, unit cost to twelve decimals, effective date and sequence; identity immutable) and append-only `stock_allocations`.
- `lot_serials` (unique per item and code; a serial is one unit in one warehouse).
- `count_sessions` (draft → approved → posted | rejected; approver ≠ counter; frozen once approved; posted only with the adjustment movement) and `count_lines` (one per item, expected quantity frozen at creation, observed quantity, variance value).
- `landed_cost_runs` (one per charge document while not rejected; draft → previewed → approved → posted; approver ≠ preparer; frozen once approved; posted only with the entry) and append-only `landed_cost_allocations` (inventory plus cost of sales equals the share).
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api` and read access for `lara_worker` and `lara_audit_reader`.

Verification: `scripts/test-p10-schema.mjs` (5 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the twelve new tables.

## P10-02 domain and costing rules

`packages/domain/src/inventory.mjs` with a hook in `purchasing.mjs`:

- Inventory profile (`settings_versions` kind `inventory_profile`): goods-received clearing, stock gain and loss, landed cost clearing accounts, the three-way tolerance percent, the negative-stock policy (`block`).
- Items fix their cost method, tracking and stock account once they have posted movements; warehouses belong to a branch.
- Movements are drafted, submitted, approved by another principal and posted once: receipts open valuation layers at the stated unit cost (Dr stock / Cr goods received clearing); issues consume layers oldest first by effective date then sequence (FIFO) or cost at the running average with the residual carried to the final issue (Dr cost of sales / Cr stock, AC-09); returns to supplier consume like issues against the clearing account; transfers consume at the source and re-layer at the destination at the consumed cost with no entry and no profit; adjustments post gains and losses. Every posting locks the balance rows of its item and warehouse pairs in sorted order, so concurrent issues serialize and negative stock is refused (P10-T02). Serial lines move one unit, name their serial, and a serial cannot be received again or issued elsewhere while it sits in another warehouse (P10-T03).
- A receipt dated before posted issues of the same stock shows its deterministic recost at approval (a replay of the FIFO or average sequence with the receipt in place) and posts the difference as a linked adjustment against cost of sales without rewriting the issues; a movement into a locked period is refused by the posting function (P10-T05).
- Counts freeze the expected quantity at creation, are approved by another principal and post gains at the current average or last cost and losses at the layers through adjustment movements; landed cost runs allocate an approved posted charge over receipts by value or quantity (weight needs item weights and is refused), the residual cent to the largest basis, the remaining share raising the layers and the sold share to cost of sales, previewed with a checksum re-verified at approval and posting, posted once. Count and landed cost journals reconcile to the valuation and the stock account exactly (P10-T04).
- Three-way match: a bill against a goods order (a line naming an item or on a stock account) is refused at approval and posting until a goods receipt is posted against the order — no tolerance waives it; the billed value is compared with the received value and a variance beyond the profile tolerance needs the approver's recorded disposition reason.
- Reads: the stock card (balances, layers, posted movement lines), the valuation versus the stock account balances at a cutoff with a checksum, count lines with variances, the landed cost allocation preview and the recost preview; the `inventory_valuation` report type renders through the P03 snapshot job.

Verification: `scripts/test-p10-domain.mjs` (7 groups) covers P10-T01–T05, AC-09 and the three-way match; P03–P09 suites pass with the purchasing hook (goods lines on the clearing account with an item).

## P10-03 API and jobs

All 24 operations plus the six reads are served by `apps/api/src/workspace-api.mjs`; the worker renders `inventory_valuation` reports. Postings are synchronous inside the command transaction.

Verification: `scripts/test-p10-api.mjs` (5 groups, API and worker as processes, in CI): items and warehouses, movements through the reviewed states with AC-09 and a transfer, the stock card, recost and valuation reads with contract shapes, a count with its lines read and variance posted, a landed cost run previewed, approved, posted once and rendered as a report, 404s and later-phase gates.

## P10-04 user journeys

`apps/web/src/app/_components/workspace-inventory.tsx`: items and the stock card with the stock-to-ledger differences at `/inventory`, the movement workbench with the recost preview at `/inventory/movements`, count entry and review at `/inventory/counts`, the landed-cost preview at `/inventory/landed-costs`. The capabilities screen offers the activation; the navigation gained Assets as the next placeholder.

Verification: `tests/browser/workspace.spec.mjs` inventory journey on the production composition — two-principal activation, profile, accounts, warehouse and roles seeded through the runtime role (no reviewed operations exist for them), an item created on screen, a receipt and an issue drafted and submitted by the clerk and approved and posted by the controller, the stock card and the ledger tie, a count observed, reviewed through its lines, approved and posted with the loss, the tie re-checked, WCAG checks on the four routes (also in CI).

## P10-05 acceptance and operations

Acceptance: P10-T01–T05 and AC-09 in `scripts/test-p10-domain.mjs` and `scripts/test-p10-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P10-RUNBOOK.md` covers activation gates, costing, movements, backdating, counts, landed cost, the three-way match and the rollback rule (stop movements, keep valuation evidence).

## Open items for the owner

- No reviewed operations exist for warehouses (creation), the inventory profile or the opening stock import; the domain implements warehouses and the journey seeds them through the runtime role. Opening stock is entered as receipts against an opening clearing account until the reviewed import exists.
- No seeded role template holds the stock clerk, inventory approver or purchase-order permissions; tenants create them (tests and the journey do).
- Allocation by weight needs item weights on the item master; batch tracking records quantities per lot but no expiry; unit conversions are not modelled (one unit per item).
- The three-way match compares values through the received cost and the billed net; a price variance within tolerance stays on the goods-received clearing account for manual clearing, and a bill for goods references the order (bills without an order match two-way as before).
- The recost of a backdated receipt posts the value difference and leaves the existing allocations as recorded; a later issue consumes the backdated layer in date order from then on.
- Foreign-currency stock and the FX layer interaction (P09) are not combined: item costs are functional-currency amounts.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
