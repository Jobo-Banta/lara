"use client";
// P10 inventory costing and three-way matching: the stock card with layers
// and movements, the movement workbench (receipt, issue, transfer, return)
// through draft, submit, independent approval and posting with the recost
// preview for backdated receipts, count entry and review, the landed-cost
// preview, and the stock-to-ledger differences with source links. No screen
// moves stock by itself; every posting runs the domain rules.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,type Row,type ApiError} from './workspace-kit';
import {useBookId} from './workspace-ledger';

const money=(v:string|number|null|undefined)=>v==null?'—':new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(v));
const qty=(v:string|number|null|undefined)=>v==null?'—':Number(v).toLocaleString('en-PH',{minimumFractionDigits:0,maximumFractionDigits:6});
const today=()=>new Date().toISOString().slice(0,10);
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Inventory not enabled</h2><p>The inventory capability is activated per entity after treasury, with the controller's signed costing method, unit conversions, cutoff, negative-stock policy and opening count recorded in the inventory profile. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}

// Items and the stock card; stock-to-ledger differences at a cutoff.
export function InventoryItems({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('inventory'))return <NotEnabled me={me}/>;
 const items=useList('/items',entityId,tick);
 const accounts=useList('/accounts',entityId,tick);
 const warehouses=useList('/warehouses',entityId,tick);
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [open,setOpen]=useState<string|null>(null),[card,setCard]=useState<Row|null>(null);
 useEffect(()=>{if(!open){setCard(null);return;}setCard(null);api('GET','/stock-card?itemId='+open,{entityId}).then(r=>setCard(r.data)).catch(e=>setError(asError(e)));},[open,tick]);
 const [asOf,setAsOf]=useState(today()),[valuation,setValuation]=useState<Row|null>(null);
 useEffect(()=>{if(!bookId)return;setValuation(null);api('GET','/inventory-valuation?bookId='+bookId+'&asOf='+asOf,{entityId}).then(r=>setValuation(r.data)).catch(e=>setError(asError(e)));},[bookId,asOf,tick]);
 const assets=(accounts.items||[]).filter(a=>a.category==='asset'),expenses=(accounts.items||[]).filter(a=>a.category==='expense');
 return <>
  <ErrorPanel error={error||cmd.error||items.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('item.create')&&<section className="demo-card"><h2>New item</h2><p>The cost method is chosen before the first movement and fixed afterwards; a change is a separately reviewed conversion. Serial-tracked items move one unit per line and a serial exists in one warehouse.</p><Editor id={'item-new'+entityId} label="Create item" resetOnSave onSave={async d=>!!await cmd.run('POST','/items',{entityId,body:{sku:d.sku,description:d.description,uom:d.uom,costMethod:d.costMethod,tracking:d.tracking,stockAccountId:d.stockAccountId,cogsAccountId:d.cogsAccountId}})}>
   {input('SKU','sku','','text',{required:true,pattern:'[A-Za-z0-9][A-Za-z0-9._-]{0,63}'})}{input('Description','description','','text',{required:true})}{input('Unit','uom','pc','text',{required:true})}
   {select('Cost method','costMethod',[['fifo','FIFO'],['moving_average','Moving weighted average']],'fifo')}{select('Tracking','tracking',[['none','None'],['batch','Batch'],['serial','Serial']],'none')}
   <label>Stock account<select name="stockAccountId" required><option value="">Select asset account</option>{assets.map(a=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
   <label>Cost of sales account<select name="cogsAccountId" required><option value="">Select expense account</option>{expenses.map(a=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
  </Editor></section>}
  <h2>Items</h2>
  {items.items===null?<Loading/>:table(['SKU','Description','Unit','Cost method','Tracking','State','Stock card'],items.items.map(i=>[i.sku,i.description,i.uom,i.costMethod.replace('_',' '),i.tracking,i.state,<button key="c" type="button" onClick={()=>setOpen(open===i.id?null:i.id)}>{open===i.id?'Hide':'Open'}</button>]),'No items yet. Warehouses are registered by an operator from the signed profile ('+((warehouses.items||[]).map(w=>w.code).join(', ')||'none yet')+').')}
  {open&&<section className="demo-card"><h2>Stock card</h2>{card===null?<Loading/>:<><p>{card.sku} · {card.costMethod.replace('_',' ')}</p>{table(['Warehouse','Quantity','Value','Average unit cost'],card.balances.map((b:Row)=>[b.warehouseCode,qty(b.quantity),money(b.value),money(b.averageUnitCost)]),'No stock on hand.')}<h3>Valuation layers</h3>{table(['Warehouse','Received on','Received','Remaining','Unit cost','Remaining value'],card.layers.map((l:Row)=>[l.warehouseCode,l.effectiveDate,qty(l.qtyReceived),qty(l.qtyRemaining),l.unitCost,money(l.remainingValue)]),'No layers.')}<h3>Movements</h3>{table(['Date','Kind','Warehouse','Quantity','Cost','Lot / serial'],card.movements.map((m:Row)=>[m.accountingDate,m.kind,m.warehouseCode,qty(m.quantity),m.cost===null?'—':money(m.cost),m.lotOrSerial||'—']),'No posted movements.')}</>}</section>}
  <h2>Stock to ledger</h2><div className="demo-form"><label>As of<input type="date" value={asOf} onChange={e=>setAsOf(e.target.value)}/></label></div>
  {!bookId?<p>No active book.</p>:valuation===null?<Loading/>:<>{table(['Stock account','Valuation','Ledger balance','Difference','State'],valuation.accounts.map((a:Row)=>[a.accountCode,money(a.stockValue),money(a.ledgerBalance),money(a.difference),a.state==='ties'?'ties':<strong key="s">differs</strong>]),'No stock valued yet.')}
   {table(['SKU','Warehouse','Account','Quantity','Value'],valuation.items.map((i:Row)=>[i.sku,i.warehouseCode,i.accountCode,qty(i.quantity),money(i.value)]),'')}<p>Checksum {valuation.checksum.slice(0,12)}… · differences trace to the movements on the stock card and the journals on the entry.</p></>}
 </>;
}

// Movement workbench: receipts, issues, transfers and returns through the
// reviewed states, with the recost preview for a backdated receipt.
export function InventoryMovements({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('inventory'))return <NotEnabled me={me}/>;
 const items=useList('/items',entityId,tick);
 const warehouses=useList('/warehouses',entityId,tick);
 const movements=useList('/stock-movements',entityId,tick);
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [kind,setKind]=useState('receipt');
 const [lines,setLines]=useState<Row[]>([{itemId:'',quantity:'',unitCost:'',lotOrSerial:''}]);
 const update=(i:number,k:string,v:string)=>setLines(ls=>ls.map((l,j)=>j===i?{...l,[k]:v}:l));
 const [open,setOpen]=useState<string|null>(null),[recost,setRecost]=useState<Row|null>(null);
 useEffect(()=>{if(!open){setRecost(null);return;}api('GET','/stock-movements/'+open+'/recost',{entityId}).then(r=>setRecost(r.data)).catch(e=>setError(asError(e)));},[open,tick]);
 const act=(m:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void cmd.run('POST','/stock-movements/'+m.id+'/'+path,{entityId,ifMatch:m.version,body})}>{label}</button>:null;
 const wh=(id:string)=>(warehouses.items||[]).find(w=>w.id===id)?.code||id.slice(0,8);
 const needsCost=kind==='receipt';
 return <>
  <ErrorPanel error={error||cmd.error||movements.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('stock_movement.create')&&<section className="demo-card"><h2>New movement</h2><p>Receipts carry a unit cost per line and open valuation layers; issues, transfers and returns cost at the layers (FIFO oldest first, or the running average). A receipt dated before posted issues shows its recost at approval and posts the difference as a linked adjustment. Negative stock is refused.</p><Editor id={'move-new'+entityId+kind} label="Save draft" resetOnSave onSave={async d=>{const body:Row={kind,warehouseId:d.warehouseId,accountingDate:d.accountingDate,lines:lines.filter(l=>l.itemId&&l.quantity).map(l=>({itemId:l.itemId,quantity:l.quantity,...(l.unitCost?{unitCost:l.unitCost}:{}),...(l.lotOrSerial?{lotOrSerial:l.lotOrSerial}:{})})),...(d.reason?{reason:d.reason}:{}),...(kind==='transfer'?{toWarehouseId:d.toWarehouseId}:{}),...(d.sourceDocumentId?{sourceDocumentId:d.sourceDocumentId}:{})};const r=await cmd.run('POST','/stock-movements',{entityId,body});if(r)setLines([{itemId:'',quantity:'',unitCost:'',lotOrSerial:''}]);return !!r;}}>
   <label>Kind<select name="kind" value={kind} onChange={e=>setKind(e.target.value)}><option value="receipt">Goods receipt</option><option value="issue">Issue</option><option value="transfer">Transfer</option><option value="return">Return to supplier</option></select></label>
   <label>Warehouse<select name="warehouseId" required><option value="">Select warehouse</option>{(warehouses.items||[]).map(w=><option key={w.id} value={w.id}>{w.code} {w.name}</option>)}</select></label>
   {kind==='transfer'&&<label>To warehouse<select name="toWarehouseId" required><option value="">Select destination</option>{(warehouses.items||[]).map(w=><option key={w.id} value={w.id}>{w.code} {w.name}</option>)}</select></label>}
   {input('Accounting date','accountingDate',today(),'date',{required:true})}{input('Source document id (optional)','sourceDocumentId','','text')}{input('Reason (optional)','reason','','text')}
   <div className="table-scroll" tabIndex={0} role="region" aria-label="Movement lines"><table><thead><tr><th>Item</th><th>Quantity</th><th>Unit cost</th><th>Lot / serial</th><th></th></tr></thead><tbody>{lines.map((l,i)=><tr key={i}>
    <td><select aria-label={'Line '+(i+1)+' item'} value={l.itemId} onChange={e=>update(i,'itemId',e.target.value)}><option value="">Select item</option>{(items.items||[]).map(it=><option key={it.id} value={it.id}>{it.sku} {it.description}</option>)}</select></td>
    <td><input aria-label={'Line '+(i+1)+' quantity'} inputMode="decimal" value={l.quantity} onChange={e=>update(i,'quantity',e.target.value)} placeholder="0"/></td>
    <td><input aria-label={'Line '+(i+1)+' unit cost'} inputMode="decimal" value={l.unitCost} onChange={e=>update(i,'unitCost',e.target.value)} placeholder={needsCost?'0.00':'at the layers'} disabled={!needsCost}/></td>
    <td><input aria-label={'Line '+(i+1)+' lot or serial'} value={l.lotOrSerial} onChange={e=>update(i,'lotOrSerial',e.target.value)}/></td>
    <td><button type="button" onClick={()=>setLines(ls=>ls.filter((_,j)=>j!==i))} aria-label={'Remove line '+(i+1)}>Remove</button></td></tr>)}</tbody></table></div>
   <button type="button" onClick={()=>setLines(ls=>[...ls,{itemId:'',quantity:'',unitCost:'',lotOrSerial:''}])}>Add line</button>
  </Editor></section>}
  <h2>Movements</h2>
  {movements.items===null?<Loading/>:table(['Date','Kind','Warehouse','Lines','Reason','State','Actions'],movements.items.map(m=>[m.accountingDate,m.kind,wh(m.warehouseId)+(m.toWarehouseId?' → '+wh(m.toWarehouseId):''),m.lines.length,m.reason||'—',m.state,<div key="a" className="action-row">{m.kind==='receipt'&&<button type="button" onClick={()=>setOpen(open===m.id?null:m.id)}>{open===m.id?'Hide recost':'Recost'}</button>}{m.state==='draft'&&act(m,'Submit','submit',{},'stock_movement.submit')}{m.state==='submitted'&&act(m,'Approve','approve',{decision:'approve',contentVersion:m.contentVersion},'stock_movement.approve')}{m.state==='submitted'&&can('stock_movement.approve')&&<Editor id={'rejm'+m.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/stock-movements/'+m.id+'/approve',{entityId,ifMatch:m.version,body:{decision:'reject',contentVersion:m.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}{m.state==='approved'&&act(m,'Post','post',{},'stock_movement.post')}</div>]),'No movements yet.')}
  {open&&<section className="demo-card"><h2>Recost preview</h2>{recost===null?<Loading/>:recost.affected.length?<>{table(['Movement','Date','SKU','Recorded','Replayed','Difference'],recost.affected.map((a:Row)=>[a.kind+' '+a.movementId.slice(0,8),a.accountingDate,a.sku,money(a.recorded),money(a.replayed),money(a.difference)]),'')}<p role="status">Total difference {money(recost.totalDifference)} posts as a linked adjustment with the receipt{recost.entryId?' · posted entry '+recost.entryId.slice(0,8):''}.</p></>:<p role="status">No posted issue after this receipt's date is affected.</p>}</section>}
 </>;
}

// Count entry and review: expected quantities freeze at creation, the
// variance is reviewed and posts with independent approval.
export function InventoryCounts({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('inventory'))return <NotEnabled me={me}/>;
 const items=useList('/items',entityId,tick);
 const warehouses=useList('/warehouses',entityId,tick);
 const counts=useList('/stock-counts',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [lines,setLines]=useState<Row[]>([{itemId:'',observedQuantity:''}]);
 const update=(i:number,k:string,v:string)=>setLines(ls=>ls.map((l,j)=>j===i?{...l,[k]:v}:l));
 const [open,setOpen]=useState<string|null>(null),[detail,setDetail]=useState<Row|null>(null);
 useEffect(()=>{if(!open){setDetail(null);return;}api('GET','/stock-counts/'+open+'/lines',{entityId}).then(r=>setDetail(r.data)).catch(e=>setError(asError(e)));},[open,tick]);
 const act=(c:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void cmd.run('POST','/stock-counts/'+c.id+'/'+path,{entityId,ifMatch:c.version,body})}>{label}</button>:null;
 const wh=(id:string)=>(warehouses.items||[]).find(w=>w.id===id)?.code||id.slice(0,8);
 return <>
  <ErrorPanel error={error||cmd.error||counts.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('stock_count.create')&&<section className="demo-card"><h2>New count</h2><p>The expected quantity freezes when the count is created; the observed quantity is reviewed by another principal and the variance posts once (gains at the current cost, losses at the layers).</p><Editor id={'count-new'+entityId} label="Save count" resetOnSave onSave={async d=>{const r=await cmd.run('POST','/stock-counts',{entityId,body:{warehouseId:d.warehouseId,cutoffAt:new Date(d.cutoffAt+'T00:00:00Z').toISOString(),lines:lines.filter(l=>l.itemId&&l.observedQuantity!=='').map(l=>({itemId:l.itemId,observedQuantity:l.observedQuantity})),evidenceIds:d.evidenceId?[d.evidenceId]:[]}});if(r)setLines([{itemId:'',observedQuantity:''}]);return !!r;}}>
   <label>Warehouse<select name="warehouseId" required><option value="">Select warehouse</option>{(warehouses.items||[]).map(w=><option key={w.id} value={w.id}>{w.code} {w.name}</option>)}</select></label>
   {input('Cutoff date','cutoffAt',today(),'date',{required:true})}
   <label>Count sheet evidence<select name="evidenceId"><option value="">None</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
   <div className="table-scroll" tabIndex={0} role="region" aria-label="Count lines"><table><thead><tr><th>Item</th><th>Observed quantity</th><th></th></tr></thead><tbody>{lines.map((l,i)=><tr key={i}><td><select aria-label={'Count line '+(i+1)+' item'} value={l.itemId} onChange={e=>update(i,'itemId',e.target.value)}><option value="">Select item</option>{(items.items||[]).map(it=><option key={it.id} value={it.id}>{it.sku}</option>)}</select></td><td><input aria-label={'Count line '+(i+1)+' observed quantity'} inputMode="decimal" value={l.observedQuantity} onChange={e=>update(i,'observedQuantity',e.target.value)} placeholder="0"/></td><td><button type="button" onClick={()=>setLines(ls=>ls.filter((_,j)=>j!==i))} aria-label={'Remove count line '+(i+1)}>Remove</button></td></tr>)}</tbody></table></div>
   <button type="button" onClick={()=>setLines(ls=>[...ls,{itemId:'',observedQuantity:''}])}>Add line</button>
  </Editor></section>}
  <h2>Counts</h2>
  {counts.items===null?<Loading/>:table(['Warehouse','Cutoff','Items','State','Actions'],counts.items.map(c=>[wh(c.warehouseId),when(c.cutoffAt),c.lines.length,c.state,<div key="a" className="action-row"><button type="button" onClick={()=>setOpen(open===c.id?null:c.id)}>{open===c.id?'Hide lines':'Lines'}</button>{c.state==='draft'&&act(c,'Approve','approve',{decision:'approve',contentVersion:c.contentVersion},'stock_count.approve')}{c.state==='draft'&&can('stock_count.approve')&&<Editor id={'rejc'+c.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/stock-counts/'+c.id+'/approve',{entityId,ifMatch:c.version,body:{decision:'reject',contentVersion:c.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}{c.state==='approved'&&act(c,'Post variances','post',{},'stock_count.post')}</div>]),'No counts yet.')}
  {open&&<section className="demo-card"><h2>Count lines</h2>{detail===null?<Loading/>:table(['SKU','Expected','Observed','Variance','Variance value'],detail.lines.map((l:Row)=>[l.sku,qty(l.expectedQuantity),qty(l.observedQuantity),qty(l.varianceQuantity),l.varianceValue===null?'—':money(l.varianceValue)]),'No lines.')}</section>}
 </>;
}

// Landed cost preview: an approved charge allocated over receipts by value
// or quantity, the sold portion to cost of sales, posted once.
export function InventoryLandedCosts({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('inventory'))return <NotEnabled me={me}/>;
 const runs=useList('/landed-costs',entityId,tick);
 const movements=useList('/stock-movements',entityId,tick,{state:'posted'});
 const bills=useList('/bills',entityId,tick,{state:'posted'});
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [open,setOpen]=useState<string|null>(null),[preview,setPreview]=useState<Row|null>(null);
 useEffect(()=>{if(!open){setPreview(null);return;}api('GET','/landed-costs/'+open+'/lines',{entityId}).then(r=>setPreview(r.data)).catch(e=>setError(asError(e)));},[open,tick]);
 const act=(r:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void cmd.run('POST','/landed-costs/'+r.id+'/'+path,{entityId,ifMatch:r.version,body})}>{label}</button>:null;
 const receipts=(movements.items||[]).filter(m=>m.kind==='receipt');
 return <>
  <ErrorPanel error={error||cmd.error||runs.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('landed_cost.create')&&<section className="demo-card"><h2>New landed cost run</h2><p>An approved freight, duty or handling bill is allocated over posted goods receipts by value or quantity; the residual cent goes to the largest share. The portion still on hand raises the layers, the sold portion goes to cost of sales.</p><Editor id={'lc-new'+entityId} label="Create run" resetOnSave onSave={async d=>{const receiptIds=Object.entries(d).filter(([k,v])=>k.startsWith('rcpt:')&&v==='on').map(([k])=>k.slice(5));return !!await cmd.run('POST','/landed-costs',{entityId,body:{chargeDocumentId:d.chargeDocumentId,receiptIds,method:d.method,amount:d.amount}});}}>
   <label>Charge bill<select name="chargeDocumentId" required><option value="">Select posted bill</option>{(bills.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{b.officialNumber||b.externalReference||b.id.slice(0,8)} · {money(b.gross)}</option>)}</select></label>
   {select('Method','method',[['value','By value'],['quantity','By quantity'],['weight','By weight (needs item weights)']],'value')}{input('Amount','amount','','text',{required:true,inputMode:'decimal'})}
   <fieldset><legend>Receipts</legend>{receipts.map(m=><label key={m.id}><input type="checkbox" name={'rcpt:'+m.id}/> {m.accountingDate} {m.reason||m.id.slice(0,8)} ({m.lines.length} line{m.lines.length===1?'':'s'})</label>)}{!receipts.length&&<p>No posted receipts.</p>}</fieldset>
  </Editor></section>}
  <h2>Landed cost runs</h2>
  {runs.items===null?<Loading/>:table(['Charge','Method','Amount','Receipts','State','Actions'],runs.items.map(r=>[r.chargeDocumentId.slice(0,8),r.method,money(r.amount),r.receiptIds.length,r.state,<div key="a" className="action-row"><button type="button" onClick={()=>setOpen(open===r.id?null:r.id)}>{open===r.id?'Hide preview':'Preview'}</button>{['draft','previewed'].includes(r.state)&&act(r,'Compute preview','preview',{},'landed_cost.preview')}{r.state==='previewed'&&act(r,'Approve','approve',{decision:'approve',contentVersion:r.contentVersion},'landed_cost.approve')}{r.state==='approved'&&act(r,'Post','post',{},'landed_cost.post')}</div>]),'No landed cost runs yet.')}
  {open&&<section className="demo-card"><h2>Allocation preview</h2>{preview===null?<Loading/>:<>{table(['SKU','Receipt','Received','Remaining','Basis','Share','To inventory','To cost of sales'],preview.allocations.map((a:Row)=>[a.sku,a.movementId.slice(0,8),qty(a.qtyReceived),qty(a.qtyRemaining),money(a.basis),money(a.amount),money(a.toInventory),money(a.toCogs)]),'Compute the preview to see the allocations.')}<p role="status">To inventory {money(preview.totalToInventory)} · to cost of sales {money(preview.totalToCogs)}{preview.entryId?' · posted entry '+preview.entryId.slice(0,8):''}</p></>}</section>}
 </>;
}
