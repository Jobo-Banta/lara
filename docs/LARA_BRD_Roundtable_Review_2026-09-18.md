# LARA BRD roundtable review and decisions

September 18, 2026 | Review of DCP_BRD_LARA_v1_0.docx | Revised baseline DCP_BRD_LARA_v1_1.md

## Overall assessment

LARA has a strong starting point in Philippine transaction practices, shared accounting engines and audit evidence. The main weakness is an overly broad launch promise: a complete platform for any business, bank-first scope and a short regulatory window, while important bank and close capabilities sit in later phases. More AI features do not resolve that dependency problem.

The recommended direction is a bank-first design-partner pilot with explicit coexistence boundaries, complete selected accounting journeys, fewer compulsory process steps and evidence-backed AI assistance. The revised BRD incorporates the changes as proposals for accountable owner review. It does not silently pivot the product to SMEs or certify banking/regulatory readiness.

## What the roundtables represent

Three independent AI review agents examined the full extracted source, using 19 role perspectives across business/users, accounting/process and technology/transformation/AI. They produced 56 findings, exchanged cross-panel challenges through the coordinating review and rechecked key changes. These sentiments are simulated analytical perspectives, not interviews, customer research, a licensed CPA opinion or human expert endorsements. No product code, DCP reuse components or live customer workflows were available for implementation verification.

## Sentiment summary

| Roundtable | Overall sentiment | Main tension | Agreed direction |
| --- | --- | --- | --- |
| Business and users | Positive about local relevance; concerned about adoption and delivery scope | Sponsor wants broad reach; users want fewer steps and clear next actions | One initial cohort, role-specific workspaces, guided onboarding and measured task success |
| Accounting and process | Positive about controls; concerned about incomplete release dependencies | Smaller release versus complete books, tax outputs and payment controls | Narrow eligibility, preserve controls, separate state transitions and reconcile retained systems |
| Technology and AI | Positive about shared core; skeptical of agent count and assumed reuse | Modern platform ambitions versus security, recovery and support capacity | Modular core, qualified adapters, repeat-safe transactions, deterministic checks and optional evaluated AI |

## Adjudicated decisions

| Decision | Disposition in v1.1 | Why |
| --- | --- | --- |
| Preserve bank-first commercial direction | Adopted as bounded pilot hypothesis | Source states DCP bank conversations; customer/institution still needs selection |
| Start with service SMEs instead | Not adopted as a launch pivot | Useful later profile, but would change stated strategy without customer evidence |
| Full universal-bank replacement at launch | Rejected as current promise | Currency, FCDU, DST, trust and other obligations need complete coverage or retained-source ownership |
| Reduce mandatory PR/PO/GR and quote/order chains | Adopted conditional paths | Direct invoices/bills reduce re-entry; required procurement controls remain |
| Combine every workflow into one flat inbox | Modified | One task service, but role views and specialist reconciliation/close screens |
| One party master | Retained with stronger boundaries | Reuse identity while separating AR/AP, employee data and payee controls |
| Phase 1 financial statements and first close | Clarified and gated | Registration preparation alone does not prove a usable accounting cycle |
| Basic bank import | Moved into Phase 1 | Standard CSV and deterministic matching; PDF/AI and many adapters deferred |
| Universal readiness score | Replaced by evidence/checklist model | Failed or untested critical controls cannot hide behind a green aggregate |
| Four Phase 1 AI differentiators | Simplified | Deterministic readiness/withholding/VAT checks with optional explanations; limited capture/coding and registration drafting |
| Six agents as differentiator | Rejected as value proposition | Users buy fewer errors, less chasing and traceable results, not agent counts |
| Assume SyncTax/JANUS/GAIA are proven | Replaced by qualification gate | Capability, contracts, security, operating cost and support were not inspected |
| Configuration handles every future change | Corrected | Some accounting, schema and regulatory changes need code, tests and certification review |
| Blanket ten-year retention | Corrected to record-class policy | General current BIR books rule differs; longer sector/contract/hold requirements still matter |
| Draft PTI/QR/correction details as settled law | Made conditional | Final primary authority for these particulars was not established |
| Multiple chat channels and custom agents at launch | Deferred | Establish stable in-app journeys and permissions before broad integrations |

## Three differentiation hypotheses to test

1. **Explain a number with evidence.** Follow a return or balance to transactions, documents, rule versions and reconciliation differences. Test with a controller preparing a tax review or auditor request; compare retrieval time and unresolved evidence gaps. Pilot foundation in Phase 1; natural-language explanation later.
2. **Reach a reconciled first close.** Guide eligibility, setup, migration, authority status, practice and first close in one owned checklist. Test with a design partner and then a second compatible customer; compare onboarding hours, rework and unsupported exceptions.
3. **Resolve local finance exceptions in context.** Bring PDC state, 2307 evidence, branch handover, rejected transmission and related tasks into the transaction journey. Test AP, treasury and collections cases; proposed target is 30% lower median handling time without increased material errors.

No competitor survey or willingness-to-pay study was performed; these are differentiated product directions to validate, not established market uniqueness.

## User experience blueprint

Use My work, Money in, Money out, Close and Compliance as role-filtered navigation. Keep company/branch context visible. Reuse entered data; show source and AI draft together; highlight uncertain fields; preserve drafts and screen position. Explain errors with a next action and an owner. Distinguish posted, delivered, reported and settled. Keep comments and missing-evidence requests on the transaction. Offer manual completion during AI outages. Add language and messaging channels only where user testing shows benefit.

Test six critical journeys with at least eight representative pilot users, then recruit separate SME/retail cohorts before claiming those experiences work. Proposed acceptance is 90% unassisted task completion; accounting integrity and access controls remain hard gates regardless of speed.

## Regulatory and source-document corrections

- The source treats draft e-invoice particulars as current mandatory behavior in several places. PTI, QR, branch scope, provider restrictions and exact correction route now require verified effective authority. This is an uncertainty correction, not a conclusion that these features will not be required.
- [BIR RR 26-2025](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2026-2025%20Digest.pdf) distinguishes the issuance transition from the subsequent reporting trigger. The revised requirements keep their activation, deadlines and statuses separate.
- [BIR RR 7-2024 Section 4](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%207-%202024.pdf) provides a general five-year books/records retention period. v1.1 requires an approved record-class policy including applicable longer obligations and holds; operational backups are managed separately.
- Nine trailing rows of the original AI table contain only phase numbers, including in raw Word XML. Their missing descriptions were not reconstructed as original text. Section 12.4 identifies newly authored AI-033–037 and routes other referenced behavior to existing requirements.
- Corrected phase conflicts for handwritten capture, PDF bank reading, manual-book OCR, AI 2307 chasing, shared inbox, statement import and payroll-derived data. Removed shareholder functionality is an explicit tombstone.

This was a targeted primary-source check, not a complete BIR/BSP legal review. The rule register requires qualified applicability review before implementation and go-live. Technical primary references and accounting context appear in the full panel findings below.

## Deliverables and verification

The complete updated requirements are in [DCP_BRD_LARA_v1_1.md](DCP_BRD_LARA_v1_1.md). The original Word BRD remains unchanged. This format allows the review to be used immediately; a revised Word artifact was not delivered because the available document renderer failed with missing LibreOffice and page layout could not be verified. No visual QA of the original Word layout is claimed.

The revision preserves every identifiable original requirement ID, including the removed-item tombstone, and adds explicit acceptance gates. Structural checks verify identifier coverage, edited table placement, phase alignment and the presence of all 23 sections. They do not validate implemented software or substitute for legal approval.

## Change inventory

The revision edits 87 requirement descriptions, aligns 38 release entries, rewrites conflicting strategy/process/governance sections, and adds 16 acceptance requirements (REV 001–016), five explicitly new AI behaviors and two user-outcome objectives.

