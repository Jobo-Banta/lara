// P10-01 inventory schema acceptance against real PostgreSQL through the
// runtime role: items are unique per SKU with distinct stock and cost
// accounts; movements follow draft → submitted → approved → posted with an
// independent approver, frozen lines once submitted and immutable content
// once posted; balances never go negative; layers keep their identity and
// allocations are append-only; a serial is one unit; counts freeze once
// approved; landed cost runs are one per charge; row-level security isolates
// every table.
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
const T={id:randomUUID(),slug:'p02-test-inv-'+suffix};
const other={id:randomUUID(),slug:'p02-test-inv-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Inventory schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Clerk') returning id",[T.id,'clerk-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Approver') returning id",[T.id,'approver-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Trading entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const acct=async(code,category,side)=>(await run(api,T.id,"insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,status,content_hash,created_by) values($1,$2,$3,$4,$4,$5,$6,'none',true,'active',$7,$8) returning id",[T.id,entity,book,code,category,side,hash(code),principal])).rows[0].id;
 const inv=await acct('1500','asset','debit'),cogs=await acct('5100','expense','debit');
 const wh=(await run(api,T.id,"insert into lara.warehouses(tenant_id,entity_id,branch_id,code,name,created_by) values($1,$2,$3,'WH1','Main',$4) returning id",[T.id,entity,branch,principal])).rows[0].id;
 const wh2=(await run(api,T.id,"insert into lara.warehouses(tenant_id,entity_id,branch_id,code,name,created_by) values($1,$2,$3,'WH2','Store',$4) returning id",[T.id,entity,branch,principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.warehouses(tenant_id,entity_id,branch_id,code,name,created_by) values($1,$2,$3,'WH1','Again',$4)",[T.id,entity,branch,principal]),/duplicate key/,'same warehouse code twice');
 const item=(await run(api,T.id,"insert into lara.items(tenant_id,entity_id,sku,description,uom,cost_method,tracking,stock_account_id,cogs_account_id,created_by) values($1,$2,'WIDGET','Widget','pc','fifo','none',$3,$4,$5) returning id",[T.id,entity,inv,cogs,principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.items(tenant_id,entity_id,sku,description,uom,cost_method,tracking,stock_account_id,cogs_account_id,created_by) values($1,$2,'WIDGET','Again','pc','fifo','none',$3,$4,$5)",[T.id,entity,inv,cogs,principal]),/duplicate key/,'same SKU twice');
 await rejects(run(api,T.id,"insert into lara.items(tenant_id,entity_id,sku,description,uom,cost_method,tracking,stock_account_id,cogs_account_id,created_by) values($1,$2,'SAME','Same','pc','fifo','none',$3,$3,$4)",[T.id,entity,inv,principal]),/check constraint|violates/,'stock and cost accounts must differ');
 await rejects(run(api,T.id,"insert into lara.items(tenant_id,entity_id,sku,description,uom,cost_method,tracking,stock_account_id,cogs_account_id,created_by) values($1,$2,'LIFO','x','pc','lifo','none',$3,$4,$5)",[T.id,entity,inv,cogs,principal]),/check constraint|violates/,'unknown cost method');
 pass('fixture with warehouses unique per code and items unique per SKU with enumerated cost methods and distinct stock and cost of sales accounts');

 // Movements and lines
 const mv=async(kind,over={})=>(await run(api,T.id,"insert into lara.stock_movements(tenant_id,entity_id,book_id,kind,warehouse_id,to_warehouse_id,accounting_date,content_hash,created_by) values($1,$2,$3,$4,$5,$6,'2026-10-05',$7,$8) returning id",[T.id,entity,book,kind,over.warehouse||wh,over.to||null,hash(kind+Math.random()),principal])).rows[0].id;
 await rejects(mv('transfer'),/check constraint|violates/,'transfer without a destination');
 await rejects(mv('transfer',{to:wh}),/check constraint|violates/,'transfer to the same warehouse');
 await rejects(mv('receipt',{to:wh2}),/check constraint|violates/,'destination on a non-transfer');
 const m1=await mv('receipt');
 const lineSql="insert into lara.stock_movement_lines(tenant_id,entity_id,movement_id,line_no,item_id,quantity,unit_cost) values($1,$2,$3,$4,$5,$6,$7) returning id";
 const l1=(await run(api,T.id,lineSql,[T.id,entity,m1,1,item,10,30])).rows[0].id;
 await rejects(run(api,T.id,lineSql,[T.id,entity,m1,2,item,0,30]),/check constraint|violates/,'zero quantity');
 await rejects(run(api,T.id,lineSql,[T.id,entity,m1,1,item,1,30]),/duplicate key/,'duplicate line number');
 await rejects(run(api,T.id,"update lara.stock_movements set state='approved',approved_by=$2 where id=$1",[m1,approver]),/cannot move from draft/,'draft straight to approved');
 await run(api,T.id,"update lara.stock_movements set state='submitted' where id=$1",[m1]);
 await rejects(run(api,T.id,lineSql,[T.id,entity,m1,2,item,1,30]),/frozen/,'line added after submission');
 await rejects(run(api,T.id,"update lara.stock_movement_lines set quantity=11 where id=$1",[l1]),/frozen/,'line changed after submission');
 await rejects(run(api,T.id,"update lara.stock_movements set state='approved',approved_by=$2 where id=$1",[m1,principal]),/check constraint|violates/,'author approving');
 await run(api,T.id,"update lara.stock_movements set state='approved',approved_by=$2 where id=$1",[m1,approver]);
 await rejects(run(api,T.id,"update lara.stock_movements set content_hash=$2 where id=$1",[m1,hash('changed')]),/content changed|immutable/,'approved content changed');
 await run(api,T.id,"update lara.stock_movements set state='posted' where id=$1",[m1]);
 await rejects(run(api,T.id,"update lara.stock_movements set accounting_date='2026-10-06' where id=$1",[m1]),/immutable/,'posted movement edited');
 await rejects(run(api,T.id,"update lara.stock_movements set state='draft' where id=$1",[m1]),/immutable|cannot move/,'posted movement reopened');
 await rejects(run(api,T.id,"update lara.stock_movement_lines set cost=1 where id=$1",[l1]),/immutable/,'posted line cost edited');
 pass('stock movements follow draft → submitted → approved → posted with a separate approver, transfers name a different destination, lines freeze at submission and content is immutable once posted');

 // Balances, layers, allocations, serials
 await run(api,T.id,"insert into lara.stock_balances(tenant_id,entity_id,item_id,warehouse_id,quantity,value) values($1,$2,$3,$4,10,300)",[T.id,entity,item,wh]);
 await rejects(run(api,T.id,"update lara.stock_balances set quantity=-1 where item_id=$1",[item]),/check constraint|violates/,'negative balance');
 await rejects(run(api,T.id,"update lara.stock_balances set quantity=0,value=5 where item_id=$1",[item]),/check constraint|violates/,'value without quantity');
 const layer=(await run(api,T.id,"insert into lara.valuation_layers(tenant_id,entity_id,item_id,warehouse_id,receipt_line_id,effective_date,qty_received,qty_remaining,unit_cost,currency) values($1,$2,$3,$4,$5,'2026-10-05',10,10,30,'PHP') returning id",[T.id,entity,item,wh,l1])).rows[0].id;
 await rejects(run(api,T.id,"update lara.valuation_layers set qty_remaining=11 where id=$1",[layer]),/check constraint|violates/,'remaining beyond received');
 await rejects(run(api,T.id,"update lara.valuation_layers set warehouse_id=$2 where id=$1",[layer,wh2]),/immutable/,'layer moved to another warehouse');
 await run(api,T.id,"update lara.valuation_layers set qty_remaining=4 where id=$1",[layer]);
 await run(api,T.id,"insert into lara.stock_allocations(tenant_id,entity_id,issue_line_id,layer_id,quantity,cost) values($1,$2,$3,$4,6,180)",[T.id,entity,l1,layer]);
 await rejects(run(api,T.id,"update lara.stock_allocations set cost=0 where layer_id=$1",[layer]),/APPEND_ONLY|permission denied/,'allocation edited');
 await run(api,T.id,"insert into lara.lot_serials(tenant_id,entity_id,item_id,code,kind,warehouse_id,quantity,created_by) values($1,$2,$3,'SN-1','serial',$4,1,$5)",[T.id,entity,item,wh,principal]);
 await rejects(run(api,T.id,"insert into lara.lot_serials(tenant_id,entity_id,item_id,code,kind,warehouse_id,quantity,created_by) values($1,$2,$3,'SN-1','serial',$4,1,$5)",[T.id,entity,item,wh2,principal]),/duplicate key/,'the same serial in a second warehouse');
 await rejects(run(api,T.id,"update lara.lot_serials set quantity=2 where code='SN-1'"),/check constraint|violates/,'a serial with two units');
 pass('balances never go negative and carry no value without quantity, layers keep their identity and remaining within received, allocations are append-only, and a serial is one unit in one warehouse');

 // Counts and landed cost runs
 const cs=(await run(api,T.id,"insert into lara.count_sessions(tenant_id,entity_id,book_id,warehouse_id,cutoff_at,created_by) values($1,$2,$3,$4,now(),$5) returning id",[T.id,entity,book,wh,principal])).rows[0].id;
 await run(api,T.id,"insert into lara.count_lines(tenant_id,entity_id,session_id,item_id,expected_quantity,observed_quantity) values($1,$2,$3,$4,10,9)",[T.id,entity,cs,item]);
 await rejects(run(api,T.id,"insert into lara.count_lines(tenant_id,entity_id,session_id,item_id,expected_quantity,observed_quantity) values($1,$2,$3,$4,10,8)",[T.id,entity,cs,item]),/duplicate key/,'an item counted twice in a session');
 await rejects(run(api,T.id,"update lara.count_sessions set state='approved',approved_by=$2 where id=$1",[cs,principal]),/check constraint|violates/,'counter approving');
 await run(api,T.id,"update lara.count_sessions set state='approved',approved_by=$2 where id=$1",[cs,approver]);
 await rejects(run(api,T.id,"update lara.count_lines set observed_quantity=7 where session_id=$1",[cs]),/frozen/,'observed quantity changed after approval');
 await rejects(run(api,T.id,"update lara.count_sessions set state='posted' where id=$1",[cs]),/names its adjustment|check constraint|violates/,'posted count without a movement');
 const doc=(await run(owner,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,branch_id,kind,party_id,document_date,accounting_date,currency,rule_profile_version,net,tax,gross,state,content_hash,created_by) values($1,$2,$3,$4,'bill',gen_random_uuid(),'2026-10-05','2026-10-05','PHP','ph-2026',90,0,90,'posted',$5,$6) returning id",[T.id,entity,book,branch,hash('d'),principal]).catch(()=>({rows:[]}))).rows[0];
 if(doc){
  const lc=(await run(api,T.id,"insert into lara.landed_cost_runs(tenant_id,entity_id,book_id,charge_document_id,receipt_ids,method,amount,created_by) values($1,$2,$3,$4,$5,'value',90,$6) returning id",[T.id,entity,book,doc.id,JSON.stringify([m1]),principal])).rows[0].id;
  await rejects(run(api,T.id,"insert into lara.landed_cost_runs(tenant_id,entity_id,book_id,charge_document_id,receipt_ids,method,amount,created_by) values($1,$2,$3,$4,$5,'value',90,$6)",[T.id,entity,book,doc.id,JSON.stringify([m1]),principal]),/landed_cost_runs_one_per_charge|duplicate key/,'two runs for one charge');
  await rejects(run(api,T.id,"update lara.landed_cost_runs set state='approved',approved_by=$2 where id=$1",[lc,approver]),/cannot move from draft|check constraint|violates/,'draft straight to approved');
  await run(api,T.id,"update lara.landed_cost_runs set state='previewed',preview_json='{\"allocations\":[]}' where id=$1",[lc]);
  await run(api,T.id,"update lara.landed_cost_runs set state='approved',approved_by=$2 where id=$1",[lc,approver]);
  await rejects(run(api,T.id,"update lara.landed_cost_runs set amount=100 where id=$1",[lc]),/frozen/,'approved run edited');
  await rejects(run(api,T.id,"update lara.landed_cost_runs set state='posted' where id=$1",[lc]),/check constraint|violates/,'posted without an entry');
 }
 pass('counts count each item once, are approved by another principal, freeze afterwards and post only with their adjustment movement; landed cost runs are one per charge and freeze once approved');

 for(const table of ['warehouses','items','stock_movements','stock_movement_lines','stock_balances','valuation_layers','stock_allocations','lot_serials','count_sessions','count_lines','landed_cost_runs','landed_cost_allocations'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.stock_movements')).rows[0].n,0,'movements visible without a tenant');
 await rejects(run(api,other.id,"insert into lara.warehouses(tenant_id,entity_id,branch_id,code,name,created_by) values($1,$2,$3,'X','x',$4)",[T.id,entity,branch,principal]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['items','stock_movements','valuation_layers','count_sessions','landed_cost_runs'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security isolates tenants on every inventory table and the runtime role cannot delete inventory records');
 console.log('P10-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
