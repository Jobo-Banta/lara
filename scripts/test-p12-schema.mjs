// P12-01 AI assistance schema acceptance against real PostgreSQL through the
// runtime role: one configuration per tenant and feature that enables only
// behind a passing, accepted evaluation of the exact model and prompt (200
// held-out items for capture) with an approver other than the configurer;
// evaluation sets and results append-only except one Finance acceptance;
// runs with enumerated features and states immutable once completed;
// suggestions one per run, the proposal frozen, reviewed once; row-level
// security isolates every table.
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
await Promise.all([owner.connect(),api.connect()]);
const hash=v=>createHash('sha256').update(v).digest('hex');
const suffix=randomBytes(4).toString('hex');
const T={id:randomUUID(),slug:'p02-test-ai-'+suffix};
const other={id:randomUUID(),slug:'p02-test-ai-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'AI schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Reviewer') returning id",[T.id,'rev-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Finance') returning id",[T.id,'fin-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Assist entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const setSql="insert into lara.evaluation_sets(tenant_id,feature,version,hash,consent_basis,item_count,created_by) values($1,$2,$3,$4,'consent',$5,$6) returning id";
 const set=(await run(api,T.id,setSql,[T.id,'capture','v1',hash('s1'),220,principal])).rows[0].id;
 await rejects(run(api,T.id,setSql,[T.id,'capture','v1',hash('s2'),220,principal]),/duplicate key/,'same set version twice');
 await rejects(run(api,T.id,setSql,[T.id,'ocr','v9',hash('s3'),10,principal]),/check constraint|violates/,'unknown feature');
 await rejects(run(api,T.id,"update lara.evaluation_sets set item_count=1 where id=$1",[set]),/APPEND_ONLY|permission denied/,'set edited');
 const resSql="insert into lara.evaluation_results(tenant_id,evaluation_set_id,feature,model_version,prompt_version,metrics,thresholds,item_count,passed,created_by) values($1,$2,'capture','m1','p1','{\"materialFieldErrorRate\":0.03}','{\"materialFieldErrorRate\":0.05}',$3,$4,$5) returning id";
 const passing=(await run(api,T.id,resSql,[T.id,set,220,true,principal])).rows[0].id;
 const small=(await run(api,T.id,resSql,[T.id,set,50,true,principal])).rows[0].id;
 const failed=(await run(api,T.id,resSql,[T.id,set,220,false,principal])).rows[0].id;
 await rejects(run(api,T.id,"update lara.evaluation_results set passed=true where id=$1",[failed]),/APPEND_ONLY|permission denied/,'result flipped');
 await rejects(run(api,T.id,"update lara.evaluation_results set accepted_by=$2 where id=$1",[passing,principal]),/check constraint|violates/,'accepted by the evaluator');
 await run(api,T.id,"update lara.evaluation_results set accepted_by=$2 where id=$1",[passing,approver]);
 await run(api,T.id,"update lara.evaluation_results set accepted_by=$2 where id=$1",[small,approver]);
 await rejects(run(api,T.id,"update lara.evaluation_results set accepted_by=$2 where id=$1",[passing,principal]),/APPEND_ONLY|check constraint|violates/,'acceptance changed');
 pass('evaluation sets are unique per feature and version and append-only; results are append-only except one acceptance by a principal other than the evaluator');

 const cfgSql="insert into lara.model_feature_configs(tenant_id,feature,enabled,model_version,prompt_version,tool_schema_version,evaluation_result_id,approved_by,created_by) values($1,$2,$3,$4,$5,'t1',$6,$7,$8) returning id";
 await rejects(run(api,T.id,cfgSql,[T.id,'capture',true,'m1','p1',passing,principal,principal]),/SELF_APPROVAL/,'enabled by the configurer');
 await rejects(run(api,T.id,cfgSql,[T.id,'capture',true,'m1','p1',null,approver,principal]),/evaluation required/,'enabled without an evaluation');
 await rejects(run(api,T.id,cfgSql,[T.id,'capture',true,'m1','p1',failed,approver,principal]),/evaluation required/,'enabled on a failed evaluation');
 await rejects(run(api,T.id,cfgSql,[T.id,'capture',true,'m1','p1',small,approver,principal]),/200 held-out/,'enabled on 50 items');
 await rejects(run(api,T.id,cfgSql,[T.id,'capture',true,'m2','p1',passing,approver,principal]),/evaluation required/,'another model than the one evaluated');
 const cfg=(await run(api,T.id,cfgSql,[T.id,'capture',true,'m1','p1',passing,approver,principal])).rows[0].id;
 await rejects(run(api,T.id,cfgSql,[T.id,'capture',false,'m1','p1',null,null,principal]),/duplicate key/,'two configurations for one feature');
 await rejects(run(api,T.id,"update lara.model_feature_configs set model_version='m2' where id=$1",[cfg]),/evaluation required/,'model changed while enabled');
 await run(api,T.id,"update lara.model_feature_configs set enabled=false where id=$1",[cfg]);
 await run(api,T.id,"update lara.model_feature_configs set model_version='m2' where id=$1",[cfg]);
 await rejects(run(api,T.id,"update lara.model_feature_configs set budget_minor=-1 where id=$1",[cfg]),/check constraint|violates/,'negative budget');
 pass('a feature configuration is one per tenant and feature, enables only behind a passing, accepted evaluation of the exact model and prompt with at least 200 capture items and an approver other than the configurer, and a model change on an enabled feature is refused');

 const runSql="insert into lara.ai_runs(tenant_id,entity_id,feature,model_version,prompt_version,tool_schema_version,input_refs,requested_by,revocation_version,created_by) values($1,$2,$3,'m1','p1','t1','{\"evidenceIds\":[],\"resourceIds\":[]}',$4,1,$4) returning id";
 const r1=(await run(api,T.id,runSql,[T.id,entity,'capture',principal])).rows[0].id;
 await rejects(run(api,T.id,runSql,[T.id,entity,'chat',principal]),/check constraint|violates/,'unknown feature');
 await rejects(run(api,T.id,"update lara.ai_runs set status='succeeded' where id=$1",[r1]),/cannot move from queued|check constraint|violates/,'queued straight to succeeded');
 await run(api,T.id,"update lara.ai_runs set status='running',started_at=now() where id=$1",[r1]);
 await rejects(run(api,T.id,"update lara.ai_runs set status='succeeded' where id=$1",[r1]),/check constraint|violates/,'completed without a completion time');
 await run(api,T.id,"update lara.ai_runs set status='succeeded',completed_at=now(),cost_minor=2 where id=$1",[r1]);
 await rejects(run(api,T.id,"update lara.ai_runs set cost_minor=0 where id=$1",[r1]),/immutable/,'completed run changed');
 const sugSql="insert into lara.ai_suggestions(tenant_id,entity_id,run_id,feature,fields_json,uncertainty,model_version,created_by) values($1,$2,$3,'capture',$4,'low','m1',$5) returning id";
 const s1=(await run(api,T.id,sugSql,[T.id,entity,r1,JSON.stringify([{path:'gross',value:'1.00',evidenceId:null,sourceLocator:'x',uncertainty:'low'}]),principal])).rows[0].id;
 await rejects(run(api,T.id,sugSql,[T.id,entity,r1,'[]',principal]),/duplicate key/,'two suggestions for one run');
 await rejects(run(api,T.id,"update lara.ai_suggestions set fields_json='[]' where id=$1",[s1]),/never changes/,'proposal edited');
 await rejects(run(api,T.id,"update lara.ai_suggestions set state='accepted' where id=$1",[s1]),/check constraint|violates/,'accepted without a reviewer');
 await rejects(run(api,T.id,"update lara.ai_suggestions set state='rejected',review_decision='reject',reviewer_id=$2,reviewed_at=now() where id=$1",[s1,approver]),/check constraint|violates/,'rejected without a reason');
 await run(api,T.id,"update lara.ai_suggestions set state='edited',review_decision='edit',reviewer_id=$2,reviewed_at=now(),field_changes='[{\"path\":\"gross\",\"value\":\"2.00\"}]' where id=$1",[s1,approver]);
 await rejects(run(api,T.id,"update lara.ai_suggestions set state='accepted' where id=$1",[s1]),/immutable/,'reviewed twice');
 pass('runs carry enumerated features and states, complete once with a completion time and are immutable afterwards; suggestions are one per run with a frozen proposal, need a reviewer, a reason to reject, and are reviewed once');

 for(const table of ['evaluation_sets','evaluation_results','model_feature_configs','ai_runs','ai_suggestions'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.ai_runs')).rows[0].n,0,'runs visible without a tenant');
 await rejects(run(api,other.id,runSql,[T.id,entity,'capture',principal]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['model_feature_configs','ai_runs','ai_suggestions','evaluation_results'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security isolates tenants on every AI table and the runtime role cannot delete configurations, runs, suggestions or evaluations');
 console.log('P12-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
