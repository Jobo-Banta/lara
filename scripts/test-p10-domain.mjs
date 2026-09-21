// P10-02 inventory domain against real PostgreSQL through the runtime role:
// P10-T01 AC-09 with two-layer FIFO, the moving average with its residual
// and a partial return; P10-T02 concurrent issues cannot consume the same
// stock or go negative; P10-T03 a transfer conserves value and a serial
// cannot exist in two warehouses; P10-T04 count and landed cost journals
// reconcile to the valuation and the control account exactly; P10-T05 a
// backdated open-period receipt posts the approved recost as a linked
// adjustment and a locked period rejects; the three-way match mandates the
// receipt. Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,purchasing,inventory} from '../packages/domain/src/index.mjs';
const {MemoryEvidenceStore,FixtureScanner}=evidence;
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
process.env.FIELD_ENCRYPTION_KEY??=randomBytes(32).toString('hex');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:60000});
const api=client(process.env.DATABASE_URL),api2=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),api2.connect(),owner.connect()]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
async function rejects(promise,code,label){try{await promise;}catch(e){assert.ok(e instanceof DomainError,label+': not a DomainError: '+e.stack);assert.equal(e.code,code,label+': '+e.message);return e;}assert.fail(label+' should fail with '+code);}
const run=(ctx,fn,db=api)=>inTransaction(db,ctx,fn);
const env={FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY};
try{
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-inv-'+suffix,name:'Inventory domain',mode:'demo'});
  for(const n of ['stock','buyer','clerk','accountant','tax','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['clerk','accountant','tax','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds the inventory or purchase-order permissions; tenant roles cover the stock clerk, the buyer and the inventory approver (noted for owner review).
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.stock=await role('stock_clerk',['item.create','item.edit','item.read','stock_movement.create','stock_movement.edit','stock_movement.submit','stock_movement.read','stock_count.create','stock_count.edit','stock_count.read','landed_cost.create','landed_cost.edit','landed_cost.preview','landed_cost.read','evidence.upload','evidence.read','account.read','book.read','branch.read']);
  roles.inv_approver=await role('inventory_approver',['stock_movement.approve','stock_movement.post','stock_movement.read','stock_count.approve','stock_count.post','stock_count.read','landed_cost.approve','landed_cost.post','landed_cost.read','item.read']);
  roles.purchaser=await role('purchaser',['purchase_order.create','purchase_order.edit','purchase_order.read','purchase_order.submit','purchase_order.cancel','bill.read','party.read']);
  for(const [p,r] of [['stock','stock'],['buyer','purchaser'],['clerk','clerk'],['accountant','accountant'],['accountant','inv_approver'],['tax','tax'],['controller','controller'],['director','controller'],['director','inv_approver'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'inv-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Trading Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const stock=await ctxFor('stock'),buyer=await ctxFor('buyer'),clerk=await ctxFor('clerk'),acc=await ctxFor('accountant'),dir=await ctxFor('director');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing','treasury'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),inv=await mk('1500','Inventory','asset'),inTax=await mk('1300','Input tax','asset',{controlType:'input_tax'}),ap=await mk('2100','Payables','liability',{controlType:'ap'}),grni=await mk('2150','Goods received not invoiced','liability'),whtPay=await mk('2300','Withholding payable','liability'),adv=await mk('1400','Advances','asset'),gain=await mk('4200','Stock gain','income'),cogs=await mk('5100','Cost of sales','expense'),loss=await mk('5200','Stock loss','expense'),freight=await mk('5300','Freight in','expense');
 for(const [s,e] of [['2026-10-01','2026-10-31'],['2026-11-01','2026-11-30']])await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const approve=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await approve('purchasing_profile',{apAccountId:ap.id,inputTaxAccountId:inTax.id,cashAccountId:cash.id,withholdingPayableAccountId:whtPay.id,advanceAccountId:adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
 await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'bill','BILL','numbering-2026',$4)",[tenantId,entityId,branch.id,principals.controller]));
 const supplier=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Widgets Ltd',roles:['supplier'],identityStatus:'unknown',address:'Cebu'},env));
 const store=new MemoryEvidenceStore();
 const upload=async(name,content,who=stock)=>{const bytes=Buffer.from(content);const reg=await run(who,tx=>evidence.registerUpload(tx,who,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(who,tx=>evidence.completeUpload(tx,who,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const sheet=await upload('count-sheet.pdf','%PDF-1.4 count sheet\n');
 const entryLines=async id=>(await run(acc,tx=>tx.query('select a.code,l.txn_debit::text as d,l.txn_credit::text as c from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entry_id=$2 order by l.line_no',[tenantId,id]))).rows.map(r=>[r.code,ledger.decimal(ledger.micros(r.d)),ledger.decimal(ledger.micros(r.c))]);
 const balance=async accountId=>ledger.decimal(ledger.signedMicros((await run(acc,tx=>tx.query('select coalesce(sum(func_debit-func_credit),0)::text as b from lara.journal_lines where tenant_id=$1 and account_id=$2',[tenantId,accountId]))).rows[0].b));
 await rejects(run(stock,tx=>inventory.createItem(tx,stock,entityId,{sku:'WIDGET',description:'Widget',uom:'pc',costMethod:'fifo',tracking:'none',stockAccountId:inv.id,cogsAccountId:cogs.id})),'FEATURE_NOT_ENABLED','items before the capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'inventory','active','p10.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 await approve('inventory_profile',{grniAccountId:grni.id,stockGainAccountId:gain.id,stockLossAccountId:loss.id,landedCostClearingAccountId:freight.id,threeWayTolerancePercent:'2',profileVersion:'inventory-2026'});
 const wh1=await run(stock,tx=>inventory.createWarehouse(tx,stock,entityId,{code:'WH1',name:'Main warehouse',branchId:branch.id}));
 const wh2=await run(stock,tx=>inventory.createWarehouse(tx,stock,entityId,{code:'WH2',name:'Branch store',branchId:branch.id}));
 const widget=await run(stock,tx=>inventory.createItem(tx,stock,entityId,{sku:'WIDGET',description:'Widget',uom:'pc',costMethod:'fifo',tracking:'none',stockAccountId:inv.id,cogsAccountId:cogs.id}));
 const gadget=await run(stock,tx=>inventory.createItem(tx,stock,entityId,{sku:'GADGET',description:'Gadget',uom:'pc',costMethod:'moving_average',tracking:'none',stockAccountId:inv.id,cogsAccountId:cogs.id}));
 const serial=await run(stock,tx=>inventory.createItem(tx,stock,entityId,{sku:'SERIAL-X',description:'Serialized unit',uom:'pc',costMethod:'fifo',tracking:'serial',stockAccountId:inv.id,cogsAccountId:cogs.id}));
 await rejects(run(stock,tx=>inventory.createItem(tx,stock,entityId,{sku:'BAD',description:'x',uom:'pc',costMethod:'fifo',tracking:'none',stockAccountId:cogs.id,cogsAccountId:inv.id})),'VALIDATION_FAILED','stock account must be an asset');
 pass('fixture: trading company with inventory, GRNI, cost of sales, gain, loss and freight accounts, an approved inventory profile, two warehouses and FIFO, moving-average and serial items');

 // Movement helpers: the stock clerk drafts and submits, the accountant approves and posts.
 const move=async(body,{who=stock,poster=acc}={})=>{const m=await run(who,tx=>inventory.createMovement(tx,who,entityId,body));await run(who,tx=>inventory.submitMovement(tx,who,entityId,m.id,{}));await run(acc,tx=>inventory.approveMovement(tx,acc,entityId,m.id,{decision:'approve',contentVersion:m.contentVersion}));const p=await run(poster===acc?dir:poster,tx=>inventory.postMovement(tx,poster===acc?dir:poster,entityId,m.id,{}));return {id:m.id,posted:p};};
 const line=(itemId,quantity,extra={})=>({itemId,quantity,...extra});
 // P10-T01: AC-09 two-layer FIFO, the moving average with its residual, a partial return.
 await rejects(run(stock,tx=>inventory.createMovement(tx,stock,entityId,{kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-01',lines:[line(widget.id,'10')]})),'VALIDATION_FAILED','receipt without a unit cost');
 const r1=await move({kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-01',lines:[line(widget.id,'10',{unitCost:'30'})],reason:'PO-A'});
 assert.deepEqual(await entryLines(r1.posted.journalEntryIds[0]),[['1500','300.00','0.00'],['2150','0.00','300.00']]);
 const r2=await move({kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-03',lines:[line(widget.id,'10',{unitCost:'50'})],reason:'PO-B'});
 const i1=await move({kind:'issue',warehouseId:wh1.id,accountingDate:'2026-10-05',lines:[line(widget.id,'12')],reason:'sale'});
 assert.deepEqual(await entryLines(i1.posted.journalEntryIds[0]),[['5100','400.00','0.00'],['1500','0.00','400.00']],'AC-09: FIFO issue of 12 = 10 × 30 + 2 × 50');
 let card=await run(ctrl,tx=>inventory.stockCard(tx,ctrl,entityId,{itemId:widget.id,warehouseId:wh1.id}));
 assert.deepEqual([card.balances[0].quantity,card.balances[0].value,card.layers.map(l=>l.qtyRemaining)],['8.00','400.00',['0.00','8.00']]);
 await move({kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-01',lines:[line(gadget.id,'10',{unitCost:'30'})]});
 await move({kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-02',lines:[line(gadget.id,'10',{unitCost:'50'})]});
 const g1=await move({kind:'issue',warehouseId:wh1.id,accountingDate:'2026-10-06',lines:[line(gadget.id,'5')]});
 assert.deepEqual(await entryLines(g1.posted.journalEntryIds[0]),[['5100','200.00','0.00'],['1500','0.00','200.00']],'moving average 40 × 5');
 const g2=await move({kind:'issue',warehouseId:wh1.id,accountingDate:'2026-10-06',lines:[line(gadget.id,'15')]});
 assert.deepEqual(await entryLines(g2.posted.journalEntryIds[0]),[['5100','600.00','0.00'],['1500','0.00','600.00']],'the final issue carries the residual: 800 − 200');
 card=await run(ctrl,tx=>inventory.stockCard(tx,ctrl,entityId,{itemId:gadget.id,warehouseId:wh1.id}));
 assert.deepEqual([card.balances[0].quantity,card.balances[0].value],['0.00','0.00']);
 const ret=await move({kind:'return',warehouseId:wh1.id,accountingDate:'2026-10-07',lines:[line(widget.id,'3')],reason:'damaged'});
 assert.deepEqual(await entryLines(ret.posted.journalEntryIds[0]),[['2150','150.00','0.00'],['1500','0.00','150.00']],'a partial return consumes the remaining layer at 50');
 await rejects(run(stock,tx=>inventory.updateItem(tx,stock,entityId,widget.id,widget.version,{sku:'WIDGET',description:'Widget',uom:'pc',costMethod:'moving_average',tracking:'none',stockAccountId:inv.id,cogsAccountId:cogs.id})),'STATE_CONFLICT','cost method change after activity');
 pass('P10-T01 / AC-09: two FIFO layers issue at 10 × 30 + 2 × 50 = 400 (Dr cost of sales / Cr inventory), the moving average issues at 40 and carries the residual to the final issue, a partial return consumes the remaining layer, and the cost method is fixed after activity');

 // P10-T02: concurrent issues on the same stock serialize; the second cannot go negative.
 const draft=async(q)=>{const m=await run(stock,tx=>inventory.createMovement(tx,stock,entityId,{kind:'issue',warehouseId:wh1.id,accountingDate:'2026-10-08',lines:[line(widget.id,q)],reason:'race'}));await run(stock,tx=>inventory.submitMovement(tx,stock,entityId,m.id,{}));await run(acc,tx=>inventory.approveMovement(tx,acc,entityId,m.id,{decision:'approve',contentVersion:m.contentVersion}));return m;};
 const a=await draft('4'),b=await draft('4');
 const results=await Promise.allSettled([inTransaction(api,dir,tx=>inventory.postMovement(tx,dir,entityId,a.id,{})),inTransaction(api2,dir,tx=>inventory.postMovement(tx,dir,entityId,b.id,{}))]);
 const ok=results.filter(r=>r.status==='fulfilled'),failed=results.filter(r=>r.status==='rejected');
 assert.deepEqual([ok.length,failed.length,failed[0]?.reason?.code],[1,1,'STATE_CONFLICT'],'one issue wins, the other is refused');
 card=await run(ctrl,tx=>inventory.stockCard(tx,ctrl,entityId,{itemId:widget.id,warehouseId:wh1.id}));
 assert.deepEqual([card.balances[0].quantity,card.balances[0].value],['1.00','50.00'],'5 − 4 = 1 left, never negative');
 pass('P10-T02: two concurrent issues of 4 against 5 on hand serialize on the balance lock; one posts and the other is refused as negative stock');

 // P10-T03: transfer conserves value; a serial exists in one warehouse.
 await move({kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-09',lines:[line(widget.id,'9',{unitCost:'60'})],reason:'PO-C'});
 const before=await run(ctrl,tx=>inventory.stockCard(tx,ctrl,entityId,{itemId:widget.id}));
 const totalBefore=before.balances.reduce((t,b)=>t+ledger.micros(b.value),0n);
 const tr=await move({kind:'transfer',warehouseId:wh1.id,toWarehouseId:wh2.id,accountingDate:'2026-10-10',lines:[line(widget.id,'4')]});
 assert.equal(tr.posted.journalEntryIds.length,0,'a transfer posts no entry');
 const after=await run(ctrl,tx=>inventory.stockCard(tx,ctrl,entityId,{itemId:widget.id}));
 const totalAfter=after.balances.reduce((t,b)=>t+ledger.micros(b.value),0n);
 assert.equal(totalAfter,totalBefore,'total value conserved');
 assert.deepEqual(after.balances.map(b=>[b.warehouseCode,b.quantity,b.value]),[['WH1','6.00','360.00'],['WH2','4.00','230.00']],'FIFO: 1 × 50 + 3 × 60 moved');
 await rejects(run(stock,tx=>inventory.createMovement(tx,stock,entityId,{kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-10',lines:[line(serial.id,'2',{unitCost:'100',lotOrSerial:'SN-1'})]})),'VALIDATION_FAILED','a serial line moves one unit');
 await rejects(run(stock,tx=>inventory.createMovement(tx,stock,entityId,{kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-10',lines:[line(serial.id,'1',{unitCost:'100'})]})),'VALIDATION_FAILED','a serial line names its serial');
 await move({kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-10',lines:[line(serial.id,'1',{unitCost:'100',lotOrSerial:'SN-1'})]});
 await move({kind:'transfer',warehouseId:wh1.id,toWarehouseId:wh2.id,accountingDate:'2026-10-11',lines:[line(serial.id,'1',{lotOrSerial:'SN-1'})]});
 const dup=await run(stock,tx=>inventory.createMovement(tx,stock,entityId,{kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-12',lines:[line(serial.id,'1',{unitCost:'100',lotOrSerial:'SN-1'})]}));
 await run(stock,tx=>inventory.submitMovement(tx,stock,entityId,dup.id,{}));await run(acc,tx=>inventory.approveMovement(tx,acc,entityId,dup.id,{decision:'approve',contentVersion:dup.contentVersion}));
 await rejects(run(dir,tx=>inventory.postMovement(tx,dir,entityId,dup.id,{})),'STATE_CONFLICT','a serial received again while in another warehouse');
 const issueSerialWrong=await run(stock,tx=>inventory.createMovement(tx,stock,entityId,{kind:'issue',warehouseId:wh1.id,accountingDate:'2026-10-12',lines:[line(serial.id,'1',{lotOrSerial:'SN-1'})]}));
 await run(stock,tx=>inventory.submitMovement(tx,stock,entityId,issueSerialWrong.id,{}));await run(acc,tx=>inventory.approveMovement(tx,acc,entityId,issueSerialWrong.id,{decision:'approve',contentVersion:issueSerialWrong.contentVersion}));
 await rejects(run(dir,tx=>inventory.postMovement(tx,dir,entityId,issueSerialWrong.id,{})),'STATE_CONFLICT','issuing a serial from the warehouse it left');
 pass('P10-T03: a transfer moves 4 widgets at their FIFO cost with no entry and the total value conserved; a serial moves one unit, is named on every line, and cannot be received again or issued elsewhere while it sits in another warehouse');

 // P10-T04: count variances and landed cost reconcile to the valuation and the control account.
 const valuation=async()=>run(ctrl,tx=>inventory.inventoryValuation(tx,ctrl,entityId,{bookId:book.id,asOf:'2026-10-31'}));
 let v=await valuation();
 assert.deepEqual([v.accounts.length,v.accounts[0].state,v.accounts[0].stockValue,await balance(inv.id)],[1,'ties','690.00','690.00'],'layers tie to the inventory account before the count');
 const count=await run(stock,tx=>inventory.createCount(tx,stock,entityId,{warehouseId:wh1.id,cutoffAt:'2026-10-15T08:00:00Z',lines:[{itemId:widget.id,observedQuantity:'5'},{itemId:gadget.id,observedQuantity:'2'}],evidenceIds:[sheet]}));
 const cl=await run(ctrl,tx=>inventory.countLines(tx,ctrl,entityId,count.id));
 assert.deepEqual(cl.lines.map(l=>[l.sku,l.expectedQuantity,l.observedQuantity,l.varianceQuantity]),[['GADGET','0.00','2.00','2.00'],['WIDGET','6.00','5.00','-1.00']],'expected quantities frozen at creation');
 await rejects(run(stock,tx=>inventory.approveCount(tx,stock,entityId,count.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','counter approving');
 await run(acc,tx=>inventory.approveCount(tx,acc,entityId,count.id,{decision:'approve',contentVersion:1}));
 const cp=await run(dir,tx=>inventory.postCount(tx,dir,entityId,count.id,{}));
 assert.equal(cp.journalEntryIds.length,2,'a gain entry and a loss entry');
 assert.deepEqual(await entryLines(cp.journalEntryIds[0]),[['1500','100.00','0.00'],['4200','0.00','100.00']],'gadget gain of 2 at the last cost 50');
 assert.deepEqual(await entryLines(cp.journalEntryIds[1]),[['5200','60.00','0.00'],['1500','0.00','60.00']],'widget loss of 1 at the FIFO layer 60');
 v=await valuation();
 assert.deepEqual([v.accounts[0].state,v.accounts[0].stockValue,await balance(inv.id)],['ties','730.00','730.00'],'the count journals reconcile to the valuation exactly');
 // Landed cost: a posted freight bill of 90 allocated by value over receipts r1 (300, fully sold) and r2 (500, 0 of 10 remaining after the sales... the receipt of 9 at 60 carries stock).
 const billDoc=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,{kind:'bill',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:'2026-10-16',accountingDate:'2026-10-16',currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:'FRT-1',lines:[{description:'Freight',quantity:'1',unitPrice:'90',discount:'0',priceBasis:'exclusive',accountId:freight.id,dimensions:{}}],evidenceIds:[sheet]}));
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,billDoc.id,{}));await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,billDoc.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,billDoc.id,{}));
 const rc=(await run(ctrl,tx=>inventory.listMovements(tx,ctrl,entityId,{}))).items.find(m=>m.reason==='PO-C');
 await rejects(run(stock,tx=>inventory.createLandedCost(tx,stock,entityId,{chargeDocumentId:billDoc.id,receiptIds:[rc.id],method:'weight',amount:'90.00'})),'FEATURE_NOT_ENABLED','allocation by weight without item weights');
 const lc=await run(stock,tx=>inventory.createLandedCost(tx,stock,entityId,{chargeDocumentId:billDoc.id,receiptIds:[r2.id,rc.id],method:'value',amount:'90.00'}));
 const lp=await run(stock,tx=>inventory.previewLandedCost(tx,stock,entityId,lc.id,{}));
 // r2: 10 at 50 = 500 basis, 0 remaining → all to cost of sales; rc: 9 at 60 = 540 basis, 5 remaining after the issue, the transfer and the count → 5/9 to inventory.
 const byMove=Object.fromEntries(lp.preview.allocations.map(x=>[x.movementId,x]));
 assert.deepEqual([byMove[r2.id].amount,byMove[r2.id].toInventory,byMove[r2.id].toCogs,byMove[rc.id].amount,byMove[rc.id].toInventory,byMove[rc.id].toCogs,lp.preview.totalToInventory],['43.27','0.00','43.27','46.73','25.96','20.77','25.96']);
 await run(acc,tx=>inventory.approveLandedCost(tx,acc,entityId,lc.id,{decision:'approve',contentVersion:2}));
 const lpost=await run(dir,tx=>inventory.postLandedCost(tx,dir,entityId,lc.id,{}));
 assert.deepEqual(await entryLines(lpost.journalEntryIds[0]),[['1500','25.96','0.00'],['5100','64.04','0.00'],['5300','0.00','90.00']]);
 v=await valuation();
 assert.deepEqual([v.accounts[0].state,v.accounts[0].stockValue,await balance(inv.id)],['ties','755.96','755.96'],'the landed cost journal reconciles to the valuation exactly');
 assert.deepEqual((await run(dir,tx=>inventory.postLandedCost(tx,dir,entityId,lc.id,{}))).journalEntryIds,lpost.journalEntryIds,'posting again has one effect');
 pass('P10-T04: the count posts a gain at the last cost and a loss at the layer with independent approval, the landed cost allocates 90 by value with the sold portion to cost of sales and the remaining portion raising the layers, and both journals reconcile to the valuation and the control account exactly');

 // P10-T05: a backdated open-period receipt posts the approved recost; a locked period rejects.
 const bolt=await run(stock,tx=>inventory.createItem(tx,stock,entityId,{sku:'BOLT',description:'Bolt',uom:'pc',costMethod:'fifo',tracking:'none',stockAccountId:inv.id,cogsAccountId:cogs.id}));
 await move({kind:'receipt',warehouseId:wh2.id,accountingDate:'2026-10-04',lines:[line(bolt.id,'10',{unitCost:'30'})]});
 const bi=await move({kind:'issue',warehouseId:wh2.id,accountingDate:'2026-10-06',lines:[line(bolt.id,'4')]});
 assert.deepEqual(await entryLines(bi.posted.journalEntryIds[0]),[['5100','120.00','0.00'],['1500','0.00','120.00']]);
 const back=await run(stock,tx=>inventory.createMovement(tx,stock,entityId,{kind:'receipt',warehouseId:wh2.id,accountingDate:'2026-10-02',lines:[line(bolt.id,'10',{unitCost:'20'})],reason:'late paperwork'}));
 await run(stock,tx=>inventory.submitMovement(tx,stock,entityId,back.id,{}));
 const preview=await run(ctrl,tx=>inventory.recostPreview(tx,ctrl,entityId,back.id));
 assert.deepEqual([preview.affected.length,preview.affected[0].recorded,preview.affected[0].replayed,preview.totalDifference],[1,'120.00','80.00','-40.00'],'the issue of 4 would have cost 4 × 20 with the receipt in place');
 await run(acc,tx=>inventory.approveMovement(tx,acc,entityId,back.id,{decision:'approve',contentVersion:back.contentVersion}));
 const bp=await run(dir,tx=>inventory.postMovement(tx,dir,entityId,back.id,{}));
 assert.equal(bp.journalEntryIds.length,2,'the receipt entry and the linked recost adjustment');
 assert.deepEqual(await entryLines(bp.journalEntryIds[1]),[['1500','40.00','0.00'],['5100','0.00','40.00']],'the recost credits cost of sales and restores inventory by 40');
 v=await valuation();
 assert.equal(v.accounts[0].state,'ties','the recost keeps the valuation tied');
 const periods=(await run(ctrl,tx=>ledger.listPeriods(tx,ctrl,entityId,{bookId:book.id}))).items;const nov=periods.find(p=>p.startsOn==='2026-11-01');
 await run(ctrl,tx=>ledger.softClosePeriod(tx,ctrl,entityId,nov.id,{reason:'Close'}));await run(ctrl,tx=>ledger.lockPeriod(tx,ctrl,entityId,nov.id,{reason:'Lock'}));
 const lockedMove=await run(stock,tx=>inventory.createMovement(tx,stock,entityId,{kind:'receipt',warehouseId:wh2.id,accountingDate:'2026-11-05',lines:[line(bolt.id,'1',{unitCost:'20'})]}));
 await run(stock,tx=>inventory.submitMovement(tx,stock,entityId,lockedMove.id,{}));await run(acc,tx=>inventory.approveMovement(tx,acc,entityId,lockedMove.id,{decision:'approve',contentVersion:lockedMove.contentVersion}));
 await rejects(run(dir,tx=>inventory.postMovement(tx,dir,entityId,lockedMove.id,{})),'PERIOD_LOCKED','receipt into a locked period');
 pass('P10-T05: a receipt backdated before a posted issue shows the deterministic recost at approval and posts it as a linked adjustment (cost of sales −40, inventory +40) without rewriting the issue; a movement into a locked period is rejected');

 // Three-way match: a goods order, its receipt, and bills within and beyond the tolerance.
 const po=await run(buyer,tx=>purchasing.createDocument(tx,buyer,entityId,{kind:'purchase_order',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:'2026-10-18',accountingDate:'2026-10-18',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Widgets',quantity:'10',unitPrice:'60',discount:'0',priceBasis:'exclusive',accountId:inv.id,dimensions:{}}],evidenceIds:[]}));
 await run(buyer,tx=>purchasing.submitDocument(tx,buyer,entityId,po.id,{}));await run(ctrl,tx=>purchasing.approveDocument(tx,ctrl,entityId,po.id,{decision:'approve',contentVersion:1}));
 const billFor=async(price,ref)=>{const d=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,{kind:'bill',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:'2026-10-20',accountingDate:'2026-10-20',currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:ref,sourceDocumentId:po.id,lines:[{description:'Widgets',quantity:'10',unitPrice:price,discount:'0',priceBasis:'exclusive',accountId:grni.id,itemId:widget.id,dimensions:{}}],evidenceIds:[sheet]}));await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,d.id,{}));return d;};
 const early=await billFor('60','SI-EARLY');
 await rejects(run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,early.id,{decision:'approve',contentVersion:1})),'STATE_CONFLICT','bill for goods before any goods receipt');
 await move({kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-19',sourceDocumentId:po.id,lines:[line(widget.id,'10',{unitCost:'60'})],reason:'PO goods'});
 await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,early.id,{decision:'approve',contentVersion:1}));
 const posted=await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,early.id,{}));
 assert.equal(posted.state,'posted','a bill within tolerance of the received value posts');
 const po2=await run(buyer,tx=>purchasing.createDocument(tx,buyer,entityId,{kind:'purchase_order',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:'2026-10-21',accountingDate:'2026-10-21',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Widgets',quantity:'10',unitPrice:'70',discount:'0',priceBasis:'exclusive',accountId:inv.id,dimensions:{}}],evidenceIds:[]}));
 await run(buyer,tx=>purchasing.submitDocument(tx,buyer,entityId,po2.id,{}));await run(ctrl,tx=>purchasing.approveDocument(tx,ctrl,entityId,po2.id,{decision:'approve',contentVersion:1}));
 await move({kind:'receipt',warehouseId:wh1.id,accountingDate:'2026-10-21',sourceDocumentId:po2.id,lines:[line(widget.id,'10',{unitCost:'60'})],reason:'PO goods 2'});
 const over=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,{kind:'bill',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:'2026-10-22',accountingDate:'2026-10-22',currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:'SI-OVER',sourceDocumentId:po2.id,lines:[{description:'Widgets',quantity:'10',unitPrice:'70',discount:'0',priceBasis:'exclusive',accountId:grni.id,itemId:widget.id,dimensions:{}}],evidenceIds:[sheet]}));
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,over.id,{}));
 const e=await rejects(run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,over.id,{decision:'approve',contentVersion:1})),'VALIDATION_FAILED','variance beyond tolerance without a disposition');
 assert.match(e.message,/beyond the tolerance/);
 await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,over.id,{decision:'approve',contentVersion:1,reason:'Price increase agreed with the supplier; variance accepted'}));
 assert.equal((await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,over.id,{}))).state,'posted','the approved variance posts');
 pass('three-way match: a bill for a goods order is refused until a goods receipt is posted, posts within the tolerance, and a variance beyond it needs the approver\'s recorded disposition before it posts');
 console.log('P10-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),api2.end(),owner.end()]);
}
