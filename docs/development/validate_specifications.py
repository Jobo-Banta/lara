"""Dependency-free checks for this specification package, not application tests."""
from pathlib import Path
from decimal import Decimal
from datetime import date, datetime
import json, re, uuid

ROOT=Path(__file__).resolve().parent
def read(name):return json.loads((ROOT/'contracts'/name).read_text(encoding='utf-8'))
failures=[]
def check(ok,msg):
    if not ok:failures.append(msg)

api=read('openapi.json');schemas=api['components']['schemas'];ops=[]
def walk(value):
    if isinstance(value,dict):
        if '$ref' in value:
            r=value['$ref'];check(r.startswith('#/components/schemas/') and r.split('/')[-1] in schemas,'Unresolved schema '+r)
        if value.get('type')=='object':
            check(len(value.get('required',[]))==len(set(value.get('required',[]))),'Repeated required field')
            for key in value.get('required',[]):check(key in value.get('properties',{}),'Required field undefined '+key)
        for v in value.values():walk(v)
    elif isinstance(value,list):
        for v in value:walk(v)
walk(api)
for path,methods in api['paths'].items():
    for method,op in methods.items():
        ops.append(op['operationId'])
        declared={p['name'] for p in op.get('parameters',[]) if p['in']=='path'}
        check(declared==set(re.findall(r'{(\w+)}',path)),'Path parameters '+path)
        check(any(code.startswith('2') for code in op['responses']),'No success response '+path)
        if method=='post':check(any(p['name']=='Idempotency-Key' and p['required'] for p in op['parameters']),'Missing idempotency '+path)
        if method=='patch':check(any(p['name']=='If-Match' and p['required'] for p in op['parameters']),'Missing version guard '+path)
        if path.startswith('/demo/'):check(op.get('x-demo-only') is True,'Demo registration flag '+path)
check(len(ops)==len(set(ops)),'Duplicate operation ID')

def validate(value,schema,path='value'):
    if '$ref' in schema:return validate(value,schemas[schema['$ref'].split('/')[-1]],path)
    types=schema.get('type',[]);types=[types] if isinstance(types,str) else types
    matches={'object':isinstance(value,dict),'array':isinstance(value,list),'string':isinstance(value,str),'integer':isinstance(value,int) and not isinstance(value,bool),'number':isinstance(value,(int,float)) and not isinstance(value,bool),'boolean':isinstance(value,bool),'null':value is None}
    if types and not any(matches.get(t,False) for t in types):failures.append(path+' wrong type');return
    if 'enum' in schema:check(value in schema['enum'],path+' invalid enum')
    if 'const' in schema:check(value==schema['const'],path+' invalid const')
    if isinstance(value,dict):
        for k in schema.get('required',[]):check(k in value,path+' missing '+k)
        for k,v in value.items():
            if k in schema.get('properties',{}):validate(v,schema['properties'][k],path+'.'+k)
            elif schema.get('additionalProperties') is False:failures.append(path+' unknown '+k)
            elif isinstance(schema.get('additionalProperties'),dict):validate(v,schema['additionalProperties'],path+'.'+k)
    if isinstance(value,list):
        check(len(value)>=schema.get('minItems',0),path+' too few items')
        for i,v in enumerate(value):validate(v,schema.get('items',{}),path+f'[{i}]')
    if isinstance(value,str):
        check(len(value)>=schema.get('minLength',0) and len(value)<=schema.get('maxLength',10**9),path+' text length')
        if 'pattern' in schema:check(re.fullmatch(schema['pattern'],value) is not None,path+' pattern')
        try:
            if schema.get('format')=='uuid':uuid.UUID(value)
            if schema.get('format')=='date':date.fromisoformat(value)
            if schema.get('format')=='date-time':datetime.fromisoformat(value.replace('Z','+00:00'))
        except ValueError:failures.append(path+' invalid format')
    if isinstance(value,(int,float)) and not isinstance(value,bool):check(schema.get('minimum',float('-inf'))<=value<=schema.get('maximum',float('inf')),path+' out of range')

examples=read('request-examples.json')['examples']
for x in examples:validate(x['value'],schemas[x['schema']],x['name'])

brd=(ROOT.parent/'DCP_BRD_LARA_v1_1.md').read_text(encoding='utf-8')
pattern=r'\b(?:FR-[A-Z]+-\d{3}|COMP-[A-Z]+-\d{3}|INT-EIS-\d{3}|AI-GR-\d{3}|AI-\d{3}|NFR-[A-Z]+-\d{3}|RPT-\d{3}|OBJ-\d+)\b'
source_ids=set(re.findall(pattern,brd))|{f'REV-{n:03}' for n in range(1,17)}
requirements=read('requirements.json')['requirements'];mapped=[x['id'] for x in requirements]
check(set(mapped)==source_ids,'BRD coverage differs: '+str(source_ids^set(mapped)))
check(len(mapped)==len(set(mapped)),'Duplicate requirement ID')
releases=read('release-plan.json')['releases'];release_ids={r['id'] for r in releases}
for r in releases:
    check((ROOT/Path(r['spec'].replace(chr(92),'/'))).exists(),'Missing release spec '+r['id'])
    check(all(d in release_ids for d in r['depends_on']),'Unknown dependency '+r['id'])
