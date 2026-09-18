import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {canonical,contentHash,requestHash,DomainError,translate,pageArgs,page,expectVersion} from '../packages/domain/src/core.mjs';
import {sniffMime,sniffedMatches,FixtureScanner} from '../packages/domain/src/evidence.mjs';
import {encryptField,decryptField,maskTaxId} from '../packages/domain/src/parties.mjs';

test('canonical hashing is order independent and ignores undefined', () => {
  assert.equal(canonical({b:1,a:[{d:undefined,c:'x'}]}),'{"a":[{"c":"x"}],"b":1}');
  assert.equal(contentHash({a:1,b:2}),contentHash({b:2,a:1}));
  assert.notEqual(contentHash({a:1}),contentHash({a:'1'}));
  assert.equal(requestHash('post_parties',{x:1}),requestHash('post_parties',{x:1}));
  assert.notEqual(requestHash('post_parties',{x:1}),requestHash('patch_parties_id',{x:1}));
});

test('domain errors map to the contract statuses and database rule prefixes translate', () => {
  const e=new DomainError('VERSION_CONFLICT','stale',{resourceVersion:4});
  assert.equal(e.status,412);assert.deepEqual(e.body('t'),{code:'VERSION_CONFLICT',message:'stale',traceId:'t',fieldErrors:[],retryable:false,resourceVersion:4});
  assert.equal(new DomainError('DEPENDENCY_UNAVAILABLE','down').retryable,true);
  assert.equal(translate(Object.assign(new Error('SELF_APPROVAL: the requesting principal cannot decide'),{code:'23514'})).code,'SELF_APPROVAL');
  assert.equal(translate(Object.assign(new Error('APPEND_ONLY: audit_events rows cannot be updated'),{code:'23000'})).code,'STATE_CONFLICT');
  assert.equal(translate(Object.assign(new Error('duplicate key'),{code:'23505'})).code,'STATE_CONFLICT');
  assert.equal(translate(Object.assign(new Error('rls'),{code:'42501'})).code,'FORBIDDEN');
  assert.equal(translate(Object.assign(new Error('timeout'),{code:'57014'})).code,'DEPENDENCY_UNAVAILABLE');
  assert.throws(()=>expectVersion({version:'3'},2),/changed since/);
  assert.throws(()=>expectVersion({version:'3'},undefined),/If-Match/);
  expectVersion({version:'3'},'3');
});

test('paging validates limits and cursors and encodes a stable continuation', () => {
  assert.deepEqual(pageArgs(undefined),{limit:50,after:null});
  assert.throws(()=>pageArgs({limit:0}),/1 to 200/);
  assert.throws(()=>pageArgs({cursor:'nope'}),/Invalid cursor/);
  const rows=[{id:'8f1c2b8e-1111-4c2b-9c1e-000000000001',created_at:new Date('2026-09-19T00:00:00Z'),tenant_id:'t'},{id:'8f1c2b8e-1111-4c2b-9c1e-000000000002',created_at:new Date('2026-09-19T00:00:01Z'),tenant_id:'t'},{id:'8f1c2b8e-1111-4c2b-9c1e-000000000003',created_at:new Date('2026-09-19T00:00:02Z'),tenant_id:'t'}];
  const p=page(rows,2,r=>r.id);
  assert.deepEqual(p.items,[rows[0].id,rows[1].id]);
  assert.deepEqual(pageArgs({cursor:p.nextCursor,limit:2}).after,{createdAt:'2026-09-19T00:00:01.000Z',id:rows[1].id,scope:'t'});
  assert.equal(page(rows.slice(0,2),2,r=>r.id).nextCursor,null);
});

