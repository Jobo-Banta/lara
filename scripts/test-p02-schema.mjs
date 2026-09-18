// P02-01 schema acceptance against a real PostgreSQL: tenant isolation under
// RLS, revocation versions, maker-checker, immutable approvals, evidence state
// machine, task/obligation invariants, immutable audit chain, durable operation
// tables, runtime grants and definition seeds. Test tenants are removed at the
// end through the owner maintenance branch; runtime roles cannot do that.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const owner=client(process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
const api=client(process.env.DATABASE_URL);
const worker=client(process.env.WORKER_DATABASE_URL||process.env.SUPABASE_LARA_WORKER_DATABASE_URL);
await Promise.all([owner.connect(),api.connect(),worker.connect()]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const suffix=randomBytes(4).toString('hex');
const A={id:randomUUID(),slug:'p02-test-a-'+suffix},B={id:randomUUID(),slug:'p02-test-b-'+suffix},live=randomUUID();
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=label=>console.log('PASS '+(++step)+': '+label);
try{
 // Seeds
 const published=JSON.parse(await readFile(new URL('../docs/development/contracts/permissions.json',import.meta.url),'utf8')).permissions;
 const seeded=(await owner.query('select code from lara.permission_definitions')).rows.map(r=>r.code).sort();
 assert.deepEqual(seeded,[...new Set(published)].sort());
 const templates=(await owner.query('select code,permissions from lara.role_templates')).rows;
 assert.deepEqual(templates.map(t=>t.code).sort(),['accountant','auditor','billing','clerk','controller','operations','security_admin','tax','treasury']);
 for(const t of templates)for(const p of t.permissions)assert.ok(seeded.includes(p),t.code+' uses unpublished '+p);
 assert.equal((await owner.query("select count(*)::int n from lara.capability_definitions c, unnest(c.depends_on) d where d not in (select code from lara.capability_definitions)")).rows[0].n,0);
 pass('permission codes, role templates and capability graph seeded from the reviewed contracts');

 // Tenants, principals, entities under owner with tenant context
 for(const t of [A,B]){
  await run(owner,t.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,$3,'demo')",[t.id,t.slug,'P02 schema test '+t.slug]);
  t.principal=(await run(owner,t.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Maker') returning id",[t.id,'maker-'+t.slug])).rows[0].id;
  t.checker=(await run(owner,t.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Checker') returning id",[t.id,'checker-'+t.slug])).rows[0].id;
  t.entity=(await run(owner,t.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by) values($1,$2,1,'PHP','Asia/Manila',$3,$4) returning id",[t.id,'Entity '+t.slug,hash('entity'+t.slug),t.principal])).rows[0].id;
  t.role=(await run(owner,t.id,"insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'clerk','Clerk',(select permissions from lara.role_templates where code='clerk'),'approved',$2,$3) returning id",[t.id,hash('role'+t.slug),t.principal])).rows[0].id;
  t.task=(await run(owner,t.id,"insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,reason,created_by) values($1,$2,'missing_evidence','party',$3,'Evidence required',$4) returning id",[t.id,t.entity,randomUUID(),t.principal])).rows[0].id;
  t.party=(await run(owner,t.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,content_hash,created_by) values($1,$2,$3,'unknown',$4,$5) returning id",[t.id,t.entity,'Party '+t.slug,hash('party'+t.slug),t.principal])).rows[0].id;
 }
 assert.equal((await run(owner,'',"select count(*)::int n from lara.tasks where tenant_id in ($1,$2)",[A.id,B.id])).rows[0].n,0);
 pass('table owner without tenant context sees no tenant rows (no owner-role RLS bypass)');

 // Runtime isolation P02-T01 basis
 const apiA=await run(api,A.id,'select id,tenant_id from lara.tasks order by created_at');
 assert.deepEqual(apiA.rows.map(r=>r.tenant_id),[A.id]);
 assert.equal((await run(api,A.id,'select count(*)::int n from lara.party')).rows[0].n,1);
 assert.equal((await run(api,A.id,'select count(*)::int n from lara.entities where id=$1',[B.entity])).rows[0].n,0);
 assert.equal((await run(api,A.id,"update lara.tasks set reason='tampered' where id=$1",[B.task])).rowCount,0);
 await rejects(run(api,A.id,"insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,reason,created_by) values($1,$2,'x','party',$3,'cross tenant write',$4)",[B.id,B.entity,randomUUID(),A.principal]),/row-level security/,'cross-tenant insert');
 assert.equal((await run(api,'',"select count(*)::int n from lara.tasks")).rows[0].n,0);
 assert.equal((await run(api,'',"select count(*)::int n from lara.tenants")).rows[0].n,0);
 pass('runtime role reads, updates and inserts are confined to the bound tenant; no context yields no rows');

 // Revocation version P02-T02 basis
 const rv=async()=>(await run(owner,A.id,'select revocation_version from lara.principals where id=$1',[A.principal])).rows[0].revocation_version;
 assert.equal(await rv(),'1');
 const membership=(await run(api,A.id,"insert into lara.memberships(tenant_id,principal_id,entity_id,role_id,created_by) values($1,$2,$3,$4,$5) returning id,version",[A.id,A.principal,A.entity,A.role,A.checker])).rows[0];
 assert.equal(await rv(),'2');
 const revoked=await run(api,A.id,"update lara.memberships set status='revoked',revoked_reason='Left the company',version=999 where id=$1 and version=$2 returning version,updated_at>created_at as touched",[membership.id,membership.version]);
 assert.equal(revoked.rows[0].version,'2');assert.equal(revoked.rows[0].touched,true);
 assert.equal(await rv(),'3');
 assert.equal((await run(api,A.id,"update lara.memberships set revoked_reason='stale' where id=$1 and version=$2",[membership.id,membership.version])).rowCount,0);
 await rejects(run(api,A.id,"update lara.memberships set status='revoked' where id=$1",[membership.id]).then(()=>run(api,A.id,"update lara.memberships set status='revoked',revoked_reason=null where id=$1",[membership.id])),/check constraint|violates/,'revocation without reason');
 pass('membership changes advance the principal revocation version; row version is server managed and stale writes affect nothing');

 // Roles
 await rejects(run(api,A.id,"insert into lara.roles(tenant_id,code,name,permissions,content_hash,created_by) values($1,'bad','Bad','[\"ledger.destroy\"]'::jsonb,$2,$3)",[A.id,hash('bad'),A.principal]),/published permission codes/,'unknown permission');
 await rejects(run(api,A.id,"update lara.roles set permissions='[\"entity.read\",\"period.lock\"]'::jsonb where id=$1",[A.role]),/new approval/,'approved role mutation');
 pass('roles accept only published permissions and approved permission sets change only through a new approval');

 // Approval policy immutability and one active per type (P02-T03 basis)
 const policy=(await run(api,A.id,"insert into lara.approval_policies(tenant_id,entity_id,type,version_number,required_steps_json,effective_from,content_hash,created_by) values($1,$2,'journal',1,jsonb_build_array(jsonb_build_object('roleId',$3::text,'distinctActorRequired',true)),'2026-01-01',$4,$5) returning id,version",[A.id,A.entity,A.role,hash('policy1'),A.principal])).rows[0];
 await rejects(run(api,A.id,"update lara.approval_policies set status='approved',approved_by=$2 where id=$1",[policy.id,A.principal]),/check constraint|violates/,'self-approved policy');
 await run(api,A.id,"update lara.approval_policies set status='active',approved_by=$2 where id=$1",[policy.id,A.checker]);
 await rejects(run(api,A.id,"update lara.approval_policies set required_steps_json='[]'::jsonb where id=$1",[policy.id]),/immutable|check constraint/,'active policy content change');
 await rejects(run(api,A.id,"update lara.approval_policies set effective_from='2027-01-01' where id=$1",[policy.id]),/immutable/,'active policy date change');
 await rejects(run(api,A.id,"insert into lara.approval_policies(tenant_id,entity_id,type,version_number,required_steps_json,effective_from,status,approved_by,content_hash,created_by) values($1,$2,'journal',2,'[{}]','2026-02-01','active',$3,$4,$5)",[A.id,A.entity,A.checker,hash('policy2'),A.principal]),/approval_policies_one_active|duplicate key/,'second active policy');
 pass('approved approval policies are immutable, need an independent approver and are unique per active type');

 // Approval requests and decisions: maker-checker
 const request=(await run(api,A.id,"insert into lara.approval_requests(tenant_id,entity_id,resource_type,resource_id,content_version,content_hash,policy_id,policy_version,step,created_by) values($1,$2,'party',$3,1,$4,$5,1,1,$6) returning id",[A.id,A.entity,A.party,hash('party-v1'),policy.id,A.principal])).rows[0];
 await rejects(run(api,A.id,"insert into lara.approval_decisions(tenant_id,entity_id,request_id,actor_id,decision) values($1,$2,$3,$4,'approve')",[A.id,A.entity,request.id,A.principal]),/SELF_APPROVAL/,'self approval');
 await rejects(run(api,A.id,"insert into lara.approval_decisions(tenant_id,entity_id,request_id,actor_id,decision) values($1,$2,$3,$4,'reject')",[A.id,A.entity,request.id,A.checker]),/check constraint|violates/,'reject without reason');
 await rejects(run(api,A.id,"update lara.approval_requests set content_hash=$2 where id=$1",[request.id,hash('party-v2')]),/immutable/,'request content change');
 const decision=(await run(api,A.id,"insert into lara.approval_decisions(tenant_id,entity_id,request_id,actor_id,decision) values($1,$2,$3,$4,'approve') returning id",[A.id,A.entity,request.id,A.checker])).rows[0];
 await run(api,A.id,"update lara.approval_requests set status='approved' where id=$1",[request.id]);
 await rejects(run(api,A.id,"update lara.approval_requests set status='pending' where id=$1",[request.id]),/terminal/,'reopen terminal request');
 await rejects(run(api,A.id,"insert into lara.approval_decisions(tenant_id,entity_id,request_id,actor_id,decision) values($1,$2,$3,$4,'approve')",[A.id,A.entity,request.id,B.checker]),/row-level|foreign key|STATE_CONFLICT/,'decision on decided request or foreign principal');
 await rejects(run(api,A.id,"update lara.approval_decisions set decision='reject' where id=$1",[decision.id]),/permission denied|APPEND_ONLY/,'decision update');
 await rejects(run(api,A.id,"delete from lara.approval_decisions where id=$1",[decision.id]),/permission denied|APPEND_ONLY/,'decision delete');
 pass('approval decisions bind the request content, forbid the maker, need reasons for rejection and are append-only');

 // Evidence state machine P02-T05 basis
 const evidence=(await run(api,A.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,classification,created_by) values($1,$2,$3,'invoice.pdf',$4,'application/pdf',1024,'confidential',$5) returning id,status",[A.id,A.entity,'tenants/'+A.id+'/evidence/'+randomUUID(),hash('pdf'),A.principal])).rows[0];
 assert.equal(evidence.status,'quarantined');
 await rejects(run(api,A.id,"update lara.evidence set status='available' where id=$1",[evidence.id]),/cannot move from quarantined to available/,'skip scanning');
 await rejects(run(api,A.id,"update lara.evidence set status='rejected' where id=$1",[evidence.id]),/check constraint|violates/,'reject without reason');
 await rejects(run(api,A.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,classification,created_by) values($1,$2,$3,'x.exe',$4,'application/x-msdownload',10,'internal',$5)",[A.id,A.entity,'k'+randomUUID(),hash('exe'),A.principal]),/check constraint|violates/,'executable mime');
 await run(worker,A.id,"update lara.evidence set status='scanning' where id=$1",[evidence.id]);
 await rejects(run(worker,A.id,"update lara.evidence set sha256=$2 where id=$1",[evidence.id,hash('other')]),/identity is immutable/,'checksum rewrite');
 await run(worker,A.id,"update lara.evidence set status='available' where id=$1",[evidence.id]);
 await rejects(run(worker,A.id,"update lara.evidence set status='rejected',rejection_reason='late' where id=$1",[evidence.id]),/cannot move from available/,'terminal evidence');
 await rejects(run(api,A.id,"insert into lara.evidence_links(tenant_id,entity_id,evidence_id,resource_type,resource_id,resource_version,created_by) values($1,$2,$3,'party',$4,1,$5)",[A.id,A.entity,evidence.id,B.party,A.principal]).then(()=>run(api,A.id,"insert into lara.evidence_links(tenant_id,entity_id,evidence_id,resource_type,resource_id,resource_version,created_by) values($1,$2,$3,'party',$4,1,$5)",[A.id,A.entity,evidence.id,B.party,A.principal])),/duplicate key/,'duplicate evidence link');
 pass('evidence follows quarantined → scanning → available, rejects disguised executables, keeps identity immutable and links are unique');

 // Tasks P02-T04 basis
 const source=randomUUID();
 const t1=(await run(api,A.id,"insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,cause_key,reason,created_by) values($1,$2,'missing_evidence','party',$3,'tin','No supporting document',$4) returning id,version",[A.id,A.entity,source,A.principal])).rows[0];
 await rejects(run(api,A.id,"insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,cause_key,reason,created_by) values($1,$2,'missing_evidence','party',$3,'tin','Duplicate',$4)",[A.id,A.entity,source,A.principal]),/tasks_one_active_cause|duplicate key/,'duplicate active task');
 await rejects(run(api,A.id,"update lara.tasks set status='waiting_for_information',owner_id=$2 where id=$1",[t1.id,A.principal]),/check constraint|violates/,'waiting without due date');
 await rejects(run(api,A.id,"update lara.tasks set status='resolved' where id=$1",[t1.id]),/check constraint|violates/,'resolved without resolution');
 await run(api,A.id,"update lara.tasks set status='resolved',resolution='Evidence attached' where id=$1",[t1.id]);
 await run(api,A.id,"insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,cause_key,reason,created_by) values($1,$2,'missing_evidence','party',$3,'tin','Reopened after new finding',$4)",[A.id,A.entity,source,A.principal]);
 await rejects(run(api,A.id,"delete from lara.tasks where id=$1",[t1.id]),/permission denied/,'runtime task delete');
 pass('one active task per source, kind and cause; waiting and resolved states carry their required fields; runtime cannot delete');

 // Obligations
 const ob=(await run(api,A.id,"insert into lara.obligations(tenant_id,entity_id,kind,period_key,rule_version,due_at,owner_id,created_by) values($1,$2,'vat_return','2026-09','2026.1','2026-10-20T00:00:00Z',$3,$4) returning id",[A.id,A.entity,A.principal,A.principal])).rows[0];
 await rejects(run(api,A.id,"insert into lara.obligations(tenant_id,entity_id,kind,period_key,rule_version,due_at,owner_id,created_by) values($1,$2,'vat_return','2026-09','2026.2','2026-10-25T00:00:00Z',$3,$4)",[A.id,A.entity,A.principal,A.principal]),/duplicate key/,'duplicate obligation');
 await rejects(run(api,A.id,"update lara.obligations set status='completed' where id=$1",[ob.id]),/check constraint|violates/,'completion without evidence');
 await run(api,A.id,"update lara.obligations set status='completed',evidence_id=$2,completed_at=now(),completed_by=$3 where id=$1",[ob.id,evidence.id,A.principal]);
 await rejects(run(api,A.id,"update lara.obligations set rule_version='2026.2' where id=$1",[ob.id]),/retain their completion evidence/,'template change after completion');
 pass('obligations are unique per kind, period and profile; completion requires evidence and is retained');

 // Party invariants
 await rejects(run(api,A.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,content_hash,created_by) values($1,$2,'Known without id','known',$3,$4)",[A.id,A.entity,hash('k'),A.principal]),/check constraint|violates/,'known identity without tax id');
 await rejects(run(api,A.id,"delete from lara.party where id=$1",[A.party]),/permission denied/,'runtime party delete');
 pass('known party identity requires an encrypted tax id; masters cannot be deleted by the runtime');

 // Entity activation gate and capability dependencies
 await run(owner,live,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Live gate',$3)",[live,'p02-test-live-'+suffix,'live']);
 const liveEntity=(await run(owner,live,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by) values($1,'Live entity',1,'PHP','Asia/Manila',$2,$3) returning id",[live,hash('live'),A.principal])).rows[0].id;
 await rejects(run(owner,live,"update lara.entities set status='active' where id=$1",[liveEntity]),/RULE_PROFILE_NOT_APPROVED/,'live activation without profile');
 await run(owner,live,"insert into lara.onboarding_checks(tenant_id,entity_id,check_code,created_by) values($1,$2,'retention_policy',$3)",[live,liveEntity,A.principal]);
 await rejects(run(owner,live,"update lara.entities set status='active',registration_profile_id=$2 where id=$1",[liveEntity,randomUUID()]),/onboarding checks must pass/,'live activation with pending check');
 await run(owner,live,"update lara.onboarding_checks set status='passed' where entity_id=$1",[liveEntity]);
 await run(owner,live,"update lara.entities set status='active',registration_profile_id=$2 where id=$1",[liveEntity,randomUUID()]);
 await run(api,A.id,"update lara.entities set status='active' where id=$1",[A.entity]);
 await rejects(run(owner,live,"update lara.tenants set mode='demo' where id=$1",[live]),/immutable/,'tenant mode change');
 await rejects(run(api,A.id,"insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'general_ledger','active','p03.1',$3,now(),$4)",[A.id,A.entity,A.checker,A.principal]),/FEATURE_NOT_ENABLED.*workspace/,'ledger before workspace');
 await run(api,A.id,"insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'workspace','active','p02.1',$3,now(),$4)",[A.id,A.entity,A.checker,A.principal]);
 await rejects(run(api,A.id,"insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'general_ledger','active','p03.1',$3,now(),$4)",[A.id,A.entity,A.principal,A.principal]),/check constraint|violates/,'self-approved capability');
 pass('live entities activate only with a profile and passed onboarding checks; capabilities need active dependencies and an independent approver');

 // Audit chain
 const audit=async(action,resource)=>(await run(api,A.id,"insert into lara.audit_events(tenant_id,entity_id,actor_id,action,resource_type,resource_id,resource_version,trace_id) values($1,$2,$3,$4,'party',$5,1,$6) returning sequence,previous_hash,hash,occurred_at",[A.id,A.entity,A.principal,action,resource,'trace-'+randomUUID()])).rows[0];
 const e1=await audit('party.create',A.party),e2=await audit('party.edit',A.party),e3=await audit('party.archive',A.party);
 assert.deepEqual([e1.sequence,e2.sequence,e3.sequence],['1','2','3']);
 assert.equal(e1.previous_hash,'0'.repeat(64));assert.equal(e2.previous_hash,e1.hash);assert.equal(e3.previous_hash,e2.hash);
 const forged=await run(api,A.id,"insert into lara.audit_events(tenant_id,entity_id,actor_id,action,resource_type,trace_id,sequence,previous_hash,hash) values($1,$2,$3,'party.forge','party','t',999,$4,$4) returning sequence,previous_hash",[A.id,A.entity,A.principal,hash('forged')]);
 assert.equal(forged.rows[0].sequence,'4');assert.equal(forged.rows[0].previous_hash,e3.hash);
 const head=(await run(api,A.id,'select sequence,hash from lara.audit_chain_heads where entity_id=$1',[A.entity])).rows[0];
 assert.equal(head.sequence,'4');
 const verify=(await run(api,A.id,`select bool_and(hash = encode(sha256(convert_to(previous_hash||'|'||tenant_id::text||'|'||entity_id::text||'|'||sequence::text||'|'||coalesce(actor_id::text,'')||'|'||coalesce(delegation_id::text,'')||'|'||action||'|'||resource_type||'|'||coalesce(resource_id::text,'')||'|'||coalesce(resource_version::text,'')||'|'||coalesce(before_ref,'')||'|'||coalesce(after_ref,'')||'|'||coalesce(reason,'')||'|'||trace_id||'|'||to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'UTF8')),'hex')) as intact, bool_and(previous_hash = prev) as linked, count(*)::int as n from (select e.*, coalesce(lag(hash) over (order by sequence), repeat('0',64)) as prev from lara.audit_events e where entity_id=$1) chain`,[A.entity])).rows[0];
 assert.deepEqual(verify,{intact:true,linked:true,n:4});
 await rejects(run(api,A.id,"update lara.audit_events set action='party.tamper' where entity_id=$1 and sequence=1",[A.entity]),/permission denied|APPEND_ONLY/,'audit update');
 await rejects(run(api,A.id,"delete from lara.audit_events where entity_id=$1",[A.entity]),/permission denied|APPEND_ONLY/,'audit delete');
 await rejects(run(owner,A.id,"delete from lara.audit_events where entity_id=$1 and sequence=4",[A.entity]),/APPEND_ONLY/,'owner audit delete without maintenance flag');
 pass('audit events form a database-assigned hash chain that recomputes intact; client sequence/hash values are ignored and rows are append-only for every role');

 // Command receipts, outbox, jobs
 const key=randomUUID();
 await run(api,A.id,"insert into lara.command_receipts(tenant_id,entity_id,actor_id,operation,idempotency_key,request_hash) values($1,$2,$3,'post_parties',$4,$5)",[A.id,A.entity,A.principal,key,hash('req')]);
 await rejects(run(api,A.id,"insert into lara.command_receipts(tenant_id,entity_id,actor_id,operation,idempotency_key,request_hash) values($1,$2,$3,'post_parties',$4,$5)",[A.id,A.entity,A.principal,key,hash('other')]),/duplicate key/,'duplicate scoped key');
 await run(api,A.id,"update lara.command_receipts set status='committed',resource_type='party',resource_id=$2,completed_at=now(),response_json='{}' where idempotency_key=$1",[key,A.party]);
 await rejects(run(api,A.id,"update lara.command_receipts set response_json='{\"tampered\":true}' where idempotency_key=$1",[key]),/final/,'rewrite committed receipt');
 const event=(await run(api,A.id,"insert into lara.outbox_events(tenant_id,entity_id,aggregate_type,aggregate_id,aggregate_version,event_type,payload) values($1,$2,'party',$3,1,'party.created.v1',jsonb_build_object('partyId',$4::text)) returning event_id",[A.id,A.entity,A.party,A.party])).rows[0];
 await rejects(run(api,A.id,"insert into lara.outbox_events(tenant_id,entity_id,aggregate_type,aggregate_id,aggregate_version,event_type,payload) values($1,$2,'party',$3,1,'party.created.v1','{}')",[A.id,A.entity,A.party]),/duplicate key/,'duplicate aggregate event');
 assert.equal((await run(worker,'',"select count(*)::int n from lara.outbox_events where tenant_id in ($1,$2)",[A.id,B.id])).rows[0].n,1);
 await rejects(run(worker,'',"update lara.outbox_events set payload='{}' ,published_at=now() where event_id=$1",[event.event_id]),/permission denied|APPEND_ONLY/,'payload rewrite on publish');
 await run(worker,'',"update lara.outbox_events set published_at=now() where event_id=$1",[event.event_id]);
 await rejects(run(worker,'',"update lara.outbox_events set published_at=now() where event_id=$1",[event.event_id]),/APPEND_ONLY/,'republish');
 await run(worker,'',"insert into lara.inbox_receipts(consumer,event_id) values('notifications',$1)",[event.event_id]);
 await rejects(run(worker,'',"insert into lara.inbox_receipts(consumer,event_id) values('notifications',$1)",[event.event_id]),/duplicate key/,'duplicate inbox receipt');
 const job=(await run(api,A.id,"insert into lara.jobs(tenant_id,entity_id,kind,requested_by,revocation_version) values($1,$2,'export.tasks',$3,3) returning id",[A.id,A.entity,A.principal])).rows[0];
 await rejects(run(worker,'',"update lara.jobs set state='succeeded' where id=$1",[job.id]),/cannot move from queued to succeeded/,'skip running');
 await rejects(run(worker,'',"update lara.jobs set state='running' where id=$1",[job.id]),/check constraint|violates/,'running without lease');
 const claimed=await run(worker,'',"update lara.jobs set state='running',lease_owner='worker-1',lease_until=now()+interval '60 seconds',attempt=attempt+1 where id=(select id from lara.jobs where state in ('queued','retry_wait') and run_after<=now() and tenant_id=$1 order by run_after,id for update skip locked limit 1) returning id",[A.id]);
 assert.equal(claimed.rows[0].id,job.id);
 assert.equal((await run(api,B.id,"select count(*)::int n from lara.jobs where id=$1",[job.id])).rows[0].n,0);
 pass('command receipts are unique per scope and final once committed; outbox is publish-only with unique aggregate versions; inbox receipts are unique; jobs follow the published transitions and workers claim across tenants with SKIP LOCKED while runtime tenants stay isolated');

 // Audit reader is read-only
 const reader=process.env.SUPABASE_LARA_AUDIT_READER_DATABASE_URL||process.env.AUDIT_READER_DATABASE_URL;
 if(reader){const ro=client(reader);await ro.connect();try{assert.equal((await run(ro,A.id,'select count(*)::int n from lara.audit_events where entity_id=$1',[A.entity])).rows[0].n,4);await rejects(run(ro,A.id,"insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,reason,created_by) values($1,$2,'x','party',$3,'r',$4)",[A.id,A.entity,randomUUID(),A.principal]),/permission denied/,'reader write');}finally{await ro.end();}pass('audit reader sees scoped audit events and cannot write');}
 console.log('PASS P02-01 schema: '+step+' groups against '+(await owner.query('select version()')).rows[0].version.split(' on ')[0]);
}finally{
 await owner.query("select set_config('lara.maintenance','teardown',false)");
 for(const id of [A.id,B.id,live]){
  await owner.query("select set_config('lara.tenant_id',$1,false)",[id]);
  for(const table of ['audit_events','audit_chain_heads','inbox_receipts','outbox_events','jobs','command_receipts','approval_decisions','approval_requests','obligations','task_comments','tasks','evidence_links','party_bank_accounts','party_roles','party','evidence','settings_versions','onboarding_checks','capability_activations','approval_policies','delegation','memberships','roles','principals','books','branches','entities']){
   if(table==='inbox_receipts')await owner.query('delete from lara.inbox_receipts where event_id in (select event_id from lara.outbox_events where tenant_id=$1)',[id]);
   else await owner.query('delete from lara.'+table+' where tenant_id=$1',[id]);
  }
  await owner.query('delete from lara.tenants where id=$1',[id]);
 }
 await Promise.all([owner.end(),api.end(),worker.end()]);
}