graph={r['id']:r['depends_on'] for r in releases};visiting=set();done=set()
def visit(k):
    if k in visiting:failures.append('Cyclic release dependency '+k);return
    if k in done:return
    visiting.add(k)
    for d in graph.get(k,[]):visit(d)
    visiting.remove(k);done.add(k)
for k in graph:visit(k)
for q in requirements:
    check((ROOT/Path(q['specification'].replace(chr(92),'/'))).exists(),'Missing requirement specification '+q['id'])
    check(q['production_completion_phase'] in release_ids|{'REMOVED','DEFERRED'},'Unknown requirement phase '+q['id'])
tickets=read('backlog.json')['tickets'];ticketids={t['id'] for t in tickets}
check(len(ticketids)==len(tickets),'Duplicate backlog ID')
for t in tickets:
    check(t['phase'] in release_ids,'Unknown ticket phase '+t['id'])
    check(all(d in ticketids for d in t['depends_on']),'Unknown ticket dependency '+t['id'])
    check(all(d in release_ids for d in t.get('depends_on_releases',[])),'Unknown ticket release dependency '+t['id'])

cases=read('accounting-cases.json')['cases']
for c in cases:
    debit=sum(Decimal(l['debit']) for l in c['lines']);credit=sum(Decimal(l['credit']) for l in c['lines'])
    check(debit==credit and debit>0,'Unbalanced fixture '+c['id'])
    for l in c['lines']:check((Decimal(l['debit'])>0) != (Decimal(l['credit'])>0),'Invalid line '+c['id'])
machines=read('state-machines.json')['machines']
for n,machine in machines.items():
    for state,targets in machine.items():check(all(x in machine for x in targets),'Unknown target state '+n+'.'+state)
check(machines['document']['posted']==[],'Posted document is mutable')
check('accountNumber' not in schemas['BankAccountResource']['properties'],'Unmasked account in read schema')
check('taxId' not in schemas['PartyResource']['properties'],'Unmasked tax ID in read schema')
check('contentVersion' in schemas['ApprovalDecision']['required'],'Approval content version missing')

# Generate result before checking links so the README link is resolvable.
report=ROOT/'VALIDATION.md';report.write_text('# Specification validation\n\nValidation in progress.\n',encoding='utf-8')
for md in ROOT.rglob('*.md'):
    text=md.read_text(encoding='utf-8')
    for target in re.findall(r'\]\(([^)]+)\)',text):
        if target.startswith(('https://','http://','#','mailto:')):continue
        check((md.parent/Path(target.split('#')[0].replace(chr(92),'/'))).exists(),'Broken link '+str(md.relative_to(ROOT))+' → '+target)
    if md.parent.name=='phases' and md.name!='README.md':
        for heading in ['Shipped scope','Data and migration contract','Calculation and business rules','Acceptance scenarios','Migration and recovery','Activation and release']:
            check('## '+heading in text,'Missing phase section '+md.name+' '+heading)

status='PASS' if not failures else 'FAIL'
summary=f'''# Specification validation

Status: **{status}**. Executed against the files in this package.

- {len(requirements)} BRD and acceptance requirements mapped with no duplicate IDs.
- {len(releases)} dependency-checked release increments and {len(tickets)} implementation tickets.
- {len(ops)} unique API operations and {len(schemas)} schemas checked for internal references, required fields, path parameters and command guards.
- {len(examples)} concrete request examples checked against the supported schema constraints.
- {len(cases)} accounting fixtures checked for exact decimal debit and credit balance.
- State targets, terminal posted-document state, sensitive read-model masking and approval content-version binding checked.
- Relative Markdown links and mandatory phase-specification sections checked.

This is a dependency-free structural and targeted semantic checker, not a complete OpenAPI/JSON Schema conformance validator. Run the team's official OpenAPI linter during P00. No application, PostgreSQL migration, browser, security penetration, provider certification or load test has been executed by this documentation task; those are implementation release gates.

Re-run with `python docs/development/validate_specifications.py` from the repository root. No third-party package is required.
'''
if failures:summary+='\n## Failures\n\n'+'\n'.join('- '+x for x in failures)+'\n'
report.write_text(summary,encoding='utf-8')
print(status,':',len(requirements),'requirements;',len(ops),'operations;',len(tickets),'tickets')
for failure in failures:print('ERROR:',failure)
raise SystemExit(1 if failures else 0)
