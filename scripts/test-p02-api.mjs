// P02-03 HTTP acceptance: the API and worker run as separate processes with
// their runtime roles. Covers contract routing, header conventions,
// idempotent replay, validation errors, tenant isolation, evidence
// upload → verify → scan → download, tasks, exports with revocation recheck
// (CORE-14), command lookup, feature gating and rate limiting.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse,validate} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization} from '../packages/domain/src/index.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4021,BASE='http://127.0.0.1:'+PORT,bucket='.local/p02-api-test-'+randomBytes(3).toString('hex');
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex'),WORKER_POLL_MS:'200',RATE_LIMIT_WRITES_PER_MINUTE:'30'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex');
const tenants=[];let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
const children=[];
function start(file,extra={}){const c=spawn(process.execPath,[file],{env:{...env,...extra},stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>{out+=b;});c.stderr.on('data',b=>{out+=b;});c.log=()=>out;c.done=false;c.once('exit',()=>{c.done=true;});children.push(c);return c;}
async function stop(c){if(c.done)return;const exited=new Promise(r=>c.once('exit',r));c.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);if(!c.done)c.kill('SIGKILL');}
async function waitFor(fn,label,ms=20000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,150));}assert.fail('timeout: '+label);}

async function bootstrap(slug){
 const tenantId=randomUUID();tenants.push(tenantId);
 const principals={},roles={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug,name:'API test '+slug,mode:'demo'});
  for(const name of ['security','preparer','controller','clerk','exporter'])principals[name]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:name+'-'+slug,displayName:name})).id;
  const preparer=['entity.create','entity.edit','entity.read','branch.create','branch.edit','branch.read','party.create','party.edit','party.archive','party.read','task.create','task.edit','task.assign','task.resolve','task.comments','task.read','evidence.upload','evidence.read','obligation.create','obligation.edit','obligation.complete','obligation.read','membership.read','session.read','command.read','job.read'];
  roles.preparer=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'preparer','Preparer',$2,'approved',$3,$4) returning id",[tenantId,JSON.stringify(preparer),sha('preparer'),principals.security])).rows[0].id;
  for(const code of ['security_admin','controller','clerk'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  roles.exporter=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'exporter','Exporter','[\"evidence.export\",\"evidence.read\",\"session.read\",\"job.read\"]','approved',$2,$3) returning id",[tenantId,sha('exporter'),principals.security])).rows[0].id;
  const grant=(p,r)=>tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  await grant('security','security_admin');await grant('preparer','preparer');await grant('controller','controller');await grant('clerk','clerk');
 });
 return {tenantId,slug,principals,roles};
}
async function call(t,name,method,path,{body,headers={},raw}={}){
 const token=signIdentity(name+'-'+t.slug,method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET);
 const response=await fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token,...(raw?{}:{'content-type':'application/json'}),...headers},body:raw??(body===undefined?undefined:JSON.stringify(body))});
 if(response.status===401){const text=await response.clone().text();console.error('401 on '+method+' /v1'+path+' token='+token.slice(0,40)+' body='+text);}
 return response;
}
const json=async r=>{const text=await r.text();try{return JSON.parse(text);}catch{return {raw:text};}};
const key=()=>({'idempotency-key':randomUUID()});
const im=v=>({'if-match':'"'+v+'"'});
const versionOf=async(t,name,path,headers={})=>(await json(await call(t,name,'GET',path,{headers}))).version;
const contract=(op,body)=>{const v=validateResponse(op,body);assert.equal(v.ok,true,op+' response drifted from the contract: '+JSON.stringify(v.fieldErrors)+' '+JSON.stringify(body).slice(0,300));};
const errorShape=body=>assert.equal(validate('Error',body).ok,true,'error shape: '+JSON.stringify(body));

