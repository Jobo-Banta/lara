// P10-03 HTTP acceptance: inventory through the API and worker as processes.
// Items and warehouses over the reviewed operations; a goods receipt, a FIFO
// issue (AC-09) and a transfer through draft, submit, independent approval
// and posting; the stock card and the valuation-versus-ledger read; a count
// with its lines read, approved and posted; a landed cost run previewed with
// its allocations read, approved and posted once; the inventory_valuation
// report job; and isolation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,evidence,parties,purchasing,inventory} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4033,BASE='http://127.0.0.1:'+PORT,bucket='.local/p10-api-test-'+randomBytes(3).toString('hex');
const fieldKey=process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex');
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:fieldKey,WORKER_POLL_MS:'200',RATE_LIMIT_WRITES_PER_MINUTE:'2000',RATE_LIMIT_READS_PER_MINUTE:'5000',MAIL_ADAPTER:'local',EINVOICE_ADAPTER:'fixture'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
const children=[];
function start(file){const c=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>{out+=b;});c.stderr.on('data',b=>{out+=b;});c.log=()=>out;c.done=false;c.once('exit',()=>{c.done=true;});children.push(c);return c;}
async function stop(c){if(c.done)return;const exited=new Promise(r=>c.once('exit',r));c.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);if(!c.done)c.kill('SIGKILL');}
async function waitFor(fn,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,200));}assert.fail('timeout: '+label);}
const principals={};
const call=async(name,method,path,{body,headers={},raw}={})=>{const token=signIdentity(name+'-'+suffix,method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET);return fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token,...(raw?{}:{'content-type':'application/json'}),...headers},body:raw??(body===undefined?undefined:JSON.stringify(body))});};
const json=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return {raw:t};}};
const must=async(r,status)=>{const t=await r.text();assert.equal(r.status,status,t);try{return JSON.parse(t);}catch{return {raw:t};}};
const key=()=>({'idempotency-key':randomUUID()});
const im=v=>({'if-match':'"'+v+'"'});
const contract=(op,body)=>{const v=validateResponse(op,body);assert.equal(v.ok,true,op+' drifted: '+JSON.stringify(v.fieldErrors)+' '+JSON.stringify(body).slice(0,300));};
const apiProcess=start('apps/api/src/server.mjs');let worker=null;
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 let entityId,branchId,bookId,evidenceId,wh1,wh2,billId;const accounts={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-inv-'+suffix,name:'Inventory API',mode:'demo'});
  for(const n of ['stock','clerk','accountant','controller','director','auditor','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['clerk','accountant','controller','auditor','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.stock=await role('stock_clerk',['item.create','item.edit','item.read','stock_movement.create','stock_movement.edit','stock_movement.submit','stock_movement.read','stock_count.create','stock_count.edit','stock_count.read','landed_cost.create','landed_cost.edit','landed_cost.preview','landed_cost.read','evidence.upload','evidence.read','account.read','book.read','branch.read','report.generate','job.read']);
  roles.inv_approver=await role('inventory_approver',['stock_movement.approve','stock_movement.post','stock_movement.read','stock_count.approve','stock_count.post','stock_count.read','landed_cost.approve','landed_cost.post','landed_cost.read','item.read']);
  for(const [p,r] of [['stock','stock'],['clerk','clerk'],['accountant','accountant'],['accountant','inv_approver'],['controller','controller'],['director','controller'],['director','inv_approver'],['auditor','auditor'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Trading API Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  branchId=(await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'})).id;
  for(const c of ['workspace','general_ledger','sales','purchasing','treasury','inventory'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.director,principals.controller]);
  bookId=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,principals.controller])).rows[0].id;
  for(const [code,name,category,side] of [['1010','Cash','asset','debit'],['1500','Inventory','asset','debit'],['2150','Goods received not invoiced','liability','credit'],['4200','Stock gain','income','credit'],['5100','Cost of sales','expense','debit'],['5200','Stock loss','expense','debit'],['5300','Freight in','expense','debit'],['2100','Payables','liability','credit'],['1300','Input tax','asset','debit'],['2300','Withholding payable','liability','credit'],['1400','Advances','asset','debit']])accounts[code]=(await tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id",[tenantId,entityId,bookId,code,name,category,side,code==='2100'?'ap':code==='1300'?'input_tax':'none',!['2100','1300'].includes(code),sha(code),principals.controller])).rows[0].id;
  await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4)",[tenantId,entityId,bookId,principals.controller]);
  const dir={...await identity.actorContext(tx,tenantId,principals.director),traceId:'setup'};
  const s=await organization.saveSettings(tx,ctrl,entityId,'inventory_profile',{grniAccountId:accounts['2150'],stockGainAccountId:accounts['4200'],stockLossAccountId:accounts['5200'],landedCostClearingAccountId:accounts['5300'],threeWayTolerancePercent:'2',profileVersion:'inventory-2026'});
  await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});
  const stockCtx={...await identity.actorContext(tx,tenantId,principals.stock),traceId:'setup'};
  wh1=(await inventory.createWarehouse(tx,stockCtx,entityId,{code:'WH1',name:'Main',branchId})).id;
  wh2=(await inventory.createWarehouse(tx,stockCtx,entityId,{code:'WH2',name:'Store',branchId})).id;
  const pdf=Buffer.from('%PDF-1.4 count sheet\n');const store=new evidence.MemoryEvidenceStore();
  const reg=await evidence.registerUpload(tx,stockCtx,entityId,{filename:'count.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'internal'});
  await evidence.completeUpload(tx,stockCtx,entityId,reg.evidenceId,pdf,store);
  await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);
  evidenceId=reg.evidenceId;
  // A posted freight bill as the landed cost charge, through the purchasing flow.
  const pp=await organization.saveSettings(tx,ctrl,entityId,'purchasing_profile',{apAccountId:accounts['2100'],inputTaxAccountId:accounts['1300'],cashAccountId:accounts['1010'],withholdingPayableAccountId:accounts['2300'],advanceAccountId:accounts['1400'],withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
  await organization.approveSettings(tx,dir,entityId,pp.id,{payloadHash:pp.payloadHash});
  await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'bill','BILL','numbering-2026',$4)",[tenantId,entityId,branchId,principals.controller]);
  const clerkCtx={...await identity.actorContext(tx,tenantId,principals.clerk),traceId:'setup'},accCtx={...await identity.actorContext(tx,tenantId,principals.accountant),traceId:'setup'};
  const party=await parties.createParty(tx,clerkCtx,entityId,{legalName:'Forwarder',roles:['supplier'],identityStatus:'unknown',address:'Manila'},{FIELD_ENCRYPTION_KEY:fieldKey});
  const bill=await purchasing.createDocument(tx,clerkCtx,entityId,{kind:'bill',branchId,bookId,partyId:party.id,documentDate:'2026-10-10',accountingDate:'2026-10-10',currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:'FRT-1',lines:[{description:'Freight',quantity:'1',unitPrice:'90',discount:'0',priceBasis:'exclusive',accountId:accounts['5300'],dimensions:{}}],evidenceIds:[evidenceId]});
  await purchasing.submitDocument(tx,clerkCtx,entityId,bill.id,{});await purchasing.approveDocument(tx,accCtx,entityId,bill.id,{decision:'approve',contentVersion:1});await purchasing.postDocument(tx,accCtx,entityId,bill.id,{});
  billId=bill.id;
 });
 const eh={'x-entity-id':entityId};
 worker=start('apps/worker/src/main.mjs');
 // Items and warehouses.
 let r=await call('auditor','POST','/items',{body:{sku:'WIDGET',description:'Widget',uom:'pc',costMethod:'fifo',tracking:'none',stockAccountId:accounts['1500'],cogsAccountId:accounts['5100']},headers:{...key(),...eh}});assert.equal(r.status,403);
 r=await call('stock','POST','/items',{body:{sku:'WIDGET',description:'Widget',uom:'pc',costMethod:'fifo',tracking:'none',stockAccountId:accounts['1500'],cogsAccountId:accounts['5100']},headers:{...key(),...eh}});const item=await must(r,201);contract('post_items',item);
 r=await call('stock','PATCH','/items/'+item.id,{body:{sku:'WIDGET',description:'Widget, blue',uom:'pc',costMethod:'fifo',tracking:'none',stockAccountId:accounts['1500'],cogsAccountId:accounts['5100']},headers:{...eh,...im(item.version)}});const edited=await must(r,200);contract('patch_items_id',edited);assert.equal(edited.description,'Widget, blue');
 r=await call('auditor','GET','/items',{headers:eh});const items=await must(r,200);contract('get_items',items);assert.equal(items.items.length,1);
 r=await call('auditor','GET','/items/'+item.id,{headers:eh});contract('get_items_id',await must(r,200));
 r=await call('auditor','GET','/warehouses',{headers:eh});const whs=await must(r,200);contract('get_warehouses',whs);assert.deepEqual(whs.items.map(w=>w.code).sort(),['WH1','WH2']);
 pass('items over HTTP: created and edited by the stock clerk, refused to the examiner, listed and read; warehouses listed');
 // Movements: receipt, FIFO issue (AC-09), transfer.
 const move=async(body)=>{const m=await must(await call('stock','POST','/stock-movements',{body,headers:{...key(),...eh}}),201);contract('post_stock_movements',m);const s=await must(await call('stock','POST','/stock-movements/'+m.id+'/submit',{body:{},headers:{...key(),...eh,...im(m.version)}}),200);const a=await must(await call('accountant','POST','/stock-movements/'+m.id+'/approve',{body:{decision:'approve',contentVersion:m.contentVersion},headers:{...key(),...eh,...im(s.version)}}),200);const p=await must(await call('director','POST','/stock-movements/'+m.id+'/post',{body:{},headers:{...key(),...eh,...im(a.version)}}),200);contract('post_stock_movements_id_post',p);return {id:m.id,posted:p};};
 r=await call('stock','POST','/stock-movements',{body:{kind:'receipt',warehouseId:wh1,accountingDate:'2026-10-01',lines:[{itemId:item.id,quantity:'10'}]},headers:{...key(),...eh}});assert.equal(r.status,422,'receipt without a unit cost');
 const r1=await move({kind:'receipt',warehouseId:wh1,accountingDate:'2026-10-01',lines:[{itemId:item.id,quantity:'10',unitCost:'30'}],reason:'PO-A'});
 const r2=await move({kind:'receipt',warehouseId:wh1,accountingDate:'2026-10-03',lines:[{itemId:item.id,quantity:'10',unitCost:'50'}],reason:'PO-B'});
 r=await call('stock','POST','/stock-movements/'+r2.id+'/post',{body:{},headers:{...key(),...eh,...im(99)}});assert.equal(r.status,403,'the stock clerk holds no posting');
 const i1=await move({kind:'issue',warehouseId:wh1,accountingDate:'2026-10-05',lines:[{itemId:item.id,quantity:'12'}],reason:'sale'});
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 const lines=async id=>(await api.query('select a.code,l.txn_debit::text as d,l.txn_credit::text as c from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entry_id=$2 order by l.line_no',[tenantId,id])).rows.map(x=>[x.code,Number(x.d),Number(x.c)]);
 assert.deepEqual(await lines(i1.posted.journalEntryIds[0]),[['5100',400,0],['1500',0,400]],'AC-09 over HTTP');
 const tr=await move({kind:'transfer',warehouseId:wh1,toWarehouseId:wh2,accountingDate:'2026-10-06',lines:[{itemId:item.id,quantity:'3'}]});
 assert.equal(tr.posted.journalEntryIds.length,0);
 r=await call('auditor','GET','/stock-card?itemId='+item.id,{headers:eh});const card=await must(r,200);contract('get_stock_card',card);assert.deepEqual(card.balances.map(b=>[b.warehouseCode,b.quantity,b.value]),[['WH1','5.00','250.00'],['WH2','3.00','150.00']]);
 r=await call('auditor','GET','/stock-movements?warehouseId='+wh2,{headers:eh});const mvs=await must(r,200);contract('get_stock_movements',mvs);assert.equal(mvs.items.length,1);
 r=await call('auditor','GET','/stock-movements/'+r1.id,{headers:eh});contract('get_stock_movements_id',await must(r,200));
 r=await call('auditor','GET','/stock-movements/'+r1.id+'/recost',{headers:eh});const rc=await must(r,200);contract('get_stock_movements_id_recost',rc);assert.equal(rc.affected.length,0);
 r=await call('auditor','GET','/inventory-valuation?bookId='+bookId+'&asOf=2026-10-31',{headers:eh});const val=await must(r,200);contract('get_inventory_valuation',val);assert.deepEqual([val.accounts[0].state,val.accounts[0].stockValue],['ties','400.00']);
 pass('movements over HTTP: a receipt needs unit costs, the clerk cannot post, two receipts and a FIFO issue post AC-09, a transfer posts no entry, and the stock card, the movement reads, the recost read and the valuation-versus-ledger read carry contract shapes');
 // Count with lines read, approval and posting.
 r=await call('stock','POST','/stock-counts',{body:{warehouseId:wh1,cutoffAt:'2026-10-07T08:00:00Z',lines:[{itemId:item.id,observedQuantity:'4'}],evidenceIds:[evidenceId]},headers:{...key(),...eh}});const count=await must(r,201);contract('post_stock_counts',count);
 r=await call('auditor','GET','/stock-counts/'+count.id+'/lines',{headers:eh});const cl=await must(r,200);contract('get_stock_counts_id_lines',cl);assert.deepEqual([cl.lines[0].expectedQuantity,cl.lines[0].observedQuantity,cl.lines[0].varianceQuantity],['5.00','4.00','-1.00']);
 r=await call('stock','POST','/stock-counts/'+count.id+'/approve',{body:{decision:'approve',contentVersion:count.contentVersion},headers:{...key(),...eh,...im(count.version)}});assert.equal(r.status,403);
 r=await call('accountant','POST','/stock-counts/'+count.id+'/approve',{body:{decision:'approve',contentVersion:count.contentVersion},headers:{...key(),...eh,...im(count.version)}});const ca=await must(r,200);contract('post_stock_counts_id_approve',ca);
 r=await call('director','POST','/stock-counts/'+count.id+'/post',{body:{},headers:{...key(),...eh,...im(ca.version)}});const cp=await must(r,200);contract('post_stock_counts_id_post',cp);assert.equal(cp.journalEntryIds.length,1);
 assert.deepEqual(await lines(cp.journalEntryIds[0]),[['5200',50,0],['1500',0,50]],'the loss posts at the layer cost');
 r=await call('auditor','GET','/stock-counts',{headers:eh});const counts=await must(r,200);contract('get_stock_counts',counts);assert.equal(counts.items[0].state,'posted');
 r=await call('auditor','GET','/stock-counts/'+count.id,{headers:eh});contract('get_stock_counts_id',await must(r,200));
 pass('a count over HTTP freezes the expected quantity, shows its variance through the lines read, is approved by another role and posts the loss at the layer cost');
 // Landed cost run: preview with allocations read, approval, one posting; the valuation report job.
 r=await call('stock','POST','/landed-costs',{body:{chargeDocumentId:billId,receiptIds:[r1.id,r2.id],method:'weight',amount:'90.00'},headers:{...key(),...eh}});assert.equal(r.status,409,'allocation by weight is not enabled');
 r=await call('stock','POST','/landed-costs',{body:{chargeDocumentId:billId,receiptIds:[r1.id,r2.id],method:'value',amount:'90.00'},headers:{...key(),...eh}});const lc=await must(r,201);contract('post_landed_costs',lc);
 r=await call('stock','POST','/landed-costs/'+lc.id+'/preview',{body:{},headers:{...key(),...eh,...im(lc.version)}});const lp=await must(r,200);contract('post_landed_costs_id_preview',lp);
 r=await call('auditor','GET','/landed-costs/'+lc.id+'/lines',{headers:eh});const ll=await must(r,200);contract('get_landed_costs_id_lines',ll);assert.deepEqual([ll.allocations.length,ll.totalToInventory,ll.totalToCogs],[2,'22.50','67.50'],'4 of 20 received remain: 90 × 4/20 to inventory');
 r=await call('auditor','GET','/landed-costs/'+lc.id,{headers:eh});const lcv=await must(r,200);contract('get_landed_costs_id',lcv);
 r=await call('accountant','POST','/landed-costs/'+lc.id+'/approve',{body:{decision:'approve',contentVersion:lcv.contentVersion},headers:{...key(),...eh,...im(lcv.version)}});const la=await must(r,200);contract('post_landed_costs_id_approve',la);
 r=await call('director','POST','/landed-costs/'+lc.id+'/post',{body:{},headers:{...key(),...eh,...im(la.version)}});const lpost=await must(r,200);contract('post_landed_costs_id_post',lpost);assert.equal(lpost.journalEntryIds.length,1);
 r=await call('director','POST','/landed-costs/'+lc.id+'/post',{body:{},headers:{...key(),...eh,...im(lpost.version)}});const again=await must(r,200);assert.deepEqual(again.journalEntryIds,lpost.journalEntryIds,'posting again has one effect');
 r=await call('auditor','GET','/landed-costs',{headers:eh});contract('get_landed_costs',await must(r,200));
 r=await call('auditor','GET','/inventory-valuation?bookId='+bookId+'&asOf=2026-10-31',{headers:eh});const val2=await must(r,200);assert.deepEqual([val2.accounts[0].state,val2.accounts[0].stockValue],['ties','372.50'],'valuation still ties after the count and the landed cost');
 r=await call('stock','POST','/reports',{body:{reportType:'inventory_valuation',bookId,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:new Date().toISOString(),format:'json'},headers:{...key(),...eh}});const rj=await must(r,202);
 await waitFor(async()=>['succeeded','failed'].includes((await json(await call('stock','GET','/jobs/'+rj.id,{headers:eh}))).state),'valuation report job',60000);
 assert.equal((await json(await call('stock','GET','/jobs/'+rj.id,{headers:eh}))).state,'succeeded',worker?.log().split('\n').slice(-6).join('\n'));
 pass('a landed cost run over HTTP refuses the weight method, previews its allocations through the lines read, is approved by another role, posts once, keeps the valuation tied and renders the inventory_valuation report through the worker');
 // Isolation and later-phase gate.
 r=await call('auditor','GET','/items/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('auditor','GET','/stock-movements/'+r1.id,{headers:{'x-entity-id':randomUUID()}});assert.equal(r.status,404);
 r=await call('auditor','GET','/stock-card?itemId='+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('auditor','POST','/packs/install',{body:{},headers:{...key(),...eh}});assert.ok([403,404,409].includes(r.status),'later-phase operations stay gated or refused for the caller');
 pass('unknown records and foreign entities answer 404; later-phase operations stay gated');
 console.log('P10-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-40).join(String.fromCharCode(10)));console.error(worker?.log().split(String.fromCharCode(10)).slice(-8).join(String.fromCharCode(10))||'');throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
