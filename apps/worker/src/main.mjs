// Worker: heartbeat plus the durable job loop. Jobs are claimed with
// SKIP LOCKED under a 60 second lease renewed every 20 seconds; failures
// retry at 1s/5s/30s/2m/10m and then dead-letter with an owned task. Every
// handler rechecks the requesting principal's revocation version before it
// touches tenant data and runs inside a tenant-bound transaction.
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {loadLocalEnv} from '../../../scripts/local-env.mjs';
import {connectionOptions} from '../../../packages/database/src/connection.mjs';
import {DomainError,inTransaction,audit,identity,evidence,ledger,sales,treasury,compliance,fi,inventory,assets,assistant,aiProviderFromEnv,portals,messagingProviderFromEnv} from '../../../packages/domain/src/index.mjs';
import {evidenceStoreFromEnv,scannerFromEnv} from '../../../packages/domain/src/adapters.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../../api/package.json',import.meta.url))('pg');
const url=process.env.WORKER_DATABASE_URL||process.env.SUPABASE_LARA_WORKER_DATABASE_URL;
if(!url)throw Error('Worker runtime connection required');
const owner='worker-'+process.pid+'-'+Math.random().toString(36).slice(2,8);
const retrySeconds=[1,5,30,120,600];
const log=(event,extra={})=>console.log(JSON.stringify({service:'worker',event,time:new Date().toISOString(),...extra}));
const warn=(event,extra={})=>console.error(JSON.stringify({service:'worker',event,severity:'error',time:new Date().toISOString(),...extra}));
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
let store,scanner,transport,aiProvider,mailProvider;
try{store=evidenceStoreFromEnv();scanner=scannerFromEnv();transport=compliance.transportFromEnv(process.env,store);aiProvider=aiProviderFromEnv(process.env);mailProvider=messagingProviderFromEnv(process.env,store);}catch(e){warn('adapter_unavailable',{message:e.message});process.exit(1);}

const client=()=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:5000,query_timeout:30000});

