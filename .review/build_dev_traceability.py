from pathlib import Path
import re,json
R=Path('D:/DCP/LARA');D=R/'docs/development';C=D/'contracts';s=(R/'docs/DCP_BRD_LARA_v1_1.md').read_text(encoding='utf-8')
catalog=json.loads((C/'phase-catalog.json').read_text())
def file(p):
 if p=='P00':return '03-phase-00-setup.md'
 if p=='P01':return '04-phase-01-prototype.md'
 return catalog[p[:3]]['spec']
def phase_for(id):
 n=int(id.split('-')[-1]) if not id.startswith('REV') else int(id[-3:])
 if id.startswith('OBJ-'):return {1:'P07',2:'P07',3:'P07',4:'P03',5:'P12',6:'P08',7:'P18D',8:'P01',9:'P05'}[n]
 if id.startswith('REV'):return {1:'P08',2:'P07',3:'P05',4:'P02',5:'P04',6:'P06',7:'P07',8:'P07',9:'P08',10:'P02',11:'P12',12:'P12',13:'P01',14:'P00',15:'P08',16:'P02'}[n]
 if id.startswith('FR-SH'):return {1:'P03',2:'P04',3:'P02',4:'P04',5:'P02',6:'P03',7:'P06',8:'P11',9:'P02',10:'P02',11:'P03'}[n]
 if id.startswith('FR-CO'):return {1:'P02',2:'P02',3:'P04',4:'P02',5:'P04',6:'P17C',7:'P07',8:'P07'}[n]
 if id.startswith('FR-GL'):return {4:'P11',8:'P09',9:'P15',13:'P11',14:'P16',15:'P16',16:'P15',19:'P11',20:'P07'}.get(n,'P03')
 if id.startswith('FR-AR'):return {5:'P17B',8:'P17C',9:'P13',10:'P13',15:'P11',16:'P13',19:'DEFERRED',20:'P06',21:'P07',23:'P13'}.get(n,'P04')
 if id.startswith('FR-AP'):return {3:'P07',4:'P10',7:'P13',10:'P06',11:'P06',13:'P10',14:'P13'}.get(n,'P05')
 if id.startswith('FR-CB'):return 'P02' if n==6 else 'P06'
 if id.startswith('FR-IN'):return 'P10'
 if id.startswith('FR-FA'):return 'P11'
 if id.startswith('FR-TX'):return 'P04' if n in [1,2,6] else 'P07'
 if id.startswith('FR-PL'):return {1:'P02',2:'P02',3:'P03',4:'P02',5:'P13',6:'P17D',7:'P03',8:'P07',9:'P18A',10:'P17C',11:'REMOVED',12:'P18C',13:'P13',14:'P18C',15:'P02',16:'P14'}[n]
 if id.startswith('FR-PH'):return {1:'P05',2:'P06',3:'P05',4:'P04',5:'P04',6:'P06',7:'P06',8:'P06',9:'P11',10:'P05',11:'P04',12:'P07',13:'P05',14:'P07',15:'P07',16:'P07',17:'P07',18:'P08',19:'P08',20:'P17E',21:'P17D',22:'P07',23:'P06',24:'P17C',25:'P09',26:'P16',27:'P17A',28:'P17B',29:'P12',30:'P13',31:'P06'}[n]
 if id.startswith('FR-FI'):return 'P09' if n in [5,11] else 'P08'
 if id.startswith('FR-AU'):return {1:'P03',2:'P03',3:'P02',4:'P02',5:'P07',6:'P13'}[n]
 if id.startswith('COMP-INV'):return 'P07' if n in [13,14,15,16] else 'P04'
 if id.startswith('COMP-BOA'):return 'P10' if n==5 else 'P07'
 if id.startswith('COMP-AUD'):return 'P02' if n in [1,4,6,7,8] else 'P03'
 if id.startswith('COMP-REG') or id.startswith('INT-EIS'):return 'P07'
 if id.startswith('AI-GR'):return 'P12'
 if id.startswith('AI-'):return {3:'P07',4:'P12',12:'P18B',13:'P07',15:'P07',16:'P07',26:'P18B',28:'P18A',29:'P02',30:'P14',31:'P18B',32:'DEFERRED',35:'P18B'}.get(n,'P12')
 if id.startswith('RPT-'):return {1:'P07',2:'P07',3:'P07',4:'P07',5:'P07',6:'P17D',7:'P07',8:'P05',9:'P16',10:'P15',11:'P06',12:'P16',13:'P07',14:'P03',15:'P04'}[n]
 if id.startswith('NFR-'):return 'P01' if id.startswith('NFR-USE') else 'P04' if id=='NFR-PER-003' else 'P02' if id.startswith('NFR-DAT') or id in ['NFR-SEC-001','NFR-SEC-005','NFR-SEC-009','NFR-SEC-010','NFR-SEC-014'] else 'P00'
 raise ValueError(id)