**Edited source IDs:** OBJ-1, FR-SH-003, FR-SH-005, FR-SH-006, FR-SH-010, FR-CO-004, FR-CO-007, FR-GL-004, FR-GL-010, FR-GL-011, FR-GL-017, FR-GL-018, FR-GL-021, FR-AR-003, FR-AR-004, FR-AR-005, FR-AR-014, FR-AR-021, FR-AR-023, FR-AP-001, FR-AP-003, FR-AP-005, FR-AP-010, FR-CB-004, FR-IN-003, FR-TX-004, FR-PL-001, FR-PL-011, FR-PL-012, FR-PL-013, FR-PH-023, FR-PH-027, FR-PH-029, FR-FI-002, FR-FI-004, FR-FI-005, FR-FI-006, FR-FI-007, COMP-INV-003, COMP-INV-005, COMP-INV-013, COMP-INV-014, COMP-INV-015, COMP-AUD-002, COMP-AUD-003, COMP-REG-005, COMP-REG-006, COMP-REG-008, INT-EIS-001, INT-EIS-002, INT-EIS-003, INT-EIS-004, INT-EIS-005, INT-EIS-010, INT-EIS-013, INT-EIS-015, AI-GR-002, AI-GR-005, AI-003, AI-013, AI-015, AI-016, AI-029, AI-030, RPT-006, RPT-007, NFR-SEC-002, NFR-SEC-004, NFR-SEC-012, NFR-SEC-013, NFR-DAT-001, NFR-DAT-006, NFR-PER-001, NFR-PER-002, NFR-PER-003, NFR-USE-002, FR-PL-006, FR-FI-009, FR-FI-011, FR-AR-020, FR-PH-010, FR-PH-013, AI-018, AI-026, FR-SH-002, FR-SH-011, AI-024.

**Release updates:** FR-GL-004: 1; FR-GL-017: 1; FR-GL-018: 1; FR-AR-003: 1; FR-AR-005: 2 conditional; FR-AR-023: 2; FR-AP-001: 1; FR-AP-003: 1 applicable; FR-AP-010: 1 conditional; FR-CB-004: 1 basic; 2 advanced; FR-IN-003: 2 conditional; FR-TX-004: 1 applicable; 2 remainder; FR-PL-011: Removed; FR-PL-012: 3; FR-PL-013: 2; FR-PH-023: 1 basic; 2 adapters; FR-PH-027: 2; FR-PH-029: 1 manual; 2 AI; FR-FI-002: 1 conditional; FR-FI-004: 1 applicable; FR-FI-005: 2 conditional; FR-FI-006: 2 conditional; FR-FI-007: 1 mapping; 2 template; AI-017: 2; AI-019: 2; AI-020: 2; AI-022: 2; AI-029: 1 foundation; 2 expansion; AI-030: 3; RPT-006: 1 applicable; 2 payroll; RPT-007: 1 core; 2 expansion; FR-PL-006: 2 data; 3 connectors; FR-FI-009: 1 pilot; later scale; FR-FI-011: 3 conditional; AI-018: 2; AI-026: 3; FR-SH-011: 1 templates; 2 designer; AI-024: 2.

## Remaining owner decisions

Select the actual pilot institution, required books/currencies/taxes and source boundaries; establish workload and support expectations; verify final legal profiles; qualify DCP components and choose the stack; approve a costed commercial model and hosting arrangement. These require actual business evidence and accountable decisions, not further simulated voting.

### LARA business and user roundtable review

Review basis: full extracted BRD-LARA-2026-V1.0, 18 September 2026. These are AI-simulated role perspectives and analytical sentiments, not interviews, actual expert endorsements, measured customer research, or regulatory advice. Recommendations below are product judgments grounded in the BRD; no external market, legal, or competitor claims are asserted. Decisions are recommended for the revised draft and remain subject to product-owner acceptance.

#### Roundtable sentiments

| Perspective | Sentiment | Main concern | Desired outcome |
|---|---|---|---|
| Business sponsor | Positive about reusable local finance product; concerned about delivery economics | A bank, retailer and sole proprietor cannot all be launch acceptance cases | A bounded reference customer and repeatable onboarding |
| SME owner | Values fewer spreadsheets and clearer cash/tax obligations; intimidated by enterprise scope | Too many fields, roles, permits and module names | See cash, amounts due and next action; delegate accounting safely |
| Finance controller | Strongly supports immutable records and reconciliations; cautiously positive about AI | Phase 1 may not support a complete financial close for the chosen customer | Traceable numbers, reproducible reports and controlled exceptions |
| Accounts clerk | Welcomes capture and reuse; wary of approving plausible mistakes | Reviewing a full AI draft can take as long as typing it | Side-by-side evidence, uncertain fields highlighted, corrections remembered safely |
| Branch cashier | Supports one daily-close flow; concerned about outages and slow hand-offs | Unsure whether an invoice posted, reached the customer or was accepted externally | Fast issuance, clear status, no duplicates and explicit recovery |
| Auditor | Positive about evidence exports; skeptical of readiness scores presented as assurance | Broad access and incomplete evidence can undermine apparent transparency | Scoped access and demonstrable traceability, with gaps visible |
| UX/service designer | Supports one inbox and simple mode; concerned about a crowded universal interface | Shared engines are implementation reuse, not automatically a usable journey | Role-specific tasks, progressive disclosure and tested recovery paths |

#### Findings and recommended decisions (18)

##### BU-01 — Launch segment is not coherent (critical)
**References:** sections 1, 5, 20; OBJ-6/7; FR-FI-005/006/007/011; FR-GL-008; FR-IN-001–007.
**Discussion:** Sponsor favors banking because conversations exist. SME owner objects that solving banking does not demonstrate retail usability or inventory fitness. Controller notes that required bank currency/book/tax features sit in later phases.
**Decision:** Keep one codebase as the product principle; remove the claim that satisfying a bank automatically satisfies retail. Define a named design-partner institution type, legal entities, branches, currencies, transaction volumes, systems of record and applicable taxes before promising Phase 1. Support only customers whose complete required capabilities are released and tested. SME and retail packs need separate validation.
**Acceptance:** A signed capability/applicability matrix has zero unresolved required capabilities for the launch cohort. A customer requiring FCDU, trust books, inventory or another deferred capability cannot pass go-live unless that capability is delivered and validated or an explicitly approved supported source-system boundary covers it.

##### BU-02 — Sell a complete operating outcome, not a permit checklist (critical)
**References:** OBJ-1–4; section 5; RPT-007; FR-GL-017/018; FR-FI-001/004.
**Discussion:** Sponsor wants deadline speed; controller will not accept a ledger unable to explain its balance sheet. The draft's financial statement pack and several tax outputs are deferred despite a complete-CAS promise.
**Decision:** Phase 1 must enable invoice-to-cash, bill-to-payment, source-to-ledger reconciliation and a complete first close for the selected cohort. Make a trial balance, balance sheet and income statement explicit Phase 1 deliverables, with other statements and regulatory returns selected by applicability. Distinguish draft readiness from authority-issued registration.
**Acceptance:** One representative parallel-close dataset completes all required journeys and reconciles control balances, statements, books and applicable returns with approved differences; no mandatory step depends on an unowned spreadsheet.

##### BU-03 — Roadmap contradictions undermine confidence (high)
**References:** section 5 versus AI-017/019/020/022; FR-PH-029; FR-PH-023 versus FR-CB-004; FR-AP-003 versus RPT-006; AI-029 versus FR-SH-010.
**Discussion:** All roles need to know what is actually included. A later-phase AI inbox must not imply that ordinary work waits until Phase 2.
**Decision:** Use requirement tables as the canonical release ledger, reconcile all summary text, and distinguish the Phase 1 human work queue from later AI behaviors. Move handwritten capture, PDF statement reading, manual-books OCR and AI 2307 chasing consistently to Phase 2; keep reviewed spreadsheet migration and deterministic certificate tracking in Phase 1. Resolve tax certificate dates by the selected cohort's needs.
**Acceptance:** Every live requirement has one release, priority, owner and applicability; automated/document review finds no conflicting phase references. Removed FR-PL-011 is retained only as a tombstone, not a planned Phase 3 feature.

