# LARA business and user roundtable review

Review basis: full extracted BRD-LARA-2026-V1.0, 18 September 2026. These are AI-simulated role perspectives and analytical sentiments, not interviews, actual expert endorsements, measured customer research, or regulatory advice. Recommendations below are product judgments grounded in the BRD; no external market, legal, or competitor claims are asserted. Decisions are recommended for the revised draft and remain subject to product-owner acceptance.

## Roundtable sentiments

| Perspective | Sentiment | Main concern | Desired outcome |
|---|---|---|---|
| Business sponsor | Positive about reusable local finance product; concerned about delivery economics | A bank, retailer and sole proprietor cannot all be launch acceptance cases | A bounded reference customer and repeatable onboarding |
| SME owner | Values fewer spreadsheets and clearer cash/tax obligations; intimidated by enterprise scope | Too many fields, roles, permits and module names | See cash, amounts due and next action; delegate accounting safely |
| Finance controller | Strongly supports immutable records and reconciliations; cautiously positive about AI | Phase 1 may not support a complete financial close for the chosen customer | Traceable numbers, reproducible reports and controlled exceptions |
| Accounts clerk | Welcomes capture and reuse; wary of approving plausible mistakes | Reviewing a full AI draft can take as long as typing it | Side-by-side evidence, uncertain fields highlighted, corrections remembered safely |
| Branch cashier | Supports one daily-close flow; concerned about outages and slow hand-offs | Unsure whether an invoice posted, reached the customer or was accepted externally | Fast issuance, clear status, no duplicates and explicit recovery |
| Auditor | Positive about evidence exports; skeptical of readiness scores presented as assurance | Broad access and incomplete evidence can undermine apparent transparency | Scoped access and demonstrable traceability, with gaps visible |
| UX/service designer | Supports one inbox and simple mode; concerned about a crowded universal interface | Shared engines are implementation reuse, not automatically a usable journey | Role-specific tasks, progressive disclosure and tested recovery paths |

## Findings and recommended decisions (18)

### BU-01 — Launch segment is not coherent (critical)
**References:** sections 1, 5, 20; OBJ-6/7; FR-FI-005/006/007/011; FR-GL-008; FR-IN-001–007.
**Discussion:** Sponsor favors banking because conversations exist. SME owner objects that solving banking does not demonstrate retail usability or inventory fitness. Controller notes that required bank currency/book/tax features sit in later phases.
**Decision:** Keep one codebase as the product principle; remove the claim that satisfying a bank automatically satisfies retail. Define a named design-partner institution type, legal entities, branches, currencies, transaction volumes, systems of record and applicable taxes before promising Phase 1. Support only customers whose complete required capabilities are released and tested. SME and retail packs need separate validation.
**Acceptance:** A signed capability/applicability matrix has zero unresolved required capabilities for the launch cohort. A customer requiring FCDU, trust books, inventory or another deferred capability cannot pass go-live unless that capability is delivered and validated or an explicitly approved supported source-system boundary covers it.

### BU-02 — Sell a complete operating outcome, not a permit checklist (critical)
**References:** OBJ-1–4; section 5; RPT-007; FR-GL-017/018; FR-FI-001/004.
**Discussion:** Sponsor wants deadline speed; controller will not accept a ledger unable to explain its balance sheet. The draft's financial statement pack and several tax outputs are deferred despite a complete-CAS promise.
**Decision:** Phase 1 must enable invoice-to-cash, bill-to-payment, source-to-ledger reconciliation and a complete first close for the selected cohort. Make a trial balance, balance sheet and income statement explicit Phase 1 deliverables, with other statements and regulatory returns selected by applicability. Distinguish draft readiness from authority-issued registration.
**Acceptance:** One representative parallel-close dataset completes all required journeys and reconciles control balances, statements, books and applicable returns with approved differences; no mandatory step depends on an unowned spreadsheet.

### BU-03 — Roadmap contradictions undermine confidence (high)
**References:** section 5 versus AI-017/019/020/022; FR-PH-029; FR-PH-023 versus FR-CB-004; FR-AP-003 versus RPT-006; AI-029 versus FR-SH-010.
**Discussion:** All roles need to know what is actually included. A later-phase AI inbox must not imply that ordinary work waits until Phase 2.
**Decision:** Use requirement tables as the canonical release ledger, reconcile all summary text, and distinguish the Phase 1 human work queue from later AI behaviors. Move handwritten capture, PDF statement reading, manual-books OCR and AI 2307 chasing consistently to Phase 2; keep reviewed spreadsheet migration and deterministic certificate tracking in Phase 1. Resolve tax certificate dates by the selected cohort's needs.
**Acceptance:** Every live requirement has one release, priority, owner and applicability; automated/document review finds no conflicting phase references. Removed FR-PL-011 is retained only as a tombstone, not a planned Phase 3 feature.