rows={}
for line in s.splitlines():
 m=re.match(r'^\| ((?:FR|COMP|INT|AI|NFR|RPT|OBJ)-[A-Z0-9-]+) \|',line)
 if m:
  id=m[1]; cols=[v.strip() for v in line.strip('|').split('|')];rows[id]={'source_text':' | '.join(cols[1:]),'source_release_label':cols[-1] if not id.startswith(('COMP-','NFR-','OBJ-','AI-GR-','INT-')) else 'See source BRD'}
for n in range(33,38):
 id=f'AI-{n:03}'; line=next(x for x in s.splitlines() if x.startswith('- '+id+' '));rows[id]={'source_text':line[2:],'source_release_label':'New BRD v1.1 behavior'}
for n in range(1,17):
 title=re.search(rf'### REV {n:03} ([^\n]+)',s).group(1);rows[f'REV-{n:03}']={'source_text':title,'source_release_label':'BRD acceptance overlay'}
notes={
'FR-GL-004':'P03 basic manual templates; P11 completes recurring/scheduled execution.',
'FR-GL-009':'P02 separates legal entities; P15 completes intercompany/consolidation.',
'FR-SH-011':'P03 approved reports; P07 statutory outputs; P18A designer.',
'FR-AP-003':'P05 tax recognition; P07 completes all enabled certificate outputs.',
'FR-PL-002':'P02 establishes secured API; each module extends it in its own release.',
'FR-PL-006':'P07 supports minimum validated payroll-tax input for enabled 2316; P17D completes dedicated payroll integration/remittances.',
'FR-PH-029':'P03 reviewed spreadsheet migration; P12 completes manual-book OCR assistance.',
'FR-PH-030':'P13 optional eTSP hand-off; cannot activate without accredited partner contract and reconciliation.',
'RPT-006':'P07 delivers applicable 2306/2316 from validated external data; P17D completes payroll source integration.',
'RPT-007':'P03 management TB/BS/IS; P07 completes approved statement pack/disclosures for selected profile.',
'RPT-009':'P01 synthetic overview; P04/P06 live cash/sales; P16 complete margin/project/budget views.',
'RPT-012':'Party detail P05, schedule P11, budget P16; whole combined requirement complete at P16.',
'AI-013':'Deterministic readiness P07; optional AI explanation P12.',
'AI-015':'Deterministic withholding screening P07; optional AI explanation P12.',
'AI-016':'Deterministic input-tax rules P07; document OCR assistance P12.',
'AI-029':'P02 human task service; P12 adds AI producers, not a new inbox.',
'AI-030':'P14 deterministic multi-client prioritization; uses already released P12 AI when enabled.',
'REV-012':'P04/P06 live overview; P12 natural-language answers; prototype only in P01.',
'REV-013':'P01 initial user tests; repeat for every production module/cohort.',
'FR-AR-019':'Deferred in original BRD; no government-withholding implementation or activation promised.',
'FR-PL-011':'Removed corporate-secretarial work; keep tombstone, do not build.',
'AI-032':'Explicit scope decision: peer benchmarks deferred beyond this implementation baseline pending privacy/cohort design.',
}
result=[]
for id,v in sorted(rows.items()):
 p=phase_for(id);active=p not in ['DEFERRED','REMOVED']
 spec=file(p) if active else '01-delivery-plan.md'
 result.append({'id':id,**v,'production_completion_phase':p,'specification':spec,'prototype':'simulated selective journey only; not production fulfillment' if p not in ['P00','REMOVED','DEFERRED'] else 'not applicable','status':'specified_not_implemented' if active else p.lower(),'acceptance_evidence':([f'{p[:3]}-T01..T05','applicable CORE-01..18','RG-01..08','requirement-specific test proving every clause of source_text'] if int(p[1:3])>=2 else [p+' acceptance cases','RG gates appropriate to release purpose']) if active else ['feature absent and server activation denied'],'scope_note':notes.get(id,'All source clauses apply within supported profile; production phase labels supersede original BRD release numbers. Cross-cutting controls recur in later releases.')})