export const handlers={
 // Scan the staged object; the domain records the outcome and disposes infected content.
 'evidence.scan':async(tx,ctx,job)=>{const r=await evidence.recordScan(tx,ctx,job.entity_id,job.payload_ref.evidenceId,scanner,store);return {resourceType:'evidence',resourceId:r.id,state:r.state};},
 // Scoped export: recheck authorization, snapshot the authorized rows at the
 // recorded cutoff, write an immutable manifest with checksum as evidence.
 'export.tasks':(tx,ctx,job)=>exportRows(tx,ctx,job,'tasks','select id,kind,source_type,source_id,owner_id,due_at,status,severity,reason,created_at,updated_at,version from lara.tasks where tenant_id=$1 and entity_id=$2 and created_at<=$3 order by created_at,id'),
 'export.masters':(tx,ctx,job)=>exportRows(tx,ctx,job,'masters','select p.id,p.legal_name,p.identity_status,p.status,p.created_at,p.version,(select string_agg(role,\';\' order by role) from lara.party_roles r where r.tenant_id=p.tenant_id and r.party_id=p.id) as roles from lara.party p where p.tenant_id=$1 and p.entity_id=$2 and p.created_at<=$3 order by p.created_at,p.id'),
 // Ledger report: snapshot with checksum, rendered file stored as restricted evidence.
 'report.generate':async(tx,ctx,job)=>{
  const current=await identity.assertJobStillAuthorized(tx,job,'report.generate');
  const actor={...current,traceId:ctx.traceId};
  const snap=await ledger.snapshotReport(tx,actor,job.entity_id,job.payload_ref,{builders:{aging:(t,c,e,input)=>sales.agingReport(t,c,e,{asOf:input.periodEnd}),ap_aging:(t,c,e,input)=>sales.agingReport(t,c,e,{asOf:input.periodEnd,side:'AP'}),bank_reconciliation:(t,c,e,input)=>treasury.reconciliationReport(t,c,e,{bankAccountId:input.dimensions?.bankAccountId,asOf:input.periodEnd}),...fi.reportBuilders,...inventory.reportBuilders,...assets.reportBuilders}});
  const format=job.payload_ref.format||'json';
  let content,mime;
  if(format==='csv'){const rows=snap.payload.lines||snap.payload.parties.flatMap(p=>p.items.map(i=>({party:p.legalName,...i})));const cols=snap.payload.lines?['code','name','category','debit','credit','balance']:['party','officialNumber','dueDate','daysPastDue','outstanding'];const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';content=Buffer.from([cols.join(','),...rows.map(l=>cols.map(c=>esc(l[c])).join(','))].join('\n')+'\n');mime='text/csv';}
  else if(format==='json'){content=Buffer.from(JSON.stringify(snap,null,1));mime='application/json';}
  else throw new DomainError('FEATURE_NOT_ENABLED','PDF reports arrive with the reporting module.');
  const sha256=createHash('sha256').update(content).digest('hex');
  const key='tenants/'+job.tenant_id+'/entities/'+job.entity_id+'/reports/'+snap.id;
  await store.put(key,content);
  const row=(await tx.query("insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,$4,$5,$6,$7,'quarantined','restricted',$8) returning id",[job.tenant_id,job.entity_id,key,snap.reportType+'-'+snap.periodKey+'-v'+snap.versionNumber+'.'+format,sha256,mime,content.length,job.requested_by])).rows[0];
  await tx.query("update lara.evidence set status='scanning' where id=$1",[row.id]);
  await tx.query("update lara.evidence set status='available' where id=$1",[row.id]);
  await audit(tx,{...ctx,principalId:job.requested_by},{entityId:job.entity_id,action:'report.generate',resourceType:'report_snapshot',resourceId:snap.id,resourceVersion:snap.versionNumber,afterRef:snap.checksum,reason:snap.reportType+' '+format});
  return {resourceType:'evidence',resourceId:row.id,state:'available',snapshotId:snap.id,checksum:snap.checksum};},
 // Invoice delivery: the mail adapter is local in this release, so the delivery is recorded as sent with a local reference; the document keeps only the projection.
 'document.deliver':async(tx,ctx,job)=>{
  await identity.assertJobStillAuthorized(tx,job,'invoice.deliver');
  const delivery=(await tx.query('select * from lara.deliveries where tenant_id=$1 and id=$2',[job.tenant_id,job.payload_ref.deliveryId])).rows[0];
  if(!delivery)throw new DomainError('NOT_FOUND','Delivery not found.');
  const reference=(process.env.MAIL_ADAPTER||'local')+':'+job.id;
  await tx.query("update lara.deliveries set state='sent',attempt=attempt+1,provider_reference=$3 where tenant_id=$1 and id=$2",[job.tenant_id,delivery.id,reference]);
  await tx.query("update lara.documents set delivery_state='sent' where tenant_id=$1 and id=$2",[job.tenant_id,delivery.document_id]);
  await audit(tx,{...ctx,principalId:job.requested_by},{entityId:job.entity_id,action:'invoice.delivered',resourceType:'delivery',resourceId:delivery.id,resourceVersion:Number(delivery.version)+1,afterRef:reference});
  return {resourceType:'delivery',resourceId:delivery.id,state:'sent',reference};},
 // Match proposals after a statement commit: deterministic candidates become proposed matches; ambiguous lines stay unmatched.
 'bank.propose_matches':async(tx,ctx,job)=>{
  const current=await identity.assertJobStillAuthorized(tx,job,'import.commit');
  const r=await treasury.proposeMatches(tx,{...current,traceId:ctx.traceId},job.entity_id,{bankAccountId:job.payload_ref.bankAccountId,batchId:job.payload_ref.batchId});
  return {resourceType:'bank_account',resourceId:job.payload_ref.bankAccountId,state:'proposed',proposed:r.proposed.length,ambiguous:r.ambiguous.length};},
 // E-invoice reporting: send once; unknown outcomes are reconciled by status query, never resent blindly.
 'einvoice.transmit':async(tx,ctx,job)=>{const current=await identity.assertJobStillAuthorized(tx,job,null);const r=await compliance.transmit(tx,{...current,traceId:ctx.traceId},job.entity_id,job.payload_ref.transmissionId,{transport,env:process.env});return {resourceType:'transmission',resourceId:r.id,state:r.state};},
 'einvoice.reconcile':async(tx,ctx,job)=>{const current=await identity.assertJobStillAuthorized(tx,job,'transmission.reconcile');const r=await compliance.reconcile(tx,{...current,traceId:ctx.traceId},job.entity_id,job.payload_ref.transmissionId,{transport});return {resourceType:'transmission',resourceId:r.id,state:r.state};},
 // Feed calendar sweep: overdue expected batches raise their close tasks (also run before every soft close and lock).
 'feed.sweep':async(tx,ctx,job)=>{const current=await identity.assertJobStillAuthorized(tx,job,null);const r=await fi.sweepExpectedBatches(tx,{...current,traceId:ctx.traceId},job.entity_id,{bookId:job.payload_ref.bookId||null});return {resourceType:'expected_batch',resourceId:job.entity_id,state:'swept',missing:r.missing,tasks:r.tasks};},
 'registration.pack':async(tx,ctx,job)=>{const current=await identity.assertJobStillAuthorized(tx,job,'registration.prepare');const r=await compliance.generateRegistrationPack(tx,{...current,traceId:ctx.traceId},job.entity_id,{authority:job.payload_ref.authority,scope:job.payload_ref.scope,store});return {resourceType:'evidence',resourceId:r.evidenceId,state:'available',caseId:r.case.id,hash:r.hash};},
 // Schedule run: the requesting principal's schedule.execute authority is rechecked; lines post once, recurring kinds draft, a closed period raises a task.
 'schedule.run':async(tx,ctx,job)=>{const current=await identity.assertJobStillAuthorized(tx,job,'schedule.execute');const r=await assets.executeScheduleRun(tx,{...current,traceId:ctx.traceId},job.entity_id,job.payload_ref.runId,{sales,ledger});return {resourceType:'schedule_run',resourceId:r.id,state:r.state,results:r.results.length};},
 // AI run: the requester's authority is rechecked at start and at completion; the domain gates every tool and stores minimized output.
 'assistant.run':async(tx,ctx,job)=>{const r=await assistant.executeRun(tx,{tenantId:job.tenant_id,principalId:job.requested_by,traceId:ctx.traceId},job.entity_id,job.payload_ref.runId,{provider:aiProvider,store,ledger});return {resourceType:'ai_run',resourceId:r.id,state:r.state,suggestionId:r.suggestionId};},
 // Authorized message delivery (P13): once per send key; a relay failure records a failed receipt in its own transaction and retries with the same key.
 'message.send':async(tx,ctx,job)=>{const current=await identity.assertJobStillAuthorized(tx,job,'message_request.send');try{const r=await portals.deliverMessage(tx,{...current,traceId:ctx.traceId},job.entity_id,job.payload_ref.messageId,{provider:mailProvider,store});return {resourceType:'message_request',resourceId:r.id,state:r.state};}catch(e){if(e.deliveryFailure){const db=client();await db.connect();try{await inTransaction(db,{tenantId:job.tenant_id,principalId:job.requested_by,traceId:ctx.traceId},t=>portals.recordDeliveryFailure(t,{tenantId:job.tenant_id,principalId:job.requested_by,traceId:ctx.traceId},job.entity_id,job.payload_ref.messageId,e.deliveryFailure));}finally{await db.end();}}throw e;}},
 'export.evidence_manifest':(tx,ctx,job)=>exportRows(tx,ctx,job,'evidence_manifest','select id,filename,mime,byte_count,sha256,status,classification,created_at from lara.evidence where tenant_id=$1 and entity_id=$2 and created_at<=$3 order by created_at,id'),
};
async function exportRows(tx,ctx,job,kind,sql){
 const permission='evidence.export';
 const current=await identity.assertJobStillAuthorized(tx,job,permission);
 const cutoff=job.payload_ref.cutoff;
 let rows=(await tx.query(sql,[job.tenant_id,job.entity_id,cutoff])).rows;
 if(job.payload_ref.resourceIds?.length)rows=rows.filter(r=>job.payload_ref.resourceIds.includes(r.id));
 if(rows.length>10000)throw new DomainError('VALIDATION_FAILED','Export exceeds the 10,000 row limit; narrow the scope.');
 const format=job.payload_ref.format||'json';
 let content,mime,filename;
 if(format==='csv'){const cols=rows.length?Object.keys(rows[0]):[];const esc=v=>v==null?'':'"'+String(v instanceof Date?v.toISOString():v).replace(/"/g,'""')+'"';content=Buffer.from([cols.join(','),...rows.map(r=>cols.map(c=>esc(r[c])).join(','))].join('\n')+'\n');mime='text/csv';filename=kind+'-'+cutoff.slice(0,10)+'.csv';}
 else if(format==='json'){content=Buffer.from(JSON.stringify({kind,cutoff,tenantId:job.tenant_id,entityId:job.entity_id,requestedBy:job.requested_by,rows},null,1));mime='application/json';filename=kind+'-'+cutoff.slice(0,10)+'.json';}
 else throw new DomainError('FEATURE_NOT_ENABLED','PDF exports arrive with the reporting module.');
 const sha256=createHash('sha256').update(content).digest('hex');
 const key='tenants/'+job.tenant_id+'/entities/'+job.entity_id+'/exports/'+job.id;
 await store.put(key,content);
 // The export becomes restricted evidence that downloads through the
 // authenticated content endpoint, so revocation stops new downloads.
 const row=(await tx.query("insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,$4,$5,$6,$7,'quarantined','restricted',$8) returning id",[job.tenant_id,job.entity_id,key,filename,sha256,mime,content.length,job.requested_by])).rows[0];
 await tx.query("update lara.evidence set status='scanning' where id=$1",[row.id]);
 await tx.query("update lara.evidence set status='available' where id=$1",[row.id]);
 await audit(tx,{...ctx,principalId:job.requested_by},{entityId:job.entity_id,action:'export.complete',resourceType:'evidence',resourceId:row.id,resourceVersion:3,afterRef:sha256,reason:kind+' '+format+' '+rows.length+' rows'});
 return {resourceType:'evidence',resourceId:row.id,state:'available',rows:rows.length,sha256};
}

async function claim(db){
 const r=await db.query(`update lara.jobs set state='running',lease_owner=$1,lease_until=now()+interval '60 seconds',attempt=attempt+1
  where id=(select id from lara.jobs where (state in ('queued','retry_wait') and run_after<=now()) or (state='running' and lease_until<now()) order by run_after,id for update skip locked limit 1) returning *`,[owner]);
 return r.rows[0];
}
async function runJob(db,job){
 const ctx={tenantId:job.tenant_id,principalId:null,traceId:job.trace_id||'job-'+job.id};
 const heartbeat=setInterval(()=>db.query("update lara.jobs set lease_until=now()+interval '60 seconds' where id=$1 and lease_owner=$2",[job.id,owner]).catch(()=>{}),20000);
 try{
  const handler=handlers[job.kind];
  if(!handler)throw new DomainError('FEATURE_NOT_ENABLED','No handler for job kind '+job.kind);
  const result=await inTransaction(db,ctx,tx=>handler(tx,ctx,job));
  await db.query("update lara.jobs set state='succeeded',result_resource_type=$2,result_resource_id=$3,lease_owner=null,lease_until=null where id=$1 and lease_owner=$4",[job.id,result?.resourceType||null,result?.resourceId||null,owner]);
  log('job_succeeded',{job_id:job.id,kind:job.kind,attempt:job.attempt,trace_id:ctx.traceId});
 }catch(error){
  const code=error instanceof DomainError?error.code:'DEPENDENCY_UNAVAILABLE';
  // Authorization and rule failures are final; infrastructure failures retry.
  const finalCodes=['FORBIDDEN','NOT_FOUND','STATE_CONFLICT','VALIDATION_FAILED','FEATURE_NOT_ENABLED','EVIDENCE_NOT_READY'];
  if(finalCodes.includes(code)){
   await db.query("update lara.jobs set state='failed',error_code=$2,lease_owner=null,lease_until=null where id=$1 and lease_owner=$3",[job.id,code,owner]);
   warn('job_failed',{job_id:job.id,kind:job.kind,code,trace_id:ctx.traceId});
  }else if(job.attempt<=retrySeconds.length){
   await db.query("update lara.jobs set state='retry_wait',error_code=$2,run_after=now()+make_interval(secs=>$3),lease_owner=null,lease_until=null where id=$1 and lease_owner=$4",[job.id,code,retrySeconds[job.attempt-1],owner]);
   warn('job_retry_wait',{job_id:job.id,kind:job.kind,code,attempt:job.attempt,trace_id:ctx.traceId});
  }else{
   await db.query("update lara.jobs set state='dead_letter',error_code=$2,lease_owner=null,lease_until=null where id=$1 and lease_owner=$3",[job.id,code,owner]);
   if(job.entity_id)await inTransaction(db,ctx,tx=>tx.query(`insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,cause_key,severity,reason,created_by) values($1,$2,'dead_letter','job',$3,'dead_letter','high',$4,$5)
     on conflict (tenant_id,entity_id,source_type,source_id,kind,cause_key) where status not in ('resolved','cancelled') do nothing`,[job.tenant_id,job.entity_id,job.id,'Job '+job.kind+' exhausted retries: '+code,job.requested_by||'00000000-0000-0000-0000-000000000000'])).catch(e=>warn('dead_letter_task_failed',{message:e.message}));
   warn('job_dead_letter',{job_id:job.id,kind:job.kind,code,trace_id:ctx.traceId});
  }
 }finally{clearInterval(heartbeat);}
}

let lastHeartbeat=0;
while(!stopping){
 const db=client();
 try{
  await db.connect();
  if(Date.now()-lastHeartbeat>30000){await db.query('select version from public.schema_migrations limit 1');log('heartbeat',{status:'ready',owner});lastHeartbeat=Date.now();}
  let job;
  while(!stopping&&(job=await claim(db)))await runJob(db,job);
 }catch(error){warn('dependency_unavailable');}
 finally{await db.end().catch(()=>{});}
 for(let i=0;i<(process.env.WORKER_POLL_MS?1:5)&&!stopping;i++)await new Promise(r=>setTimeout(r,Number(process.env.WORKER_POLL_MS)||1000));
}