const apiProcess=start('apps/api/src/server.mjs');
let worker=null;
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 assert.equal((await fetch(BASE+'/health/ready')).status,200,apiProcess.log());
 const A=await bootstrap('api-a-'+suffix),B=await bootstrap('api-b-'+suffix);

 // Session and unknown accounts
 let r=await call(A,'preparer','GET','/me');assert.equal(r.status,200);const me=await json(r);contract('get_me',me);assert.equal(me.tenantId,A.tenantId);assert.ok(me.permissions.includes('entity.create'));
 r=await fetch(BASE+'/v1/me',{headers:{authorization:'Bearer '+signIdentity('nobody-'+suffix,'GET','/v1/me',process.env.SESSION_SECRET)}});assert.equal(r.status,403);errorShape(await json(r));
 r=await fetch(BASE+'/v1/me');assert.equal(r.status,401);
 r=await call(A,'preparer','GET','/nothing/here');assert.equal(r.status,404);
 r=await call(A,'preparer','POST','/settlements',{body:{},headers:key()});assert.equal(r.status,409);assert.equal((await json(r)).code,'FEATURE_NOT_ENABLED');
 pass('session context comes from membership; unknown accounts, missing tokens, unknown routes and later-phase operations answer with typed errors');

 // Entities: headers, validation, idempotency, ETag/If-Match
 const entityBody={legalName:'API Entity',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1};
 r=await call(A,'preparer','POST','/entities',{body:entityBody});assert.equal(r.status,428);assert.equal((await json(r)).code,'PRECONDITION_REQUIRED');
 r=await call(A,'preparer','POST','/entities',{body:{...entityBody,fiscalYearStartMonth:13,extra:1},headers:key()});assert.equal(r.status,422);const bad=await json(r);errorShape(bad);assert.deepEqual(bad.fieldErrors.map(f=>f.path).sort(),['extra','fiscalYearStartMonth']);
 const k=key();
 r=await call(A,'preparer','POST','/entities',{body:entityBody,headers:k});assert.equal(r.status,201);const entity=await json(r);contract('post_entities',entity);assert.equal(r.headers.get('etag'),'"1"');
 r=await call(A,'preparer','POST','/entities',{body:entityBody,headers:k});assert.equal(r.status,201);assert.deepEqual(await json(r),entity,'replay returns the committed resource');
 r=await call(A,'preparer','POST','/entities',{body:{...entityBody,legalName:'Other'},headers:k});assert.equal(r.status,409);assert.equal((await json(r)).code,'IDEMPOTENCY_CONFLICT');
 r=await call(A,'clerk','POST','/entities',{body:entityBody,headers:key()});assert.equal(r.status,403);
 r=await call(A,'preparer','GET','/commands/'+k['idempotency-key'],{headers:{'x-entity-id':entity.id}});assert.equal(r.status,200);const cmd=await json(r);contract('get_commands_key',cmd);assert.equal(cmd.resourceId,entity.id);
 r=await call(A,'preparer','PATCH','/entities/'+entity.id,{body:{...entityBody,legalName:'API Entity Inc'}});assert.equal(r.status,428);
 r=await call(A,'preparer','PATCH','/entities/'+entity.id,{body:{...entityBody,legalName:'API Entity Inc'},headers:{'if-match':'"9"'}});assert.equal(r.status,412);const stale=await json(r);assert.equal(stale.code,'VERSION_CONFLICT');assert.equal(stale.resourceVersion,1);
 r=await call(A,'preparer','PATCH','/entities/'+entity.id,{body:{...entityBody,legalName:'API Entity Inc'},headers:{'if-match':'"1"'}});assert.equal(r.status,200);const renamed=await json(r);contract('patch_entities_id',renamed);assert.equal(renamed.contentVersion,2);assert.equal(r.headers.get('etag'),'"2"');
 r=await call(A,'preparer','GET','/entities');const listed=await json(r);contract('get_entities',listed);assert.deepEqual(listed.items.map(e=>e.id),[entity.id]);
 pass('POST needs Idempotency-Key, invalid bodies return field errors, replay is exact, conflicting replay is 409, PATCH needs If-Match with the ETag version and forbidden roles are refused');

 // Branch, activation as two principals, isolation
 r=await call(A,'preparer','POST','/branches',{body:{code:'HQ',name:'Head office',address:'Makati'},headers:key()});assert.equal(r.status,422,'X-Entity-Id required');
 r=await call(A,'preparer','POST','/branches',{body:{code:'HQ',name:'Head office',address:'Makati'},headers:{...key(),'x-entity-id':entity.id}});assert.equal(r.status,201);contract('post_branches',await json(r));
 r=await call(A,'preparer','POST','/entities/'+entity.id+'/activate',{body:{reason:'Setup complete'},headers:key()});assert.equal(r.status,428,'action commands need If-Match');
 r=await call(A,'preparer','POST','/entities/'+entity.id+'/activate',{body:{reason:'Setup complete'},headers:{...key(),...im(1)}});assert.equal(r.status,412,'stale If-Match on an action');
 r=await call(A,'preparer','POST','/entities/'+entity.id+'/activate',{body:{reason:'Setup complete'},headers:{...key(),...im(await versionOf(A,'preparer','/entities/'+entity.id))}});assert.equal(r.status,200);const req=await json(r);contract('post_entities_id_activate',req);assert.equal(req.state,'pending_activation');
 r=await call(A,'controller','POST','/entities/'+entity.id+'/activate',{body:{reason:'Reviewed'},headers:{...key(),...im(req.version)}});assert.equal(r.status,200);const act=await json(r);assert.equal(act.state,'active');
 r=await call(B,'preparer','GET','/entities/'+entity.id);assert.equal(r.status,404,'other tenant cannot see the entity');
 r=await call(B,'preparer','GET','/tasks',{headers:{'x-entity-id':entity.id}});assert.equal(r.status,404);
 r=await call(B,'preparer','POST','/parties',{body:{legalName:'Intruder',roles:['customer'],identityStatus:'not_applicable',address:'x'},headers:{...key(),'x-entity-id':entity.id}});assert.equal(r.status,404);
 pass('entity-scoped operations need X-Entity-Id; activation is requested by the preparer and approved by the controller; another tenant sees nothing of the entity');

 // Evidence: register, stage, complete, scan, download; mismatch rejected
 const pdf=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
 const eh={'x-entity-id':entity.id};
 r=await call(A,'preparer','POST','/evidence/uploads',{body:{filename:'invoice.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'confidential'},headers:{...key(),...eh}});assert.equal(r.status,201);const up=await json(r);contract('post_evidence_uploads',up);
 r=await call(A,'preparer','POST','/evidence/'+up.evidenceId+'/complete',{body:{},headers:{...key(),...eh,...im(up.version)}});assert.equal(r.status,409,'complete before upload');
 r=await call(A,'preparer','PUT','/evidence/'+up.evidenceId+'/content',{raw:pdf,headers:{...eh,'content-type':'application/pdf'}});assert.equal(r.status,204);
 r=await call(A,'preparer','GET','/evidence/'+up.evidenceId+'/content',{headers:eh});assert.equal(r.status,409,'quarantined content not served');
 r=await call(A,'preparer','POST','/evidence/'+up.evidenceId+'/complete',{body:{},headers:{...key(),...eh,...im(up.version)}});assert.equal(r.status,202);const job=await json(r);contract('post_evidence_id_complete',job);
 r=await call(A,'preparer','GET','/evidence/'+up.evidenceId,{headers:eh});assert.equal((await json(r)).state,'scanning');
 worker=start('apps/worker/src/main.mjs');
 await waitFor(async()=>(await json(await call(A,'preparer','GET','/jobs/'+job.id,{headers:eh}))).state==='succeeded','scan job');
 r=await call(A,'preparer','GET','/jobs/'+job.id,{headers:eh});const done=await json(r);contract('get_jobs_id',done);assert.equal(done.resultResourceId,up.evidenceId);
 r=await call(A,'preparer','GET','/evidence/'+up.evidenceId,{headers:eh});const ev=await json(r);contract('get_evidence_id',ev);assert.equal(ev.state,'available');
 r=await call(A,'preparer','GET','/evidence/'+up.evidenceId+'/content',{headers:eh});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/pdf');assert.ok(Buffer.from(await r.arrayBuffer()).equals(pdf));
 r=await call(B,'preparer','GET','/evidence/'+up.evidenceId+'/content',{headers:eh});assert.equal(r.status,404);
 r=await call(A,'preparer','POST','/evidence/uploads',{body:{filename:'other.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:'a'.repeat(64),classification:'internal'},headers:{...key(),...eh}});const up2=await json(r);
 r=await call(A,'preparer','PUT','/evidence/'+up2.evidenceId+'/content',{raw:pdf,headers:eh});assert.equal(r.status,204);
 r=await call(A,'preparer','POST','/evidence/'+up2.evidenceId+'/complete',{body:{},headers:{...key(),...eh,...im(up2.version)}});assert.equal(r.status,422);const rej=await json(r);errorShape(rej);assert.match(rej.message,/checksum/);
 r=await call(A,'preparer','GET','/evidence/'+up2.evidenceId,{headers:eh});assert.equal((await json(r)).state,'rejected');
 pass('evidence uploads stage bytes, complete verifies and queues the scan, the worker makes clean content available, downloads stay scoped, and a checksum mismatch is rejected and persisted');

 // Tasks
 const taskBody={kind:'missing_evidence',sourceType:'party',sourceId:randomUUID(),reason:'Registration document required'};
 r=await call(A,'preparer','POST','/tasks',{body:taskBody,headers:{...key(),...eh}});assert.equal(r.status,201);const task=await json(r);contract('post_tasks',task);
 r=await call(A,'preparer','POST','/tasks',{body:taskBody,headers:{...key(),...eh}});assert.equal(r.status,200);assert.equal((await json(r)).id,task.id,'same cause returns the existing task');
 r=await call(A,'preparer','POST','/tasks/'+task.id+'/assign',{body:{ownerId:A.principals.clerk,reason:'Clerk collects'},headers:{...key(),...eh,...im(task.version)}});assert.equal(r.status,200);const assigned=await json(r);contract('post_tasks_id_assign',assigned);
 r=await call(A,'clerk','POST','/tasks/'+task.id+'/resolve',{body:{reason:'Done'},headers:{...key(),...eh,...im(assigned.version)}});assert.equal(r.status,409);assert.equal((await json(r)).code,'EVIDENCE_NOT_READY');
 r=await call(A,'clerk','POST','/tasks/'+task.id+'/resolve',{body:{reason:'Attached',evidenceIds:[up.evidenceId]},headers:{...key(),...eh,...im(assigned.version)}});assert.equal(r.status,200);const res=await json(r);contract('post_tasks_id_resolve',res);assert.equal(res.state,'resolved');
 r=await call(A,'clerk','GET','/tasks?ownerId='+A.principals.clerk+'&status=resolved',{headers:eh});const tl=await json(r);contract('get_tasks',tl);assert.deepEqual(tl.items.map(t=>t.id),[task.id]);
 // Cursors bind scope and filters: a cursor issued for one filter set is refused under another, and a forged scope is refused.
 for(let i=0;i<2;i++)await call(A,'preparer','POST','/tasks',{body:{...taskBody,sourceId:randomUUID()},headers:{...key(),...eh}});
 r=await call(A,'preparer','GET','/tasks?limit=1&status=open',{headers:eh});const page1=await json(r);assert.ok(page1.nextCursor,'a continuation cursor is issued');
 r=await call(A,'preparer','GET','/tasks?limit=1&status=open&cursor='+encodeURIComponent(page1.nextCursor),{headers:eh});assert.equal(r.status,200);
 r=await call(A,'preparer','GET','/tasks?limit=1&status=resolved&cursor='+encodeURIComponent(page1.nextCursor),{headers:eh});assert.equal(r.status,422,'cursor reused with a different filter');
 const forged=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(page1.nextCursor,'base64url').toString()),scope:'0000000000000000'})).toString('base64url');
 r=await call(A,'preparer','GET','/tasks?limit=1&status=open&cursor='+encodeURIComponent(forged),{headers:eh});assert.equal(r.status,422,'forged cursor scope');
 pass('tasks open once per cause, assign, refuse resolution without available evidence, list by owner and status, and cursors are bound to their scope and filters');

 // Exports and revocation (CORE-14): queue while the worker is stopped
 await stop(worker);worker=null;
 r=await call(A,'preparer','POST','/exports',{body:{kind:'tasks',resourceIds:[],format:'csv'},headers:{...key(),...eh}});assert.equal(r.status,403);
 r=await call(A,'security','POST','/memberships',{body:{principalId:A.principals.exporter,roleId:A.roles.exporter,branchIds:[]},headers:{...key(),...eh}});assert.equal(r.status,201);const membership=await json(r);contract('post_memberships',membership);
 r=await call(A,'exporter','POST','/exports',{body:{kind:'tasks',resourceIds:[],format:'csv'},headers:{...key(),...eh}});assert.equal(r.status,202);const revokedJob=await json(r);contract('post_exports',revokedJob);
 r=await call(A,'security','POST','/memberships/'+membership.id+'/revoke',{body:{reason:'Left'},headers:{...key(),...eh,...im(membership.version)}});assert.equal(r.status,200);
 r=await call(A,'controller','POST','/exports',{body:{kind:'tasks',resourceIds:[],format:'csv'},headers:{...key(),...eh}});assert.equal(r.status,202);const okJob=await json(r);
 worker=start('apps/worker/src/main.mjs');
 await waitFor(async()=>['failed','succeeded'].includes((await json(await call(A,'controller','GET','/jobs/'+revokedJob.id,{headers:eh}))).state),'revoked export job');
 await waitFor(async()=>['failed','succeeded'].includes((await json(await call(A,'controller','GET','/jobs/'+okJob.id,{headers:eh}))).state),'controller export job');
 const revokedState=await json(await call(A,'controller','GET','/jobs/'+revokedJob.id,{headers:eh}));assert.equal(revokedState.state,'failed','queued export denied after revocation');
 await api.query("select set_config('lara.tenant_id',$1,false)",[A.tenantId]);
 assert.equal((await api.query('select error_code from lara.jobs where id=$1',[revokedJob.id])).rows[0].error_code,'FORBIDDEN');
 const okState=await json(await call(A,'controller','GET','/jobs/'+okJob.id,{headers:eh}));assert.equal(okState.state,'succeeded');assert.equal(okState.resultResourceType,'evidence');
 r=await call(A,'controller','GET','/evidence/'+okState.resultResourceId+'/content',{headers:eh});assert.equal(r.status,200);const csv=await r.text();assert.match(csv.split('\n')[0],/^id,kind,source_type/);assert.ok(csv.includes(task.id));
 r=await call(A,'exporter','GET','/jobs/'+revokedJob.id,{headers:eh});assert.equal(r.status,404,'revoked principal cannot see the job scope');
 pass('exports need evidence.export; a job queued before revocation fails with FORBIDDEN when the worker rechecks; a controller export produces a checksummed CSV downloadable as restricted evidence');

 // Rate limit: a second API instance with a low configured write limit proves the 429 path deterministically.
 const limitedApi=start('apps/api/src/server.mjs',{API_PORT:'4022',RATE_LIMIT_WRITES_PER_MINUTE:'3'});
 await waitFor(async()=>{try{return (await fetch('http://127.0.0.1:4022/health/live')).ok;}catch{return false;}},'limited api live');
 const statuses=[];
 for(let i=0;i<6;i++){const token=signIdentity('clerk-'+A.slug,'POST','/v1/tasks',process.env.SESSION_SECRET);const rr=await fetch('http://127.0.0.1:4022/v1/tasks',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...key(),...eh},body:JSON.stringify({...taskBody,sourceId:randomUUID()})});statuses.push(rr.status);if(rr.status===429){assert.equal(rr.headers.get('retry-after'),'5');errorShape(await json(rr));}}
 assert.deepEqual(statuses,[201,201,201,429,429,429],'fourth write within the minute is limited');
 await stop(limitedApi);
 pass('write bursts above the configured per-principal limit return 429 with Retry-After and a typed error');
 console.log('PASS P02-03 API: '+step+' groups');
}catch(error){console.error('--- api log ---\n'+apiProcess.log().split('\n').filter(l=>!l.includes('request_completed')).slice(-15).join('\n'));for(const c of children.slice(1))console.error('--- worker log ---\n'+c.log().split('\n').slice(-12).join('\n'));throw error;}
finally{
 for(const c of children)await stop(c);
 await owner.query("select set_config('lara.maintenance','teardown',false)");
 for(const id of tenants){
  await owner.query("select set_config('lara.tenant_id',$1,false)",[id]);
  for(const table of ['audit_events','audit_chain_heads','inbox_receipts','outbox_events','jobs','command_receipts','approval_decisions','approval_requests','obligations','task_comments','tasks','evidence_links','party_bank_accounts','party_roles','party','evidence','settings_versions','onboarding_checks','capability_activations','approval_policies','delegation','memberships','roles','principals','books','branches','entities']){
   if(table==='inbox_receipts')await owner.query('delete from lara.inbox_receipts where event_id in (select event_id from lara.outbox_events where tenant_id=$1)',[id]);
   else await owner.query('delete from lara.'+table+' where tenant_id=$1',[id]);
  }
  await owner.query('delete from lara.tenants where id=$1',[id]);
 }
 await Promise.all([api.end(),owner.end()]);
 await rm(bucket,{recursive:true,force:true});
}
