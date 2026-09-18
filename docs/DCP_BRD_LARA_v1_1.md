# LARA Business Requirements Document

Version 1.1 | September 18, 2026 | DCP Product Office | Revised draft for owner review

This revision replaces the v1.0 requirements baseline for review, preserves valid requirement identifiers and makes the launch scope, control boundaries and user journeys more explicit. The original Word document is retained unchanged. Proposed release decisions are not stakeholder approvals, and pilot targets are not measured results. The companion roundtable report records AI-simulated perspectives, disagreements and the change rationale.

Sections 1 to 22 retain the original subject structure. Section 23 adds testable acceptance requirements and pilot gates. Removed FR-PL-011 remains a tombstone; nine incomplete AI table rows are quarantined in section 12.4 and newly authored requirements are clearly identified.

## 1 Executive summary

LARA is DCP's proposed Philippine accounting platform for controlled bookkeeping, invoicing, tax preparation and audit evidence. The product should make finance work easier through guided journeys, reusable data and evidence-backed AI drafts. Compliance outputs remain deterministic and accountable to named reviewers.

Version 1.1 narrows launch claims while preserving the bank-first commercial direction and one-codebase strategy. The recommended first release is a controlled financial-institution design-partner pilot with explicit source-system boundaries. It is not a promise to replace every bank ledger or serve every industry immediately. The pilot must complete its selected invoice-to-cash, bill-to-payment, reconciliation and first-close journeys, not merely generate a registration pack.

Banks, SMEs and retailers have different acceptance cases. Each pack must pass its own capability, usability and regulatory tests. Configuration should cover ordinary client variation; complex functionality may still require reusable code and adapters. No customer-specific code fork is planned.

Three proposed differentiators guide the roadmap: trace a reported number to its source and applicable rule; guide a new customer from migration through a reconciled first close; and resolve local cash, withholding-certificate and invoice exceptions in one work queue. These are product hypotheses to validate with target users, not claims of competitor uniqueness.

RR 26-2025 identifies a December 31, 2026 issuance transition deadline for specified groups and treats sales reporting separately. Customer coverage, existing obligations and later issuances must be checked before commitment. Product release dates follow signed scope and demonstrated readiness, not an assumed ability to finish the complete roadmap by that date.

## 2. Philippine business practices

Local finance teams follow many habits that general accounting software does not handle out of the box. Covering them well removes the spreadsheets and paper logs that clients otherwise keep on the side. The full requirements are in section 9.10. In summary, they fall into six groups:

Paper trail and approvals: check and disbursement vouchers with signature blocks, check signatory rules, counter receipts, check release days, and numbered supplementary receipts.

Cash handling: post-dated checks, daily collection reports with cash count, deposit slips, revolving funds, and cash advance liquidation.

Tax paperwork around each transaction: supplier and customer certificates (2303, sworn declarations, zero-rating certificates), 2307 follow-up, withholding timing under EOPT, tax payment records, and the BIR filing calendar.

Organization: head office and branch accounts, per-branch books, and local government obligations such as business permits and real property tax.

Local channels: local bank statement formats, InstaPay, PESONet, and QR Ph references, e-wallets, and online marketplace payouts.

Industry habits: progress billing with retention, lease deposits and advance rent, statutory discounts, and employee loans.

Rules to confirm with the tax advisor

A few items depend on specific regulations that should be checked before build: output VAT relief on uncollected receivables under EOPT, withholding on online marketplace and e-wallet payouts, the scope of statutory discounts beyond senior citizens and PWDs, and current rules on binding and submitting loose-leaf books. Their requirements are written so the rates and rules are settings, not code.

## 3 Business background

The source BRD identifies Philippine finance teams managing accounting, invoices, checks, withholding evidence and registration requirements across fragmented tools. LARA's business opportunity is to reduce repeated entry, exception handling and evidence assembly while delivering a repeatable DCP product.

The immediate commercial hypothesis is a financial-institution design partner because the source describes active DCP conversations in that segment. Neither market size, willingness to pay nor delivery economics has been validated in this review. Product must test these before broad launch. E-invoicing coverage does not automatically require every business to buy or replace its entire accounting system.

## 4 Objectives and success measures

Targets are proposed for the selected pilot and require a recorded baseline. Product owns measurement; the named accountable owner approves definitions and exceptions. Authority outcomes and customer behavior are tracked separately from product-controlled acceptance.

| ID | Objective | Measure and owner |
| --- | --- | --- |
| OBJ-1 | Support taxpayer registration | Tax lead: all applicable checklist items evidenced and reviewed; record actual authority decision separately. Pack generation is not approval. |
| OBJ-2 | Reliable issuance and applicable reporting | Engineering/operations: 100% of committed eligible documents durably queued, no duplicate financial effect; report submission/acceptance timeliness against the active deadline, with outages and exceptions visible. |
| OBJ-3 | Faster accurate preparation | Tax lead: target supported quarterly preparation under one hour from reconciled complete inputs; all agreed format/regression cases pass. Measure real rejections and causes; do not guarantee authority acceptance. |
| OBJ-4 | Shorter close | Controller: target five working days by the third pilot close; baseline from comparable prior periods and report unresolved reconciling items and upstream delays. |
| OBJ-5 | Less encoding and review effort | Product/finance: target 70% unchanged capture across the agreed eligible input population; include failures and abstentions in the denominator, measure material field errors and review time separately. |
| OBJ-6 | Repeatable onboarding | Product: onboard a second compatible customer on the same code release and supported adapters, measuring configuration and support hours against the first. |
| OBJ-7 | Reusable industry architecture | Product/engineering: retain one codebase and validate each additional cohort independently. Same release does not imply identical workflows or universal current coverage. |
| OBJ-8 | Seamless critical tasks | UX/product: proposed 90% unassisted completion across six critical journeys with at least eight representative users; report failures by role, not only an overall average. |
| OBJ-9 | Measurable simplification | Product/process owner: proposed 30% lower median handling time in bill entry and exception resolution versus the same-team baseline, without increased material errors. |

Capture the baseline before onboarding, assess at first close and after three closes, and retain dataset scope, sample size, measurement window, exclusions and evidence. Numerical targets can be refined before pilot commitment; accounting and security invariants cannot be waived as usability tradeoffs.

## 5 Scope and releases

Priority M means required within the stated applicability, S means desirable and C means optional. Phase numbers describe dependency order, not delivery dates. A conditional requirement is mandatory before a customer using that capability goes live; deferring the feature also defers that customer or establishes an approved retained-system boundary. Section 23 supplies acceptance gates and ownership. Detailed requirement rows are the release authority.

### Phase 1 controlled pilot

Deliver setup, access controls, master data, audit trail, posting and period controls; direct invoices and bills; collections, payments and basic bank reconciliation; a standard CSV statement import; applicable books, tax worksheets and certificates; evidence-linked registration preparation; e-invoice issuance and reporting adapters where applicable; migration, core source reconciliation, a role-based work queue, close checklist and substantiation. Trial balance, balance sheet and income statement are explicit core outputs.

Enable checks, PDCs, vouchers, branch cash close, procurement and other local practices only where the pilot needs them. Disabling optional steps must never disable an applicable accounting, tax or approval control. Final withholding, GRT, DST, foreign currencies and separate books must either be fully supported within the selected scope or remain in a named authoritative source with reconciled hand-offs. Full bank replacement is not accepted with these dependencies unresolved.

The AI scope is limited to assisted typed-document capture, coding suggestions, migration mapping and explanations of deterministic validation failures. Readiness, withholding and input-VAT checks are rules with evidence; AI is an optional explanation layer. Add one registration drafting behavior only after its evidence and evaluation gate passes. Handwritten capture, PDF statement reading, manual-books OCR and AI certificate chasing are Phase 2.

### Phase 2 expansion

Add inventory and valuation, asset schedules, multi-currency and bank-book extensions, advanced matching, additional tax/financial reporting packs, portals, recurring schedules, one validated messaging channel and the accounting-firm console. A deferred feature needed by a pilot is pulled into its committed release or that pilot is excluded; a spreadsheet workaround without an accountable control is insufficient.

### Phase 3 options

Consolidation, further industry packs, project costing, client-defined agents and advanced advisory analytics follow evidence of demand and support capacity. Peer benchmarks remain an opt-in research option requiring enough protected cohort data to prevent reidentification.

### Out of scope

Full payroll, manufacturing/MRP, CRM, POS terminal software, core banking/treasury/lending engines, corporate-secretarial registers and tax advisory services remain outside the product. Direct tax filing/payment is not Phase 1; a future qualified filing partner may provide a separately controlled hand-off.

## 6. Stakeholders and user roles

### Stakeholders

Client finance leadership: sponsor at each implementation; approves configuration and sign-off.

Client accounting team: daily users of the ledger, receivables, payables, and close.

Branch and treasury staff: daily users of collections, disbursements, and the branch close.

Internal audit and compliance: review controls, access, and evidence; users of section 9.12.

Client external auditor and tax advisor: review books, templates, and filings.

Accounting and bookkeeping firms: run several client companies on the product; a channel as well as a user.

BIR and applicable offices: issue applicable acknowledgements/authorizations and may post-evaluate; exact permit profile requires verified authority.

DCP product and engineering teams: build and support LARA; DCP co-signs the Joint Sworn Statement as system provider.

### Role and permission matrix

Roles below are the starting set. "Approve" always means a different person from the one who created the item.

| Role | Journal entries | Invoices and memos | Bills and payments | Bank reconciliation | Tax files and books | Reports and audit log | Settings and users |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Accounts Clerk | Draft | Draft | Draft | View | None | View own work | None |
| Billing / Cashier | None | Create and post invoices; request voids | Record collections | None | None | View own work | None |
| Senior Accountant | Create, post | Approve memos | Approve, post | Execute | Generate | Full view | None |
| Tax Officer | View | View | Review withholding codes | View | Generate, validate, mark as filed | Full view | Tax codes only |
| Finance Director | Approve, reverse | Approve voids | Final approval above limits | Approve | Approve for filing | Full view | Approval limits, period close |
| External Auditor / BIR Examiner | View | View | View | View | View, export | View, export audit log | None |
| Security Administrator | None | None | None | None | None | Access log only | Users and roles, with approval |
| System Administrator | None | None | None | None | None | System log only (cannot edit or delete) | Technical settings, backups |
| Internal Auditor | View | View | View | View | View, export | Full view, export audit log | None |

Roles are configurable, but required segregation of duties is enforced at the action and transaction-version level. Setup identifies unsupported single-user arrangements and requires an authorized second reviewer; AI is not that reviewer.

## 7 Regulatory basis and evidence status

Maintain a regulatory register with primary source, effective date, affected taxpayer profile, reviewer, interpretation, test cases and superseded version. The requirements below are a product design baseline, not evidence that every regulation or customer application has been legally validated.

Verified in this review: RR 26-2025 describes the issuance transition and separates the subsequent sales-reporting trigger; RR 7-2024 Section 4 specifies a general five-year preservation period for books and accounting records, with the filing-related start date and extended preservation in relevant unresolved cases. See section 22 for primary sources. A contractual ten-year archive may still be offered, but is not a universal legal minimum and does not require retaining every operational backup for ten years.

