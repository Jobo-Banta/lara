from pathlib import Path
import re,json
from docx import Document
from docx.text.paragraph import Paragraph
from docx.table import Table

root=Path('D:/DCP/LARA')
d=Document(root/'docs/DCP_BRD_LARA_v1_0.docx')
sections={}; current=0
for el in d.element.body:
    if el.tag.endswith('}p'):
        p=Paragraph(el,d); text=p.text.strip()
        m=re.match(r'^(\d+)\.\s',text)
        if m: current=int(m[1]); sections[current]=[]
        sections.setdefault(current,[]).append(('p',text,p.style.name if p.style else ""))
    elif el.tag.endswith('}tbl'):
        sections.setdefault(current,[]).append(('t',Table(el,d),''))

edits={}
phases={}
def edit(id,text,phase=None):
    edits[id]=text
    if phase is not None: phases[id]=phase

edit('OBJ-1','Support taxpayer CAS registration with an evidence-linked checklist; authority-issued acknowledgement is an external outcome, not a software guarantee.')
edit('FR-SH-003','One party identity with customer, supplier, employee and bank roles; tenant and role permissions protect sensitive fields. Keep AR and AP balances separate; no automatic netting or cross-tenant identity sharing.')
edit('FR-SH-005','One approval and limits engine with document-version checks, delegation, amount limits, signatories and enforced maker-checker restrictions. Material edits invalidate approval. No self-approval through role switching.')
edit('FR-SH-006','Shared ingestion stages: receive, malware check, stage, validate, map, review and commit through authorized posting. Adapters retain source IDs, batch totals, duplicates and retry history. AI is optional; rejected records remain recoverable.')
edit('FR-SH-010','One task service for approvals, drafts, rejected transmissions, imports, reconciliation and control exceptions; role-specific views show one owner, deadline, reason, source and next action. Group duplicate alerts and support controlled delegation.')
edit('FR-CO-004','Customer and supplier identity, registered address and TIN/branch code where legally required. Validate format and applicable mandatory fields; represent legitimate missing or non-applicable identifiers explicitly, never with dummy TINs.')
edit('FR-CO-007','Store permit type, number, dates, branch scope and declared software version under the applicable approved regulatory profile. PTI-specific fields are conditional pending verified final authority; no universal PTI gate based only on a draft.')
edit('FR-GL-004','Basic recurring manual-journal templates and scheduled reversal drafts through the posting engine. Broader contract and asset schedules use FR-SH-008 in Phase 2.', '1')
edit('FR-GL-010','Control accounts accept only authorized subledger postings or controlled source-system and migration batches. Each external batch includes source totals, detail or traceable references, reconciliation and independent approval; free-form manual posting remains blocked.')
edit('FR-GL-011','Freeze individual accounts and configure adjustment cut-offs. Finance Director authority cannot bypass a hard lock; use the controlled correction process in FR-GL-021.')
edit('FR-GL-017','Phase 1 close checklist per entity and period with owners, dependencies, evidence and independent sign-off; hard lock only after required reconciliations and unresolved-item disposition.', '1')
edit('FR-GL-018','Phase 1 substantiation of material and control balance-sheet accounts, with supporting schedules, preparer, reviewer and aged reconciling items. The controller approves coverage and materiality; expand automation later.', '1')
edit('FR-GL-021','Post-close corrections use approved current-open-period adjustments unless an explicitly authorized reopen is permitted. Reopening requires reason, independent approval, audit event and a new report version; preserve original issued reports and assess refiling. Never bypass hard locks or edit original entries.')
edit('FR-AR-003','Direct invoice entry is supported. Approved quotations and sales orders may convert to invoices without re-entry when enabled by the customer process; never require dummy orders.', '1')
edit('FR-AR-004','Sales adjustment documents use separate controlled series and link to original invoices. Enable credit notes, debit notes or additional invoices only according to a verified effective regulatory profile.')
edit('FR-AR-005','Statutory discounts and VAT treatment use advisor-approved eligibility, transaction categories, rates and evidence rules; protect identity data. Required before onboarding any customer relying on this workflow.', '2 conditional')
edit('FR-AR-014','Apply, unapply and reapply payments, advances and credits to open invoices with versioned allocation history. Posted accounting effects require linked reversal or adjustment entries; closed-period balances cannot silently change.')
edit('FR-AR-021','Support QR generation and read-back testing under the approved invoice profile. Required QR payload and legal applicability must be verified before enforcement; a QR code alone is not proof of authenticity.')
edit('FR-AR-023','Optional privacy-preserving invoice verification using non-enumerable tokens, rate limits and minimal fields. No public TIN, address, full invoice or BIR acceptance assertion without authorized evidence.', '2')
edit('FR-AP-001','Support direct bills and policy-controlled purchase requests and POs. Orders are optional for approved expense categories; required procurement controls cannot be bypassed.', '1')
edit('FR-AP-003','Compute applicable expanded/final withholding using effective-dated rules. Generate and reconcile 2307 and, for taxpayers with final-withholding obligations, 2306 before their first live obligated transaction.', '1 applicable')
edit('FR-AP-005','Payments have distinct prepared, approved, released and settled states; provide vouchers, credits and reconciliation. Supplier bank changes require independent verification and approval; a payment file or check print does not prove settlement.')
edit('FR-AP-010','Checks issued register, void and stale-check treatment, with check printing and release scheduling enabled only for customers using checks; go-live requires tested bank layouts and signatories.', '1 conditional')
edit('FR-CB-004','Phase 1 standard reviewed CSV statement import and deterministic matching suggestions; Phase 2 additional formats and AI matching. Posting and reconciliation remain approved, with unmatched lines visible.', '1 basic; 2 advanced')
edit('FR-IN-003','Inventory Book generated from a complete, reconciled stock record. Required before goods-business go-live together with applicable inventory movement and valuation capabilities; never generated from unsupported stock data.', '2 conditional')
edit('FR-TX-004','Applicable return worksheets with transaction drill-down: Phase 1 2550Q, 0619-E and 1601-EQ; 1601-FQ, GRT and other returns become release gates whenever the selected cohort requires them. 1604-E is Phase 2 unless its due date falls inside the pilot obligation window.', '1 applicable; 2 remainder')
edit('FR-PL-001','Attach files with checksums, version history, tenant permissions and the approved record-class retention/legal-hold policy. JANUS is a candidate adapter subject to qualification, not an assumed dependency.')
edit('FR-PL-011','Removed from scope. Shareholder registers and share transfers remain corporate secretarial work outside LARA.', 'Removed')
edit('FR-PL-012','Client AI integrations through a qualified gateway, scoped identities and allowlisted draft/report tools; no direct financial or production database authority.', '3')
edit('FR-PL-013','Pilot one justified messaging channel after core web workflows are stable. Identity binding, minimal sensitive content, permission checks and deep links to authenticated review are mandatory.', '2')
edit('FR-PH-023','Phase 1 one standard bank CSV import and tested check layout per pilot bank; additional Philippine bank formats and reference matching adapters arrive in Phase 2.', '1 basic; 2 adapters')
edit('FR-PH-027','Lease deposits, advances and escalations use effective-dated approved withholding and accounting rules; do not hard-code one rate for all parties or transaction types.', '2')
edit('FR-PH-029','Phase 1 reviewed spreadsheet migration from manual books. Photo/OCR digitization AI-022 is Phase 2; all opening balances still require reconciliation and sign-off.', '1 manual; 2 AI')
edit('FR-FI-002','Support passed-on GRT and related income treatment only through institution-specific rules approved by the tax advisor, with source citations and effective dates.', '1 conditional')
edit('FR-FI-004','Final withholding on applicable passive-income payments with certificates, alphalists and remittance worksheets, or a documented retained-source-system boundary with reconciled outputs. No incomplete live tax workflow.', '1 applicable')
edit('FR-FI-005','Separate RBU and FCDU books, functional currencies and combined management view. Bank replacement or pilot scope requiring these books is blocked until this and FR-GL-008 are validated, or books remain explicitly in the authoritative source system.', '2 conditional')
edit('FR-FI-006','Instrument-specific DST calculations, return and payment evidence. Required before any in-scope obligated workflow; otherwise retain the verified source-system calculation and reconciled hand-off.', '2 conditional')
edit('FR-FI-007','Approved account mapping from each pilot source to LARA and statutory outputs is required in Phase 1. A reusable BSP-aligned reporting template is Phase 2; this is not a claim to provide the full BSP reporting suite.', '1 mapping; 2 template')
edit('COMP-INV-003','Show buyer identifiers when required by the current advisor-approved invoice profile, including transaction thresholds, taxpayer type and exceptions. Do not rely on an unverified single threshold.')
edit('COMP-INV-005','Apply exemption wording only where the verified invoice and tax profile requires it; distinguish VAT-exempt, non-VAT and percentage-tax treatment.')
edit('COMP-INV-013','Support configurable QR content and verifiable read-back. Draft-circular QR particulars are pending final verification, not a universal current legal rule.')
edit('COMP-INV-014','Generate structured electronic invoice data that can be extracted and transmitted under the applicable requirements; keep customer delivery evidence and distinguish issuance from live sales reporting. A scanned paper image alone is not structured invoice data.')
edit('COMP-INV-015','Posted invoices are immutable. Use the effective, advisor-approved correction document and original-reference rules; the draft credit-note/additional-invoice prescription remains conditional until verified.')
edit('COMP-AUD-002','Store immutable system posting timestamp separately from accounting date, document date and applicable tax date. Validate accounting date against period controls and preserve all dates in exports.')
edit('COMP-AUD-003','No deletion or editing of posted records. Journals use linked reversals; invoices use correction documents allowed by the effective regulatory profile. Retain voided numbers, reason, approvals and original evidence.')
edit('COMP-REG-005','Generate a PTI application pack if required by verified effective rules; draft-circular fields are preparatory and cannot be represented as authority-approved requirements.')
edit('COMP-REG-006','Assess product, platform and core-system changes against applicable registration and permit rules before release; maintain authority-reviewed impact evidence rather than assuming every change has the same filing route.')
edit('COMP-REG-008','Record permit scope and branch coverage based on verified authority instructions; prepare branch notices or applications accordingly. Do not assume one permit covers every branch.')
edit('INT-EIS-001','Commit the posting and durable outbound event atomically. Only applicable document types enter transmission under the active regulatory profile; external service response never controls the local transaction commit.')
edit('INT-EIS-002','Serialize, sign and transmit using the certified adapter and taxpayer-specific active reporting profile. Apply verified deadlines, including a three-day window only where applicable; track the legal basis and effective date.')
edit('INT-EIS-003','Separate accounting, buyer delivery, reporting and settlement statuses. Reporting includes not yet applicable, queued, sending, unknown acknowledgement, accepted and rejected, with timestamps and authoritative response references.')
edit('INT-EIS-004','Rejections and uncertain acknowledgements enter the owned task queue. Reconcile remote status before retry; transport repairs retain payload history, while financial corrections create linked documents, never edit posted invoices.')
edit('INT-EIS-005','Alerts use the effective reporting deadline and escalation owner. Bound retries with backoff and deduplication; expose service outages, remaining time and approved contingency procedure.')
edit('INT-EIS-010','Version formats, endpoints and deadlines. Simple parameter changes use tested configuration; schema, signing or protocol changes may require adapter code, certification and controlled release.')
edit('INT-EIS-013','Generate and validate QR content when required by the active approved invoice profile; preserve the profile version used.')
edit('INT-EIS-015','Support linked electronic correction documents under the verified active rules; reconcile their financial and reporting effects with the original.')
edit('AI-GR-002','Store model/prompt/rule versions, permission context, source references, output, review disposition and an uncertainty indicator where meaningful. Confidence is not a legal conclusion or a substitute for evaluation.')
edit('AI-GR-005','Contractually control model-provider training, retention, processing region and subprocessors. No shared-model training or cross-tenant learning from client data without explicit authorized consent and privacy review.')
edit('AI-003','Deterministic pre-filing reconciliation and schema checks, with optional AI explanations. External acceptance is measured separately and is not guaranteed.')
edit('AI-013','Readiness evidence view derived from deterministic checklist results, missing evidence and blocking issues; AI may explain. A score cannot mask blockers or be described as regulatory certification.')
edit('AI-015','Deterministic screening for possible missed withholding with rule citations and source evidence; optional AI explanation suggests review, not a conclusive liability determination.')
edit('AI-016','Invoice and party-status evidence checks with uncertainty shown; OCR is advisory and tax eligibility follows approved rules and human review.')
for id in ['AI-017','AI-019','AI-020','AI-022']: phases[id]='2'
edit('AI-029','AI suggestions enter the existing Phase 1 human task service; no separate agent inbox. Additional AI behaviors arrive progressively after measured benefit and safety evaluation.', '1 foundation; 2 expansion')
edit('AI-030','AI prioritization extends the Phase 2 multi-client console FR-PL-016, preserving explicit company context and isolated permissions.', '3')
edit('RPT-006','2306 in Phase 1 for obligated taxpayers; 2316 from validated external payroll data in Phase 2 or earlier if required by the selected scope.', '1 applicable; 2 payroll')
edit('RPT-007','Phase 1 trial balance, balance sheet and income statement reconciled to the ledger. Cash flow, changes in equity, notes and other statutory formats must also be available before any in-scope reporting obligation; Phase 2 expands standard packs.', '1 core; 2 expansion')
edit('NFR-SEC-002','Session controls follow the applicable verified registration profile; provide clear reauthentication and draft recovery. Do not weaken an applicable single-session control without authority approval.')
edit('NFR-SEC-004','Mandatory MFA for privileged and approval roles; support SSO and strong authentication. Apply password rotation/session settings required by the verified Annex B profile, documenting any conflict with modern identity practice and the approved resolution.')
edit('NFR-SEC-012','Security assurance roadmap with owner, cost and scope; ISO/IEC 27001 certification is a proposed milestone subject to assessment, not a promised first-year outcome.')
edit('NFR-SEC-013','Qualify one supported cloud deployment initially; private cloud/on-premise and financial-sector hosting arrangements require separate operational, security and recovery acceptance before sale. Contractual residency is verified across backups, telemetry, support and AI.')
edit('NFR-DAT-001','Record-class retention with effective legal basis, trigger date, customer policy and holds. RR 7-2024 Section 4 provides a general five-year books/records period; longer applicable sector, contract or dispute requirements may apply. Do not equate backup rotation with legal archive retention.')
edit('NFR-DAT-006','Assess and fulfill applicable NPC DPO and processing-system registration requirements, with documented applicability and current registration evidence where required.')
edit('NFR-PER-001','Pilot targets: p95 interactive response under 2 seconds and local invoice posting under 1 second, excluding external acknowledgements, under an agreed workload, device and network profile. Measure end-to-end user time separately.')
edit('NFR-PER-002','Before build commitment, approve a capacity profile covering tenants, branches, peak posts, lines, retention and concurrent reports. Validate target full-year GL export under 60 seconds at that profile; larger exports may use an asynchronous job with visible progress.')
edit('NFR-PER-003','Unique serial numbers under concurrency, with no silent reuse or unexplained gaps. Preserve issued, void, failed/reserved and cancelled number evidence according to the approved numbering profile; test crashes and retries.')
edit('NFR-USE-002','Target WCAG 2.2 AA for all critical journeys, including authentication, capture, approval and recovery; verify keyboard, focus, screen-reader and error handling behavior.')
edit('FR-PL-006','Validated payroll journal and 2316/1601-C data import from a retained payroll system in Phase 2; additional payroll integrations Phase 3. Any earlier obligation requires a supported import before activation.', '2 data; 3 connectors')
edit('FR-FI-009','Branch books, codes, inter-branch reconciliation and roll-up at the signed pilot capacity profile. Hundreds-of-branches support is a later scale claim requiring demonstrated load and operational acceptance.', '1 pilot; later scale')
edit('FR-FI-011','Trust/fiduciary books remain in a named authoritative source until separate-book capability is released. In-scope trust activity blocks replacement go-live without complete validated accounting, reporting and reconciliation.', '3 conditional')
edit('FR-AR-020','Track received PDC custody, due date, deposit, clearance, dishonor and replacement. A bounce reverses only its affected settlement/allocation and preserves other payments, original evidence and period controls.')
edit('FR-PH-010','Store supplier 2303, declarations and relevant exemption/zero-rating evidence with versions and expiry. VAT status is one input to eligibility; approved invoice, transaction and evidence checks determine proposed input VAT treatment.')
edit('FR-PH-013','Recognize withholding under the verified effective timing rule for the tax/transaction profile. Preserve accrual and payment dates, prevent duplicate recognition and route missing withholding to review before payment.')
edit('AI-018','One validated messaging channel may accept receipt photos or English/Filipino input as drafts. Identity, permissions and explicit review apply; external instructions are untrusted evidence, not authorization.', '2')
edit('AI-026','Suggest rule-setting changes and test cases from cited issuances for qualified review. Assess whether configuration, software or certification changes are necessary; never activate rules autonomously.', '3')
edit('FR-SH-002','One document registry for series, layouts and supported validation rules. Configuration reuses proven document behavior; new legal or accounting semantics require reviewed code and regression tests.')
edit('FR-SH-011','One reporting service with locked statutory templates, consistent headers and exports. Phase 1 uses approved reports and filters; broad custom report design is Phase 2.', '1 templates; 2 designer')
edit('AI-024','Advisory risk indicators with source evidence before approval; never a substitute for the required independent human approver.', '2')

