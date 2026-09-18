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