Retain for advisor verification: RR 9-2009; RMC 5-2021; RMO 9-2021 and Annex B; the exact application of RMC 10-2020; RR 7-2024 as amended and RMC 77-2024; RR 11-2025 as amended; RR 16-2006 and later books submission rules; RA 10173 and applicable NPC rules; and institution-specific BSP and accounting requirements. Old retention references RR 17-2013/RR 5-2014 are historical, not the sole current baseline.

The source refers to an August 2026 draft e-invoice circular. Final primary authority for its PTI, QR payload, branch coverage, provider restrictions and exact correction route was not established in this review. Keep these in a pending profile; a draft must not create a universal production block or sales claim. Tax/compliance owns the final applicability review before build baselines and go-live.

## 8 Core business processes

### Invoice to cash

Create a direct invoice or reuse an approved order, validate identity and tax fields, review and post once, deliver to the buyer, transmit when applicable, record and allocate collections, track withholding evidence and reconcile settlement. Quotations, sales orders and delivery steps are enabled only when the business process requires them. The transaction timeline separates posted, delivered, reported and settled.

### Bill to payment

Capture a direct bill or match to a required PO/receipt, check duplication and evidence, calculate tax deterministically, review exceptions and approve/post. Prepare payment against approved items, verify payee details, authorize release separately, issue required certificates and reconcile settlement. Reuse party data, coding and attachments throughout; never require a fictitious PO to pay an approved utility bill.

### Record to report

Validate each source batch, reconcile accepted counts and amounts, approve/post, resolve bank and control-account differences, prepare supported adjustments, substantiate required accounts, complete the close checklist and lock the period. Reports and applicable returns retain their data cut-off and rule versions; filing evidence is recorded separately from preparation.

### Corrections and recovery

Posted entries are immutable. Journal errors use linked reversal/adjustment entries; invoice errors follow the effective verified correction rules. Rejected transmission is not permission to edit a posted invoice. Uncertain external acknowledgement requires status reconciliation before resend. Post-close corrections follow FR-GL-021, preserve the original report and assess any refiling obligation.

### Branch daily close

One flow ties documents issued, collections, cash count, differences, deposits and handover evidence together. Cashier and reviewer act on the same record; deposit timing and uncleared checks remain visible until reconciled. An approved downtime procedure uses controlled documents and reconciles each one exactly once after recovery.

## 9. Functional requirements

Priority: M must, S should, C could.

### 9.0 Shared building blocks

Shared engines reduce duplicate implementation. Use supported configuration where appropriate and reviewed reusable code or adapters where new domain behavior is required. Each industry pack retains its own accounting and acceptance tests.

| ID | Shared building block | Priority | Phase |
| --- | --- | --- | --- |
| FR-SH-001 | Posting engine. The only way anything reaches the ledger. Balance check, period control, dimensions, control accounts, audit trail, and reversal rules live here once. | M | 1 |
| FR-SH-002 | One document registry for series, layouts and supported validation rules. Configuration reuses proven document behavior; new legal or accounting semantics require reviewed code and regression tests. | M | 1 |
| FR-SH-003 | One party identity with customer, supplier, employee and bank roles; tenant and role permissions protect sensitive fields. Keep AR and AP balances separate; no automatic netting or cross-tenant identity sharing. | M | 1 |
| FR-SH-004 | Tax engine. VAT, percentage taxes, withholding, and stamp taxes as rules with rates, effective dates, and evidence of the version used. Every module asks the engine; no module computes tax itself. | M | 1 |
| FR-SH-005 | One approval and limits engine with document-version checks, delegation, amount limits, signatories and enforced maker-checker restrictions. Material edits invalidate approval. No self-approval through role switching. | M | 1 |
| FR-SH-006 | Shared ingestion stages: receive, malware check, stage, validate, map, review and commit through authorized posting. Adapters retain source IDs, batch totals, duplicates and retry history. AI is optional; rejected records remain recoverable. | M | 1 |
| FR-SH-007 | Reconciliation framework. One way to match two sets of records and explain the difference: bank against ledger, payments against invoices, sub-ledgers against control accounts, books against returns, and documents against what the BIR accepted. | M | 1 |
| FR-SH-008 | Schedule engine. Anything that generates entries over time: depreciation, deferred revenue and expense, recurring invoices and journals, lease schedules, and amortisations. One engine, many schedule types. | S | 2 |
| FR-SH-009 | Obligations and reminders. One calendar for filings, permits, certificate expiries, business permits, binding of books, and any other dated duty, with owners, evidence, and escalation. | M | 1 |
| FR-SH-010 | One task service for approvals, drafts, rejected transmissions, imports, reconciliation and control exceptions; role-specific views show one owner, deadline, reason, source and next action. Group duplicate alerts and support controlled delegation. | M | 1 |
| FR-SH-011 | One reporting service with locked statutory templates, consistent headers and exports. Phase 1 uses approved reports and filters; broad custom report design is Phase 2. | M | 1 templates; 2 designer |

### 9.1 Company, branch, and master data

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-CO-001 | Store each company's registered name, trade name, registered address, TIN, VAT or Non-VAT status, RDO, and fiscal year. | M | 1 |
| FR-CO-002 | Store branches with five-digit branch codes and branch addresses; every transaction belongs to a branch. | M | 1 |
| FR-CO-003 | Store Acknowledgement Certificate number, date issued, and approved series ranges per branch and document type. | M | 1 |
| FR-CO-004 | Customer and supplier identity, registered address and TIN/branch code where legally required. Validate format and applicable mandatory fields; represent legitimate missing or non-applicable identifiers explicitly, never with dummy TINs. | M | 1 |
| FR-CO-005 | Item and service catalog with unit of measure, default accounts, and tax codes. | M | 1 |
| FR-CO-006 | Register POS machines linked to the system (brand, model, serial, MIN, permit number) for declaration at registration. | S | 1 |
| FR-CO-007 | Store permit type, number, dates, branch scope and declared software version under the applicable approved regulatory profile. PTI-specific fields are conditional pending verified final authority; no universal PTI gate based only on a draft. | M | 1 |
| FR-CO-008 | Store the taxpayer classification (micro, small, medium, large, or Large Taxpayers Service) with its effective date, and warn when a change starts a new compliance period. | S | 1 |

### 9.2 General ledger

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-GL-001 | Hierarchical chart of accounts (assets, liabilities, equity, income, expense) with unlimited depth and a Philippine SME starter template. | M | 1 |
| FR-GL-002 | Block posting unless total debits equal total credits. | M | 1 |
| FR-GL-003 | Manual journal entries with date, reference, description, account, debit, credit, and attachments. | M | 1 |
| FR-GL-004 | Basic recurring manual-journal templates and scheduled reversal drafts through the posting engine. Broader contract and asset schedules use FR-SH-008 in Phase 2. | S | 1 |
| FR-GL-005 | Tag every GL line with branch, cost center, department, project, and business unit; dimensions configurable and optionally mandatory per account. | M | 1 |
| FR-GL-006 | Period open, soft close, and hard lock; no posting to locked periods. | M | 1 |
| FR-GL-007 | Year-end closing of income and expense to retained earnings. | M | 1 |
| FR-GL-008 | Multi-currency transactions with historical rates, revaluation, and automatic realized and unrealized exchange gain or loss entries. | S | 2 |
| FR-GL-009 | Multiple companies under one group, each with its own TIN, books, and series; intercompany entries and consolidation. | C | 3 |
| FR-GL-010 | Control accounts accept only authorized subledger postings or controlled source-system and migration batches. Each external batch includes source totals, detail or traceable references, reconciliation and independent approval; free-form manual posting remains blocked. | M | 1 |
| FR-GL-011 | Freeze individual accounts and configure adjustment cut-offs. Finance Director authority cannot bypass a hard lock; use the controlled correction process in FR-GL-021. | M | 1 |
| FR-GL-012 | Rounding account and a small tolerance setting for centavo differences. | M | 1 |
| FR-GL-013 | Deferred revenue and deferred expense (prepayments) with schedules that post monthly recognition entries automatically. | S | 2 |
| FR-GL-014 | Allocation rules that split one cost across several cost centers or branches by percentage. | S | 2 |
| FR-GL-015 | Budgets by account and dimension with control actions (warn or stop) on purchase orders, bills, and journals; budget versus actual report. | S | 2 |
| FR-GL-016 | Intercompany invoices and journal entries that create the matching entry in the other company. | C | 3 |
| FR-GL-017 | Phase 1 close checklist per entity and period with owners, dependencies, evidence and independent sign-off; hard lock only after required reconciliations and unresolved-item disposition. | M | 1 |
| FR-GL-018 | Phase 1 substantiation of material and control balance-sheet accounts, with supporting schedules, preparer, reviewer and aged reconciling items. The controller approves coverage and materiality; expand automation later. | M | 1 |
| FR-GL-019 | Parallel views of the same transactions for book and tax purposes, so permanent and timing differences are held once and reported both ways. | S | 2 |
| FR-GL-020 | Book-to-tax reconciliation and a deferred tax schedule built from the difference between the two views. | S | 2 |
| FR-GL-021 | Post-close corrections use approved current-open-period adjustments unless an explicitly authorized reopen is permitted. Reopening requires reason, independent approval, audit event and a new report version; preserve original issued reports and assess refiling. Never bypass hard locks or edit original entries. | M | 1 |

### 9.3 Sales and receivables

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-AR-001 | Issue VAT and Non-VAT invoices meeting all content rules in COMP-INV. | M | 1 |
| FR-AR-002 | Line-level tax calculation for VATable, VAT-exempt, and zero-rated items, with summary breakdown on the invoice. | M | 1 |
| FR-AR-003 | Direct invoice entry is supported. Approved quotations and sales orders may convert to invoices without re-entry when enabled by the customer process; never require dummy orders. | M | 1 |
| FR-AR-004 | Sales adjustment documents use separate controlled series and link to original invoices. Enable credit notes, debit notes or additional invoices only according to a verified effective regulatory profile. | M | 1 |
| FR-AR-005 | Statutory discounts and VAT treatment use advisor-approved eligibility, transaction categories, rates and evidence rules; protect identity data. Required before onboarding any customer relying on this workflow. | S | 2 conditional |
| FR-AR-006 | Record collections, partial payments, and withholding tax deducted by customers; log 2307s received. | M | 1 |
| FR-AR-007 | Receivables aging, statement of account, and customer ledger. | M | 1 |
| FR-AR-008 | Import sales from POS and e-commerce channels as summarized or detailed entries. | S | 2 |
| FR-AR-009 | Payment links (GCash, Maya, cards) on emailed invoices. | C | 2 |
| FR-AR-010 | Customer portal to view invoices, statements, and upload 2307s. | C | 2 |
| FR-AR-011 | Payment terms templates (for example 30 days, or 50% down and 50% on delivery) that create due-date schedules on orders and invoices. | M | 1 |
| FR-AR-012 | Customer credit limits with a warning or block on sales orders and invoices, and an approved override. | S | 1 |
| FR-AR-013 | Customer advances and deposits recorded before invoicing and applied to invoices later. | M | 1 |
| FR-AR-014 | Apply, unapply and reapply payments, advances and credits to open invoices with versioned allocation history. Posted accounting effects require linked reversal or adjustment entries; closed-period balances cannot silently change. | M | 1 |
| FR-AR-015 | Recurring invoices and subscriptions (rent, retainers, service contracts) created on schedule as drafts for approval. | S | 2 |
| FR-AR-016 | Dunning: reminder levels and optional late charges, run from the collections work in FR-SH-010 rather than a separate module. | C | 2 |
| FR-AR-018 | Price lists and discount rules by customer, item, quantity, or date range. | S | 2 |
| FR-AR-019 | Sales to government agencies: record VAT and income tax withheld at source and match them to 2306 and 2307 certificates received. Deferred by decision. | Deferred | Later |
| FR-AR-020 | Track received PDC custody, due date, deposit, clearance, dishonor and replacement. A bounce reverses only its affected settlement/allocation and preserves other payments, original evidence and period controls. | M | 1 |
| FR-AR-021 | Support QR generation and read-back testing under the approved invoice profile. Required QR payload and legal applicability must be verified before enforcement; a QR code alone is not proof of authenticity. | M | 1 |
| FR-AR-022 | Deliver invoices electronically by email, secure link, or mobile view; log every delivery; and print a copy when the buyer asks for one. | M | 1 |
| FR-AR-023 | Optional privacy-preserving invoice verification using non-enumerable tokens, rate limits and minimal fields. No public TIN, address, full invoice or BIR acceptance assertion without authorized evidence. | S | 2 |

