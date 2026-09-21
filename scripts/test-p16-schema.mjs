// P16 planning schema acceptance against real PostgreSQL through the
// runtime role: budget versions unique per book and period with one active,
// approved by another principal and immutable once approved; one bucket per
// account and dimension set; commitments one per order line, consumption
// never reduced, final states final; allocation rule versions and runs
// (posted once per rule version and period, inputs frozen once approved);
// projects with unique codes, contract versions immutable once decided,
// milestones never billed beyond certification, advances never recouped
// beyond their amount, billings and retention items bound to their invoice;
// row-level security isolates every table.
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
const T={id:randomUUID(),slug:'p02-test-plan-'+suffix},other={id:randomUUID(),slug:'p02-test-plan-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Planning schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const ctrl=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Controller') returning id",[T.id,'pc-'+suffix])).rows[0].id;
 const dir=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Director') returning id",[T.id,'pd-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Planning entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),ctrl])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),ctrl])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,ctrl])).rows[0].id;
 const acct=async(code,category,side)=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$4,$5,$6,'none',true,'active',$7,$8) returning id",[T.id,entity,book,code,category,side,hash(code),ctrl])).rows[0].id;
 const fees=await acct('5000','expense','debit'),rent=await acct('5200','expense','debit'),target=await acct('5900','expense','debit');
 const period=(await run(owner,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4) returning id",[T.id,entity,book,ctrl])).rows[0].id;
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'drivers.pdf',$4,'application/pdf',10,'available','internal',$5) returning id",[T.id,entity,'k-'+suffix,hash('d'),ctrl])).rows[0].id;
 const party=(await run(owner,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Client Co','unknown','active',$3,$4) returning id",[T.id,entity,hash('p'),ctrl])).rows[0].id;
 const doc=async(kind)=>(await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,rule_profile_version,payload_hash,created_by,net,tax,gross) values($1,$2,$3,$4,$5,$6,'2026-10-05','2026-10-05','PHP','ph-2026',$7,$8,1000,0,1000) returning id",[T.id,entity,book,kind,branch,party,hash('d'+kind+Math.random()),ctrl])).rows[0].id;
 const order=await doc('purchase_order'),invoice=await doc('invoice');

 const bSql="insert into lara.budgets(tenant_id,entity_id,book_id,period_start,period_end,version_number,currency,policy,content_hash,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4,'PHP',$5,$6,$7) returning id";
 const b1=(await run(api,T.id,bSql,[T.id,entity,book,1,'block',hash('b1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,bSql,[T.id,entity,book,1,'block',hash('b2'),ctrl]),/duplicate key/,'version number twice');
 await rejects(run(api,T.id,bSql,[T.id,entity,book,2,'advise',hash('b3'),ctrl]),/check constraint|violates/,'unknown policy');
 const lSql="insert into lara.budget_lines(tenant_id,budget_id,account_id,dimensions_json,dimensions_key,amount) values($1,$2,$3,$4,$5,$6) returning id";
 const line=(await run(api,T.id,lSql,[T.id,b1,fees,'{}','{}',5000])).rows[0].id;
 await rejects(run(api,T.id,lSql,[T.id,b1,fees,'{}','{}',1]),/duplicate key/,'one bucket per account and dimension set');
 await rejects(run(api,T.id,lSql,[T.id,b1,rent,'{}','{}',-1]),/check constraint|violates/,'negative budget');
 await rejects(run(api,T.id,"update lara.budgets set state='approved',approved_by=$2,approved_at=now() where id=$1",[b1,ctrl]),/check constraint|violates/,'approved by its author');
 await rejects(run(api,T.id,"update lara.budgets set state='active',activated_by=$2,activated_at=now() where id=$1",[b1,dir]),/cannot move from|check constraint|violates/,'draft straight to active');
 await run(api,T.id,"update lara.budgets set state='approved',approved_by=$2,approved_at=now() where id=$1",[b1,dir]);
 await rejects(run(api,T.id,"update lara.budgets set content_hash=$2 where id=$1",[b1,hash('b9')]),/immutable/,'approved budget changed');
 await run(api,T.id,"update lara.budgets set state='active',activated_by=$2,activated_at=now() where id=$1",[b1,dir]);
 const b2=(await run(api,T.id,bSql,[T.id,entity,book,2,'warn',hash('b4'),ctrl])).rows[0].id;
 await run(api,T.id,"update lara.budgets set state='approved',approved_by=$2,approved_at=now() where id=$1",[b2,dir]);
 await rejects(run(api,T.id,"update lara.budgets set state='active',activated_by=$2,activated_at=now() where id=$1",[b2,dir]),/duplicate key/,'two active budgets for one book and period');
 await run(api,T.id,"update lara.budgets set state='superseded' where id=$1",[b1]);
 await rejects(run(api,T.id,"update lara.budgets set state='active' where id=$1",[b1]),/final/,'superseded budget reopened');
 pass('budgets are versioned per book and period, one active, approved by another principal, immutable once approved, superseded budgets final; one bucket per account and dimension set with non-negative amounts');

 const cSql="insert into lara.commitments(tenant_id,entity_id,book_id,budget_id,budget_line_id,source_type,source_id,line_no,account_id,dimensions_json,amount,created_by) values($1,$2,$3,$4,$5,'purchase_order',$6,$7,$8,'{}',$9,$10) returning id";
 const c=(await run(api,T.id,cSql,[T.id,entity,book,b1,line,order,1,fees,800,ctrl])).rows[0].id;
 await rejects(run(api,T.id,cSql,[T.id,entity,book,b1,line,order,1,fees,800,ctrl]),/duplicate key/,'one commitment per order line');
 await rejects(run(api,T.id,cSql,[T.id,entity,book,b1,line,order,2,fees,0,ctrl]),/check constraint|violates/,'zero commitment');
 await rejects(run(api,T.id,"update lara.commitments set consumed=900 where id=$1",[c]),/check constraint|violates/,'consumed beyond the amount');
 await run(api,T.id,"update lara.commitments set consumed=300 where id=$1",[c]);
 await rejects(run(api,T.id,"update lara.commitments set consumed=200 where id=$1",[c]),/never reduced/,'consumption reduced');
 await rejects(run(api,T.id,"update lara.commitments set override_reason='x' where id=$1",[c]),/check constraint|violates/,'override without the principal');
 await run(api,T.id,"update lara.commitments set state='released' where id=$1",[c]);
 await rejects(run(api,T.id,"update lara.commitments set state='open' where id=$1",[c]),/final/,'released commitment reopened');
 pass('commitments are one per order line, positive, consumed never beyond the amount nor reduced, overrides carry their principal, released or consumed commitments final');

 const rSql="insert into lara.allocation_rules(tenant_id,entity_id,book_id,code,version_number,name,source_account_ids,target_account_id,drivers,effective_from,content_hash,created_by) values($1,$2,$3,'OVH',$4,'Overhead',$5,$6,$7,'2026-01-01',$8,$9) returning id";
 const r1=(await run(api,T.id,rSql,[T.id,entity,book,1,[fees,rent],target,JSON.stringify([{dimensions:{cc:randomUUID()},weight:'1'}]),hash('r1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,rSql,[T.id,entity,book,1,[fees],target,'[]',hash('r2'),ctrl]),/duplicate key|check constraint|violates/,'version twice or no drivers');
 await rejects(run(api,T.id,rSql,[T.id,entity,book,2,[],target,JSON.stringify([{weight:'1'}]),hash('r3'),ctrl]),/check constraint|violates/,'no source accounts');
 await rejects(run(api,T.id,"update lara.allocation_rules set state='approved',approved_by=$2,approved_at=now() where id=$1",[r1,ctrl]),/check constraint|violates/,'rule approved by its author');
 await run(api,T.id,"update lara.allocation_rules set state='approved',approved_by=$2,approved_at=now() where id=$1",[r1,dir]);
 await rejects(run(api,T.id,"update lara.allocation_rules set content_hash=$2 where id=$1",[r1,hash('r9')]),/immutable/,'approved rule changed');
 const runSql="insert into lara.allocation_runs(tenant_id,entity_id,rule_version_id,period_id,source_cutoff,driver_evidence_id,content_hash,created_by) values($1,$2,$3,$4,'2026-11-01T00:00:00Z',$5,$6,$7) returning id";
 const a1=(await run(api,T.id,runSql,[T.id,entity,r1,period,evidence,hash('a1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,"update lara.allocation_runs set state='previewed' where id=$1",[a1]),/check constraint|violates/,'previewed without lines');
 await run(api,T.id,"update lara.allocation_runs set state='previewed',pool=1000,lines='{}',lines_hash=$2 where id=$1",[a1,hash('l1')]);
 await rejects(run(api,T.id,"update lara.allocation_runs set state='approved',approved_by=$2,approved_at=now() where id=$1",[a1,ctrl]),/check constraint|violates/,'run approved by the preparer');
 await run(api,T.id,"update lara.allocation_runs set state='approved',approved_by=$2,approved_at=now() where id=$1",[a1,dir]);
 await rejects(run(api,T.id,"update lara.allocation_runs set source_cutoff='2026-11-02T00:00:00Z' where id=$1",[a1]),/keeps its inputs/,'approved run inputs changed');
 await rejects(run(api,T.id,"update lara.allocation_runs set state='posted' where id=$1",[a1]),/check constraint|violates/,'posted without an entry');
 await run(api,T.id,"update lara.allocation_runs set state='posted',entry_id=$2,posted_by=$3,posted_at=now() where id=$1",[a1,randomUUID(),dir]);
 const a2=(await run(api,T.id,runSql,[T.id,entity,r1,period,evidence,hash('a2'),ctrl])).rows[0].id;
 await run(api,T.id,"update lara.allocation_runs set state='previewed',pool=1000,lines='{}',lines_hash=$2 where id=$1",[a2,hash('l2')]);
 await run(api,T.id,"update lara.allocation_runs set state='approved',approved_by=$2,approved_at=now() where id=$1",[a2,dir]);
 await rejects(run(api,T.id,"update lara.allocation_runs set state='posted',entry_id=$2,posted_by=$3,posted_at=now() where id=$1",[a2,randomUUID(),dir]),/duplicate key/,'a rule version posts once per period');
 await rejects(run(api,T.id,"update lara.allocation_runs set state='approved' where id=$1",[a1]),/final/,'posted run reopened');
 pass('rule versions are unique per code, need sources and drivers, are approved by another principal and immutable; runs preview only with lines, approve by another principal with inputs frozen, post once per rule version and period, posted runs final');

 const pSql="insert into lara.projects(tenant_id,entity_id,code,customer_id,currency,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,'PHP',$5,$6,$7) returning id";
 const p=(await run(api,T.id,pSql,[T.id,entity,'PRJ-1',party,JSON.stringify([evidence]),hash('p1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,pSql,[T.id,entity,'PRJ-1',party,JSON.stringify([evidence]),hash('p2'),ctrl]),/duplicate key/,'project code twice');
 await rejects(run(api,T.id,pSql,[T.id,entity,'PRJ-2',party,'[]',hash('p3'),ctrl]),/check constraint|violates/,'project without evidence');
 const cvSql="insert into lara.project_contract_versions(tenant_id,entity_id,project_id,version_number,contract_amount,reason,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,'Original',$6,$7,$8) returning id";
 const cv=(await run(api,T.id,cvSql,[T.id,entity,p,1,100000,JSON.stringify([evidence]),hash('cv1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,cvSql,[T.id,entity,p,1,100000,JSON.stringify([evidence]),hash('cv2'),ctrl]),/duplicate key/,'contract version twice');
 await rejects(run(api,T.id,"update lara.project_contract_versions set state='approved',approved_by=$2,approved_at=now() where id=$1",[cv,ctrl]),/check constraint|violates/,'contract approved by its author');
 await run(api,T.id,"update lara.project_contract_versions set state='approved',approved_by=$2,approved_at=now() where id=$1",[cv,dir]);
 await rejects(run(api,T.id,"update lara.project_contract_versions set contract_amount=1 where id=$1",[cv]),/immutable/,'decided contract version changed');
 const mSql="insert into lara.milestones(tenant_id,entity_id,project_id,sequence,name,amount,created_by) values($1,$2,$3,$4,'Design',$5,$6) returning id";
 const m=(await run(api,T.id,mSql,[T.id,entity,p,1,40000,ctrl])).rows[0].id;
 await rejects(run(api,T.id,mSql,[T.id,entity,p,1,10,ctrl]),/duplicate key/,'sequence twice');
 await rejects(run(api,T.id,"update lara.milestones set billed_value=10 where id=$1",[m]),/check constraint|violates/,'billed beyond certification');
 await rejects(run(api,T.id,"update lara.milestones set certified_value=30000 where id=$1",[m]),/check constraint|violates/,'certified without a certifier and evidence');
 await run(api,T.id,"update lara.milestones set certified_value=30000,certified_by=$2,certified_at=now(),certified_evidence_ids=$3,state='certified' where id=$1",[m,dir,JSON.stringify([evidence])]);
 await run(api,T.id,"update lara.milestones set billed_value=20000,state='billed' where id=$1",[m]);
 await rejects(run(api,T.id,"update lara.milestones set billed_value=10000 where id=$1",[m]),/never reduced/,'billed value reduced');
 await rejects(run(api,T.id,"update lara.milestones set certified_value=15000 where id=$1",[m]),/cannot fall below/,'certification below billing');
 const settlement=(await run(api,T.id,"insert into lara.settlements(tenant_id,entity_id,book_id,direction,party_id,payment_method,currency,value_date,gross_amount,cash_amount,withholding_amount,adjustment_amount,payload_hash,created_by) values($1,$2,$3,'receipt',$4,'transfer','PHP','2026-10-02',5000,5000,0,0,$5,$6) returning id",[T.id,entity,book,party,hash('s'),ctrl])).rows[0].id;
 const aSql="insert into lara.project_advances(tenant_id,entity_id,project_id,collection_id,amount,created_by) values($1,$2,$3,$4,$5,$6) returning id";
 const adv=(await run(api,T.id,aSql,[T.id,entity,p,settlement,5000,ctrl])).rows[0].id;
 await rejects(run(api,T.id,aSql,[T.id,entity,p,settlement,1,ctrl]),/duplicate key/,'one advance per project and collection');
 await rejects(run(api,T.id,"update lara.project_advances set recouped=6000 where id=$1",[adv]),/check constraint|violates/,'recouped beyond the advance');
 const billing=(await run(api,T.id,"insert into lara.project_billings(tenant_id,entity_id,project_id,milestone_id,invoice_id,contract_version_id,certified_amount,retention_amount,advance_recoupment,evidence_ids,created_by) values($1,$2,$3,$4,$5,$6,20000,2000,3000,$7,$8) returning id",[T.id,entity,p,m,invoice,cv,JSON.stringify([evidence]),ctrl])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.project_billings(tenant_id,entity_id,project_id,milestone_id,invoice_id,contract_version_id,certified_amount,retention_amount,advance_recoupment,evidence_ids,created_by) values($1,$2,$3,$4,$5,$6,1000,900,200,$7,$8)",[T.id,entity,p,m,invoice,cv,JSON.stringify([evidence]),ctrl]),/duplicate key|check constraint|violates/,'second billing on the invoice or held beyond certified');
 const riSql="insert into lara.retention_items(tenant_id,entity_id,project_id,milestone_id,billing_id,invoice_id,held,due_condition,recognition_entry_id,created_by) values($1,$2,$3,$4,$5,$6,2000,'Final acceptance',$7,$8) returning id";
 const ri=(await run(api,T.id,riSql,[T.id,entity,p,m,billing,invoice,randomUUID(),ctrl])).rows[0].id;
 await rejects(run(api,T.id,riSql,[T.id,entity,p,m,billing,invoice,randomUUID(),ctrl]),/duplicate key/,'one retention item per invoice');
 await rejects(run(api,T.id,"update lara.retention_items set state='released' where id=$1",[ri]),/check constraint|violates/,'released without the release invoice, amount and evidence');
 await run(api,T.id,"update lara.project_billings set state='posted' where id=$1",[billing]);
 await rejects(run(api,T.id,"update lara.project_billings set retention_amount=1 where id=$1",[billing]),/immutable/,'posted billing changed');
 pass('projects have unique codes and evidence; contract versions are unique, approved by another principal and immutable once decided; milestones certify on evidence and never bill beyond certification nor reduce billing; advances recoup within their amount; billings and retention items bind to one invoice and posted billings are immutable');

 for(const table of ['budgets','budget_lines','commitments','allocation_rules','allocation_runs','projects','project_contract_versions','milestones','project_advances','project_billings','retention_items'])assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.projects')).rows[0].n,0,'projects visible without a tenant');
 await rejects(run(api,other.id,pSql,[T.id,entity,'PRJ-9',party,JSON.stringify([evidence]),hash('p9'),ctrl]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['budgets','commitments','allocation_runs','projects','retention_items'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security keeps planning records in their tenant; the runtime role cannot delete them');
 console.log('P16-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
