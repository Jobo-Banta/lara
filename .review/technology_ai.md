# Technology, transformation and AI roundtable

Review date: 18 September 2026. Source: original BRD-LARA-2026-V1.0, read in full. This is an AI-simulated discussion of professional perspectives, not consultation with named human experts, customer research, a security audit, or evidence that DCP components have been implemented. Recommendations and numerical gates below are proposed product decisions for accountable owners to validate.

## Sentiments and debate

| Perspective | Sentiment | Discussion contribution |
|---|---|---|
| Platform architect | Positive on one posting engine; concerned about universal scope | Shared primitives can reduce duplication, but metadata cannot express every new accounting or regulatory behavior. Start with a modular application and separate background workers; extract services only where isolation or load evidence justifies it. |
| Security architect | Cautiously supportive | Human approval is necessary but does not prevent cross-client disclosure, document prompt injection, privileged database access, or approval of stale drafts. Permissions and validation belong outside the model. |
| SRE / operations lead | Concerned about bank-scale readiness | Unique invoice numbers, repeat-safe imports, durable transmission, recovery and reconciliation need explicit failure tests. A latency target without workload and network definitions cannot prove readiness. |
| AI product specialist | Excited by local evidence workflows; skeptical of agent count | Forty named features or six agents do not establish differentiation. Measure fewer corrections, less chasing and faster resolution. Deterministic checks should remain usable when AI is off. |
| Transformation / adoption lead | Positive on role-specific work; concerned about rollout burden | Finance users should complete familiar jobs in one place. A guided pilot, task-based training, simple defaults and visible exception ownership matter more than chat channels at launch. |

Disagreement resolved: the architect favors broad reusable engines; the transformation lead warns against building a workflow platform before the first accounting journey works. Recommendation: retain shared contracts, implement only the selected launch journeys, and add configurable cases when validated. AI product favors early capture and explanations; security requires release evaluations and a manual path first. Recommendation: pilot AI as optional assistance after deterministic posting and controls pass. These are reasoned perspectives, not votes from external practitioners.

## Findings and recommended BRD changes

### TECH-01 — Qualify reuse instead of treating it as proven (high)
Original: sections 1, 11, 16–18; FR-PL-001/012; INT-EIS-001–015; AI-GR-001–007.
Replace claims that DCP already owns most hard parts or retention is solved with candidate reuse subject to evidence. Qualify SyncTax, JANUS, GAIA and Daedalus separately for API coverage, ownership/licensing, tenant isolation, support, version compatibility, performance, deployment and failure behavior. Standalone means a single supported product contract; describe whether bundled internal services require additional installations or licenses. No internal code or service evidence was supplied for this review.
Acceptance: engineering signs a fit-gap matrix and end-to-end proof for each reused component before committing delivery estimates; every unmet mandatory requirement has an owned adapter, replacement or release blocker. Client-facing availability is tested during each component outage.

### TECH-02 — Make architecture a decision record, not a coding-tool promise (high)
Original: section 16; OBJ-6/7; FR-SH-001–011.
Recommend a modular transactional core, background workers, object storage and explicit service contracts as the initial design to evaluate. Keep TypeScript/PostgreSQL and the unnamed Python framework as options until assessed; no claim about hiring advantage without team evidence. Do not infer delivery feasibility from Claude Code. AI-generated code receives the same accounting review, security review and release tests. Delete 'no outside licence terms apply'; inventory all frameworks, libraries, models and reused components for review.
Acceptance: engineering records the selected stack, operating cost, support skills, component inventory and licensing disposition; demonstrates an invoice, posting, transmission and reversal at the agreed launch load. No unresolved critical dependency/licensing issue at release. NIST SSDF supports a secure development lifecycle, including third-party component management [S7].

### TECH-03 — Commit ledger and transmission work durably (critical)
Original: FR-SH-001/006; INT-EIS-001/004/005/006; FR-FI-008.
Posting, document issuance and the durable work record must commit consistently. Recommend transactional outbox plus repeat-safe consumers; specify business idempotency keys, duplicate detection, bounded retry with backoff, dead-letter handling and recovery. Track 'sent, awaiting acknowledgement' independently of confirmed acceptance. A timeout cannot imply rejection or justify blindly issuing a new invoice. AWS describes outbox as addressing database/message dual writes and calls for idempotent consumers [S1].
Acceptance: fault injection at every commit/send/ack boundary causes zero missing committed documents and zero duplicate ledger effects; replaying the same import/event 100 times produces one business result, with attempts retained. Daily issued/accepted reconciliation explains every difference.