### 9.4 Purchases and payables

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-AP-001 | Support direct bills and policy-controlled purchase requests and POs. Orders are optional for approved expense categories; required procurement controls cannot be bypassed. | M | 1 |
| FR-AP-002 | Supplier bills with input VAT, supplier TIN, and invoice number; flag bills missing required invoice details. | M | 1 |
| FR-AP-003 | Compute applicable expanded/final withholding using effective-dated rules. Generate and reconcile 2307 and, for taxpayers with final-withholding obligations, 2306 before their first live obligated transaction. | M | 1 applicable |
| FR-AP-004 | Three-way match of purchase order, goods receipt, and supplier invoice, with quantity and price tolerances; exceptions routed for approval. | S | 2 (two-way in 1) |
| FR-AP-005 | Payments have distinct prepared, approved, released and settled states; provide vouchers, credits and reconciliation. Supplier bank changes require independent verification and approval; a payment file or check print does not prove settlement. | M | 1 |
| FR-AP-006 | Payables aging, supplier ledger, and duplicate bill detection. | M | 1 |
| FR-AP-007 | Vendor portal to submit invoices and download 2307s. | C | 2 |
| FR-AP-008 | Supplier advances and down payments applied to bills later. | M | 1 |
| FR-AP-009 | Employee expense claims and cash advance liquidation with receipts, approvals, and unliquidated advance aging. | M | 1 |
| FR-AP-010 | Checks issued register, void and stale-check treatment, with check printing and release scheduling enabled only for customers using checks; go-live requires tested bank layouts and signatories. | M | 1 conditional |
| FR-AP-011 | Bulk supplier payments and bank payment upload files. | S | 2 |
| FR-AP-012 | Withholding categories by supplier type, with thresholds and running totals per supplier. | S | 1 |
| FR-AP-013 | Landed cost: add freight, duties, and brokerage to the cost of imported goods. | S | 2 |
| FR-AP-014 | Supplier e-invoice inbox: accept structured electronic invoices from suppliers by upload, email, or API, check them, and create draft bills without re-encoding. | S | 2 |

### 9.5 Cash and bank

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-CB-001 | Bank and cash accounts, deposits, transfers, and disbursements. | M | 1 |
| FR-CB-002 | Petty cash funds with replenishment. | S | 1 |
| FR-CB-003 | Manual bank reconciliation with reconciliation report. | M | 1 |
| FR-CB-004 | Phase 1 standard reviewed CSV statement import and deterministic matching suggestions; Phase 2 additional formats and AI matching. Posting and reconciliation remain approved, with unmatched lines visible. | S | 1 basic; 2 advanced |
| FR-CB-005 | Modes of payment (cash, check, bank transfer, GCash, Maya, card) each linked to a default account. | M | 1 |
| FR-CB-006 | Register of bank guarantees and surety bonds with expiry alerts, held as obligation types in FR-SH-009 rather than a separate register. | C | 3 |

### 9.6 Inventory

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-IN-001 | Warehouses, stock receipts, issues, transfers, and adjustments with GL posting. | M* | 2 |
| FR-IN-002 | FIFO and weighted average costing; valuation report. | M* | 2 |
| FR-IN-003 | Inventory Book generated from a complete, reconciled stock record. Required before goods-business go-live together with applicable inventory movement and valuation capabilities; never generated from unsupported stock data. | M* | 2 conditional |
| FR-IN-004 | Year-end inventory list export. | S | 2 |
| FR-IN-005 | Perpetual inventory: every stock movement posts to the ledger, with a stock versus ledger check report. | M* | 2 |
| FR-IN-006 | Batch and serial number tracking with expiry dates. | C | 2 |
| FR-IN-007 | Physical count with variance posting. | M* | 2 |

Inventory-dependent customers are excluded until the complete applicable inventory journey is released and validated; a Phase 1 commitment requires explicitly pulling those dependencies forward.

### 9.7 Fixed assets

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-FA-001 | Asset register with category, location, custodian, cost, and useful life. | S | 2 |
| FR-FA-002 | Capitalize from bills; track additional capitalized costs. | S | 2 |
| FR-FA-003 | Straight-line, declining balance, and sum-of-the-years' digits depreciation with automatic monthly entries. | S | 2 |
| FR-FA-004 | Asset split, merge, transfer, disposal (with gain or loss), and write-off. | S | 2 |
| FR-FA-005 | Separate book and tax depreciation where they differ (separate "finance books"). | C | 3 |
| FR-FA-006 | Construction in progress: collect costs before an asset is ready, then capitalize. | S | 2 |
| FR-FA-007 | Asset value adjustments, impairment, and revaluation. | C | 3 |
| FR-FA-008 | Asset maintenance schedules and history. | C | 3 |

### 9.8 Tax engine

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-TX-001 | Configurable tax codes: 12% VAT, zero-rated, exempt, percentage tax, with effective dates. | M | 1 |
| FR-TX-002 | ATC code library for expanded and final withholding, with rates and effective dates, maintained centrally by DCP. | M | 1 |
| FR-TX-003 | Input VAT, output VAT, and withholding summaries per period and branch. | M | 1 |
| FR-TX-004 | Applicable return worksheets with transaction drill-down: Phase 1 2550Q, 0619-E and 1601-EQ; 1601-FQ, GRT and other returns become release gates whenever the selected cohort requires them. 1604-E is Phase 2 unless its due date falls inside the pilot obligation window. | M | 1 applicable; 2 remainder |
| FR-TX-005 | Filing tracker: due dates, status, confirmation reference, and attached BIR acknowledgement email. | S | 1 |
| FR-TX-006 | Tax rules and item tax templates that pick the right VAT and withholding treatment from customer or supplier type, item, and location (for example ecozone zero-rated or VAT-exempt items). | M | 1 |
| FR-TX-007 | BIR correspondence tracker: letters of authority, notices, assessments, and requests, each with deadlines, assigned owner, documents submitted, and status. | M | 1 |
| FR-TX-008 | Annual income tax worksheet with the reconciliation from the financial statements to the return, including non-deductible items and timing differences. | S | 2 |
| FR-TX-009 | Year-end submission bundle for the audited financial statements and their attachments, assembled with the file names and formats the BIR expects. | S | 2 |
| FR-TX-010 | Sales and purchases reconciliation in one report: books against returns, against the summary lists, and against what was accepted by the BIR e-invoicing system, with differences explained line by line. | M | 1 |

### 9.9 Documents, integrations, and platform

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-PL-001 | Attach files with checksums, version history, tenant permissions and the approved record-class retention/legal-hold policy. JANUS is a candidate adapter subject to qualification, not an assumed dependency. | M | 1 |
| FR-PL-002 | REST API and webhooks for all main records, secured and rate-limited. | M | 1 |
| FR-PL-003 | Spreadsheet import templates with validation for customers, suppliers, items, opening balances, and open invoices, delivered through the ingestion pipeline (FR-SH-006). | M | 1 |
| FR-PL-004 | Approval workflows configurable by document type, amount, and branch. | M | 1 |
| FR-PL-005 | Offline capture of drafts only (for example expense receipts on mobile), synced before posting. | C | 2 |
| FR-PL-006 | Validated payroll journal and 2316/1601-C data import from a retained payroll system in Phase 2; additional payroll integrations Phase 3. Any earlier obligation requires a supported import before activation. | C | 2 data; 3 connectors |
| FR-PL-007 | Guided import from other accounting systems and spreadsheets, including opening balances and open invoices. | S | 1 |
| FR-PL-008 | Print template designer for letterheads and layouts, with BIR-required invoice fields locked and always shown. | M | 1 |
| FR-PL-009 | No-code custom fields and form rules, kept separate from BIR-controlled fields. | S | 2 |
| FR-PL-010 | Import POS cashier closings (X and Z readings) and reconcile them with deposits. | S | 2 |
| FR-PL-011 | Removed from scope. Shareholder registers and share transfers remain corporate secretarial work outside LARA. | Removed | Removed |
| FR-PL-012 | Client AI integrations through a qualified gateway, scoped identities and allowlisted draft/report tools; no direct financial or production database authority. | S | 3 |
| FR-PL-013 | Pilot one justified messaging channel after core web workflows are stable. Identity binding, minimal sensitive content, permission checks and deep links to authenticated review are mandatory. | S | 2 |
| FR-PL-014 | No-code rule and agent builder for clients, limited to drafts, alerts, and reports; BIR-controlled behaviour cannot be changed. | C | 3 |
| FR-PL-015 | Guided setup and a simple mode: a short wizard with Philippine templates by business type and size, hiding advanced fields until they are switched on. | M | 1 |
| FR-PL-016 | Multi-client console for accounting and bookkeeping firms: one login across client companies, staff assignment, and a combined deadline and exception view, with strict data separation between clients. | S | 2 |

### 9.10 Philippine business practices

**Vouchers, approvals, and supplementary documents**

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-PH-001 | Check vouchers and disbursement vouchers with "prepared, checked, approved, received by" blocks, a supporting-documents checklist, and scanned signed copies attached. | M | 1 |
| FR-PH-002 | Check signatory matrix per bank account: how many signatories are needed and who, by amount; release log showing who received the check, with ID or authorization letter. | M | 1 |
| FR-PH-003 | Counter receipts: supplier submits an invoice and gets a numbered counter receipt; payments follow set check release days; payables aging can run by counter date. | S | 1 |
| FR-PH-004 | Numbered supplementary documents (collection receipt, acknowledgement receipt, provisional receipt, delivery receipt, billing statement, statement of account), each marked "not valid for claim of input tax". | M | 1 |
| FR-PH-005 | Cash and charge invoice types (paid now versus on account), with separate series if the client prefers. | S | 1 |

**Cash handling**

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-PH-006 | Daily collection report per cashier and branch, with cash count by bill and coin, deposit slip tracking, and cash over or short entries. | M | 1 |
| FR-PH-007 | Revolving funds and petty cash vouchers with replenishment reports and custodian accountability. | S | 1 |
| FR-PH-008 | Post-dated checks and cash advance liquidation (see FR-AR-020, FR-AP-009, FR-AP-010), plus a combined PDC calendar used by cash forecasting. | M | 1 |
| FR-PH-009 | Employee receivables (salary loans, cash advances) with deduction schedules shared with payroll. | S | 2 |