### BU-04 — Reduce mandatory journey steps (high)
**References:** section 8; FR-AR-003; FR-AP-001/004; FR-PL-015.
**Discussion:** Clerk and SME owner reject entering quotations, orders and receipts for every transaction. Controller needs evidence where procurement policy requires it.
**Decision:** Offer direct invoice and direct bill paths. Quotation, sales order, PO and goods receipt are conditional steps controlled by policy and transaction type, not universal prerequisites. Enable an approved no-PO bill exception where appropriate.
**Acceptance:** A service invoice and recurring utility bill can be prepared without dummy orders or receipts. A policy-controlled PO purchase cannot bypass its required evidence. Reused values are not retyped downstream.

### BU-05 — One inbox needs role-specific views (high)
**References:** FR-SH-010; AI-029; FR-PL-015; NFR-USE-001.
**Discussion:** UX and clerk welcome one work list but do not want hundreds of mixed technical failures and approvals. Sponsor wants accountability.
**Decision:** Present Today/My work, Collections, Payments, Close and Compliance views over one shared queue. Show owner, entity/branch, due date, monetary impact, reason and next action; provide reassignment, delegation, escalation and saved filters. Keep AI agent names out of primary navigation.
**Acceptance:** Each exception has one active owner, linked source and resolution state; duplicate alerts on one cause are grouped. A cashier cannot see another branch's restricted work. An absent approver's work reaches an authorized delegate without self-approval.

### BU-06 — Preserve continuity across screens and failures (high)
**References:** NFR-USE-001; FR-AR-022; INT-EIS-003/004; FR-PL-005; COMP-INV-012/016.
**Discussion:** Cashier cares whether the customer can leave with a valid document; finance cares about reporting. One vague completed status conflates these outcomes.
**Decision:** Expose independent accounting, buyer-delivery, external-reporting and settlement statuses in a transaction timeline. Autosave drafts, preserve filters and position after drill-down, explain recoverable errors in plain language, and provide approved downtime/recovery instructions. Offline capture never silently becomes invoice issuance.
**Acceptance:** A lost response or repeated tap causes no duplicate posting/number. The user can distinguish posted-but-undelivered from queued/rejected transmission, resume interrupted drafts and reconcile any approved downtime document once.

### BU-07 — AI review must save time without hiding uncertainty (high)
**References:** AI-001/002; AI-GR-001/002/007; OBJ-5.
**Discussion:** Clerk welcomes less typing but dislikes a confidence number without evidence. Auditor wants material tax and identity fields reviewed.
**Decision:** Show source and draft side by side, highlight uncertain or conflicting fields, explain coding and tax suggestions, and show a change preview before approval. Manual completion remains available. Rules validate arithmetic, totals and required fields deterministically.
**Acceptance:** Pilot users can locate evidence for every material extracted field, correct a suggestion without re-entering the document and finish when AI is unavailable. Report review time and material error rate alongside no-edit capture rate; acceptance alone is not proof of correctness.

### BU-08 — Small-team controls need an honest operating model (high)
**References:** section 6; FR-SH-005; NFR-SEC-010; FR-AU-003/004.
**Discussion:** SME owner cannot invent a second employee. Auditor will not accept an AI second reviewer as the independent approver.
**Decision:** Configure a genuine external accountant/authorized second approver for workflows requiring independent approval. Document any allowed low-risk single-user workflow separately with compensating review accepted by the customer and advisors; do not silently weaken mandatory controls. Block conflicts rather than merely warn where separation is required.
**Acceptance:** Creator cannot approve their own controlled transaction by switching roles or using delegated access. Setup identifies unsupported staffing/control combinations before purchase or go-live, and the UI explains the required approver.

### BU-09 — Registration and migration are a service journey (high)
**References:** section 15/17; FR-PL-007/015; AI-005; COMP-REG-001/005.
**Discussion:** Owner fears disruption; sponsor needs predictable onboarding cost. Controller needs auditable opening balances.
**Decision:** One guided onboarding journey with checklist owner, dependencies, customer/DCP/advisor responsibilities, documents, configured sample transactions, training, reconciled migration, authority status and go-live decision. Present estimated effort and customer prerequisites before commitment.
**Acceptance:** User sees exactly what blocks readiness and who acts next. Go-live requires reconciled openings and open items, signed scope/control matrix, required external authorizations and tested rollback/contingency plan. Product must not mark an authority approval complete merely because a pack was generated.

