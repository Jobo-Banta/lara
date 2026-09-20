// P15 intercompany and consolidation schema acceptance against real
// PostgreSQL through the runtime role: one live group per reporting entity
// with wholly-owned full-method members only; mapping versions and rate sets
// approved by another principal and immutable once approved; intercompany
// pairs with a unique shared reference and source document whose posted
// sides are never rolled back and whose final states stay final;
// consolidation runs versioned per group and period end, one published,
// inputs frozen once approved; eliminations and translation adjustments
// bound to their run; row-level security isolates every table.
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
const T={id:randomUUID(),slug:'p02-test-group-'+suffix},other={id:randomUUID(),slug:'p02-test-group-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Group schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const ctrl=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Group controller') returning id",[T.id,'gc-'+suffix])).rows[0].id;
 const dir=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Director') returning id",[T.id,'gd-'+suffix])).rows[0].id;
 const entity=async name=>(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,$2,1,'PHP','Asia/Manila',$3,$4,'active') returning id",[T.id,name,hash(name),ctrl])).rows[0].id;
 const parent=await entity('Parent Holdings'),sub=await entity('Subsidiary Trading');
 const book=async(e,code,cur)=>(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,$3,'primary',$4,'active',$5) returning id",[T.id,e,code,cur,ctrl])).rows[0].id;
 const parentBook=await book(parent,'PHP-MAIN','PHP'),subBook=await book(sub,'USD-MAIN','USD');
 const groupBook=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'CONSOL','management','PHP','active',$3) returning id",[T.id,parent,ctrl])).rows[0].id;
 const acct=async(e,b,code,category,side)=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$4,$5,$6,'none',true,'active',$7,$8) returning id",[T.id,e,b,code,category,side,hash(e+code),ctrl])).rows[0].id;
 const parentAr=await acct(parent,parentBook,'1200','asset','debit'),subAp=await acct(sub,subBook,'2100','liability','credit');
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'rates.pdf',$4,'application/pdf',10,'available','internal',$5) returning id",[T.id,parent,'k-'+suffix,hash('r'),ctrl])).rows[0].id;
 const branch=async e=>(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,e,hash('b'+e),ctrl])).rows[0].id;
 const parentBranch=await branch(parent),subBranch=await branch(sub);
 const party=async e=>(await run(owner,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Counterparty','unknown','active',$3,$4) returning id",[T.id,e,hash('p'+e),ctrl])).rows[0].id;
 const parentParty=await party(parent),subParty=await party(sub);
 const doc=async(e,b,br,p,kind)=>(await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,rule_profile_version,payload_hash,created_by,net,tax,gross) values($1,$2,$3,$4,$5,$6,'2026-10-01','2026-10-01','PHP','ph-2026',$7,$8,1000,0,1000) returning id",[T.id,e,b,kind,br,p,hash('d'+e+kind+Math.random()),ctrl])).rows[0].id;
 const invoice=await doc(parent,parentBook,parentBranch,parentParty,'invoice'),bill=await doc(sub,subBook,subBranch,subParty,'bill');

 const groupSql="insert into lara.groups(tenant_id,entity_id,name,reporting_currency,book_id,created_by) values($1,$2,$3,'PHP',$4,$5) returning id";
 const group=(await run(api,T.id,groupSql,[T.id,parent,'Holdings group',groupBook,ctrl])).rows[0].id;
 await rejects(run(api,T.id,groupSql,[T.id,parent,'Second',groupBook,ctrl]),/duplicate key/,'two live groups for one reporting entity');
 const memberSql="insert into lara.group_members(tenant_id,group_id,entity_id,ownership_pct,method,effective_from,created_by) values($1,$2,$3,$4,$5,'2026-01-01',$6)";
 await run(api,T.id,memberSql,[T.id,group,parent,100,'full',ctrl]);
 await run(api,T.id,memberSql,[T.id,group,sub,100,'full',ctrl]);
 await rejects(run(api,T.id,memberSql,[T.id,group,sub,100,'full',ctrl]),/duplicate key/,'member twice');
 await rejects(run(api,T.id,memberSql,[T.id,group,sub,60,'full',ctrl]),/check constraint|violates/,'partial ownership under the full method');
 await rejects(run(api,T.id,memberSql,[T.id,group,sub,40,'equity',ctrl]),/check constraint|violates/,'equity method');
 await rejects(run(api,T.id,"update lara.groups set state='active',activated_by=$2,activated_at=now() where id=$1",[group,ctrl]),/check constraint|violates/,'activated by the definer');
 await run(api,T.id,"update lara.groups set state='active',activated_by=$2,activated_at=now() where id=$1",[group,dir]);
 await rejects(run(api,T.id,"update lara.groups set reporting_currency='USD' where id=$1",[group]),/keeps its reporting currency/,'active group changes currency');
 await rejects(run(api,T.id,"update lara.groups set state='draft' where id=$1",[group]),/cannot move from/,'active back to draft');
 pass('one live group per reporting entity, wholly-owned full-method members only, activation by another principal, currency and book frozen once active');

 const mvSql="insert into lara.group_mapping_versions(tenant_id,entity_id,group_id,mapping_version,entry_count,content_hash,created_by) values($1,$2,$3,$4,1,$5,$6) returning id";
 const mv=(await run(api,T.id,mvSql,[T.id,parent,group,'2026.1',hash('m1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,mvSql,[T.id,parent,group,'2026.1',hash('m2'),ctrl]),/duplicate key/,'mapping version twice');
 const entrySql="insert into lara.group_account_mappings(tenant_id,mapping_version_id,member_entity_id,account_id,group_account_code,group_account_name,group_category,role) values($1,$2,$3,$4,$5,$6,$7,$8)";
 await run(api,T.id,entrySql,[T.id,mv,parent,parentAr,'G1200','Intercompany receivables','asset','intercompany_receivable']);
 await rejects(run(api,T.id,entrySql,[T.id,mv,parent,parentAr,'G1200','Intercompany receivables','asset','intercompany_receivable']),/duplicate key/,'account mapped twice in a version');
 await rejects(run(api,T.id,entrySql,[T.id,mv,sub,subAp,'G2100','Intercompany payables','liability','plug']),/check constraint|violates/,'unknown role');
 await rejects(run(api,T.id,"update lara.group_mapping_versions set state='approved',approved_by=$2,approved_at=now() where id=$1",[mv,ctrl]),/check constraint|violates/,'mapping approved by its author');
 await run(api,T.id,"update lara.group_mapping_versions set state='approved',approved_by=$2,approved_at=now() where id=$1",[mv,dir]);
 await rejects(run(api,T.id,"update lara.group_mapping_versions set content_hash=$2 where id=$1",[mv,hash('m3')]),/immutable/,'approved mapping changed');
 const rsSql="insert into lara.consolidation_rate_sets(tenant_id,entity_id,code,period_end,reporting_currency,rates,source_evidence_id,content_hash,created_by) values($1,$2,$3,'2026-10-31','PHP',$4,$5,$6,$7) returning id";
 const rs=(await run(api,T.id,rsSql,[T.id,parent,'2026-10',JSON.stringify([{currency:'USD',closing:'56.5',average:'56',historical:'55'}]),evidence,hash('r1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,rsSql,[T.id,parent,'2026-10',JSON.stringify([]),evidence,hash('r2'),ctrl]),/duplicate key/,'rate set code twice');
 await rejects(run(api,T.id,rsSql,[T.id,parent,'2026-10b','{}',evidence,hash('r3'),ctrl]),/check constraint|violates/,'rates not an array');
 await rejects(run(api,T.id,"update lara.consolidation_rate_sets set state='approved',approved_by=$2,approved_at=now() where id=$1",[rs,ctrl]),/check constraint|violates/,'rate set approved by its author');
 await run(api,T.id,"update lara.consolidation_rate_sets set state='approved',approved_by=$2,approved_at=now() where id=$1",[rs,dir]);
 await rejects(run(api,T.id,"update lara.consolidation_rate_sets set rates='[]' , content_hash=$2 where id=$1",[rs,hash('r4')]),/immutable/,'approved rate set changed');
 pass('mapping versions and rate sets are unique per group or entity, approved by another principal and immutable once approved');

 const pairSql="insert into lara.intercompany_pairs(tenant_id,entity_id,source_entity_id,target_entity_id,source_document_id,shared_reference,target_draft,content_hash,created_by) values($1,$2,$2,$3,$4,$5,'{}',$6,$7) returning id";
 const pair=(await run(api,T.id,pairSql,[T.id,parent,sub,invoice,'ICP-000001',hash('p1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,pairSql,[T.id,parent,sub,invoice,'ICP-000002',hash('p2'),ctrl]),/duplicate key/,'one pair per source document');
 await rejects(run(api,T.id,pairSql,[T.id,parent,sub,bill,'ICP-000001',hash('p3'),ctrl]),/duplicate key/,'shared reference twice');
 await rejects(run(api,T.id,pairSql,[T.id,parent,parent,bill,'ICP-000003',hash('p4'),ctrl]),/check constraint|violates/,'source and target the same entity');
 await rejects(run(api,T.id,"update lara.intercompany_pairs set state='accepted' where id=$1",[pair]),/check constraint|violates/,'accepted without a target document');
 await rejects(run(api,T.id,"update lara.intercompany_pairs set state='posted' where id=$1",[pair]),/cannot move from|check constraint|violates/,'draft straight to posted');
 await run(api,T.id,"update lara.intercompany_pairs set state='accepted',target_document_id=$2 where id=$1",[pair,bill]);
 await rejects(run(api,T.id,"update lara.intercompany_pairs set target_draft='{\"changed\":true}' where id=$1",[pair]),/keeps its documents/,'accepted pair draft changed');
 await run(api,T.id,"update lara.intercompany_pairs set source_posted_at=now() where id=$1",[pair]);
 await rejects(run(api,T.id,"update lara.intercompany_pairs set source_posted_at=null where id=$1",[pair]),/never rolled back/,'issued source side rolled back');
 await rejects(run(api,T.id,"update lara.intercompany_pairs set state='exception' where id=$1",[pair]),/check constraint|violates/,'exception without a reason');
 await run(api,T.id,"update lara.intercompany_pairs set state='exception',exception_reason='target side: STATE_CONFLICT: Approval is required before posting.' where id=$1",[pair]);
 await run(api,T.id,"update lara.intercompany_pairs set state='accepted' where id=$1",[pair]);
 await run(api,T.id,"update lara.intercompany_pairs set state='posted',target_posted_at=now() where id=$1",[pair]);
 await rejects(run(api,T.id,"update lara.intercompany_pairs set state='exception',exception_reason='x' where id=$1",[pair]),/final/,'posted pair reopened');
 pass('pairs are unique per source document and shared reference between two entities, accepted only with a target document, issued sides never rolled back, exceptions carry a reason, posted pairs final');

 const snap=(await run(api,T.id,"insert into lara.report_snapshots(tenant_id,entity_id,book_id,report_type,period_key,version_number,cutoff_posted_at,rule_version,payload,checksum,created_by) values($1,$2,$3,'statements','2026-10',1,now(),'p03.1','{}'::jsonb,$4,$5) returning id",[T.id,sub,subBook,hash('s'),ctrl])).rows[0].id;
 const runSql="insert into lara.consolidation_runs(tenant_id,entity_id,group_id,period_end,version_number,member_snapshot_ids,rate_set_id,mapping_version,content_hash,created_by) values($1,$2,$3,'2026-10-31',$4,$5,$6,'2026.1',$7,$8) returning id";
 const r1=(await run(api,T.id,runSql,[T.id,parent,group,1,[snap],rs,hash('c1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,runSql,[T.id,parent,group,1,[snap],rs,hash('c2'),ctrl]),/duplicate key/,'version number twice for the group and period');
 await rejects(run(api,T.id,runSql,[T.id,parent,group,2,[],rs,hash('c3'),ctrl]),/check constraint|violates/,'no snapshots');
 await rejects(run(api,T.id,"update lara.consolidation_runs set state='previewed' where id=$1",[r1]),/check constraint|violates/,'previewed without a result');
 await run(api,T.id,"update lara.consolidation_runs set state='previewed',result='{}',result_hash=$2 where id=$1",[r1,hash('res')]);
 await rejects(run(api,T.id,"update lara.consolidation_runs set state='approved',approved_by=$2,approved_at=now() where id=$1",[r1,ctrl]),/check constraint|violates/,'approved by the preparer');
 await run(api,T.id,"update lara.consolidation_runs set state='approved',approved_by=$2,approved_at=now() where id=$1",[r1,dir]);
 await rejects(run(api,T.id,"update lara.consolidation_runs set mapping_version='2026.2' where id=$1",[r1]),/keeps its inputs/,'approved run inputs changed');
 await rejects(run(api,T.id,"update lara.consolidation_runs set state='published' where id=$1",[r1]),/check constraint|violates/,'published without a snapshot');
 const cons=(await run(api,T.id,"insert into lara.report_snapshots(tenant_id,entity_id,book_id,report_type,period_key,version_number,cutoff_posted_at,rule_version,payload,checksum,created_by) values($1,$2,$3,'consolidated_statements','2026-10',1,now(),'p15.1','{}'::jsonb,$4,$5) returning id",[T.id,parent,groupBook,hash('cs'),ctrl])).rows[0].id;
 await run(api,T.id,"update lara.consolidation_runs set state='published',published_snapshot_id=$2,published_at=now() where id=$1",[r1,cons]);
 const r2=(await run(api,T.id,runSql,[T.id,parent,group,2,[snap],rs,hash('c4'),ctrl])).rows[0].id;
 await run(api,T.id,"update lara.consolidation_runs set state='previewed',result='{}',result_hash=$2 where id=$1",[r2,hash('res2')]);
 await run(api,T.id,"update lara.consolidation_runs set state='approved',approved_by=$2,approved_at=now() where id=$1",[r2,dir]);
 await rejects(run(api,T.id,"update lara.consolidation_runs set state='published',published_snapshot_id=$2,published_at=now() where id=$1",[r2,cons]),/duplicate key/,'two published runs for one group and period');
 await run(api,T.id,"update lara.consolidation_runs set state='superseded' where id=$1",[r1]);
 await rejects(run(api,T.id,"update lara.consolidation_runs set state='published' where id=$1",[r1]),/final/,'superseded run reopened');
 const elimSql="insert into lara.elimination_entries(tenant_id,entity_id,run_id,kind,pair_id,lines,amount,difference,reason,evidence_ids,created_by) values($1,$2,$3,$4,$5,'[]',1000,0,'Reciprocal balances',$6,$7)";
 await run(api,T.id,elimSql,[T.id,parent,r2,'pair',pair,'[]',ctrl]);
 await rejects(run(api,T.id,elimSql,[T.id,parent,r2,'pair',null,'[]',ctrl]),/check constraint|violates/,'pair elimination without a pair');
 await rejects(run(api,T.id,elimSql,[T.id,parent,r2,'manual',null,'[]',ctrl]),/check constraint|violates/,'manual elimination without evidence');
 await run(api,T.id,elimSql,[T.id,parent,r2,'manual',null,JSON.stringify([evidence]),ctrl]);
 const trSql="insert into lara.translation_adjustments(tenant_id,entity_id,run_id,member_entity_id,source,policy,currency,rate,amount) values($1,$2,$3,$4,'balance_sheet','closing','USD',56.5,100)";
 await run(api,T.id,trSql,[T.id,parent,r2,sub]);
 await rejects(run(api,T.id,trSql,[T.id,parent,r2,sub]),/duplicate key/,'one adjustment per run, member and source');
 pass('runs are versioned per group and period end, previewed only with a result, approved by another principal with inputs frozen, one published per period with a snapshot, superseded runs final; eliminations and translation adjustments bind to their run');

 for(const table of ['groups','group_members','group_mapping_versions','group_account_mappings','consolidation_rate_sets','intercompany_pairs','consolidation_runs','elimination_entries','translation_adjustments'])assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.groups')).rows[0].n,0,'groups visible without a tenant');
 await rejects(run(api,other.id,groupSql,[T.id,parent,'Intruder',groupBook,ctrl]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['groups','intercompany_pairs','consolidation_runs','consolidation_rate_sets'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security keeps group, pair and run records in their tenant; the runtime role cannot delete them');
 console.log('P15-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