**Tax paperwork around each transaction**

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-PH-010 | Store supplier 2303, declarations and relevant exemption/zero-rating evidence with versions and expiry. VAT status is one input to eligibility; approved invoice, transaction and evidence checks determine proposed input VAT treatment. | M | 1 |
| FR-PH-011 | Customer compliance file: 2303, ecozone zero-rating certificates, and tax exemption certificates, applied automatically by tax rules. | S | 1 |
| FR-PH-012 | 2307 received tracking: expected versus received per customer and period, follow-up list, and link to the collection (feeds SAWT). | M | 1 |
| FR-PH-013 | Recognize withholding under the verified effective timing rule for the tax/transaction profile. Preserve accrual and payment dates, prevent duplicate recognition and route missing withholding to review before payment. | M | 1 |
| FR-PH-014 | Tax payment records: payment channel (eFPS, bank, e-wallet, online banking), reference numbers, proof of payment, and link to the return. | M | 1 |
| FR-PH-015 | BIR filing calendar based on the client's eFPS filing group, branches, and tax types, with reminders to preparers and approvers. | M | 1 |
| FR-PH-016 | Tracker for loose-leaf book binding and any required year-end submissions, per branch. | S | 1 |
| FR-PH-017 | Output VAT relief on uncollected receivables and the matching input VAT reversal for purchases not yet paid, where current EOPT rules allow (to confirm). | S | 2 |
| FR-PH-018 | Documentary stamp tax computation for loans, leases, and share issuances. Financial institutions use the fuller treatment in FR-FI-006. | C | 3 |

**Organization and government obligations**

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-PH-019 | Head office and branch accounts ("due to" and "due from"), inter-branch transfers, per-branch books, and head office roll-up. | M | 1 |
| FR-PH-020 | Local government obligations: business permit renewal, local business tax, real property tax, and community tax, with calendar and payables. | S | 2 |
| FR-PH-021 | Government contribution remittances from payroll (SSS, PhilHealth, Pag-IBIG contributions and loans) with remittance references. | S | 2 |
| FR-PH-022 | Statement layouts for full PFRS, PFRS for SMEs, and the small-entity framework; year-end pack for SEC and eAFS submissions. | S | 2 |

**Local channels**

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-PH-023 | Phase 1 one standard bank CSV import and tested check layout per pilot bank; additional Philippine bank formats and reference matching adapters arrive in Phase 2. | S | 1 basic; 2 adapters |
| FR-PH-024 | E-wallet and online marketplace payouts: split each payout into gross sales, platform fees, and any tax withheld by the platform, then reconcile the net deposit (rules to confirm). | S | 2 |
| FR-PH-025 | BSP reference exchange rates loaded for revaluation. | S | 2 |

**Industry habits**

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-PH-026 | Progress billing with retention (for example 10%), down payment recoupment, and retention release. | C | 2 |
| FR-PH-027 | Lease deposits, advances and escalations use effective-dated approved withholding and accounting rules; do not hard-code one rate for all parties or transaction types. | S | 2 |
| FR-PH-028 | Statutory discounts beyond senior citizen and PWD as configurable discount types with ID capture (scope to confirm). | S | 2 |
| FR-PH-029 | Phase 1 reviewed spreadsheet migration from manual books. Photo/OCR digitization AI-022 is Phase 2; all opening balances still require reconciliation and sign-off. | M | 1 manual; 2 AI |
| FR-PH-030 | Hand prepared returns and attachments to a BIR-accredited electronic tax service provider for filing and payment, and record the confirmation against the filing calendar. | S | 2 |
| FR-PH-031 | Branch daily close and shift handover: cut-off per branch, cash count and handover between cashiers with both signatures, and a daily pack that ties collections, documents issued, and deposits together. | M | 1 |

### 9.11 Financial institutions (first industry pack)

These requirements ship as a pack that is switched on for banks, quasi-banks, financing companies, and similar institutions. They are settings and modules on the same core, not a separate product.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-FI-001 | Gross receipts tax engine for institutions taxed under the percentage tax rules instead of VAT: rates by income type and by the remaining maturity of the instrument, with the return worksheet and drill-down to transactions. | M | 1 |
| FR-FI-002 | Support passed-on GRT and related income treatment only through institution-specific rules approved by the tax advisor, with source citations and effective dates. | S | 1 conditional |
| FR-FI-003 | Invoice behaviour for institutions not subject to VAT: non-VAT invoice layout and wording, with VAT still applied to any lines that remain VATable. | M | 1 |
| FR-FI-004 | Final withholding on applicable passive-income payments with certificates, alphalists and remittance worksheets, or a documented retained-source-system boundary with reconciled outputs. No incomplete live tax workflow. | M | 1 applicable |
| FR-FI-005 | Separate RBU and FCDU books, functional currencies and combined management view. Bank replacement or pilot scope requiring these books is blocked until this and FR-GL-008 are validated, or books remain explicitly in the authoritative source system. | M | 2 conditional |
| FR-FI-006 | Instrument-specific DST calculations, return and payment evidence. Required before any in-scope obligated workflow; otherwise retain the verified source-system calculation and reconciled hand-off. | M | 2 conditional |
| FR-FI-007 | Approved account mapping from each pilot source to LARA and statutory outputs is required in Phase 1. A reusable BSP-aligned reporting template is Phase 2; this is not a claim to provide the full BSP reporting suite. | M mapping; S template | 1 mapping; 2 template |
| FR-FI-008 | Interface to core banking and other source systems: scheduled journals, subsidiary ledger balances, automatic reconciliation against control accounts, and a queue for rejected entries. | M | 1 |
| FR-FI-009 | Branch books, codes, inter-branch reconciliation and roll-up at the signed pilot capacity profile. Hundreds-of-branches support is a later scale claim requiring demonstrated load and operational acceptance. | M | 1 pilot; later scale |
| FR-FI-010 | Read-only, fully logged access for internal audit, external auditors, and regulators, with export of the records and logs they ask for. | M | 1 |
| FR-FI-011 | Trust/fiduciary books remain in a named authoritative source until separate-book capability is released. In-scope trust activity blocks replacement go-live without complete validated accounting, reporting and reconciliation. | C | 3 conditional |

### 9.12 Audit and control support

Internal audit, external auditors, and examiners are users of the system, not visitors to it. These requirements give them what they normally ask for by email, and they are deterministic checks, not AI suggestions.

| ID | Requirement | Priority | Phase |
| --- | --- | --- | --- |
| FR-AU-001 | Full population data extract for a chosen period in a standard format, with a checksum, so auditors can test every transaction rather than a sample taken from the screen. | M | 1 |
| FR-AU-002 | Journal entry testing view: all entries with who created, who approved, the time posted, the source module, round amounts, weekend and after-hours postings, and entries to unusual account pairs. | M | 1 |
| FR-AU-003 | Rule-based control monitoring, separate from the AI layer: segregation-of-duties conflicts, dormant or shared accounts, postings outside business hours, and approval limits bypassed, each with the evidence attached. | M | 1 |
| FR-AU-004 | Periodic user access review: the system asks owners to confirm or remove each person’s access on a schedule, and keeps the signed result. | M | 1 |
| FR-AU-005 | Auditor workspace: a request list (prepared by client) with owners and status, document upload against each item, and read-only drill-down from the trial balance to the source record. | S | 2 |
| FR-AU-006 | Balance confirmation letters to customers and suppliers, with replies logged against the account. | C | 2 |

## 10. BIR compliance requirements

Each item maps to the Annex B checklist. The completed checklist is signed by both the client and DCP at registration.

### 10.1 Invoice content (COMP-INV)

| ID | Requirement | Notes |
| --- | --- | --- |
| COMP-INV-001 | The system, not the user, generates the serial number, printed prominently with at least six running digits and leading zeros. | Replaces the draft's five-digit example. |
| COMP-INV-002 | Show seller's registered name, registered address, "VAT REG TIN" or "NON-VAT REG TIN" with branch code, and transaction date. | Trade name optional. Business style is no longer required. |
| COMP-INV-003 | Show buyer identifiers when required by the current advisor-approved invoice profile, including transaction thresholds, taxpayer type and exceptions. Do not rely on an unverified single threshold. | Threshold and exceptions require current primary-source verification. |
| COMP-INV-004 | Show quantity, description, unit price, line and total amounts, VAT amount, and breakdown of VATable, exempt, and zero-rated sales for mixed transactions. |  |
| COMP-INV-005 | Apply exemption wording only where the verified invoice and tax profile requires it; distinguish VAT-exempt, non-VAT and percentage-tax treatment. |  |
| COMP-INV-006 | Print Acknowledgement Certificate number, date issued, and series range at the bottom, pulled from setup. | Any required validity phrase to be confirmed against current EOPT rules. |
| COMP-INV-007 | Print "THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX" on supplementary documents. |  |
| COMP-INV-008 | Print "REPRINT" on every copy after the first; log each reprint with user and time. |  |
| COMP-INV-009 | Produce at least an original for the buyer and a retained copy for the seller. | Electronic copies count as retained copy. |
| COMP-INV-010 | Enforce issuance thresholds by setting: VAT-registered sellers issue invoices regardless of amount; others for ₱500 or more. | Threshold adjusts periodically; keep configurable. |
| COMP-INV-011 | Warn when a series range is 80% used and block issuance past the registered range. |  |
| COMP-INV-012 | Record manual invoices issued during system downtime under their own series, clearly labeled. |  |
| COMP-INV-013 | Support configurable QR content and verifiable read-back. Draft-circular QR particulars are pending final verification, not a universal current legal rule. | Pending final primary authority; see section 7. |
| COMP-INV-014 | Generate structured electronic invoice data that can be extracted and transmitted under the applicable requirements; keep customer delivery evidence and distinguish issuance from live sales reporting. A scanned paper image alone is not structured invoice data. | Drives the data model and the delivery log. |
| COMP-INV-015 | Posted invoices are immutable. Use the effective, advisor-approved correction document and original-reference rules; the draft credit-note/additional-invoice prescription remains conditional until verified. | Draft-specific route pending verified final authority. |
| COMP-INV-016 | Record manual invoices used during downtime (system failure, no internet, power loss, cyber incident, or force majeure) and load them back into the system once it is running. | Extends COMP-INV-012 with the reasons named in the draft circular. |
| COMP-INV-017 | Register of voided, cancelled, and unused document numbers, plus a gap report per series and branch, ready to print for an examiner. | Examiners ask for this early in a review. |

### 10.2 Books of accounts (COMP-BOA)

| ID | Requirement |
| --- | --- |
| COMP-BOA-001 | One-click General Journal and General Ledger: date, reference, description, account title or code, debit, credit. |
| COMP-BOA-002 | Sales Journal: date, customer TIN, customer name or code, address, description, document number, amount, discount, output VAT, net sales. |
| COMP-BOA-003 | Purchase Journal: date, supplier TIN, supplier name or code, address, description, document number, amount, discount, input VAT, net purchases. |
| COMP-BOA-004 | Cash Receipts Journal and Cash Disbursements Journal. |
| COMP-BOA-005 | Inventory Book: date, product name or code, description, unit, price per unit, amount. |
| COMP-BOA-006 | Every book, statement, and report shows registered name, address, TIN with branch code, software name and version, user who ran it, and date and time generated. |
| COMP-BOA-007 | Reports cannot be edited inside the system; exports to CSV and DAT are available. |
| COMP-BOA-008 | Loose-leaf printing with page numbering and binding-ready layout. |
| COMP-BOA-009 | Annual soft copy of books in Standard Audit File format with a transmittal letter listing file names, types, and sizes, ready within 30 days after the close of the taxable year. |
| COMP-BOA-010 | Certification page for printed or exported books, naming the responsible officer, the period covered, the number of pages or records, and the software name and version. |