### BU-10 — Basic bank import has disproportionate user value (medium)
**References:** FR-CB-003/004; FR-PH-023; FR-SH-006/007; OBJ-4.
**Discussion:** Controller argues manual-only reconciliation undermines a five-day-close promise; sponsor resists expanding Phase 1 into bank connectivity and AI parsing.
**Decision:** Include a single reviewed CSV bank import template and deterministic candidate matching in Phase 1 through existing ingestion/reconciliation engines. Defer PDF parsing, direct bank feeds, AI matching and a large bank-adapter library.
**Acceptance:** Users import a supported statement, review totals and duplicates, match one-to-one/partial/grouped items with evidence and reconcile to the statement balance; unsupported formats fail with a helpful template link.

### BU-11 — Owner value must be visible on day one (medium)
**References:** RPT-008/009/011; AI-023; FR-PH-015.
**Discussion:** Owner does not need an AI monthly narrative before seeing cash and overdue invoices. Sponsor wants ongoing subscription value beyond compliance season.
**Decision:** Provide a small Phase 1 home summary derived from already available data: book cash position with reconciliation freshness, overdue receivables/payables, next obligations and blocked work. Defer forecasts and narrative explanations to Phase 2.
**Acceptance:** Every tile links to its underlying records and displays company, as-of time and relevant reconciliation state; no misleading cash forecast or margin calculation appears when source coverage is incomplete.

### BU-12 — Readiness scores must expose coverage and blockers (high)
**References:** AI-013/014; OBJ-1/3; section 12.3.
**Discussion:** Sponsor likes a visible score; auditor objects to a reassuring number covering only a subset of rules.
**Decision:** Use a deterministic readiness checklist with pass/fail/not-applicable/not-tested/needs-review and evidence first. AI explains the findings. Any summary score shows denominator, rule version, freshness and exclusions; critical failures remain prominent. No score certifies compliance or estimates defensible tax exposure by itself.
**Acceptance:** A critical unresolved blocker cannot display ready. Users can reproduce the checklist against its saved data/rule version and distinguish checked items from untested legal obligations.

### BU-13 — Differentiators are hypotheses requiring proof (high)
**References:** section 12.3; AI-013/015/016/019/023; FR-TX-010; RPT-013.
**Discussion:** Sponsor favors many AI features; users favor fewer completed jobs. Auditor values evidence more than an agent count.
**Decision:** Prioritize three demonstrable product propositions: evidence-linked Philippine transaction-to-return reconciliation; guided go-live with reused setup/migration evidence; and exception-first finance work incorporating local certificates, PDCs and branch close. Treat language/chat, AI briefs and future forecasts as accelerators. Do not claim competitive uniqueness until evaluated.
**Acceptance:** For each proposition define a representative customer scenario, baseline effort, observed result and willingness-to-pay research question. Launch demos use end-to-end reconciled evidence, not disconnected AI prompts.

### BU-14 — Commercial packaging and ownership remain undefined (high)
**References:** section 17/18/20; NFR-SEC-013; NFR-DAT-005; OBJ-6.
**Discussion:** Sponsor fears selling bespoke bank implementations under an SME subscription; owner fears surprise implementation and AI fees.
**Decision:** Draft commercial packages around a shared core plus certified packs/service levels; separate onboarding, integration, hosting and advanced AI costs transparently. Choose pricing only after validation. DCP remains the accountable product/support owner even where SyncTax, JANUS and GAIA are internal components.
**Acceptance:** Before a pilot contract, customer receives supported scope, dependencies, service responsibilities, support hours, usage limits, data export/exit terms and full estimated first-year cost. Unit economics track onboarding hours, support hours, storage/transmission and AI costs per cohort.

### BU-15 — Access for auditors needs boundaries (high)
**References:** FR-FI-010; FR-AU-001/005; role matrix; AI-GR-004.
**Discussion:** Auditor values self-service; owner does not authorize unlimited permanent access merely by inviting an auditor.
**Decision:** Offer scoped, time-limited auditor invitations by entity, period and record type, with export approval where required, access logging and revocation. Evidence exports include scope, generation time, source lineage and completeness/exception statement.
**Acceptance:** An expired/revoked invitation immediately loses access, including AI queries and shared links; an auditor cannot expand their own scope. The requesting customer can reproduce exactly which records were shared.

