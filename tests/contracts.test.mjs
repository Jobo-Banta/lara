import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operations,operationsForPhase,findOperation,schemaFor,validate,validateInput,validateResponse,permissions,assertTransition,errorStatus,openapi} from '../packages/contracts/src/index.mjs';

test('every operation names a published permission and a compilable input/response schema', () => {
  const codes=new Set(permissions);
  for(const op of Object.values(operations)){
    assert.ok(codes.has(op.permission),op.operationId+' uses unpublished permission '+op.permission);
    if(op.input)schemaFor(op.input);
    if(op.response)schemaFor(op.response);
    assert.ok(op.successStatus,op.operationId+' has no success response');
  }
  assert.equal(Object.keys(operations).length,Object.values(openapi.paths).reduce((n,item)=>n+Object.keys(item).filter(m=>['get','post','put','patch','delete'].includes(m)).length,0));
});

test('P02 operations follow the mutation header conventions', () => {
  const p02=operationsForPhase('P02');
  assert.equal(p02.length,52);
  for(const op of p02){
    if(op.method==='POST')assert.ok(op.requiresIdempotencyKey,op.operationId+' must require Idempotency-Key');
    if(op.method==='PATCH')assert.ok(op.requiresIfMatch,op.operationId+' must require If-Match');
    if(op.method==='POST'&&/\/\{id\}\//.test(op.path))assert.ok(!op.requiresIfMatch||op.requiresIfMatch,op.operationId);
    if(op.scope==='entity')assert.ok(op.requiresEntity,op.operationId+' entity scope needs X-Entity-Id');
    if(op.method==='GET'&&op.isList)assert.deepEqual(op.queryParams.filter(q=>['cursor','limit'].includes(q)).sort(),['cursor','limit'],op.operationId+' list paging');
  }
  assert.equal(operations.get_me.scope,'tenant');
  assert.equal(operations.post_entities.scope,'tenant');
});

test('route matching resolves path parameters and rejects unknown routes', () => {
  const hit=findOperation('PATCH','/parties/8f1c2b8e-1111-4c2b-9c1e-000000000001');
  assert.equal(hit.operation.operationId,'patch_parties_id');
  assert.deepEqual(hit.params,{id:'8f1c2b8e-1111-4c2b-9c1e-000000000001'});
  assert.equal(findOperation('GET','/parties/x/y'),null);
  assert.equal(findOperation('DELETE','/parties'),null);
});

test('input validation enforces the reviewed schemas with typed field errors', () => {
  assert.deepEqual(validateInput('post_entities',{legalName:'LARA Demo Finance',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}),{ok:true,fieldErrors:[]});
  const bad=validateInput('post_entities',{legalName:'',baseCurrency:'php',timezone:'Asia/Manila',fiscalYearStartMonth:13,extra:true});
  assert.equal(bad.ok,false);
  assert.deepEqual(bad.fieldErrors.map(e=>e.path).sort(),['baseCurrency','extra','fiscalYearStartMonth','legalName']);
  assert.equal(validateInput('post_parties',{legalName:'Northwind',roles:['customer'],identityStatus:'known',address:'Cebu'}).ok,true);
  assert.equal(validateInput('post_parties',{legalName:'Northwind',roles:[],identityStatus:'known',address:'Cebu'}).ok,false);
  assert.equal(validateInput('post_evidence_uploads',{filename:'a.pdf',mime:'application/x-msdownload',byteCount:10,sha256:'a'.repeat(64),classification:'internal'}).ok,false);
  assert.equal(validateInput('post_evidence_uploads',{filename:'a.pdf',mime:'application/pdf',byteCount:20971521,sha256:'a'.repeat(64),classification:'internal'}).ok,false);
  assert.equal(validateInput('post_approval_policies',{documentKind:'journal',effectiveFrom:'2026-01-01',steps:[{roleId:'8f1c2b8e-1111-4c2b-9c1e-000000000001',minimumAmount:'0',maximumAmount:'100000.00',distinctActorRequired:false}],sourceEvidenceIds:['8f1c2b8e-1111-4c2b-9c1e-000000000002']}).ok,false,'distinctActorRequired must be true');
  assert.equal(validateInput('get_entities',undefined).ok,true);
  assert.equal(validateInput('get_entities',{cursor:'x'}).ok,false);
});

test('request examples validate and responses require the shared resource envelope', () => {
  const examples=JSON.parse(readFileSync(new URL('../docs/development/contracts/request-examples.json',import.meta.url),'utf8')).examples;
  for(const example of examples){const r=validate(example.schema,example.value);assert.equal(r.ok,true,example.name+' '+JSON.stringify(r.fieldErrors));}
  const resource={id:'8f1c2b8e-1111-4c2b-9c1e-000000000001',version:1,contentVersion:1,state:'draft',createdAt:'2026-09-19T00:00:00Z',updatedAt:'2026-09-19T00:00:00Z',simulation:false,legalName:'X',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1};
  assert.equal(validateResponse('post_entities',resource).ok,true);
  assert.equal(validateResponse('post_entities',{...resource,version:0}).ok,false);
  assert.equal(validateResponse('get_entities',{items:[resource],nextCursor:null}).ok,true);
  assert.equal(validateResponse('get_entities',{items:[resource]}).ok,false);
  assert.equal(validate('Error',{code:'VALIDATION_FAILED',message:'x',traceId:'t',fieldErrors:[],retryable:false}).ok,true);
});

test('state machine helper follows the published transitions and error codes map to HTTP statuses', () => {
  assert.equal(assertTransition('evidence','quarantined','scanning'),true);
  assert.equal(assertTransition('evidence','quarantined','available'),false);
  assert.equal(assertTransition('job','queued','succeeded'),false);
  assert.throws(()=>assertTransition('evidence','lost','available'),/Unknown state/);
  assert.equal(errorStatus.VERSION_CONFLICT,412);
  assert.equal(errorStatus.SELF_APPROVAL,403);
});