### 10.3 Audit trail and controls (COMP-AUD)

| ID | Requirement |
| --- | --- |
| COMP-AUD-001 | Append-only activity log of all creates, posts, voids, approvals, logins, report runs, exports, and setting changes, with before and after values. |
| COMP-AUD-002 | Store immutable system posting timestamp separately from accounting date, document date and applicable tax date. Validate accounting date against period controls and preserve all dates in exports. |
| COMP-AUD-003 | No deletion or editing of posted records. Journals use linked reversals; invoices use correction documents allowed by the effective regulatory profile. Retain voided numbers, reason, approvals and original evidence. |
| COMP-AUD-004 | Every record stores the user ID of its creator and each approver. |
| COMP-AUD-005 | Automatic cross-checking of totals (ledger vs. sub-ledgers, journals vs. GL) with alerts on any out-of-balance condition. |
| COMP-AUD-006 | Log is tamper-evident (hash-chained) and protected from change by any role, including administrators. |
| COMP-AUD-007 | Log can be filtered, printed, and exported for examiners. |
| COMP-AUD-008 | Database-level changes to critical tables are also logged. |

### 10.4 Registration and change control (COMP-REG)

| ID | Requirement |
| --- | --- |
| COMP-REG-001 | Generate a registration pack: sample invoices and memos, sample books, printed audit trail, pre-filled system description, and Annex B checklist. |
| COMP-REG-002 | Support the Joint Sworn Statement process, since a system maintained by a third-party provider uses the joint form. |
| COMP-REG-003 | Classify every release as minor or major. A major enhancement, such as a change in functionality, requires an updated registration. Major releases are flagged to clients with a re-registration pack. |
| COMP-REG-004 | Display software name and version everywhere required, matching what was declared. |
| COMP-REG-005 | Generate a PTI application pack if required by verified effective rules; draft-circular fields are preparatory and cannot be represented as authority-approved requirements. |
| COMP-REG-006 | Assess product, platform and core-system changes against applicable registration and permit rules before release; maintain authority-reviewed impact evidence rather than assuming every change has the same filing route. |
| COMP-REG-007 | Export registration and permit packs as PDF, JPEG, or PNG within the file size limits of the BIR online registration system. |
| COMP-REG-008 | Record permit scope and branch coverage based on verified authority instructions; prepare branch notices or applications accordingly. Do not assume one permit covers every branch. |

## 11. E-invoicing module

LARA owns the customer outcome for issuance, delivery and applicable sales reporting. SyncTax is a candidate implementation behind the LARA contract, subject to qualification; customers should not need to operate a second work queue. Issuance and reporting are separate obligations and statuses. Credentials, permits, deadlines and allowed correction documents follow verified taxpayer-specific rules.

| ID | Requirement | Priority |
| --- | --- | --- |
| INT-EIS-001 | Commit the posting and durable outbound event atomically. Only applicable document types enter transmission under the active regulatory profile; external service response never controls the local transaction commit. | M |
| INT-EIS-002 | Serialize, sign and transmit using the certified adapter and taxpayer-specific active reporting profile. Apply verified deadlines, including a three-day window only where applicable; track the legal basis and effective date. | M |
| INT-EIS-003 | Separate accounting, buyer delivery, reporting and settlement statuses. Reporting includes not yet applicable, queued, sending, unknown acknowledgement, accepted and rejected, with timestamps and authoritative response references. | M |
| INT-EIS-004 | Rejections and uncertain acknowledgements enter the owned task queue. Reconcile remote status before retry; transport repairs retain payload history, while financial corrections create linked documents, never edit posted invoices. | M |
| INT-EIS-005 | Alerts use the effective reporting deadline and escalation owner. Bound retries with backoff and deduplication; expose service outages, remaining time and approved contingency procedure. | M |
| INT-EIS-006 | Daily reconciliation of documents issued versus documents accepted by the BIR. | M |
| INT-EIS-007 | Onboarding guide for each client's own EIS credentials. Production transmission needs the taxpayer's own EIS certification and permit to transmit. | M |
| INT-EIS-008 | Secure storage and rotation of each client's signing keys and credentials. | M |
| INT-EIS-009 | Optional hand-off to an outside e-invoicing solution provider through the LARA API, for clients who prefer one. | S |
| INT-EIS-010 | Version formats, endpoints and deadlines. Simple parameter changes use tested configuration; schema, signing or protocol changes may require adapter code, certification and controlled release. | M |
| INT-EIS-011 | Keep issuing and reporting separate: every invoice is built so its data can be sent, while live transmission is a setting turned on per company when the taxpayer is covered or notified. | M |
| INT-EIS-012 | Check each document against the BIR data list before sending, explain failures in plain language, and offer a fix. | M |
| INT-EIS-013 | Generate and validate QR content when required by the active approved invoice profile; preserve the profile version used. | M |
| INT-EIS-014 | Keep a full evidence pack for each document: the file sent, the signature, the BIR reply, and any repair history, for the full retention period. | M |
| INT-EIS-015 | Support linked electronic correction documents under the verified active rules; reconcile their financial and reporting effects with the original. | M |

## 12. AI requirements and differentiators

Guiding rule: AI prepares, a person posts.

LARA enforces immutable posted records and accountable review. AI prepares drafts and explanations; deterministic services enforce posting, tax calculations, permissions and period controls. A named authorized person approves each consequential action.

### 12.1 Guardrails (apply to every AI feature)

| ID | Requirement |
| --- | --- |
| AI-GR-001 | AI can only create drafts, suggestions, and alerts. It never posts, voids, approves, or changes a posted record. |
| AI-GR-002 | Store model/prompt/rule versions, permission context, source references, output, review disposition and an uncertainty indicator where meaningful. Confidence is not a legal conclusion or a substitute for evaluation. |
| AI-GR-003 | The AI layer is separate from the registered accounting rules, so model updates do not change how invoices or books are produced. |
| AI-GR-004 | AI respects the user's permissions; it cannot show data the user cannot see. |
| AI-GR-005 | Contractually control model-provider training, retention, processing region and subprocessors. No shared-model training or cross-tenant learning from client data without explicit authorized consent and privacy review. |
| AI-GR-006 | Each AI feature can be switched off per company. |
| AI-GR-007 | Answers about numbers always show the source records they came from. |

### 12.2 Standard AI features

These are candidate assistive capabilities. Release priority depends on validated user benefit, evidence quality and acceptance criteria, not an assumed market standard.

| ID | Feature | Target | Phase |
| --- | --- | --- | --- |
| AI-001 | Bill and receipt capture. Read supplier invoices (photo, PDF, email) and fill supplier, TIN, number, date, lines, VAT, and withholding; flag missing BIR invoice details. | 70% of bills need no field change | 1 |
| AI-002 | Smart coding. Suggest account, dimensions, tax code, and ATC code; learn from corrections. | 85% suggestion acceptance after 3 months | 1 |
| AI-003 | Deterministic pre-filing reconciliation and schema checks, with optional AI explanations. External acceptance is measured separately and is not guaranteed. | All agreed deterministic cases pass; external rejections tracked separately | 1 |
| AI-004 | E-invoice fix helper. Explain e-invoice rejections from the BIR and propose the correct memo or fix. | Rejections resolved within 1 day | 1 |
| AI-005 | Migration helper. Map old chart of accounts and spreadsheets to the new structure. | Migration effort cut by half | 1 |
| AI-006 | Bank matching. Match statement lines to invoices and bills, including partial and grouped payments. | 80% auto-matched | 2 |
| AI-007 | Anomaly watch. Flag duplicate bills, unusual amounts, odd-hour postings, void clusters, and segregation-of-duty breaches. | Weekly digest to Finance Director | 2 |
| AI-008 | Ask your books. Answer plain-language questions in English or Filipino with linked sources. | Answers traceable to records | 2 |
| AI-009 | Close helper. Run the close checklist, suggest accruals, and write variance explanations. | Close in 5 days or less | 2 |
| AI-010 | Collections helper. Predict late payers and draft reminders for a person to send. | Lower days sales outstanding | 2 |
| AI-011 | Audit helper. Assemble records and logs for an examiner's request; draft the registration system description. | Request packs in under 1 hour | 2 |
| AI-012 | Rule-change watch. Summarize new BIR issuances and propose setting or template updates for approval. | Review within 5 days of issuance | 3 |

### 12.3 DCP differentiators

These features are built around Philippine rules and habits, and they are where the product should stand out. All of them follow the guardrails in 12.1. Their differentiation and demand remain hypotheses to validate; deterministic checks continue to work with AI disabled.

To keep the product small, these features are not separate products. They are behaviours of six agents that share one inbox, one guardrail set, and one audit trail: capture (documents in), coding and matching (where things belong), compliance watch (permits, filings, and readiness), cash and collections, close, and audit support. A new AI feature is usually a new behaviour of an existing agent, not a new module.

**Readiness and tax evidence**

| ID | Feature | What it does | Why it stands out | Phase |
| --- | --- | --- | --- | --- |
| AI-013 | Readiness evidence view | Readiness evidence view derived from deterministic checklist results, missing evidence and blocking issues; AI may explain. A score cannot mask blockers or be described as regulatory certification. | Explains readiness without claiming assurance. | 1 |
| AI-014 | Mock BIR audit | Runs the tests examiners commonly do (sales versus returns, expenses without withholding, input VAT without valid invoices, 2307 versus SAWT) and estimates possible exposure for the tax advisor to review. | Finds problems before the Letter of Authority arrives. | 2 |
| AI-015 | Missed-withholding finder | Deterministic screening for possible missed withholding with rule citations and source evidence; optional AI explanation suggests review, not a conclusive liability determination. | Evidence-linked local review in the transaction workflow. | 1 |
| AI-016 | Input VAT guard | Invoice and party-status evidence checks with uncertainty shown; OCR is advisory and tax eligibility follows approved rules and human review. | Evidence-linked local review in the transaction workflow. | 1 |
| AI-026 | Rule-to-setting assistant | Suggest rule-setting changes and test cases from cited issuances for qualified review. Assess whether configuration, software or certification changes are necessary; never activate rules autonomously. | Evidence and impact preview for controlled change. | 3 |
| AI-027 | Deadline and penalty guard | Warns about upcoming filings and estimates penalties if late, using rates DCP maintains. | Makes the cost of delay visible. | 2 |

**Capture the way Filipinos actually work**

| ID | Feature | What it does | Why it stands out | Phase |
| --- | --- | --- | --- | --- |
| AI-017 | Handwritten invoice reader | Reads handwritten and pre-printed manual invoices, including printer and authority-to-print details. | Many local suppliers still issue handwritten invoices. | 2 |
| AI-018 | Chat-app capture | One validated messaging channel may accept receipt photos or English/Filipino input as drafts. Identity, permissions and explicit review apply; external instructions are untrusted evidence, not authorization. | Meets users in the apps they already use daily. | 2 |
| AI-020 | PDF bank statement reader | Reads PDF statements from local banks that do not offer clean exports. | Removes manual encoding before reconciliation. | 2 |
| AI-022 | Manual books digitizer | Reads photos of columnar books and ledgers to build opening balances and history. | Makes switching from manual books fast. | 2 |
| AI-021 | Contract to schedule | Reads lease and service contracts through a qualified document adapter and proposes recurring billing, escalations, deposits, and withholding. | Proposes schedules for accounting review with linked contract evidence. | 2 |