### BU-16 — Define measurable usability and adoption acceptance (high)
**References:** NFR-USE-001/002; OBJ-4/5; section 15.
**Discussion:** UX will not accept 'plain language' and 'mobile usable' as sufficient evidence. Clerk wants training aligned to daily tasks.
**Decision:** Validate six critical journeys with representative users: issue/collect, capture/review/pay, resolve a rejection, reconcile cash, close a branch and retrieve audit evidence. Add keyboard operation, clear error recovery, accessible status labels, explicit company/branch context and role-based micro-guides. Proposed pilot target: at least 90% unassisted task completion after brief onboarding, with no duplicate postings or control bypasses; calibrate timing targets against observed baseline.
**Acceptance:** Record task success, elapsed time, error/rework, help requests and qualitative sentiment by role and cohort; issues preventing independent completion block rollout. Metrics are planned targets, not claimed research results.

### BU-17 — Collaboration should stay attached to the work (medium)
**References:** FR-SH-010; FR-PL-001/013; AI-019; FR-PH-012.
**Discussion:** Clerk and controller currently risk recreating email chains around missing documents. Owner wants transparent accountability without another chat tool.
**Decision:** Add contextual comments, mention/assignment, request-for-information status and version-linked evidence to the shared work item. Offer in-app requests before multiplying messaging integrations; external follow-ups remain reviewed and explicitly sent by an authorized user.
**Acceptance:** A missing 2307 or invoice detail has one request history linked to the transaction; resolving it updates the original work item without duplicate tasks. New evidence after approval invalidates/re-routes the affected approval when material.

### BU-18 — Make the outcome metrics controllable and honest (high)
**References:** OBJ-1–7; AI-001–006; INT-EIS-001–006; section 19.
**Discussion:** Sponsor wants simple headline targets; controller rejects guarantees that depend on authority outages, client source quality or missing approvals.
**Decision:** Separate product-controlled measures from externally dependent business outcomes. Define transmission obligation applicability, denominator, retry/outage evidence, validation scope, capture population, material fields and excluded cases. Track onboarding effort and qualified reference-customer repeatability alongside adoption and close time. Keep ambitious outcomes as pilot targets, not warranties.
**Acceptance:** Each objective has owner, baseline, measurement window, evidence source and exclusions. Product-controlled eligible documents enter the durable queue without loss; any missed external deadline is visible with accountable cause and response. Capture metrics include rejected/abstained documents so accuracy cannot be inflated by dropping hard inputs.

## Suggested business acceptance gate

Product owner selects the launch cohort and acknowledges deferred packs; finance lead signs the complete-close and reconciliation evidence; users demonstrate critical tasks; security/control owners sign role segregation and access tests; tax advisor confirms applicable rules and authority requirements; operations owner signs onboarding, recovery and support readiness. The revised BRD should be marked reviewed draft, not approved by actual stakeholders.

## Cross-panel deliberation and response

- **Bank-first direction: agree; preserve it explicitly.** Existing DCP conversations justify a bank/financial-institution design-partner track as the BRD's stated commercial intent. Do not silently pivot the release to SMEs. The sponsor supports that focus; the SME owner persona is a test of future simplicity and a separate later cohort, not a contradictory launch customer. Select the exact institution and required capability envelope before scope lock.
- **Controlled bank coexistence pilot: agree with conditions.** Keep the core banking/source platforms as the source of operational subledgers and instrument calculations, with clearly assigned books of record, reconciled journal/balance interfaces, cutover boundaries and customer-owned controls. Label coexistence accurately in contracts and demonstrations. Do not imply complete bank replacement or complete statutory coverage until FX/FCDU/DST/trust and every applicable reporting requirement are satisfied. A staged pilot is useful only if there is no ambiguity over where a required calculation, reconciliation and report lives, who owns it and how evidence is obtained.
- **Modular core and qualified reuse: agree.** Sponsor values common product support; users should experience one product even when DCP components are reused internally. Verify component fitness and operational ownership; do not promise unlimited configuration or assume metadata removes industry accounting differences. Do not expose six AI agents as six new user modules.
- **Deterministic compliance with limited AI: strongly agree.** Controller and auditor require deterministic validation, posting and readiness evidence. Clerk wants AI capture/explanations to reduce review effort; no perceived confidence score substitutes for evidence or independent approval.
- **Disagreement on reducing scope solely to transmission:** sponsor might accept a narrow commercial pilot, but controller rejects calling it a complete CAS replacement. The revised BRD must distinguish the bounded pilot from the qualified product release; user-facing claims must match the actual system boundary.
- **Damaged AI end table:** do not reconstruct invented original requirements. Record the nine phase-only rows as source-document defects. Any replacement features require new/reconciled IDs and are explicitly revised proposals.
- **Retention correction supplied by primary-source panel:** accept replacement of the blanket ten-year claim with a policy based on confirmed legal, sector, contractual and legal-hold needs. Explain the customer-visible policy and export/exit behavior; avoid retaining every backup indefinitely by default. The regulator panel owns the legal citation and precise applicability.
