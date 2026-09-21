// P05-01 purchasing schema acceptance against real PostgreSQL through the
// runtime role: supplier references are unique per supplier while the bill
// lives, beneficiary versions are reviewed by another principal with one
// approved version per party and immutable once reviewed, payment orders
// follow the published state machine and need evidence for release and
// settlement, advances liquidate only from posted settlements within their
// balance through append-only events, certificates are immutable once issued,
// supplier credits allocate on the payable side, and row-level security
// isolates every table. Test tenants are removed at the end.
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
const T={id:randomUUID(),slug:'p02-test-purch-'+suffix};
const other={id:randomUUID(),slug:'p02-test-purch-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 // Fixture: entity, branch, primary PHP book, two principals, a supplier and an employee, a withholding rule, AC-03 chart, an open period and available evidence.
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Purchasing schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Preparer') returning id",[T.id,'preparer-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Approver') returning id",[T.id,'approver-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Purchasing entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const supplier=(await run(api,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Supplies Inc','unknown','active',$3,$4) returning id",[T.id,entity,hash('s'),principal])).rows[0].id;
 const employee=(await run(api,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Juan Dela Cruz','unknown','active',$3,$4) returning id",[T.id,entity,hash('emp'),principal])).rows[0].id;
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'si.pdf',$4,'application/pdf',10,'available','internal',$5) returning id",[T.id,entity,'k-'+suffix,hash('pdf'),principal])).rows[0].id;
 const acct=async(code,name,category,extra={})=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11) returning id",[T.id,entity,book,code,name,category,category==='asset'||category==='expense'?'debit':'credit',extra.control||'none',!extra.control,hash(code),principal])).rows[0].id;
 const cash=await acct('1010','Cash','asset');await acct('1300','Input tax','asset',{control:'input_tax'});const ap=await acct('2100','Payables','liability',{control:'ap'});await acct('5000','Professional fees','expense');
 await run(api,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-09-01','2026-09-30',$4)",[T.id,entity,book,principal]);
 const ewt=(await run(api,T.id,"insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,source_evidence_ids,golden_case_ids,content_hash,created_by,status,approved_by,activated_by,activated_at) values($1,$2,'EWT2',1,'withholding','2026-01-01',0.02,'net','accrual','line_half_up',$3,'[\"AC-03\"]',$4,$5,'active',$6,$6,now()) returning id",[T.id,entity,JSON.stringify([evidence]),hash('ewt'),principal,approver])).rows[0].id;
 const post=(lines,sourceId=randomUUID(),sourceType='settlement')=>run(api,T.id,'select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:T.id,entityId:entity,bookId:book,sourceType,sourceId,sourceVersion:1,accountingDate:'2026-09-18',documentDate:'2026-09-18',description:'Module posting',currency:'PHP',manual:false,postingActor:principal,lines})]);
 pass('fixture tenant with entity, branch, book, two principals, supplier and employee, withholding rule, AC-03 chart, an open period and available evidence');

 // Bills: supplier reference unique per supplier while not cancelled; withholding bounded and rule-backed.
 const bill=async(over={})=>(await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,net,tax,gross,withholding,withholding_rule_version_id,supplier_reference_normalized,external_reference,rule_profile_version,payload_hash,created_by,state) values($1,$2,$3,'bill',$4,$5,'2026-09-18','2026-09-18','PHP',10000,1200,11200,$6,$7,$8,$9,'tax-2026',$10,$11,$12) returning id",[T.id,entity,book,branch,over.party||supplier,over.withholding??200,over.withholding===0?null:ewt,over.ref??'si0001',over.ref??'SI-0001',hash(randomUUID()),principal,over.state||'draft'])).rows[0].id;
 const bill1=await bill();
 await rejects(bill(),/documents_supplier_reference|duplicate key/,'same normalized supplier reference twice');
 const cancelledBill=await bill({ref:'si0002'});await run(api,T.id,"update lara.documents set state='cancelled' where id=$1",[cancelledBill]);
 const reused=await bill({ref:'si0002'});assert.ok(reused,'a cancelled bill releases its reference');
 await rejects(bill({ref:'si0003',withholding:20000}),/documents_withholding_bounds|violates/,'withholding above net');
 await rejects(run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,net,tax,gross,withholding,rule_profile_version,payload_hash,created_by) values($1,$2,$3,'bill',$4,$5,'2026-09-18','2026-09-18','PHP',100,0,100,2,'x',$6,$7)",[T.id,entity,book,branch,supplier,hash('w'),principal]),/documents_withholding_needs_rule|violates/,'withholding without a rule version');
 pass('supplier references are unique per supplier while the bill is not cancelled; withholding is bounded by the net and backed by a rule version');

 // Beneficiary versions
 const ben=async(over={})=>(await run(api,T.id,"insert into lara.beneficiary_versions(tenant_id,entity_id,party_id,version_number,bank_name,account_name,account_number_encrypted,account_number_last4,content_hash,created_by,status,reviewed_by) values($1,$2,$3,$4,'BDO','Supplies Inc','enc','7890',$5,$6,$7,$8) returning id",[T.id,entity,over.party||supplier,over.version||1,hash(String(over.version||1)),principal,over.status||'draft',over.reviewedBy||null])).rows[0].id;
 const b1=await ben();
 await rejects(ben(),/duplicate key/,'same party and version number twice');
 await rejects(run(api,T.id,"update lara.beneficiary_versions set status='approved',reviewed_by=$2 where id=$1",[b1,principal]),/check constraint|violates/,'reviewer equal to the author');
 await rejects(run(api,T.id,"update lara.beneficiary_versions set status='approved' where id=$1",[b1]),/check constraint|violates/,'approval without a reviewer');
 await rejects(run(api,T.id,"update lara.beneficiary_versions set status='superseded' where id=$1",[b1]),/cannot move from draft/,'draft straight to superseded');
 await run(api,T.id,"update lara.beneficiary_versions set status='approved',reviewed_by=$2 where id=$1",[b1,approver]);
 await rejects(run(api,T.id,"update lara.beneficiary_versions set account_number_encrypted='other' where id=$1",[b1]),/immutable/,'approved bank details edited');
 const b2=await ben({version:2});
 await rejects(run(api,T.id,"update lara.beneficiary_versions set status='approved',reviewed_by=$2 where id=$1",[b2,approver]),/beneficiary_versions_one_approved|duplicate key/,'two approved versions per party');
 await run(api,T.id,"update lara.beneficiary_versions set status='superseded' where id=$1",[b1]);
 await run(api,T.id,"update lara.beneficiary_versions set status='approved',reviewed_by=$2 where id=$1",[b2,approver]);
 await rejects(run(api,T.id,"update lara.beneficiary_versions set status='draft' where id=$1",[b1]),/cannot move from superseded/,'superseded reopened');
 pass('beneficiary versions are approved by another principal, one approved per party, immutable once reviewed and never reopened');

 // Payment orders: state machine, evidence for release and settlement, authority binding, one live order per settlement.
 const settlement=async(over={})=>(await run(api,T.id,"insert into lara.settlements(tenant_id,entity_id,book_id,direction,party_id,payment_method,currency,gross_amount,cash_amount,withholding_amount,value_date,payload_hash,created_by,state) values($1,$2,$3,'payment',$4,'transfer','PHP',$5,$5,0,'2026-09-25',$6,$7,$8) returning id",[T.id,entity,book,over.party||supplier,over.amount||11000,hash(randomUUID()),principal,over.state||'submitted'])).rows[0].id;
 const s1=await settlement();
 const order=async(over={})=>(await run(api,T.id,"insert into lara.payment_orders(tenant_id,entity_id,settlement_id,beneficiary_version_id,scheduled_date,created_by) values($1,$2,$3,$4,'2026-09-26',$5) returning id",[T.id,entity,over.settlement||s1,over.beneficiary||b2,principal])).rows[0].id;
 const o1=await order();
 await rejects(order(),/payment_orders_one_live|duplicate key/,'second live order on one settlement');
 await rejects(run(api,T.id,"update lara.payment_orders set state='authorized',authorized_by=$2,authorized_settlement_version=1 where id=$1",[o1,approver]),/cannot move from draft to authorized/,'draft straight to authorized');
 await run(api,T.id,"update lara.payment_orders set state='submitted',submitted_by=$2 where id=$1",[o1,principal]);
 await rejects(run(api,T.id,"update lara.payment_orders set state='authorized',authorized_by=$2,authorized_settlement_version=1 where id=$1",[o1,principal]),/check constraint|violates/,'authority by the preparer');
 await rejects(run(api,T.id,"update lara.payment_orders set state='authorized' where id=$1",[o1]),/check constraint|violates/,'authorized without an authorizer');
 await run(api,T.id,"update lara.payment_orders set state='authorized',authorized_by=$2,authorized_settlement_version=1 where id=$1",[o1,approver]);
 await rejects(run(api,T.id,"update lara.payment_orders set beneficiary_version_id=$2 where id=$1",[o1,b1]),/returns to draft first/,'beneficiary changed on an authorized order');
 await rejects(run(api,T.id,"update lara.payment_orders set state='settled' where id=$1",[o1]),/cannot move from authorized to settled|check constraint|violates/,'settled without release');
 await rejects(run(api,T.id,"update lara.payment_orders set state='released' where id=$1",[o1]),/check constraint|violates/,'released without channel, reference and evidence');
 await rejects(run(api,T.id,"update lara.payment_orders set state='released',release_channel='manual',release_reference='TXN-1',release_evidence_ids='[]',released_by=$2,released_at=now() where id=$1",[o1,principal]),/check constraint|violates/,'released without evidence');
 await run(api,T.id,"update lara.payment_orders set state='released',release_channel='manual',release_reference='TXN-1',release_evidence_ids=$3,released_by=$2,released_at=now() where id=$1",[o1,principal,JSON.stringify([evidence])]);
 await rejects(run(api,T.id,"update lara.payment_orders set release_reference='TXN-2' where id=$1",[o1]),/release evidence is immutable/,'release reference edited');
 await rejects(run(api,T.id,"update lara.payment_orders set state='settled',settle_reference='BANK-1',settled_at=now(),settle_value_date='2026-09-26',settled_by=$2 where id=$1",[o1,principal]),/check constraint|violates/,'settled without evidence');
 await run(api,T.id,"update lara.payment_orders set state='settled',settle_reference='BANK-1',settled_at=now(),settle_value_date='2026-09-26',settle_evidence_ids=$3,settled_by=$2 where id=$1",[o1,principal,JSON.stringify([evidence])]);
 await rejects(run(api,T.id,"update lara.payment_orders set settle_reference='BANK-2' where id=$1",[o1]),/settlement evidence is immutable/,'settlement reference edited');
 await rejects(run(api,T.id,"update lara.payment_orders set state='released' where id=$1",[o1]),/cannot move from settled/,'settled back to released');
 await run(api,T.id,"update lara.payment_orders set state='returned' where id=$1",[o1]);
 await rejects(run(api,T.id,"update lara.payment_orders set state='settled' where id=$1",[o1]),/terminal in state returned/,'returned reopened');
 const s2=await settlement();const o2=await order({settlement:s2});
 await run(api,T.id,"update lara.payment_orders set state='submitted',submitted_by=$2 where id=$1",[o2,principal]);
 await run(api,T.id,"update lara.payment_orders set state='draft',submitted_by=null where id=$1",[o2]);
 await run(api,T.id,"update lara.payment_orders set state='cancelled' where id=$1",[o2]);
 const o2b=await order({settlement:s2});assert.ok(o2b,'a cancelled order frees the settlement');
 pass('payment orders follow draft → submitted → authorized → released → settled → returned with an authorizer distinct from the preparer, immutable release and settlement evidence, one live order per settlement, and terminal states');

 // Advances: only posted settlements liquidate, events never exceed the balance, status derives from events, events are append-only.
 const advSettlement=await settlement({party:employee,amount:10000,state:'approved'});
 const adv=(await run(api,T.id,"insert into lara.advances(tenant_id,entity_id,party_id,settlement_id,amount,currency,created_by) values($1,$2,$3,$4,10000,'PHP',$5) returning id",[T.id,entity,employee,advSettlement,principal])).rows[0].id;
 const claim=await bill({party:employee,ref:'claim1',withholding:0});
 const liquidate=(amount,document=claim)=>run(api,T.id,"insert into lara.advance_events(tenant_id,entity_id,advance_id,kind,amount,document_id,created_by) values($1,$2,$3,'liquidation',$4,$5,$6)",[T.id,entity,adv,amount,document,principal]);
 await rejects(liquidate(6000),/only posted advances liquidate/,'liquidating before the advance settlement posted');
 const entry=(await post([{accountId:cash,branchId:branch,dimensions:{},debit:'0',credit:'10000'},{accountId:ap,branchId:branch,dimensions:{},debit:'10000',credit:'0'}],advSettlement)).rows[0].id;
 await run(api,T.id,"update lara.settlements set state='posted',posted_entry_id=$2 where id=$1",[advSettlement,entry]);
 await rejects(run(api,T.id,"insert into lara.advance_events(tenant_id,entity_id,advance_id,kind,amount,created_by) values($1,$2,$3,'liquidation',1,$4)",[T.id,entity,adv,principal]),/check constraint|violates/,'liquidation without a claim document');
 await rejects(liquidate(10001),/ALLOCATION_EXCEEDS_BALANCE/,'liquidating beyond the advance');
 await liquidate(6000);
 await rejects(liquidate(1000),/advance_events_one_liquidation_per_claim|duplicate key/,'one claim liquidating twice');
 assert.equal((await run(api,T.id,'select status from lara.advances where id=$1',[adv])).rows[0].status,'partially_liquidated');
 await rejects(liquidate(4001,await bill({party:employee,ref:'claim2',withholding:0})),/ALLOCATION_EXCEEDS_BALANCE/,'second claim beyond the remainder');
 await run(api,T.id,"insert into lara.advance_events(tenant_id,entity_id,advance_id,kind,amount,settlement_id,created_by) values($1,$2,$3,'return',4000,$4,$5)",[T.id,entity,adv,advSettlement,principal]);
 assert.equal((await run(api,T.id,'select status from lara.advances where id=$1',[adv])).rows[0].status,'closed');
 await rejects(run(api,T.id,"update lara.advances set amount=1 where id=$1",[adv]),/immutable/,'advance amount edited');
 await rejects(run(api,T.id,"delete from lara.advance_events where advance_id=$1",[adv]),/permission denied|APPEND_ONLY/,'advance events deleted');
 await run(api,T.id,"insert into lara.expense_claims(document_id,tenant_id,entity_id,employee_party_id,advance_id,policy_version) values($1,$2,$3,$4,$5,'expense-2026')",[claim,T.id,entity,employee,adv]);
 await rejects(run(api,T.id,"update lara.expense_claims set employee_party_id=$2 where document_id=$1",[claim,supplier]),/immutable/,'claim employee changed');
 pass('advances liquidate only from posted settlements, never beyond their balance, once per claim, close through append-only events and keep their identity');

 // Receipts of service and withholding certificates
 const po=(await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,net,tax,gross,rule_profile_version,payload_hash,created_by,state) values($1,$2,$3,'purchase_order',$4,$5,'2026-09-18','2026-09-18','PHP',20000,0,20000,'tax-2026',$6,$7,'approved') returning id",[T.id,entity,book,branch,supplier,hash('po'),principal])).rows[0].id;
 const receipt=(await run(api,T.id,"insert into lara.receipts_of_service(tenant_id,entity_id,order_id,evidence_id,accepted_by,lines_json,total,created_by) values($1,$2,$3,$4,$5,'[{\"lineNo\":1,\"amount\":\"20000\"}]',20000,$5) returning id",[T.id,entity,po,evidence,principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.receipts_of_service(tenant_id,entity_id,order_id,evidence_id,accepted_by,lines_json,total,created_by) values($1,$2,$3,$4,$5,'[]',1,$5)",[T.id,entity,po,evidence,principal]),/check constraint|violates/,'receipt without lines');
 await rejects(run(api,T.id,"update lara.receipts_of_service set total=1 where id=$1",[receipt]),/permission denied|APPEND_ONLY/,'receipt edited');
 await run(api,T.id,"update lara.documents set state='submitted',submitted_by=$2 where id=$1",[bill1,principal]);
 await run(api,T.id,"update lara.documents set state='approved',approved_by=$2,approved_version=1 where id=$1",[bill1,approver]);
 const billEntry=(await post([{accountId:ap,branchId:branch,dimensions:{},debit:'0',credit:'11000'},{accountId:cash,branchId:branch,dimensions:{},debit:'11000',credit:'0'}],bill1,'document')).rows[0].id;
 await run(api,T.id,"update lara.documents set state='posted',posted_entry_id=$2,posted_by=$3,posted_at=now(),withholding_recognition='accrual' where id=$1",[bill1,billEntry,approver]);
 await rejects(run(api,T.id,"update lara.documents set withholding=1 where id=$1",[bill1]),/immutable/,'posted withholding edited');
 await rejects(run(api,T.id,"update lara.documents set supplier_reference_normalized='x' where id=$1",[bill1]),/immutable/,'posted supplier reference edited');
 const ev=(await run(api,T.id,"insert into lara.tax_events(tenant_id,entity_id,document_id,tax_rule_version_id,tax_point,recognition,basis,amount,recognition_entry_id) values($1,$2,$3,$4,'2026-09-18','accrual',10000,200,$5) returning id",[T.id,entity,bill1,ewt,billEntry])).rows[0].id;
 const cert=(await run(api,T.id,"insert into lara.withholding_certificates(tenant_id,entity_id,party_id,period_key,version_number,tax_rule_version_id,basis_total,tax_total,tax_event_ids,output_version,checksum,created_by) values($1,$2,$3,'2026-Q3',1,$4,10000,200,$5,'wht-certificate-1',$6,$7) returning id",[T.id,entity,supplier,ewt,JSON.stringify([ev]),hash('cert'),principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.withholding_certificates(tenant_id,entity_id,party_id,period_key,version_number,tax_rule_version_id,basis_total,tax_total,tax_event_ids,output_version,checksum,created_by) values($1,$2,$3,'2026-13',1,$4,1,1,$5,'v','x',$6)",[T.id,entity,supplier,ewt,JSON.stringify([ev]),principal]),/check constraint|violates/,'malformed period or checksum');
 await rejects(run(api,T.id,"update lara.withholding_certificates set status='issued' where id=$1",[cert]),/cannot move from draft|check constraint|violates/,'issued without review');
 await rejects(run(api,T.id,"update lara.withholding_certificates set status='reviewed',reviewed_by=$2 where id=$1",[cert,principal]),/check constraint|violates/,'reviewed by the preparer');
 await run(api,T.id,"update lara.withholding_certificates set status='reviewed',reviewed_by=$2 where id=$1",[cert,approver]);
 await run(api,T.id,"update lara.withholding_certificates set status='issued' where id=$1",[cert]);
 await rejects(run(api,T.id,"update lara.withholding_certificates set tax_total=1 where id=$1",[cert]),/immutable/,'issued certificate edited');
 await rejects(run(api,T.id,"update lara.withholding_certificates set status='draft' where id=$1",[cert]),/cannot move from issued/,'issued certificate reopened');
 pass('receipts of service are evidence-backed append-only facts; posted bills keep their withholding and supplier reference; certificates are reviewed by another principal and immutable once issued');

 // Supplier credits allocate on the payable side within gross net of withholding.
 const item=(await run(api,T.id,"insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AP',$4,11000,'PHP','2026-10-18') returning id",[T.id,entity,bill1,supplier])).rows[0].id;
 const credit=(await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,net,tax,gross,withholding,withholding_rule_version_id,source_document_id,rule_profile_version,payload_hash,created_by,state,posted_entry_id,posted_by,posted_at,approved_version,approved_by) values($1,$2,$3,'credit_note',$4,$5,'2026-09-20','2026-09-20','PHP',2000,240,2240,40,$6,$7,'tax-2026',$8,$9,'posted',$10,$11,now(),1,$11) returning id",[T.id,entity,book,branch,supplier,ewt,bill1,hash('cn'),principal,billEntry,approver])).rows[0].id;
 const applyCredit=amount=>run(api,T.id,"insert into lara.allocation_events(tenant_id,entity_id,credit_document_id,open_item_id,amount,action) values($1,$2,$3,$4,$5,'apply')",[T.id,entity,credit,item,amount]);
 await rejects(applyCredit(2201),/ALLOCATION_EXCEEDS_BALANCE/,'supplier credit beyond gross net of withholding');
 await applyCredit(2200);
 assert.equal((await run(api,T.id,'select status from lara.open_items where id=$1',[item])).rows[0].status,'partially_settled');
 const arItem=(await run(api,T.id,"insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AR',$4,100,'PHP','2026-10-18') returning id",[T.id,entity,reused,supplier])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.allocation_events(tenant_id,entity_id,credit_document_id,open_item_id,amount,action) values($1,$2,$3,$4,1,'apply')",[T.id,entity,credit,arItem]),/receipts settle receivables and payments settle payables/,'supplier credit applied to a receivable');
 pass('a posted supplier credit allocates against the payable up to its gross net of withholding and never against a receivable');

 if(worker){
  await rejects(run(worker,T.id,"insert into lara.payment_orders(tenant_id,entity_id,settlement_id,beneficiary_version_id,scheduled_date,created_by) values($1,$2,$3,$4,'2026-09-26',$5)",[T.id,entity,s2,b2,principal]),/permission denied/,'worker creating payment orders');
  await rejects(run(worker,T.id,"insert into lara.advance_events(tenant_id,entity_id,advance_id,kind,amount,settlement_id,created_by) values($1,$2,$3,'return',1,$4,$5)",[T.id,entity,adv,advSettlement,principal]),/permission denied/,'worker moving advances');
  await run(worker,T.id,"update lara.withholding_certificates set evidence_id=$2 where id=$1",[cert,evidence]);
  pass('the worker cannot create payments or move advances; it may attach the rendered certificate evidence');
 }

 // Isolation
 for(const table of ['receipts_of_service','beneficiary_versions','payment_orders','advances','advance_events','expense_claims','withholding_certificates'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.payment_orders')).rows[0].n,0,'payment orders visible without a tenant');
 await rejects(run(api,other.id,"insert into lara.beneficiary_versions(tenant_id,entity_id,party_id,version_number,bank_name,account_name,account_number_encrypted,account_number_last4,content_hash,created_by) values($1,$2,$3,9,'X','Y','enc','1234',$4,$5)",[T.id,entity,supplier,hash('x'),principal]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['payment_orders','beneficiary_versions','advances','withholding_certificates'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security isolates tenants on every purchasing table and the runtime role cannot delete payments, beneficiaries, advances or certificates');
 console.log('P05-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end(),worker?.end()]);
}