### TECH-04 — Specify safe numbering and correction state machines (critical)
Original: NFR-PER-003; COMP-INV-001/012/015/016/017; COMP-AUD-003; INT-EIS-004/015.
Distinguish internal record identifiers from regulated document series. Define tenant, branch, document type and authorized series scope; allocate official numbers atomically at issuance and never recycle issued numbers. Preserve voided/unused evidence and apply advisor-approved correction routes. PostgreSQL ordinary sequences do not provide gapless numbering; locking-based counters have concurrency costs [S2]. 'Strong locking' alone is insufficient design evidence.
Acceptance: agreed peak-concurrency, rollback and crash tests demonstrate uniqueness, correct series boundaries, no reuse and a complete explanation of any unused number. Source documents remain immutable while payload repair history and permissible accounting corrections are independently auditable.

### TECH-05 — Version configuration as controlled software (high)
Original: INT-EIS-010; FR-SH-002/004/005; NFR-OPS-003; AI-026; sections 16–19.
Replace 'every change is configuration rather than code' with 'use configuration when the validated rule model supports the change; otherwise assess a versioned software release.' Rules need source, effective date, reviewer, impact preview, test examples and rollback/recovery plan. Separate rate/table changes from new algorithms, schemas or correction behavior. Allow scoped extensions through reviewed contracts rather than unlimited client scripting.
Acceptance: historical reports reproduce their original rule versions; future-dated configuration cannot affect earlier transactions; each approved rule has passing examples and regression evidence. Unsupported rule changes are blocked from activation, not approximated by AI.

### TECH-06 — Prove isolation beyond database rows (critical)
Original: NFR-SEC-009/014/015; FR-PL-016; AI-GR-004; AI-008/030/032.
Tenant/entity/branch and role authorization must apply to APIs, attachments, exports, search/vector retrieval, caches, queues, tools, logs and background jobs. PostgreSQL RLS can help, but owners and privileged roles can bypass policies [S3]; it is not the whole isolation design. Support access requires time-limited authorization and auditable access. Cross-client cockpit aggregates must be separately authorized.
Acceptance: adversarial tests across every surface return zero unauthorized records; credentials with owner/BYPASSRLS powers cannot run normal application requests; revocation invalidates access to queued work and retrieval. Security owner approves residual risks before production.

### TECH-07 — Harden human approval and high-risk actions (critical)
Original: section 6; FR-SH-005; NFR-SEC-001/005/010/014; AI-GR-001.
Enforce separation of preparer and approver where required; a warning alone cannot meet an enforced rule. Validate permissions and approved document version again when posting. Material changes invalidate approval. Require MFA for privileged users and approvers; evaluate risk-based step-up for payee bank changes, exports and payment release. Preserve applicable registration-specific authentication constraints pending advisor confirmation.
Acceptance: self-approval, stale approval, unauthorized delegation and post-revocation execution fail controlled tests; payee bank detail changes require separate approval and evidence. Emergency access expires automatically and is reviewed.

### TECH-08 — Add AI data-boundary and tool protections (critical)
Original: AI-GR-001–007; FR-PL-012/013/014; AI-018/021/028.
Treat uploaded invoices, email, contracts and retrieved text as untrusted evidence, never instructions. Use constrained tool schemas and allowlisted actions; no arbitrary SQL, shell or external sending from model output. Validate drafts deterministically and enforce permissions before retrieval and before tools execute. Model/service contracts must cover processing locations, retention, subprocessors, training use, deletion and tenant opt-outs. Document prompt injection is a recognized risk [S4].
Acceptance: adversarial document tests cannot trigger posting, approval, unauthorized disclosure or external sends; every tool action has actor, tenant, evidence and result. AI-off mode retains the full manual accounting workflow. Disable compromised behavior independently by tenant and feature.

### TECH-09 — Introduce an AI release evaluation gate (high)
Original: OBJ-5; AI-001/002/006; AI-GR-002/006; section 19.
Keep 70% unchanged bill capture as an outcome hypothesis, not a safety metric. Benchmark field accuracy and financially material error separately on consented or synthetic local examples; stratify by supplier, image quality, language and document type. Report abstention rate, false positives, correction effort, latency and cost. Confidence must be empirically calibrated, not a model's unsupported self-rating. NIST's GenAI profile is a useful voluntary lifecycle-risk reference [S5].
Acceptance: initial proposed pilot evaluation uses at least 200 held-out representative bills, no training leakage and accountant adjudication; report sample size and uncertainty. Zero unauthorized actions, balanced draft totals and evidence completeness are hard gates; Product and Finance approve field-error thresholds before release. Re-evaluate model, prompt or retrieval changes; roll back degraded versions.

### TECH-10 — Split deterministic compliance from AI explanation (high)
Original: AI-003/013/015/016/027; FR-AU-003; INT-EIS-012; OBJ-3.
Schema checks, arithmetic, reconciliation, required fields, known rates and deadlines are deterministic controls. AI can extract uncertain data, explain exceptions and draft remedies. Readiness should show failed checks, evidence coverage, stale evidence and unresolved blockers; no blended green score that conceals a critical gap. Do not represent readiness as regulator certification or guarantee zero rejection.
Acceptance: AI disabled produces identical deterministic control results; one critical failed control prevents a 'ready' status; each finding identifies rule version, source records, reason and owner. Known format-test cases all pass before export; actual external rejection causes are tracked separately from LARA validation defects.