##### BU-04 — Reduce mandatory journey steps (high)
**References:** section 8; FR-AR-003; FR-AP-001/004; FR-PL-015.
**Discussion:** Clerk and SME owner reject entering quotations, orders and receipts for every transaction. Controller needs evidence where procurement policy requires it.
**Decision:** Offer direct invoice and direct bill paths. Quotation, sales order, PO and goods receipt are conditional steps controlled by policy and transaction type, not universal prerequisites. Enable an approved no-PO bill exception where appropriate.
**Acceptance:** A service invoice and recurring utility bill can be prepared without dummy orders or receipts. A policy-controlled PO purchase cannot bypass its required evidence. Reused values are not retyped downstream.

##### BU-05 — One inbox needs role-specific views (high)
**References:** FR-SH-010; AI-029; FR-PL-015; NFR-USE-001.
**Discussion:** UX and clerk welcome one work list but do not want hundreds of mixed technical failures and approvals. Sponsor wants accountability.
**Decision:** Present Today/My work, Collections, Payments, Close and Compliance views over one shared queue. Show owner, entity/branch, due date, monetary impact, reason and next action; provide reassignment, delegation, escalation and saved filters. Keep AI agent names out of primary navigation.
**Acceptance:** Each exception has one active owner, linked source and resolution state; duplicate alerts on one cause are grouped. A cashier cannot see another branch's restricted work. An absent approver's work reaches an authorized delegate without self-approval.

##### BU-06 — Preserve continuity across screens and failures (high)
**References:** NFR-USE-001; FR-AR-022; INT-EIS-003/004; FR-PL-005; COMP-INV-012/016.
**Discussion:** Cashier cares whether the customer can leave with a valid document; finance cares about reporting. One vague completed status conflates these outcomes.
**Decision:** Expose independent accounting, buyer-delivery, external-reporting and settlement statuses in a transaction timeline. Autosave drafts, preserve filters and position after drill-down, explain recoverable errors in plain language, and provide approved downtime/recovery instructions. Offline capture never silently becomes invoice issuance.
**Acceptance:** A lost response or repeated tap causes no duplicate posting/number. The user can distinguish posted-but-undelivered from queued/rejected transmission, resume interrupted drafts and reconcile any approved downtime document once.

##### BU-07 — AI review must save time without hiding uncertainty (high)
**References:** AI-001/002; AI-GR-001/002/007; OBJ-5.
**Discussion:** Clerk welcomes less typing but dislikes a confidence number without evidence. Auditor wants material tax and identity fields reviewed.
**Decision:** Show source and draft side by side, highlight uncertain or conflicting fields, explain coding and tax suggestions, and show a change preview before approval. Manual completion remains available. Rules validate arithmetic, totals and required fields deterministically.
**Acceptance:** Pilot users can locate evidence for every material extracted field, correct a suggestion without re-entering the document and finish when AI is unavailable. Report review time and material error rate alongside no-edit capture rate; acceptance alone is not proof of correctness.

##### BU-08 — Small-team controls need an honest operating model (high)
**References:** section 6; FR-SH-005; NFR-SEC-010; FR-AU-003/004.
**Discussion:** SME owner cannot invent a second employee. Auditor will not accept an AI second reviewer as the independent approver.
**Decision:** Configure a genuine external accountant/authorized second approver for workflows requiring independent approval. Document any allowed low-risk single-user workflow separately with compensating review accepted by the customer and advisors; do not silently weaken mandatory controls. Block conflicts rather than merely warn where separation is required.
**Acceptance:** Creator cannot approve their own controlled transaction by switching roles or using delegated access. Setup identifies unsupported staffing/control combinations before purchase or go-live, and the UI explains the required approver.

##### BU-09 — Registration and migration are a service journey (high)
**References:** section 15/17; FR-PL-007/015; AI-005; COMP-REG-001/005.
**Discussion:** Owner fears disruption; sponsor needs predictable onboarding cost. Controller needs auditable opening balances.
**Decision:** One guided onboarding journey with checklist owner, dependencies, customer/DCP/advisor responsibilities, documents, configured sample transactions, training, reconciled migration, authority status and go-live decision. Present estimated effort and customer prerequisites before commitment.
**Acceptance:** User sees exactly what blocks readiness and who acts next. Go-live requires reconciled openings and open items, signed scope/control matrix, required external authorizations and tested rollback/contingency plan. Product must not mark an authority approval complete merely because a pack was generated.

##### BU-10 — Basic bank import has disproportionate user value (medium)
**References:** FR-CB-003/004; FR-PH-023; FR-SH-006/007; OBJ-4.
**Discussion:** Controller argues manual-only reconciliation undermines a five-day-close promise; sponsor resists expanding Phase 1 into bank connectivity and AI parsing.
**Decision:** Include a single reviewed CSV bank import template and deterministic candidate matching in Phase 1 through existing ingestion/reconciliation engines. Defer PDF parsing, direct bank feeds, AI matching and a large bank-adapter library.
**Acceptance:** Users import a supported statement, review totals and duplicates, match one-to-one/partial/grouped items with evidence and reconcile to the statement balance; unsupported formats fail with a helpful template link.

##### BU-11 — Owner value must be visible on day one (medium)
**References:** RPT-008/009/011; AI-023; FR-PH-015.
**Discussion:** Owner does not need an AI monthly narrative before seeing cash and overdue invoices. Sponsor wants ongoing subscription value beyond compliance season.
**Decision:** Provide a small Phase 1 home summary derived from already available data: book cash position with reconciliation freshness, overdue receivables/payables, next obligations and blocked work. Defer forecasts and narrative explanations to Phase 2.
**Acceptance:** Every tile links to its underlying records and displays company, as-of time and relevant reconciliation state; no misleading cash forecast or margin calculation appears when source coverage is incomplete.

##### BU-12 — Readiness scores must expose coverage and blockers (high)
**References:** AI-013/014; OBJ-1/3; section 12.3.
**Discussion:** Sponsor likes a visible score; auditor objects to a reassuring number covering only a subset of rules.
**Decision:** Use a deterministic readiness checklist with pass/fail/not-applicable/not-tested/needs-review and evidence first. AI explains the findings. Any summary score shows denominator, rule version, freshness and exclusions; critical failures remain prominent. No score certifies compliance or estimates defensible tax exposure by itself.
**Acceptance:** A critical unresolved blocker cannot display ready. Users can reproduce the checklist against its saved data/rule version and distinguish checked items from untested legal obligations.

##### BU-13 — Differentiators are hypotheses requiring proof (high)
**References:** section 12.3; AI-013/015/016/019/023; FR-TX-010; RPT-013.
**Discussion:** Sponsor favors many AI features; users favor fewer completed jobs. Auditor values evidence more than an agent count.
**Decision:** Prioritize three demonstrable product propositions: evidence-linked Philippine transaction-to-return reconciliation; guided go-live with reused setup/migration evidence; and exception-first finance work incorporating local certificates, PDCs and branch close. Treat language/chat, AI briefs and future forecasts as accelerators. Do not claim competitive uniqueness until evaluated.
**Acceptance:** For each proposition define a representative customer scenario, baseline effort, observed result and willingness-to-pay research question. Launch demos use end-to-end reconciled evidence, not disconnected AI prompts.

##### BU-14 — Commercial packaging and ownership remain undefined (high)
**References:** section 17/18/20; NFR-SEC-013; NFR-DAT-005; OBJ-6.
**Discussion:** Sponsor fears selling bespoke bank implementations under an SME subscription; owner fears surprise implementation and AI fees.
**Decision:** Draft commercial packages around a shared core plus certified packs/service levels; separate onboarding, integration, hosting and advanced AI costs transparently. Choose pricing only after validation. DCP remains the accountable product/support owner even where SyncTax, JANUS and GAIA are internal components.
**Acceptance:** Before a pilot contract, customer receives supported scope, dependencies, service responsibilities, support hours, usage limits, data export/exit terms and full estimated first-year cost. Unit economics track onboarding hours, support hours, storage/transmission and AI costs per cohort.

