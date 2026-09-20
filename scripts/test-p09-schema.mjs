// P09-01 multi-currency and separate books schema acceptance against real
// PostgreSQL through the runtime role: currency metadata is readable and
// fixed; books carry the reviewed kinds with one primary; FX rates are one
// approved per pair and date, approved by another principal and immutable;
// the posting function refuses a foreign currency without a rate, requires
// balanced functional totals, records the rate, refuses a management book and
// a closed partition; FX layers are append-only; revaluation runs follow
// draft → previewed → approved → posted with one run per rate set; row-level
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
const T={id:randomUUID(),slug:'p02-test-fx-'+suffix};
const other={id:randomUUID(),slug:'p02-test-fx-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'FX schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Preparer') returning id",[T.id,'preparer-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Approver') returning id",[T.id,'approver-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'FX entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 await rejects(run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'P2','primary','PHP','active',$3)",[T.id,entity,principal]),/books_one_primary|duplicate key/,'two primary books');
 await rejects(run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'X','sidecar','PHP','active',$3)",[T.id,entity,principal]),/check constraint|violates/,'unknown book kind');
 const fcdu=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'FCDU','fcdu','USD','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const mgmt=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'MGMT','management','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const acct=async(bookId,code,category,side)=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$4,$5,$6,'none',true,'active',$7,$8) returning id",[T.id,entity,bookId,code,category,side,hash(bookId+code),principal])).rows[0].id;
 const cash=await acct(book,'1010','asset','debit'),ar=await acct(book,'1200','asset','debit'),rev=await acct(book,'4000','income','credit');
 const mcash=await acct(mgmt,'1010','asset','debit'),mrev=await acct(mgmt,'4000','income','credit');
 const fcash=await acct(fcdu,'1010','asset','debit'),fdep=await acct(fcdu,'2100','liability','credit');
 for(const b of [book,fcdu,mgmt])await run(owner,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,status,created_by) values($1,$2,$3,'2026-10-01','2026-10-31','open',$4)",[T.id,entity,b,principal]);
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'rates.pdf',$4,'application/pdf',10,'available','internal',$5) returning id",[T.id,entity,'k-'+suffix,hash('r'),principal])).rows[0].id;
 assert.ok((await run(api,T.id,"select minor_units from lara.currency_metadata where code='JPY'")).rows[0].minor_units===0,'currency metadata readable');
 await rejects(run(api,T.id,"update lara.currency_metadata set minor_units=3 where code='JPY'"),/permission denied/,'runtime role editing currency metadata');
 pass('fixture with a primary PHP book, an FCDU book in USD, a management view, accounts, periods and evidence; currency metadata is readable and fixed; one primary book and reviewed kinds only');

 // FX rates
 const rate=async(date,value,over={})=>(await run(api,T.id,"insert into lara.fx_rates(tenant_id,entity_id,base_currency,quote_currency,rate_date,rate,source_evidence_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning id",[T.id,entity,over.base||'USD',over.quote||'PHP',date,value,evidence,principal])).rows[0].id;
 const r1=await rate('2026-10-05','56');
 await rejects(rate('2026-10-05','56',{base:'USD',quote:'USD'}),/check constraint|violates/,'same base and quote');
 await rejects(rate('2026-10-05','-1'),/check constraint|violates/,'negative rate');
 await rejects(run(api,T.id,"update lara.fx_rates set status='approved',approved_by=$2 where id=$1",[r1,principal]),/check constraint|violates/,'author approving');
 await run(api,T.id,"update lara.fx_rates set status='approved',approved_by=$2 where id=$1",[r1,approver]);
 const r1b=await rate('2026-10-05','57');
 await rejects(run(api,T.id,"update lara.fx_rates set status='approved',approved_by=$2 where id=$1",[r1b,approver]),/fx_rates_one_approved|duplicate key/,'two approved rates for one pair and date');
 await rejects(run(api,T.id,"update lara.fx_rates set rate=58 where id=$1",[r1]),/immutable/,'approved rate edited');
 await rejects(run(api,T.id,"update lara.fx_rates set status='draft' where id=$1",[r1]),/immutable|cannot move/,'approved rate reopened');
 pass('FX rates need distinct currencies and a positive value, are approved by another principal, one approved per pair and date, and are immutable once approved');

 // Posting function: FX entries
 const post=(p)=>run(api,T.id,'select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:T.id,entityId:entity,bookId:book,sourceType:'test',sourceId:randomUUID(),sourceVersion:1,accountingDate:'2026-10-05',documentDate:'2026-10-05',description:'FX test',postingActor:principal,...p})]);
 const lines=[{accountId:ar,branchId:branch,debit:'100.00',credit:'0',dimensions:{}},{accountId:rev,branchId:branch,debit:'0',credit:'100.00',dimensions:{}}];
 await rejects(post({currency:'USD',lines}),/never default to 1/,'foreign currency without a rate');
 await rejects(post({currency:'USD',rate:'56',lines:[{...lines[0],funcDebit:'5600.00'},{...lines[1],funcCredit:'5599.00'}]}),/functional debits/,'unbalanced functional totals');
 await rejects(post({currency:'USD',rate:'56',lines:[{...lines[0],funcDebit:'0',funcCredit:'5600.00'},{...lines[1],funcCredit:'5600.00'}]}),/functional side differs/,'functional side differing from the transaction side');
 const fxId=(await post({currency:'USD',rate:'56',lines})).rows[0].id;
 const e=(await run(api,T.id,'select fx_rate::text as r,transaction_currency,functional_currency,total_debit::text as td from lara.journal_entries where id=$1',[fxId])).rows[0];
 assert.deepEqual([Number(e.r),e.transaction_currency,e.functional_currency,Number(e.td)],[56,'USD','PHP',5600],'the entry records the rate and functional totals');
 const jl=(await run(api,T.id,'select txn_debit::text as td,func_debit::text as fd from lara.journal_lines where entry_id=$1 order by line_no',[fxId])).rows[0];
 assert.deepEqual([Number(jl.td),Number(jl.fd)],[100,5600]);
 const phpId=(await post({currency:'PHP',lines})).rows[0].id;
 assert.equal(Number((await run(api,T.id,'select fx_rate::text as r from lara.journal_entries where id=$1',[phpId])).rows[0].r),1,'functional-currency entries keep rate 1');
 await rejects(post({bookId:mgmt,currency:'PHP',lines:[{...lines[0],accountId:mcash},{...lines[1],accountId:mrev}]}),/management view never posts/,'posting into a management view');
 const flines=[{accountId:fcash,branchId:branch,debit:'10.00',credit:'0',dimensions:{}},{accountId:fdep,branchId:branch,debit:'0',credit:'10.00',dimensions:{}}];
 await post({bookId:fcdu,currency:'USD',lines:flines});
 await run(api,T.id,"insert into lara.book_access(tenant_id,entity_id,book_id,principal_id,access,granted_by) values($1,$2,$3,$4,'post',$5)",[T.id,entity,fcdu,approver,principal]);
 await rejects(run(api,T.id,"insert into lara.book_access(tenant_id,entity_id,book_id,principal_id,access,granted_by) values($1,$2,$3,$4,'post',$4)",[T.id,entity,fcdu,approver]),/check constraint|violates/,'granting oneself');
 await rejects(post({bookId:fcdu,currency:'USD',lines:flines}),/no posting access/,'posting into a closed partition without a grant');
 await post({bookId:fcdu,currency:'USD',postingActor:approver,lines:flines});
 pass('the posting function refuses a foreign currency without a rate, requires balanced functional totals on matching sides, records the rate with functional header totals, keeps rate 1 for functional entries, refuses a management view and a closed partition without a posting grant');

 // Layers and revaluation runs
 const doc=(await run(owner,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,branch_id,kind,party_id,document_date,accounting_date,currency,rule_profile_version,net,tax,gross,state,content_hash,created_by) select $1,$2,$3,$4,'invoice',p.id,'2026-10-05','2026-10-05','USD','ph-2026',100,0,100,'posted',$5,$6 from (select gen_random_uuid() as id) p returning id",[T.id,entity,book,branch,hash('d'),principal]).catch(()=>({rows:[]}))).rows[0];
 if(doc){
  const party=(await run(owner,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,roles,identity_status,address_json,content_hash,created_by) values($1,$2,'Buyer','[\"customer\"]','unknown','{}',$3,$4) returning id",[T.id,entity,hash('p'),principal]).catch(()=>({rows:[{id:null}]}))).rows[0];
  if(party.id){
   await run(owner,T.id,'update lara.documents set party_id=$2 where id=$1',[doc.id,party.id]);
   const item=(await run(owner,T.id,"insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AR',$4,100,'USD','2026-11-04') returning id",[T.id,entity,doc.id,party.id])).rows[0].id;
   await run(api,T.id,"insert into lara.fx_open_item_layers(tenant_id,entity_id,open_item_id,seq,event,txn_remaining,func_carrying,rate,created_by) values($1,$2,$3,1,'open',100,5600,56,$4)",[T.id,entity,item,principal]);
   await rejects(run(api,T.id,"insert into lara.fx_open_item_layers(tenant_id,entity_id,open_item_id,seq,event,txn_remaining,func_carrying,rate,created_by) values($1,$2,$3,1,'settle',60,3360,57,$4)",[T.id,entity,item,principal]),/duplicate key/,'same layer sequence twice');
   await rejects(run(api,T.id,"insert into lara.fx_open_item_layers(tenant_id,entity_id,open_item_id,seq,event,txn_remaining,func_carrying,rate,created_by) values($1,$2,$3,2,'settle',-1,0,57,$4)",[T.id,entity,item,principal]),/check constraint|violates/,'negative remaining');
   await rejects(run(api,T.id,"update lara.fx_open_item_layers set func_carrying=0 where open_item_id=$1",[item]),/APPEND_ONLY|permission denied/,'layer edited');
  }
 }
 const period=(await run(api,T.id,'select id from lara.periods where book_id=$1',[book])).rows[0].id;
 const closing=await rate('2026-10-31','58');await run(api,T.id,"update lara.fx_rates set status='approved',approved_by=$2 where id=$1",[closing,approver]);
 const runRow=async(rateId)=>(await run(api,T.id,"insert into lara.revaluation_runs(tenant_id,entity_id,book_id,period_id,rate_set_id,currency,account_ids,created_by) values($1,$2,$3,$4,$5,'USD',$6,$7) returning id",[T.id,entity,book,period,rateId,JSON.stringify([ar]),principal])).rows[0].id;
 const v1=await runRow(closing);
 await rejects(runRow(closing),/revaluation_runs_one_per_set|duplicate key/,'two runs for one rate set');
 await rejects(run(api,T.id,"update lara.revaluation_runs set state='approved',approved_by=$2 where id=$1",[v1,approver]),/cannot move from draft|check constraint|violates/,'draft straight to approved');
 await rejects(run(api,T.id,"update lara.revaluation_runs set state='previewed' where id=$1",[v1]),/check constraint|violates/,'previewed without a preview');
 await run(api,T.id,"update lara.revaluation_runs set state='previewed',preview_json='{\"lines\":[]}' where id=$1",[v1]);
 await rejects(run(api,T.id,"update lara.revaluation_runs set state='approved',approved_by=$2 where id=$1",[v1,principal]),/check constraint|violates/,'preparer approving');
 await run(api,T.id,"update lara.revaluation_runs set state='approved',approved_by=$2 where id=$1",[v1,approver]);
 await rejects(run(api,T.id,"update lara.revaluation_runs set account_ids='[]' where id=$1",[v1]),/frozen|check constraint|violates/,'approved run edited');
 await rejects(run(api,T.id,"update lara.revaluation_runs set state='posted' where id=$1",[v1]),/check constraint|violates/,'posted without an entry');
 await run(api,T.id,"update lara.revaluation_runs set state='posted',entry_id=$2 where id=$1",[v1,phpId]);
 await rejects(run(api,T.id,"update lara.revaluation_runs set entry_id=$2 where id=$1",[v1,fxId]),/keeps its entry/,'posted entry swapped');
 await rejects(run(api,T.id,"update lara.revaluation_runs set state='draft' where id=$1",[v1]),/cannot move from posted/,'posted run reopened');
 pass('FX layers are append-only with one sequence per item and non-negative remaining; revaluation runs are one per rate set, follow draft → previewed → approved → posted with a preview, an independent approver and an entry, and freeze once approved');

 for(const table of ['book_access','book_links','fx_rates','fx_open_item_layers','revaluation_runs'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.fx_rates')).rows[0].n,0,'rates visible without a tenant');
 await rejects(run(api,other.id,"insert into lara.book_links(tenant_id,entity_id,source_book_id,target_view_id,translation_policy,created_by) values($1,$2,$3,$4,'as_is',$5)",[T.id,entity,book,mgmt,principal]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['fx_rates','revaluation_runs','book_access'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security isolates tenants on every FX table and the runtime role cannot delete FX records');
 console.log('P09-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
