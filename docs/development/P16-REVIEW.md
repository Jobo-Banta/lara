# P16 implementation review — 21 September 2026

P16 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain rules), 3 (API and purchasing/sales hooks), 4 (user journeys) and 5 (acceptance and operations) are implemented; no `planning` capability is activated for a live entity.

## P16-01 contracts and migration

Contracts: the 18 P16 operations (`/budgets` create/list/get/edit/approve/activate, `/allocation-runs` create/list/get/edit/preview/approve/post, `/projects` create/list/get/edit/progress-billing) and their schemas were already in the reviewed OpenAPI; the `budget.*`, `allocation_run.*` and `project.*` permissions and the `planning` capability (depends on `inventory` and `assets`) were seeded by `0009`. Under the phase rule that screens may add read/list and versioned-mutation operations, seventeen entity-scoped operations were added and the catalog regenerated (429 operations): budget availability and commitments, allocation rule versions with approval, run lines, milestones with certification, change orders with approval, advances, retention with release, and profitability. The reviewed `AllocationRunCreate` names `ruleVersionId` and `ProgressBilling` names `milestoneId`; both now resolve to records.

Migration `0031_p16_planning.sql`:

- `budgets` (versioned per book and period, one active, approved and activated by other principals, immutable once approved, superseded and rejected final) and `budget_lines` (one bucket per account and dimension set; the row locked while a commitment is reserved).
- `commitments` (one per order line, positive, consumption never beyond the amount nor reduced, warning or override with its principal, consumed and released final).
- `allocation_rules` (versions per code with sources, drivers and target, approved by another principal, immutable once approved) and `allocation_runs` (previewed only with lines and their hash, approved by another principal with inputs frozen, posted once per rule version and period with the entry).
- `projects` (unique codes, evidence), `project_contract_versions` (unique per project, approved by another principal, immutable once decided), `milestones` (certified on evidence by a certifier, billed never beyond certification nor reduced), `project_advances` (one per project and collection, recouped within the amount), `project_billings` (one per invoice, retention and recoupment within the certified amount, immutable once posted) and `retention_items` (one per invoice, released only with the release invoice, full amount and evidence).
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api`; the runtime role cannot delete planning records.

Verification: `scripts/test-p16-schema.mjs` (5 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the eleven new tables.

## P16-02 domain rules

`packages/domain/src/planning.mjs` with hooks in `purchasing.mjs` (order approval reserves, cancellation releases, a bill posting against the order consumes) and `sales.mjs` (a progress or release invoice posting applies the billing):

- Budgets in the book's functional currency with one bucket per account and dimension set; availability = budget − posted spend in the period on the bucket − open commitments; reservation locks the bucket rows, so simultaneous approvals serialize; `block` refuses beyond the balance unless the approver holds `budget.activate` and records a reason, `warn` records the warning (P16-T01); consumption transfers the commitment to the actual line by line without double counting; a bill without an order is actual only (P16-T02).
- Allocation rule versions validated (no control accounts, target not a source, positive weights and total, one driver per dimension set); runs validated against the rule's effective dates and refused when the rule version is already posted for the period; the pool and lines computed from the ledger as of the cutoff with the residual on the first driver; approval and posting recompute and refuse a stale preview; posting moves the pool to the target per driver in one entry, once (P16-T03).
- Projects with an approved contract version; milestones certified by a principal other than the owner on evidence within the milestone amount and never below billing; documented advances from posted collections with an unapplied remainder; progress billing drafts the due-now invoice (certified less retention) never beyond the certified, unbilled value nor the approved contract, and when the invoice posts the retention is recognized in its receivable and the advance recouped by allocation; release drafts a due-now invoice against the retention receivable whose posting settles the AR control and closes the item; profitability from posted facts with work in progress excluded (P16-T04).
- Change orders are contract versions approved by a second principal; the amount never changes in place; earlier billing stands and earlier versions stay visible (P16-T05).

Verification: `scripts/test-p16-domain.mjs` (7 groups) covers P16-T01–T05, including two connections approving orders concurrently against one bucket.

## P16-03 API

All 18 operations plus the seventeen additions are served by `apps/api/src/workspace-api.mjs`; the purchasing and sales operations carry the hooks, so the screens of P05 and P04 reserve, consume and apply without new endpoints.

Verification: `scripts/test-p16-api.mjs` (6 groups, API as a process, in CI): budgets over HTTP with availability, an order refused beyond the budget and approved with an override, the bill consuming the commitment, a rule and a run through preview, lines, approval and posting, a project through contract approval, certification, advance, progress billing, the invoice's review, retention, release, profitability and a change order, isolation and gates.

## P16-04 user journeys

`apps/web/src/app/_components/workspace-planning.tsx`: `/planning` (budget versions drafted, approved and activated; budget versus actual and open commitments per bucket with warnings and overrides; commitments), `/planning/allocations` (rule versions with drivers and approval; runs with preview, lines showing the residual placement, approval and posting), `/planning/projects` (projects, contract versions and change orders, milestones with certification, advances, progress billing, retention with release, profitability). The purchase order approval on `/purchases/orders` carries the override reason. The capabilities screen offers `planning`; the navigation gained the Local operations placeholder (P17).

Verification: `tests/browser/workspace.spec.mjs` planning journey on the production composition — activation by two principals, a budget approved and activated with its availability, an order refused beyond the blocking budget and approved with the recorded override, the commitment consumed by its bill, a rule and run previewed, approved and posted, a project with contract approval, certification, advance, progress billing, retention, release and a change order, WCAG checks (also in CI).

## P16-05 acceptance and operations

Acceptance: P16-T01–T05 in `scripts/test-p16-domain.mjs` and `scripts/test-p16-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P16-RUNBOOK.md` covers activation gates, budget control, allocations, projects and the rollback rule.

## Open items for the owner

- No seeded role template holds the budget, allocation or project authorities; tests and the journey create a planner and a project manager.
- Budget buckets and drivers use dimension value ids; a dimension picker arrives with the reporting dimension increment.
- Progress invoices carry no tax lines; taxable progress billing needs the tax code on the billing input.
- CSV/PDF exports of the availability and worksheet views arrive with the report export increment.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
