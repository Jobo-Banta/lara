// P08-01 financial institution coexistence schema acceptance against real
// PostgreSQL through the runtime role: source ownership follows draft →
// approved with a separate approver, is immutable once approved and never
// overlaps an approved window; mapping versions are unique per source and
// label with lines frozen after approval; source batches are unique per
// source and external id, follow staged → validated → approved → posted →
// replaced, refuse approval with errors and are immutable once posted with
// their rows frozen; expected batches are unique per source, kind and period;
// balance snapshots and roll-ups are append-only; instrument facts are
// immutable; row-level security isolates every table.
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
const T={id:randomUUID(),slug:'p02-test-fi-'+suffix};
const other={id:randomUUID(),slug:'p02-test-fi-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Institution schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Officer') returning id",[T.id,'officer-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Approver') returning id",[T.id,'approver-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Pilot bank',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const account=(await run(owner,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,'1010','Cash','asset','debit','none',true,'active',$4,$5) returning id",[T.id,entity,book,hash('a'),principal])).rows[0].id;
 const evidence=(await run(api,T.id,"insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,'feed.csv',$4,'text/csv',10,'available','internal',$5) returning id",[T.id,entity,'k-'+suffix,hash('csv'),principal])).rows[0].id;
 const system=(await run(api,T.id,"insert into lara.source_systems(tenant_id,entity_id,code,name,owner_name,granularity,created_by) values($1,$2,'CBS','Core banking','IT','detail',$3) returning id",[T.id,entity,principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.source_systems(tenant_id,entity_id,code,name,owner_name,granularity,created_by) values($1,$2,'CBS','Again','IT','detail',$3)",[T.id,entity,principal]),/duplicate key/,'same source code twice');
 await rejects(run(api,T.id,"insert into lara.source_systems(tenant_id,entity_id,code,name,owner_name,granularity,created_by) values($1,$2,'X','x','IT','hourly',$3)",[T.id,entity,principal]),/check constraint|violates/,'unknown granularity');
 pass('fixture tenant with entity, branch, book, account, evidence and a source system unique per code with an enumerated granularity');

 // Source ownership
 const own=async(family,from,to=null)=>(await run(api,T.id,"insert into lara.source_ownership(tenant_id,entity_id,book_id,source_system,transaction_family,effective_from,effective_to,evidence_ids,created_by) values($1,$2,$3,'CBS',$4,$5,$6,$7,$8) returning id",[T.id,entity,book,family,from,to,JSON.stringify([evidence]),principal])).rows[0].id;
 const o1=await own('journal','2026-01-01');
 await rejects(run(api,T.id,"insert into lara.source_ownership(tenant_id,entity_id,book_id,source_system,transaction_family,effective_from,evidence_ids,created_by) values($1,$2,$3,'CBS','journal','2026-01-01','[]',$4)",[T.id,entity,book,principal]),/check constraint|violates/,'ownership without evidence');
 await rejects(run(api,T.id,"update lara.source_ownership set status='approved',approved_by=$2 where id=$1",[o1,principal]),/check constraint|violates/,'author approving');
 await run(api,T.id,"update lara.source_ownership set status='approved',approved_by=$2 where id=$1",[o1,approver]);
 await rejects(run(api,T.id,"update lara.source_ownership set effective_from='2026-02-01' where id=$1",[o1]),/immutable/,'approved window edited');
 const o2=await own('journal','2026-06-01','2026-12-31');
 await rejects(run(api,T.id,"update lara.source_ownership set status='approved',approved_by=$2 where id=$1",[o2,approver]),/already covers/,'overlapping approved windows');
 const o3=await own('balances','2026-01-01');
 await run(api,T.id,"update lara.source_ownership set status='approved',approved_by=$2 where id=$1",[o3,approver]);
 await rejects(run(api,T.id,"update lara.source_ownership set status='draft' where id=$1",[o1]),/cannot move from approved/,'approved back to draft');
 pass('source ownership needs evidence, is approved by another principal, freezes its window afterwards, and never overlaps an approved window of the same book and family');

 // Mapping versions and lines
 const mv=(await run(api,T.id,"insert into lara.mapping_versions(tenant_id,entity_id,source_system_id,version_label,evidence_id,hash,line_count,created_by) values($1,$2,$3,'v1',$4,$5,1,$6) returning id",[T.id,entity,system,evidence,hash('m1'),principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.mapping_versions(tenant_id,entity_id,source_system_id,version_label,evidence_id,hash,line_count,created_by) values($1,$2,$3,'v1',$4,$5,1,$6)",[T.id,entity,system,evidence,hash('m2'),principal]),/duplicate key/,'same label twice');
 await run(api,T.id,"insert into lara.mapping_lines(tenant_id,entity_id,mapping_version_id,source_account,target_account_id) values($1,$2,$3,'100100',$4)",[T.id,entity,mv,account]);
 await rejects(run(api,T.id,"insert into lara.mapping_lines(tenant_id,entity_id,mapping_version_id,source_account,target_account_id) values($1,$2,$3,'100100',$4)",[T.id,entity,mv,account]),/duplicate key/,'same source account twice in a version');
 await rejects(run(api,T.id,"update lara.mapping_versions set status='approved',approved_by=$2 where id=$1",[mv,principal]),/check constraint|violates/,'importer approving the mapping');
 await run(api,T.id,"update lara.mapping_versions set status='approved',approved_by=$2 where id=$1",[mv,approver]);
 await rejects(run(api,T.id,"insert into lara.mapping_lines(tenant_id,entity_id,mapping_version_id,source_account,target_account_id) values($1,$2,$3,'100200',$4)",[T.id,entity,mv,account]),/frozen/,'line added to an approved mapping');
 await rejects(run(api,T.id,"delete from lara.mapping_lines where mapping_version_id=$1",[mv]),/frozen|permission denied/,'line removed from an approved mapping');
 await rejects(run(api,T.id,"update lara.mapping_versions set hash=$2 where id=$1",[mv,hash('m3')]),/immutable/,'approved hash edited');
 pass('mapping versions are unique per source and label, approved by another principal, and their lines freeze once approved');

 // Source batches and rows
 const imp=async(ext,checksum)=>(await run(api,T.id,"insert into lara.opening_batches(tenant_id,entity_id,book_id,kind,evidence_id,checksum,cutoff,source_id,external_batch_id,mapping_version,created_by) values($1,$2,$3,'journal',$4,$5,'2026-10-31','CBS',$6,'v1',$7) returning id",[T.id,entity,book,evidence,checksum,ext,principal])).rows[0].id;
 const i1=await imp('B1',hash('c1'));
 const batch=async(importId,ext,checksum)=>(await run(api,T.id,"insert into lara.source_batches(tenant_id,entity_id,book_id,source_system_id,import_id,kind,external_batch_id,checksum,mapping_version_id,created_by) values($1,$2,$3,$4,$5,'journal',$6,$7,$8,$9) returning id",[T.id,entity,book,system,importId,ext,checksum,mv,principal])).rows[0].id;
 const b1=await batch(i1,'B1',hash('c1'));
 const i1b=await imp('B1-dup',hash('c1b'));
 await rejects(batch(i1b,'B1',hash('c2')),/duplicate key|source_batches_external/,'same external batch id twice for a source');
 await rejects(batch(i1,'B9',hash('c9')),/duplicate key/,'two source batches for one import');
 await run(api,T.id,"insert into lara.source_rows(tenant_id,entity_id,batch_id,row_no,external_line_id,accounting_date,book_code,branch_code,branch_id,account_code,target_account_id,currency,debit,credit) values($1,$2,$3,1,'L1','2026-10-05','PHP-MAIN','HQ',$4,'100100',$5,'PHP',100,0)",[T.id,entity,b1,branch,account]);
 await rejects(run(api,T.id,"insert into lara.source_rows(tenant_id,entity_id,batch_id,row_no,external_line_id,accounting_date,book_code,branch_code,account_code,currency,debit,credit) values($1,$2,$3,2,'L1','2026-10-05','PHP-MAIN','HQ','100100','PHP',0,100)",[T.id,entity,b1]),/duplicate key/,'same external line id twice in a batch');
 await rejects(run(api,T.id,"insert into lara.source_rows(tenant_id,entity_id,batch_id,row_no,external_line_id,status) values($1,$2,$3,3,'L3','error')",[T.id,entity,b1]),/check constraint|violates/,'error row without an error');
 await rejects(run(api,T.id,"update lara.source_batches set state='approved' where id=$1",[b1]),/cannot move from staged/,'staged straight to approved');
 await run(api,T.id,"update lara.source_batches set state='validated',row_count=1,error_count=1 where id=$1",[b1]);
 await rejects(run(api,T.id,"update lara.source_batches set state='approved' where id=$1",[b1]),/cannot be approved/,'approval with errors');
 await run(api,T.id,"update lara.source_batches set error_count=0,state='approved' where id=$1",[b1]);
 await rejects(run(api,T.id,"insert into lara.source_rows(tenant_id,entity_id,batch_id,row_no,external_line_id) values($1,$2,$3,4,'L4')",[T.id,entity,b1]),/frozen/,'row added to an approved batch');
 await rejects(run(api,T.id,"update lara.source_batches set state='posted' where id=$1",[b1]),/check constraint|violates/,'posted journal batch without its entry');
 const period=(await run(owner,T.id,"insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,status,created_by) values($1,$2,$3,'2026-10-01','2026-10-31','open',$4) returning id",[T.id,entity,book,principal])).rows[0].id;
 const entry=(await run(owner,T.id,"insert into lara.journal_entries(tenant_id,entity_id,book_id,source_type,source_id,source_version,purpose,accounting_date,document_date,description,period_id,transaction_currency,functional_currency,posting_actor,lines_hash,line_count,total_debit,total_credit) values($1,$2,$3,'source_batch',$4,1,'posting','2026-10-05','2026-10-05','B1',$5,'PHP','PHP',$6,$7,2,100,100) returning id",[T.id,entity,book,b1,period,principal,hash('lines')])).rows[0].id;
 await run(api,T.id,"update lara.source_batches set state='posted',posted_entry_id=$2 where id=$1",[b1,entry]);
 await rejects(run(api,T.id,"update lara.source_batches set checksum=$2 where id=$1",[b1,hash('c3')]),/immutable/,'posted checksum edited');
 await rejects(run(api,T.id,"update lara.source_batches set state='staged' where id=$1",[b1]),/cannot move from posted/,'posted batch reopened');
 await rejects(run(api,T.id,"update lara.source_batches set state='replaced' where id=$1",[b1]),/names its replacement/,'replaced without a replacement');
 const i2=await imp('B1R',hash('c4'));const b2=await batch(i2,'B1R',hash('c4'));
 await run(api,T.id,"update lara.source_batches set state='replaced',replaced_by_batch_id=$2 where id=$1",[b1,b2]);
 pass('source batches are one per import and external id, follow staged → validated → approved → posted → replaced, refuse approval with errors and posting without an entry, freeze rows once approved and content once posted');

 // Expected batches, snapshots, facts, roll-ups
 await run(api,T.id,"insert into lara.expected_batches(tenant_id,entity_id,source_system_id,book_id,kind,period_start,period_end,deadline_at,created_by) values($1,$2,$3,$4,'journal','2026-10-01','2026-10-31','2026-11-03T00:00:00Z',$5)",[T.id,entity,system,book,principal]);
 await rejects(run(api,T.id,"insert into lara.expected_batches(tenant_id,entity_id,source_system_id,book_id,kind,period_start,period_end,deadline_at,created_by) values($1,$2,$3,$4,'journal','2026-10-01','2026-10-31','2026-11-05T00:00:00Z',$5)",[T.id,entity,system,book,principal]),/duplicate key/,'same expectation twice');
 await rejects(run(api,T.id,"update lara.expected_batches set state='received' where source_system_id=$1",[system]),/check constraint|violates/,'received without the batch');
 await run(api,T.id,"insert into lara.source_balance_snapshots(tenant_id,entity_id,source_system_id,batch_id,book_id,account_code,currency,balance,cutoff) values($1,$2,$3,$4,$5,'130100','PHP',1000,'2026-10-31')",[T.id,entity,system,b2,book]);
 await rejects(run(api,T.id,"insert into lara.source_balance_snapshots(tenant_id,entity_id,source_system_id,batch_id,book_id,account_code,currency,balance,cutoff) values($1,$2,$3,$4,$5,'130100','PHP',2000,'2026-10-31')",[T.id,entity,system,b2,book]),/duplicate key/,'two balances for one account and cutoff');
 await rejects(run(api,T.id,"update lara.source_balance_snapshots set balance=0 where source_system_id=$1",[system]),/APPEND_ONLY|permission denied/,'snapshot edited');
 const rowId=(await run(api,T.id,"select id from lara.source_rows where batch_id=$1",[b1])).rows[0].id;
 const fact=(await run(api,T.id,"insert into lara.tax_instrument_facts(tenant_id,entity_id,source_system_id,batch_id,row_id,instrument_ref,instrument_type,maturity_date,amount,currency,income_category,event_date,created_by) values($1,$2,$3,$4,$5,'LN-1','loan','2029-10-05',100,'PHP','interest_income','2026-10-05',$6) returning id",[T.id,entity,system,b1,rowId,principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.tax_instrument_facts(tenant_id,entity_id,source_system_id,batch_id,row_id,instrument_ref,instrument_type,amount,currency,income_category,event_date,created_by) values($1,$2,$3,$4,$5,'LN-1','loan',-5,'PHP','interest_income','2026-10-05',$6)",[T.id,entity,system,b1,rowId,principal]),/check constraint|violates|duplicate key/,'negative amount or second fact per row');
 await rejects(run(api,T.id,"update lara.tax_instrument_facts set amount=200 where id=$1",[fact]),/immutable/,'fact amount edited');
 await run(api,T.id,"update lara.tax_instrument_facts set status='superseded',superseded_by_batch_id=$2 where id=$1",[fact,b2]);
 await rejects(run(api,T.id,"update lara.tax_instrument_facts set status='active' where id=$1",[fact]),/stay superseded/,'superseded fact reactivated');
 await run(api,T.id,"insert into lara.branch_rollups(tenant_id,entity_id,book_id,period_start,period_end,checksum,manifest_json,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4,'{}',$5)",[T.id,entity,book,hash('r'),principal]);
 await rejects(run(api,T.id,"update lara.branch_rollups set checksum=$1",[hash('r2')]),/APPEND_ONLY|permission denied/,'roll-up edited');
 pass('expected batches are unique per source, kind and period and need the batch to be received; balance snapshots and roll-ups are append-only; instrument facts are immutable and stay superseded');

 if(worker){
  await rejects(run(worker,T.id,"insert into lara.source_batches(tenant_id,entity_id,book_id,source_system_id,import_id,kind,external_batch_id,checksum,created_by) values($1,$2,$3,$4,$5,'journal','W',$6,$7)",[T.id,entity,book,system,i2,hash('w'),principal]),/permission denied/,'worker staging batches');
  await run(worker,T.id,"update lara.expected_batches set state='missing' where source_system_id=$1",[system]);
  pass('the worker sweeps expected batches but cannot stage source batches');
 }

 for(const table of ['source_systems','source_ownership','mapping_versions','mapping_lines','source_batches','source_rows','expected_batches','source_balance_snapshots','tax_instrument_facts','branch_rollups'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.source_batches')).rows[0].n,0,'batches visible without a tenant');
 await rejects(run(api,other.id,"insert into lara.source_systems(tenant_id,entity_id,code,name,owner_name,granularity,created_by) values($1,$2,'Z','z','z','detail',$3)",[T.id,entity,principal]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['source_systems','source_ownership','mapping_versions','source_batches','expected_batches','tax_instrument_facts'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security isolates tenants on every institution table and the runtime role cannot delete institution records');
 console.log('P08-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end(),worker?.end()]);
}
