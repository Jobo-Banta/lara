# P10 inventory costing and three-way matching runbook

Extends `P02-RUNBOOK.md` through `P09-RUNBOOK.md`; earlier procedures apply unchanged. Direct edits to posted `lara.stock_movements` and their lines, `lara.valuation_layers` identity, `lara.stock_allocations`, `lara.stock_balances`, approved `lara.count_sessions`, `lara.landed_cost_runs` or `lara.landed_cost_allocations` are prohibited; the database refuses them for every application role, and a privileged edit is a Sev1 posting-integrity incident handled as in the P03 runbook. Stock never goes negative and nothing is rewritten: a wrong movement is corrected by a new linked movement.

## Activation gates

Inventory work on an entity needs, in order: the `treasury` capability active, the `inventory` capability activated with evidence and an independent approval (`/settings/capabilities`), an approved `inventory_profile` settings version naming the goods-received clearing, stock gain, stock loss and landed cost clearing accounts, the three-way tolerance percent and the negative-stock policy, at least one warehouse per branch, and items with their cost method chosen before the first movement. Until the reviewed contract gains operations for them, an operator seeds the profile and the warehouses through the runtime role with the tenant set, exactly as `tests/browser/workspace.spec.mjs` does. Before activation for a live customer the controller signs the costing method, unit conversions, cutoff, negative-stock policy and the opening count, and the stock, ledger, receivables, payables and inventory outputs pass on the parallel month. Opening stock enters as receipts dated at the cutoff against an opening clearing account reconciled to the ledger opening.

## Movements

The clerk drafts a movement (`/inventory/movements`): a receipt names the unit cost per line, an issue, a transfer or a return costs at the layers. Serial-tracked items move one unit per line with the serial named; batch-tracked items name the lot. Submission freezes the lines; another principal approves; a third step posts (the preparer never both approves and posts). Posting locks the item and warehouse balances in sorted order: two concurrent issues serialize, and one that would leave negative stock is refused (`STATE_CONFLICT`) — split it or wait for the receipt. FIFO consumes the oldest layer by effective date then sequence; the moving average recalculates after each receipt and the final issue carries the residual. Transfers conserve quantity and value and post no entry. A serial that sits in another warehouse cannot be received again or issued from elsewhere.

## Backdated movements

A receipt dated before posted issues of the same stock in an open period shows its recost at approval (`GET /stock-movements/{id}/recost`): the FIFO or average sequence replayed with the receipt in place and the difference per affected issue. Approving the receipt approves that recost; posting writes the receipt and a linked adjustment (cost of sales against stock) for the total difference. The issues are not rewritten and later issues consume the backdated layer in date order. Backdated issues, transfers and returns before later movements are refused; date them on or after the last movement. Any movement into a locked period is refused.

## Counts

Create the count at the cutoff (`/inventory/counts`); the expected quantities freeze at creation, so post every movement up to the cutoff first. Enter the observed quantities with the count sheet as evidence; review the variances through the lines read; another principal approves; posting creates and posts the adjustment movements — gains at the current average or last cost, losses at the layers — and the stock-to-ledger view must tie afterwards. A recount is a new session.

## Landed cost

Post the freight, duty or handling bill through purchasing, then create the run (`/inventory/landed-costs`) over the posted receipts it belongs to, by value or quantity (weight needs item weights and is refused). The preview shows each layer's share, the portion still on hand raised into the layer and the sold portion to cost of sales; approval by another principal and posting both re-verify the preview against current stock — a movement in between means preview again. One run per charge; posting is one entry.

## Three-way match

A bill against a goods order (an order line on a stock account or naming an item) is refused at approval and at posting until a goods receipt is posted against the order; no tolerance waives the receipt. The billed value is compared with the received cost: within the profile tolerance the bill posts to the goods-received clearing account; beyond it the approver records a disposition reason at approval and the bill posts with it. Clear the goods-received clearing account against receipts and bills monthly; a residual is a price variance to investigate, not to hide.

## Stock to ledger

`/inventory` (`GET /inventory-valuation`) compares the valuation (balances by stock account) with the stock account balances at a cutoff and names every difference. A difference means a posting outside the module reached a stock account (manual journals, bills posting straight to stock) — trace it on the entry and the stock card, and correct it through the owning flow.

## Rollback

Deactivating the capability stops new movements, counts and landed cost runs; the valuation evidence (layers, allocations, balances, counts) and the stock cards stay readable. Never delete or edit posted movements; reverse through new linked movements.

## Evidence to preserve

For every inventory incident: trace ids, the `audit_events` range for the entity, the item and warehouse ids, the movement ids with their lines and costs, the layer and allocation ids, the count session ids with the count sheet evidence, the landed cost run ids with their previews, the journal entry ids (posting and recost) and the valuation checksum. Export them with `POST /exports` before any operator action.