**Cash and collections**

| ID | Feature | What it does | Why it stands out | Phase |
| --- | --- | --- | --- | --- |
| AI-019 | 2307 chaser | Predicts which customers still owe 2307s, drafts follow-ups, reads received 2307 files, and matches them to collections. | Connects missing certificates to the collection workflow. | 2 |
| AI-023 | AI finance brief | A monthly owner's brief in English or Filipino: what changed, why, and what to do, with a cash forecast that includes the post-dated check calendar. | Forecasts reflect how local businesses really get paid. | 2 |

**Control and fraud prevention**

| ID | Feature | What it does | Why it stands out | Phase |
| --- | --- | --- | --- | --- |
| AI-024 | Review assistance | Advisory risk indicators with source evidence before approval; never a substitute for the required independent human approver. | Helps reviewers focus on evidenced exceptions. | 2 |
| AI-025 | Fraud pattern watch | Flags suppliers whose TIN or bank account matches an employee, purchases split to stay under approval limits, check number gaps, and look-alike duplicate invoices. | Goes beyond simple duplicate checks. | 2 |

**Working with the system**

| ID | Feature | What it does | Why it stands out | Phase |
| --- | --- | --- | --- | --- |
| AI-028 | Report builder by conversation | "Show sales by branch compared with last year" becomes a saved, reusable report. | No report-writing skills needed. | 2 |
| AI-029 | Shared work queue | AI suggestions enter the existing Phase 1 human task service; no separate agent inbox. Additional AI behaviors arrive progressively after measured benefit and safety evaluation. | Review AI drafts in the existing authorized task flow. | 1 foundation; 2 expansion |
| AI-030 | Accounting firm cockpit | AI prioritization extends the Phase 2 multi-client console FR-PL-016, preserving explicit company context and isolated permissions. | Opens a channel through local accounting firms. | 3 |
| AI-031 | Tax computation helper | Shows side-by-side computations such as itemized versus optional standard deduction, for the advisor to review. | Informs decisions without giving advice on its own. | 3 |
| AI-032 | Peer benchmarks | With client consent, compares margins and collection days against anonymized peers in the same industry. | Insight that grows as the client base grows. | 3 |

Positioning in one line

LARA helps Philippine finance teams complete daily work and explain their books through connected evidence, clear exceptions and optional AI assistance.

### 12.4 Requirement integrity

The nine phase-only rows at the end of the original AI table contain no recoverable IDs or feature descriptions and are not valid approved requirements. Their labels mentioned elsewhere are captured below as newly specified requirements; no missing source text is claimed to have been recovered.

- AI-033 Registration drafting assistant, Phase 1 optional: assemble an evidence-linked application narrative; show every missing artifact; never attest or sign for the taxpayer/provider.
- AI-034 Evidence-backed task explanations, Phase 1: explain deterministic failures with source records and rule versions; abstain when evidence is missing.
- AI-035 Historical rule explanation, Phase 2: display which approved rule version applied at the transaction date, with links; changes cannot rewrite historical postings.
- AI-036 Cash action suggestions, Phase 2: propose collection or payment actions from reconciled data, distinguish uncleared checks from available cash and require human authorization.
- AI-037 Audit request assembly, Phase 3: prepare a scoped evidence manifest from authorized records; show gaps and require reviewer release. Reuses AI-011 and the shared evidence service.

Supplier inbox, document reminders and client agents remain FR-AP-014, FR-SH-009/010 and FR-PL-012/014, not separate products. No autonomous external messaging, bank instruction, filing, posting or approval is authorized by any AI requirement.

## 13. Reports and statutory outputs

| ID | Output | Rule | Phase |
| --- | --- | --- | --- |
| RPT-001 | 2550Q worksheet with SLSP (RELIEF DAT) | SLSP must agree with the return and ledger before export. | 1 |
| RPT-002 | 0619-E and 1601-EQ worksheets with QAP DAT | One QAP file per month of the quarter. | 1 |
| RPT-003 | Form 2307 per payee, emailed with delivery log | Annex B asks how certificates are sent. | 1 |
| RPT-004 | SAWT DAT from 2307s received | Must match the certificates, or tax credits can be disallowed. | 2 |
| RPT-005 | 1604-E and annual alphalist | Must reconcile with the quarterly lists. | 2 |
| RPT-006 | 2306 in Phase 1 for obligated taxpayers; 2316 from validated external payroll data in Phase 2 or earlier if required by the selected scope. | 2316 fed from payroll import. | 1 applicable; 2 payroll |
| RPT-007 | Phase 1 trial balance, balance sheet and income statement reconciled to the ledger. Cash flow, changes in equity, notes and other statutory formats must also be available before any in-scope reporting obligation; Phase 2 expands standard packs. | By period, branch, and dimension; PFRS layout. | 1 core; 2 expansion |
| RPT-008 | Receivables and payables aging, statements, customer and supplier ledgers |  | 1 |
| RPT-009 | Management dashboards: cash position, sales, margins, tax due calendar |  | 2 |
| RPT-010 | Consolidated statements | For multi-company groups. | 3 |
| RPT-011 | Post-dated check register, check register, and unliquidated cash advance report | Daily use by treasury and accounting. | 1 |
| RPT-012 | Trial balance by customer and supplier, customer credit balances, budget versus actual, deferred revenue schedule | Frequently asked for by finance teams and auditors. | 2 |
| RPT-013 | Reconciliation pack: sales and purchases per books, per returns, per summary lists, and per documents accepted by the BIR | Differences explained line by line before filing. | 1 |
| RPT-014 | Close status and account substantiation report | Shows which tasks and accounts are still open, by entity and branch. | 1 |
| RPT-015 | Void, cancelled, and unused document register with series gaps | Printed for examiners on request. | 1 |

## 14. Non-functional requirements

### 14.1 Security (from Annex B and good practice)

| ID | Requirement |
| --- | --- |
| NFR-SEC-001 | Documented request and approval process for giving access; access changes logged. |
| NFR-SEC-002 | Session controls follow the applicable verified registration profile; provide clear reauthentication and draft recovery. Do not weaken an applicable single-session control without authority approval. |
| NFR-SEC-003 | Account lockout after a configurable number of failed logins (default 5). |
| NFR-SEC-004 | Mandatory MFA for privileged and approval roles; support SSO and strong authentication. Apply password rotation/session settings required by the verified Annex B profile, documenting any conflict with modern identity practice and the approved resolution. |
| NFR-SEC-005 | Access removed or changed the same day an employee leaves or moves roles; SSO de-provisioning supported. |
| NFR-SEC-006 | Encryption in transit (TLS 1.2 or higher) and at rest. |
| NFR-SEC-007 | Accounting data reachable only through the application's authorized functions, not directly. |
| NFR-SEC-008 | Hosting in data centers that are access-controlled and protected from power loss and fire; firewall traffic monitored. |
| NFR-SEC-009 | Tenant data isolation (row-level security or separate databases). |
| NFR-SEC-010 | Segregation-of-duties rules enforced and conflicts reported. |
| NFR-SEC-011 | Yearly penetration test and vulnerability scanning in the release pipeline. |
| NFR-SEC-012 | Security assurance roadmap with owner, cost and scope; ISO/IEC 27001 certification is a proposed milestone subject to assessment, not a promised first-year outcome. |
| NFR-SEC-013 | Qualify one supported cloud deployment initially; private cloud/on-premise and financial-sector hosting arrangements require separate operational, security and recovery acceptance before sale. Contractual residency is verified across backups, telemetry, support and AI. |
| NFR-SEC-014 | Single sign-on and automated provisioning from the client’s identity system, so joiners, movers, and leavers are handled centrally and access reviews stay accurate. |
| NFR-SEC-015 | Security events and the audit log can be forwarded to the client’s monitoring system in a standard format, without giving that system access to accounting data. |

### 14.2 Other quality requirements

| ID | Area | Requirement |
| --- | --- | --- |
| NFR-DAT-001 | Retention | Record-class retention with effective legal basis, trigger date, customer policy and holds. RR 7-2024 Section 4 provides a general five-year books/records period; longer applicable sector, contract or dispute requirements may apply. Do not equate backup rotation with legal archive retention. |
| NFR-DAT-002 | Backup | Daily backups, point-in-time recovery, copies in a second location; restore tested every quarter and documented for registration. |
| NFR-DAT-003 | Recovery | Recovery point of 15 minutes or less; recovery time of 4 hours or less. |
| NFR-DAT-004 | Privacy | Data Privacy Act compliance: privacy notice, data processing agreement with each client, breach process, and data subject requests. |
| NFR-DAT-005 | Residency | Hosting region agreed with each client and stated in the contract. |
| NFR-PER-001 | Speed | Pilot targets: p95 interactive response under 2 seconds and local invoice posting under 1 second, excluding external acknowledgements, under an agreed workload, device and network profile. Measure end-to-end user time separately. |
| NFR-PER-002 | Volume | Before build commitment, approve a capacity profile covering tenants, branches, peak posts, lines, retention and concurrent reports. Validate target full-year GL export under 60 seconds at that profile; larger exports may use an asynchronous job with visible progress. |
| NFR-PER-003 | Concurrency | Unique serial numbers under concurrency, with no silent reuse or unexplained gaps. Preserve issued, void, failed/reserved and cancelled number evidence according to the approved numbering profile; test crashes and retries. |
| NFR-AVL-001 | Availability | 99.5% monthly uptime, with planned maintenance outside business hours. |
| NFR-USE-001 | Usability | Web app usable on desktop and mobile; plain-language screens; English first, Filipino for key screens and AI chat. |
| NFR-USE-002 | Accessibility | Target WCAG 2.2 AA for all critical journeys, including authentication, capture, approval and recovery; verify keyboard, focus, screen-reader and error handling behavior. |
| NFR-OPS-001 | Monitoring | Error, performance, and e-invoicing queue monitoring with alerts. |
| NFR-OPS-002 | Releases | Versioned releases with change notes; minor versus major classification per COMP-REG-003. |
| NFR-DAT-006 | Privacy | Assess and fulfill applicable NPC DPO and processing-system registration requirements, with documented applicability and current registration evidence where required. |
| NFR-DAT-007 | Hosting | Philippine hosting offered as the default for clients who want their data kept in the country. |
| NFR-OPS-003 | Rules | Every tax rule, rate, and template is versioned with effective dates, so any past period can be explained under the rules that applied then. |
| NFR-DAT-008 | Non-production | Test and training environments use masked data, and never carry live TINs, names, or bank details. |
| NFR-DAT-009 | Legal hold | Records under examination or dispute can be placed on hold so retention rules never remove them. |

## 15 Migration and go live

Agree a cutover and authority profile with the client controller and tax advisor. Before moving data, define which system is authoritative for each book, transaction, document series, tax calculation and source schedule. Only in-scope records move; retained core-banking, asset, inventory, payroll or trust data require signed interfaces and reconciliation boundaries.

Migrate approved masters, opening trial balance and open items, plus detailed supporting schedules where LARA assumes ownership. Record file checksums, counts, totals, mapping versions and approvals. AR/AP detail must exactly tie to controls; unresolved differences have owners and cannot silently become opening equity or suspense. Replaying an import cannot duplicate balances.

