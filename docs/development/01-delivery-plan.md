# Delivery phases and release policy

## What ships at every boundary

A release is a tagged application image, compatible database migration, updated contracts, automated tests, operator runbook, release notes, demo script and a signed acceptance record. Work is not complete when the screen works against a mock. Starting with P02, enabled features use real persistence, business rules, authorization, evidence and recovery. Incomplete capabilities remain absent from production navigation and return `FEATURE_NOT_ENABLED` on direct API access.

P00 and P01 are explicit exceptions in **purpose**, not engineering quality: P00 is an engineering platform release; P01 is a synthetic-data prototype. Neither may issue valid tax documents, execute bank instructions or claim completed compliance. Prototype API/state is isolated from production financial records and cannot be promoted by changing a flag.

| Phase | Shippable increment | New complete supported boundary | Dependencies |
| --- | --- | --- | --- |
| P00 | Engineering baseline | Repository, environments, database, identity, CI, migrations, observability | None |
| P01 | UX prototype | Persistent synthetic journeys, role tasks, demo imports, labelled simulated AI/reporting, reset and feedback | P00 |
| P02 | Finance workspace | Tenant/company/branch setup, parties, users, roles, approvals, evidence, tasks and obligations | P01 |
| P03 | General ledger | PHP books, journals, reversals, periods, opening import, trial balance, basic statements and close | P02 |
| P04 | Sales and collections | Approved tax kernel, direct/order invoicing, corrections, AR aging, advances and collection allocations | P03 |
| P05 | Purchasing and payables | PO/non-PO bills, withholding, expense advances, supplier credits and manual payment settlement | P04 |
| P06 | Treasury and reconciliation | Bank statements, matching, transfers, PDC/check lifecycle, branch cash close and payment files | P05 |
| P07 | Compliance and e-invoicing | Applicable books/returns, filing evidence, registration pack, certified transmission and reconciliation | P06 |
| P08 | Financial institution coexistence | Source feeds, bank account mapping, GRT/final withholding/DST profiles, branch reconciliation | P07 |
| P09 | Multiple currencies and books | Currency conversion, FX settlement/revaluation, separate RBU/FCDU/trust book boundaries | P08 |
| P10 | Inventory and procurement matching | Stock movements, FIFO/weighted-average, count, costing, landed cost, three-way matching | P06; P09 for foreign-currency stock |
| P11 | Assets and schedules | Asset lifecycle, depreciation, prepayment/deferred revenue, recurring documents and schedules | P03/P05; P09 for foreign currency |
| P12 | Evidence-backed AI assistance | Document capture/coding, exceptions, finance questions, close and audit drafting with evaluations | P07; each tool also requires its target module |
| P13 | Customer and supplier collaboration | Scoped portals, payment links, document/certificate requests, one messaging channel | P04–P07 |
| P14 | Accounting firm workspace | Explicit multi-client access, assignments, deadlines, authorized aggregate views | P07/P13 |
| P15 | Group accounting | Intercompany paired documents, eliminations, translated consolidation and group reports | P09/P11 |
| P16 | Planning and project accounting | Budgets, commitments, cost allocations, project/retention billing and management reporting | P10/P11 |
| P17 | Local operations extensions | Leases, statutory discounts, marketplace/POS/payroll/LGU adapters as separate feature releases | P07/P09/P11/P16 as applicable |
| P18 | Controlled extensibility | Report builder, rule-change proposals, client draft tools and approved industry packs | P12/P14–P17 as applicable |

Default delivery is serial P00→P09, then P10→P18. After P09 independent modules may be implemented in dependency order, but each module still receives its own release and gate. P17 and P18 contain explicitly numbered independently shippable feature increments; their matrix entries define what each release enables. Do not label the entire parent phase complete when only one increment exists.

## Production activation rules

P02 can serve as a real finance work/evidence workspace. P03 can serve a scoped management ledger with signed source ownership and controlled imports; it is not a certified complete statutory CAS. P04–P06 expand operational finance only for profiles with all applicable controls/obligations supported. P07 provides the base statutory/compliance capability for eligible customers. The original bank-first pilot reaches live coexistence at P08, or P09 when separate books/currencies are required. Inventory, trust, payroll-derived outputs or other required capabilities extend the dependency set before activation.

No phase “borrows” an unbuilt future module through a fake UI. Examples: P05 records authorized manual settlement with evidence; P06 adds bank-file release and statement confirmation. P03 accepts controlled depreciation schedule imports; P11 replaces those imports for customers who choose native assets. P04 has a durable reporting outbox but cannot enable a reporting-required profile until P07 provides its certified adapter.

## Release gate RG

RG-01: every in-scope acceptance scenario passes through the UI and API against PostgreSQL, with no mocks on an enabled production path.

RG-02: prior-phase regression suite passes, including permission negatives, period/amount invariants and duplicate/retry tests.

RG-03: migration works from the immediately previous release and a clean database; old/new application versions coexist during expansion migration. No destructive downgrade of financial records.

RG-04: zero open critical/high correctness or security defects. Other defects have an owner, workaround and explicit release acceptance. Test coverage is evidence, not permission to ignore failed scenarios.

RG-05: backup/restore, job retry, alert routing, support runbook, feature disable and data export work for the changed scope. Recovery meets the agreed profile.

RG-06: meaningful end-to-end demo and task-based user acceptance, including validation error, permission denial, empty/loading and interrupted-request recovery.

RG-07: required regulatory/customer/provider inputs have valid evidence for enabled profiles. Absent evidence disables only the unsupported capability/profile.

RG-08: release manifest records source commit, image digests, migration versions, rule/template versions, enabled capabilities and operator acceptance. No “production grade” assertion before these gates pass.

## Change to the earlier BRD roadmap

Old BRD Phase 1 is decomposed principally across P02–P08. Old Phase 2 appears in P09–P17 and some earlier dependency-complete features. Old Phase 3 appears in P15/P18 or the explicitly deferred list. Removed FR-PL-011 and deferred government withholding/peer benchmarks remain non-enabled unless their documented scope decision is changed. The requirement map is exhaustive and authoritative; original IDs stay stable.

## Delivery visibility

The [build status page](../../build-status.html) tracks every release increment and backlog ticket. Follow the [update contract](13-build-tracking.md) at each work-session handoff and release. All module UI work follows the [approved design and asset contract](12-design-and-assets.md).
