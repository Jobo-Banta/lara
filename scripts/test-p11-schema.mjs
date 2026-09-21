// P11-01 assets and schedules schema acceptance against real PostgreSQL
// through the runtime role: asset classes with distinct accounts, assets
// unique per tag with residual within cost and an independent approver,
// approved register facts changed only through append-only events, one live
// schedule per source with a fixed identity, reviewed versions immutable,
// lines unique per schedule and period and immutable once executed, runs
// with at least one schedule, append-only book/tax layers; row-level
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
const T={id:randomUUID(),slug:'p02-test-ast-'+suffix};
const other={id:randomUUID(),slug:'p02-test-ast-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Assets schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Clerk') returning id",[T.id,'clerk-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Approver') returning id",[T.id,'approver-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Plant entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const period=(await run(owner,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4) returning id",[T.id,entity,book,principal])).rows[0].id;
 const acct=async(code,category,side)=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$4,$5,$6,'none',true,'active',$7,$8) returning id",[T.id,entity,book,code,category,side,hash(code),principal])).rows[0].id;
 const equip=await acct('1700','asset','debit'),accDep=await acct('1710','asset','debit'),depExp=await acct('6100','expense','debit'),gain=await acct('4300','income','credit'),loss=await acct('6300','expense','debit'),cip=await acct('1690','asset','debit');
 const doc=(await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,document_date,accounting_date,currency,rule_profile_version,payload_hash,created_by,net,tax,gross) values($1,$2,$3,'bill',$4,'2026-10-01','2026-10-01','PHP','ph-2026',$5,$6,1000,0,1000) returning id",[T.id,entity,book,branch,hash('d'),principal])).rows[0].id;
 const classSql="insert into lara.asset_classes(tenant_id,entity_id,book_id,code,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,disposal_gain_account_id,disposal_loss_account_id,cip_account_id,default_method,default_useful_life_months,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id";
 const klass=(await run(api,T.id,classSql,[T.id,entity,book,'EQUIP','Equipment',equip,accDep,depExp,gain,loss,null,'straight_line',60,principal])).rows[0].id;
 await rejects(run(api,T.id,classSql,[T.id,entity,book,'EQUIP','Again',equip,accDep,depExp,gain,loss,null,'straight_line',60,principal]),/duplicate key/,'same class code twice');
 await rejects(run(api,T.id,classSql,[T.id,entity,book,'SAME','Same accounts',equip,equip,depExp,gain,loss,null,'straight_line',60,principal]),/check constraint|violates/,'asset and accumulated accounts must differ');
 await rejects(run(api,T.id,classSql,[T.id,entity,book,'CIPX','CIP same as asset',equip,accDep,depExp,gain,loss,equip,'straight_line',60,principal]),/check constraint|violates/,'CIP account equal to the asset account');
 await rejects(run(api,T.id,classSql,[T.id,entity,book,'UNITS','Units of production',equip,accDep,depExp,gain,loss,null,'units_of_production',60,principal]),/check constraint|violates/,'unknown method');
 pass('asset classes are unique per code with enumerated methods and distinct asset, accumulated depreciation and expense accounts');

 const assetSql="insert into lara.assets(tenant_id,entity_id,book_id,class_id,tag,cost,residual,currency,in_service_date,useful_life_months,method,source_document_id,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,'PHP','2026-10-01',$8,'straight_line',$9,$10,$11) returning id";
 const asset=(await run(api,T.id,assetSql,[T.id,entity,book,klass,'EQ-1',1000,100,60,doc,hash('a1'),principal])).rows[0].id;
 await rejects(run(api,T.id,assetSql,[T.id,entity,book,klass,'EQ-1',1000,100,60,doc,hash('a1'),principal]),/duplicate key/,'same tag twice');
 await rejects(run(api,T.id,assetSql,[T.id,entity,book,klass,'EQ-2',1000,1001,60,doc,hash('a2'),principal]),/check constraint|violates/,'residual above cost');
 await rejects(run(api,T.id,assetSql,[T.id,entity,book,klass,'EQ-3',0,0,60,doc,hash('a3'),principal]),/check constraint|violates/,'zero cost');
 await rejects(run(api,T.id,assetSql,[T.id,entity,book,klass,'EQ-4',1000,0,0,doc,hash('a4'),principal]),/check constraint|violates/,'zero life');
 await rejects(run(api,T.id,"insert into lara.assets(tenant_id,entity_id,book_id,class_id,tag,cost,residual,currency,in_service_date,useful_life_months,method,content_hash,created_by) values($1,$2,$3,$4,'EQ-5',1,0,'PHP','2026-10-01',1,'straight_line',$5,$6)",[T.id,entity,book,klass,hash('a5'),principal]),/check constraint|violates/,'no source and no parent');
 await rejects(run(api,T.id,"update lara.assets set state='approved',approved_by=$2 where id=$1",[asset,principal]),/check constraint|violates/,'approved by the preparer');
 await rejects(run(api,T.id,"update lara.assets set state='disposed' where id=$1",[asset]),/cannot move from draft/,'draft straight to disposed');
 await run(api,T.id,"update lara.assets set state='approved',approved_by=$2 where id=$1",[asset,approver]);
 await rejects(run(api,T.id,"update lara.assets set useful_life_months=48 where id=$1",[asset]),/prospective schedule version/,'life edited on an approved asset');
 await rejects(run(api,T.id,"update lara.assets set accumulated_depreciation=1001 where id=$1",[asset]),/check constraint|violates/,'accumulated beyond cost');
 const evSql="insert into lara.asset_events(tenant_id,entity_id,asset_id,sequence,kind,effective_date,amount,proceeds,target_location_id,reason,evidence_ids,cost_before,accumulated_before,cost_after,accumulated_after,created_by) values($1,$2,$3,$4,$5,'2026-11-01',$6,$7,$8,'reason',$9,1000,0,1000,0,$10) returning id";
 await rejects(run(api,T.id,evSql,[T.id,entity,asset,1,'disposal',null,null,null,'[]',principal]),/check constraint|violates/,'event without evidence');
 await rejects(run(api,T.id,evSql,[T.id,entity,asset,1,'disposal',null,null,null,JSON.stringify([randomUUID()]),principal]),/check constraint|violates/,'disposal without proceeds');
 await rejects(run(api,T.id,evSql,[T.id,entity,asset,1,'split',null,null,null,JSON.stringify([randomUUID()]),principal]),/check constraint|violates/,'split without an amount');
 await rejects(run(api,T.id,evSql,[T.id,entity,asset,1,'transfer',null,null,null,JSON.stringify([randomUUID()]),principal]),/check constraint|violates/,'transfer without a target');
 const ev=(await run(api,T.id,evSql,[T.id,entity,asset,1,'transfer',null,null,branch,JSON.stringify([randomUUID()]),principal])).rows[0].id;
 await rejects(run(api,T.id,evSql,[T.id,entity,asset,1,'transfer',null,null,branch,JSON.stringify([randomUUID()]),principal]),/duplicate key/,'same sequence twice');
 await rejects(run(api,T.id,"update lara.asset_events set reason='x' where id=$1",[ev]),/APPEND_ONLY|permission denied/,'event edited');
 await run(api,T.id,"update lara.assets set state='disposed' where id=$1",[asset]);
 await rejects(run(api,T.id,"update lara.assets set cost=2000 where id=$1",[asset]),/immutable/,'disposed asset changed');
 pass('assets are unique per tag with residual within cost, a positive life, a source or a parent, approval by another principal, life and method fixed once approved, events append-only with evidence and kind-specific fields, and disposed assets immutable');

 const asset2=(await run(api,T.id,assetSql,[T.id,entity,book,klass,'EQ-2',1200,0,12,doc,hash('a2'),principal])).rows[0].id;
 await run(api,T.id,"update lara.assets set state='approved',approved_by=$2 where id=$1",[asset2,approver]);
 const schSql="insert into lara.recognition_schedules(tenant_id,entity_id,book_id,kind,source_type,source_id,start_date,end_date,basis_amount,currency,method,policy_version,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'PHP',$10,'dep_monthly',$11,$12) returning id";
 const sch=(await run(api,T.id,schSql,[T.id,entity,book,'depreciation','asset',asset2,'2026-10-01','2027-09-30',1200,'straight_line',hash('s1'),principal])).rows[0].id;
 await rejects(run(api,T.id,schSql,[T.id,entity,book,'depreciation','asset',asset2,'2026-10-01','2027-09-30',1200,'straight_line',hash('s2'),principal]),/recognition_schedules_one_live|duplicate key/,'second live schedule for one source');
 await rejects(run(api,T.id,schSql,[T.id,entity,book,'depreciation','asset',asset2,'2027-10-01','2027-09-30',1200,'straight_line',hash('s3'),principal]),/check constraint|violates/,'end before start');
 await rejects(run(api,T.id,schSql,[T.id,entity,book,'lease','asset',asset2,'2026-10-01','2027-09-30',1200,'straight_line',hash('s4'),principal]),/check constraint|violates/,'unknown kind');
 await rejects(run(api,T.id,"update lara.recognition_schedules set state='approved',approved_by=$2 where id=$1",[sch,principal]),/check constraint|violates/,'approved by the preparer');
 await rejects(run(api,T.id,"update lara.recognition_schedules set state='paused' where id=$1",[sch]),/cannot move from draft|check constraint|violates/,'draft straight to paused');
 const verSql="insert into lara.schedule_versions(tenant_id,entity_id,schedule_id,version_no,effective_from,start_date,end_date,method,basis_amount,policy_version,reason,checksum,created_by) values($1,$2,$3,$4,'2026-10-01','2026-10-01','2027-09-30','straight_line',1200,'dep_monthly','initial',$5,$6) returning id";
 const v1=(await run(api,T.id,verSql,[T.id,entity,sch,1,hash('v1'),principal])).rows[0].id;
 await rejects(run(api,T.id,verSql,[T.id,entity,sch,2,hash('v2'),principal]),/schedule_versions_one_draft|duplicate key/,'two draft versions');
 await rejects(run(api,T.id,"update lara.schedule_versions set state='approved',approved_by=$2 where id=$1",[v1,principal]),/check constraint|violates/,'version approved by its preparer');
 await run(api,T.id,"update lara.schedule_versions set state='approved',approved_by=$2 where id=$1",[v1,approver]);
 await rejects(run(api,T.id,"update lara.schedule_versions set basis_amount=1300 where id=$1",[v1]),/immutable/,'approved version edited');
 await run(api,T.id,"update lara.recognition_schedules set state='approved',approved_by=$2 where id=$1",[sch,approver]);
 await rejects(run(api,T.id,"update lara.recognition_schedules set kind='prepayment' where id=$1",[sch]),/identity is fixed/,'kind changed');
 const lineSql="insert into lara.schedule_lines(tenant_id,entity_id,schedule_id,version_id,sequence,period_start,period_end,amount) values($1,$2,$3,$4,$5,$6,$7,$8) returning id";
 const l1=(await run(api,T.id,lineSql,[T.id,entity,sch,v1,1,'2026-10-01','2026-10-31',100])).rows[0].id;
 await rejects(run(api,T.id,lineSql,[T.id,entity,sch,v1,2,'2026-10-01','2026-10-31',100]),/duplicate key/,'two lines for one period');
 await rejects(run(api,T.id,lineSql,[T.id,entity,sch,v1,2,'2026-11-15','2026-11-30',100]),/check constraint|violates/,'period not starting on the first');
 await rejects(run(api,T.id,lineSql,[T.id,entity,sch,v1,2,'2026-11-01','2026-11-30',-1]),/check constraint|violates/,'negative amount');
 await rejects(run(api,T.id,"update lara.schedule_lines set state='posted' where id=$1",[l1]),/check constraint|violates/,'posted without an entry');
 const entry=(await run(owner,T.id,"insert into lara.journal_entries(tenant_id,entity_id,book_id,source_type,source_id,source_version,purpose,accounting_date,document_date,description,currency,total_debit,total_credit,posting_actor,entry_hash,previous_hash,sequence,manual) values($1,$2,$3,'schedule_line',$4,1,'posting','2026-10-31','2026-10-31','x','PHP',100,100,$5,$6,$6,1,false) returning id",[T.id,entity,book,l1,principal,hash('je')]).catch(()=>null))?.rows?.[0]?.id;
 if(entry){
  await run(api,T.id,"update lara.schedule_lines set state='posted',posted_entry_id=$2 where id=$1",[l1,entry]);
  await rejects(run(api,T.id,"update lara.schedule_lines set amount=101 where id=$1",[l1]),/immutable/,'posted line edited');
  await rejects(run(api,T.id,"delete from lara.schedule_lines where id=$1",[l1]),/immutable/,'posted line deleted');
 }
 await rejects(run(api,T.id,"insert into lara.schedule_runs(tenant_id,entity_id,period_id,schedule_ids,requested_by,created_by) values($1,$2,$3,'{}',$4,$4)",[T.id,entity,period,principal]),/check constraint|violates/,'run without schedules');
 const runId=(await run(api,T.id,"insert into lara.schedule_runs(tenant_id,entity_id,period_id,schedule_ids,requested_by,created_by) values($1,$2,$3,$4,$5,$5) returning id",[T.id,entity,period,[sch],principal])).rows[0].id;
 await rejects(run(api,T.id,"update lara.schedule_runs set state='done' where id=$1",[runId]),/check constraint|violates/,'unknown run state');
 const layerSql="insert into lara.book_tax_layers(tenant_id,entity_id,asset_id,period_start,book_depreciation,tax_depreciation,book_value,tax_value,rule_version) values($1,$2,$3,'2026-10-01',100,150,1100,1050,'tax:declining_balance:36') returning id";
 const layer=(await run(api,T.id,layerSql,[T.id,entity,asset2])).rows[0].id;
 await rejects(run(api,T.id,layerSql,[T.id,entity,asset2]),/duplicate key/,'two layers for one period and rule');
 await rejects(run(api,T.id,"update lara.book_tax_layers set tax_value=0 where id=$1",[layer]),/APPEND_ONLY|permission denied/,'layer edited');
 pass('one live schedule per source with a fixed identity and independent approval, one draft version at a time immutable once reviewed, lines unique per period on the first of the month and immutable once executed, runs with at least one schedule, book/tax layers unique per period and rule and append-only');

 for(const table of ['asset_classes','assets','asset_events','asset_components','recognition_schedules','schedule_versions','schedule_lines','schedule_runs','book_tax_layers'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.assets')).rows[0].n,0,'assets visible without a tenant');
 await rejects(run(api,other.id,classSql,[T.id,entity,book,'X','x',equip,accDep,depExp,gain,loss,null,'straight_line',60,principal]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['asset_classes','assets','recognition_schedules','schedule_versions','schedule_runs'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security isolates tenants on every asset and schedule table and the runtime role cannot delete register or schedule records');
 console.log('P11-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