##### BU-15 — Access for auditors needs boundaries (high)
**References:** FR-FI-010; FR-AU-001/005; role matrix; AI-GR-004.
**Discussion:** Auditor values self-service; owner does not authorize unlimited permanent access merely by inviting an auditor.
**Decision:** Offer scoped, time-limited auditor invitations by entity, period and record type, with export approval where required, access logging and revocation. Evidence exports include scope, generation time, source lineage and completeness/exception statement.
**Acceptance:** An expired/revoked invitation immediately loses access, including AI queries and shared links; an auditor cannot expand their own scope. The requesting customer can reproduce exactly which records were shared.

##### BU-16 — Define measurable usability and adoption acceptance (high)
**References:** NFR-USE-001/002; OBJ-4/5; section 15.
**Discussion:** UX will not accept 'plain language' and 'mobile usable' as sufficient evidence. Clerk wants training aligned to daily tasks.
**Decision:** Validate six critical journeys with representative users: issue/collect, capture/review/pay, resolve a rejection, reconcile cash, close a branch and retrieve audit evidence. Add keyboard operation, clear error recovery, accessible status labels, explicit company/branch context and role-based micro-guides. Proposed pilot target: at least 90% unassisted task completion after brief onboarding, with no duplicate postings or control bypasses; calibrate timing targets against observed baseline.
**Acceptance:** Record task success, elapsed time, error/rework, help requests and qualitative sentiment by role and cohort; issues preventing independent completion block rollout. Metrics are planned targets, not claimed research results.

##### BU-17 — Collaboration should stay attached to the work (medium)
**References:** FR-SH-010; FR-PL-001/013; AI-019; FR-PH-012.
**Discussion:** Clerk and controller currently risk recreating email chains around missing documents. Owner wants transparent accountability without another chat tool.
**Decision:** Add contextual comments, mention/assignment, request-for-information status and version-linked evidence to the shared work item. Offer in-app requests before multiplying messaging integrations; external follow-ups remain reviewed and explicitly sent by an authorized user.
**Acceptance:** A missing 2307 or invoice detail has one request history linked to the transaction; resolving it updates the original work item without duplicate tasks. New evidence after approval invalidates/re-routes the affected approval when material.

##### BU-18 — Make the outcome metrics controllable and honest (high)
**References:** OBJ-1–7; AI-001–006; INT-EIS-001–006; section 19.
**Discussion:** Sponsor wants simple headline targets; controller rejects guarantees that depend on authority outages, client source quality or missing approvals.
**Decision:** Separate product-controlled measures from externally dependent business outcomes. Define transmission obligation applicability, denominator, retry/outage evidence, validation scope, capture population, material fields and excluded cases. Track onboarding effort and qualified reference-customer repeatability alongside adoption and close time. Keep ambitious outcomes as pilot targets, not warranties.
**Acceptance:** Each objective has owner, baseline, measurement window, evidence source and exclusions. Product-controlled eligible documents enter the durable queue without loss; any missed external deadline is visible with accountable cause and response. Capture metrics include rejected/abstained documents so accuracy cannot be inflated by dropping hard inputs.

#### Suggested business acceptance gate

Product owner selects the launch cohort and acknowledges deferred packs; finance lead signs the complete-close and reconciliation evidence; users demonstrate critical tasks; security/control owners sign role segregation and access tests; tax advisor confirms applicable rules and authority requirements; operations owner signs onboarding, recovery and support readiness. The revised BRD should be marked reviewed draft, not approved by actual stakeholders.

#### Cross-panel deliberation and response

- **Bank-first direction: agree; preserve it explicitly.** Existing DCP conversations justify a bank/financial-institution design-partner track as the BRD's stated commercial intent. Do not silently pivot the release to SMEs. The sponsor supports that focus; the SME owner persona is a test of future simplicity and a separate later cohort, not a contradictory launch customer. Select the exact institution and required capability envelope before scope lock.
- **Controlled bank coexistence pilot: agree with conditions.** Keep the core banking/source platforms as the source of operational subledgers and instrument calculations, with clearly assigned books of record, reconciled journal/balance interfaces, cutover boundaries and customer-owned controls. Label coexistence accurately in contracts and demonstrations. Do not imply complete bank replacement or complete statutory coverage until FX/FCDU/DST/trust and every applicable reporting requirement are satisfied. A staged pilot is useful only if there is no ambiguity over where a required calculation, reconciliation and report lives, who owns it and how evidence is obtained.
- **Modular core and qualified reuse: agree.** Sponsor values common product support; users should experience one product even when DCP components are reused internally. Verify component fitness and operational ownership; do not promise unlimited configuration or assume metadata removes industry accounting differences. Do not expose six AI agents as six new user modules.
- **Deterministic compliance with limited AI: strongly agree.** Controller and auditor require deterministic validation, posting and readiness evidence. Clerk wants AI capture/explanations to reduce review effort; no perceived confidence score substitutes for evidence or independent approval.
- **Disagreement on reducing scope solely to transmission:** sponsor might accept a narrow commercial pilot, but controller rejects calling it a complete CAS replacement. The revised BRD must distinguish the bounded pilot from the qualified product release; user-facing claims must match the actual system boundary.
- **Damaged AI end table:** do not reconstruct invented original requirements. Record the nine phase-only rows as source-document defects. Any replacement features require new/reconciled IDs and are explicitly revised proposals.
- **Retention correction supplied by primary-source panel:** accept replacement of the blanket ten-year claim with a policy based on confirmed legal, sector, contractual and legal-hold needs. Explain the customer-visible policy and export/exit behavior; avoid retaining every backup indefinitely by default. The regulator panel owns the legal citation and precise applicability.


### Accounting and process roundtable — proposed BRD revisions

This is an AI-simulated role review of the full BRD-LARA-2026-V1.0, not a meeting with named people, a CPA opinion, customer research, or regulatory sign-off. The sentiments below are analytical judgments. All proposed numerical acceptance targets require pilot baselining unless they describe accounting invariants.

#### Sentiments and productive disagreements

| Perspective | Sentiment | Core concern | Resolution recommended |
|---|---|---|---|
| Controller | Cautiously positive | Strong immutable ledger and local document coverage, but phase dependencies make the “complete CAS” promise unreliable. | A supported operating profile and complete close are release gates. |
| AP lead | Positive with reservations | Capture once is valuable; mandatory PR–PO–GR chains and repeated approval screens would slow ordinary service bills. | Policy selects PO and non-PO routes, with common capture, tax, approval and payment evidence. |
| AR/collections lead | Positive | Local checks and 2307 handling are relevant; collection, credit and certificate states are conflated. | Separate invoice, allocation, cash settlement and certificate status with one customer workbench. |
| Treasury lead | Concerned | A printed check or uploaded payment file is not confirmed cash movement. | Separate authorization, release, bank acknowledgment and settlement; prevent duplicate release. |
| Tax reviewer | Concerned | Draft regulatory claims and broad blanket tax treatments are presented as build-ready rules. | Source-backed applicability matrix and advisor approval before activation; no claim of tax certification. |
| Audit reviewer | Positive about traceability | Hard locks conflict with later adjustments; warning-only duty conflicts can bypass approvals. | Explicit report versions, amendment workflow and enforced action-level controls. |
| Lean process specialist | Strongly supportive of reuse | Shared engines simplify engineering but do not inherently reduce user effort. | Three transaction journeys and one close journey; measure touches, handoffs, exceptions and completion time. |

The controller wants full statement and reconciliation coverage early; the lean specialist wants a small release. Resolve by narrowing the supported customer profile, not deleting accounting controls. Treasury wants dual authorization; small teams lack enough staff. Resolve with approved staffing/outsourced-review arrangements and explicit eligibility restrictions where mandatory controls cannot be met. Tax wants conservative review; AP wants faster processing. Resolve by deterministic rule checks and risk-based routing, with human resolution of uncertainty.

#### Twenty findings and concrete changes

1. **Define what the first bank deployment actually replaces.** References: section 1; section 5; FR-FI-004–008; FR-GL-008; RPT-006. Bank-first scope defers foreign currency, separate FCDU books, DST, bank reporting mappings and some final-withholding outputs. Recommend two explicit profiles: a narrowly scoped bank coexistence pilot retaining named source systems, and a later expanded bank accounting release. A bank replacing its general ledger requires all applicable dependencies before cutover. Acceptance: signed responsibility matrix covers every transaction class, tax output, book, currency and interface; an unsupported item blocks activation. Do not equate a successful bank pilot with universal bank replacement or retail readiness.