test('content sniffing identifies real types and rejects disguised executables', async () => {
  assert.equal(sniffMime(Buffer.from('%PDF-1.4 x')),'application/pdf');
  assert.equal(sniffMime(Buffer.from([0xff,0xd8,0xff,0xe0])),'image/jpeg');
  assert.equal(sniffMime(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1])),'image/png');
  assert.equal(sniffMime(Buffer.from([0x4d,0x5a,0x90,0x00])),'application/x-msdownload');
  assert.equal(sniffMime(Buffer.from('#!/bin/sh\n')),'text/x-script');
  assert.equal(sniffMime(Buffer.from('a,b\n1,2\n')),'text/csv');
  assert.equal(sniffedMatches('application/pdf',Buffer.from('MZ fake pdf')),false);
  assert.equal(sniffedMatches('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from(' [Content_Types].xml')])),true);
  assert.equal(sniffedMatches('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from(' nested.zip')])),false);
  const scanner=new FixtureScanner();
  assert.equal((await scanner.scan(Buffer.from('clean'))).clean,true);
  assert.equal((await scanner.scan(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'))).clean,false);
});

test('field encryption round-trips with a configured key and never leaks plaintext', () => {
  const env={FIELD_ENCRYPTION_KEY:randomBytes(32).toString('hex')};
  const stored=encryptField('123-456-789-000',env);
  assert.ok(stored.startsWith('v1.')&&!stored.includes('123-456'));
  assert.equal(decryptField(stored,env),'123-456-789-000');
  assert.notEqual(encryptField('123-456-789-000',env),stored,'fresh IV per encryption');
  assert.throws(()=>decryptField(stored,{FIELD_ENCRYPTION_KEY:randomBytes(32).toString('hex')}));
  assert.throws(()=>encryptField('x',{}),/not configured/);
  assert.equal(maskTaxId('123-456-789-000'),'•••••••••000');
});

test('rate limiter refills per minute and denies the burst above the limit', async () => {
  process.env.RATE_LIMIT_WRITES_PER_MINUTE='4';
  const {rateLimit}=await import('../apps/api/src/workspace-api.mjs');
  let now=1_000_000;
  for(let i=0;i<4;i++)rateLimit('p1',true,now);
  assert.throws(()=>rateLimit('p1',true,now),/Too many requests/);
  rateLimit('p2',true,now);
  now+=15_000;rateLimit('p1',true,now);
  assert.throws(()=>rateLimit('p1',true,now),/Too many requests/);
  now+=60_000;for(let i=0;i<4;i++)rateLimit('p1',true,now);
  assert.throws(()=>rateLimit('p1',true,now),/Too many requests/);
});

test('tax kernel rounds half up once per line or per document and allocates the residual cent deterministically', async () => {
  const {computeLines,totals,rateScaled}=await import('../packages/domain/src/sales.mjs');
  const {decimal}=await import('../packages/domain/src/ledger.mjs');
  const rules=new Map([['L',{id:'L',rate:'0.12',rounding:'line_half_up'}],['D',{id:'D',rate:'0.12',rounding:'document_half_up'}]]);
  const money=c=>c.map(x=>[decimal(x.net),decimal(x.tax),decimal(x.gross)]);
  assert.equal(rateScaled('0.12'),120000000000n);
  assert.deepEqual(money(computeLines([{quantity:'1',unitPrice:'10000',discount:'0',priceBasis:'exclusive',taxCodeId:'L'}],rules)),[['10000.00','1200.00','11200.00']]);
  assert.deepEqual(money(computeLines([{quantity:'1',unitPrice:'11200',discount:'0',priceBasis:'inclusive',taxCodeId:'L'}],rules)),[['10000.00','1200.00','11200.00']]);
  assert.deepEqual(money(computeLines([{quantity:'3',unitPrice:'33.333333',discount:'0',priceBasis:'exclusive',taxCodeId:'L'}],rules)),[['100.00','12.00','112.00']]);
  assert.deepEqual(money(computeLines([{quantity:'1',unitPrice:'1.05',discount:'0',priceBasis:'exclusive',taxCodeId:'L'}],rules)),[['1.05','0.13','1.18']]);
  const three=k=>[1,2,3].map(()=>({quantity:'1',unitPrice:'1.05',discount:'0',priceBasis:'exclusive',taxCodeId:k}));
  assert.deepEqual(money(computeLines(three('L'),rules)).map(a=>a[1]),['0.13','0.13','0.13']);
  assert.deepEqual(money(computeLines(three('D'),rules)).map(a=>a[1]),['0.13','0.13','0.12']);
  assert.equal(decimal(totals(computeLines(three('D'),rules)).tax),'0.38');
  // Larger remainder wins the residual cent regardless of position.
  const uneven=computeLines([{quantity:'1',unitPrice:'1.04',discount:'0',priceBasis:'exclusive',taxCodeId:'D'},{quantity:'1',unitPrice:'1.07',discount:'0',priceBasis:'exclusive',taxCodeId:'D'}],rules);
  assert.deepEqual(money(uneven).map(a=>a[1]),['0.12','0.13']);
  assert.deepEqual(money(computeLines([{quantity:'2',unitPrice:'50',discount:'10',priceBasis:'exclusive'}],rules)),[['90.00','0.00','90.00']]);
  assert.throws(()=>computeLines([{quantity:'0',unitPrice:'5',discount:'0',priceBasis:'exclusive'}],rules),e=>e.code==='VALIDATION_FAILED');
});