def md_table(t):
    rows=[]
    actual_header=[c.text.strip() for c in t.rows[0].cells]
    for r in t.rows:
        vals=[c.text.strip().replace('\n','<br>') for c in r.cells]
        if len(set(vals))==1:
            if vals[0] in ['1','2','3','']: continue
            rows.append(('group',vals[0])); continue
        id=vals[0]
        if id in edits:
            column=2 if id.startswith('NFR-') and len(vals)==3 else 2 if id.startswith('AI-') and len(vals)==5 else 1
            vals[column]=edits[id]
        if id in phases: vals[-1]=phases[id]
        if id=='FR-PL-011': vals[2]='Removed'
        if id=='FR-FI-007': vals[2]='M mapping; S template'
        if id=='AI-003': vals[2]='All agreed deterministic cases pass; external rejections tracked separately'
        if id=='AI-026': vals[3]='Evidence and impact preview for controlled change.'
        if id=='AI-013': vals[1]='Readiness evidence view'
        if id=='AI-024': vals[1]='Review assistance'; vals[3]='Helps reviewers focus on evidenced exceptions.'
        if id=='AI-019': vals[3]='Connects missing certificates to the collection workflow.'
        if id=='AI-021': vals[3]='Proposes schedules for accounting review with linked contract evidence.'
        if id=='AI-029': vals[1]='Shared work queue'; vals[3]='Review AI drafts in the existing authorized task flow.'
        if id=='COMP-INV-015': vals[2]='Draft-specific route pending verified final authority.'
        if id=='OBJ-1': vals[2]='Authority acknowledgement recorded; every applicable checklist item linked to evidence and reviewed.'
        if id=='AI-013': vals[3]='Explains readiness without claiming assurance.'
        if id in ['AI-015','AI-016']: vals[3]='Evidence-linked local review in the transaction workflow.'
        rows.append(('row',vals))
    result=[]; header=None
    for kind,vals in rows:
        if kind=='group':
            result+=['',f'**{vals}**','']; header=None
        else:
            if header is None:
                if vals[0] in ['ID','Role','Phase','Option','Risk','Decision']:
                    header=vals; result+=['| '+' | '.join(vals)+' |','| '+' | '.join(['---']*len(vals))+' |']; continue
                header=actual_header
                result+=['| '+' | '.join(header)+' |','| '+' | '.join(['---']*len(vals))+' |']
            result+=['| '+' | '.join(v.replace('|','\\|') for v in vals)+' |']
    value='\n'.join(result)
    value=re.sub(r'\|[^\n]+\|\n\|(?: --- \|)+\n(?=\n\*\*)','',value)
    return value