2. **Separate the SME profile from the bank profile.** References: OBJ-7; FR-PL-015; section 20. Shared code is sensible; identical workflows are not. Recommend initially supporting a domestic service-business profile with explicit single-currency/no-stock limits; select actual target customers through discovery. Goods sellers require inventory valuation and stock-ledger reconciliation, either in LARA or through a verified retained subsystem. Acceptance: setup eligibility screen identifies incompatible needs and shows the supported alternative; bank-only dimensions and reports do not appear in the service-business workflow.

3. **Make Phase 1 a usable accounting cycle.** References: RPT-007; FR-GL-017/018; FR-FA-001–005; FR-GL-013; section 5. Trial balance, balance sheet, income statement and operational cash position belong in the initial accounting release; a full framework-specific statement pack may follow only with a documented preparation boundary. Accruals, asset depreciation and prepayments still need controlled imported/manual schedules if their engines are deferred. Acceptance: complete a parallel month with all material balances supported, subledgers reconciled, statement totals tied to the ledger and every retained schedule owned. No “complete financial statements” claim until cash flow, equity movement and applicable presentation/disclosures are supported.

4. **Give dates unambiguous meanings.** References: FR-GL-003/006/011; COMP-AUD-002. The immutable timestamp at posting is not the accounting effective date. Specify document date, accounting date/period, tax point when applicable, and system posting timestamp. Acceptance: a late-entered invoice can reach a permitted prior open accounting period while retaining its actual posting timestamp; locked-period attempts are rejected and reported. No backdating of audit timestamps.

5. **Resolve hard locks versus audit adjustments.** References: FR-GL-006/011/021; section 8. Recommend approved corrections in an open period by default; where a prior-period adjustment is authorized, use a controlled adjustment period/report version with original published reports retained. Do not let the Finance Director silently bypass a hard lock. Acceptance: original report checksum and totals are reproducible after adjustment; revised report shows adjustment references, approvers, dates and impact; required filing-amendment tasks are raised.

6. **Preserve control accounts during migration and source-system coexistence.** References: FR-GL-010; FR-SH-006/007; FR-FI-008; section 15. “Only source modules” needs to include validated opening-balance and external-subledger adapters, not unrestricted manual journals. Acceptance: opening AR/AP details exactly reconcile to controls, duplicate opening loads are rejected, source ownership is explicit, and an external control-account journal without supporting subledger totals is quarantined.

7. **Define interface integrity as accounting behavior.** References: FR-FI-008; FR-SH-001/006; COMP-AUD-005. Add source batch IDs, line counts, debit/credit totals, duplicate/replay detection, cutoff rules, missing-batch alerts, mapping version, approval and suspense ownership. Acceptance: resending a batch never doubles postings; partial failure cannot silently post an incomplete balanced set; a late/missing source batch blocks the relevant close task. Keep source drill-through or durable evidence for summarized entries.

8. **Replace mandatory linear purchase steps with policy routes.** References: section 8; FR-AP-001/004/009. Use capture → validate → approve exceptions/commitment → post → authorize/release → reconcile. Goods purchases use PO/receipt matching when supported; routine service bills can use an approved non-PO route with receipt-of-service evidence; employee reimbursement is a document subtype. Acceptance: a permitted non-PO bill needs no dummy PO or goods receipt, and required goods receipt exceptions cannot bypass approval. Count touches and re-entry; set improvement targets after pilot baseline.

9. **Separate bill approval from cash authorization and settlement.** References: FR-AP-005/010/011; FR-PH-001/002; FR-CB-001. One treasury workbench should hold a state sequence: proposed, authorized, released, bank-acknowledged, settled, failed/cancelled. Generated vouchers and check prints are evidence, not new encodings. Acceptance: an approved bill cannot be paid twice by re-uploading a file; beneficiary changes invalidate pending payment approval; failed/returned payments reopen the right payable without deleting history. Payment-file/export capability does not imply bank execution.

10. **Model checks without overstating available cash.** References: FR-AR-020; FR-AP-010; FR-PH-008; RPT-011. Distinguish checks received/issued, custody/release, due date, deposit/presentation, clearing, dishonor, replacement and stale status. Accounting treatment is policy-approved; do not hardwire “invoice reopened” without explaining prior settlement entries. Acceptance: a bounced partial PDC reverses only its settlement, preserves other allocations and charges, and leaves a traceable replacement chain. Cash forecast distinguishes expected PDC receipts from cleared funds.

11. **Make allocations and certificates separate records.** References: FR-AR-006/013/014; FR-PH-012; RPT-004. A 2307 can relate to multiple invoices and periods; expected withholding, certificate received and credit available for filing are separate states. Acceptance: partial/grouped collections reconcile gross amount, net cash and withholding; unapplied cash remains visible; a certificate cannot be claimed twice; un-applying a payment does not erase prior tax evidence or a filed return snapshot.

12. **Strengthen party data without automatic netting.** References: FR-SH-003; FR-CO-004; FR-PH-010/011; AI-025. One identity may have multiple commercial roles, but customer and supplier contracts, balances, credit limits and permissions remain separate. Employee details need restricted access. Supplier payment-account changes require independent verification and approval. Acceptance: customer/supplier role sharing does not automatically offset AR and AP; bank-detail changes are versioned and routed to a different approver; masked employee fields remain hidden from ordinary AP users.

13. **Turn tax completeness into a customer-specific go-live gate.** References: FR-TX-001–010; FR-FI-001–006; FR-AP-003; RPT-001–006; FR-PH-013/027. Avoid shipping one form while its underlying ledger/tax/certificate dependencies remain later-phase. Add an obligation matrix by taxpayer, transaction, period and profile, with rule source, effective date and reviewer. Acceptance: applicable form/certificate/reconciliation combinations are tested end to end before enabling the related transaction; unsupported obligations show a named retained-system owner. Blanket lease percentages or institution-wide VAT/GRT assumptions must be reviewed; no legal conclusion is made in this review.

14. **Keep compliance decisions deterministic.** References: AI-003/013/015/016; FR-AU-003; FR-TX-010. Arithmetic, required fields, duplicate keys, rule applicability and reconciliations must run without AI. AI explains and proposes; uncertain document interpretation routes to review. Replace a single readiness score with required checks, blockers, warnings, scope and evidence freshness. Acceptance: the same approved data/rule version yields the same control result with AI off; all failed mandatory checks stay visible even if an aggregate score is high; no score means “BIR-approved.”

15. **Use one role-aware workbench, not one undifferentiated queue.** References: FR-SH-010; AI-029; section 17. Consolidate capture, approvals, import issues, tax exceptions and close tasks into a shared work item model with filtered role views, owner, due date, priority, dependencies and escalation. Link related exceptions to one transaction so staff do not fix the same cause repeatedly. Acceptance: resolving one missing supplier fact updates linked draft checks without duplicate tasks; users never see unauthorized payroll, bank or client data through counts, previews or search.

16. **Unify schedule tooling, preserve accounting semantics.** References: FR-SH-008; FR-GL-004/013; FR-FA-003/005; FR-PH-009/027. A recurrence engine can be shared, but leases, depreciation, interest and revenue recognition cannot become interchangeable templates without specialized rules and approvals. Also reconcile FR-GL-004 Phase 1 against FR-SH-008 Phase 2. Acceptance: approved schedules preserve calculation assumptions, start/end dates, modification history, posting references and book/tax differences; regeneration does not repost recognized periods. Phase 1 recurrence can remain a narrow journal-template capability.

17. **Make inventory conditional by eligibility, not an ambiguous footnote.** References: FR-IN-001–007; COMP-BOA-005; section 20. The inventory book cannot be credibly offered without a validated source of quantities and values. Recommend service businesses first or a verified external inventory bridge; do not automatically move a full warehouse module into Phase 1. Acceptance: goods customers cannot activate an unsupported stock model; imported stock balances tie to the inventory control account; physical-count variances and cutoff have documented owners. Applicable registration format still needs advisor confirmation.

