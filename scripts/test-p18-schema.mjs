// P18 extensibility schema acceptance against real PostgreSQL through the
// runtime role: the four capabilities and permissions seeded; report
// definitions versioned per name, published by another principal and
// immutable once published, runs append-only; custom fields unique per
// resource and key with a cf_ key; rule proposals assessed only with an
// impact, approved only by another principal when the impact passed;
// tool grants with allowlisted tools only, never widened once approved,
// runs append-only; pack versions unique per pack and version, one
// installed per pack, manifest frozen; row-level security isolates.
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
const T={id:randomUUID(),slug:'p02-test-ext-'+suffix},other={id:randomUUID(),slug:'p02-test-ext-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 assert.deepEqual((await run(api,null,"select code from lara.capability_definitions where phase like 'P18%' order by code")).rows.map(r=>r.code),['client_tools','industry_packs','report_authoring','rule_proposals']);
 assert.equal((await run(api,null,"select count(*)::int n from lara.permission_definitions where code in ('report_definition.run','custom_field.publish','tool.execute','pack.read')")).rows[0].n,4);
 pass('the four P18 capabilities and the new permissions are seeded');
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Extensibility schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const author=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Author') returning id",[T.id,'ea-'+suffix])).rows[0].id;
 const reviewer=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Reviewer') returning id",[T.id,'er-'+suffix])).rows[0].id;
 const clientP=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Client bot') returning id",[T.id,'ec-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Ext entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),author])).rows[0].id;
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'issuance.pdf',$4,'application/pdf',10,'available','internal',$5) returning id",[T.id,entity,'k-'+suffix,hash('i'),author])).rows[0].id;
 const ev=JSON.stringify([evidence]);

 const rdSql="insert into lara.report_definitions(tenant_id,entity_id,name,version_number,metric_ids,ast,content_hash,created_by) values($1,$2,'Sales by month',$3,array['revenue'],'{\"version\":\"ast-1\"}',$4,$5) returning id";
 const rd=(await run(api,T.id,rdSql,[T.id,entity,1,hash('r1'),author])).rows[0].id;
 await rejects(run(api,T.id,rdSql,[T.id,entity,1,hash('r2'),author]),/duplicate key/,'name and version twice');
 await rejects(run(api,T.id,"update lara.report_definitions set state='published',published_by=$2,published_at=now() where id=$1",[rd,author]),/check constraint|violates/,'published by its author');
 await run(api,T.id,"update lara.report_definitions set state='published',published_by=$2,published_at=now() where id=$1",[rd,reviewer]);
 await rejects(run(api,T.id,"update lara.report_definitions set ast='{\"version\":\"ast-1\",\"x\":1}',content_hash=$2 where id=$1",[rd,hash('r9')]),/immutable/,'published definition changed');
 const rr=(await run(api,T.id,"insert into lara.report_runs(tenant_id,entity_id,definition_id,row_count,cost,checksum,payload,scope_entity_ids,created_by) values($1,$2,$3,0,1,$4,'{}',$5,$6) returning id",[T.id,entity,rd,hash('run'),[entity],author])).rows[0].id;
 await rejects(run(api,T.id,"update lara.report_runs set row_count=5 where id=$1",[rr]),/append-only|APPEND_ONLY|permission denied/,'runs are append-only');
 const cfSql="insert into lara.custom_fields(tenant_id,entity_id,resource_type,key,label,field_type,content_hash,created_by) values($1,$2,'party',$3,'Region','text',$4,$5) returning id";
 const cf=(await run(api,T.id,cfSql,[T.id,entity,'cf_region',hash('c1'),author])).rows[0].id;
 await rejects(run(api,T.id,cfSql,[T.id,entity,'cf_region',hash('c2'),author]),/duplicate key/,'field key twice');
 await rejects(run(api,T.id,cfSql,[T.id,entity,'tin',hash('c3'),author]),/check constraint|violates/,'keys carry the cf_ prefix');
 await rejects(run(api,T.id,"update lara.custom_fields set state='published',published_by=$2,published_at=now() where id=$1",[cf,author]),/check constraint|violates/,'field published by its author');
 pass('report definitions are versioned per name, published by another principal and immutable once published, runs append-only; custom fields are unique per resource and key with the cf_ prefix and published by another principal');

 const rpSql="insert into lara.rule_proposals(tenant_id,entity_id,source_evidence_ids,affected_profile_ids,golden_case_ids,content_hash,created_by) values($1,$2,$3,$4,'[\"AC-01\"]',$5,$6) returning id";
 const rp=(await run(api,T.id,rpSql,[T.id,entity,ev,JSON.stringify([randomUUID()]),hash('p1'),author])).rows[0].id;
 await rejects(run(api,T.id,rpSql,[T.id,entity,'[]',JSON.stringify([randomUUID()]),hash('p2'),author]),/check constraint|violates/,'proposal without source evidence');
 await rejects(run(api,T.id,"update lara.rule_proposals set state='assessed' where id=$1",[rp]),/check constraint|violates/,'assessed without an impact');
 await run(api,T.id,"update lara.rule_proposals set state='assessed',impact='{}',impact_hash=$2,impact_passed=false where id=$1",[rp,hash('i1')]);
 await rejects(run(api,T.id,"update lara.rule_proposals set state='approved',approved_by=$2,approved_at=now() where id=$1",[rp,reviewer]),/check constraint|violates/,'approved while the impact failed');
 await run(api,T.id,"update lara.rule_proposals set impact_passed=true where id=$1",[rp]);
 await rejects(run(api,T.id,"update lara.rule_proposals set state='approved',approved_by=$2,approved_at=now() where id=$1",[rp,author]),/check constraint|violates/,'approved by the proposer');
 await run(api,T.id,"update lara.rule_proposals set state='approved',approved_by=$2,approved_at=now() where id=$1",[rp,reviewer]);
 await rejects(run(api,T.id,"update lara.rule_proposals set state='draft' where id=$1",[rp]),/immutable/,'approved proposal reopened');
 pass('proposals need source evidence, are assessed only with an impact, approved only by another principal when the impact passed, and are immutable once approved');

 const tgSql="insert into lara.tool_grants(tenant_id,entity_id,client_id,tools,entity_ids,expires_at,content_hash,created_by) values($1,$2,$3,$4,$5,now()+interval '30 days',$6,$7) returning id";
 const tg=(await run(api,T.id,tgSql,[T.id,entity,clientP,['read_report'],[entity],hash('g1'),author])).rows[0].id;
 await rejects(run(api,T.id,tgSql,[T.id,entity,clientP,['approve_journal'],[entity],hash('g2'),author]),/check constraint|violates/,'tools outside the allowlist');
 await rejects(run(api,T.id,"update lara.tool_grants set state='approved',approved_by=$2,approved_at=now() where id=$1",[tg,author]),/check constraint|violates/,'grant approved by its drafter');
 await run(api,T.id,"update lara.tool_grants set state='approved',approved_by=$2,approved_at=now() where id=$1",[tg,reviewer]);
 await rejects(run(api,T.id,"update lara.tool_grants set tools=array['read_report','propose_draft'] where id=$1",[tg]),/never widens/,'approved grant widened');
 await rejects(run(api,T.id,"update lara.tool_grants set expires_at=now()+interval '60 days' where id=$1",[tg]),/never widens/,'approved grant extended');
 const tr=(await run(api,T.id,"insert into lara.tool_runs(tenant_id,entity_id,grant_id,tool,request_hash,outcome,reason,created_by) values($1,$2,$3,'approve_journal',$4,'denied','not a client tool',$5) returning id",[T.id,entity,tg,hash('q'),clientP])).rows[0].id;
 await rejects(run(api,T.id,"update lara.tool_runs set outcome='served' where id=$1",[tr]),/append-only|APPEND_ONLY|permission denied/,'runs are append-only');
 await run(api,T.id,"update lara.tool_grants set state='revoked',revoked_reason='done' where id=$1",[tg]);
 await rejects(run(api,T.id,"update lara.tool_grants set state='approved' where id=$1",[tg]),/final/,'revoked grant reopened');
 pass('tool grants name allowlisted tools only, are approved by another principal, never widen or extend once approved, runs are append-only, revoked grants are final');

 const pvSql="insert into lara.pack_versions(tenant_id,entity_id,pack_id,version,manifest,manifest_hash,evidence_ids,created_by) values($1,$2,'retail-ph',$3,'{}',$4,$5,$6) returning id";
 const pv1=(await run(api,T.id,pvSql,[T.id,entity,'1.0.0',hash('m1'),ev,author])).rows[0].id;
 await rejects(run(api,T.id,pvSql,[T.id,entity,'1.0.0',hash('m1'),ev,author]),/duplicate key/,'pack version twice');
 await rejects(run(api,T.id,pvSql,[T.id,entity,'2',hash('m2'),ev,author]),/check constraint|violates/,'version not semantic');
 await run(api,T.id,"update lara.pack_versions set state='installed',snapshot='{\"settings\":{}}' where id=$1",[pv1]);
 await rejects(run(api,T.id,"update lara.pack_versions set manifest_hash=$2 where id=$1",[pv1,hash('m9')]),/keeps its manifest/,'manifest changed');
 const pv2=(await run(api,T.id,pvSql,[T.id,entity,'1.1.0',hash('m3'),ev,author])).rows[0].id;
 await rejects(run(api,T.id,"update lara.pack_versions set state='installed' where id=$1",[pv2]),/duplicate key/,'two installed versions of one pack');
 await run(api,T.id,"update lara.pack_versions set state='superseded' where id=$1",[pv1]);
 await run(api,T.id,"update lara.pack_versions set state='installed' where id=$1",[pv2]);
 await run(api,T.id,"update lara.pack_versions set state='rolled_back' where id=$1",[pv2]);
 await run(api,T.id,"update lara.pack_versions set state='installed' where id=$1",[pv1]);
 await rejects(run(api,T.id,"update lara.pack_versions set state='installed' where id=$1",[pv2]),/final/,'rolled back version reinstalled');
 pass('pack versions are unique per pack and semantic version, one installed per pack, the manifest frozen, a superseded version reinstated by rollback and a rolled-back version final');

 for(const table of ['report_definitions','report_runs','custom_fields','rule_proposals','tool_grants','tool_runs','pack_versions'])assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 await rejects(run(api,other.id,cfSql,[T.id,entity,'cf_intruder',hash('c9'),author]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['report_definitions','rule_proposals','tool_grants','pack_versions'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security keeps extensibility records in their tenant; the runtime role cannot delete them');
 console.log('P18-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
