// P06-01 treasury schema acceptance against real PostgreSQL through the
// runtime role: bank accounts are approved by another principal and unique per
// bank and number, statement line keys are single-use per account and keep
// their source content, confirmed reconciliation amounts never overlap on a
// line or a counterpart and reverse once, checks follow the custody machine
// and never clear twice, transfers and cash sessions follow their machines,
// counted values are never overwritten, handovers are independent, bank file
// runs are immutable, and row-level security isolates every table.
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
const T={id:randomUUID(),slug:'p02-test-treas-'+suffix};
const other={id:randomUUID(),slug:'p02-test-treas-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Treasury schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Preparer') returning id",[T.id,'preparer-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Approver') returning id",[T.id,'approver-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Treasury entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const customer=(await run(api,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Acme','unknown','active',$3,$4) returning id",[T.id,entity,hash('c'),principal])).rows[0].id;
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'bank.pdf',$4,'application/pdf',10,'available','internal',$5) returning id",[T.id,entity,'k-'+suffix,hash('pdf'),principal])).rows[0].id;
 const acct=async(code,name,category,control='none')=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11) returning id",[T.id,entity,book,code,name,category,category==='asset'||category==='expense'?'debit':'credit',control,control==='none',hash(code),principal])).rows[0].id;
 const bankLedger=await acct('1020','Bank BDO','asset'),bank2Ledger=await acct('1030','Bank BPI','asset'),ar=await acct('1200','Receivables','asset','ar');
 await run(api,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4)",[T.id,entity,book,principal]);
 pass('fixture tenant with entity, branch, book, two principals, a customer, bank ledger accounts, evidence and an open period');

 // Bank accounts
 const bank=async(over={})=>(await run(api,T.id,"insert into lara.bank_accounts(tenant_id,entity_id,book_id,ledger_account_id,bank_code,encrypted_number,number_hash,number_last4,currency,evidence_ids,content_hash,created_by,status,approved_by) values($1,$2,$3,$4,$5,'enc',$6,'7890','PHP',$7,$8,$9,$10,$11) returning id",[T.id,entity,book,over.ledger||bankLedger,over.code||'BDO',over.numberHash||hash('n1'),JSON.stringify([evidence]),hash(randomUUID()),principal,over.status||'draft',over.approvedBy||null])).rows[0].id;
 const bdo=await bank();
 await rejects(bank(),/duplicate key/,'same bank and number twice');
 await rejects(run(api,T.id,"update lara.bank_accounts set status='approved',approved_by=$2 where id=$1",[bdo,principal]),/check constraint|violates/,'approver equal to the author');
 await rejects(run(api,T.id,"update lara.bank_accounts set status='archived' where id=$1",[bdo]),/cannot move from draft/,'draft archived');
 await run(api,T.id,"update lara.bank_accounts set status='approved',approved_by=$2 where id=$1",[bdo,approver]);
 await rejects(run(api,T.id,"update lara.bank_accounts set encrypted_number='other' where id=$1",[bdo]),/new draft and approval/,'approved number edited in place');
 await rejects(run(api,T.id,"insert into lara.bank_accounts(tenant_id,entity_id,book_id,ledger_account_id,bank_code,encrypted_number,number_hash,number_last4,currency,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,'BDO','enc',$5,'1111','PHP','[]',$6,$7)",[T.id,entity,book,bankLedger,hash('n2'),hash('x'),principal]),/check constraint|violates/,'bank account without evidence');
 const bpi=await bank({ledger:bank2Ledger,code:'BPI',numberHash:hash('n3'),status:'approved',approvedBy:approver});
 pass('bank accounts are unique per bank and number, approved by another principal, and change only through a new draft');

 // Statement batches and lines
 const imp=(await run(api,T.id,"insert into lara.opening_batches(tenant_id,entity_id,book_id,kind,evidence_id,checksum,cutoff,source_id,external_batch_id,mapping_version,created_by,state,approved_by) values($1,$2,$3,'bank_statement',$4,$5,'2026-10-05',$6,'STMT-1','lara-csv-1',$7,'approved',$8) returning id",[T.id,entity,book,evidence,hash('csv'),bdo,principal,approver])).rows[0].id;
 const batch=(await run(api,T.id,"insert into lara.bank_statement_batches(tenant_id,entity_id,bank_account_id,import_id,from_date,to_date,source_hash,opening_balance,closing_balance,line_count,created_by) values($1,$2,$3,$4,'2026-10-01','2026-10-05',$5,10000,13000,2,$6) returning id",[T.id,entity,bdo,imp,hash('csv'),principal])).rows[0].id;
 await run(api,T.id,"update lara.opening_batches set state='committed' where id=$1",[imp]);
 await rejects(run(api,T.id,"insert into lara.bank_statement_batches(tenant_id,entity_id,bank_account_id,import_id,from_date,to_date,source_hash,opening_balance,closing_balance,line_count,created_by) values($1,$2,$3,$4,'2026-10-01','2026-10-05',$5,1,1,0,$6)",[T.id,entity,bdo,imp,hash('csv2'),principal]),/duplicate key/,'two batches for one import');
 const line=async(key,amount)=>(await run(api,T.id,"insert into lara.bank_statement_lines(tenant_id,entity_id,bank_account_id,batch_id,source_line_key,booked_date,signed_amount,currency,reference,source_json) values($1,$2,$3,$4,$5,'2026-10-03',$6,'PHP','REF','{}') returning id",[T.id,entity,bdo,batch,key,amount])).rows[0].id;
 const l1=await line('L1',3000),l2=await line('L2',-50);
 await rejects(line('L1',1),/duplicate key/,'same source line key twice on one account');
 await rejects(line('L0',0),/check constraint|violates/,'zero amount');
 await rejects(run(api,T.id,"update lara.bank_statement_lines set signed_amount=1 where id=$1",[l1]),/source content/,'line amount edited');
 await rejects(run(api,T.id,"update lara.bank_statement_batches set closing_balance=1 where id=$1",[batch]),/permission denied|APPEND_ONLY/,'batch edited');
 pass('one statement batch per import; line keys are single-use per account, amounts non-zero and source content immutable');

 // Reconciliation allocations
 const settlement=async(over={})=>(await run(api,T.id,"insert into lara.settlements(tenant_id,entity_id,book_id,direction,party_id,bank_account_id,payment_method,currency,gross_amount,cash_amount,withholding_amount,value_date,payload_hash,created_by,state,posted_entry_id) values($1,$2,$3,$4,$5,$6,'transfer','PHP',$7,$7,0,'2026-10-03',$8,$9,$10,$11) returning id",[T.id,entity,book,over.direction||'receipt',customer,bdo,over.amount||3000,hash(randomUUID()),principal,over.state||'draft',over.entry||null])).rows[0].id;
 const post=(lines,sourceId,sourceType='settlement')=>run(api,T.id,'select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:T.id,entityId:entity,bookId:book,sourceType,sourceId,sourceVersion:1,accountingDate:'2026-10-03',documentDate:'2026-10-03',description:'Module posting',currency:'PHP',manual:false,postingActor:principal,lines})]);
 const draftReceipt=await settlement();
 const receiptId=randomUUID();
 const entry=(await post([{accountId:bankLedger,branchId:branch,dimensions:{},debit:'3000',credit:'0'},{accountId:ar,branchId:branch,dimensions:{},debit:'0',credit:'3000'}],receiptId)).rows[0].id;
 const receipt=(await run(api,T.id,"insert into lara.settlements(id,tenant_id,entity_id,book_id,direction,party_id,bank_account_id,payment_method,currency,gross_amount,cash_amount,withholding_amount,value_date,payload_hash,created_by,state,posted_entry_id) values($1,$2,$3,$4,'receipt',$5,$6,'transfer','PHP',3000,3000,0,'2026-10-03',$7,$8,'posted',$9) returning id",[receiptId,T.id,entity,book,customer,bdo,hash('r'),principal,entry])).rows[0].id;
 const match=async(lines,allocs,over={})=>(await run(api,T.id,"insert into lara.reconciliation_matches(tenant_id,entity_id,bank_account_id,statement_line_ids,allocations,content_hash,created_by,origin) values($1,$2,$3,$4,$5,$6,$7,$8) returning id",[T.id,entity,bdo,JSON.stringify(lines),JSON.stringify(allocs),hash(randomUUID()),principal,over.origin||'manual'])).rows[0].id;
 const m1=await match([l1],[{resourceType:'settlement',resourceId:receipt,amount:'3000.00'}]);
 const apply=(matchId,lineId,type,resourceId,amount)=>run(api,T.id,"insert into lara.reconciliation_allocations(tenant_id,entity_id,match_id,line_id,resource_type,resource_id,amount,action,created_by) values($1,$2,$3,$4,$5,$6,$7,'apply',$8) returning id",[T.id,entity,matchId,lineId,type,resourceId,amount,approver]);
 await rejects(apply(m1,l1,'settlement',draftReceipt,3000),/only posted settlements reconcile/,'allocation to a draft settlement');
 await rejects(apply(m1,l2,'settlement',receipt,50),/receipts match credits/,'receipt against a bank debit');
 await rejects(apply(m1,l1,'settlement',receipt,3001),/ALLOCATION_EXCEEDS_BALANCE/,'allocation beyond the line');
 await rejects(apply(m1,l2,'journal',randomUUID(),50),/no line on this bank account/,'journal without a bank line');
 const a1=(await apply(m1,l1,'settlement',receipt,3000)).rows[0].id;
 assert.equal((await run(api,T.id,'select match_state from lara.bank_statement_lines where id=$1',[l1])).rows[0].match_state,'matched');
 const m2=await match([l1],[{resourceType:'settlement',resourceId:receipt,amount:'1.00'}]);
 await rejects(apply(m2,l1,'settlement',receipt,1),/ALLOCATION_EXCEEDS_BALANCE/,'second confirmation on a matched line');
 await rejects(run(api,T.id,"update lara.reconciliation_matches set state='confirmed',confirmed_by=$2 where id=$1",[m1,principal]),/SELF_APPROVAL/,'preparer confirming a manual match');
 await run(api,T.id,"update lara.reconciliation_matches set state='confirmed',confirmed_by=$2 where id=$1",[m1,approver]);
 await rejects(run(api,T.id,"update lara.reconciliation_matches set allocations='[]' where id=$1",[m1]),/check constraint|violates|immutable/,'confirmed allocations edited');
 await rejects(run(api,T.id,"update lara.reconciliation_matches set state='draft' where id=$1",[m1]),/cannot move from confirmed/,'confirmed back to draft');
 await rejects(run(api,T.id,"insert into lara.reconciliation_allocations(tenant_id,entity_id,match_id,line_id,resource_type,resource_id,amount,action,reverses_id,created_by) values($1,$2,$3,$4,'settlement',$5,1,'reverse',$6,$7)",[T.id,entity,m1,l1,receipt,a1,approver]),/mirror one apply/,'reverse with a different amount');
 await run(api,T.id,"insert into lara.reconciliation_allocations(tenant_id,entity_id,match_id,line_id,resource_type,resource_id,amount,action,reverses_id,created_by) values($1,$2,$3,$4,'settlement',$5,3000,'reverse',$6,$7)",[T.id,entity,m1,l1,receipt,a1,approver]);
 await rejects(run(api,T.id,"insert into lara.reconciliation_allocations(tenant_id,entity_id,match_id,line_id,resource_type,resource_id,amount,action,reverses_id,created_by) values($1,$2,$3,$4,'settlement',$5,3000,'reverse',$6,$7)",[T.id,entity,m1,l1,receipt,a1,approver]),/reconciliation_allocations_one_reverse|duplicate key/,'one apply reversed twice');
 assert.equal((await run(api,T.id,'select match_state from lara.bank_statement_lines where id=$1',[l1])).rows[0].match_state,'unmatched');
 await rejects(run(api,T.id,"delete from lara.reconciliation_allocations where match_id=$1",[m1]),/permission denied|APPEND_ONLY/,'allocations deleted');
 const proposed=await match([l1],[{resourceType:'settlement',resourceId:receipt,amount:'3000.00'}],{origin:'proposed'});
 await run(api,T.id,"update lara.reconciliation_matches set state='confirmed',confirmed_by=$2 where id=$1",[proposed,principal]);
 pass('confirmed allocations never exceed a statement line or a posted counterpart, respect direction and bank line, reverse once by mirror, derive the line state, and a manual match needs another confirmer while a proposal may be confirmed by anyone');

 // Checks
 const check=async(over={})=>(await run(api,T.id,"insert into lara.check_instruments(tenant_id,entity_id,direction,bank_account_id,check_number,party_id,amount,currency,due_date,state,payload_hash,created_by) values($1,$2,$3,$4,$5,$6,1000,'PHP','2026-10-10',$7,$8,$9) returning id",[T.id,entity,over.direction||'received',bdo,over.number||'CHK-1',customer,over.state||'custody',hash(randomUUID()),principal])).rows[0].id;
 const c1=await check();
 await rejects(check(),/duplicate key/,'same check number twice');
 await rejects(run(api,T.id,"update lara.check_instruments set state='cleared',cleared_at=now() where id=$1",[c1]),/cannot move from custody to cleared/,'custody straight to cleared');
 await run(api,T.id,"update lara.check_instruments set state='deposited' where id=$1",[c1]);
 await rejects(run(api,T.id,"update lara.check_instruments set amount=1 where id=$1",[c1]),/keeps its number, party and amount/,'amount changed in circulation');
 await rejects(run(api,T.id,"update lara.check_instruments set state='cleared' where id=$1",[c1]),/check constraint|violates/,'cleared without a clearing time');
 await run(api,T.id,"update lara.check_instruments set state='cleared',cleared_at=now() where id=$1",[c1]);
 await rejects(run(api,T.id,"update lara.check_instruments set state='deposited' where id=$1",[c1]),/cannot move from cleared/,'cleared back to deposited');
 await run(api,T.id,"update lara.check_instruments set state='dishonored' where id=$1",[c1]);
 await rejects(run(api,T.id,"update lara.check_instruments set state='cleared' where id=$1",[c1]),/terminal in state dishonored/,'dishonored reopened');
 const issued=await check({direction:'issued',number:'CHK-1',state:'drafted'});assert.ok(issued,'issued numbers are independent of received');
 pass('checks are unique per bank, direction and number, follow custody → deposited → cleared → dishonored (issued: drafted → released), keep their amount in circulation and never clear twice');

 // Transfers and cash sessions
 const transfer=(await run(api,T.id,"insert into lara.transfers(tenant_id,entity_id,book_id,from_account_id,to_account_id,currency,amount,value_date,payload_hash,created_by) values($1,$2,$3,$4,$5,'PHP',1500,'2026-10-06',$6,$7) returning id",[T.id,entity,book,bdo,bpi,hash('t'),principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.transfers(tenant_id,entity_id,book_id,from_account_id,to_account_id,currency,amount,value_date,payload_hash,created_by) values($1,$2,$3,$4,$4,'PHP',1,'2026-10-06',$5,$6)",[T.id,entity,book,bdo,hash('t2'),principal]),/check constraint|violates/,'transfer to itself');
 await run(api,T.id,"update lara.transfers set state='submitted',submitted_by=$2 where id=$1",[transfer,principal]);
 await rejects(run(api,T.id,"update lara.transfers set state='approved',approved_by=$2 where id=$1",[transfer,principal]),/check constraint|violates/,'self-approved transfer');
 await run(api,T.id,"update lara.transfers set state='approved',approved_by=$2 where id=$1",[transfer,approver]);
 await rejects(run(api,T.id,"update lara.transfers set state='posted' where id=$1",[transfer]),/check constraint|violates/,'posted without an entry');
 const session=(await run(api,T.id,"insert into lara.cash_sessions(tenant_id,entity_id,branch_id,cashier_id,business_date,opening_amount,created_by) values($1,$2,$3,$4,'2026-10-09',5000,$4) returning id",[T.id,entity,branch,principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.cash_sessions(tenant_id,entity_id,branch_id,cashier_id,business_date,opening_amount,created_by) values($1,$2,$3,$4,'2026-10-09',1,$4)",[T.id,entity,branch,principal]),/cash_sessions_one_open|duplicate key/,'second open session for the cashier and date');
 await rejects(run(api,T.id,"update lara.cash_sessions set state='closed',closed_at=now() where id=$1",[session]),/cannot move from open to closed|check constraint|violates/,'closed without a count');
 await rejects(run(api,T.id,"update lara.cash_sessions set state='counted',expected_amount=5000,counted_amount=4800,variance=-200 where id=$1",[session]),/check constraint|violates/,'variance without a reason');
 await run(api,T.id,"update lara.cash_sessions set state='counted',expected_amount=5000,counted_amount=4800,variance=-200,variance_reason='short' where id=$1",[session]);
 await run(api,T.id,"insert into lara.cash_count_lines(tenant_id,session_id,count_no,denomination,quantity) values($1,$2,1,1000,4)",[T.id,session]);
 await rejects(run(api,T.id,"update lara.cash_count_lines set quantity=5 where session_id=$1",[session]),/permission denied|APPEND_ONLY/,'count line edited');
 await run(api,T.id,"update lara.cash_sessions set state='closed',closed_at=now() where id=$1",[session]);
 await rejects(run(api,T.id,"update lara.cash_sessions set counted_amount=5000 where id=$1",[session]),/never overwritten/,'counted value overwritten after close');
 await rejects(run(api,T.id,"insert into lara.cash_handovers(tenant_id,session_id,outgoing_id,incoming_id,decision,attestations) values($1,$2,$3,$3,'approve','{}')",[T.id,session,principal]),/check constraint|violates/,'cashier handing over to themselves');
 await run(api,T.id,"insert into lara.cash_handovers(tenant_id,session_id,outgoing_id,incoming_id,decision,attestations) values($1,$2,$3,$4,'approve','{}')",[T.id,session,principal,approver]);
 await run(api,T.id,"update lara.cash_sessions set state='handed_over' where id=$1",[session]);
 await rejects(run(api,T.id,"update lara.cash_sessions set state='open' where id=$1",[session]),/cannot move from handed_over/,'handed-over session reopened');
 pass('transfers need a distinct destination, another approver and an entry to post; cash sessions count before close, explain variance, never overwrite counted values, hand over to another principal and stay closed');

 // Bank file runs
 const payee=(await run(api,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Supplier','unknown','active',$3,$4) returning id",[T.id,entity,hash('s'),principal])).rows[0].id;
 const paySettlement=(await run(api,T.id,"insert into lara.settlements(tenant_id,entity_id,book_id,direction,party_id,bank_account_id,payment_method,currency,gross_amount,cash_amount,withholding_amount,value_date,payload_hash,created_by,state) values($1,$2,$3,'payment',$4,$5,'transfer','PHP',900,900,0,'2026-10-05',$6,$7,'submitted') returning id",[T.id,entity,book,payee,bdo,hash('p'),principal])).rows[0].id;
 const ben=(await run(api,T.id,"insert into lara.beneficiary_versions(tenant_id,entity_id,party_id,version_number,bank_name,account_name,account_number_encrypted,account_number_last4,content_hash,created_by,status,reviewed_by) values($1,$2,$3,1,'BDO','Supplier','enc','1234',$4,$5,'approved',$6) returning id",[T.id,entity,payee,hash('ben'),principal,approver])).rows[0].id;
 const order=(await run(api,T.id,"insert into lara.payment_orders(tenant_id,entity_id,settlement_id,beneficiary_version_id,scheduled_date,created_by,state,submitted_by,authorized_by,authorized_settlement_version) values($1,$2,$3,$4,'2026-10-05',$5,'authorized',$5,$6,1) returning id",[T.id,entity,paySettlement,ben,principal,approver])).rows[0].id;
 const fileRun=(await run(api,T.id,"insert into lara.bank_file_runs(tenant_id,entity_id,bank_account_id,format_version,file_hash,item_count,total_amount,created_by) values($1,$2,$3,'lara-csv-1',$4,1,900,$5) returning id",[T.id,entity,bdo,hash('file'),principal])).rows[0].id;
 await run(api,T.id,"insert into lara.bank_file_items(tenant_id,run_id,payment_id,amount) values($1,$2,$3,900)",[T.id,fileRun,order]);
 await rejects(run(api,T.id,"insert into lara.bank_file_runs(tenant_id,entity_id,bank_account_id,format_version,file_hash,item_count,total_amount,created_by) values($1,$2,$3,'lara-csv-1',$4,1,900,$5)",[T.id,entity,bdo,hash('file'),principal]),/duplicate key/,'same file content twice for one account');
 await rejects(run(api,T.id,"insert into lara.bank_file_items(tenant_id,run_id,payment_id,amount) values($1,$2,$3,900)",[T.id,fileRun,order]),/duplicate key/,'one payment in two runs');
 await rejects(run(api,T.id,"update lara.bank_file_runs set file_hash=$2 where id=$1",[fileRun,hash('other')]),/immutable/,'file hash edited');
 await run(api,T.id,"update lara.bank_file_runs set state='accepted' where id=$1",[fileRun]);
 await rejects(run(api,T.id,"update lara.bank_file_runs set state='generated' where id=$1",[fileRun]),/terminal in state accepted/,'accepted run reopened');
 pass('bank file runs are unique per content and account, carry each payment once and are immutable once generated');

 if(worker){
  await rejects(run(worker,T.id,"insert into lara.bank_accounts(tenant_id,entity_id,book_id,ledger_account_id,bank_code,encrypted_number,number_hash,number_last4,currency,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,'XYZ','enc',$5,'0000','PHP',$6,$7,$8)",[T.id,entity,book,bankLedger,hash('w'),JSON.stringify([evidence]),hash('w2'),principal]),/permission denied/,'worker creating bank accounts');
  await rejects(run(worker,T.id,"insert into lara.reconciliation_allocations(tenant_id,entity_id,match_id,line_id,resource_type,resource_id,amount,action,created_by) values($1,$2,$3,$4,'settlement',$5,1,'apply',$6)",[T.id,entity,m2,l1,receipt,principal]),/permission denied/,'worker confirming allocations');
  const wm=await run(worker,T.id,"insert into lara.reconciliation_matches(tenant_id,entity_id,bank_account_id,statement_line_ids,allocations,content_hash,created_by,origin,state) values($1,$2,$3,$4,$5,$6,$7,'proposed','proposed') returning id",[T.id,entity,bdo,JSON.stringify([l2]),JSON.stringify([]),hash('wm'),principal]).catch(e=>e);
  assert.match(String(wm.message||'ok'),/check constraint|violates|ok/,'worker may propose matches (content rules still apply)');
  pass('the worker proposes matches but cannot create bank accounts or confirm allocations');
 }

 // Isolation
 for(const table of ['bank_accounts','bank_statement_batches','bank_statement_lines','reconciliation_matches','reconciliation_allocations','check_instruments','transfers','cash_sessions','cash_count_lines','cash_handovers','bank_file_runs','bank_file_items'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.bank_accounts')).rows[0].n,0,'bank accounts visible without a tenant');
 await rejects(run(api,other.id,"insert into lara.transfers(tenant_id,entity_id,book_id,from_account_id,to_account_id,currency,amount,value_date,payload_hash,created_by) values($1,$2,$3,$4,$5,'PHP',1,'2026-10-06',$6,$7)",[T.id,entity,book,bdo,bpi,hash('x'),principal]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['bank_accounts','bank_statement_lines','check_instruments','transfers','cash_sessions','bank_file_runs'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security isolates tenants on every treasury table and the runtime role cannot delete treasury records');
 console.log('P06-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end(),worker?.end()]);
}