18. **Specify operating controls at the action level.** References: section 6; FR-SH-005; NFR-SEC-010; FR-AU-003. “Warn” on duty conflict contradicts mandatory separate approval. Enforce no self-approval for controlled transactions and high-risk settings; changes to tax rules, series, payment beneficiaries and limits need independent review. Small-team profiles require approved compensating controls where permissible, not silent overrides. Acceptance: alternate role assignments and API calls cannot approve one's own controlled work; changed amount/payee/tax treatment invalidates approval; delegated authority has scope and expiry.

19. **Simplify sales without pretending all businesses sell alike.** References: section 8; FR-AR-003/011/013/015; FR-PH-005. Support direct invoice → deliver → collect → reconcile; quote/order is optional when a business uses it. Cash versus charge is a payment condition, not necessarily separate duplicated screens. Acceptance: a service business creates a valid direct invoice without a fake quotation/order/delivery; order-based businesses preserve approved references; invoice status, delivery status and government transmission status remain distinct. Changes after issuance follow the approved correction policy.

20. **Fix phase and evidence contradictions before sign-off.** References: section 5 versus AI-017/019/020/022; FR-PH-023 versus FR-CB-004; RPT-006 versus FR-PL-006; FR-PL-011; section 17; section 20. Phase 2 readers/2307 chaser still show Phase 1 in detailed rows; Phase 1 statement imports conflict with Phase 2 imports; payroll-derived outputs precede their specified import; removed shareholder work still shows Phase 3; close management remains an open question despite mandatory Phase 1 rows. Use one authoritative release register with dependencies and profile applicability. Replace historical “a panel ... went through every module” claims with a dated, explicitly simulated review note unless real minutes exist. Acceptance: no active requirement has inconsistent status across tables; deferred/removed rows have no implied release commitment; every release feature has an owner and demonstrated dependency coverage.

#### Proposed operating journeys

- Sell and collect: direct invoice or optional order → policy validation and posting → delivery/transmission tracked independently → collection and withholding allocation → settlement/reconciliation → exceptions only in the workbench.
- Buy and pay: capture once → PO/non-PO/expense policy → deterministic checks and required approvals → post → separate payment authorization and release → reconcile. Produce vouchers and certificates from those same records.
- Import and reconcile: stage → prove batch completeness → validate mapping and tax/accounting dates → authorize deterministic posting → reconcile control totals → route only failures.
- Close and report: automatically collect reconciliation evidence → review material exceptions and schedules → approve adjustments → generate reconciled reports → lock version → retain filing acknowledgment and evidence. AI may draft explanations; it cannot certify completion.

#### Recommended scope decisions for parent BRD update

Keep common Phase 1 foundations: journal integrity; AR/AP and local collections/disbursements; manual/rules-based reconciliation; minimum close and balance substantiation; customer-specific required tax outputs; trial balance and basic statements; controlled import/migration; registration evidence; issuance and reporting capability as separately activated functions. Add minimal structured bank-file import if required for the pilot; defer PDF/AI bank readers. Keep four differentiator behaviors only after deterministic controls, and make bank applicability explicit (input-VAT assistance is not equally central to every bank).

Defer full procurement, warehouses, advanced asset lifecycle, portals, chat approvals, complex autonomous agents, peer benchmarks and broad industry packs until justified by an actual supported cohort. A bank coexistence deployment must retain specialist source calculations for interest, impairment/expected credit losses, instrument valuation and other excluded functions, with reconciled journals and evidence. This is a product boundary recommendation, not a claim that any particular bank may legally omit a function.

Measure outcomes per profile: median active minutes and human touches per bill/invoice; exception rate and age; duplicate-payment incidents; unmatched cash; reconciling-item age; close duration; successful first-pass migration reconciliation; and user task completion without assistance. Baseline during pilot, then agree improvement targets. Absolute invariants: balanced ledger, no duplicate posting/payment release, no uncontrolled locked-period changes, and complete traceability.

#### Primary-source context and boundaries

