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
  Object.assign(fixture,{bookId:book,branchId:branch.id,cash:cash.id,revenue:rev.id});
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
 assert.equal(reads.errors+writes.errors+mixed.errors+postings.errors,0,'no request may fail under load: '+stderr.slice(-500));
 if(process.env.LARA_LOAD_ASSERT==='1'){
  for(const s of [reads,writes,mixed,postings])assert.ok(s.p95<2000,s.label+' p95 '+s.p95+'ms exceeds the 2 s profile');
  assert.ok(writes.p95<1000&&postings.p95<1000,'local command/post p95 exceeds the 1 s profile: '+writes.p95+'/'+postings.p95);
  console.log('PASS P02 load profile asserted on the local database');
 }else console.log('REPORT P02 load measured against a remote database; thresholds not asserted (set LARA_LOAD_ASSERT=1 on the benchmark environment)');
}finally{
 if(child&&child.exitCode===null&&!child.signalCode){const exited=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);}
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
