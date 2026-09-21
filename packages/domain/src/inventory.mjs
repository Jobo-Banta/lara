// Inventory costing and three-way matching (P10): items with a cost method
// fixed before the first movement, reviewed stock movements posted once through
// lara.post_journal_entry, valuation layers consumed oldest first (FIFO) or at
// the running average with the residual carried to the final issue, balances
// locked in sorted order so concurrent issues never go negative, serials that
// exist in one warehouse, transfers that conserve quantity and value, counts
// with frozen expected quantities and independently approved variances,
// landed costs allocated to receipts with the sold portion to cost of sales,
// deterministic recost with a linked adjustment for backdated receipts, and
// the three-way match that never waives a mandated goods receipt.
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {linkEvidence} from './evidence.mjs';
import {micros,decimal,signedMicros} from './ledger.mjs';

const MICRO=1000000n;
const money=v=>decimal(micros(String(v)),2);
const qty=v=>micros(String(v));
// cost of a quantity at a 12-decimal unit cost, rounded half-up to cents.
const costOf=(q,unitCost12)=>{const raw=q*unitCost12;const cents=(raw+5n*10n**15n)/(10n**16n);return cents*10000n;};
const unit12=(value,q)=>q===0n?0n:(value*10n**12n+q/2n)/q; // micros per unit, 12-dec scaled
const unit12Text=u=>{const s=u.toString().padStart(13,'0');return s.slice(0,-12)+'.'+s.slice(-12);};
const unit12Of=text=>{const s=String(text);const [w,f='']=s.split('.');return BigInt(w)*10n**12n+BigInt(f.padEnd(12,'0').slice(0,12));};