### TECH-11 — Deliver evidence-backed answers and snapshots (high)
Original: AI-008/023/028; AI-GR-007; FR-SH-011; FR-TX-010.
Use approved reporting/metric definitions for amounts; let AI interpret a permission-filtered result rather than calculate ledger figures freely. Every answer includes entity, period, currency, as-of time, inclusion basis and source links. Show when data are stale, incomplete or unreconciled. The saved report remains usable without chat.
Acceptance: agreed finance question set reconciles exactly to canonical reports; unsupported questions trigger clarification or explicit inability to answer; source links remain authorization-checked. Changing period/entity visibly changes context and never silently mixes companies.

### TECH-12 — Make differentiated workflows measurable (medium)
Original: AI-013/015/016/019/021/023; INT-EIS-014; sections 12/17.
Prioritize three propositions: (1) evidence-linked Philippine compliance exceptions with a clear fix path; (2) document-to-draft-to-2307/payment traceability; (3) recoverable issuance-to-BIR-status evidence. Later add 'explain this balance' and rule-version impact preview. These are differentiation hypotheses; no market evidence establishes uniqueness. Six agents are an implementation grouping, not a user value claim.
Acceptance: pilot each selected proposition against the same team's baseline; proposed target is 30% less median handling time without higher material-error rates. Track review time and false alarms so apparent automation does not merely move work to approvers.

### TECH-13 — One work hub, several actionable views (high)
Original: FR-SH-010; FR-PL-015; AI-029; NFR-USE-001.
Ship the common work hub in Phase 1; add AI producers by their phase. Give billing, AP, treasury, tax, approvers and auditors relevant views with owner, due date, amount, reason, source and next action. Preserve specialist workspaces for reconciliation and close; a common queue must not become a flat list of everything. Deduplicate alerts, group related exceptions, support delegation and escalation, and show document progress without switching modules.
Acceptance: at least 8 representative pilot users complete agreed daily tasks; proposed gate is 90% task completion without help, no lost/duplicate items, and 30% shorter median time than baseline. Bulk approval shows per-item exceptions and retains individual audit decisions.

### TECH-14 — Design for accessibility and weak connections (medium)
Original: NFR-USE-001/002; FR-PL-005/013; FR-AR-022/023; AI-018.
Recommend WCAG 2.2 AA as the product target; W3C advises the current 2.2 standard while 2.1 remains a recommendation [S6]. Include keyboard operation, visible focus, meaningful errors, sufficient targets and accessible authentication. Save drafts with clear sync state and safe retry; offline drafts never issue official numbers or post. Start capture in the web app and add one validated messaging channel later, rather than four integrations at once. Invoice verification must reveal only approved minimal fields through non-guessable identifiers.
Acceptance: keyboard and screen-reader tests cover posting, approval and correction; pilot at an agreed throttled network profile; reconnect/retry produces one draft and no duplicate posting. Public invoice verification is tested for enumeration and unauthorized personal-data exposure.

### TECH-15 — Define service levels using the selected client workload (high)
Original: NFR-PER-001/002; NFR-AVL-001; NFR-DAT-002/003; NFR-OPS-001; FR-FI-009.
Specify launch branch count, active users, posting rate, annual ledger lines, report size and network conditions. Measure interactive operations separately from asynchronous exports. Report uptime, BIR dependency failures and queue age separately; external outages do not erase LARA's escalation responsibility. Validate RPO 15 minutes/RTO 4 hours against the entire system, including keys, documents, rules and queues. Do not assume a bank accepts the 99.5% default.
Acceptance: SRE and pilot client sign the workload/service profile; production-like load meets agreed p95 targets; quarterly recovery restores reconciled balances, evidence and pending transmissions within RPO/RTO. A tested outage runbook and named on-call owner exist before go-live.

### TECH-16 — Protect evidence and define retention by category (high)
Original: COMP-AUD-001/006/008; NFR-DAT-001/004/008/009; INT-EIS-014.
Hash chaining supports tamper detection but does not on its own make privileged rewriting impossible. Require protected independent checkpoints or immutable evidence storage, restricted administration and verification. Separate accounting retention/legal hold from backup rotation, debug logs and AI prompt retention; do not assume every transient log and backup must remain ten years. Tax/privacy owners approve the retention schedule; technical review does not determine legal periods.
Acceptance: deliberate log deletion/modification is detected; evidence export verifies checksums and references; legal holds prevent scheduled deletion; restoration preserves audit continuity. Sensitive prompts and operational logs follow approved minimization and deletion policy.

