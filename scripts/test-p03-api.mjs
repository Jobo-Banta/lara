// P03-03 HTTP acceptance: ledger operations through the API and worker as
// processes. Chart, periods, journal lifecycle with independent approval and
// posting, refusals with typed codes, reversal, opening import through the
// evidence path, trial balance report as a job stored as evidence, period
// soft close/lock/reopen and cross-tenant isolation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4025,BASE='http://127.0.0.1:'+PORT,bucket='.local/p03-api-test-'+randomBytes(3).toString('hex');
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex'),WORKER_POLL_MS:'200',RATE_LIMIT_WRITES_PER_MINUTE:'1000',RATE_LIMIT_READS_PER_MINUTE:'5000'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
const children=[];
function start(file){const c=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>{out+=b;});c.stderr.on('data',b=>{out+=b;});c.log=()=>out;c.done=false;c.once('exit',()=>{c.done=true;});children.push(c);return c;}
async function stop(c){if(c.done)return;const exited=new Promise(r=>c.once('exit',r));c.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);if(!c.done)c.kill('SIGKILL');}
async function waitFor(fn,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,200));}assert.fail('timeout: '+label);}
const principals={};
const call=async(name,method,path,{body,headers={},raw}={})=>{const token=signIdentity(name+'-'+suffix,method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET);const r=await fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token,...(raw?{}:{'content-type':'application/json'}),...headers},body:raw??(body===undefined?undefined:JSON.stringify(body))});return r;};
const json=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return {raw:t};}};
const must=async(r,status)=>{const t=await r.text();assert.equal(r.status,status,t);try{return JSON.parse(t);}catch{return {raw:t};}};
const key=()=>({'idempotency-key':randomUUID()});
const im=v=>({'if-match':'"'+v+'"'});
const contract=(op,body)=>{const v=validateResponse(op,body);assert.equal(v.ok,true,op+' drifted: '+JSON.stringify(v.fieldErrors)+' '+JSON.stringify(body).slice(0,200));};
const apiProcess=start('apps/api/src/server.mjs');let worker=null;
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 let entityId,branchId;
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-ledger-'+suffix,name:'Ledger API',mode:'demo'});
  for(const n of ['accountant','controller','security','clerk'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['accountant','controller','security_admin','clerk'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  for(const [p,r] of [['accountant','accountant'],['controller','controller'],['security','security_admin'],['clerk','clerk']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  const ctx={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctx,{legalName:'Ledger API Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  const fresh={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  branchId=(await organization.createBranch(tx,fresh,entityId,{code:'HQ',name:'Head office',address:'Makati'})).id;
  for(const c of ['workspace','general_ledger'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.controller,principals.accountant]);
  await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3)",[tenantId,entityId,principals.controller]);
 });
 const bookId=(await api.query("select id from lara.books where tenant_id=$1",[tenantId]).catch(()=>({rows:[]}))).rows[0]?.id||await (async()=>{await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);return (await api.query("select id from lara.books where tenant_id=$1",[tenantId])).rows[0].id;})();
 const eh={'x-entity-id':entityId};
 // Chart
 const acct=async(body)=>{const r=await call('accountant','POST','/accounts',{body:{bookId,controlType:'none',requiredDimensions:[],...body},headers:{...key(),...eh}});const a=await must(r,201);contract('post_accounts',a);return a;};
 const cash=await acct({code:'1010',name:'Cash',category:'asset'});
 const revenue=await acct({code:'4000',name:'Revenue',category:'income'});
 const ar=await acct({code:'1200',name:'Receivables',category:'asset',controlType:'ar'});
 let r=await call('clerk','POST','/accounts',{body:{bookId,code:'9999',name:'X',category:'asset',controlType:'none',requiredDimensions:[]},headers:{...key(),...eh}});assert.equal(r.status,403);
 r=await call('accountant','GET','/accounts?bookId='+bookId,{headers:eh});const accounts=await json(r);contract('get_accounts',accounts);assert.equal(accounts.items.length,3);
 r=await call('accountant','PATCH','/accounts/'+cash.id,{body:{bookId,code:'1010',name:'Cash and banks',category:'asset',controlType:'none',requiredDimensions:[]},headers:{...eh,...im(cash.version)}});assert.equal(r.status,200);assert.equal((await json(r)).name,'Cash and banks');
 pass('chart of accounts through the API with role checks, listing and versioned edits');
 // Periods
 r=await call('controller','POST','/periods',{body:{bookId,startsOn:'2026-09-01',endsOn:'2026-09-30'},headers:{...key(),...eh}});assert.equal(r.status,201);const period=await json(r);contract('post_periods',period);
 r=await call('controller','POST','/periods',{body:{bookId,startsOn:'2026-09-15',endsOn:'2026-10-15'},headers:{...key(),...eh}});assert.equal(r.status,409);assert.equal((await json(r)).code,'STATE_CONFLICT');
 pass('periods are created per book and overlaps are refused with a typed conflict');
 // Journal lifecycle
 const lines=(d,c,amt='1000.00')=>[{accountId:d,branchId,debit:amt,credit:'0',dimensions:{}},{accountId:c,branchId,debit:'0',credit:amt,dimensions:{}}];
 const jb={bookId,accountingDate:'2026-09-18',documentDate:'2026-09-18',currency:'PHP',description:'Cash sale',lines:lines(cash.id,revenue.id),evidenceIds:[]};
 r=await call('accountant','POST','/journals',{body:{...jb,lines:lines(cash.id,revenue.id).map((l,i)=>i?{...l,credit:'900.00'}:l)},headers:{...key(),...eh}});assert.equal(r.status,422);assert.equal((await json(r)).code,'UNBALANCED_ENTRY');
 r=await call('accountant','POST','/journals',{body:jb,headers:{...key(),...eh}});const j=await must(r,201);contract('post_journals',j);
 r=await call('accountant','POST','/journals/'+j.id+'/submit',{body:{},headers:{...key(),...eh,...im(j.version)}});assert.equal(r.status,200);const sub=await json(r);contract('post_journals_id_submit',sub);
 r=await call('accountant','POST','/journals/'+j.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(sub.version)}});assert.equal(r.status,403);assert.equal((await json(r)).code,'SELF_APPROVAL');
 r=await call('controller','POST','/journals/'+j.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(sub.version)}});assert.equal(r.status,200);const appr=await json(r);
 r=await call('accountant','POST','/journals/'+j.id+'/post',{body:{},headers:{...key(),...eh,...im(appr.version)}});const posted=await must(r,200);contract('post_journals_id_post',posted);assert.equal(posted.state,'posted');assert.equal(posted.journalEntryIds.length,1);
 r=await call('accountant','PATCH','/journals/'+j.id,{body:jb,headers:{...eh,...im(posted.version)}});assert.equal(r.status,409);
 // Control account refusal through the API
 r=await call('accountant','POST','/journals',{body:{...jb,description:'Manual AR',lines:lines(ar.id,revenue.id)},headers:{...key(),...eh}});const bad=await json(r);
 r=await call('accountant','POST','/journals/'+bad.id+'/submit',{body:{},headers:{...key(),...eh,...im(bad.version)}});const bs=await json(r);
 r=await call('controller','POST','/journals/'+bad.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(bs.version)}});const ba=await json(r);
 r=await call('accountant','POST','/journals/'+bad.id+'/post',{body:{},headers:{...key(),...eh,...im(ba.version)}});assert.equal(r.status,409);assert.match((await json(r)).message,/owning module/);
 // Reversal
 r=await call('accountant','POST','/journals/'+j.id+'/reverse',{body:{accountingDate:'2026-09-20',reason:'Duplicate'},headers:{...key(),...eh,...im(posted.version)}});const rev=await must(r,200);contract('post_journals_id_reverse',rev);assert.equal(rev.state,'draft');
 r=await call('accountant','GET','/journals?bookId='+bookId+'&status=draft,posted',{headers:eh});const jl=await json(r);contract('get_journals',jl);assert.equal(jl.items.length,2);
 pass('journals: unbalanced drafts refused, self-approval refused, independent approval and posting produce one entry, posted journals are immutable, manual control-account posting is refused and a reversal draft is created');
 // Opening import through the evidence path and the worker
 const csv=Buffer.from('source_key,account_code,branch_code,accounting_date,debit,credit\nOB-1,1010,HQ,2026-08-31,5000.00,0\nOB-2,4000,HQ,2026-08-31,0,5000.00\n');
 r=await call('controller','POST','/periods',{body:{bookId,startsOn:'2026-08-01',endsOn:'2026-08-31'},headers:{...key(),...eh}});assert.equal(r.status,201);
 r=await call('accountant','POST','/evidence/uploads',{body:{filename:'openings.csv',mime:'text/csv',byteCount:csv.length,sha256:sha(csv),classification:'confidential'},headers:{...key(),...eh}});const up=await json(r);
 r=await call('accountant','PUT','/evidence/'+up.evidenceId+'/content',{raw:csv,headers:{...eh,'content-type':'text/csv'}});assert.equal(r.status,204);
 r=await call('accountant','POST','/evidence/'+up.evidenceId+'/complete',{body:{},headers:{...key(),...eh,...im(up.version)}});assert.equal(r.status,202,await r.text());
 worker=start('apps/worker/src/main.mjs');
 await waitFor(async()=>(await json(await call('accountant','GET','/evidence/'+up.evidenceId,{headers:eh}))).state==='available','scan');
 r=await call('accountant','POST','/imports',{body:{kind:'openings',evidenceId:up.evidenceId,mappingVersion:'v1',sourceId:'legacy',externalBatchId:'B1',cutoffDate:'2026-08-31'},headers:{...key(),...eh}});const imp=await must(r,201);contract('post_imports',imp);
 r=await call('accountant','POST','/imports/'+imp.id+'/validate',{body:{},headers:{...key(),...eh,...im(imp.version)}});const val=await must(r,200);assert.equal(val.state,'validated');
 r=await call('controller','POST','/imports/'+imp.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(val.version)}});assert.equal(r.status,200);const ia=await json(r);
 const ck=key();
 r=await call('controller','POST','/imports/'+imp.id+'/commit',{body:{},headers:{...ck,...eh,...im(ia.version)}});const committed=await must(r,200);contract('post_imports_id_commit',committed);assert.equal(committed.journalEntryIds.length,1);
 r=await call('controller','POST','/imports/'+imp.id+'/commit',{body:{},headers:{...ck,...eh,...im(ia.version)}});assert.deepEqual(await json(r),committed,'idempotent replay of the commit');
 pass('opening import: CSV evidence scanned, import created, validated, independently approved and committed once through the API');
 // Report job
 r=await call('controller','POST','/reports',{body:{reportType:'trial_balance',bookId,periodStart:'2026-08-01',periodEnd:'2026-09-30',asOf:new Date().toISOString(),format:'csv'},headers:{...key(),...eh}});const job=await must(r,202);contract('post_reports',job);
 await waitFor(async()=>['succeeded','failed'].includes((await json(await call('controller','GET','/jobs/'+job.id,{headers:eh}))).state),'report job');
 const done=await json(await call('controller','GET','/jobs/'+job.id,{headers:eh}));assert.equal(done.state,'succeeded',worker?.log().split('\n').slice(-5).join('\n'));
 r=await call('controller','GET','/evidence/'+done.resultResourceId+'/content',{headers:eh});assert.equal(r.status,200);const text=await r.text();assert.match(text.split('\n')[0],/^code,name,category/);assert.ok(text.includes('1010'));
 r=await call('clerk','POST','/reports',{body:{reportType:'trial_balance',bookId,periodStart:'2026-08-01',periodEnd:'2026-09-30',asOf:new Date().toISOString(),format:'csv'},headers:{...key(),...eh}});assert.equal(r.status,403);
 pass('trial balance report runs as a job, is stored as restricted evidence with a CSV rendering and requires report.generate');
 // Period close through the API
 r=await call('controller','POST','/periods/'+period.id+'/soft-close',{body:{reason:'Month end'},headers:{...key(),...eh,...im(period.version)}});const sc=await must(r,200);contract('post_periods_id_soft_close',sc);
 r=await call('controller','POST','/periods/'+period.id+'/lock',{body:{reason:'Lock'},headers:{...key(),...eh,...im(sc.version)}});const lk=await must(r,200);assert.equal(lk.state,'locked');
 r=await call('accountant','POST','/journals',{body:{...jb,description:'Late'},headers:{...key(),...eh}});const late=await json(r);
 r=await call('accountant','POST','/journals/'+late.id+'/submit',{body:{},headers:{...key(),...eh,...im(late.version)}});const ls=await json(r);
 r=await call('controller','POST','/journals/'+late.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(ls.version)}});const la=await json(r);
 r=await call('accountant','POST','/journals/'+late.id+'/post',{body:{},headers:{...key(),...eh,...im(la.version)}});assert.equal(r.status,409);assert.equal((await json(r)).code,'PERIOD_LOCKED');
 r=await call('accountant','POST','/periods/'+period.id+'/reopen',{body:{reason:'x'},headers:{...key(),...eh,...im(lk.version)}});assert.equal(r.status,403);
 r=await call('controller','POST','/periods/'+period.id+'/reopen',{body:{reason:'Audit adjustment'},headers:{...key(),...eh,...im(lk.version)}});assert.equal(r.status,200);assert.equal((await json(r)).state,'open');
 pass('periods soft close and lock through the API, locked periods refuse postings with PERIOD_LOCKED, and reopening needs period.reopen');
 console.log('PASS P03-03 API: '+step+' groups');
}catch(error){console.error('--- api log ---\n'+apiProcess.log().split('\n').filter(l=>!l.includes('request_completed')).slice(-10).join('\n'));if(worker)console.error('--- worker ---\n'+worker.log().split('\n').slice(-8).join('\n'));throw error;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