save=lambda n,o:(C/n).write_text(json.dumps(o,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
save('requirements.json',{'version':1,'basis':'BRD v1.1 plus 16 acceptance requirements; user-requested new release sequence','requirements':result})

backlog=[]
p0=[('Repository and toolchain','Create workspace layout, exact lockfile, runtime/image version manifest and cross-platform scripts.','P00-T01'),('Configuration and secrets','Typed environment schema, secret references and invalid-config startup failure.','P00-T02'),('Database and migrations','Roles, migration runner/checksum/lock and clean/upgrade verification.','P00-T03/P00-T05'),('Identity integration','OIDC BFF session and scoped API identity with no browser token persistence.','P00-T04'),('CI quality gates','Required builds/tests/scans and generated-contract drift check.','P00-T07'),('Demo deployment isolation','Separate demo DB/storage/mail adapters and prohibited production fixture registration.','P00-T06'),('Observability and readiness','Health/version endpoints, safe logs/traces and alert routing.','P00-T01'),('Backup and engineering release','Restore rehearsal, reproducible setup guide, release manifest/tag.','P00-T08')]
p1=[('Shell and accessibility','Implement navigation/context, reusable forms/lists/statuses and responsive layouts.','P01-T05'),('Persistent demo backend','Demo DB state, commands, versions, scoped runs and coherent synthetic totals.','P01-T01'),('Invoice journey','DEMO-01 and DEMO-03 create/review/simulate/collect with retry proof.','P01-T02'),('Bill and payment journey','DEMO-02 evidence split review and separate payment states.','P01-T02'),('Bank reconciliation journey','DEMO-05 partial/grouped match and explicit adjustment.','P01-T02'),('Compliance and close journey','DEMO-04/06 rejection/correction/period blockers.','P01-T02'),('Audit and recovery journey','DEMO-07/08 source drill-through, scoped exports and edit conflicts.','P01-T04'),('Demo host controls','Per-run reset, labels, fixture egress block and identity-switch isolation.','P01-T03/P01-T06/P01-T07'),('Feedback and task research','Task cards, feedback capture and eight-user protocol.','P01-T08'),('Prototype release','Hosted working build, facilitator script and recorded gate evidence.','P01-T01..08')]
for p,tasks in [('P00',p0),('P01',p1)]:
 for i,(title,desc,test) in enumerate(tasks,1):backlog.append({'id':f'{p}-{i:02}','phase':p,'title':title,'implementation':desc,'depends_on':[] if i==1 else [f'{p}-{i-1:02}'],'spec':file(p),'acceptance':test,'status':'ready_for_implementation'})
for p,meta in catalog.items():
 reqs=[x['id'] for x in result if x['production_completion_phase'].startswith(p)]
 tasks=[('Contracts and migrations','Implement typed models, scoped FKs, constraints, indexes, permissions and additive migrations.'),('Domain and accounting','Implement the exact phase state/calculation rules and real database transaction tests.'),('API jobs and adapters','Implement reviewed operations, idempotency, outbox, authorization and integration failures.'),('User journeys and outputs','Complete all specified screens, error/recovery states, reports and evidence export.'),('Acceptance and operations','Run phase/shared/regression/security/migration/recovery/load scenarios and finalize runbooks.'),('Shippable release','Record RG-01–08 and per-profile activation; tag and deploy complete supported module.')]
 for i,(title,desc) in enumerate(tasks,1):backlog.append({'id':f'{p}-{i:02}','phase':p,'title':title,'implementation':desc,'depends_on': [f'{p}-{i-1:02}'] if i>1 else [meta['dependencies']],'spec':meta['spec'],'requirements':reqs,'acceptance':f'{p}-T01..T05 and RG-01..08','status':'specified_external_activation_gates_apply'})
save('backlog.json',{'version':1,'notes':'Tickets are implementation work, not completed changes. Phase dependencies refer to the delivery graph. P17/P18 feature increments must receive separate tagged releases and their own evidence.','tickets':backlog})

summary='# Requirement coverage and release mapping\n\nThe [JSON register](contracts/requirements.json) contains every BRD requirement and acceptance-overlay ID, exact source text, production completion phase, owning specification and evidence requirement. Prototype demonstrations do not satisfy production requirements.\n\n| Phase | Requirements completed in this phase | Specification |\n| --- | --- | --- |\n'
for p in ['P00','P01']+list(catalog)+['DEFERRED','REMOVED']:
 ids=[x['id'] for x in result if x['production_completion_phase']==p or (p in catalog and x['production_completion_phase'].startswith(p))]
 if ids:summary+=f'| {p} | {len(ids)} | '+(f'[{p}]({file(p)})' if p not in ['DEFERRED','REMOVED'] else 'Explicit non-enabled scope')+' |\n'
summary+='\n## Scope decisions\n\nFR-PL-011 remains removed. FR-AR-019 remains deferred. AI-032 peer benchmarking is intentionally deferred beyond the build baseline because no privacy-preserving cohort design or consented dataset exists. This is a documented change from the optional future BRD item, not a silently omitted requirement. No other source ID is dropped.\n\n## Composite requirements\n\n'
for id,n in notes.items():summary+=f'- **{id}:** {n}\n'
(D/'09-requirement-coverage.md').write_text(summary,encoding='utf-8')
print('Mapped',len(result),'requirements;',len(backlog),'implementation tickets')