// ---------------------------------------------------------------------------
// Capability, profile, warehouses and items
// ---------------------------------------------------------------------------
export async function requireInventory(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='inventory' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The inventory capability is not active for this entity.');
}
export async function isInventoryActive(tx,ctx,entityId){return (await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='inventory' and status='active'",[ctx.tenantId,entityId])).rowCount>0;}
export async function inventoryProfile(tx,ctx,entityId){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='inventory_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved inventory profile (goods received clearing, stock gain and loss, landed cost clearing accounts, tolerance, negative-stock policy) is required.');
 const p=row.payload;
 for(const k of ['grniAccountId','stockGainAccountId','stockLossAccountId'])if(!isUuid(p[k]))fail('RULE_PROFILE_NOT_APPROVED','The inventory profile lacks '+k+'.');
 return {grniAccountId:p.grniAccountId,stockGainAccountId:p.stockGainAccountId,stockLossAccountId:p.stockLossAccountId,landedCostClearingAccountId:isUuid(p.landedCostClearingAccountId)?p.landedCostClearingAccountId:null,threeWayTolerancePercent:typeof p.threeWayTolerancePercent==='string'&&/^\d{1,3}(\.\d{1,4})?$/.test(p.threeWayTolerancePercent)?p.threeWayTolerancePercent:'0',negativeStockPolicy:'block',profileVersion:typeof p.profileVersion==='string'?p.profileVersion:'inventory-1'};
}
const warehouseResource=r=>({id:r.id,version:Number(r.version),code:r.code,name:r.name,branchId:r.branch_id,state:r.status,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
export async function createWarehouse(tx,ctx,entityId,{code,name,branchId}){
 requirePermission(ctx,'item.create');requireEntity(ctx,entityId);await requireInventory(tx,ctx,entityId);
 const branch=(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,branchId])).rows[0];
 if(!branch)fail('NOT_FOUND','Branch not found.');
 const row=(await tx.query('insert into lara.warehouses(tenant_id,entity_id,branch_id,code,name,created_by) values($1,$2,$3,$4,$5,$6) returning *',[ctx.tenantId,entityId,branchId,String(code).toUpperCase(),String(name).trim(),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'warehouse.create',resourceType:'warehouse',resourceId:row.id,resourceVersion:1});
 return warehouseResource(row);
}
export async function listWarehouses(tx,ctx,entityId,query){
 requirePermission(ctx,'item.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.warehouses where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,warehouseResource,scope);
}
async function warehouseFor(tx,ctx,entityId,id){if(!isUuid(id))fail('VALIDATION_FAILED','warehouseId must be a UUID.',{fieldErrors:[{path:'warehouseId',message:'UUID'}]});const w=(await tx.query("select * from lara.warehouses where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,id])).rows[0];if(!w)fail('NOT_FOUND','Warehouse not found.');return w;}
const itemResource=r=>resource(r,{sku:r.sku,description:r.description,uom:r.uom,costMethod:r.cost_method,tracking:r.tracking,stockAccountId:r.stock_account_id,cogsAccountId:r.cogs_account_id});
async function checkItemAccounts(tx,ctx,entityId,input){
 const accounts=(await tx.query("select id,category,status,book_id from lara.accounts where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[])",[ctx.tenantId,entityId,[input.stockAccountId,input.cogsAccountId]])).rows;
 const stock=accounts.find(a=>a.id===input.stockAccountId),cogs=accounts.find(a=>a.id===input.cogsAccountId);
 if(!stock||stock.category!=='asset'||stock.status!=='active')fail('VALIDATION_FAILED','The stock account is an active asset account.',{fieldErrors:[{path:'stockAccountId',message:'Active asset account'}]});
 if(!cogs||cogs.category!=='expense'||cogs.status!=='active')fail('VALIDATION_FAILED','The cost of sales account is an active expense account.',{fieldErrors:[{path:'cogsAccountId',message:'Active expense account'}]});
 if(stock.book_id!==cogs.book_id)fail('VALIDATION_FAILED','Stock and cost of sales accounts belong to one book.',{fieldErrors:[{path:'cogsAccountId',message:'Other book'}]});
 return stock.book_id;
}
export async function createItem(tx,ctx,entityId,input){
 requirePermission(ctx,'item.create');requireEntity(ctx,entityId);assertInput('ItemCreate',input);await requireInventory(tx,ctx,entityId);
 await checkItemAccounts(tx,ctx,entityId,input);
 const row=(await tx.query('insert into lara.items(tenant_id,entity_id,sku,description,uom,cost_method,tracking,stock_account_id,cogs_account_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,input.sku.trim(),input.description.trim(),input.uom.trim(),input.costMethod,input.tracking,input.stockAccountId,input.cogsAccountId,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'item.create',resourceType:'item',resourceId:row.id,resourceVersion:1});
 return itemResource(row);
}
export async function updateItem(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'item.edit');requireEntity(ctx,entityId);assertInput('ItemCreate',input);if(!isUuid(id))fail('NOT_FOUND','Item not found.');
 const row=(await tx.query('select * from lara.items where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Item not found.');expectVersion(row,expectedVersion);
 const moved=(await tx.query("select 1 from lara.stock_movement_lines l join lara.stock_movements m on m.tenant_id=l.tenant_id and m.id=l.movement_id where l.tenant_id=$1 and l.item_id=$2 and m.state='posted' limit 1",[ctx.tenantId,id])).rowCount>0;
 if(moved&&(input.costMethod!==row.cost_method||input.stockAccountId!==row.stock_account_id||input.tracking!==row.tracking))fail('STATE_CONFLICT','The cost method, tracking and stock account are fixed once the item has posted movements; a change is a separately reviewed conversion.');
 await checkItemAccounts(tx,ctx,entityId,input);
 const updated=(await tx.query('update lara.items set sku=$3,description=$4,uom=$5,cost_method=$6,tracking=$7,stock_account_id=$8,cogs_account_id=$9,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.sku.trim(),input.description.trim(),input.uom.trim(),input.costMethod,input.tracking,input.stockAccountId,input.cogsAccountId])).rows[0];
 await audit(tx,ctx,{entityId,action:'item.edit',resourceType:'item',resourceId:id,resourceVersion:Number(updated.version)});
 return itemResource(updated);
}
export async function getItem(tx,ctx,entityId,id){requirePermission(ctx,'item.read');requireEntity(ctx,entityId);if(!isUuid(id))fail('NOT_FOUND','Item not found.');const row=(await tx.query('select * from lara.items where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Item not found.');return itemResource(row);}
export async function listItems(tx,ctx,entityId,query){
 requirePermission(ctx,'item.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.items where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,itemResource,scope);
}

// ---------------------------------------------------------------------------
// Stock movements
// ---------------------------------------------------------------------------
const lineFields=async(tx,ctx,id)=>(await tx.query('select * from lara.stock_movement_lines where tenant_id=$1 and movement_id=$2 order by line_no',[ctx.tenantId,id])).rows.map(l=>({itemId:l.item_id,quantity:money(l.quantity),...(l.unit_cost!==null?{unitCost:money(l.unit_cost)}:{}),...(l.lot_or_serial?{lotOrSerial:l.lot_or_serial}:{})}));
async function movementResource(tx,ctx,r){return resource({...r,status:r.state},{kind:r.kind,warehouseId:r.warehouse_id,...(r.to_warehouse_id?{toWarehouseId:r.to_warehouse_id}:{}),accountingDate:iso(r.accounting_date),...(r.source_document_id?{sourceDocumentId:r.source_document_id}:{}),lines:await lineFields(tx,ctx,r.id),...(r.reason?{reason:r.reason}:{})});}
const material=input=>({kind:input.kind,warehouseId:input.warehouseId,toWarehouseId:input.toWarehouseId||null,accountingDate:input.accountingDate,sourceDocumentId:input.sourceDocumentId||null,lines:input.lines.map(l=>({itemId:l.itemId,quantity:money(l.quantity),unitCost:l.unitCost!==undefined?money(l.unitCost):null,lotOrSerial:l.lotOrSerial||null})),reason:input.reason||null});
async function validateMovement(tx,ctx,entityId,input){
 const warehouse=await warehouseFor(tx,ctx,entityId,input.warehouseId);
 if(input.kind==='transfer'){if(!input.toWarehouseId)fail('VALIDATION_FAILED','Transfers name the destination warehouse.',{fieldErrors:[{path:'toWarehouseId',message:'Required'}]});if(input.toWarehouseId===input.warehouseId)fail('VALIDATION_FAILED','Transfers move between two warehouses.',{fieldErrors:[{path:'toWarehouseId',message:'Same warehouse'}]});await warehouseFor(tx,ctx,entityId,input.toWarehouseId);}
 else if(input.toWarehouseId)fail('VALIDATION_FAILED','Only transfers name a destination.',{fieldErrors:[{path:'toWarehouseId',message:'Not a transfer'}]});
 const items=new Map();
 for(const [i,l] of input.lines.entries()){
  if(!isUuid(l.itemId))fail('VALIDATION_FAILED','itemId must be a UUID.',{fieldErrors:[{path:'lines.'+i+'.itemId',message:'UUID'}]});
  const item=items.get(l.itemId)||(await tx.query("select * from lara.items where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,l.itemId])).rows[0];
  if(!item)fail('NOT_FOUND','Item on line '+(i+1)+' not found.');items.set(l.itemId,item);
  if(qty(l.quantity)<=0n)fail('VALIDATION_FAILED','Quantities are positive.',{fieldErrors:[{path:'lines.'+i+'.quantity',message:'Positive'}]});
  if(input.kind==='receipt'&&l.unitCost===undefined)fail('VALIDATION_FAILED','Receipts carry a unit cost per line.',{fieldErrors:[{path:'lines.'+i+'.unitCost',message:'Required'}]});
  if(['issue','transfer','return'].includes(input.kind)&&l.unitCost!==undefined)fail('VALIDATION_FAILED','Issues, transfers and returns cost at the layers, not a stated unit cost.',{fieldErrors:[{path:'lines.'+i+'.unitCost',message:'Not allowed'}]});
  if(item.tracking!=='none'&&!l.lotOrSerial)fail('VALIDATION_FAILED','Item '+item.sku+' is '+item.tracking+'-tracked; the line names its '+(item.tracking==='serial'?'serial':'batch')+'.',{fieldErrors:[{path:'lines.'+i+'.lotOrSerial',message:'Required'}]});
  if(item.tracking==='serial'&&qty(l.quantity)!==MICRO)fail('VALIDATION_FAILED','A serial line moves exactly one unit.',{fieldErrors:[{path:'lines.'+i+'.quantity',message:'One unit per serial'}]});
 }
 let source=null;
 if(input.sourceDocumentId){source=(await tx.query('select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.sourceDocumentId])).rows[0];if(!source)fail('NOT_FOUND','Source document not found.');
  if(input.kind==='receipt'&&source.kind!=='purchase_order')fail('VALIDATION_FAILED','Receipts reference a purchase order.',{fieldErrors:[{path:'sourceDocumentId',message:'Not a purchase order'}]});
  if(input.kind==='issue'&&!['invoice','sales_order'].includes(source.kind))fail('VALIDATION_FAILED','Issues reference an invoice or sales order.',{fieldErrors:[{path:'sourceDocumentId',message:'Not a sales document'}]});
  if(input.kind==='return'&&source.kind!=='purchase_order')fail('VALIDATION_FAILED','Returns reference the purchase order received against.',{fieldErrors:[{path:'sourceDocumentId',message:'Not a purchase order'}]});}
 return {warehouse,items,source};
}
async function loadMovement(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Stock movement not found.');const row=(await tx.query('select * from lara.stock_movements where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Stock movement not found.');return row;}
const mresult=(row,extra={})=>({resourceType:'stock_movement',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
async function writeLines(tx,ctx,entityId,id,lines){
 await tx.query('delete from lara.stock_movement_lines where tenant_id=$1 and movement_id=$2',[ctx.tenantId,id]);
 for(const [i,l] of lines.entries())await tx.query('insert into lara.stock_movement_lines(tenant_id,entity_id,movement_id,line_no,item_id,quantity,unit_cost,lot_or_serial) values($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,entityId,id,i+1,l.itemId,decimal(qty(l.quantity),6),l.unitCost!==undefined?decimal(micros(String(l.unitCost)),6):null,l.lotOrSerial||null]);
}
export async function createMovement(tx,ctx,entityId,input){
 requirePermission(ctx,'stock_movement.create');requireEntity(ctx,entityId);assertInput('StockMovementCreate',input);await requireInventory(tx,ctx,entityId);
 const {items}=await validateMovement(tx,ctx,entityId,input);
 const bookId=[...items.values()][0]?(await tx.query('select book_id from lara.accounts where tenant_id=$1 and id=$2',[ctx.tenantId,[...items.values()][0].stock_account_id])).rows[0].book_id:null;
 const m=material(input),hash=contentHash(m);
 const row=(await tx.query('insert into lara.stock_movements(tenant_id,entity_id,book_id,kind,warehouse_id,to_warehouse_id,accounting_date,source_document_id,reason,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[ctx.tenantId,entityId,bookId,input.kind,input.warehouseId,input.toWarehouseId||null,input.accountingDate,input.sourceDocumentId||null,input.reason||null,hash,ctx.principalId])).rows[0];
 await writeLines(tx,ctx,entityId,row.id,input.lines);
 await audit(tx,ctx,{entityId,action:'stock_movement.create',resourceType:'stock_movement',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return movementResource(tx,ctx,row);
}
export async function updateMovement(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'stock_movement.edit');requireEntity(ctx,entityId);assertInput('StockMovementCreate',input);
 const row=await loadMovement(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Only draft movements change; withdraw a submitted one first.');
 await validateMovement(tx,ctx,entityId,input);
 const m=material(input),hash=contentHash(m);
 await writeLines(tx,ctx,entityId,id,input.lines);
 const updated=(await tx.query('update lara.stock_movements set kind=$3,warehouse_id=$4,to_warehouse_id=$5,accounting_date=$6,source_document_id=$7,reason=$8,content_hash=$9,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.kind,input.warehouseId,input.toWarehouseId||null,input.accountingDate,input.sourceDocumentId||null,input.reason||null,hash])).rows[0];
 await audit(tx,ctx,{entityId,action:'stock_movement.edit',resourceType:'stock_movement',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return movementResource(tx,ctx,updated);
}
export async function submitMovement(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'stock_movement.submit');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadMovement(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Movement is '+row.state+'.');
 const updated=(await tx.query("update lara.stock_movements set state='submitted' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:'stock_movement.submit',resourceType:'stock_movement',resourceId:id,resourceVersion:Number(updated.version)});
 return mresult(updated);
}
export async function approveMovement(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'stock_movement.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadMovement(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='submitted')fail('STATE_CONFLICT','Only submitted movements are decided.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot approve the movement.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The movement changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 // A backdated receipt shows its deterministic recost; approving it approves the linked adjustment.
 const recost=input.decision==='approve'&&row.kind==='receipt'?await recostPreviewFor(tx,ctx,entityId,row):null;
 const updated=(await tx.query('update lara.stock_movements set state=$3,approved_by=$4,recost_json=$5 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.decision==='approve'?'approved':'draft',input.decision==='approve'?ctx.principalId:null,recost?JSON.stringify(recost):null])).rows[0];
 await audit(tx,ctx,{entityId,action:'stock_movement.'+input.decision,resourceType:'stock_movement',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.content_hash});
 return mresult(updated);
}
// Locks the balance rows of every (item, warehouse) pair in sorted order so
// two concurrent postings on the same stock serialize instead of racing.
async function lockBalances(tx,ctx,entityId,pairs){
 const keys=[...new Set(pairs.map(p=>p.itemId+'|'+p.warehouseId))].sort();
 const out=new Map();
 for(const k of keys){const [itemId,warehouseId]=k.split('|');
  await tx.query('insert into lara.stock_balances(tenant_id,entity_id,item_id,warehouse_id) values($1,$2,$3,$4) on conflict do nothing',[ctx.tenantId,entityId,itemId,warehouseId]);
  out.set(k,(await tx.query('select * from lara.stock_balances where tenant_id=$1 and item_id=$2 and warehouse_id=$3 for update',[ctx.tenantId,itemId,warehouseId])).rows[0]);}
 return out;
}
async function saveBalance(tx,ctx,itemId,warehouseId,q,value){await tx.query('update lara.stock_balances set quantity=$4,value=$5,updated_at=now() where tenant_id=$1 and item_id=$2 and warehouse_id=$3',[ctx.tenantId,itemId,warehouseId,decimal(q,6),decimal(value<0n?0n:value,6)]);}
// Consumes layers oldest first (effective date, then receipt sequence). FIFO
// costs each allocation at its layer; the moving average costs the whole
// issue at the running average and carries the residual to the final issue.
async function consume(tx,ctx,entityId,{item,warehouseId,lineId,quantity,balance}){
 const need=quantity;const bq=micros(String(balance.quantity)),bv=micros(String(balance.value));
 if(need>bq)fail('STATE_CONFLICT','Negative stock is not allowed: '+item.sku+' has '+decimal(bq)+' in the warehouse and the movement needs '+decimal(need)+'.');
 const layers=(await tx.query('select * from lara.valuation_layers where tenant_id=$1 and item_id=$2 and warehouse_id=$3 and qty_remaining>0 order by effective_date,seq for update',[ctx.tenantId,item.id,warehouseId])).rows;
 let left=need,cost=0n;const allocations=[];
 const avgUnit=item.cost_method==='moving_average'?unit12(bv,bq):null;
 for(const layer of layers){
  if(left<=0n)break;
  const take=micros(String(layer.qty_remaining))<left?micros(String(layer.qty_remaining)):left;
  const unit=item.cost_method==='fifo'?unit12Of(layer.unit_cost):avgUnit;
  let c=costOf(take,unit);
  const remainingAfter=micros(String(layer.qty_remaining))-take;
  allocations.push({layer,take,c,remainingAfter});left-=take;cost+=c;
 }
 if(left>0n)fail('STATE_CONFLICT','Negative stock is not allowed: layers of '+item.sku+' cover '+decimal(need-left)+' of '+decimal(need)+'.');
 // The final issue absorbs the residual so value never drifts from the layers.
 if(need===bq)cost=bv;
 else if(cost>bv)cost=bv;
 for(const a of allocations){
  await tx.query('update lara.valuation_layers set qty_remaining=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,a.layer.id,decimal(a.remainingAfter,6)]);
  await tx.query('insert into lara.stock_allocations(tenant_id,entity_id,issue_line_id,layer_id,quantity,cost) values($1,$2,$3,$4,$5,$6)',[ctx.tenantId,entityId,lineId,a.layer.id,decimal(a.take,6),decimal(a.c,6)]);
 }
 await saveBalance(tx,ctx,item.id,warehouseId,bq-need,bv-cost);
 return {cost,allocations};
}
async function addLayer(tx,ctx,entityId,{item,warehouseId,lineId,quantity,unit12:u,effectiveDate,currency,balance}){
 const value=costOf(quantity,u);
 const row=(await tx.query('insert into lara.valuation_layers(tenant_id,entity_id,item_id,warehouse_id,receipt_line_id,effective_date,qty_received,qty_remaining,unit_cost,currency) values($1,$2,$3,$4,$5,$6,$7,$7,$8,$9) returning *',[ctx.tenantId,entityId,item.id,warehouseId,lineId,effectiveDate,decimal(quantity,6),unit12Text(u),currency])).rows[0];
 await saveBalance(tx,ctx,item.id,warehouseId,micros(String(balance.quantity))+quantity,micros(String(balance.value))+value);
 return {layer:row,value};
}
async function trackSerial(tx,ctx,entityId,{item,code,warehouseId,direction,quantity}){
 if(item.tracking==='none')return;
 const kind=item.tracking;
 const row=(await tx.query('select * from lara.lot_serials where tenant_id=$1 and item_id=$2 and code=$3 for update',[ctx.tenantId,item.id,code])).rows[0];
 if(direction==='in'){
  if(kind==='serial'&&row&&row.status==='in_stock'&&micros(String(row.quantity))>0n)fail('STATE_CONFLICT','Serial '+code+' of '+item.sku+' is already in stock'+(row.warehouse_id!==warehouseId?' in another warehouse':'')+'; a serial exists in one place.');
  if(!row)await tx.query("insert into lara.lot_serials(tenant_id,entity_id,item_id,code,kind,warehouse_id,quantity,status,created_by) values($1,$2,$3,$4,$5,$6,$7,'in_stock',$8)",[ctx.tenantId,entityId,item.id,code,kind,warehouseId,decimal(quantity,6),ctx.principalId]);
  else{if(kind==='batch'&&micros(String(row.quantity))>0n&&row.warehouse_id!==warehouseId)fail('STATE_CONFLICT','Batch '+code+' is held in another warehouse; transfer it first.');await tx.query("update lara.lot_serials set warehouse_id=$3,quantity=$4,status='in_stock' where tenant_id=$1 and id=$2",[ctx.tenantId,row.id,warehouseId,decimal(micros(String(row.quantity))+quantity,6)]);}
 }else{
  if(!row||row.status!=='in_stock'||row.warehouse_id!==warehouseId||micros(String(row.quantity))<quantity)fail('STATE_CONFLICT',(kind==='serial'?'Serial ':'Batch ')+code+' of '+item.sku+' is not in stock in this warehouse.');
  const left=micros(String(row.quantity))-quantity;
  await tx.query('update lara.lot_serials set quantity=$3,status=$4,warehouse_id=$5 where tenant_id=$1 and id=$2',[ctx.tenantId,row.id,decimal(left,6),left>0n?'in_stock':'issued',left>0n?warehouseId:null]);
 }
}
// Deterministic recost for a receipt dated before posted issues of the same
// item and warehouse: replay the FIFO or average sequence with the receipt in
// place and list what each later issue would have cost. Nothing is rewritten;
// posting the receipt posts the difference as a linked adjustment.
async function recostPreviewFor(tx,ctx,entityId,row){
 const lines=(await tx.query('select l.*,i.sku,i.cost_method from lara.stock_movement_lines l join lara.items i on i.tenant_id=l.tenant_id and i.id=l.item_id where l.tenant_id=$1 and l.movement_id=$2 order by l.line_no',[ctx.tenantId,row.id])).rows;
 const affected=[];let total=0n;
 for(const l of lines){
  const later=(await tx.query("select m.id as movement_id,m.kind,m.accounting_date,l2.id as line_id,l2.quantity::text as quantity,l2.cost::text as cost,l2.unit_cost::text as unit_cost,m.created_at from lara.stock_movement_lines l2 join lara.stock_movements m on m.tenant_id=l2.tenant_id and m.id=l2.movement_id where l2.tenant_id=$1 and l2.item_id=$2 and (m.warehouse_id=$3 or m.to_warehouse_id=$3) and m.state='posted' and m.accounting_date>=$4::date order by m.accounting_date,m.created_at,l2.line_no",[ctx.tenantId,l.item_id,row.warehouse_id,iso(row.accounting_date)])).rows;
  const issues=later.filter(x=>['issue','return','transfer','adjustment'].includes(x.kind)&&x.cost!==null&&!(x.kind==='adjustment'&&x.unit_cost!==null));
  if(!issues.length)continue;
  // Replay: layers at the receipt date (posted receipts before it) plus this receipt, then the later movements in order.
  const before=(await tx.query("select l2.quantity::text as quantity,l2.unit_cost::text as unit_cost,m.accounting_date,m.created_at from lara.stock_movement_lines l2 join lara.stock_movements m on m.tenant_id=l2.tenant_id and m.id=l2.movement_id where l2.tenant_id=$1 and l2.item_id=$2 and m.warehouse_id=$3 and m.state='posted' and m.accounting_date<$4::date and l2.unit_cost is not null order by m.accounting_date,m.created_at",[ctx.tenantId,l.item_id,row.warehouse_id,iso(row.accounting_date)])).rows;
  const beforeIssues=(await tx.query("select coalesce(sum(l2.quantity),0)::text as q,coalesce(sum(l2.cost),0)::text as c from lara.stock_movement_lines l2 join lara.stock_movements m on m.tenant_id=l2.tenant_id and m.id=l2.movement_id where l2.tenant_id=$1 and l2.item_id=$2 and m.warehouse_id=$3 and m.state='posted' and m.accounting_date<$4::date and l2.unit_cost is null and l2.cost is not null",[ctx.tenantId,l.item_id,row.warehouse_id,iso(row.accounting_date)])).rows[0];
  let layers=before.map(b=>({q:micros(b.quantity),u:unit12Of(b.unit_cost)}));
  // Net the issues before the receipt date off the oldest layers.
  let consumedBefore=micros(beforeIssues.q);
  for(const L of layers){const t=L.q<consumedBefore?L.q:consumedBefore;L.q-=t;consumedBefore-=t;if(consumedBefore<=0n)break;}
  layers=layers.filter(L=>L.q>0n);
  layers.push({q:micros(l.quantity),u:unit12Of(l.unit_cost)});
  let avgV=layers.reduce((t,L)=>t+costOf(L.q,L.u),0n),avgQ=layers.reduce((t,L)=>t+L.q,0n);
  for(const x of later){
   const q=micros(x.quantity);
   if(x.unit_cost!==null){layers.push({q,u:unit12Of(x.unit_cost)});avgV+=costOf(q,unit12Of(x.unit_cost));avgQ+=q;continue;}
   let left=q,replayed=0n;
   if(l.cost_method==='fifo'){for(const L of layers){if(left<=0n)break;const t=L.q<left?L.q:left;replayed+=costOf(t,L.u);L.q-=t;left-=t;}layers=layers.filter(L=>L.q>0n);}
   else{replayed=q===avgQ?avgV:costOf(q,unit12(avgV,avgQ));avgV-=replayed;avgQ-=q;for(const L of layers){if(left<=0n)break;const t=L.q<left?L.q:left;L.q-=t;left-=t;}layers=layers.filter(L=>L.q>0n);}
   const recorded=micros(x.cost);const diff=replayed-recorded;
   if(diff!==0n){affected.push({movementId:x.movement_id,lineId:x.line_id,kind:x.kind,accountingDate:iso(x.accounting_date),sku:l.sku,recorded:decimal(recorded),replayed:decimal(replayed),difference:decimal(diff)});total+=diff;}
  }
 }
 return {affected,totalDifference:decimal(total),checksum:contentHash(affected)};
}
export async function recostPreview(tx,ctx,entityId,id){
 requirePermission(ctx,'stock_movement.read');requireEntity(ctx,entityId);
 const row=await loadMovement(tx,ctx,entityId,id,{lock:false});
 if(row.kind!=='receipt')return {id,affected:[],totalDifference:'0.00',checksum:contentHash([]),entryId:row.recost_entry_id};
 const p=row.state==='posted'?(row.recost_json||{affected:[],totalDifference:'0.00',checksum:contentHash([])}):await recostPreviewFor(tx,ctx,entityId,row);
 return {id,...p,entryId:row.recost_entry_id};
}
// Posting: one financial effect per movement, layers and balances in the same
// transaction; a retry returns the same result.
export async function postMovement(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'stock_movement.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadMovement(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return mresult(row,{journalEntryIds:[row.posted_entry_id,row.recost_entry_id].filter(Boolean)});
 if(row.state!=='approved')fail('STATE_CONFLICT','Approval is required before posting.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot both approve and post.');
 const profile=await inventoryProfile(tx,ctx,entityId);
 const lines=(await tx.query('select l.*,i.sku,i.cost_method,i.tracking,i.stock_account_id,i.cogs_account_id from lara.stock_movement_lines l join lara.items i on i.tenant_id=l.tenant_id and i.id=l.item_id where l.tenant_id=$1 and l.movement_id=$2 order by l.line_no',[ctx.tenantId,id])).rows;
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,row.book_id])).rows[0];
 const warehouse=(await tx.query('select * from lara.warehouses where tenant_id=$1 and id=$2',[ctx.tenantId,row.warehouse_id])).rows[0];
 const pairs=lines.flatMap(l=>[{itemId:l.item_id,warehouseId:row.warehouse_id},...(row.to_warehouse_id?[{itemId:l.item_id,warehouseId:row.to_warehouse_id}]:[])]);
 const balances=await lockBalances(tx,ctx,entityId,pairs);
 const bal=(itemId,wh)=>balances.get(itemId+'|'+wh);
 const refresh=async(itemId,wh)=>{const b=(await tx.query('select * from lara.stock_balances where tenant_id=$1 and item_id=$2 and warehouse_id=$3',[ctx.tenantId,itemId,wh])).rows[0];balances.set(itemId+'|'+wh,b);return b;};
 // Backdating: a locked period is refused by the posting function; an open
 // period needs the approved recost (computed at approval) posted as a linked adjustment.
 const later=(await tx.query("select 1 from lara.stock_movements m join lara.stock_movement_lines l on l.tenant_id=m.tenant_id and l.movement_id=m.id where m.tenant_id=$1 and m.entity_id=$2 and m.state='posted' and m.accounting_date>$3::date and l.item_id=any($4::uuid[]) and (m.warehouse_id=$5 or m.to_warehouse_id=$5) limit 1",[ctx.tenantId,entityId,iso(row.accounting_date),lines.map(l=>l.item_id),row.warehouse_id])).rowCount>0;
 if(later&&row.kind!=='receipt')fail('STATE_CONFLICT','A backdated '+row.kind+' before later posted movements is not allowed; date it on or after the last movement.');
 const journal=[];let description='';
 const item=l=>({id:l.item_id,sku:l.sku,cost_method:l.cost_method,tracking:l.tracking});
 if(row.kind==='receipt'||(row.kind==='adjustment'&&lines.every(l=>l.unit_cost!==null))){
  let total=0n;const byAccount=new Map();
  for(const l of lines){const q=qty(l.quantity),u=unit12Of(l.unit_cost);const {value}=await addLayer(tx,ctx,entityId,{item:item(l),warehouseId:row.warehouse_id,lineId:l.id,quantity:q,unit12:u,effectiveDate:iso(row.accounting_date),currency:book.functional_currency,balance:bal(l.item_id,row.warehouse_id)});await refresh(l.item_id,row.warehouse_id);await trackSerial(tx,ctx,entityId,{item:item(l),code:l.lot_or_serial,warehouseId:row.warehouse_id,direction:'in',quantity:q});await tx.query('update lara.stock_movement_lines set cost=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,l.id,decimal(value,6)]);byAccount.set(l.stock_account_id,(byAccount.get(l.stock_account_id)||0n)+value);total+=value;}
  for(const [acct,v] of byAccount)if(v>0n)journal.push({accountId:acct,branchId:warehouse.branch_id,dimensions:{},debit:decimal(v,6),credit:'0'});
  if(total>0n)journal.push({accountId:row.kind==='receipt'?profile.grniAccountId:profile.stockGainAccountId,branchId:warehouse.branch_id,dimensions:{},debit:'0',credit:decimal(total,6)});
  description=(row.kind==='receipt'?'Goods receipt ':'Stock gain ')+(row.reason||'')+' at '+warehouse.code;
 }else if(['issue','return','adjustment'].includes(row.kind)){
  let total=0n;const byStock=new Map(),byCogs=new Map();
  for(const l of lines){if(l.unit_cost!==null)fail('VALIDATION_FAILED','Mixed adjustment directions are separate movements.',{fieldErrors:[{path:'lines',message:'Mixed'}]});const q=qty(l.quantity);await trackSerial(tx,ctx,entityId,{item:item(l),code:l.lot_or_serial,warehouseId:row.warehouse_id,direction:'out',quantity:q});const {cost}=await consume(tx,ctx,entityId,{item:item(l),warehouseId:row.warehouse_id,lineId:l.id,quantity:q,balance:bal(l.item_id,row.warehouse_id)});await refresh(l.item_id,row.warehouse_id);await tx.query('update lara.stock_movement_lines set cost=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,l.id,decimal(cost,6)]);byStock.set(l.stock_account_id,(byStock.get(l.stock_account_id)||0n)+cost);const dr=row.kind==='issue'?l.cogs_account_id:row.kind==='return'?profile.grniAccountId:profile.stockLossAccountId;byCogs.set(dr,(byCogs.get(dr)||0n)+cost);total+=cost;}
  for(const [acct,v] of byCogs)if(v>0n)journal.push({accountId:acct,branchId:warehouse.branch_id,dimensions:{},debit:decimal(v,6),credit:'0'});
  for(const [acct,v] of byStock)if(v>0n)journal.push({accountId:acct,branchId:warehouse.branch_id,dimensions:{},debit:'0',credit:decimal(v,6)});
  description=(row.kind==='issue'?'Stock issue ':row.kind==='return'?'Return to supplier ':'Stock loss ')+(row.reason||'')+' from '+warehouse.code;
 }else if(row.kind==='transfer'){
  // Quantity and value conserved: consume at the source, re-layer at the destination at the consumed cost; no profit, no entry.
  for(const l of lines){const q=qty(l.quantity);await trackSerial(tx,ctx,entityId,{item:item(l),code:l.lot_or_serial,warehouseId:row.warehouse_id,direction:'out',quantity:q});const {cost}=await consume(tx,ctx,entityId,{item:item(l),warehouseId:row.warehouse_id,lineId:l.id,quantity:q,balance:bal(l.item_id,row.warehouse_id)});await refresh(l.item_id,row.warehouse_id);await addLayer(tx,ctx,entityId,{item:item(l),warehouseId:row.to_warehouse_id,lineId:l.id,quantity:q,unit12:unit12(cost,q),effectiveDate:iso(row.accounting_date),currency:book.functional_currency,balance:bal(l.item_id,row.to_warehouse_id)});const dest=await refresh(l.item_id,row.to_warehouse_id);
   // The destination value equals the consumed cost exactly, whatever the unit rounding.
   const src=await refresh(l.item_id,row.warehouse_id);await tx.query('update lara.stock_balances set value=$4 where tenant_id=$1 and item_id=$2 and warehouse_id=$3',[ctx.tenantId,l.item_id,row.to_warehouse_id,decimal(micros(String(dest.value))-costOf(q,unit12(cost,q))+cost,6)]);void src;
   await trackSerial(tx,ctx,entityId,{item:item(l),code:l.lot_or_serial,warehouseId:row.to_warehouse_id,direction:'in',quantity:q});await tx.query('update lara.stock_movement_lines set cost=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,l.id,decimal(cost,6)]);}
 }
 let entryId=null;
 if(journal.length>=2)entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'stock_movement',sourceId:id,sourceVersion:Number(row.content_version),purpose:'posting',accountingDate:iso(row.accounting_date),documentDate:iso(row.accounting_date),description:description.trim(),currency:book.functional_currency,manual:false,postingActor:ctx.principalId,commandId,lines:journal})])).rows[0].id;
 // The approved recost of a backdated receipt posts as a linked adjustment (cost of sales against stock).
 let recostId=null;
 if(row.kind==='receipt'&&later){
  const recost=row.recost_json||await recostPreviewFor(tx,ctx,entityId,row);
  const diff=signedMicros(recost.totalDifference);
  if(diff!==0n){const byItem=new Map();for(const a of recost.affected){const l=lines.find(x=>x.sku===a.sku);byItem.set(l.item_id,(byItem.get(l.item_id)||0n)+signedMicros(a.difference));}
   const adj=[];for(const [itemId,d] of byItem){const l=lines.find(x=>x.item_id===itemId);if(d>0n){adj.push({accountId:l.cogs_account_id,branchId:warehouse.branch_id,dimensions:{},debit:decimal(d,6),credit:'0'},{accountId:l.stock_account_id,branchId:warehouse.branch_id,dimensions:{},debit:'0',credit:decimal(d,6)});await refresh(itemId,row.warehouse_id);const b=bal(itemId,row.warehouse_id);await saveBalance(tx,ctx,itemId,row.warehouse_id,micros(String(b.quantity)),micros(String(b.value))-d);}else{adj.push({accountId:l.stock_account_id,branchId:warehouse.branch_id,dimensions:{},debit:decimal(-d,6),credit:'0'},{accountId:l.cogs_account_id,branchId:warehouse.branch_id,dimensions:{},debit:'0',credit:decimal(-d,6)});await refresh(itemId,row.warehouse_id);const b=bal(itemId,row.warehouse_id);await saveBalance(tx,ctx,itemId,row.warehouse_id,micros(String(b.quantity)),micros(String(b.value))-d);}}
   recostId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'stock_recost',sourceId:id,sourceVersion:Number(row.content_version),purpose:'adjustment',accountingDate:iso(row.accounting_date),documentDate:iso(row.accounting_date),description:'Recost of issues after the backdated receipt '+(row.reason||'')+' ('+recost.affected.length+' line(s))',currency:book.functional_currency,manual:false,postingActor:ctx.principalId,commandId,lines:adj})])).rows[0].id;}
 }
 const updated=(await tx.query("update lara.stock_movements set state='posted',posted_entry_id=$3,recost_entry_id=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId,recostId])).rows[0];
 await audit(tx,ctx,{entityId,action:'stock_movement.post',resourceType:'stock_movement',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId||row.content_hash});
 if(entryId)await emit(tx,ctx,{entityId,aggregateType:'stock_movement',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'document.posted.v1',payload:{movementId:id,entryId,kind:row.kind}});
 return mresult(updated,{journalEntryIds:[entryId,recostId].filter(Boolean)});
}
export async function getMovement(tx,ctx,entityId,id){requirePermission(ctx,'stock_movement.read');requireEntity(ctx,entityId);return movementResource(tx,ctx,await loadMovement(tx,ctx,entityId,id,{lock:false}));}
export async function listMovements(tx,ctx,entityId,query){
 requirePermission(ctx,'stock_movement.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.state){params.push(String(query.state));where+=' and state=$'+params.length;}
 if(query?.warehouseId){if(!isUuid(query.warehouseId))fail('VALIDATION_FAILED','warehouseId must be a UUID.');params.push(query.warehouseId);where+=' and (warehouse_id=$'+params.length+' or to_warehouse_id=$'+params.length+')';}
 const rows=(await tx.query('select * from lara.stock_movements where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const items=[];for(const r of rows.slice(0,limit))items.push(await movementResource(tx,ctx,r));
 const last=rows.length>limit?rows[limit-1]:null;
 return {items,nextCursor:last?Buffer.from(JSON.stringify({createdAt:iso(last.created_at),id:last.id,scope})).toString('base64url'):null};
}
// Stock card: the balance, the open layers and the posted movement lines of an item, per warehouse.
export async function stockCard(tx,ctx,entityId,{itemId,warehouseId=null}){
 requirePermission(ctx,'stock_movement.read');requireEntity(ctx,entityId);if(!isUuid(itemId))fail('VALIDATION_FAILED','itemId must be a UUID.',{fieldErrors:[{path:'itemId',message:'UUID'}]});
 const item=(await tx.query('select * from lara.items where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,itemId])).rows[0];if(!item)fail('NOT_FOUND','Item not found.');
 const params=[ctx.tenantId,itemId];let where='';if(warehouseId){if(!isUuid(warehouseId))fail('VALIDATION_FAILED','warehouseId must be a UUID.');params.push(warehouseId);where=' and b.warehouse_id=$3';}
 const balances=(await tx.query('select b.*,w.code from lara.stock_balances b join lara.warehouses w on w.tenant_id=b.tenant_id and w.id=b.warehouse_id where b.tenant_id=$1 and b.item_id=$2'+where+' order by w.code',params)).rows;
 const layers=(await tx.query('select v.*,w.code from lara.valuation_layers v join lara.warehouses w on w.tenant_id=v.tenant_id and w.id=v.warehouse_id where v.tenant_id=$1 and v.item_id=$2'+where.replace('b.','v.')+' order by v.effective_date,v.seq',params)).rows;
 const movements=(await tx.query("select m.id,m.kind,m.accounting_date,m.warehouse_id,m.to_warehouse_id,l.quantity::text as quantity,l.cost::text as cost,l.lot_or_serial,w.code as warehouse_code from lara.stock_movement_lines l join lara.stock_movements m on m.tenant_id=l.tenant_id and m.id=l.movement_id join lara.warehouses w on w.tenant_id=m.tenant_id and w.id=m.warehouse_id where l.tenant_id=$1 and l.item_id=$2 and m.state='posted'"+(warehouseId?' and (m.warehouse_id=$3 or m.to_warehouse_id=$3)':'')+' order by m.accounting_date,m.created_at,l.line_no',params)).rows;
 return {itemId,sku:item.sku,costMethod:item.cost_method,balances:balances.map(b=>({warehouseId:b.warehouse_id,warehouseCode:b.code,quantity:decimal(micros(String(b.quantity))),value:decimal(micros(String(b.value))),averageUnitCost:micros(String(b.quantity))>0n?decimal(costOf(MICRO,unit12(micros(String(b.value)),micros(String(b.quantity)))),2):'0.00'})),layers:layers.map(v=>({id:v.id,warehouseCode:v.code,effectiveDate:iso(v.effective_date),qtyReceived:decimal(micros(String(v.qty_received))),qtyRemaining:decimal(micros(String(v.qty_remaining))),unitCost:String(v.unit_cost).replace(/0+$/,'').replace(/\.$/,'.0'),remainingValue:decimal(costOf(micros(String(v.qty_remaining)),unit12Of(v.unit_cost)))})),movements:movements.map(m=>({movementId:m.id,kind:m.kind,accountingDate:iso(m.accounting_date),warehouseCode:m.warehouse_code,quantity:decimal(micros(m.quantity)),cost:m.cost===null?null:decimal(micros(m.cost)),lotOrSerial:m.lot_or_serial}))};
}
// Valuation versus the ledger: layers by stock account against the account balance at the cutoff.
export async function inventoryValuation(tx,ctx,entityId,{bookId,asOf}){
 requirePermission(ctx,'stock_movement.read');requireEntity(ctx,entityId);
 if(!isUuid(bookId))fail('VALIDATION_FAILED','bookId must be a UUID.',{fieldErrors:[{path:'bookId',message:'UUID'}]});
 if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf||''))fail('VALIDATION_FAILED','asOf is a date.',{fieldErrors:[{path:'asOf',message:'Date'}]});
 const rows=(await tx.query("select i.id as item_id,i.sku,i.stock_account_id,a.code as account_code,w.code as warehouse_code,b.quantity::text as quantity,b.value::text as value from lara.stock_balances b join lara.items i on i.tenant_id=b.tenant_id and i.id=b.item_id join lara.accounts a on a.tenant_id=i.tenant_id and a.id=i.stock_account_id join lara.warehouses w on w.tenant_id=b.tenant_id and w.id=b.warehouse_id where b.tenant_id=$1 and b.entity_id=$2 and a.book_id=$3 and (b.quantity>0 or b.value>0) order by a.code,i.sku,w.code",[ctx.tenantId,entityId,bookId])).rows;
 const accounts=new Map();
 for(const r of rows){const a=accounts.get(r.stock_account_id)||{accountId:r.stock_account_id,accountCode:r.account_code,stock:0n};a.stock+=micros(r.value);accounts.set(r.stock_account_id,a);}
 const out=[];
 for(const a of accounts.values()){const ledger=signedMicros((await tx.query('select coalesce(sum(l.func_debit-l.func_credit),0)::text as b from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.book_id=$2 and l.account_id=$3 and e.accounting_date<=$4::date',[ctx.tenantId,bookId,a.accountId,asOf])).rows[0].b);out.push({accountId:a.accountId,accountCode:a.accountCode,stockValue:decimal(a.stock),ledgerBalance:decimal(ledger),difference:decimal(a.stock-ledger),state:a.stock===ledger?'ties':'differs'});}
 const view={bookId,asOf,items:rows.map(r=>({itemId:r.item_id,sku:r.sku,warehouseCode:r.warehouse_code,accountCode:r.account_code,quantity:decimal(micros(r.quantity)),value:decimal(micros(r.value))})),accounts:out};
 return {...view,checksum:contentHash(view)};
}

// ---------------------------------------------------------------------------
// Count sessions
// ---------------------------------------------------------------------------
const countResource=async(tx,ctx,r)=>resource({...r,status:r.state},{warehouseId:r.warehouse_id,cutoffAt:iso(r.cutoff_at),lines:(await tx.query('select item_id,observed_quantity from lara.count_lines where tenant_id=$1 and session_id=$2 order by item_id',[ctx.tenantId,r.id])).rows.map(l=>({itemId:l.item_id,observedQuantity:money(l.observed_quantity)})),evidenceIds:r.evidence_ids});
async function loadCount(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Count not found.');const row=(await tx.query('select * from lara.count_sessions where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Count not found.');return row;}
async function writeCountLines(tx,ctx,entityId,id,warehouseId,lines){
 await tx.query('delete from lara.count_lines where tenant_id=$1 and session_id=$2',[ctx.tenantId,id]);
 const seen=new Set();
 for(const [i,l] of lines.entries()){
  if(seen.has(l.itemId))fail('VALIDATION_FAILED','Each item appears once in a count.',{fieldErrors:[{path:'lines.'+i+'.itemId',message:'Duplicate'}]});seen.add(l.itemId);
  const item=(await tx.query("select id from lara.items where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,l.itemId])).rows[0];if(!item)fail('NOT_FOUND','Item on line '+(i+1)+' not found.');
  const expected=(await tx.query('select quantity::text as q from lara.stock_balances where tenant_id=$1 and item_id=$2 and warehouse_id=$3',[ctx.tenantId,l.itemId,warehouseId])).rows[0];
  await tx.query('insert into lara.count_lines(tenant_id,entity_id,session_id,item_id,expected_quantity,observed_quantity) values($1,$2,$3,$4,$5,$6)',[ctx.tenantId,entityId,id,l.itemId,expected?decimal(micros(expected.q),6):'0',decimal(qty(l.observedQuantity),6)]);
 }
}
export async function createCount(tx,ctx,entityId,input){
 requirePermission(ctx,'stock_count.create');requireEntity(ctx,entityId);assertInput('CountCreate',input);await requireInventory(tx,ctx,entityId);
 const warehouse=await warehouseFor(tx,ctx,entityId,input.warehouseId);
 const bookId=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary' and status='active'",[ctx.tenantId,entityId])).rows[0]?.id;
 if(!bookId)fail('STATE_CONFLICT','No active primary book.');
 const row=(await tx.query('insert into lara.count_sessions(tenant_id,entity_id,book_id,warehouse_id,cutoff_at,evidence_ids,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[ctx.tenantId,entityId,bookId,warehouse.id,input.cutoffAt,JSON.stringify([...input.evidenceIds].sort()),ctx.principalId])).rows[0];
 await writeCountLines(tx,ctx,entityId,row.id,warehouse.id,input.lines);
 if(input.evidenceIds.length)await linkEvidence(tx,ctx,entityId,input.evidenceIds,'stock_count',row.id,1);
 await audit(tx,ctx,{entityId,action:'stock_count.create',resourceType:'stock_count',resourceId:row.id,resourceVersion:1});
 return countResource(tx,ctx,row);
}
export async function updateCount(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'stock_count.edit');requireEntity(ctx,entityId);assertInput('CountCreate',input);
 const row=await loadCount(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Only draft counts change; a recount is a new session.');
 const warehouse=await warehouseFor(tx,ctx,entityId,input.warehouseId);
 await writeCountLines(tx,ctx,entityId,id,warehouse.id,input.lines);
 const updated=(await tx.query('update lara.count_sessions set warehouse_id=$3,cutoff_at=$4,evidence_ids=$5,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,warehouse.id,input.cutoffAt,JSON.stringify([...input.evidenceIds].sort())])).rows[0];
 await audit(tx,ctx,{entityId,action:'stock_count.edit',resourceType:'stock_count',resourceId:id,resourceVersion:Number(updated.version)});
 return countResource(tx,ctx,updated);
}
export async function approveCount(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'stock_count.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadCount(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Count is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The counter cannot approve the count.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The count changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const updated=(await tx.query('update lara.count_sessions set state=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.decision==='approve'?'approved':'rejected',input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'stock_count.'+input.decision,resourceType:'stock_count',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'stock_count',resourceId:id,version:Number(updated.version),state:updated.state};
}
// Posting a count creates and posts the adjustment movements for the
// variances: gains at the current average unit cost, losses at the layers.
export async function postCount(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'stock_count.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadCount(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted'){const m=row.movement_id?(await tx.query('select posted_entry_id from lara.stock_movements where tenant_id=$1 and id=$2',[ctx.tenantId,row.movement_id])).rows[0]:null;return {resourceType:'stock_count',resourceId:id,version:Number(row.version),state:'posted',journalEntryIds:m?.posted_entry_id?[m.posted_entry_id]:[]};}
 if(row.state!=='approved')fail('STATE_CONFLICT','Approve the count before posting.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The counter cannot both approve and post.');
 const lines=(await tx.query('select * from lara.count_lines where tenant_id=$1 and session_id=$2 order by item_id',[ctx.tenantId,id])).rows;
 const gains=[],losses=[];
 for(const l of lines){
  const expected=micros(String(l.expected_quantity)),observed=micros(String(l.observed_quantity));
  if(observed>expected){const b=(await tx.query('select quantity::text as q,value::text as v from lara.stock_balances where tenant_id=$1 and item_id=$2 and warehouse_id=$3',[ctx.tenantId,l.item_id,row.warehouse_id])).rows[0];const last=(await tx.query('select unit_cost::text as u from lara.valuation_layers where tenant_id=$1 and item_id=$2 and warehouse_id=$3 order by effective_date desc,seq desc limit 1',[ctx.tenantId,l.item_id,row.warehouse_id])).rows[0];const u=b&&micros(b.q)>0n?unit12(micros(b.v),micros(b.q)):last?unit12Of(last.u):0n;gains.push({itemId:l.item_id,quantity:decimal(observed-expected),unitCost:decimal(costOf(MICRO,u))});}
  else if(observed<expected)losses.push({itemId:l.item_id,quantity:decimal(expected-observed)});
 }
 const movementIds=[],entries=[];
 const dateOf=iso(row.cutoff_at).slice(0,10);
 for(const [kind,ls] of [['gain',gains],['loss',losses]]){
  if(!ls.length)continue;
  const m=material({kind:'adjustment',warehouseId:row.warehouse_id,accountingDate:dateOf,lines:ls,reason:'count '+id.slice(0,8)+' '+kind});const hash=contentHash(m);
  // The adjustment movement is drafted, submitted and approved with the count's own approval, then posted.
  const mv=(await tx.query("insert into lara.stock_movements(tenant_id,entity_id,book_id,kind,warehouse_id,accounting_date,count_session_id,reason,content_hash,created_by) values($1,$2,$3,'adjustment',$4,$5,$6,$7,$8,$9) returning *",[ctx.tenantId,entityId,row.book_id,row.warehouse_id,dateOf,id,'count '+id.slice(0,8)+' '+kind,hash,row.created_by])).rows[0];
  for(const [i,l] of ls.entries())await tx.query('insert into lara.stock_movement_lines(tenant_id,entity_id,movement_id,line_no,item_id,quantity,unit_cost) values($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,entityId,mv.id,i+1,l.itemId,decimal(qty(l.quantity),6),l.unitCost!==undefined?decimal(micros(String(l.unitCost)),6):null]);
  await tx.query("update lara.stock_movements set state='submitted' where tenant_id=$1 and id=$2",[ctx.tenantId,mv.id]);
  await tx.query("update lara.stock_movements set state='approved',approved_by=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,mv.id,row.approved_by]);
  const posted=await postMovement(tx,{...ctx,permissions:new Set([...ctx.permissions,'stock_movement.post'])},entityId,mv.id,{},undefined,{commandId});
  movementIds.push(mv.id);entries.push(...posted.journalEntryIds);
 }
 for(const l of lines){const v=(await tx.query("select coalesce(sum(l2.cost),0)::text as c from lara.stock_movement_lines l2 join lara.stock_movements m on m.tenant_id=l2.tenant_id and m.id=l2.movement_id where l2.tenant_id=$1 and m.count_session_id=$2 and l2.item_id=$3",[ctx.tenantId,id,l.item_id])).rows[0].c;await tx.query('update lara.count_lines set variance_value=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,l.id,decimal(micros(v)*(micros(String(l.observed_quantity))>=micros(String(l.expected_quantity))?1n:-1n),6)]);}
 const updated=(await tx.query("update lara.count_sessions set state='posted',movement_id=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,movementIds[0]||null])).rows[0];
 await audit(tx,ctx,{entityId,action:'stock_count.post',resourceType:'stock_count',resourceId:id,resourceVersion:Number(updated.version),afterRef:entries[0]||null,reason:gains.length+' gain(s), '+losses.length+' loss(es)'});
 return {resourceType:'stock_count',resourceId:id,version:Number(updated.version),state:'posted',journalEntryIds:entries,movementIds};
}
export async function getCount(tx,ctx,entityId,id){requirePermission(ctx,'stock_count.read');requireEntity(ctx,entityId);return countResource(tx,ctx,await loadCount(tx,ctx,entityId,id,{lock:false}));}
export async function countLines(tx,ctx,entityId,id){
 requirePermission(ctx,'stock_count.read');requireEntity(ctx,entityId);const row=await loadCount(tx,ctx,entityId,id,{lock:false});
 const lines=(await tx.query('select l.*,i.sku from lara.count_lines l join lara.items i on i.tenant_id=l.tenant_id and i.id=l.item_id where l.tenant_id=$1 and l.session_id=$2 order by i.sku',[ctx.tenantId,id])).rows;
 return {id,state:row.state,lines:lines.map(l=>({itemId:l.item_id,sku:l.sku,expectedQuantity:decimal(micros(String(l.expected_quantity))),observedQuantity:decimal(micros(String(l.observed_quantity))),varianceQuantity:decimal(micros(String(l.observed_quantity))-micros(String(l.expected_quantity))),varianceValue:l.variance_value===null?null:decimal(signedMicros(String(l.variance_value)))})),movementId:row.movement_id};
}
export async function listCounts(tx,ctx,entityId,query){
 requirePermission(ctx,'stock_count.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.count_sessions where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const items=[];for(const r of rows.slice(0,limit))items.push(await countResource(tx,ctx,r));
 const last=rows.length>limit?rows[limit-1]:null;
 return {items,nextCursor:last?Buffer.from(JSON.stringify({createdAt:iso(last.created_at),id:last.id,scope})).toString('base64url'):null};
}

// ---------------------------------------------------------------------------
// Landed cost runs
// ---------------------------------------------------------------------------
const runResource=r=>resource({...r,status:r.state},{chargeDocumentId:r.charge_document_id,receiptIds:r.receipt_ids,method:r.method,amount:money(r.amount)});
async function loadRun(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Landed cost run not found.');const row=(await tx.query('select * from lara.landed_cost_runs where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Landed cost run not found.');return row;}
async function checkRunInput(tx,ctx,entityId,input){
 const charge=(await tx.query("select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,input.chargeDocumentId])).rows[0];
 if(!charge||charge.kind!=='bill')fail('NOT_FOUND','The charge document is a supplier bill.');
 if(charge.state!=='posted')fail('STATE_CONFLICT','The charge bill is '+charge.state+'; only posted charges allocate.');
 if(micros(input.amount)>micros(String(charge.gross)))fail('VALIDATION_FAILED','The allocated amount exceeds the charge bill.',{fieldErrors:[{path:'amount',message:'Exceeds the bill'}]});
 if(input.method==='weight')fail('FEATURE_NOT_ENABLED','Allocation by weight needs item weights, which the item master does not carry yet.');
 const receipts=(await tx.query("select * from lara.stock_movements where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[]) and kind='receipt' and state='posted'",[ctx.tenantId,entityId,input.receiptIds])).rows;
 if(receipts.length!==new Set(input.receiptIds).size)fail('VALIDATION_FAILED','Every receipt must be a posted goods receipt.',{fieldErrors:[{path:'receiptIds',message:'Posted receipts only'}]});
 return {charge,receipts,bookId:receipts[0].book_id};
}
export async function createLandedCost(tx,ctx,entityId,input){
 requirePermission(ctx,'landed_cost.create');requireEntity(ctx,entityId);assertInput('LandedCostCreate',input);await requireInventory(tx,ctx,entityId);
 const {bookId}=await checkRunInput(tx,ctx,entityId,input);
 const row=(await tx.query('insert into lara.landed_cost_runs(tenant_id,entity_id,book_id,charge_document_id,receipt_ids,method,amount,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[ctx.tenantId,entityId,bookId,input.chargeDocumentId,JSON.stringify([...new Set(input.receiptIds)].sort()),input.method,money(input.amount),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'landed_cost.create',resourceType:'landed_cost',resourceId:row.id,resourceVersion:1});
 return runResource(row);
}
export async function updateLandedCost(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'landed_cost.edit');requireEntity(ctx,entityId);assertInput('LandedCostCreate',input);
 const row=await loadRun(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(!['draft','previewed'].includes(row.state))fail('STATE_CONFLICT','Landed cost run is '+row.state+'.');
 await checkRunInput(tx,ctx,entityId,input);
 const updated=(await tx.query("update lara.landed_cost_runs set state='draft',charge_document_id=$3,receipt_ids=$4,method=$5,amount=$6,preview_json=null,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.chargeDocumentId,JSON.stringify([...new Set(input.receiptIds)].sort()),input.method,money(input.amount)])).rows[0];
 await audit(tx,ctx,{entityId,action:'landed_cost.edit',resourceType:'landed_cost',resourceId:id,resourceVersion:Number(updated.version)});
 return runResource(updated);
}
// Allocation over the receipts' layers by value or quantity, residual to the
// largest basis (ties by layer sequence); the remaining share of each layer
// goes to inventory and the sold share to cost of sales.
async function computeAllocations(tx,ctx,row){
 const layers=(await tx.query('select v.*,l.movement_id,i.sku,i.stock_account_id,i.cogs_account_id from lara.valuation_layers v join lara.stock_movement_lines l on l.tenant_id=v.tenant_id and l.id=v.receipt_line_id join lara.items i on i.tenant_id=v.tenant_id and i.id=v.item_id where v.tenant_id=$1 and l.movement_id=any($2::uuid[]) order by v.seq',[ctx.tenantId,row.receipt_ids])).rows;
 if(!layers.length)fail('STATE_CONFLICT','The receipts have no valuation layers.');
 const amount=micros(String(row.amount));
 const basis=layers.map(v=>row.method==='quantity'?micros(String(v.qty_received)):costOf(micros(String(v.qty_received)),unit12Of(v.unit_cost)));
 const totalBasis=basis.reduce((t,b)=>t+b,0n);
 if(totalBasis<=0n)fail('STATE_CONFLICT','The allocation basis is zero.');
 const roundCents=x=>((x+5000n)/10000n)*10000n;
 const rounded=basis.map(b=>roundCents(amount*b/totalBasis));
 const residual=amount-rounded.reduce((t,s)=>t+s,0n);
 let largest=0;for(let i=1;i<basis.length;i++)if(basis[i]>basis[largest])largest=i;
 rounded[largest]+=residual;
 return layers.map((v,i)=>{const received=micros(String(v.qty_received)),remaining=micros(String(v.qty_remaining));const toInv=received>0n?roundCents(rounded[i]*remaining/received):0n;return {layerId:v.id,receiptLineId:v.receipt_line_id,movementId:v.movement_id,sku:v.sku,stockAccountId:v.stock_account_id,cogsAccountId:v.cogs_account_id,qtyReceived:decimal(received),qtyRemaining:decimal(remaining),basis:decimal(basis[i]),amount:decimal(rounded[i]),toInventory:decimal(toInv),toCogs:decimal(rounded[i]-toInv)};});
}
export async function previewLandedCost(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'landed_cost.preview');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadRun(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','previewed'].includes(row.state))fail('STATE_CONFLICT','Landed cost run is '+row.state+'.');
 const allocations=await computeAllocations(tx,ctx,row);
 const preview={allocations,totalToInventory:decimal(allocations.reduce((t,a)=>t+micros(a.toInventory),0n)),totalToCogs:decimal(allocations.reduce((t,a)=>t+micros(a.toCogs),0n)),checksum:contentHash(allocations)};
 const updated=(await tx.query("update lara.landed_cost_runs set state='previewed',preview_json=$3,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,JSON.stringify(preview)])).rows[0];
 await audit(tx,ctx,{entityId,action:'landed_cost.preview',resourceType:'landed_cost',resourceId:id,resourceVersion:Number(updated.version),afterRef:preview.checksum});
 return {resourceType:'landed_cost',resourceId:id,version:Number(updated.version),state:'previewed',preview};
}
export async function approveLandedCost(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'landed_cost.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadRun(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='previewed')fail('STATE_CONFLICT','Preview the run before approval.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot approve the run.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The run changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 if(input.decision==='approve'){const fresh=await computeAllocations(tx,ctx,row);if(contentHash(fresh)!==row.preview_json.checksum)fail('STATE_CONFLICT','Stock moved since the preview; preview again.');}
 const updated=(await tx.query('update lara.landed_cost_runs set state=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.decision==='approve'?'approved':'rejected',input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'landed_cost.'+input.decision,resourceType:'landed_cost',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.preview_json.checksum});
 return {resourceType:'landed_cost',resourceId:id,version:Number(updated.version),state:updated.state};
}
export async function postLandedCost(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'landed_cost.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadRun(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return {resourceType:'landed_cost',resourceId:id,version:Number(row.version),state:'posted',journalEntryIds:[row.posted_entry_id]};
 if(row.state!=='approved')fail('STATE_CONFLICT','Approve the run before posting.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot both approve and post.');
 const profile=await inventoryProfile(tx,ctx,entityId);
 if(!profile.landedCostClearingAccountId)fail('RULE_PROFILE_NOT_APPROVED','The inventory profile names no landed cost clearing account.');
 const fresh=await computeAllocations(tx,ctx,row);
 if(contentHash(fresh)!==row.preview_json.checksum)fail('STATE_CONFLICT','Stock moved since the approval; preview and approve again.');
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,row.book_id])).rows[0];
 const layerRows=(await tx.query('select v.*,w.branch_id from lara.valuation_layers v join lara.warehouses w on w.tenant_id=v.tenant_id and w.id=v.warehouse_id where v.tenant_id=$1 and v.id=any($2::uuid[]) for update of v',[ctx.tenantId,fresh.map(a=>a.layerId)])).rows;
 await lockBalances(tx,ctx,entityId,layerRows.map(v=>({itemId:v.item_id,warehouseId:v.warehouse_id})));
 const stock=new Map(),cogs=new Map();let total=0n;let branchId=null;
 for(const a of fresh){
  const v=layerRows.find(x=>x.id===a.layerId);branchId=branchId||v.branch_id;
  const toInv=micros(a.toInventory),toCogs=micros(a.toCogs);total+=micros(a.amount);
  if(toInv>0n){const remaining=micros(String(v.qty_remaining));const newUnit=unit12Of(v.unit_cost)+unit12(toInv,remaining);await tx.query('update lara.valuation_layers set unit_cost=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,v.id,unit12Text(newUnit)]);const b=(await tx.query('select * from lara.stock_balances where tenant_id=$1 and item_id=$2 and warehouse_id=$3',[ctx.tenantId,v.item_id,v.warehouse_id])).rows[0];await saveBalance(tx,ctx,v.item_id,v.warehouse_id,micros(String(b.quantity)),micros(String(b.value))+toInv);}
  await tx.query('insert into lara.landed_cost_allocations(tenant_id,entity_id,run_id,layer_id,receipt_line_id,basis,amount,to_inventory,to_cogs) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.tenantId,entityId,id,a.layerId,a.receiptLineId,a.basis,a.amount,a.toInventory,a.toCogs]);
  stock.set(a.stockAccountId,(stock.get(a.stockAccountId)||0n)+toInv);cogs.set(a.cogsAccountId,(cogs.get(a.cogsAccountId)||0n)+toCogs);
 }
 const lines=[];
 for(const [acct,v] of stock)if(v>0n)lines.push({accountId:acct,branchId,dimensions:{},debit:decimal(v,6),credit:'0'});
 for(const [acct,v] of cogs)if(v>0n)lines.push({accountId:acct,branchId,dimensions:{},debit:decimal(v,6),credit:'0'});
 lines.push({accountId:profile.landedCostClearingAccountId,branchId,dimensions:{},debit:'0',credit:decimal(total,6)});
 const charge=(await tx.query('select accounting_date from lara.documents where tenant_id=$1 and id=$2',[ctx.tenantId,row.charge_document_id])).rows[0];
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'landed_cost',sourceId:id,sourceVersion:Number(row.content_version),purpose:'posting',accountingDate:iso(charge.accounting_date),documentDate:iso(charge.accounting_date),description:'Landed cost '+row.method+' allocation of '+money(row.amount),currency:book.functional_currency,manual:false,postingActor:ctx.principalId,commandId,lines})])).rows[0].id;
 const updated=(await tx.query("update lara.landed_cost_runs set state='posted',posted_entry_id=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId])).rows[0];
 await audit(tx,ctx,{entityId,action:'landed_cost.post',resourceType:'landed_cost',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'landed_cost',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'document.posted.v1',payload:{runId:id,entryId}});
 return {resourceType:'landed_cost',resourceId:id,version:Number(updated.version),state:'posted',journalEntryIds:[entryId]};
}
export async function getLandedCost(tx,ctx,entityId,id){requirePermission(ctx,'landed_cost.read');requireEntity(ctx,entityId);return runResource(await loadRun(tx,ctx,entityId,id,{lock:false}));}
export async function landedCostPreview(tx,ctx,entityId,id){requirePermission(ctx,'landed_cost.read');requireEntity(ctx,entityId);const row=await loadRun(tx,ctx,entityId,id,{lock:false});const p=row.preview_json||{allocations:[],totalToInventory:'0.00',totalToCogs:'0.00',checksum:null};return {id,state:row.state,method:row.method,amount:money(row.amount),allocations:p.allocations,totalToInventory:p.totalToInventory,totalToCogs:p.totalToCogs,checksum:p.checksum,entryId:row.posted_entry_id};}
export async function listLandedCosts(tx,ctx,entityId,query){
 requirePermission(ctx,'landed_cost.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.landed_cost_runs where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,runResource,scope);
}

// ---------------------------------------------------------------------------
// Three-way match: a bill against a purchase order with goods receipts.
// The receipt is mandated; the price variance is compared with the tolerance
// and a variance beyond it needs the approver's recorded disposition.
// ---------------------------------------------------------------------------
export async function threeWayCheck(tx,ctx,entityId,bill,{stage,reason=null}){
 if(!bill.source_document_id||bill.kind!=='bill')return null;
 if(!(await isInventoryActive(tx,ctx,entityId)))return null;
 const receipts=(await tx.query("select coalesce(sum(l.cost),0)::text as value,count(distinct m.id)::int as n from lara.stock_movement_lines l join lara.stock_movements m on m.tenant_id=l.tenant_id and m.id=l.movement_id where m.tenant_id=$1 and m.entity_id=$2 and m.kind='receipt' and m.state='posted' and m.source_document_id=$3",[ctx.tenantId,entityId,bill.source_document_id])).rows[0];
 // A goods order (a line on a stock account of an item) mandates a posted goods receipt; no tolerance waives it.
 const goods=(await tx.query("select 1 from lara.document_lines l where l.tenant_id=$1 and l.document_id in ($2,$4) and (l.item_id is not null or l.account_id in (select stock_account_id from lara.items i where i.tenant_id=l.tenant_id and i.entity_id=$3)) limit 1",[ctx.tenantId,bill.source_document_id,entityId,bill.id])).rowCount>0;
 if(!receipts.n){if(goods)fail('STATE_CONFLICT','Three-way match: the order is for goods and no goods receipt is posted against it; the receipt is mandated before the bill '+(stage==='approve'?'is approved':'posts')+'.');return null;}
 const received=micros(receipts.value);
 const billed=micros(String(bill.net))+micros((await tx.query("select coalesce(sum(net),0)::text as n from lara.documents where tenant_id=$1 and entity_id=$2 and kind='bill' and source_document_id=$3 and state='posted' and id<>$4",[ctx.tenantId,entityId,bill.source_document_id,bill.id])).rows[0].n);
 const profile=await inventoryProfile(tx,ctx,entityId);
 const tolerance=received*BigInt(Math.round(Number(profile.threeWayTolerancePercent)*10000))/1000000n;
 const variance=billed-received;const abs=variance<0n?-variance:variance;
 const result={received:decimal(received),billed:decimal(billed),variance:decimal(variance),tolerance:decimal(tolerance),withinTolerance:abs<=tolerance};
 if(!result.withinTolerance){
  if(stage==='approve'&&!reason)fail('VALIDATION_FAILED','Three-way match: billed '+decimal(billed)+' against received '+decimal(received)+' varies by '+decimal(variance)+', beyond the tolerance of '+decimal(tolerance)+'; approval needs a reason recording the variance disposition.',{fieldErrors:[{path:'reason',message:'Variance disposition required'}]});
  if(stage==='post'){const disposed=(await tx.query("select 1 from lara.audit_events where tenant_id=$1 and resource_type='document' and resource_id=$2 and action='bill.approve' and reason is not null limit 1",[ctx.tenantId,bill.id])).rowCount>0;if(!disposed)fail('STATE_CONFLICT','Three-way match: the variance of '+decimal(variance)+' exceeds the tolerance and no disposition was recorded at approval.');}
 }
 return result;
}
export const reportBuilders={inventory_valuation:(tx,ctx,entityId,input)=>inventoryValuation(tx,ctx,entityId,{bookId:input.bookId,asOf:input.periodEnd})};