Retire only the series and books whose ownership transfers, recording their final numbers and dates. Prevent overlapping live issuance or duplicated postings between systems. Retained series continue only in their approved scope. Agree which historical records are fully migrated, summarized or retained with accessible evidence.

Complete a representative parallel-close rehearsal covering the scoped journeys, tax outputs, source interfaces and corrections before production activation. Reconcile opening and closing balances, certify required external credentials and complete role-based practice tasks. A waiver of a material control or missing accounting capability is not a completed gate.

Before issuance, test rollback of configuration/imports. After official issuance, continuity requires preservation and reconciliation of issued documents, controlled corrections and an approved downtime procedure, not a destructive restore that loses new obligations. Assign a DCP support owner, customer incident owner and first-close support plan. Export/exit must preserve usable masters, transactions, attachments, audit history and report versions.

## 16 Architecture and technology

Recommendation for Engineering Lead approval: begin with a modular application core and relational ledger, with separate background workers for document processing, reporting, integrations and optional AI. Preserve clear module interfaces; split services only when measured scaling, security or ownership demands it. A small shared engine set does not eliminate domain-specific accounting tests.

DCP's TypeScript/PostgreSQL option is the provisional default if team experience is confirmed. A named Python framework remains an alternative only after its actual license, support, extension boundaries and operational fit are reviewed. No framework is selected by this BRD. Use an architecture decision record and a vertical-slice prototype to prove posting integrity, tenant isolation, report performance and recovery.

The accounting core uses fixed-precision amounts, explicit rounding and currency policies, database transactions and controlled number allocation. Commit a durable outbound event with posting, then deliver asynchronously with idempotency and reconciliation of unknown acknowledgements. Do not claim exactly-once network delivery; demonstrate no duplicate financial effect under retries.

Version schemas, tax rules, document templates, source mappings and integration contracts. Metadata controls supported variation but cannot safely replace all code changes. Exports and regulatory packs must be reproducible from a defined data cut-off and rule version.

AI accesses allowlisted tools through the same tenant, record and field permissions as the user. A semantic reporting layer supplies approved measures and read-only queries. AI receives no unrestricted SQL or production credentials. Documents and retrieved text are untrusted input; their instructions cannot grant authority.

SyncTax, JANUS, GAIA and Daedalus are reuse candidates reported in the source BRD, not independently inspected assets. Qualify each for API contract, license, tenant isolation, deployment, data residency, failure behavior, performance, support ownership and cost. Record adopt/adapt/build decisions and a fallback before making the pilot dependent on them.

AI coding tools are optional development aids. Named engineers own design and review; accounting specialists own golden transaction cases. Dependencies still carry license obligations. Maintain dependency inventory, security scanning and release evidence. Faster code generation is not an estimate of implementation or assurance effort.

## 17 Simplification and seamless experience

Expose five role-filtered workspaces: My work, Money in, Money out, Close and Compliance. Reports, evidence search and configuration are shared utilities. Agent names and internal engines should not be primary navigation. SMEs see only enabled tasks; bank staff see authorized entity and branch context persistently.

| Consolidation | User benefit | Control retained |
| --- | --- | --- |
| One transaction record and timeline | Reuse fields and evidence across capture, approval, payment and reporting | Separate state transitions, permissions and immutable accounting |
| One treasury journey | Vouchers, signatories, PDCs and release evidence in context | Payment authorization and settlement remain distinct |
| One reconciliation service with purpose-specific views | Resolve differences without maintaining separate spreadsheets | Matching is distinct from recognition, write-off and netting |
| One obligations and task service | Filings, certificates, permits and rejections have owners and next actions | Applicable due dates, escalation and completion evidence |
| One party identity with protected roles | Stop re-entering tax data | No automatic AR/AP offset or disclosure of employee data |
| One assisted review surface | Compare source, draft, rule and changes side by side | Human approval; uncertain fields and blockers remain visible |
| One setup and first-close journey | Configuration, import, rehearsal and reconciliation stay connected | Advisor and controller acceptance before live use |

Defer broad report designers, multiple chat channels, client agent builders and peer benchmarks until core adoption is demonstrated. Prefer reviewed templates and one useful adapter over a generic no-code engine. Simple mode reduces visible fields and optional steps; it does not reduce required controls.

Measure improvement from the same representative baseline tasks: median and p90 completion time, hand-offs, repeated fields, rework and material errors. Target at least 30% lower median handling time for pilot bill entry and exception resolution without a higher material error rate; this is a proposed pilot threshold, not an achieved result.

## 18 Assumptions and constraints

The bank-first direction is retained as a commercial hypothesis. Institution type, design partner, processing volume, authoritative books and tax responsibilities require named-owner decisions. No bank-wide replacement, universal industry coverage or regulatory approval is implied.

Each taxpayer supplies accurate registration data, required credentials and a qualified advisor. Product and compliance maintain evidence-backed rule profiles. Regulatory changes may require configuration, code, testing and renewed authority assessment.

One managed cloud deployment is the proposed initial support model. Other hosting models require qualification and cost approval. Reuse assets, commercial pricing and third-party contracts have not been verified in this document review. Existing payroll, core banking and other excluded systems remain responsible for their documented boundary outputs.

## 19 Risks and responses

| Risk | Impact | Response and owner |
| --- | --- | --- |
| Pilot scope expands across incompatible cohorts | High | Product gates the selected end-to-end journeys, first close and capability matrix; price additional scope explicitly. |
| Required bank calculation or report is deferred | High | Controller signs retained-system boundaries; unsupported obligations block activation. |
| Regulatory or draft rules change | High | Tax lead verifies primary authority and effective dates; Engineering assesses settings, code, certification and registration impact. |
| Registration or examination reveals gaps | High | Evidence-linked checklist, advisor review and representative release tests; never promise authority approval. |
| Reused component fails qualification | High | Engineering owns fit-gap proof and fallback before schedule commitment. |
| AI misleads reviewers or exposes data | High | Security and Finance gate permissions, adversarial evaluation, material-error tests, source evidence and manual fallback. |
| Migration/source feeds duplicate or omit data | High | Controller and integration owner reconcile source totals, detect replay/missing batches and control cutover. |
| External reporting service is unavailable | High | Operations monitors queue age/deadlines, resolves unknown acknowledgements and runs an approved contingency process. |
| Single-user staffing conflicts with required approval | High | Product identifies ineligible workflows; customer supplies authorized independent review. AI does not substitute. |
| Financial-sector hosting and procurement take longer | High | Security and Operations qualify deployment, recovery and vendor-review evidence before commercial commitment. |
| DCP provider liability and unverified entity/brand | Medium | Legal confirms contracting/signatory entity, responsibilities, trademark/domain and applicable registration-change implications. |
| Customers expect filing or payment execution | Medium | Product states preparation versus execution clearly; qualify any later partner and record actual confirmation. |
| Alert burden and AI review erase savings | Medium | UX/process owner measures time, false alarms, rework and material errors; consolidate related tasks and remove low-value behavior. |
| Onboarding/support costs undermine repeatability | High | Finance/Product measure per-customer delivery hours, storage, AI and support cost before broad launch. |

## 20 Decisions required before pilot commitment

| Decision | Proposed default | Accountable owner | Due gate |
| --- | --- | --- | --- |
| Institution and design partner | One bank/FI cohort; explicit coexistence boundary | Product sponsor | Before scope commitment |
| Required currencies, books and taxes | Support fully or retain in a named reconciled authoritative source | Controller and tax lead | Before backlog baseline |
| Peak workload and availability | Profile from partner data; no generic bank-scale promise | Engineering and operations | Before capacity design |
| Regulatory profile and pending circular | Verified effective primary authority only | Tax/compliance lead | Before rules baseline and go-live |
| Stack and reusable components | Prototype modular core and qualify each dependency | Engineering Lead | Before production architecture |
| Cloud region and support access | One qualified deployment with end-to-end residency review | Security/privacy and operations | Before contract |
| Pilot pricing and delivery cost | Costed subscription and onboarding hypothesis, no invented prices | Product and finance sponsor | Before commercial offer |
| Brand and provider entity | Legal entity and trademark/domain checks | Product and legal | Before external launch |

Resolved for this draft: basic close and substantiation are Phase 1; goods customers cannot launch without their inventory dependencies; quotation and PO steps are conditional; AI never replaces a required approver; full firm-console and autonomous/client-agent ambitions remain later releases.

## 21. Glossary

AC: Acknowledgement Certificate, the BIR’s confirmation that a system is registered.

Annex B: the BIR checklist of functional and technical requirements for a CAS.

ATC: Alphanumeric Tax Code, used to classify withholding taxes.

CAS / CBA: Computerized Accounting System / Computerized Books of Accounts.

DAT file: the BIR’s text file format for alphalists and summary lists.

DST: Documentary Stamp Tax.

EIS: the BIR’s Electronic Invoicing System.

EOPT: the Ease of Paying Taxes Act and its regulations.

eTSP: Electronic Tax Service Provider, a company accredited by the BIR to file and pay taxes on behalf of taxpayers.

EWT: Expanded Withholding Tax.

FCDU: Foreign Currency Deposit Unit, the part of a bank whose foreign currency business is kept in separate books.

GRT: Gross Receipts Tax, the percentage tax paid by banks and similar institutions instead of VAT.

LARA: Ledger, Accounting, Reporting and Audit. DCP’s AI-native Computerized Accounting System described in this document, and the name of the assistant inside it.

PFRS: Philippine Financial Reporting Standards.

PTI: Permit to Issue described in the source draft circular; applicable final authority and taxpayer scope must be verified before enforcement.

QAP: Quarterly Alphalist of Payees.

SAWT: Summary Alphalist of Withholding Taxes.

SLSP: Summary List of Sales and Purchases.

## 22 Sources and sign off

Primary references checked for targeted corrections on September 18, 2026:

- [BIR RR 26-2025 official digest](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2026-2025%20Digest.pdf) — issuance transition and separate sales-reporting trigger.
- [BIR RR 7-2024 full text](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%207-%202024.pdf) — Section 4 preservation of books and records; confirm taxpayer-specific extensions and other obligations.
- [BIR RR 11-2025 full text](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2011-2025.pdf) — e-invoicing framework, read with amendments and applicable later issuances.

Other references named in section 7 remain in the verification register. This targeted review is not a complete legal certification. Technical primary references and role-specific reasoning are recorded in the companion roundtable review.

Approval remains pending. DCP Product Sponsor accepts cohort and commercial scope; Product Manager owns requirement/release traceability; Controller accepts accounting journeys; Tax Advisor accepts legal applicability and templates; Engineering Lead accepts architecture and test evidence; Security/Privacy and Operations accept deployment and recovery; pilot customer owner accepts migration and operating responsibilities. Record name, decision, exceptions, date and version for each sign-off.

## 23 Acceptance requirements and release gates

The requirements below are newly added in v1.1. They supplement the retained IDs rather than replace their domain detail. Product Manager maintains the requirement-to-scenario register; each domain owner maps their requirements to the applicable gate before implementation. All numeric pilot thresholds are proposals for owner approval, not measured results or regulatory mandates.

### REV 001 Supported customer and system boundary

**Owner:** Product Sponsor and Controller. **Release:** Phase 1 must. **Links:** OBJ-6/7, FR-FI-005/006/008/011, FR-IN-001–007.

