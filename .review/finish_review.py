from pathlib import Path
import re,json,hashlib
r=Path('D:/DCP/LARA'); doc=r/'docs/DCP_BRD_LARA_v1_1.md'
body=doc.read_text(encoding='utf-8')
original=(r/'.review/brd_original.txt').read_text(encoding='utf-8')
pattern=r'\b(?:FR-[A-Z]+-\d{3}|COMP-[A-Z]+-\d{3}|INT-EIS-\d{3}|AI-GR-\d{3}|AI-\d{3}|NFR-[A-Z]+-\d{3}|RPT-\d{3}|OBJ-\d+)\b'
old=set(re.findall(pattern,original)); new=set(re.findall(pattern,body))
missing=sorted(old-new)
changes=json.loads((r/'.review/changes.json').read_text())
report='''# LARA BRD roundtable review and decisions

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

'''
report+=f'The revision edits {len(changes["edited_ids"])} requirement descriptions, aligns {len(changes["phase_updates"])} release entries, rewrites conflicting strategy/process/governance sections, and adds 16 acceptance requirements (REV 001–016), five explicitly new AI behaviors and two user-outcome objectives.\n\n'
report+='**Edited source IDs:** '+', '.join(changes['edited_ids'])+'.\n\n'
report+='**Release updates:** '+ '; '.join(f'{k}: {v}' for k,v in changes['phase_updates'].items())+'.\n\n'
report+='## Remaining owner decisions\n\nSelect the actual pilot institution, required books/currencies/taxes and source boundaries; establish workload and support expectations; verify final legal profiles; qualify DCP components and choose the stack; approve a costed commercial model and hosting arrangement. These require actual business evidence and accountable decisions, not further simulated voting.\n\n'
for name in ['business_users','accounting_process','technology_ai']:
    text=(r/f'.review/{name}.md').read_text(encoding='utf-8')
    text=re.sub(r'(?m)^(#{1,4}) ',r'##\1 ',text)
    report+=text+'\n\n'
(r/'docs/LARA_BRD_Roundtable_Review_2026-09-18.md').write_text(report,encoding='utf-8')
checks={'source_ids':len(old),'revised_ids':len(new),'missing_original_ids':missing,'new_ids':sorted(new-old),'revision_section_count':len(re.findall(r'^## \d+',body,re.M)),'original_docx_sha256':hashlib.sha256((r/'docs/DCP_BRD_LARA_v1_0.docx').read_bytes()).hexdigest()}
(r/'.review/verification.json').write_text(json.dumps(checks,indent=2),encoding='utf-8')
print(json.dumps(checks,indent=2))
assert not missing,missing
assert checks['revision_section_count']==23
