// P02 load measurement: concurrent reads and commands through the HTTP API
// against real PostgreSQL. Always reports p50/p95/max and error counts; asserts
// the 07-security profile (p95 under 2 s) only when LARA_LOAD_ASSERT=1, which
// CI sets for its local database. Remote databases are reported, not judged.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {inTransaction,identity,organization,ledger} from '../packages/domain/src/index.mjs';
const fixture={};
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const api=new pg.Client({...connectionOptions(process.env.DATABASE_URL),connectionTimeoutMillis:15000,query_timeout:30000});
const owner=new pg.Client({...connectionOptions(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL),connectionTimeoutMillis:15000,query_timeout:60000});
await Promise.all([api.connect(),owner.connect()]);
const PORT=4023,BASE='http://127.0.0.1:'+PORT;
const requests=Number(process.env.LARA_LOAD_REQUESTS||200),concurrency=Number(process.env.LARA_LOAD_CONCURRENCY||10);
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID(),subject='load-'+suffix;
let child;
try{
 let entityId,principalId;
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-load-'+suffix,name:'Load '+suffix,mode:'demo'});
  const p=await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject,displayName:'load'});principalId=p.id;
  const role=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) select $1,'controller','Controller',permissions,'approved',$2,$3 from lara.role_templates where code='controller' returning id",[tenantId,'0'.repeat(64),p.id])).rows[0].id;
  await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$2)',[tenantId,p.id,role]);
  // Second principal for the posting profile: the accountant prepares and posts, the controller approves.
  const a=await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:'load-acct-'+suffix,displayName:'accountant'});
  const arole=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) select $1,'accountant','Accountant',permissions,'approved',$2,$3 from lara.role_templates where code='accountant' returning id",[tenantId,'1'.repeat(64),p.id])).rows[0].id;
  await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,a.id,arole,p.id]);
  const ctx={...await identity.actorContext(tx,tenantId,p.id),traceId:'load'};
  entityId=(await organization.createEntity(tx,ctx,{legalName:'Load entity',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  const fresh={...await identity.actorContext(tx,tenantId,p.id),traceId:'load'};
  const branch=await organization.createBranch(tx,fresh,entityId,{code:'HQ',name:'HQ',address:'Makati'});
  for(const c of ['workspace','general_ledger'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,p.id,a.id]);
  const book=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,p.id])).rows[0].id;
  const actx={...await identity.actorContext(tx,tenantId,a.id),traceId:'load'};
  const cash=await ledger.createAccount(tx,actx,entityId,{bookId:book,code:'1010',name:'Cash',category:'asset',controlType:'none',requiredDimensions:[]});
  const rev=await ledger.createAccount(tx,actx,entityId,{bookId:book,code:'4000',name:'Revenue',category:'income',controlType:'none',requiredDimensions:[]});
  await ledger.createPeriod(tx,fresh,entityId,{bookId:book,startsOn:'2026-01-01',endsOn:'2026-12-31'});
  // Sales issuance profile: billing prepares and submits, the controller approves, the accountant issues; numbering serializes on the series row.
  const b=await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:'load-bill-'+suffix,displayName:'billing'});
  const brole=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) select $1,'billing','Billing',permissions,'approved',$2,$3 from lara.role_templates where code='billing' returning id",[tenantId,'2'.repeat(64),p.id])).rows[0].id;
  await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,b.id,brole,p.id]);
  await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'sales','active','p04.1',$3,now(),$4)",[tenantId,entityId,p.id,a.id]);
  const ar=await ledger.createAccount(tx,actx,entityId,{bookId:book,code:'1200',name:'Receivables',category:'asset',controlType:'ar',requiredDimensions:[]});
  const otax=await ledger.createAccount(tx,actx,entityId,{bookId:book,code:'2200',name:'Output tax',category:'liability',controlType:'output_tax',requiredDimensions:[]});
  const profile={arAccountId:ar.id,outputTaxAccountId:otax.id,cashAccountId:cash.id,scale:2,dueDays:30};
  await tx.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,'sales_profile',1,$3,$4,'approved',$5,now(),$6)",[tenantId,entityId,JSON.stringify(profile),'3'.repeat(64),a.id,p.id]);
  await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4)",[tenantId,entityId,branch.id,p.id]);
  const rule=(await tx.query("insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,status,approved_by,activated_by,activated_at,content_hash,created_by) values($1,$2,'VAT12',1,'vat','2026-01-01',0.12,'net','issue','line_half_up',gen_random_uuid(),$3,'[\"AC-01\"]','active',$4,$4,now(),$5,$6) returning id",[tenantId,entityId,JSON.stringify([randomUUID()]),p.id,'4'.repeat(64),a.id])).rows[0].id;
  const customer=(await tx.query("insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Load customer','unknown','active',$3,$4) returning id",[tenantId,entityId,'5'.repeat(64),p.id])).rows[0].id;
  await tx.query("insert into lara.party_roles(tenant_id,entity_id,party_id,role,created_by) values($1,$2,$3,'customer',$4)",[tenantId,entityId,customer,p.id]);
  // Purchasing bill profile: the clerk prepares and submits, the accountant approves and posts; the supplier reference guard and numbering serialize per supplier and series.
  const c=await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:'load-clerk-'+suffix,displayName:'clerk'});
  const crole=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) select $1,'clerk','Clerk',permissions,'approved',$2,$3 from lara.role_templates where code='clerk' returning id",[tenantId,'6'.repeat(64),p.id])).rows[0].id;
  await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,c.id,crole,p.id]);
  await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'purchasing','active','p05.1',$3,now(),$4)",[tenantId,entityId,p.id,a.id]);
  const ap=await ledger.createAccount(tx,actx,entityId,{bookId:book,code:'2100',name:'Payables',category:'liability',controlType:'ap',requiredDimensions:[]});
  const itax=await ledger.createAccount(tx,actx,entityId,{bookId:book,code:'1300',name:'Input tax',category:'asset',controlType:'input_tax',requiredDimensions:[]});
  const exp=await ledger.createAccount(tx,actx,entityId,{bookId:book,code:'5000',name:'Fees',category:'expense',controlType:'none',requiredDimensions:[]});
  await tx.query("insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,status,approved_by,effective_at,created_by) values($1,$2,'purchasing_profile',1,$3,$4,'approved',$5,now(),$6)",[tenantId,entityId,JSON.stringify({apAccountId:ap.id,inputTaxAccountId:itax.id,cashAccountId:cash.id,scale:2,dueDays:30}),'7'.repeat(64),a.id,p.id]);
  await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'bill','BILL','numbering-2026',$4)",[tenantId,entityId,branch.id,p.id]);
  const supplier=(await tx.query("insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Load supplier','unknown','active',$3,$4) returning id",[tenantId,entityId,'8'.repeat(64),p.id])).rows[0].id;
  await tx.query("insert into lara.party_roles(tenant_id,entity_id,party_id,role,created_by) values($1,$2,$3,'supplier',$4)",[tenantId,entityId,supplier,p.id]);
  const invoice=(await tx.query("insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'si.pdf',$4,'application/pdf',10,'available','internal',$5) returning id",[tenantId,entityId,'load-'+suffix,'9'.repeat(64),p.id])).rows[0].id;
  Object.assign(fixture,{bookId:book,branchId:branch.id,cash:cash.id,revenue:rev.id,rule,customer,supplier,expense:exp.id,invoice});
 });
 child=spawn(process.execPath,['apps/api/src/server.mjs'],{env:{...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',RATE_LIMIT_WRITES_PER_MINUTE:'100000',RATE_LIMIT_READS_PER_MINUTE:'100000',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:'.local/load-'+suffix,FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex')},stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);
 for(let i=0;i<100;i++){try{if((await fetch(BASE+'/health/live')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const call=async(method,path,body,who=subject,extra={})=>{const started=performance.now();const r=await fetch(BASE+'/v1'+path,{method,headers:{authorization:'Bearer '+signIdentity(who,method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET),'content-type':'application/json','x-entity-id':entityId,'idempotency-key':randomUUID(),...extra},body:body?JSON.stringify(body):undefined});const text=await r.text();return {ms:performance.now()-started,status:r.status,body:text};};
 const run=async(label,fn)=>{
  const results=[];let next=0;
  await Promise.all(Array.from({length:concurrency},async()=>{while(next<requests){const i=next++;results.push(await fn(i));}}));
  const ms=results.map(r=>r.ms).sort((a,b)=>a-b),p=q=>Math.round(ms[Math.min(ms.length-1,Math.floor(ms.length*q))]);
  const errors=results.filter(r=>r.status>=400).length;
  if(errors&&process.env.LARA_LOAD_DEBUG)console.error(results.find(r=>r.status>=400).body.slice(0,400));
  const statuses={};for(const r of results)statuses[r.status]=(statuses[r.status]||0)+1;
  const summary={label,requests,concurrency,p50:p(0.5),p95:p(0.95),max:Math.round(ms.at(-1)),errors,statuses,throughputPerSec:Math.round(requests/(results.reduce((s,r)=>s+r.ms,0)/concurrency/1000)*10)/10};
  console.log(JSON.stringify(summary));return summary;
 };
 const reads=await run('GET /v1/tasks',()=>call('GET','/tasks?limit=50'));
 const writes=await run('POST /v1/tasks',i=>call('POST','/tasks',{kind:'load_check',sourceType:'party',sourceId:randomUUID(),reason:'Load request '+i}));
 const mixed=await run('mixed 4 reads : 1 write',i=>i%5===0?call('POST','/tasks',{kind:'load_mixed',sourceType:'party',sourceId:randomUUID(),reason:'Mixed load '+i}):call('GET','/tasks?limit=50&status=open'));
 // Posting profile (07-security: 20 postings/s sustained is the benchmark target; measured here as the post step of a reviewed journal).
 const acct='load-acct-'+suffix;
 const postings=await run('journal post (after prepare, submit, approve)',async i=>{
  const j=JSON.parse((await call('POST','/journals',{bookId:fixture.bookId,accountingDate:'2026-06-15',documentDate:'2026-06-15',currency:'PHP',description:'Load posting '+i,lines:[{accountId:fixture.cash,branchId:fixture.branchId,debit:'100.00',credit:'0',dimensions:{}},{accountId:fixture.revenue,branchId:fixture.branchId,debit:'0',credit:'100.00',dimensions:{}}],evidenceIds:[]},acct)).body);
  const s=JSON.parse((await call('POST','/journals/'+j.id+'/submit',{},acct,{'if-match':'"'+j.version+'"'})).body);
  const a=JSON.parse((await call('POST','/journals/'+j.id+'/approve',{decision:'approve',contentVersion:1},subject,{'if-match':'"'+s.version+'"'})).body);
  return call('POST','/journals/'+j.id+'/post',{},acct,{'if-match':'"'+a.version+'"'});
 });
 // Issuance profile (P04-T02 under concurrency): reviewed invoices issue with a single-use number; the series lock serializes only the issue step.
 const bill='load-bill-'+suffix;
 const issuance=await run('invoice issue (after prepare, submit, approve)',async i=>{
  const d=JSON.parse((await call('POST','/invoices',{kind:'invoice',branchId:fixture.branchId,bookId:fixture.bookId,partyId:fixture.customer,documentDate:'2026-06-15',accountingDate:'2026-06-15',currency:'PHP',ruleProfileVersion:'load',lines:[{description:'Load invoice '+i,quantity:'1',unitPrice:'1000',discount:'0',priceBasis:'exclusive',accountId:fixture.revenue,taxCodeId:fixture.rule,dimensions:{}}],evidenceIds:[]},bill)).body);
  const s=JSON.parse((await call('POST','/invoices/'+d.id+'/submit',{},bill,{'if-match':'"'+d.version+'"'})).body);
  const a=JSON.parse((await call('POST','/invoices/'+d.id+'/approve',{decision:'approve',contentVersion:1},subject,{'if-match':'"'+s.version+'"'})).body);
  return call('POST','/invoices/'+d.id+'/post',{},acct,{'if-match':'"'+a.version+'"'});
 });
 const numbers=JSON.parse((await call('GET','/invoices?state=posted&limit=200',undefined,bill)).body).items.map(d=>d.officialNumber);
 assert.equal(new Set(numbers).size,numbers.length,'official numbers must be unique under concurrent issuance');
 // Bill profile (P05-T03 under concurrency): distinct supplier references post with single-use numbers; the same reference submitted concurrently records exactly one bill.
 const clerk='load-clerk-'+suffix;
 const bills=await run('bill post (after prepare, submit, approve)',async i=>{
  const d=JSON.parse((await call('POST','/bills',{kind:'bill',branchId:fixture.branchId,bookId:fixture.bookId,partyId:fixture.supplier,documentDate:'2026-06-15',accountingDate:'2026-06-15',currency:'PHP',ruleProfileVersion:'load',externalReference:'LOAD-'+i,lines:[{description:'Load bill '+i,quantity:'1',unitPrice:'1000',discount:'0',priceBasis:'exclusive',accountId:fixture.expense,taxCodeId:fixture.rule,dimensions:{}}],evidenceIds:[fixture.invoice]},clerk)).body);
  const s=JSON.parse((await call('POST','/bills/'+d.id+'/submit',{},clerk,{'if-match':'"'+d.version+'"'})).body);
  // Equal amounts on one date flag every later bill as a possible duplicate; the approval records the disposition.
  const a=JSON.parse((await call('POST','/bills/'+d.id+'/approve',{decision:'approve',contentVersion:1,reason:'Load run: distinct supplier invoices checked'},acct,{'if-match':'"'+s.version+'"'})).body);
  return call('POST','/bills/'+d.id+'/post',{},acct,{'if-match':'"'+a.version+'"'});
 });
 const billNumbers=JSON.parse((await call('GET','/bills?state=posted&limit=200',undefined,clerk)).body).items.map(d=>d.officialNumber);
 assert.equal(new Set(billNumbers).size,billNumbers.length,'bill numbers must be unique under concurrent posting');
 const duplicates=await Promise.all(Array.from({length:concurrency},()=>call('POST','/bills',{kind:'bill',branchId:fixture.branchId,bookId:fixture.bookId,partyId:fixture.supplier,documentDate:'2026-06-16',accountingDate:'2026-06-16',currency:'PHP',ruleProfileVersion:'load',externalReference:'DUP-001',lines:[{description:'Duplicate race',quantity:'1',unitPrice:'50',discount:'0',priceBasis:'exclusive',accountId:fixture.expense,dimensions:{}}],evidenceIds:[fixture.invoice]},clerk)));
 assert.equal(duplicates.filter(r=>r.status===201).length,1,'exactly one bill per supplier reference under a concurrent race: '+JSON.stringify(duplicates.map(r=>r.status)));
 assert.ok(duplicates.filter(r=>r.status===409).every(r=>JSON.parse(r.body).code==='DUPLICATE_SOURCE'),'the losers answer DUPLICATE_SOURCE');
 assert.equal(reads.errors+writes.errors+mixed.errors+postings.errors+issuance.errors+bills.errors,0,'no request may fail under load: '+stderr.slice(-500));
 if(process.env.LARA_LOAD_ASSERT==='1'){
  for(const s of [reads,writes,mixed,postings,issuance,bills])assert.ok(s.p95<2000,s.label+' p95 '+s.p95+'ms exceeds the 2 s profile');
  assert.ok(writes.p95<1000&&postings.p95<1000,'local command/post p95 exceeds the 1 s profile: '+writes.p95+'/'+postings.p95);
  console.log('PASS P02 load profile asserted on the local database');
 }else console.log('REPORT P02 load measured against a remote database; thresholds not asserted (set LARA_LOAD_ASSERT=1 on the benchmark environment)');
}finally{
 if(child&&child.exitCode===null&&!child.signalCode){const exited=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);}
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