The IFRS Foundation distinguishes transaction translation, functional currency and presentation currency in IAS 21; this supports treating currency handling as an accounting dependency rather than a cosmetic setting. It does not by itself establish local applicability to a particular client. [IFRS Foundation — IAS 21](https://www.ifrs.org/issued-standards/list-of-standards/ias-21-the-effects-of-changes-in-foreign-exchange-rates/).

The BSP maintains bank regulations and a separate financial-reporting guidance collection, including reporting-package and validation references. Therefore a generic ledger or chart template should not be marketed as a complete prudential reporting capability without an applicability review. [BSP Manual of Regulations for Banks](https://www.bsp.gov.ph/SitePages/Regulations/MORB.aspx), [BSP financial reporting guidance](https://www.bsp.gov.ph/Pages/Regulations/GuidelinesOnTheEstablishmentOfBanks/RegulationsOnFinancialReports.aspx).

These sources were consulted for context; no full 2026 BIR/BSP legal verification or professional sign-off was performed in this workstream. The parent review should separately verify tax dates, coverage, forms, thresholds, retention and draft rules before changing regulatory assertions.


### Technology, transformation and AI roundtable

Review date: 18 September 2026. Source: original BRD-LARA-2026-V1.0, read in full. This is an AI-simulated discussion of professional perspectives, not consultation with named human experts, customer research, a security audit, or evidence that DCP components have been implemented. Recommendations and numerical gates below are proposed product decisions for accountable owners to validate.

#### Sentiments and debate

| Perspective | Sentiment | Discussion contribution |
|---|---|---|
| Platform architect | Positive on one posting engine; concerned about universal scope | Shared primitives can reduce duplication, but metadata cannot express every new accounting or regulatory behavior. Start with a modular application and separate background workers; extract services only where isolation or load evidence justifies it. |
| Security architect | Cautiously supportive | Human approval is necessary but does not prevent cross-client disclosure, document prompt injection, privileged database access, or approval of stale drafts. Permissions and validation belong outside the model. |
| SRE / operations lead | Concerned about bank-scale readiness | Unique invoice numbers, repeat-safe imports, durable transmission, recovery and reconciliation need explicit failure tests. A latency target without workload and network definitions cannot prove readiness. |
| AI product specialist | Excited by local evidence workflows; skeptical of agent count | Forty named features or six agents do not establish differentiation. Measure fewer corrections, less chasing and faster resolution. Deterministic checks should remain usable when AI is off. |
| Transformation / adoption lead | Positive on role-specific work; concerned about rollout burden | Finance users should complete familiar jobs in one place. A guided pilot, task-based training, simple defaults and visible exception ownership matter more than chat channels at launch. |

Disagreement resolved: the architect favors broad reusable engines; the transformation lead warns against building a workflow platform before the first accounting journey works. Recommendation: retain shared contracts, implement only the selected launch journeys, and add configurable cases when validated. AI product favors early capture and explanations; security requires release evaluations and a manual path first. Recommendation: pilot AI as optional assistance after deterministic posting and controls pass. These are reasoned perspectives, not votes from external practitioners.

#### Findings and recommended BRD changes

##### TECH-01 — Qualify reuse instead of treating it as proven (high)
Original: sections 1, 11, 16–18; FR-PL-001/012; INT-EIS-001–015; AI-GR-001–007.
Replace claims that DCP already owns most hard parts or retention is solved with candidate reuse subject to evidence. Qualify SyncTax, JANUS, GAIA and Daedalus separately for API coverage, ownership/licensing, tenant isolation, support, version compatibility, performance, deployment and failure behavior. Standalone means a single supported product contract; describe whether bundled internal services require additional installations or licenses. No internal code or service evidence was supplied for this review.
Acceptance: engineering signs a fit-gap matrix and end-to-end proof for each reused component before committing delivery estimates; every unmet mandatory requirement has an owned adapter, replacement or release blocker. Client-facing availability is tested during each component outage.

##### TECH-02 — Make architecture a decision record, not a coding-tool promise (high)
Original: section 16; OBJ-6/7; FR-SH-001–011.
Recommend a modular transactional core, background workers, object storage and explicit service contracts as the initial design to evaluate. Keep TypeScript/PostgreSQL and the unnamed Python framework as options until assessed; no claim about hiring advantage without team evidence. Do not infer delivery feasibility from Claude Code. AI-generated code receives the same accounting review, security review and release tests. Delete 'no outside licence terms apply'; inventory all frameworks, libraries, models and reused components for review.
Acceptance: engineering records the selected stack, operating cost, support skills, component inventory and licensing disposition; demonstrates an invoice, posting, transmission and reversal at the agreed launch load. No unresolved critical dependency/licensing issue at release. NIST SSDF supports a secure development lifecycle, including third-party component management [S7].

##### TECH-03 — Commit ledger and transmission work durably (critical)
Original: FR-SH-001/006; INT-EIS-001/004/005/006; FR-FI-008.
Posting, document issuance and the durable work record must commit consistently. Recommend transactional outbox plus repeat-safe consumers; specify business idempotency keys, duplicate detection, bounded retry with backoff, dead-letter handling and recovery. Track 'sent, awaiting acknowledgement' independently of confirmed acceptance. A timeout cannot imply rejection or justify blindly issuing a new invoice. AWS describes outbox as addressing database/message dual writes and calls for idempotent consumers [S1].
Acceptance: fault injection at every commit/send/ack boundary causes zero missing committed documents and zero duplicate ledger effects; replaying the same import/event 100 times produces one business result, with attempts retained. Daily issued/accepted reconciliation explains every difference.

##### TECH-04 — Specify safe numbering and correction state machines (critical)
Original: NFR-PER-003; COMP-INV-001/012/015/016/017; COMP-AUD-003; INT-EIS-004/015.
Distinguish internal record identifiers from regulated document series. Define tenant, branch, document type and authorized series scope; allocate official numbers atomically at issuance and never recycle issued numbers. Preserve voided/unused evidence and apply advisor-approved correction routes. PostgreSQL ordinary sequences do not provide gapless numbering; locking-based counters have concurrency costs [S2]. 'Strong locking' alone is insufficient design evidence.
Acceptance: agreed peak-concurrency, rollback and crash tests demonstrate uniqueness, correct series boundaries, no reuse and a complete explanation of any unused number. Source documents remain immutable while payload repair history and permissible accounting corrections are independently auditable.

##### TECH-05 — Version configuration as controlled software (high)
Original: INT-EIS-010; FR-SH-002/004/005; NFR-OPS-003; AI-026; sections 16–19.
Replace 'every change is configuration rather than code' with 'use configuration when the validated rule model supports the change; otherwise assess a versioned software release.' Rules need source, effective date, reviewer, impact preview, test examples and rollback/recovery plan. Separate rate/table changes from new algorithms, schemas or correction behavior. Allow scoped extensions through reviewed contracts rather than unlimited client scripting.
Acceptance: historical reports reproduce their original rule versions; future-dated configuration cannot affect earlier transactions; each approved rule has passing examples and regression evidence. Unsupported rule changes are blocked from activation, not approximated by AI.

##### TECH-06 — Prove isolation beyond database rows (critical)
Original: NFR-SEC-009/014/015; FR-PL-016; AI-GR-004; AI-008/030/032.
Tenant/entity/branch and role authorization must apply to APIs, attachments, exports, search/vector retrieval, caches, queues, tools, logs and background jobs. PostgreSQL RLS can help, but owners and privileged roles can bypass policies [S3]; it is not the whole isolation design. Support access requires time-limited authorization and auditable access. Cross-client cockpit aggregates must be separately authorized.
Acceptance: adversarial tests across every surface return zero unauthorized records; credentials with owner/BYPASSRLS powers cannot run normal application requests; revocation invalidates access to queued work and retrieval. Security owner approves residual risks before production.

##### TECH-07 — Harden human approval and high-risk actions (critical)
Original: section 6; FR-SH-005; NFR-SEC-001/005/010/014; AI-GR-001.
Enforce separation of preparer and approver where required; a warning alone cannot meet an enforced rule. Validate permissions and approved document version again when posting. Material changes invalidate approval. Require MFA for privileged users and approvers; evaluate risk-based step-up for payee bank changes, exports and payment release. Preserve applicable registration-specific authentication constraints pending advisor confirmation.
Acceptance: self-approval, stale approval, unauthorized delegation and post-revocation execution fail controlled tests; payee bank detail changes require separate approval and evidence. Emergency access expires automatically and is reviewed.

##### TECH-08 — Add AI data-boundary and tool protections (critical)
Original: AI-GR-001–007; FR-PL-012/013/014; AI-018/021/028.
Treat uploaded invoices, email, contracts and retrieved text as untrusted evidence, never instructions. Use constrained tool schemas and allowlisted actions; no arbitrary SQL, shell or external sending from model output. Validate drafts deterministically and enforce permissions before retrieval and before tools execute. Model/service contracts must cover processing locations, retention, subprocessors, training use, deletion and tenant opt-outs. Document prompt injection is a recognized risk [S4].
Acceptance: adversarial document tests cannot trigger posting, approval, unauthorized disclosure or external sends; every tool action has actor, tenant, evidence and result. AI-off mode retains the full manual accounting workflow. Disable compromised behavior independently by tenant and feature.

##### TECH-09 — Introduce an AI release evaluation gate (high)
Original: OBJ-5; AI-001/002/006; AI-GR-002/006; section 19.
Keep 70% unchanged bill capture as an outcome hypothesis, not a safety metric. Benchmark field accuracy and financially material error separately on consented or synthetic local examples; stratify by supplier, image quality, language and document type. Report abstention rate, false positives, correction effort, latency and cost. Confidence must be empirically calibrated, not a model's unsupported self-rating. NIST's GenAI profile is a useful voluntary lifecycle-risk reference [S5].
Acceptance: initial proposed pilot evaluation uses at least 200 held-out representative bills, no training leakage and accountant adjudication; report sample size and uncertainty. Zero unauthorized actions, balanced draft totals and evidence completeness are hard gates; Product and Finance approve field-error thresholds before release. Re-evaluate model, prompt or retrieval changes; roll back degraded versions.

##### TECH-10 — Split deterministic compliance from AI explanation (high)
Original: AI-003/013/015/016/027; FR-AU-003; INT-EIS-012; OBJ-3.
Schema checks, arithmetic, reconciliation, required fields, known rates and deadlines are deterministic controls. AI can extract uncertain data, explain exceptions and draft remedies. Readiness should show failed checks, evidence coverage, stale evidence and unresolved blockers; no blended green score that conceals a critical gap. Do not represent readiness as regulator certification or guarantee zero rejection.
Acceptance: AI disabled produces identical deterministic control results; one critical failed control prevents a 'ready' status; each finding identifies rule version, source records, reason and owner. Known format-test cases all pass before export; actual external rejection causes are tracked separately from LARA validation defects.

##### TECH-11 — Deliver evidence-backed answers and snapshots (high)
Original: AI-008/023/028; AI-GR-007; FR-SH-011; FR-TX-010.
Use approved reporting/metric definitions for amounts; let AI interpret a permission-filtered result rather than calculate ledger figures freely. Every answer includes entity, period, currency, as-of time, inclusion basis and source links. Show when data are stale, incomplete or unreconciled. The saved report remains usable without chat.
Acceptance: agreed finance question set reconciles exactly to canonical reports; unsupported questions trigger clarification or explicit inability to answer; source links remain authorization-checked. Changing period/entity visibly changes context and never silently mixes companies.

##### TECH-12 — Make differentiated workflows measurable (medium)
Original: AI-013/015/016/019/021/023; INT-EIS-014; sections 12/17.
Prioritize three propositions: (1) evidence-linked Philippine compliance exceptions with a clear fix path; (2) document-to-draft-to-2307/payment traceability; (3) recoverable issuance-to-BIR-status evidence. Later add 'explain this balance' and rule-version impact preview. These are differentiation hypotheses; no market evidence establishes uniqueness. Six agents are an implementation grouping, not a user value claim.
Acceptance: pilot each selected proposition against the same team's baseline; proposed target is 30% less median handling time without higher material-error rates. Track review time and false alarms so apparent automation does not merely move work to approvers.

##### TECH-13 — One work hub, several actionable views (high)
Original: FR-SH-010; FR-PL-015; AI-029; NFR-USE-001.
Ship the common work hub in Phase 1; add AI producers by their phase. Give billing, AP, treasury, tax, approvers and auditors relevant views with owner, due date, amount, reason, source and next action. Preserve specialist workspaces for reconciliation and close; a common queue must not become a flat list of everything. Deduplicate alerts, group related exceptions, support delegation and escalation, and show document progress without switching modules.
Acceptance: at least 8 representative pilot users complete agreed daily tasks; proposed gate is 90% task completion without help, no lost/duplicate items, and 30% shorter median time than baseline. Bulk approval shows per-item exceptions and retains individual audit decisions.

##### TECH-14 — Design for accessibility and weak connections (medium)
Original: NFR-USE-001/002; FR-PL-005/013; FR-AR-022/023; AI-018.
Recommend WCAG 2.2 AA as the product target; W3C advises the current 2.2 standard while 2.1 remains a recommendation [S6]. Include keyboard operation, visible focus, meaningful errors, sufficient targets and accessible authentication. Save drafts with clear sync state and safe retry; offline drafts never issue official numbers or post. Start capture in the web app and add one validated messaging channel later, rather than four integrations at once. Invoice verification must reveal only approved minimal fields through non-guessable identifiers.
Acceptance: keyboard and screen-reader tests cover posting, approval and correction; pilot at an agreed throttled network profile; reconnect/retry produces one draft and no duplicate posting. Public invoice verification is tested for enumeration and unauthorized personal-data exposure.

##### TECH-15 — Define service levels using the selected client workload (high)
Original: NFR-PER-001/002; NFR-AVL-001; NFR-DAT-002/003; NFR-OPS-001; FR-FI-009.
Specify launch branch count, active users, posting rate, annual ledger lines, report size and network conditions. Measure interactive operations separately from asynchronous exports. Report uptime, BIR dependency failures and queue age separately; external outages do not erase LARA's escalation responsibility. Validate RPO 15 minutes/RTO 4 hours against the entire system, including keys, documents, rules and queues. Do not assume a bank accepts the 99.5% default.
Acceptance: SRE and pilot client sign the workload/service profile; production-like load meets agreed p95 targets; quarterly recovery restores reconciled balances, evidence and pending transmissions within RPO/RTO. A tested outage runbook and named on-call owner exist before go-live.

##### TECH-16 — Protect evidence and define retention by category (high)
Original: COMP-AUD-001/006/008; NFR-DAT-001/004/008/009; INT-EIS-014.
Hash chaining supports tamper detection but does not on its own make privileged rewriting impossible. Require protected independent checkpoints or immutable evidence storage, restricted administration and verification. Separate accounting retention/legal hold from backup rotation, debug logs and AI prompt retention; do not assume every transient log and backup must remain ten years. Tax/privacy owners approve the retention schedule; technical review does not determine legal periods.
Acceptance: deliberate log deletion/modification is detected; evidence export verifies checksums and references; legal holds prevent scheduled deletion; restoration preserves audit continuity. Sensitive prompts and operational logs follow approved minimization and deletion policy.

##### TECH-17 — Pilot adoption with migration and exit evidence (high)
Original: section 15; FR-PL-007/015; AI-005/022; OBJ-4/6/7.
Use a resumable go-live journey: eligibility and scope, setup, data mapping, reconciled opening balances, practice, required approvals, cutover and monitored operation. Record unresolved differences and owners. Stage rollout by company or branch where legally/accountingly supportable, with explicit rollback before issuance and a reconciled continuity plan after issuance. Include customer export/exit capability and role-based practice tasks.
Acceptance: Finance signs opening TB, AR/AP aging and source-control reconciliation; no unexplained difference above approved materiality; users complete key role tasks before access to live posting. At least one recovery rehearsal and a supported first close precede broader rollout. Export completeness is proven on a pilot tenant.

##### TECH-18 — Repair phase traceability and gate bank support (high)
Original: section 5 versus AI-017/019/020/022/029, FR-PH-023, FR-CB-004; FR-FI-005/006/007; section 20.
Align AI-017/019/020/022 to Phase 2 as section 5 states; the common queue stays Phase 1 while later AI producers attach to it. Resolve bank-statement import Phase 1/2 inconsistency. The parent review inspected the raw DOCX XML and confirmed nine final AI rows contain phase numbers only, without recoverable IDs or descriptions. Record this as a source defect. Any replacement requirements must be explicitly marked newly authored, with fresh identifiers and rationale; do not present reconstructed intent as original content. Bank readiness cannot be asserted while a selected institution requires deferred currency/FCDU/DST/BSP mappings. Define supported institution profile and capability matrix; unsupported clients wait or trigger a deliberate release-scope decision.
Acceptance: one authoritative requirements register has ID, owner, phase, dependency, validation and release gate; automated/document review finds zero contradictory phases. No launch claim for a client until every mandatory capability for its approved profile passes an end-to-end scenario.

#### Proposed sequence

1. Before scope approval: name the pilot institution/business profile; complete dependency, reuse and legal-source matrices; settle the critical contradictions.
2. First demonstrable slice: capture/import one invoice, review, post once, transmit reliably, handle rejection and reconcile, with complete evidence and tenant isolation.
3. Pilot readiness: load, recovery, authorization, migration, accessibility and task-completion gates; rule and AI evaluation suites; role-based training.
4. Controlled rollout: optional AI capture/coding and evidence explanations in the same work hub; measure correction burden and handling time.
5. Expand only after observed value: 2307 follow-up, close assistance, permission-aware reporting, additional channels and industry packs. Keep peer benchmarks and client-built agents deferred until privacy, aggregation and operational controls are proven.

#### Primary technical sources verified for this review

S1. AWS, [Transactional outbox pattern](https://docs.aws.amazon.com/en_en/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html): database/event consistency and repeat-safe consumers. Pattern reference; not a recommendation to select AWS.
S2. PostgreSQL, [CREATE SEQUENCE](https://www.postgresql.org/docs/current/sql-createsequence.htm): sequences are not gapless; counter locking has concurrency costs.
S3. PostgreSQL, [Row security policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html): owner and privileged-role bypass behavior.
S4. OWASP, [Prompt injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/): untrusted model inputs can redirect behavior.
S5. NIST, [Generative AI Profile, AI 600-1](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence): voluntary lifecycle framework. Proposed thresholds in this review are ours, not NIST mandates.
S6. W3C, [WCAG 2.2](https://www.w3.org/TR/WCAG22/): current recommended accessibility target; does not invalidate WCAG 2.1.
S7. NIST, [Secure Software Development Framework](https://csrc.nist.gov/projects/ssdf): secure lifecycle reference. DCP licensing and delivery assumptions still require internal review.

#### Cross-panel response: controlled bank coexistence

Agree with the accounting/process panel that a controlled coexistence pilot is safer and smaller than declaring support for all universal-bank functions. The BRD should state the operating boundary in business terms: each source system, book, account and transaction family has one authoritative origin; LARA receives the approved granularity and retains source references, counts and totals. A source remains responsible for excluded subledgers or instrument computations. FX, FCDU, DST and other institution-specific data may enter through qualified interfaces only if the selected client's complete accounting and reporting obligations can be demonstrated; an import does not erase a missing capability.

Engineering acceptance: test opening balances, daily and period-end deltas, duplicate and late deliveries, rejected batches, correction/reversal linkage and control-account reconciliation. Replaying a feed must not double-count; a partial batch must have a defined atomicity/recovery policy. No undefined dual ownership of tax calculations, official invoice series, ledger postings or reporting. Finance and the source-system owner sign the boundary and every unexplained reconciling item before cutover. Position a limited pilot as the approved scope only; do not call it a complete replacement bank CAS until all required capabilities and statutory outputs are proven.