Before a pilot commitment, record institution type, entities, branches, currencies, books, applicable taxes, volumes and users. Assign exactly one authoritative origin to each transaction family, ledger/subledger, invoice series and tax computation. For each retained system name its operator, output, reconciliation frequency and recovery path. A pilot is blocked by any mandatory capability without a tested LARA implementation or a signed, supported retained-system boundary. A successful pilot does not establish full bank-replacement or retail readiness.

### REV 002 Complete finance cycle

**Owner:** Controller and Tax Lead. **Release:** Phase 1 must. **Links:** FR-GL-017/018/021, RPT-001–008/013/014.

Run a representative month through invoice/collection, bill/payment, imported journals, adjustments, applicable tax outputs and close. Trial balance must balance; AR/AP and other control accounts must reconcile exactly to their detail. All material balance-sheet items have reviewed support. Deferred asset, accrual and prepayment engines require controlled source schedules with named owners. Statutory outputs required during the pilot cannot be deferred without a documented preparation boundary accepted by the responsible customer/advisor. Preserve report versions and unresolved-item dispositions.

### REV 003 Capture once and use conditional steps

**Owner:** Product and AP/AR Leads. **Release:** Phase 1 must. **Links:** FR-AR-003, FR-AP-001/004, FR-SH-002/003.

A direct service invoice and approved non-PO utility bill must complete without dummy orders or receipts. Reuse party identity, tax facts, lines, references and attachments downstream. When policy requires a PO, receipt or second approval, a user cannot bypass it through another screen, import or API. Measure human touches, retyped fields, active handling time and rework on the same baseline cases.

### REV 004 Shared work and contextual collaboration

**Owner:** Product and UX Lead. **Release:** Phase 1 must. **Links:** FR-SH-009/010, AI-029.

Each actionable exception has a source record, one active owner, reason, deadline and permitted next action. Provide role-filtered My work, Money in, Money out, Close and Compliance views; preserve filters and position after drill-down. Comments, requests for information, assignments and evidence stay on the task. Group related alerts and close dependent checks when their cause is resolved. Delegation is scoped, expires and cannot create self-approval. External messages require an explicit authorized send action.

### REV 005 Clear status and recoverable user actions

**Owner:** Product and Engineering. **Release:** Phase 1 must. **Links:** INT-EIS-001–006, FR-PL-005, COMP-INV-012/016.

Display accounting, buyer-delivery, reporting and settlement states independently. An invoice may be posted but undelivered or awaiting reporting acknowledgement. Save drafts and show sync state; interrupted users resume without losing data. Retry, double-click, lost-response and reconnect tests must create one financial effect, never a duplicate invoice. Offline drafts do not receive official numbers or post. Approved downtime documents reconcile once on recovery.

### REV 006 Payments and beneficiary controls

**Owner:** Treasury and Controller. **Release:** Phase 1 must. **Links:** FR-AP-005/010/011, FR-PH-002, FR-AR-020.

Separate approval of the bill, authority to pay, release and bank-confirmed settlement. Supplier bank changes require independently verified evidence and invalidate affected pending approvals. Replayed payment files or actions cannot release the same payment twice. Failed, returned and partial payments preserve history and adjust only their affected allocation. Distinguish cleared funds, held checks and forecast receipts. A printed check or exported payment file is not proof of settlement.

### REV 007 Withholding evidence allocation

**Owner:** Tax and Collections Leads. **Release:** Phase 1 must for applicable flows. **Links:** FR-AR-006/014, FR-PH-012, RPT-004.

Maintain expected withholding, received certificate, reviewed eligibility and claimed credit as separate states. Support partial/grouped receipts and certificates linked to multiple invoices without double counting. Gross settlement must reconcile to net cash plus withholding and other explicit adjustments. Unapplying cash cannot delete certificate history or change a filed return snapshot; create a review task for any filing impact. SAWT output is enabled only when its full input and reconciliation dependencies pass.

### REV 008 Deterministic controls and governed rules

**Owner:** Tax Lead and Engineering. **Release:** Phase 1 must. **Links:** FR-SH-004, AI-003/013/015/016, NFR-OPS-003.

Arithmetic, posting balance, required fields, known tax computations, duplicate checks and reconciliations run independently of AI. Store primary authority, reviewer, version, effective date, applicability and test examples for every active rule. Identical data/rules produce identical control outcomes with AI on or off. Readiness states include passed, failed, not applicable, not tested and needs review, with evidence freshness and blockers. A critical failed or untested mandatory check prevents a ready status. No score certifies compliance.

### REV 009 Durable interfaces and source reconciliation

**Owner:** Integration Lead and Controller. **Release:** Phase 1 must. **Links:** FR-FI-008, FR-SH-001/006/007, INT-EIS-001–006.

Record source batch IDs, line counts, debit/credit totals, mapping version, cut-off and source references. Define batch atomicity; partial failures cannot silently create an incomplete posting. Replaying the same batch or outbound event 100 times must produce one business effect. Fault tests at commit, send and acknowledgement boundaries must show no lost committed document. Resolve unknown external acknowledgement before resend. Missing/late source batches remain visible and block affected close tasks; every daily issued/accepted difference has a disposition.

### REV 010 Enforced authorization and evidence integrity

**Owner:** Security and Internal Control Leads. **Release:** Phase 1 must. **Links:** FR-SH-005, NFR-SEC-009/010, COMP-AUD-006/008.

Enforce tenant, entity, branch, record and sensitive-field permissions across screens, APIs, files, exports, queues, search and AI. Recheck authority and document version at execution. Self-approval, stale approval, revoked access and unauthorized delegation must fail. Normal application requests cannot use database-owner bypass authority. Auditor access is scoped by entity/period and time-limited. Revocation blocks future access, export generation and hosted-link downloads; previously downloaded copies remain subject to recipient confidentiality, retention and disposal controls. Test expired links and denied new downloads after revocation. Protect audit checkpoints independently; deliberate history modification/deletion must be detected, not merely discouraged by a hash-chain label.

### REV 011 Evidence-first AI review and fallback

**Owner:** AI Lead, Finance and Privacy. **Release:** Phase 1 must for enabled AI. **Links:** AI-GR-001–007, AI-001/002/033/034.

Show source document and suggested fields side by side; highlight missing, conflicting and uncertain evidence. Model output cannot post, approve, release payments, file returns or send messages. Untrusted document instructions cannot grant tools or access. Validate amounts and tax deterministically. Evaluate at least 200 representative held-out bills, stratified by source and quality; record field errors, material errors, abstention, correction time, latency and cost. Finance approves material-error thresholds before the pilot. Zero unauthorized actions and no control bypass are hard gates. Re-evaluate model/prompt/retrieval changes and roll back degradation. Full manual work remains usable during AI outages or tenant opt-out.

### REV 012 Trustworthy answers and owner overview

**Owner:** Reporting Lead and Product. **Release:** Phase 1 overview; Phase 2 natural-language answers. **Links:** AI-008/023/028, RPT-007/008/009.

Phase 1 home shows book cash with reconciliation freshness, overdue receivables/payables, upcoming obligations and blocked work from available authorized data. Every figure links to records and displays entity, period/currency where applicable and as-of time. Later AI answers use approved metric definitions and permission-filtered query results, reconcile exactly to canonical reports and state incomplete/unreconciled data. Unsupported questions require clarification or abstention. No margin or forecast claim appears without its input coverage.

### REV 013 User testing and accessibility

**Owner:** UX and Pilot Customer Lead. **Release:** Phase 1 must. **Links:** OBJ-8/9, NFR-USE-001/002.

Test at least eight representative pilot users across billing, AP, treasury, controller, tax and review roles. Cover issue/collect, capture/review/pay, resolve rejection, reconcile cash, close a branch and retrieve evidence. Proposed gate: 90% unassisted task completion after brief onboarding, with no duplicate financial effect or control bypass; any role-blocking defect requires resolution. Compare median and p90 times, rework and sentiments with baseline. Test keyboard, focus, screen-reader and accessible errors against WCAG 2.2 AA on critical journeys. Validate draft/retry behavior under an agreed weak-connection profile. Broader SME/retail usability needs its own cohort testing.

### REV 014 Qualified reuse and operating model

**Owner:** Engineering and Operations. **Release:** Phase 1 must. **Links:** section 16, NFR-SEC-013, NFR-PER-001/002, NFR-DAT-002/003.

Qualify each proposed DCP/shared component with working contract tests, fit-gap record, security/residency evidence, cost and support owner. Choose the stack through a reviewed decision record and vertical slice. Define pilot branches, users, peak posting rate, ledger lines and report volumes before evaluating latency. Agree availability/support hours with the customer; the original 99.5% is a planning baseline, not automatic bank acceptance. Rehearse full recovery, including documents, rules, keys and pending transmissions, against RPO 15 minutes and RTO four hours. Reconcile balances and replay behavior after recovery. Repeat recovery exercises quarterly.

### REV 015 Onboarding economics and exit

**Owner:** Product, Finance Sponsor and Customer Controller. **Release:** Phase 1 must. **Links:** section 15, FR-PL-007/015.

Show a resumable onboarding checklist with DCP/customer/advisor responsibilities, prerequisites, blockers and authority status. Sign opening balance and open-item reconciliations, complete the parallel-close rehearsal and train users by task. Before commercial commitment disclose supported scope, service hours, usage limits, dependencies, onboarding/integration work and estimated first-year cost. Track actual delivery/support hours and infrastructure/AI costs per customer. Demonstrate a complete authorized export of masters, transactions, evidence and audit/report history so exit is not dependent on screenshots.

### REV 016 Retention and privacy lifecycle

**Owner:** Tax, Privacy and Security Leads. **Release:** Phase 1 must. **Links:** NFR-DAT-001/004/009, FR-PL-001, INT-EIS-014.

Approve retention separately for books, documents, regulatory evidence, operational logs, AI inputs/outputs and backups. Record legal/contractual basis, trigger, disposal method and hold rules; do not present a contractual archive period as a universal legal minimum. Holds block eligible deletion; deletion jobs report evidence and failures. Include model providers, search indexes, replicas and support copies. Restore tests must preserve holds and avoid re-exposing access-revoked data. An exit export does not cancel lawful retained-record obligations.

### Release evidence checklist

| Gate | Evidence | Accountable acceptance |
| --- | --- | --- |
| Scope and obligation gate | Supported-customer matrix, authoritative-system map, legal profile, costed scope | Product Sponsor, Controller, Tax Lead |
| Core correctness gate | Golden transactions, balanced/control-account reconciliation, corrections, dates, series and retry tests | Controller and Engineering |
| Security and AI gate | Isolation/approval adversarial tests, audit integrity, privacy terms and AI evaluation or AI disabled | Security, Privacy and Finance |
| User and migration gate | Reconciled openings, parallel close, task completion/accessibility evidence and training | Customer Controller and UX |
| Operating gate | Qualified deployment, workload results, recovery drill, on-call/support and external-dependency runbooks | Operations and customer owner |
| Expansion gate | First close completed, three-close outcome review, second-customer repeatability and unresolved issues | Product Sponsor and Finance |

Go-live requires each applicable gate to pass with named evidence. Pending authority requirements, material unexplained balances and critical security defects are blockers. A proposed deadline, AI confidence score or successful demo cannot substitute for gate acceptance.


