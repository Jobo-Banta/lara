// P17 local operations schema acceptance against real PostgreSQL through
// the runtime role: the five capabilities and their permissions seeded;
// leases approved by another principal and frozen once approved with
// append-only events; one live eligibility per customer and category,
// immutable once approved; payouts whose net must equal gross less
// deductions, one per channel and source, final once posted; POS machines
// unique per serial and MIN, closings unique per machine, shift and reading
// with gross equal to the reading difference; payroll batches unique per
// file, posted once per source and period, records append-only; remittances
// remitted only with a reference and evidence; local obligations unique per
// authority, kind, period and property, complete only with payment and,
// where required, filing evidence; row-level security isolates every table.
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
const T={id:randomUUID(),slug:'p02-test-local-'+suffix},other={id:randomUUID(),slug:'p02-test-local-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 const caps=(await run(api,null,"select code,phase,depends_on from lara.capability_definitions where phase like 'P17%' order by code")).rows;
 assert.deepEqual(caps.map(c=>c.code),['leases','local_obligations','marketplace_pos','payroll_data','statutory_discounts']);
 assert.deepEqual(caps.find(c=>c.code==='leases').depends_on,['sales','assets']);
 assert.equal((await run(api,null,"select count(*)::int n from lara.permission_definitions where code in ('payout.post','payroll_record.read','local_obligation.complete','pos_closing.match')")).rows[0].n,3,'the P17 permissions are seeded (pos_closing.match is not a permission)');
 pass('the five P17 capabilities are defined with their dependencies and the new permissions are seeded');

 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Local ops schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const ctrl=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Controller') returning id",[T.id,'lc-'+suffix])).rows[0].id;
 const dir=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Director') returning id",[T.id,'ld-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Local entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),ctrl])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),ctrl])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,ctrl])).rows[0].id;
 const acct=async(code,category,side)=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$4,$5,$6,'none',true,'active',$7,$8) returning id",[T.id,entity,book,code,category,side,hash(code),ctrl])).rows[0].id;
 const ar=await acct('1200','asset','debit'),fees=await acct('5300','expense','debit'),wht=await acct('1350','asset','debit'),clearing=await acct('1020','asset','debit');
 const party=(await run(owner,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Tenant Co','unknown','active',$3,$4) returning id",[T.id,entity,hash('p'),ctrl])).rows[0].id;
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'lease.pdf',$4,'application/pdf',10,'available','internal',$5) returning id",[T.id,entity,'k-'+suffix,hash('l'),ctrl])).rows[0].id;
 const doc=(await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,rule_profile_version,payload_hash,created_by,net,tax,gross) values($1,$2,$3,'invoice',$4,$5,'2026-10-01','2026-10-01','PHP','ph-2026',$6,$7,1000,0,1000) returning id",[T.id,entity,book,branch,party,hash('d'),ctrl])).rows[0].id;
 const schedule=(await run(api,T.id,"insert into lara.recognition_schedules(tenant_id,entity_id,book_id,kind,source_type,source_id,start_date,end_date,basis_amount,currency,method,policy_version,content_hash,created_by) values($1,$2,$3,'recurring_invoice','document',$4,'2026-10-01','2027-09-30',20000,'PHP','recurring','recurring-1',$5,$6) returning id",[T.id,entity,book,doc,hash('s'),ctrl])).rows[0].id;
 const ev=JSON.stringify([evidence]);

 const leaseSql="insert into lara.lease_contracts(tenant_id,entity_id,party_id,start_date,end_date,currency,deposit,advance,billing_schedule_id,withholding_profile_version,base_rent,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,'PHP',40000,20000,$6,'wht-2026',20000,$7,$8,$9) returning id";
 const lease=(await run(api,T.id,leaseSql,[T.id,entity,party,'2026-10-01','2027-09-30',schedule,ev,hash('l1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,leaseSql,[T.id,entity,party,'2026-10-01','2027-09-30',schedule,ev,hash('l2'),ctrl]),/duplicate key/,'one lease per billing schedule');
 await rejects(run(api,T.id,leaseSql,[T.id,entity,party,'2027-09-30','2026-10-01',schedule,'[]',hash('l3'),ctrl]),/check constraint|violates/,'end before start or no evidence');
 await rejects(run(api,T.id,"update lara.lease_contracts set state='approved',approved_by=$2,approved_at=now() where id=$1",[lease,ctrl]),/check constraint|violates/,'lease approved by its drafter');
 await run(api,T.id,"update lara.lease_contracts set state='approved',approved_by=$2,approved_at=now() where id=$1",[lease,dir]);
 await rejects(run(api,T.id,"update lara.lease_contracts set content_hash=$2 where id=$1",[lease,hash('l9')]),/keeps its terms/,'approved lease changed');
 const evSql="insert into lara.lease_events(tenant_id,entity_id,lease_id,kind,amount,event_date,approved_by,created_by) values($1,$2,$3,$4,1000,'2026-10-05',$5,$6) returning id";
 const e1=(await run(api,T.id,evSql,[T.id,entity,lease,'deposit_received',null,ctrl])).rows[0].id;
 await rejects(run(api,T.id,evSql,[T.id,entity,lease,'deposit_applied',null,ctrl]),/check constraint|violates/,'application without an approver');
 // Independence from the receipt's recorder is a domain rule (the applier differs from the principal who recorded the receipt), not a row check.
 await rejects(run(api,T.id,"update lara.lease_events set amount=5 where id=$1",[e1]),/append-only|APPEND_ONLY|permission denied/,'events are append-only');
 pass('leases are one per billing schedule with evidence and a coherent term, approved by another principal and frozen once approved; events are append-only and applications carry their approver');

 const elSql="insert into lara.discount_eligibility(tenant_id,entity_id,party_id,category,profile_version,valid_until,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,'sc-2026','2027-12-31',$5,$6,$7) returning id";
 const el=(await run(api,T.id,elSql,[T.id,entity,party,'senior_citizen',ev,hash('el1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,elSql,[T.id,entity,party,'senior_citizen',ev,hash('el2'),ctrl]),/duplicate key/,'two live eligibilities for one customer and category');
 await rejects(run(api,T.id,elSql,[T.id,entity,party,'pwd','[]',hash('el3'),ctrl]),/check constraint|violates/,'eligibility without evidence');
 await rejects(run(api,T.id,"update lara.discount_eligibility set state='approved',approved_by=$2,approved_at=now() where id=$1",[el,ctrl]),/check constraint|violates/,'eligibility approved by its recorder');
 await run(api,T.id,"update lara.discount_eligibility set state='approved',approved_by=$2,approved_at=now() where id=$1",[el,dir]);
 await rejects(run(api,T.id,"update lara.discount_eligibility set content_hash=$2 where id=$1",[el,hash('el9')]),/immutable/,'approved eligibility changed');
 const dlSql="insert into lara.discount_lines(tenant_id,entity_id,document_id,line_no,eligibility_id,category,profile_version,basis,rate,amount,created_by) values($1,$2,$3,1,$4,'senior_citizen','sc-2026',1000,0.2,200,$5)";
 await run(api,T.id,dlSql,[T.id,entity,doc,el,ctrl]);
 await rejects(run(api,T.id,dlSql,[T.id,entity,doc,el,ctrl]),/duplicate key/,'one discount line per document line');
 await run(api,T.id,"update lara.discount_eligibility set state='revoked' where id=$1",[el]);
 await rejects(run(api,T.id,"update lara.discount_eligibility set state='approved' where id=$1",[el]),/final/,'revoked eligibility reopened');
 pass('one live eligibility per customer and category with evidence, approved by another principal, immutable once approved, revoked final; one discount line per document line');

 const chSql="insert into lara.channels(tenant_id,entity_id,code,name,kind,provider,mapping_version,receivable_account_id,fee_account_id,withholding_account_id,clearing_account_id,content_hash,created_by) values($1,$2,$3,'Shop','marketplace','ShopCo','ch-1',$4,$5,$6,$7,$8,$9) returning id";
 const ch=(await run(api,T.id,chSql,[T.id,entity,'SHOP',ar,fees,wht,clearing,hash('c1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,chSql,[T.id,entity,'SHOP',ar,fees,wht,clearing,hash('c2'),ctrl]),/duplicate key/,'channel code twice');
 const poSql="insert into lara.payout_batches(tenant_id,entity_id,channel_id,source_id,period_start,period_end,gross,fees,withholding,other_deductions,net,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,'2026-10-01','2026-10-15',$5,$6,$7,$8,$9,$10,$11,$12) returning id";
 const po=(await run(api,T.id,poSql,[T.id,entity,ch,'STM-1',10000,500,100,0,9400,ev,hash('po1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,poSql,[T.id,entity,ch,'STM-1',10000,500,100,0,9400,ev,hash('po2'),ctrl]),/duplicate key/,'payout source twice for the channel');
 await rejects(run(api,T.id,poSql,[T.id,entity,ch,'STM-2',10000,500,100,0,9500,ev,hash('po3'),ctrl]),/check constraint|violates/,'net not equal to gross less deductions');
 await rejects(run(api,T.id,"update lara.payout_batches set state='posted' where id=$1",[po]),/cannot move from|check constraint|violates/,'imported straight to posted');
 await run(api,T.id,"update lara.payout_batches set state='reconciled' where id=$1",[po]);
 await rejects(run(api,T.id,"update lara.payout_batches set state='posted' where id=$1",[po]),/check constraint|violates/,'posted without an entry');
 await run(api,T.id,"update lara.payout_batches set state='posted',entry_id=$2,posted_by=$3,posted_at=now() where id=$1",[po,randomUUID(),dir]);
 await rejects(run(api,T.id,"update lara.payout_batches set fees=1 where id=$1",[po]),/immutable/,'posted payout changed');
 const pmSql="insert into lara.pos_machines(tenant_id,entity_id,branch_id,brand,model,serial_number,machine_identification_number,permit_number,created_by) values($1,$2,$3,'Acme','X1',$4,$5,'PTU-1',$6) returning id";
 const pm=(await run(api,T.id,pmSql,[T.id,entity,branch,'SN-1','MIN-1',ctrl])).rows[0].id;
 await rejects(run(api,T.id,pmSql,[T.id,entity,branch,'SN-1','MIN-2',ctrl]),/duplicate key/,'serial twice');
 await rejects(run(api,T.id,pmSql,[T.id,entity,branch,'SN-2','MIN-1',ctrl]),/duplicate key/,'MIN twice');
 const pcSql="insert into lara.pos_closings(tenant_id,entity_id,machine_id,shift_date,shift_no,reading_kind,beginning_reading,ending_reading,gross_sales,cash_counted,evidence_ids,content_hash,created_by) values($1,$2,$3,'2026-10-05',1,'Z',$4,$5,$6,$7,$8,$9,$10) returning id";
 const pc=(await run(api,T.id,pcSql,[T.id,entity,pm,1000,3500,2500,2500,ev,hash('pc1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,pcSql,[T.id,entity,pm,1000,3500,2500,2500,ev,hash('pc2'),ctrl]),/duplicate key/,'machine, shift and reading twice');
 await rejects(run(api,T.id,pcSql,[T.id,entity,pm,1000,3500,2000,2000,ev,hash('pc3'),ctrl]),/check constraint|violates/,'gross not the reading difference');
 await rejects(run(api,T.id,"update lara.pos_closings set state='approved',approved_by=$2,approved_at=now() where id=$1",[pc,ctrl]),/check constraint|violates/,'closing approved by its recorder');
 await run(api,T.id,"update lara.pos_closings set state='approved',approved_by=$2,approved_at=now() where id=$1",[pc,dir]);
 await rejects(run(api,T.id,"update lara.pos_closings set state='matched' where id=$1",[pc]),/check constraint|violates/,'matched without a deposit');
 pass('channels are unique per code; payouts unique per channel and source with net = gross − deductions, posted only from reconciled with an entry and immutable once posted; machines unique per serial and MIN; closings unique per machine, shift and reading with gross = ending − beginning, approved by another principal and matched only with a deposit');

 const pbSql="insert into lara.payroll_batches(tenant_id,entity_id,source_system,period_key,mapping_version,employee_count,gross_total,withholding_total,net_total,source_hash,evidence_ids,created_by) values($1,$2,'PayrollCo',$3,'pay-1',2,50000,5000,45000,$4,$5,$6) returning id";
 const pb=(await run(api,T.id,pbSql,[T.id,entity,'2026-10',hash('f1'),ev,ctrl])).rows[0].id;
 await rejects(run(api,T.id,pbSql,[T.id,entity,'2026-10',hash('f1'),ev,ctrl]),/duplicate key/,'the same file twice');
 const rcSql="insert into lara.employee_tax_records(tenant_id,entity_id,batch_id,line_no,employee_reference_encrypted,employee_reference_masked,gross,withholding,net) values($1,$2,$3,$4,'v1.x.y.z','****1234',25000,2500,22500)";
 await run(api,T.id,rcSql,[T.id,entity,pb,1]);
 await rejects(run(api,T.id,rcSql,[T.id,entity,pb,1]),/duplicate key/,'record line twice');
 await rejects(run(api,T.id,"update lara.employee_tax_records set gross=1 where batch_id=$1",[pb]),/append-only|APPEND_ONLY|permission denied/,'records are append-only');
 await rejects(run(api,T.id,"update lara.payroll_batches set state='approved',approved_by=$2,approved_at=now() where id=$1",[pb,dir]),/cannot move from|check constraint|violates/,'imported straight to approved');
 await run(api,T.id,"update lara.payroll_batches set state='reconciled' where id=$1",[pb]);
 await rejects(run(api,T.id,"update lara.payroll_batches set state='approved',approved_by=$2,approved_at=now() where id=$1",[pb,ctrl]),/check constraint|violates/,'batch approved by its importer');
 await run(api,T.id,"update lara.payroll_batches set state='approved',approved_by=$2,approved_at=now() where id=$1",[pb,dir]);
 await run(api,T.id,"update lara.payroll_batches set state='posted',entry_id=$2 where id=$1",[pb,randomUUID()]);
 const pb2=(await run(api,T.id,pbSql,[T.id,entity,'2026-10',hash('f2'),ev,ctrl])).rows[0].id;
 await run(api,T.id,"update lara.payroll_batches set state='reconciled' where id=$1",[pb2]);await run(api,T.id,"update lara.payroll_batches set state='approved',approved_by=$2,approved_at=now() where id=$1",[pb2,dir]);
 await rejects(run(api,T.id,"update lara.payroll_batches set state='posted',entry_id=$2 where id=$1",[pb2,randomUUID()]),/duplicate key/,'a source and period posts once');
 const rmSql="insert into lara.remittance_records(tenant_id,entity_id,batch_id,agency,period_key,amount,due_date,created_by) values($1,$2,$3,'SSS','2026-10',3000,'2026-11-15',$4) returning id";
 const rm=(await run(api,T.id,rmSql,[T.id,entity,pb,ctrl])).rows[0].id;
 await rejects(run(api,T.id,rmSql,[T.id,entity,pb,ctrl]),/duplicate key/,'agency and period twice for the batch');
 await run(api,T.id,"update lara.remittance_records set state='approved',approved_by=$2,approved_at=now() where id=$1",[rm,dir]);
 await rejects(run(api,T.id,"update lara.remittance_records set state='remitted' where id=$1",[rm]),/check constraint|violates/,'remitted without a reference and evidence');
 await run(api,T.id,"update lara.remittance_records set state='remitted',reference='SSS-REF-1',evidence_ids=$2 where id=$1",[rm,ev]);
 await rejects(run(api,T.id,"update lara.remittance_records set state='due' where id=$1",[rm]),/final/,'remitted remittance reopened');
 pass('payroll batches are unique per file, approved by another principal, posted once per source and period with an entry; records are unique per line and append-only; remittances are unique per agency, period and batch and remitted only with a reference and evidence');

 const loSql="insert into lara.local_obligations(tenant_id,entity_id,authority,authority_profile_version,kind,property_ref,period_key,due_date,amount,requires_filing,content_hash,created_by) values($1,$2,'Makati City','lgu-2026',$3,$4,'2026',$5,$6,$7,$8,$9) returning id";
 const lo=(await run(api,T.id,loSql,[T.id,entity,'real_property_tax','TD-001','2026-03-31',12000,true,hash('lo1'),ctrl])).rows[0].id;
 await rejects(run(api,T.id,loSql,[T.id,entity,'real_property_tax','TD-001','2026-03-31',12000,true,hash('lo2'),ctrl]),/duplicate key/,'authority, kind, period and property twice');
 await run(api,T.id,loSql,[T.id,entity,'real_property_tax','TD-002','2026-03-31',9000,true,hash('lo3'),ctrl]);
 await rejects(run(api,T.id,"update lara.local_obligations set state='complete',completed_by=$2,completed_at=now() where id=$1",[lo,dir]),/check constraint|violates/,'complete without payment evidence');
 await rejects(run(api,T.id,"update lara.local_obligations set state='complete',completed_by=$2,completed_at=now(),payment_evidence_ids=$3 where id=$1",[lo,dir,ev]),/check constraint|violates/,'complete without the filing evidence the authority requires');
 await run(api,T.id,"update lara.local_obligations set state='complete',completed_by=$2,completed_at=now(),payment_evidence_ids=$3,filing_evidence_ids=$3 where id=$1",[lo,dir,ev]);
 await rejects(run(api,T.id,"update lara.local_obligations set state='open' where id=$1",[lo]),/final/,'complete obligation reopened');
 pass('local obligations are unique per authority, kind, period and property, complete only with payment evidence and, where required, filing evidence, and final once complete');

 for(const table of ['lease_contracts','lease_events','discount_eligibility','discount_lines','channels','payout_batches','pos_machines','pos_closings','payroll_batches','employee_tax_records','remittance_records','local_obligations'])assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 await rejects(run(api,other.id,chSql,[T.id,entity,'INTRUDER',ar,fees,wht,clearing,hash('c9'),ctrl]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['lease_contracts','payout_batches','payroll_batches','employee_tax_records','local_obligations'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security keeps local operations records in their tenant; the runtime role cannot delete them');
 console.log('P17-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