def section(n):
    out=[]
    for kind,value,style in sections[n]:
        if kind=='t': out+=['',md_table(value),'']; continue
        if not value: continue
        if re.match(r'^\d+\.\s',value): out+=['## '+value]
        elif re.match(r'^\d+\.\d+\s',value): out+=['### '+value]
        elif 'Heading' in style: out+=['### '+value]
        else: out += [value]
    return '\n\n'.join(out)

out={n:section(n) for n in range(1,23)}
out[1]='''## 1 Executive summary

LARA is DCP's proposed Philippine accounting platform for controlled bookkeeping, invoicing, tax preparation and audit evidence. The product should make finance work easier through guided journeys, reusable data and evidence-backed AI drafts. Compliance outputs remain deterministic and accountable to named reviewers.

Version 1.1 narrows launch claims while preserving the bank-first commercial direction and one-codebase strategy. The recommended first release is a controlled financial-institution design-partner pilot with explicit source-system boundaries. It is not a promise to replace every bank ledger or serve every industry immediately. The pilot must complete its selected invoice-to-cash, bill-to-payment, reconciliation and first-close journeys, not merely generate a registration pack.

Banks, SMEs and retailers have different acceptance cases. Each pack must pass its own capability, usability and regulatory tests. Configuration should cover ordinary client variation; complex functionality may still require reusable code and adapters. No customer-specific code fork is planned.

Three proposed differentiators guide the roadmap: trace a reported number to its source and applicable rule; guide a new customer from migration through a reconciled first close; and resolve local cash, withholding-certificate and invoice exceptions in one work queue. These are product hypotheses to validate with target users, not claims of competitor uniqueness.

RR 26-2025 identifies a December 31, 2026 issuance transition deadline for specified groups and treats sales reporting separately. Customer coverage, existing obligations and later issuances must be checked before commitment. Product release dates follow signed scope and demonstrated readiness, not an assumed ability to finish the complete roadmap by that date.
'''
out[3]='''## 3 Business background

The source BRD identifies Philippine finance teams managing accounting, invoices, checks, withholding evidence and registration requirements across fragmented tools. LARA's business opportunity is to reduce repeated entry, exception handling and evidence assembly while delivering a repeatable DCP product.

The immediate commercial hypothesis is a financial-institution design partner because the source describes active DCP conversations in that segment. Neither market size, willingness to pay nor delivery economics has been validated in this review. Product must test these before broad launch. E-invoicing coverage does not automatically require every business to buy or replace its entire accounting system.
'''
out[4]='''## 4 Objectives and success measures

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
'''
out[5]='''## 5 Scope and releases

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
'''
out[7]='''## 7 Regulatory basis and evidence status

Maintain a regulatory register with primary source, effective date, affected taxpayer profile, reviewer, interpretation, test cases and superseded version. The requirements below are a product design baseline, not evidence that every regulation or customer application has been legally validated.

Verified in this review: RR 26-2025 describes the issuance transition and separates the subsequent sales-reporting trigger; RR 7-2024 Section 4 specifies a general five-year preservation period for books and accounting records, with the filing-related start date and extended preservation in relevant unresolved cases. See section 22 for primary sources. A contractual ten-year archive may still be offered, but is not a universal legal minimum and does not require retaining every operational backup for ten years.

Retain for advisor verification: RR 9-2009; RMC 5-2021; RMO 9-2021 and Annex B; the exact application of RMC 10-2020; RR 7-2024 as amended and RMC 77-2024; RR 11-2025 as amended; RR 16-2006 and later books submission rules; RA 10173 and applicable NPC rules; and institution-specific BSP and accounting requirements. Old retention references RR 17-2013/RR 5-2014 are historical, not the sole current baseline.

The source refers to an August 2026 draft e-invoice circular. Final primary authority for its PTI, QR payload, branch coverage, provider restrictions and exact correction route was not established in this review. Keep these in a pending profile; a draft must not create a universal production block or sales claim. Tax/compliance owns the final applicability review before build baselines and go-live.
'''
out[8]='''## 8 Core business processes

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
'''
out[11]=re.sub(r'(## 11[^\n]*\n\n).*?(\n\n\| ID)',r'\1LARA owns the customer outcome for issuance, delivery and applicable sales reporting. SyncTax is a candidate implementation behind the LARA contract, subject to qualification; customers should not need to operate a second work queue. Issuance and reporting are separate obligations and statuses. Credentials, permits, deadlines and allowed correction documents follow verified taxpayer-specific rules.\2',out[11],flags=re.S)
out[12]=out[12].replace('The BIR does not allow posted records to be edited, and a registered system must show who did what. So every AI feature in this document prepares work, and a named person reviews and posts it.','LARA enforces immutable posted records and accountable review. AI prepares drafts and explanations; deterministic services enforce posting, tax calculations, permissions and period controls. A named authorized person approves each consequential action.')
out[12]=out[12].replace('These features are expected of any modern accounting system. We need them to be credible, but they are not what sets LARA apart.','These are candidate assistive capabilities. Release priority depends on validated user benefit, evidence quality and acceptance criteria, not an assumed market standard.')
out[12]=out[12].replace('All of them follow the guardrails in 12.1.','All of them follow the guardrails in 12.1. Their differentiation and demand remain hypotheses to validate; deterministic checks continue to work with AI disabled.')
out[12]+='''\n\n### 12.4 Requirement integrity

The nine phase-only rows at the end of the original AI table contain no recoverable IDs or feature descriptions and are not valid approved requirements. Their labels mentioned elsewhere are captured below as newly specified requirements; no missing source text is claimed to have been recovered.

- AI-033 Registration drafting assistant, Phase 1 optional: assemble an evidence-linked application narrative; show every missing artifact; never attest or sign for the taxpayer/provider.
- AI-034 Evidence-backed task explanations, Phase 1: explain deterministic failures with source records and rule versions; abstain when evidence is missing.
- AI-035 Historical rule explanation, Phase 2: display which approved rule version applied at the transaction date, with links; changes cannot rewrite historical postings.
- AI-036 Cash action suggestions, Phase 2: propose collection or payment actions from reconciled data, distinguish uncleared checks from available cash and require human authorization.
- AI-037 Audit request assembly, Phase 3: prepare a scoped evidence manifest from authorized records; show gaps and require reviewer release. Reuses AI-011 and the shared evidence service.

Supplier inbox, document reminders and client agents remain FR-AP-014, FR-SH-009/010 and FR-PL-012/014, not separate products. No autonomous external messaging, bank instruction, filing, posting or approval is authorized by any AI requirement.
'''
out[16]='''## 16 Architecture and technology

Recommendation for Engineering Lead approval: begin with a modular application core and relational ledger, with separate background workers for document processing, reporting, integrations and optional AI. Preserve clear module interfaces; split services only when measured scaling, security or ownership demands it. A small shared engine set does not eliminate domain-specific accounting tests.

DCP's TypeScript/PostgreSQL option is the provisional default if team experience is confirmed. A named Python framework remains an alternative only after its actual license, support, extension boundaries and operational fit are reviewed. No framework is selected by this BRD. Use an architecture decision record and a vertical-slice prototype to prove posting integrity, tenant isolation, report performance and recovery.

The accounting core uses fixed-precision amounts, explicit rounding and currency policies, database transactions and controlled number allocation. Commit a durable outbound event with posting, then deliver asynchronously with idempotency and reconciliation of unknown acknowledgements. Do not claim exactly-once network delivery; demonstrate no duplicate financial effect under retries.

Version schemas, tax rules, document templates, source mappings and integration contracts. Metadata controls supported variation but cannot safely replace all code changes. Exports and regulatory packs must be reproducible from a defined data cut-off and rule version.

AI accesses allowlisted tools through the same tenant, record and field permissions as the user. A semantic reporting layer supplies approved measures and read-only queries. AI receives no unrestricted SQL or production credentials. Documents and retrieved text are untrusted input; their instructions cannot grant authority.

SyncTax, JANUS, GAIA and Daedalus are reuse candidates reported in the source BRD, not independently inspected assets. Qualify each for API contract, license, tenant isolation, deployment, data residency, failure behavior, performance, support ownership and cost. Record adopt/adapt/build decisions and a fallback before making the pilot dependent on them.

AI coding tools are optional development aids. Named engineers own design and review; accounting specialists own golden transaction cases. Dependencies still carry license obligations. Maintain dependency inventory, security scanning and release evidence. Faster code generation is not an estimate of implementation or assurance effort.
'''
out[15]='''## 15 Migration and go live

Agree a cutover and authority profile with the client controller and tax advisor. Before moving data, define which system is authoritative for each book, transaction, document series, tax calculation and source schedule. Only in-scope records move; retained core-banking, asset, inventory, payroll or trust data require signed interfaces and reconciliation boundaries.

Migrate approved masters, opening trial balance and open items, plus detailed supporting schedules where LARA assumes ownership. Record file checksums, counts, totals, mapping versions and approvals. AR/AP detail must exactly tie to controls; unresolved differences have owners and cannot silently become opening equity or suspense. Replaying an import cannot duplicate balances.

Retire only the series and books whose ownership transfers, recording their final numbers and dates. Prevent overlapping live issuance or duplicated postings between systems. Retained series continue only in their approved scope. Agree which historical records are fully migrated, summarized or retained with accessible evidence.

Complete a representative parallel-close rehearsal covering the scoped journeys, tax outputs, source interfaces and corrections before production activation. Reconcile opening and closing balances, certify required external credentials and complete role-based practice tasks. A waiver of a material control or missing accounting capability is not a completed gate.

Before issuance, test rollback of configuration/imports. After official issuance, continuity requires preservation and reconciliation of issued documents, controlled corrections and an approved downtime procedure, not a destructive restore that loses new obligations. Assign a DCP support owner, customer incident owner and first-close support plan. Export/exit must preserve usable masters, transactions, attachments, audit history and report versions.
'''
out[19]='''## 19 Risks and responses

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
'''
out[17]='''## 17 Simplification and seamless experience

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
'''
out[18]='''## 18 Assumptions and constraints

The bank-first direction is retained as a commercial hypothesis. Institution type, design partner, processing volume, authoritative books and tax responsibilities require named-owner decisions. No bank-wide replacement, universal industry coverage or regulatory approval is implied.

Each taxpayer supplies accurate registration data, required credentials and a qualified advisor. Product and compliance maintain evidence-backed rule profiles. Regulatory changes may require configuration, code, testing and renewed authority assessment.

One managed cloud deployment is the proposed initial support model. Other hosting models require qualification and cost approval. Reuse assets, commercial pricing and third-party contracts have not been verified in this document review. Existing payroll, core banking and other excluded systems remain responsible for their documented boundary outputs.
'''
out[20]='''## 20 Decisions required before pilot commitment

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
'''
out[22]='''## 22 Sources and sign off

Primary references checked for targeted corrections on September 18, 2026:

- [BIR RR 26-2025 official digest](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2026-2025%20Digest.pdf) — issuance transition and separate sales-reporting trigger.
- [BIR RR 7-2024 full text](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%207-%202024.pdf) — Section 4 preservation of books and records; confirm taxpayer-specific extensions and other obligations.
- [BIR RR 11-2025 full text](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2011-2025.pdf) — e-invoicing framework, read with amendments and applicable later issuances.

Other references named in section 7 remain in the verification register. This targeted review is not a complete legal certification. Technical primary references and role-specific reasoning are recorded in the companion roundtable review.

Approval remains pending. DCP Product Sponsor accepts cohort and commercial scope; Product Manager owns requirement/release traceability; Controller accepts accounting journeys; Tax Advisor accepts legal applicability and templates; Engineering Lead accepts architecture and test evidence; Security/Privacy and Operations accept deployment and recovery; pilot customer owner accepts migration and operating responsibilities. Record name, decision, exceptions, date and version for each sign-off.
'''

