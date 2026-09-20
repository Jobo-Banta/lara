// P07-01 compliance schema acceptance against real PostgreSQL through the
// runtime role: regulatory profiles follow draft → approved → active with
// separate author, approver and activator and one active per jurisdiction;
// artifacts are one approved per profile and code and immutable once
// approved; return runs freeze their content and lines once approved; filing
// records are append-only; transmission payloads are immutable, accepted
// transmissions final and attempts append-only; registration cases need the
// decision reference and evidence; row-level security isolates every table.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
const api=client(process.env.DATABASE_URL);
const workerURL=process.env.WORKER_DATABASE_URL||process.env.SUPABASE_LARA_WORKER_DATABASE_URL;const worker=workerURL?client(workerURL):null;
await Promise.all([owner.connect(),api.connect(),worker?.connect()]);
const hash=v=>createHash('sha256').update(v).digest('hex');
const suffix=randomBytes(4).toString('hex');
const T={id:randomUUID(),slug:'p02-test-comp-'+suffix};
const other={id:randomUUID(),slug:'p02-test-comp-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Compliance schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Preparer') returning id",[T.id,'preparer-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Approver') returning id",[T.id,'approver-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Compliance entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'mapping.csv',$4,'text/csv',10,'available','internal',$5) returning id",[T.id,entity,'k-'+suffix,hash('csv'),principal])).rows[0].id;
 pass('fixture tenant with entity, branch, book, two principals and evidence');

 // Regulatory profiles
 const profile=async(over={})=>(await run(api,T.id,"insert into lara.regulatory_profiles(tenant_id,entity_id,jurisdiction,version_number,coverage,valid_from,source_hash,evidence_ids,created_by) values($1,$2,'PH',$3,'[\"2550Q\"]','2026-01-01',$4,$5,$6) returning id",[T.id,entity,over.version||1,hash('p'+(over.version||1)),JSON.stringify([evidence]),principal])).rows[0].id;
 const p1=await profile();
 await rejects(profile(),/duplicate key/,'same jurisdiction and version twice');
 await rejects(run(api,T.id,"insert into lara.regulatory_profiles(tenant_id,entity_id,jurisdiction,version_number,coverage,valid_from,source_hash,evidence_ids,created_by) values($1,$2,'PH',9,'[]','2026-01-01',$3,'[]',$4)",[T.id,entity,hash('x'),principal]),/check constraint|violates/,'profile without evidence');
 await rejects(run(api,T.id,"update lara.regulatory_profiles set status='active',activated_by=$2,activated_at=now() where id=$1",[p1,approver]),/cannot move from draft/,'draft straight to active');
 await rejects(run(api,T.id,"update lara.regulatory_profiles set status='approved',approved_by=$2 where id=$1",[p1,principal]),/check constraint|violates/,'author approving');
 await run(api,T.id,"update lara.regulatory_profiles set status='approved',approved_by=$2 where id=$1",[p1,approver]);
 await rejects(run(api,T.id,"update lara.regulatory_profiles set coverage='[]' where id=$1",[p1]),/immutable/,'approved coverage edited');
 await rejects(run(api,T.id,"update lara.regulatory_profiles set status='active',activated_by=$2,activated_at=now() where id=$1",[p1,principal]),/SELF_APPROVAL/,'author activating');
 await run(api,T.id,"update lara.regulatory_profiles set status='active',activated_by=$2,activated_at=now() where id=$1",[p1,approver]);
 const p2=await profile({version:2});
 await run(api,T.id,"update lara.regulatory_profiles set status='approved',approved_by=$2 where id=$1",[p2,approver]);
 await rejects(run(api,T.id,"update lara.regulatory_profiles set status='active',activated_by=$2,activated_at=now() where id=$1",[p2,approver]),/regulatory_profiles_one_active|duplicate key/,'two active profiles per jurisdiction');
 pass('regulatory profiles need evidence, follow draft → approved → active with separate author, approver and activator, are immutable once approved and allow one active version per jurisdiction');

 // Artifacts
 const artifact=async(over={})=>(await run(api,T.id,"insert into lara.schema_artifacts(tenant_id,entity_id,profile_id,artifact_type,code,version_label,hash,evidence_id,created_by) values($1,$2,$3,'form_mapping','2550Q',$4,$5,$6,$7) returning id",[T.id,entity,p1,over.label||'v1',hash(over.label||'v1'),evidence,principal])).rows[0].id;
 const a1=await artifact();
 await rejects(artifact(),/duplicate key/,'same profile, type, code and version twice');
 await rejects(run(api,T.id,"update lara.schema_artifacts set status='approved',approved_by=$2 where id=$1",[a1,principal]),/check constraint|violates/,'importer approving');
 await run(api,T.id,"update lara.schema_artifacts set status='approved',approved_by=$2 where id=$1",[a1,approver]);
 await rejects(run(api,T.id,"update lara.schema_artifacts set hash=$2 where id=$1",[a1,hash('other')]),/immutable/,'approved artifact hash edited');
 const a2=await artifact({label:'v2'});
 await rejects(run(api,T.id,"update lara.schema_artifacts set status='approved',approved_by=$2 where id=$1",[a2,approver]),/schema_artifacts_one_approved|duplicate key/,'two approved mappings for one form');
 pass('artifacts are unique per profile, type, code and version, approved by another principal, one approved per form, and immutable once approved');

 // Return runs, lines and filing
 const runId=(await run(api,T.id,"insert into lara.return_runs(tenant_id,entity_id,form_code,period_start,period_end,profile_version,data_cutoff,created_by) values($1,$2,'2550Q','2026-07-01','2026-09-30','ph-2026',now(),$3) returning id",[T.id,entity,principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.return_runs(tenant_id,entity_id,form_code,period_start,period_end,profile_version,data_cutoff,created_by) values($1,$2,'2550Q','2026-09-30','2026-07-01','ph-2026',now(),$3)",[T.id,entity,principal]),/check constraint|violates/,'period end before start');
 await rejects(run(api,T.id,"update lara.return_runs set state='approved',approved_by=$2 where id=$1",[runId,approver]),/cannot move from draft to approved|check constraint|violates/,'draft straight to approved');
 await rejects(run(api,T.id,"update lara.return_runs set state='prepared' where id=$1",[runId]),/check constraint|violates/,'prepared without a snapshot hash');
 await run(api,T.id,"insert into lara.return_lines(tenant_id,run_id,line_code,description,basis,amount,source_query_version,event_count) values($1,$2,'12A','Sales',100,12,'tax-events-1',1)",[T.id,runId]);
 await run(api,T.id,"update lara.return_runs set state='prepared',snapshot_hash=$2,prepared_by=$3 where id=$1",[runId,hash('snap'),principal]);
 await rejects(run(api,T.id,"update lara.return_runs set state='approved',approved_by=$2 where id=$1",[runId,principal]),/check constraint|violates/,'preparer approving');
 await run(api,T.id,"update lara.return_runs set state='approved',approved_by=$2 where id=$1",[runId,approver]);
 await rejects(run(api,T.id,"update lara.return_runs set snapshot_hash=$2 where id=$1",[runId,hash('other')]),/immutable/,'approved snapshot edited');
 await rejects(run(api,T.id,"delete from lara.return_lines where run_id=$1",[runId]),/frozen/,'lines of an approved return deleted');
 await rejects(run(api,T.id,"insert into lara.return_lines(tenant_id,run_id,line_code,description,basis,amount,source_query_version) values($1,$2,'12B','More',1,1,'x')",[T.id,runId]),/frozen/,'lines added to an approved return');
 await rejects(run(api,T.id,"insert into lara.filing_records(tenant_id,run_id,external_reference,filed_at,evidence_ids,recorded_by) values($1,$2,'ACK',now(),'[]',$3)",[T.id,runId,principal]),/check constraint|violates/,'filing without evidence');
 await run(api,T.id,"insert into lara.filing_records(tenant_id,run_id,external_reference,filed_at,evidence_ids,recorded_by) values($1,$2,'ACK',now(),$3,$4)",[T.id,runId,JSON.stringify([evidence]),principal]);
 await rejects(run(api,T.id,"insert into lara.filing_records(tenant_id,run_id,external_reference,filed_at,evidence_ids,recorded_by) values($1,$2,'ACK2',now(),$3,$4)",[T.id,runId,JSON.stringify([evidence]),principal]),/duplicate key/,'two filings for one run');
 await rejects(run(api,T.id,"update lara.filing_records set external_reference='X' where run_id=$1",[runId]),/permission denied|APPEND_ONLY/,'filing record edited');
 await run(api,T.id,"update lara.return_runs set state='filed' where id=$1",[runId]);
 await rejects(run(api,T.id,"update lara.return_runs set state='draft' where id=$1",[runId]),/cannot move from filed/,'filed return reopened');
 pass('return runs prepare with a snapshot hash, are approved by another principal, freeze their content and lines, file once with evidence and never reopen');

 // Transmissions
 const doc=(await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,document_date,accounting_date,currency,rule_profile_version,payload_hash,created_by) values($1,$2,$3,'invoice',$4,'2026-09-18','2026-09-18','PHP','x',$5,$6) returning id",[T.id,entity,book,branch,hash('doc'),principal])).rows[0].id;
 const job=async(version=1)=>(await run(api,T.id,"insert into lara.transmission_jobs(tenant_id,entity_id,document_id,destination,payload_version,payload_hash,payload_json,profile_version,created_by) values($1,$2,$3,'fixture',$4,$5,'{\"a\":1}','c-1',$6) returning id",[T.id,entity,doc,version,hash('pl'+version),principal])).rows[0].id;
 const j1=await job();
 await rejects(job(),/duplicate key/,'same document, payload version and destination twice');
 await rejects(run(api,T.id,"update lara.transmission_jobs set payload_json='{\"a\":2}' where id=$1",[j1]),/immutable/,'payload edited');
 await rejects(run(api,T.id,"update lara.transmission_jobs set state='accepted' where id=$1",[j1]),/cannot move from queued to accepted|check constraint|violates/,'queued straight to accepted');
 await run(api,T.id,"update lara.transmission_jobs set state='sending' where id=$1",[j1]);
 await rejects(run(api,T.id,"update lara.transmission_jobs set state='rejected' where id=$1",[j1]),/check constraint|violates/,'rejected without a class');
 await run(api,T.id,"insert into lara.transmission_attempts(tenant_id,job_id,attempt,request_hash,outcome) values($1,$2,1,$3,'unknown')",[T.id,j1,hash('req')]);
 await rejects(run(api,T.id,"insert into lara.transmission_attempts(tenant_id,job_id,attempt,request_hash,outcome) values($1,$2,1,$3,'accepted')",[T.id,j1,hash('req')]),/duplicate key/,'same attempt number twice');
 await rejects(run(api,T.id,"update lara.transmission_attempts set outcome='accepted' where job_id=$1",[j1]),/permission denied|APPEND_ONLY/,'attempt edited');
 await run(api,T.id,"update lara.transmission_jobs set state='unknown' where id=$1",[j1]);
 await run(api,T.id,"update lara.transmission_jobs set state='accepted',remote_id='FX-1' where id=$1",[j1]);
 await rejects(run(api,T.id,"update lara.transmission_jobs set state='sending' where id=$1",[j1]),/final/,'accepted transmission resent');
 pass('transmissions are one per document, payload version and destination with immutable payloads, follow queued → sending → unknown → accepted, keep append-only attempts and are final once accepted');

 // Registration cases
 const c=(await run(api,T.id,"insert into lara.registration_cases(tenant_id,entity_id,authority,scope,created_by) values($1,$2,'BIR','2026',$3) returning id",[T.id,entity,principal])).rows[0].id;
 await rejects(run(api,T.id,"update lara.registration_cases set status='approved' where id=$1",[c]),/cannot move from open|check constraint|violates/,'open straight to approved');
 await rejects(run(api,T.id,"update lara.registration_cases set status='pack_generated' where id=$1",[c]),/check constraint|violates/,'pack generated without evidence');
 await run(api,T.id,"update lara.registration_cases set status='pack_generated',pack_evidence_id=$2,pack_hash=$3 where id=$1",[c,evidence,hash('pack')]);
 await run(api,T.id,"update lara.registration_cases set status='submitted',submitted_at=now() where id=$1",[c]);
 await rejects(run(api,T.id,"update lara.registration_cases set status='approved' where id=$1",[c]),/check constraint|violates/,'approved without the decision reference and evidence');
 await run(api,T.id,"update lara.registration_cases set status='approved',decision_reference='COR-1',decision_evidence_id=$2,decided_at=now() where id=$1",[c,evidence]);
 await rejects(run(api,T.id,"update lara.registration_cases set status='submitted' where id=$1",[c]),/terminal in state approved/,'decided case reopened');
 pass('registration cases need pack evidence before submission and the decision reference and evidence before approval, then stay decided');

 if(worker){
  await rejects(run(worker,T.id,"insert into lara.return_runs(tenant_id,entity_id,form_code,period_start,period_end,profile_version,data_cutoff,created_by) values($1,$2,'X','2026-07-01','2026-09-30','v',now(),$3)",[T.id,entity,principal]),/permission denied/,'worker creating returns');
  await run(worker,T.id,"update lara.transmission_jobs set attempt_count=attempt_count where id=$1",[j1]);
  pass('the worker updates transmissions but cannot create returns');
 }

 for(const table of ['regulatory_profiles','schema_artifacts','return_runs','return_lines','return_source_links','filing_records','transmission_jobs','transmission_attempts','registration_cases'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.transmission_jobs')).rows[0].n,0,'transmissions visible without a tenant');
 await rejects(run(api,other.id,"insert into lara.registration_cases(tenant_id,entity_id,authority,scope,created_by) values($1,$2,'X','y',$3)",[T.id,entity,principal]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['regulatory_profiles','return_runs','transmission_jobs','registration_cases'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security isolates tenants on every compliance table and the runtime role cannot delete compliance records');
 console.log('P07-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end(),worker?.end()]);
}
