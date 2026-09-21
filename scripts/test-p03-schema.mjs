// P03-01 ledger schema acceptance against real PostgreSQL through the runtime
// role: the posting function is the only write path for journals (CORE-01–09
// at the database layer: balance, immutability, idempotent retry, period and
// account rules), chart integrity, period non-overlap and state machine,
// openings, snapshots and close tables. Test tenants are removed at the end.
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
const T={id:randomUUID(),slug:'p02-test-ledger-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 // Fixture tenant: entity, branch, primary PHP book, principal
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Ledger schema test','demo')",[T.id,T.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Poster') returning id",[T.id,'poster-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Ledger entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 await rejects(run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-2','primary','PHP','active',$3)",[T.id,entity,principal]),/books_one_primary|duplicate key/,'second primary book');
 pass('fixture tenant with an active entity, branch and one primary PHP book');

 // Chart of accounts
 const acct=async(code,name,category,extra={})=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,parent_id,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id",[T.id,entity,book,code,name,category,['asset','expense'].includes(category)?'debit':'credit',extra.parent||null,extra.control||'none',extra.allowManual??(extra.control?false:true),extra.status||'active',hash(code),principal])).rows[0].id;
 const assets=await acct('1000','Assets','asset');
 const cash=await acct('1010','Cash','asset',{parent:assets});
 const ar=await acct('1200','Accounts receivable','asset',{parent:assets,control:'ar'});
 const frozen=await acct('1300','Frozen deposits','asset',{parent:assets,status:'frozen'});
 const revenue=await acct('4000','Revenue','income');
 const expense=await acct('5000','Expense','expense');
 await rejects(acct('1011','Wrong side','asset').then(()=>run(api,T.id,"update lara.accounts set normal_side='credit' where code='1011'")),/check constraint|violates/,'normal side derives from category');
 await rejects(acct('4100','Mixed parent','income',{parent:assets}),/share the category/,'parent category');
 await rejects(run(api,T.id,"update lara.accounts set parent_id=$2 where id=$1",[assets,cash]),/cycle/,'hierarchy cycle');
 await rejects(acct('1201','Manual control','asset',{control:'ar',allowManual:true}),/check constraint|violates/,'control accounts never accept manual posting');
 await rejects(run(api,T.id,"insert into lara.account_dimension_rules(tenant_id,entity_id,account_id,dimension_type,created_by) values($1,$2,$3,'cost_center',$4)",[T.id,entity,expense,principal]).then(()=>run(api,T.id,"update lara.account_dimension_rules set required=false where account_id=$1",[expense])),/permission denied|APPEND_ONLY/,'dimension rules are replaced, not edited');
 const costCenter=(await run(api,T.id,"insert into lara.dimensions(tenant_id,entity_id,type,code,name,created_by) values($1,$2,'cost_center','CC-100','Operations',$3) returning id",[T.id,entity,principal])).rows[0].id;
 pass('chart enforces category-derived normal side, shared parent category, no cycles, manual-posting ban on control accounts and append-only dimension rules');

 // Periods
 const period=(await run(api,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-09-01','2026-09-30',$4) returning id",[T.id,entity,book,principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-09-15','2026-10-15',$4)",[T.id,entity,book,principal]),/cannot overlap/,'overlapping period');
 const october=(await run(api,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4) returning id",[T.id,entity,book,principal])).rows[0].id;
 await rejects(run(api,T.id,"update lara.periods set status='locked',locked_by=$2,locked_at=now() where id=$1",[period,principal]),/cannot move from open to locked/,'lock without soft close');
 pass('periods of a book cannot overlap and follow open → soft_closed → locked');

 // Posting through the function
 const post=(over={})=>run(api,T.id,'select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:T.id,entityId:entity,bookId:book,sourceType:'journal_draft',sourceId:over.sourceId||randomUUID(),sourceVersion:over.sourceVersion||1,accountingDate:over.date||'2026-09-18',documentDate:'2026-09-18',description:over.description||'Test posting',currency:over.currency||'PHP',manual:over.manual??true,postingActor:principal,lines:over.lines||[{accountId:cash,branchId:branch,debit:'1000.00',credit:'0',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'1000.00',dimensions:{}}],...over.extra})]);
 await rejects(run(api,T.id,"insert into lara.journal_entries(tenant_id,entity_id,book_id,source_type,source_id,source_version,accounting_date,description,period_id,transaction_currency,functional_currency,lines_hash,line_count,total_debit,total_credit) values($1,$2,$3,'x',$4,1,'2026-09-18','direct',$5,'PHP','PHP',$6,2,1,1)",[T.id,entity,book,randomUUID(),period,hash('x')]),/permission denied/,'runtime role cannot insert journal entries directly');
 await rejects(run(api,T.id,"insert into lara.journal_lines(tenant_id,entity_id,book_id,entry_id,line_no,account_id,branch_id,txn_debit,func_debit) values($1,$2,$3,$4,1,$5,$6,1,1)",[T.id,entity,book,randomUUID(),cash,branch]),/permission denied/,'runtime role cannot insert journal lines directly');
 const source=randomUUID();
 const first=(await post({sourceId:source})).rows[0].id;
 const again=(await post({sourceId:source})).rows[0].id;
 assert.equal(again,first,'retrying the same source version returns the same entry');
 await rejects(post({sourceId:source,lines:[{accountId:cash,branchId:branch,debit:'2000.00',credit:'0',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'2000.00',dimensions:{}}]}),/DUPLICATE_SOURCE/,'same source version with different lines');
 assert.equal((await run(api,T.id,'select count(*)::int n from lara.journal_entries where source_id=$1',[source])).rows[0].n,1);
 await rejects(post({lines:[{accountId:cash,branchId:branch,debit:'1000.00',credit:'0',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'999.99',dimensions:{}}]}),/UNBALANCED_ENTRY/,'unbalanced');
 await rejects(post({lines:[{accountId:cash,branchId:branch,debit:'1000.00',credit:'0',dimensions:{}}]}),/UNBALANCED_ENTRY/,'single line');
 await rejects(post({lines:[{accountId:cash,branchId:branch,debit:'10.00',credit:'5.00',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'5.00',dimensions:{}}]}),/exactly one positive side/,'two-sided line');
 await rejects(post({lines:[{accountId:assets,branchId:branch,debit:'1000.00',credit:'0',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'1000.00',dimensions:{}}]}),/not a leaf/,'non-leaf account');
 await rejects(post({lines:[{accountId:frozen,branchId:branch,debit:'1000.00',credit:'0',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'1000.00',dimensions:{}}]}),/frozen/,'frozen account');
 await rejects(post({lines:[{accountId:ar,branchId:branch,debit:'1000.00',credit:'0',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'1000.00',dimensions:{}}]}),/owning module/,'manual posting to a control account');
 const moduleEntry=(await post({manual:false,sourceType:'invoice',lines:[{accountId:ar,branchId:branch,debit:'1120.00',credit:'0',dimensions:{}},{accountId:revenue,branchId:branch,debit:'0',credit:'1120.00',dimensions:{}}]})).rows[0].id;
 assert.ok(moduleEntry,'module postings may hit control accounts');
 await rejects(post({lines:[{accountId:expense,branchId:branch,debit:'500.00',credit:'0',dimensions:{}},{accountId:cash,branchId:branch,debit:'0',credit:'500.00',dimensions:{}}]}),/requires dimension cost_center/,'missing required dimension');
 const dimEntry=(await post({lines:[{accountId:expense,branchId:branch,debit:'500.00',credit:'0',dimensions:{cost_center:costCenter}},{accountId:cash,branchId:branch,debit:'0',credit:'500.00',dimensions:{}}]})).rows[0].id;
 assert.ok(dimEntry);
 await rejects(post({date:'2026-12-01'}),/PERIOD_LOCKED: no open period/,'date outside any period');
 await rejects(post({currency:'USD'}),/never default to 1/,'foreign currency journal without an approved rate (P09)');
 await rejects(post({extra:{tenantId:randomUUID()}}),/FORBIDDEN|outside the bound tenant/,'posting for another tenant');
 await rejects(run(api,T.id,"update lara.journal_lines set func_debit=func_debit+1 where entry_id=$1",[first]),/permission denied|APPEND_ONLY/,'posted line update');
 await rejects(run(api,T.id,"delete from lara.journal_entries where id=$1",[first]),/permission denied|APPEND_ONLY/,'posted entry delete');
 await rejects(run(owner,T.id,"update lara.journal_entries set description='tampered' where id=$1",[first]),/APPEND_ONLY/,'owner cannot rewrite posted facts');
 const totals=(await run(api,T.id,'select sum(func_debit) d,sum(func_credit) c,count(*) n from lara.journal_lines where book_id=$1',[book])).rows[0];
 assert.equal(totals.d,totals.c);assert.equal(Number(totals.n),6);
 pass('journals post only through the granted function: retry is idempotent, changed lines conflict, unbalanced/single/two-sided lines, non-leaf, frozen and manual control-account postings, missing dimensions, dates outside periods, foreign currency and foreign tenants are refused; posted facts are immutable for every role');

 // Balances and period locking with soft-close adjustment path
 const balances=(await run(api,T.id,"select code,balance from lara.account_balances($1,$2,$3,'2026-09-01','2026-09-30',now()) where balance<>0 order by code",[T.id,entity,book])).rows;
 assert.deepEqual(balances.map(b=>[b.code,Number(b.balance)]),[['1010',500],['1200',1120],['4000',2120],['5000',500]]);
 await run(api,T.id,"update lara.periods set status='soft_closed' where id=$1",[period]);
 await rejects(post({}),/soft closed/,'posting into a soft-closed period without the adjustment flag');
 const adjustment=(await post({extra:{allowSoftClosed:true,purpose:'adjustment'}})).rows[0].id;
 assert.ok(adjustment);
 await run(api,T.id,"update lara.periods set status='locked',locked_by=$2,locked_at=now() where id=$1",[period,principal]);
 await rejects(post({extra:{allowSoftClosed:true}}),/PERIOD_LOCKED: period is locked/,'posting into a locked period');
 await rejects(run(api,T.id,"update lara.periods set starts_on='2026-09-02' where id=$1",[period]),/keep their dates/,'period with postings keeps dates');
 await rejects(run(api,T.id,"update lara.periods set status='open' where id=$1",[period]),/new close version/,'reopen without a new close version');
 await run(api,T.id,"update lara.periods set status='open',close_version=close_version+1 where id=$1",[period]);
 pass('balances derive from posted lines; soft close admits only adjustments; locked periods refuse postings; reopening requires a new close version');

 // Reversal link uniqueness
 const reversal=(await post({extra:{reversalOf:first,purpose:'reversal'},lines:[{accountId:revenue,branchId:branch,debit:'1000.00',credit:'0',dimensions:{}},{accountId:cash,branchId:branch,debit:'0',credit:'1000.00',dimensions:{}}]})).rows[0].id;
 await rejects(post({extra:{reversalOf:first,purpose:'reversal'},lines:[{accountId:revenue,branchId:branch,debit:'1000.00',credit:'0',dimensions:{}},{accountId:cash,branchId:branch,debit:'0',credit:'1000.00',dimensions:{}}]}),/journal_entries_one_reversal|duplicate key/,'second reversal of the same entry');
 assert.ok(reversal);
 pass('an entry is reversed at most once');

 // Openings, snapshots, close support
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'openings.csv',$4,'text/csv',100,'available','confidential',$5) returning id",[T.id,entity,'k-'+randomUUID(),hash('csv'),principal])).rows[0].id;
 const batch=(await run(api,T.id,"insert into lara.opening_batches(tenant_id,entity_id,book_id,kind,evidence_id,checksum,cutoff,source_id,external_batch_id,mapping_version,created_by) values($1,$2,$3,'openings',$4,$5,'2026-08-31','legacy-gl','BATCH-1','v1',$6) returning id",[T.id,entity,book,evidence,hash('rows'),principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.opening_batches(tenant_id,entity_id,book_id,kind,evidence_id,checksum,cutoff,source_id,external_batch_id,mapping_version,created_by) values($1,$2,$3,'openings',$4,$5,'2026-08-31','legacy-gl','BATCH-1','v1',$6)",[T.id,entity,book,evidence,hash('rows-changed'),principal]),/opening_batches_external|duplicate key/,'same external batch with a different checksum is a conflict');
 await run(api,T.id,"insert into lara.opening_rows(tenant_id,entity_id,batch_id,row_no,source_key,account_code,branch_code,accounting_date,debit,credit) values($1,$2,$3,1,'R1','1010','HQ','2026-08-31',100,0),($1,$2,$3,2,'R2','4000','HQ','2026-08-31',0,100)",[T.id,entity,batch]);
 await rejects(run(api,T.id,"insert into lara.opening_rows(tenant_id,entity_id,batch_id,row_no,source_key,account_code,branch_code,accounting_date,debit,credit) values($1,$2,$3,3,'R1','1010','HQ','2026-08-31',1,0)",[T.id,entity,batch]),/duplicate key/,'duplicate source key');
 await rejects(run(api,T.id,"update lara.opening_batches set state='committed' where id=$1",[batch]),/cannot move from staged to committed|check constraint|violates/,'commit without validation and approval');
 await run(api,T.id,"update lara.opening_batches set state='validated',row_count=2,debit_total=100,credit_total=100 where id=$1",[batch]);
 await rejects(run(api,T.id,"update lara.opening_batches set state='approved',approved_by=$2 where id=$1",[batch,principal]),/check constraint|violates/,'self approval of an import');
 const snapshot=(await run(api,T.id,"insert into lara.report_snapshots(tenant_id,entity_id,book_id,report_type,period_key,version_number,cutoff_posted_at,rule_version,payload,checksum,created_by) values($1,$2,$3,'trial_balance','2026-09',1,now(),'p03.1','[]'::jsonb,$4,$5) returning id",[T.id,entity,book,hash('tb'),principal])).rows[0].id;
 await rejects(run(api,T.id,"update lara.report_snapshots set payload='[1]'::jsonb where id=$1",[snapshot]),/permission denied|APPEND_ONLY/,'snapshot rewrite');
 await rejects(run(api,T.id,"insert into lara.close_tasks(tenant_id,entity_id,period_id,requirement,required,status,waiver_reason,created_by) values($1,$2,$3,'bank_reconciliation',true,'waived','not needed',$4)",[T.id,entity,period,principal]),/check constraint|violates/,'required close task cannot be waived');
 await rejects(run(api,T.id,"insert into lara.substantiations(tenant_id,entity_id,period_id,account_id,preparer_id,reviewer_id,evidence_id,state,created_by) values($1,$2,$3,$4,$5,$5,$6,'reviewed',$5)",[T.id,entity,period,cash,principal,evidence]),/check constraint|violates/,'preparer cannot review own substantiation');
 const draft=(await run(api,T.id,"insert into lara.journal_drafts(tenant_id,entity_id,book_id,accounting_date,document_date,currency,description,lines,content_hash,created_by) values($1,$2,$3,'2026-10-05','2026-10-05','PHP','Draft','[{},{}]'::jsonb,$4,$5) returning id",[T.id,entity,book,hash('d1'),principal])).rows[0].id;
 await rejects(run(api,T.id,"update lara.journal_drafts set status='approved',approved_by=$2 where id=$1",[draft,principal]),/cannot move from draft to approved|check constraint|violates/,'approve without submit or by the author');
 await run(api,T.id,"update lara.journal_drafts set status='submitted',submitted_by=$2 where id=$1",[draft,principal]);
 await rejects(run(api,T.id,"update lara.journal_drafts set content_hash=$2 where id=$1",[draft,hash('d2')]),/return to draft/,'material edit while submitted');
 pass('openings dedupe external batches and source keys and follow staged → validated → approved → committed with independent approval; snapshots are immutable; required close tasks cannot be waived; substantiation review is independent; journal drafts follow the document state machine');
 console.log('PASS P03-01 schema: '+step+' groups');
}finally{
 await removeTenants(owner,[T.id]);
 await Promise.all([owner.end(),api.end()]);
}