### TECH-17 — Pilot adoption with migration and exit evidence (high)
Original: section 15; FR-PL-007/015; AI-005/022; OBJ-4/6/7.
Use a resumable go-live journey: eligibility and scope, setup, data mapping, reconciled opening balances, practice, required approvals, cutover and monitored operation. Record unresolved differences and owners. Stage rollout by company or branch where legally/accountingly supportable, with explicit rollback before issuance and a reconciled continuity plan after issuance. Include customer export/exit capability and role-based practice tasks.
Acceptance: Finance signs opening TB, AR/AP aging and source-control reconciliation; no unexplained difference above approved materiality; users complete key role tasks before access to live posting. At least one recovery rehearsal and a supported first close precede broader rollout. Export completeness is proven on a pilot tenant.

### TECH-18 — Repair phase traceability and gate bank support (high)
Original: section 5 versus AI-017/019/020/022/029, FR-PH-023, FR-CB-004; FR-FI-005/006/007; section 20.
Align AI-017/019/020/022 to Phase 2 as section 5 states; the common queue stays Phase 1 while later AI producers attach to it. Resolve bank-statement import Phase 1/2 inconsistency. The parent review inspected the raw DOCX XML and confirmed nine final AI rows contain phase numbers only, without recoverable IDs or descriptions. Record this as a source defect. Any replacement requirements must be explicitly marked newly authored, with fresh identifiers and rationale; do not present reconstructed intent as original content. Bank readiness cannot be asserted while a selected institution requires deferred currency/FCDU/DST/BSP mappings. Define supported institution profile and capability matrix; unsupported clients wait or trigger a deliberate release-scope decision.
Acceptance: one authoritative requirements register has ID, owner, phase, dependency, validation and release gate; automated/document review finds zero contradictory phases. No launch claim for a client until every mandatory capability for its approved profile passes an end-to-end scenario.

## Proposed sequence

1. Before scope approval: name the pilot institution/business profile; complete dependency, reuse and legal-source matrices; settle the critical contradictions.
2. First demonstrable slice: capture/import one invoice, review, post once, transmit reliably, handle rejection and reconcile, with complete evidence and tenant isolation.
3. Pilot readiness: load, recovery, authorization, migration, accessibility and task-completion gates; rule and AI evaluation suites; role-based training.
4. Controlled rollout: optional AI capture/coding and evidence explanations in the same work hub; measure correction burden and handling time.
5. Expand only after observed value: 2307 follow-up, close assistance, permission-aware reporting, additional channels and industry packs. Keep peer benchmarks and client-built agents deferred until privacy, aggregation and operational controls are proven.

## Primary technical sources verified for this review

S1. AWS, [Transactional outbox pattern](https://docs.aws.amazon.com/en_en/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html): database/event consistency and repeat-safe consumers. Pattern reference; not a recommendation to select AWS.
S2. PostgreSQL, [CREATE SEQUENCE](https://www.postgresql.org/docs/current/sql-createsequence.htm): sequences are not gapless; counter locking has concurrency costs.
S3. PostgreSQL, [Row security policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html): owner and privileged-role bypass behavior.
S4. OWASP, [Prompt injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/): untrusted model inputs can redirect behavior.
S5. NIST, [Generative AI Profile, AI 600-1](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence): voluntary lifecycle framework. Proposed thresholds in this review are ours, not NIST mandates.
S6. W3C, [WCAG 2.2](https://www.w3.org/TR/WCAG22/): current recommended accessibility target; does not invalidate WCAG 2.1.
S7. NIST, [Secure Software Development Framework](https://csrc.nist.gov/projects/ssdf): secure lifecycle reference. DCP licensing and delivery assumptions still require internal review.

## Cross-panel response: controlled bank coexistence

Agree with the accounting/process panel that a controlled coexistence pilot is safer and smaller than declaring support for all universal-bank functions. The BRD should state the operating boundary in business terms: each source system, book, account and transaction family has one authoritative origin; LARA receives the approved granularity and retains source references, counts and totals. A source remains responsible for excluded subledgers or instrument computations. FX, FCDU, DST and other institution-specific data may enter through qualified interfaces only if the selected client's complete accounting and reporting obligations can be demonstrated; an import does not erase a missing capability.

Engineering acceptance: test opening balances, daily and period-end deltas, duplicate and late deliveries, rejected batches, correction/reversal linkage and control-account reconciliation. Replaying a feed must not double-count; a partial batch must have a defined atomicity/recovery policy. No undefined dual ownership of tax calculations, official invoice series, ledger postings or reporting. Finance and the source-system owner sign the boundary and every unexplained reconciling item before cutover. Position a limited pilot as the approved scope only; do not call it a complete replacement bank CAS until all required capabilities and statutory outputs are proven.