# Remove superseded assertions from retained narrative and table notes.
for n in out:
    out[n]=out[n].replace('Roles are configurable. The system warns when one person is given roles that break segregation of duties (for example, creating and approving the same bill).','Roles are configurable, but required segregation of duties is enforced at the action and transaction-version level. Setup identifies unsupported single-user arrangements and requires an authorized second reviewer; AI is not that reviewer.')
    out[n]=out[n].replace('BIR (RDO or LT Office): issues the Acknowledgement Certificate and the Permit to Issue; may post-evaluate.','BIR and applicable offices: issue applicable acknowledgements/authorizations and may post-evaluate; exact permit profile requires verified authority.')
    out[n]=out[n].replace('The modules that follow are built from a small number of shared engines. Anything that looks like a new register, calendar, queue, or import is configuration of one of these, not a new piece of software. This keeps the product small enough to test, and it is why a new industry pack is settings rather than a build.','Shared engines reduce duplicate implementation. Use supported configuration where appropriate and reviewed reusable code or adapters where new domain behavior is required. Each industry pack retains its own accounting and acceptance tests.')
    out[n]=out[n].replace('LARA uses AI to keep the client ready for the BIR every day, and to fit the way Philippine businesses actually handle cash, checks, and paperwork.','LARA helps Philippine finance teams complete daily work and explain their books through connected evidence, clear exceptions and optional AI assistance.')
    out[n]=out[n].replace('**Always ready for the BIR**','**Readiness and tax evidence**')
    out[n]=out[n].replace('**Permits, e-invoicing, and agentic work**','')
    out[n]=out[n].replace('Reads lease and service contracts (with JANUS)','Reads lease and service contracts through a qualified document adapter')
    out[n]=out[n].replace('* Must-have if the client sells goods. Move to Phase 1 if so.','Inventory-dependent customers are excluded until the complete applicable inventory journey is released and validated; a Phase 1 commitment requires explicitly pulling those dependencies forward.')
    out[n]=out[n].replace('From the draft circular. Confirm the exact content when it is final.','Pending final primary authority; see section 7.')
    out[n]=out[n].replace('For VAT invoices, required for sales above ₱1,000.','Threshold and exceptions require current primary-source verification.')
    out[n]=out[n].replace('treat any change as configuration rather than code.','assess configuration, code, certification and registration impact before release.')
    out[n]=out[n].replace('PTI: Permit to Issue, the BIR permit a taxpayer needs before issuing electronic invoices, separate from the Acknowledgement Certificate.','PTI: Permit to Issue described in the source draft circular; applicable final authority and taxpayer scope must be verified before enforcement.')

header='''# LARA Business Requirements Document

Version 1.1 | September 18, 2026 | DCP Product Office | Revised draft for owner review

This revision replaces the v1.0 requirements baseline for review, preserves valid requirement identifiers and makes the launch scope, control boundaries and user journeys more explicit. The original Word document is retained unchanged. Proposed release decisions are not stakeholder approvals, and pilot targets are not measured results. The companion roundtable report records AI-simulated perspectives, disagreements and the change rationale.

Sections 1 to 22 retain the original subject structure. Section 23 adds testable acceptance requirements and pilot gates. Removed FR-PL-011 remains a tombstone; nine incomplete AI table rows are quarantined in section 12.4 and newly authored requirements are clearly identified.

'''
content=header+'\n\n'.join(out[n] for n in range(1,23))+'\n'
content=re.sub(r'\n{3,}','\n\n',content)
(root/'docs/DCP_BRD_LARA_v1_1.md').write_text(content,encoding='utf-8')
(root/'.review/changes.json').write_text(json.dumps({'edited_ids':list(edits),'phase_updates':phases},indent=2),encoding='utf-8')
print(f'Wrote full revised baseline; {len(edits)} requirement descriptions edited, {len(phases)} phase entries aligned.')

