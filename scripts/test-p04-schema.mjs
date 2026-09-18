// P04-01 sales and tax kernel schema acceptance against real PostgreSQL through
// the runtime role: approved tax rule versions are immutable with one active
// version per code, official numbers are single-use and never recycled,
// documents carry server-checked totals and an explicit state machine, posted
// documents and their lines are immutable, tax events and allocation events
// are append-only, and open-item balances derive from allocations under
// balance checks. Test tenants are removed at the end.
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
const T={id:randomUUID(),slug:'p02-test-sales-'+suffix};
const other={id:randomUUID(),slug:'p02-test-sales-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
// Runs statements in one transaction so deferred constraint triggers fire at commit.
async function tx(db,tenant,fn){await run(db,tenant,'begin');try{const out=await fn(sql=>db.query(sql.text,sql.values));await db.query('commit');return out;}catch(e){await db.query('rollback');throw e;}}
const q=(text,...values)=>({text,values});
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 // Fixture: entity, branch, primary PHP book, two principals, a customer, AC-01 chart and an open period.
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Sales schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Preparer') returning id",[T.id,'preparer-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Approver') returning id",[T.id,'approver-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Sales entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const customer=(await run(api,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Acme Trading','unknown','active',$3,$4) returning id",[T.id,entity,hash('p'),principal])).rows[0].id;
 const vendor=(await run(api,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Supplies Inc','unknown','active',$3,$4) returning id",[T.id,entity,hash('v'),principal])).rows[0].id;
 const acct=async(code,name,category,extra={})=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11) returning id",[T.id,entity,book,code,name,category,['asset','expense'].includes(category)?'debit':'credit',extra.control||'none',extra.control?false:true,hash(code),principal])).rows[0].id;
 const cash=await acct('1010','Cash','asset');
 const ar=await acct('1200','Accounts receivable','asset',{control:'ar'});
 const outputTax=await acct('2200','Output tax payable','liability',{control:'output_tax'});
 const revenue=await acct('4000','Service revenue','income');
 await run(api,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-09-01','2026-09-30',$4)",[T.id,entity,book,principal]);
 const post=(lines,sourceId=randomUUID())=>run(api,T.id,'select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:T.id,entityId:entity,bookId:book,sourceType:'document',sourceId,sourceVersion:1,accountingDate:'2026-09-18',documentDate:'2026-09-18',description:'Module posting',currency:'PHP',manual:false,postingActor:principal,lines})]).then(r=>r.rows[0].id);
 pass('fixture tenant with entity, branch, book, two principals, parties, AC-01 chart and an open period');

 // Tax rule versions
 const evidence=JSON.stringify([randomUUID()]),cases=JSON.stringify(['AC-01']);
 const rule=async(code,version,extra={})=>(await run(api,T.id,"insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,source_evidence_ids,golden_case_ids,content_hash,created_by) values($1,$2,$3,$4,'vat','2026-01-01',$5,'net','issue','line_half_up',$6,$7,$8,$9) returning id",[T.id,entity,code,version,extra.rate??'0.12',evidence,cases,hash(code+version),principal])).rows[0].id;
 const vat1=await rule('VAT12',1);
 await rejects(rule('VAT12',1),/duplicate key/,'same code and version twice');
 await rejects(rule('BAD',1,{rate:'1.5'}),/check constraint|violates/,'rate above 100%');
 await rejects(run(api,T.id,"insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,source_evidence_ids,golden_case_ids,content_hash,created_by) values($1,$2,'NOEVID',1,'vat','2026-01-01',0.12,'net','issue','line_half_up','[]','[\"AC-01\"]',$3,$4)",[T.id,entity,hash('n'),principal]),/check constraint|violates/,'rule without source evidence');
 await rejects(run(api,T.id,"update lara.tax_rule_versions set status='approved',approved_by=$2 where id=$1",[vat1,approver]),/cannot move from draft to approved/,'draft straight to approved');
 await run(api,T.id,"update lara.tax_rule_versions set status='pending_approval' where id=$1",[vat1]);
 await rejects(run(api,T.id,"update lara.tax_rule_versions set status='approved',approved_by=$2 where id=$1",[vat1,principal]),/check constraint|violates/,'author approving own rule');
 await run(api,T.id,"update lara.tax_rule_versions set status='approved',approved_by=$2 where id=$1",[vat1,approver]);
 await rejects(run(api,T.id,"update lara.tax_rule_versions set rate=0.10 where id=$1",[vat1]),/immutable/,'approved rate edit');
 await rejects(run(api,T.id,"update lara.tax_rule_versions set status='active',activated_by=$2,activated_at=now() where id=$1",[vat1,principal]),/SELF_APPROVAL/,'author activating own rule');
 await run(api,T.id,"update lara.tax_rule_versions set status='active',activated_by=$2,activated_at=now() where id=$1",[vat1,approver]);
 const vat2=await rule('VAT12',2);
 await run(api,T.id,"update lara.tax_rule_versions set status='pending_approval' where id=$1",[vat2]);
 await run(api,T.id,"update lara.tax_rule_versions set status='approved',approved_by=$2 where id=$1",[vat2,approver]);
 await rejects(run(api,T.id,"update lara.tax_rule_versions set status='active',activated_by=$2,activated_at=now() where id=$1",[vat2,approver]),/tax_rule_versions_one_active|duplicate key/,'two active versions of one code');
 await run(api,T.id,"update lara.tax_rule_versions set status='superseded' where id=$1",[vat1]);
 await run(api,T.id,"update lara.tax_rule_versions set status='active',activated_by=$2,activated_at=now() where id=$1",[vat2,approver]);
 await rejects(run(api,T.id,"update lara.tax_rule_versions set status='draft' where id=$1",[vat1]),/cannot move from superseded/,'superseded reopened');
 pass('tax rule versions need evidence and golden cases, follow draft → pending → approved → active → superseded with separate author, approver and activator, are immutable once approved and allow one active version per code');

 // Numbering series
 const series=(await run(api,T.id,"insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4) returning id",[T.id,entity,branch,principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV2','numbering-2026',$4)",[T.id,entity,branch,principal]),/document_series_one_active|duplicate key/,'second active invoice series on one branch');
 const draftDoc=async(over={})=>{const net=over.net||'10000.000000',tax=over.tax||'1200.000000';return (await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,net,tax,gross,rule_profile_version,payload_hash,created_by,series_id,official_number,state) values($1,$2,$3,$4,$5,$6,'2026-09-18','2026-09-18','PHP',$7,$8,$9,'tax-2026',$10,$11,$12,$13,$14) returning id",[T.id,entity,book,over.kind||'invoice',branch,over.party===undefined?customer:over.party,net,tax,over.gross||String(Number(net)+Number(tax)),hash(over.seed||randomUUID()),principal,over.seriesId||null,over.number||null,over.state||'draft'])).rows[0].id;};
 const issued=await draftDoc({seriesId:series,number:'INV-000001'});
 await run(api,T.id,"insert into lara.number_events(tenant_id,entity_id,series_id,number,document_id,event) values($1,$2,$3,1,$4,'issued')",[T.id,entity,series,issued]);
 await run(api,T.id,"update lara.document_series set next_number=2 where id=$1",[series]);
 await rejects(run(api,T.id,"insert into lara.number_events(tenant_id,entity_id,series_id,number,document_id,event) values($1,$2,$3,1,$4,'issued')",[T.id,entity,series,issued]),/number_events_one_issue|duplicate key/,'same number issued twice');
 await rejects(draftDoc({seriesId:series,number:'INV-000001'}),/documents_official_number|duplicate key/,'same official number on two documents');
 await rejects(draftDoc({number:'INV-000009'}),/check constraint|violates/,'official number without a series');
 await rejects(run(api,T.id,"update lara.document_series set next_number=1 where id=$1",[series]),/never recycled/,'counter moved backwards');
 await rejects(run(api,T.id,"insert into lara.number_events(tenant_id,entity_id,series_id,number,event) values($1,$2,$3,2,'skipped')",[T.id,entity,series]),/check constraint|violates/,'skip without a reason');
 await run(api,T.id,"insert into lara.number_events(tenant_id,entity_id,series_id,number,event,reason) values($1,$2,$3,2,'skipped','printer jam')",[T.id,entity,series]);
 await rejects(run(api,T.id,"update lara.number_events set reason='edited' where series_id=$1",[series]),/permission denied|APPEND_ONLY/,'number events are append-only');
 await rejects(run(api,T.id,"update lara.documents set official_number='INV-000002' where id=$1",[issued]),/never reassigned/,'official number reassigned');
 await run(api,T.id,"update lara.document_series set status='exhausted' where id=$1",[series]);
 await rejects(run(api,T.id,"update lara.document_series set status='active' where id=$1",[series]),/replaced, not reopened/,'exhausted series reopened');
 pass('one active series per branch and kind, single-use official numbers, monotonic counters, recorded skips and append-only number events');

 // Documents: totals, lines and the state machine
 const invoice=await draftDoc({seed:'inv'});
 const line=(doc,no,over={})=>q("insert into lara.document_lines(tenant_id,entity_id,document_id,line_no,description,quantity,unit_price,price_basis,account_id,tax_rule_version_id,tax_rate,net,tax,gross) values($1,$2,$3,$4,$5,$6,$7,'exclusive',$8,$9,0.12,$10,$11,$12)",T.id,entity,doc,no,over.description||'Consulting',over.quantity||'1',over.unitPrice||over.net||'10000',revenue,vat2,over.net||'10000',over.tax||'1200',over.gross||String(Number(over.net||'10000')+Number(over.tax||'1200')));
 await rejects(tx(api,T.id,async x=>{await x(line(invoice,1,{net:'9000',tax:'1080'}));}),/totals .* differ from line sums/,'header totals differing from lines at commit');
 await tx(api,T.id,async x=>{await x(line(invoice,1,{net:'6000',tax:'720'}));await x(line(invoice,2,{net:'4000',tax:'480'}));});
 await rejects(tx(api,T.id,async x=>{await x(q("update lara.documents set net=9000,gross=10200 where id=$1",invoice));}),/totals .* differ from line sums/,'header edited away from its lines');
 await rejects(run(api,T.id,"update lara.documents set gross=11201 where id=$1",[invoice]),/check constraint|violates/,'gross not equal to net plus tax');
 await rejects(tx(api,T.id,async x=>{await x(line(invoice,3,{net:'100',tax:'12',gross:'113'}));}),/check constraint|violates/,'line gross not equal to net plus tax');
 await rejects(run(api,T.id,"update lara.documents set state='approved',approved_by=$2 where id=$1",[invoice,approver]),/cannot move from draft to approved/,'draft straight to approved');
 await run(api,T.id,"update lara.documents set state='submitted',submitted_by=$2 where id=$1",[invoice,principal]);
 await rejects(run(api,T.id,"update lara.documents set payload_hash=$2 where id=$1",[invoice,hash('edited')]),/return to draft before approval/,'material edit while submitted');
 await rejects(run(api,T.id,"update lara.documents set state='approved',approved_by=$2 where id=$1",[invoice,principal]),/check constraint|violates/,'submitter approving own document');
 await run(api,T.id,"update lara.documents set state='approved',approved_by=$2,approved_version=content_version where id=$1",[invoice,approver]);
 await rejects(run(api,T.id,"update lara.documents set state='posted',posted_by=$2,posted_at=now() where id=$1",[invoice,principal]),/check constraint|violates/,'posted without a journal entry');
 await run(api,T.id,"insert into lara.party_snapshots(document_id,tenant_id,entity_id,immutable_json,snapshot_hash) values($1,$2,$3,$4,$5)",[invoice,T.id,entity,JSON.stringify({legalName:'Acme Trading'}),hash('snap')]);
 await rejects(run(api,T.id,"update lara.party_snapshots set immutable_json='{}' where document_id=$1",[invoice]),/permission denied|APPEND_ONLY/,'party snapshot edited');
 // AC-01: Dr AR 11,200 / Cr Revenue 10,000 / Cr Output tax 1,200 through the posting function.
 const entry=await post([{accountId:ar,branchId:branch,debit:'11200.00',credit:'0',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'10000.00',dimensions:{}},{accountId:outputTax,branchId:branch,debit:'0',credit:'1200.00',dimensions:{}}],invoice);
 await run(api,T.id,"update lara.documents set state='posted',posted_entry_id=$2,posted_by=$3,posted_at=now() where id=$1",[invoice,entry,principal]);
 await rejects(run(api,T.id,"update lara.documents set net=9000,gross=10200,tax=1200 where id=$1",[invoice]),/posted documents are immutable/,'posted header edited');
 await rejects(run(api,T.id,"update lara.documents set state='draft' where id=$1",[invoice]),/cannot move from posted/,'posted document reopened');
 await rejects(run(api,T.id,"update lara.document_lines set net=5000 where document_id=$1 and line_no=1",[invoice]),/lines of a posted document are immutable/,'posted line edited');
 await rejects(run(api,T.id,"delete from lara.document_lines where document_id=$1",[invoice]),/lines of a posted document are immutable/,'posted line deleted');
 await run(api,T.id,"update lara.documents set delivery_state='queued',settlement_state='unpaid' where id=$1",[invoice]);
 const credit=await draftDoc({kind:'credit_note',net:'1000.000000',tax:'120.000000',seed:'cn'});
 await run(api,T.id,"insert into lara.document_relations(tenant_id,entity_id,source_id,target_id,relation,amount,created_by) values($1,$2,$3,$4,'credit',1120,$5)",[T.id,entity,credit,invoice,principal]);
 await rejects(run(api,T.id,"insert into lara.document_relations(tenant_id,entity_id,source_id,target_id,relation,created_by) values($1,$2,$3,$3,'credit',$4)",[T.id,entity,credit,principal]),/check constraint|violates/,'self relation');
 await rejects(run(api,T.id,"delete from lara.document_relations where source_id=$1",[credit]),/permission denied|APPEND_ONLY/,'relations are append-only');
 const cancelled=await draftDoc({seed:'void'});
 await run(api,T.id,"update lara.documents set state='cancelled' where id=$1",[cancelled]);
 await rejects(run(api,T.id,"update lara.documents set state='draft' where id=$1",[cancelled]),/stay cancelled/,'cancelled document revived');
 pass('documents check totals against lines at commit, follow draft → submitted → approved → posted with separate submitter and approver, are immutable once posted with immutable lines, snapshots and append-only relations');

 // Tax events
 const lines=(await run(api,T.id,"select id from lara.document_lines where document_id=$1 order by line_no",[invoice])).rows.map(r=>r.id);
 const taxEvent=(lineId,over={})=>run(api,T.id,"insert into lara.tax_events(tenant_id,entity_id,document_id,line_id,tax_rule_version_id,tax_point,recognition,basis,amount,recognition_entry_id) values($1,$2,$3,$4,$5,'2026-09-18',$6,$7,$8,$9) returning id",[T.id,entity,invoice,lineId,vat2,over.recognition||'issue',over.basis||'6000',over.amount||'720',entry]).then(r=>r.rows[0].id);
 const te=await taxEvent(lines[0]);
 await rejects(taxEvent(lines[0]),/duplicate key/,'same recognition of one line twice');
 await taxEvent(lines[1],{basis:'4000',amount:'480'});
 await rejects(run(api,T.id,"update lara.tax_events set amount=1 where id=$1",[te]),/APPEND_ONLY|permission denied/,'tax event amount edited');
 await rejects(run(api,T.id,"delete from lara.tax_events where id=$1",[te]),/APPEND_ONLY|permission denied/,'tax event deleted');
 const reversal=await taxEvent(lines[0],{recognition:'profile_event'});
 await run(api,T.id,"update lara.tax_events set reversed_by=$2 where id=$1",[te,reversal]);
 await rejects(run(api,T.id,"update lara.tax_events set reversed_by=$2 where id=$1",[te,te]),/APPEND_ONLY/,'reversal link changed');
 pass('tax events are recognized once per line, rule version and recognition, and only record their reversal');

 // Open items, settlements and allocations (AC-02 collection)
 const item=(await run(api,T.id,"insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AR',$4,11200,'PHP','2026-10-18') returning id",[T.id,entity,invoice,customer])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AR',$4,1,'PHP','2026-10-18')",[T.id,entity,invoice,customer]),/duplicate key/,'two open items for one document');
 await rejects(run(api,T.id,"update lara.open_items set original_amount=1 where id=$1",[item]),/immutable/,'original amount edited');
 const settlement=async(over={})=>(await run(api,T.id,"insert into lara.settlements(tenant_id,entity_id,book_id,direction,party_id,payment_method,currency,gross_amount,cash_amount,withholding_amount,value_date,payload_hash,created_by,state,posted_entry_id) values($1,$2,$3,$4,$5,'transfer',$6,$7,$8,$9,'2026-09-20',$10,$11,$12,$13) returning id",[T.id,entity,book,over.direction||'receipt',over.party||customer,over.currency||'PHP',over.gross||'5000',over.cash||'5000',over.withholding||'0',hash(randomUUID()),principal,over.state||'draft',over.entry||null])).rows[0].id;
 await rejects(settlement({gross:'5000',cash:'4000',withholding:'500'}),/check constraint|violates/,'settlement components not summing to gross');
 const draftReceipt=await settlement();
 const apply=(s,i,amount,extra={})=>run(api,T.id,"insert into lara.allocation_events(tenant_id,entity_id,settlement_id,open_item_id,amount,action,reverses_id,reason,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",[T.id,entity,s,i,amount,extra.action||'apply',extra.reverses||null,extra.reason||null,principal]).then(r=>r.rows[0].id);
 await rejects(apply(draftReceipt,item,'5000'),/only posted settlements allocate/,'allocation from a draft settlement');
 await rejects(run(api,T.id,"update lara.settlements set state='posted' where id=$1",[draftReceipt]),/check constraint|violates|cannot move/,'draft settlement posted without an entry');
 const receiptEntry=await post([{accountId:cash,branchId:branch,debit:'5000.00',credit:'0',dimensions:{}},{accountId:ar,branchId:branch,debit:'0',credit:'5000.00',dimensions:{}}]);
 await run(api,T.id,"update lara.settlements set state='submitted',submitted_by=$2 where id=$1",[draftReceipt,principal]);
 await run(api,T.id,"update lara.settlements set state='approved',approved_by=$2 where id=$1",[draftReceipt,approver]);
 await run(api,T.id,"update lara.settlements set state='posted',posted_entry_id=$2 where id=$1",[draftReceipt,receiptEntry]);
 const receipt=draftReceipt;
 await rejects(run(api,T.id,"update lara.settlements set gross_amount=6000,cash_amount=6000 where id=$1",[receipt]),/posted settlements are immutable/,'posted settlement edited');
 const first=await apply(receipt,item,'3000');
 assert.equal((await run(api,T.id,"select status from lara.open_items where id=$1",[item])).rows[0].status,'partially_settled');
 await rejects(apply(receipt,item,'2500'),/ALLOCATION_EXCEEDS_BALANCE: settlement unallocated/,'allocating more than the settlement holds');
 await apply(receipt,item,'2000');
 assert.equal((await run(api,T.id,"select lara.open_item_allocated($1,$2)::text as used",[T.id,item])).rows[0].used,'5000.000000');
 const bigEntry=await post([{accountId:cash,branchId:branch,debit:'20000.00',credit:'0',dimensions:{}},{accountId:ar,branchId:branch,debit:'0',credit:'20000.00',dimensions:{}}]);
 const bigReceipt=await settlement({gross:'20000',cash:'20000',state:'posted',entry:bigEntry});
 await rejects(apply(bigReceipt,item,'6200.000001'),/ALLOCATION_EXCEEDS_BALANCE: open item outstanding/,'allocating more than the open item outstanding');
 await apply(bigReceipt,item,'6200');
 assert.equal((await run(api,T.id,"select status from lara.open_items where id=$1",[item])).rows[0].status,'settled');
 await rejects(apply(bigReceipt,item,'0.01'),/ALLOCATION_EXCEEDS_BALANCE/,'allocating to a settled item');
 await rejects(run(api,T.id,"update lara.allocation_events set amount=1 where id=$1",[first]),/permission denied|APPEND_ONLY/,'allocation events are append-only');
 await rejects(apply(receipt,item,'3000',{action:'reverse',reverses:first}),/check constraint|violates/,'reverse without a reason');
 await rejects(apply(receipt,item,'2999',{action:'reverse',reverses:first,reason:'wrong item'}),/must mirror one apply/,'reverse with a different amount');
 await apply(receipt,item,'3000',{action:'reverse',reverses:first,reason:'wrong item'});
 assert.equal((await run(api,T.id,"select status from lara.open_items where id=$1",[item])).rows[0].status,'partially_settled');
 await rejects(apply(receipt,item,'3000',{action:'reverse',reverses:first,reason:'again'}),/allocation_events_one_reverse|duplicate key/,'one apply reversed twice');
 const usdItemDoc=await draftDoc({seed:'usd'});
 await run(api,T.id,"update lara.documents set currency='USD' where id=$1",[usdItemDoc]);
 const usdItem=(await run(api,T.id,"insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AR',$4,100,'USD','2026-10-18') returning id",[T.id,entity,usdItemDoc,customer])).rows[0].id;
 await rejects(apply(bigReceipt,usdItem,'10'),/currencies differ/,'cross-currency allocation');
 const vendorDoc=await draftDoc({kind:'bill',party:vendor,seed:'bill'});
 const apItem=(await run(api,T.id,"insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AP',$4,11200,'PHP','2026-10-18') returning id",[T.id,entity,vendorDoc,vendor])).rows[0].id;
 await rejects(apply(bigReceipt,apItem,'10'),/receipts settle receivables/,'receipt applied to a payable');
 const otherCustomerDoc=await draftDoc({party:vendor,seed:'other'});
 const otherItem=(await run(api,T.id,"insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AR',$4,500,'PHP','2026-10-18') returning id",[T.id,entity,otherCustomerDoc,vendor])).rows[0].id;
 await rejects(apply(bigReceipt,otherItem,'10'),/party differs/,'receipt applied to another party');
 pass('open items settle only through append-only allocation events from posted settlements of the same party, side and currency, never beyond either balance, with mirrored single reversals and derived status');

 // Credit limits and deliveries
 const limit=(await run(api,T.id,"insert into lara.credit_limits(tenant_id,entity_id,party_id,currency,limit_amount,policy_version,created_by,status,approved_by) values($1,$2,$3,'PHP',50000,'credit-2026',$4,'approved',$5) returning id",[T.id,entity,customer,principal,approver])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.credit_limits(tenant_id,entity_id,party_id,currency,limit_amount,policy_version,created_by,status,approved_by) values($1,$2,$3,'PHP',60000,'credit-2026',$4,'approved',$5)",[T.id,entity,customer,principal,approver]),/credit_limits_one_approved|duplicate key/,'two approved limits per party and currency');
 await rejects(run(api,T.id,"insert into lara.credit_limits(tenant_id,entity_id,party_id,currency,limit_amount,policy_version,created_by,status,approved_by) values($1,$2,$3,'USD',60000,'credit-2026',$4,'approved',$4)",[T.id,entity,customer,principal]),/check constraint|violates/,'self-approved limit');
 assert.ok(limit);
 const delivery=(await run(api,T.id,"insert into lara.deliveries(tenant_id,entity_id,document_id,recipient_hash,template_version,created_by) values($1,$2,$3,$4,'invoice-email-1',$5) returning id",[T.id,entity,invoice,hash('mail'),principal])).rows[0].id;
 if(worker){
  await run(worker,T.id,"update lara.deliveries set state='sent',attempt=1,provider_reference='msg-1' where id=$1",[delivery]);
  await run(worker,T.id,"update lara.documents set delivery_state='sent' where id=$1",[invoice]);
  await rejects(run(worker,T.id,"update lara.documents set net=1 where id=$1",[invoice]),/permission denied/,'worker changing document content');
  await rejects(run(worker,T.id,"insert into lara.allocation_events(tenant_id,entity_id,settlement_id,open_item_id,amount,action) values($1,$2,$3,$4,1,'apply')",[T.id,entity,receipt,item]),/permission denied/,'worker allocating');
 }
 pass('one approved credit limit per party and currency with a separate approver; delivery projections'+(worker?' updated by the worker, which cannot touch document content or allocations':''));

 // Isolation
 for(const table of ['tax_rule_versions','document_series','documents','document_lines','open_items','settlements','allocation_events','tax_events','number_events'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.documents')).rows[0].n,0,'documents visible without a tenant');
 await rejects(run(api,other.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,document_date,accounting_date,currency,rule_profile_version,payload_hash,created_by) values($1,$2,$3,'invoice',$4,'2026-09-18','2026-09-18','PHP','x',$5,$6)",[T.id,entity,book,branch,hash('x'),principal]),/row-level security|violates/,'writing into another tenant');
 await rejects(run(api,T.id,"delete from lara.documents where id=$1",[cancelled]),/permission denied/,'documents are never deleted by the application');
 await rejects(run(api,T.id,"delete from lara.open_items where id=$1",[usdItem]),/permission denied/,'open items are never deleted by the application');
 pass('row-level security isolates tenants on every sales table and the runtime role cannot delete documents or open items');
 console.log('P04-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end(),worker?.end()]);
}
