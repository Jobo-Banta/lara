"use client";
// P04 sales screens: invoice list, editor and timeline with the four statuses
// kept separate, credit preview against the remaining eligible amount, sales
// orders and quotations converting to invoices, collections with the
// allocation workbench, customer open items with aging and statement, and tax
// rule versions. Totals shown while editing are a preview; the server computes
// and returns the recorded amounts on save.
import {useEffect,useMemo,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,uuid,type Row,type ApiError} from './workspace-kit';
import {useBookId} from './workspace-ledger';
import {FxLayersPanel,amount as fxAmount} from './workspace-fx';

const money=(v:string|number|null|undefined)=>v==null?'—':new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(v));
const today=()=>new Date().toISOString().slice(0,10);
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
const kindLabel:Record<string,string>={invoice:'Invoice',credit_note:'Credit note',quotation:'Quotation',sales_order:'Sales order'};
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Sales not enabled</h2><p>The sales capability is activated per entity after the general ledger, with an approved sales profile (control accounts, rounding) and numbering series. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}
// The four statuses of a document are always presented separately.
const Statuses=({d}:{d:Row})=><dl className="status-grid" aria-label="Document statuses"><div><dt>Document</dt><dd>{d.state.replace('_',' ')}</dd></div><div><dt>Delivery</dt><dd>{d.deliveryState.replace('_',' ')}</dd></div><div><dt>Reporting</dt><dd>{d.reportingState.replace('_',' ')}</dd></div><div><dt>Settlement</dt><dd>{d.settlementState.replace('_',' ')}</dd></div></dl>;
const previewTax=(lines:Row[],rules:Row[])=>{let net=0,tax=0;for(const l of lines){const q=Number(l.quantity||0),p=Number(l.unitPrice||0),d=Number(l.discount||0),rate=Number(rules.find(r=>r.id===l.taxCodeId)?.rate||0);const base=Math.round((q*p-d)*100)/100;if(l.priceBasis==='inclusive'){const n=Math.round(base/(1+rate)*100)/100;net+=n;tax+=base-n;}else{net+=base;tax+=Math.round(base*rate*100)/100;}}return {net,tax,gross:net+tax};};

// ---------------------------------------------------------------------------
// Document editor (invoices, credit notes, orders, quotations)
// ---------------------------------------------------------------------------
function DocumentEditor({entityId,bookId,kind,customers,accounts,rules,branches,initial,onSave,label,currencies=['PHP']}:{entityId:string,bookId:string,kind:string,customers:Row[],accounts:Row[],rules:Row[],currencies?:string[],branches:Row[],initial?:Row,onSave:(body:Row)=>Promise<boolean>,label:string}){
 const blank=()=>({description:'',quantity:'1',unitPrice:'',discount:'0',priceBasis:'exclusive',accountId:'',taxCodeId:''});
 const [lines,setLines]=useState<Row[]>(initial?.lines?.map((l:Row)=>({...l,taxCodeId:l.taxCodeId||'',discount:l.discount||'0'}))||[blank()]);
 const update=(i:number,k:string,v:string)=>setLines(ls=>ls.map((l,j)=>j===i?{...l,[k]:v}:l));
 const preview=useMemo(()=>previewTax(lines,rules),[lines,rules]);
 const revenue=accounts.filter(a=>a.state==='active'&&a.controlType==='none'&&a.category==='income');
 return <Editor id={'doc'+(initial?.id||'new')+kind+entityId+(initial?.version||0)} label={label} onSave={async d=>onSave({kind,branchId:d.branchId,bookId,partyId:d.partyId,documentDate:d.documentDate,accountingDate:d.accountingDate,currency:d.currency||'PHP',ruleProfileVersion:d.ruleProfileVersion,...(d.externalReference?{externalReference:d.externalReference}:{}),...(initial?.sourceDocumentId?{sourceDocumentId:initial.sourceDocumentId}:{}),lines:lines.map(l=>({description:l.description,quantity:l.quantity,unitPrice:l.unitPrice,discount:l.discount||'0',priceBasis:l.priceBasis,accountId:l.accountId,...(l.taxCodeId?{taxCodeId:l.taxCodeId}:{}),dimensions:{}})),evidenceIds:[]})}>
  <label>Customer<select name="partyId" defaultValue={initial?.partyId||''} required disabled={!!initial}><option value="">Select customer</option>{customers.map(c=><option key={c.id} value={c.id}>{c.legalName}</option>)}</select></label>
  <label>Branch<select name="branchId" defaultValue={initial?.branchId||branches[0]?.id||''} required>{branches.map(b=><option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select></label>
  {input('Document date','documentDate',initial?.documentDate||today(),'date',{required:true})}{input('Accounting date','accountingDate',initial?.accountingDate||today(),'date',{required:true})}
  {select('Currency','currency',currencies.map(c=>[c,c] as [string,string]),initial?.currency||'PHP')}{input('Tax profile version','ruleProfileVersion',initial?.ruleProfileVersion||'ph-vat-2026','text',{required:true})}{input('Customer reference (optional)','externalReference',initial?.externalReference||'','text',{maxLength:500})}
  <div className="table-scroll" tabIndex={0} role="region" aria-label="Document lines"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Discount</th><th>Basis</th><th>Revenue account</th><th>Tax</th><th></th></tr></thead><tbody>{lines.map((l,i)=><tr key={i}>
   <td><input aria-label={'Line '+(i+1)+' description'} value={l.description} onChange={e=>update(i,'description',e.target.value)} required maxLength={500}/></td>
   <td><input aria-label={'Line '+(i+1)+' quantity'} inputMode="decimal" value={l.quantity} onChange={e=>update(i,'quantity',e.target.value)} required/></td>
   <td><input aria-label={'Line '+(i+1)+' unit price'} inputMode="decimal" value={l.unitPrice} onChange={e=>update(i,'unitPrice',e.target.value)} required placeholder="0.00"/></td>
   <td><input aria-label={'Line '+(i+1)+' discount'} inputMode="decimal" value={l.discount} onChange={e=>update(i,'discount',e.target.value)}/></td>
   <td><select aria-label={'Line '+(i+1)+' price basis'} value={l.priceBasis} onChange={e=>update(i,'priceBasis',e.target.value)}><option value="exclusive">Tax exclusive</option><option value="inclusive">Tax inclusive</option></select></td>
   <td><select aria-label={'Line '+(i+1)+' revenue account'} value={l.accountId} onChange={e=>update(i,'accountId',e.target.value)} required><option value="">Select account</option>{revenue.map(a=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td>
   <td><select aria-label={'Line '+(i+1)+' tax rule'} value={l.taxCodeId} onChange={e=>update(i,'taxCodeId',e.target.value)}><option value="">No tax</option>{rules.map(r=><option key={r.id} value={r.id}>{r.code} {Number(r.rate)*100}%</option>)}</select></td>
   <td>{lines.length>1&&<button type="button" aria-label={'Remove line '+(i+1)} onClick={()=>setLines(ls=>ls.filter((_,j)=>j!==i))}>×</button>}</td></tr>)}</tbody></table></div>
  <div className="action-row"><button type="button" onClick={()=>setLines(ls=>[...ls,blank()])}>Add line</button></div>
  <p role="status" aria-live="polite">Preview: net {money(preview.net)} · tax {money(preview.tax)} · gross {money(preview.gross)} · the server computes and records the amounts on save.</p>
 </Editor>;
}
function useSalesRefs(entityId:string,tick:number){
 const customers=useList('/parties',entityId,tick,{role:'customer',status:'active'});
 const accounts=useList('/accounts',entityId,tick);
 const rules=useList('/tax-rules',entityId,tick);
 const branches=useList('/branches',entityId,tick);
 return {customers:customers.items||[],accounts:accounts.items||[],rules:(rules.items||[]).filter((r:Row)=>r.state==='active'),branches:branches.items||[]};
}

// ---------------------------------------------------------------------------
// Invoices and credit notes
// ---------------------------------------------------------------------------
export function SalesInvoices({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('sales'))return <NotEnabled me={me}/>;
 const [state,setState]=useState('');
 const list=useList('/invoices',entityId,tick,{state});
 const refs=useSalesRefs(entityId,tick);
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 return <>{can('invoice.prepare')&&bookId&&<><h2>New invoice</h2><DocumentEditor entityId={entityId} bookId={bookId} kind="invoice" {...refs} currencies={me.capabilities.includes('multi_currency')?['PHP','USD','EUR','JPY','GBP','SGD','HKD','CNY','AUD','CAD']:['PHP']} label="Save draft" onSave={async body=>{const r=await cmd.run('POST','/invoices',{entityId,body});if(r)window.location.assign('/sales/invoices/'+r.data.id);return !!r;}}/></>}
  <h2>Invoices and credit notes</h2>
  <div className="filter-row"><label>State<select value={state} onChange={e=>setState(e.target.value)}><option value="">All</option>{['draft','submitted','changes_requested','approved','posted','cancelled'].map(s=><option key={s} value={s}>{s.replace('_',' ')}</option>)}</select></label></div>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['Number','Kind','Customer','Date','Gross','Document','Delivery','Settlement'],list.items.map(d=>[link('/sales/invoices/'+d.id,d.officialNumber||'Draft '+d.id.slice(0,8)),kindLabel[d.kind],refs.customers.find(c=>c.id===d.partyId)?.legalName||d.partyId.slice(0,8),d.documentDate,money(d.gross),d.state.replace('_',' '),d.deliveryState.replace('_',' '),d.settlementState.replace('_',' ')]),'No invoices yet.')}</>;
}
export function SalesInvoiceDetail({entityId,id,me,can,tick,refresh}:Ctx&{id:string}){
 const [d,setD]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null),[items,setItems]=useState<Row[]>([]);
 useEffect(()=>{api('GET','/invoices/'+id,{entityId}).then(r=>{setD(r.data);setError(null);}).catch(e=>setError(asError(e)));},[id,entityId,tick]);
 useEffect(()=>{if(!d)return;api('GET','/open-items?partyId='+d.partyId,{entityId}).then(r=>setItems(r.data.items)).catch(()=>setItems([]));},[d?.partyId,tick]);
 const refs=useSalesRefs(entityId,tick);
 const cmd=useCommand(refresh);
 if(error)return <ErrorPanel error={error} onReload={refresh}/>;
 if(!d)return <Loading/>;
 const editable=['draft','changes_requested'].includes(d.state);
 const customer=refs.customers.find(c=>c.id===d.partyId);
 const act=(label:string,path:string,body:Row,permission:string,go?:boolean)=>can(permission)?<button disabled={cmd.busy} onClick={async()=>{const r=await cmd.run('POST','/invoices/'+id+'/'+path,{entityId,ifMatch:d.version,body});if(r&&go)window.location.assign('/sales/invoices/'+r.data.resourceId);}}>{label}</button>:null;
 const item=items.find(i=>i.documentId===id);
 return <>
  <section className="demo-card"><h2>{kindLabel[d.kind]} {d.officialNumber||'(draft)'}</h2><p>{customer?.legalName||'Customer'} · {d.documentDate} · accounting {d.accountingDate}{d.externalReference?' · '+d.externalReference:''}{d.sourceDocumentId&&<> · from {link('/sales/invoices/'+d.sourceDocumentId,'linked document')}</>}</p>
   <Statuses d={d}/>
   <p>Net {fxAmount(d.net,d.currency)} · Tax {fxAmount(d.tax,d.currency)} · <strong>Gross {fxAmount(d.gross,d.currency)}</strong>{item&&<> · Outstanding {fxAmount(item.outstandingAmount,d.currency)} (allocated {fxAmount(item.allocatedAmount,d.currency)}, due {item.dueDate})</>}</p>
   {item&&d.currency!=='PHP'&&<FxLayersPanel entityId={entityId} openItemId={item.id} currency={d.currency} tick={tick}/>}
   <div className="action-row">{editable&&act('Submit for approval','submit',{},'invoice.submit')}{d.state==='submitted'&&act('Approve','approve',{decision:'approve',contentVersion:d.contentVersion},'invoice.approve')}{d.state==='submitted'&&can('invoice.approve')&&<Editor id={'reject'+id} label="Request changes" onSave={async x=>!!await cmd.run('POST','/invoices/'+id+'/approve',{entityId,ifMatch:d.version,body:{decision:'reject',contentVersion:d.contentVersion,reason:x.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}{d.state==='approved'&&act(d.kind==='credit_note'?'Issue credit note':'Issue invoice','post',{},'invoice.post')}{d.state==='posted'&&d.kind==='invoice'&&act('Deliver to customer','deliver',{},'invoice.deliver')}</div>
   <ErrorPanel error={cmd.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
   {d.state==='posted'&&<p>Issued documents are immutable; corrections are new linked documents.</p>}
  </section>
  {table(['#','Description','Qty','Unit price','Discount','Basis','Account','Tax rule'],d.lines.map((l:Row,i:number)=>[i+1,l.description,l.quantity,money(l.unitPrice),money(l.discount),l.priceBasis,refs.accounts.find(a=>a.id===l.accountId)?.code||'—',refs.rules.find(r=>r.id===l.taxCodeId)?.code||(l.taxCodeId?'inactive rule':'none')]),'No lines.')}
  <section className="demo-card"><h2>Timeline</h2><ol className="timeline"><li>Created {when(d.createdAt)} · content version {d.contentVersion}</li>{d.state!=='draft'&&<li>{d.state==='cancelled'?'Cancelled':'Submitted for approval'}</li>}{['approved','posted'].includes(d.state)&&<li>Approved (bound to content version {d.contentVersion})</li>}{d.state==='posted'&&<li>Issued as {d.officialNumber} · journal entry posted</li>}{d.deliveryState!=='not_requested'&&<li>Delivery {d.deliveryState}</li>}{d.settlementState!=='unpaid'&&<li>Settlement {d.settlementState.replace('_',' ')}</li>}<li>Last change {when(d.updatedAt)} · version {d.version}</li></ol></section>
  {editable&&can('invoice.edit')&&<><h2>Edit draft</h2><DocumentEditor entityId={entityId} bookId={d.bookId} kind={d.kind} {...refs} initial={d} label="Save changes" onSave={async body=>!!await cmd.run('PATCH','/invoices/'+id,{entityId,ifMatch:d.version,body})}/></>}
  {d.state==='posted'&&d.kind==='invoice'&&can('invoice.correct')&&<CreditPreview entityId={entityId} d={d} refs={refs} cmd={cmd}/>}
 </>;
}
// Credit preview: the remaining creditable amount per revenue account is the
// original net minus prior credits; the server enforces the same rule.
function CreditPreview({entityId,d,refs,cmd}:{entityId:string,d:Row,refs:Row,cmd:ReturnType<typeof useCommand>}){
 const [credits,setCredits]=useState<Row[]|null>(null);
 useEffect(()=>{api('GET','/invoices?state=posted',{entityId}).then(r=>setCredits(r.data.items.filter((x:Row)=>x.kind==='credit_note'&&x.sourceDocumentId===d.id))).catch(()=>setCredits([]));},[d.id,entityId]);
 const [amounts,setAmounts]=useState<Record<string,string>>({});
 const remaining=useMemo(()=>{const m:Record<string,number>={};for(const l of d.lines){const q=Number(l.quantity),p=Number(l.unitPrice),disc=Number(l.discount||0);const base=Math.round((q*p-disc)*100)/100;const rate=Number(refs.rules.find((r:Row)=>r.id===l.taxCodeId)?.rate||0);const net=l.priceBasis==='inclusive'?Math.round(base/(1+rate)*100)/100:base;m[l.accountId]=(m[l.accountId]||0)+net;}for(const c of credits||[])for(const l of c.lines)m[l.accountId]=(m[l.accountId]||0)-Number(l.unitPrice)*Number(l.quantity);return m;},[d,credits,refs.rules]);
 const [kind,setKind]=useState('credit_note');
 const lines=Object.entries(amounts).filter(([,v])=>Number(v)>0).map(([accountId,v])=>{const src=d.lines.find((l:Row)=>l.accountId===accountId);return {description:'Credit: '+(src?.description||''),quantity:'1',unitPrice:v,discount:'0',priceBasis:'exclusive',accountId,...(src?.taxCodeId?{taxCodeId:src.taxCodeId}:{}),dimensions:{}};});
 const over=Object.entries(amounts).some(([a,v])=>Number(v)>(remaining[a]??0)+1e-9);
 return <section className="demo-card"><h2>Correct this invoice</h2><p>Credits reduce the receivable through a linked credit note that travels through review. Eligible amounts are what remains after earlier credits.</p>
  {credits===null?<Loading/>:table(['Revenue account','Original net','Remaining creditable','Credit net'],Object.entries(remaining).map(([accountId,left])=>[refs.accounts.find((a:Row)=>a.id===accountId)?.code||accountId.slice(0,8),money(d.lines.filter((l:Row)=>l.accountId===accountId).reduce((s:number,l:Row)=>s+Number(l.unitPrice)*Number(l.quantity)-Number(l.discount||0),0)),money(left),<input key={accountId} aria-label={'Credit for '+(refs.accounts.find((a:Row)=>a.id===accountId)?.code||accountId)} inputMode="decimal" value={amounts[accountId]||''} onChange={e=>setAmounts(m=>({...m,[accountId]:e.target.value}))} placeholder="0.00"/>]),'No revenue lines.')}
  <Editor id={'correct'+d.id} label={kind==='reversal'?'Prepare full reversal':'Prepare credit note'} disabled={kind!=='reversal'&&(!lines.length||over)} onSave={async x=>{const body:Row={kind,accountingDate:x.accountingDate,reason:x.reason,lines:kind==='reversal'?d.lines.map((l:Row)=>({description:l.description,quantity:l.quantity,unitPrice:l.unitPrice,discount:l.discount||'0',priceBasis:l.priceBasis,accountId:l.accountId,...(l.taxCodeId?{taxCodeId:l.taxCodeId}:{}),dimensions:{}})):lines};const r=await cmd.run('POST','/invoices/'+d.id+'/correct',{entityId,ifMatch:d.version,body});if(r)window.location.assign('/sales/invoices/'+r.data.resourceId);return !!r;}}>
   <label>Correction<select name="kind" value={kind} onChange={e=>setKind(e.target.value)}><option value="credit_note">Partial credit note</option><option value="reversal">Full reversal (credit everything)</option></select></label>{input('Accounting date','accountingDate',today(),'date',{required:true})}{input('Reason','reason','','text',{required:true})}
   <p role="status">{over?'A credit exceeds the remaining eligible amount.':kind==='reversal'?'Credits the full '+money(d.gross)+'.':lines.length?'Credit net '+money(lines.reduce((s,l)=>s+Number(l.unitPrice),0))+' before tax.':'Enter credit amounts above.'}</p>
  </Editor></section>;
}

// ---------------------------------------------------------------------------
// Sales orders and quotations
// ---------------------------------------------------------------------------
export function SalesOrders({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('sales'))return <NotEnabled me={me}/>;
 const list=useList('/sales-orders',entityId,tick);
 const refs=useSalesRefs(entityId,tick);
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 const [kind,setKind]=useState('sales_order');
 const act=(o:Row,label:string,path:string,body:Row,permission:string,go?:boolean)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={async()=>{const r=await cmd.run('POST','/sales-orders/'+o.id+'/'+path,{entityId,ifMatch:o.version,body});if(r&&go)window.location.assign('/sales/invoices/'+r.data.resourceId);}}>{label}</button>:null;
 return <>{can('sales_order.create')&&bookId&&<><h2>New {kind==='quotation'?'quotation':'sales order'}</h2><div className="filter-row"><label>Kind<select value={kind} onChange={e=>setKind(e.target.value)}><option value="sales_order">Sales order</option><option value="quotation">Quotation</option></select></label></div><DocumentEditor entityId={entityId} bookId={bookId} kind={kind} {...refs} label="Save draft" onSave={async body=>!!await cmd.run('POST','/sales-orders',{entityId,body})}/></>}
  <h2>Orders and quotations</h2><p>Approved orders convert once into an invoice draft for the remaining billable quantity; the source link is immutable.</p>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['Kind','Customer','Date','Gross','State','Actions'],list.items.map(o=>[kindLabel[o.kind],refs.customers.find(c=>c.id===o.partyId)?.legalName||o.partyId.slice(0,8),o.documentDate,money(o.gross),o.state.replace('_',' '),<div key="a" className="action-row">{['draft','changes_requested'].includes(o.state)&&act(o,'Submit','submit',{},'sales_order.submit')}{o.state==='submitted'&&act(o,'Approve','approve',{decision:'approve',contentVersion:o.contentVersion},'sales_order.approve')}{o.state==='approved'&&act(o,'Convert to invoice','convert',{},'sales_order.convert',true)}</div>]),'No orders yet.')}</>;
}

// ---------------------------------------------------------------------------
// Collections and the allocation workbench
// ---------------------------------------------------------------------------
function AllocationWorkbench({items,amounts,setAmounts,max}:{items:Row[],amounts:Record<string,string>,setAmounts:(f:(m:Record<string,string>)=>Record<string,string>)=>void,max:number}){
 const total=Object.values(amounts).reduce((s,v)=>s+Number(v||0),0);
 return <><div className="table-scroll" tabIndex={0} role="region" aria-label="Open items to allocate"><table><thead><tr><th>Document</th><th>Due</th><th>Original</th><th>Outstanding</th><th>Allocate</th></tr></thead><tbody>{items.map(i=><tr key={i.id}><td>{link('/sales/invoices/'+i.documentId,'Open invoice')}</td><td>{i.dueDate}</td><td>{money(i.originalAmount)}</td><td>{money(i.outstandingAmount)}</td><td><input aria-label={'Allocate to item due '+i.dueDate} inputMode="decimal" value={amounts[i.id]||''} onChange={e=>setAmounts(m=>({...m,[i.id]:e.target.value}))} placeholder="0.00"/> <button type="button" onClick={()=>setAmounts(m=>({...m,[i.id]:i.outstandingAmount}))}>Full</button></td></tr>)}</tbody></table>{!items.length&&<p>No open items for this customer; the receipt stays as an unapplied advance until invoices exist.</p>}</div>
  <p role="status" aria-live="polite">Allocated {money(total)} of {money(max)}{total>max+1e-9?' · exceeds the receipt':total<max-1e-9?' · '+money(max-total)+' stays unapplied (advance)':' · fully applied'}</p></>;
}
export function SalesCollections({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('sales'))return <NotEnabled me={me}/>;
 const list=useList('/collections',entityId,tick);
 const refs=useSalesRefs(entityId,tick);
 const cmd=useCommand(refresh);
 const [partyId,setPartyId]=useState(''),[amounts,setAmounts]=useState<Record<string,string>>({}),[gross,setGross]=useState('');
 const open=useList('/open-items',partyId?entityId:null,tick,{partyId,open:'true'});
 return <>{can('collection.create')&&<><h2>New receipt</h2><p>Gross equals cash plus customer withholding. Allocations are applied when the receipt posts; an unallocated remainder is a customer advance applied later.</p>
  <Editor id={'collection-new'+entityId} label="Save receipt" resetOnSave onSave={async d=>{const allocations=Object.entries(amounts).filter(([,v])=>Number(v)>0).map(([openItemId,amount])=>({openItemId,amount}));const r=await cmd.run('POST','/collections',{entityId,body:{direction:'receipt',partyId:d.partyId,...(d.branchId?{branchId:d.branchId}:{}),currency:d.currency||'PHP',valueDate:d.valueDate,grossAmount:d.grossAmount,cashAmount:d.cashAmount,withholdingAmount:d.withholdingAmount||'0',method:d.method,allocations,evidenceIds:[]}});if(r){setAmounts({});window.location.assign('/sales/collections/'+r.data.id);}return !!r;}}>
   <label>Customer<select name="partyId" value={partyId} onChange={e=>{setPartyId(e.target.value);setAmounts({});}} required><option value="">Select customer</option>{refs.customers.map(c=><option key={c.id} value={c.id}>{c.legalName}</option>)}</select></label>
   {select('Currency','currency',(me.capabilities.includes('multi_currency')?['PHP','USD','EUR','JPY','GBP','SGD','HKD','CNY','AUD','CAD']:['PHP']).map(c=>[c,c] as [string,string]),'PHP')}{input('Value date','valueDate',today(),'date',{required:true})}<label>Gross received<input name="grossAmount" inputMode="decimal" value={gross} onChange={e=>setGross(e.target.value)} required placeholder="0.00"/></label>{input('Cash amount','cashAmount','','text',{required:true,inputMode:'decimal',placeholder:'0.00'})}{input('Customer withholding','withholdingAmount','0','text',{inputMode:'decimal'})}{select('Method','method',[['transfer','Bank transfer'],['cash','Cash'],['check','Check'],['wallet','E-wallet'],['card','Card']],'transfer')}
   <label>Branch (drawer or account that received it)<select name="branchId" defaultValue={refs.branches[0]?.id||''}>{refs.branches.map((b:Row)=><option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select></label>
   {partyId&&(open.items===null?<Loading/>:<AllocationWorkbench items={open.items} amounts={amounts} setAmounts={setAmounts} max={Number(gross||0)}/>)}
  </Editor></>}
  <h2>Receipts</h2>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['Value date','Customer','Gross','Cash','Withholding','Allocated','State'],list.items.map(s=>[link('/sales/collections/'+s.id,s.valueDate),refs.customers.find(c=>c.id===s.partyId)?.legalName||s.partyId.slice(0,8),money(s.grossAmount),money(s.cashAmount),money(s.withholdingAmount),money(s.allocations.reduce((t:number,a:Row)=>t+Number(a.amount),0)),s.state]),'No receipts yet.')}</>;
}
export function SalesCollectionDetail({entityId,id,me,can,tick,refresh}:Ctx&{id:string}){
 const [s,setS]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null),[amounts,setAmounts]=useState<Record<string,string>>({});
 useEffect(()=>{api('GET','/collections/'+id,{entityId}).then(r=>{setS(r.data);setError(null);}).catch(e=>setError(asError(e)));},[id,entityId,tick]);
 const open=useList('/open-items',s?entityId:null,tick,{partyId:s?.partyId||'',open:'true'});
 const refs=useSalesRefs(entityId,tick);
 const cmd=useCommand(refresh);
 if(error)return <ErrorPanel error={error} onReload={refresh}/>;
 if(!s)return <Loading/>;
 const allocated=s.allocations.reduce((t:number,a:Row)=>t+Number(a.amount),0),unapplied=Number(s.grossAmount)-allocated;
 const act=(label:string,path:string,body:Row,permission:string)=>can(permission)?<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/collections/'+id+'/'+path,{entityId,ifMatch:s.version,body})}>{label}</button>:null;
 return <>
  <section className="demo-card"><h2>Receipt {s.valueDate} · {refs.customers.find(c=>c.id===s.partyId)?.legalName||''}</h2><p>State {s.state} · gross {money(s.grossAmount)} = cash {money(s.cashAmount)} + withholding {money(s.withholdingAmount)} · method {s.method}</p><p>Allocated {money(allocated)} · unapplied {money(unapplied)}{s.state==='posted'&&unapplied>0?' (customer advance)':''}</p>
   <div className="action-row">{s.state==='draft'&&act('Submit for approval','submit',{},'collection.submit')}{s.state==='submitted'&&act('Approve','approve',{decision:'approve',contentVersion:s.contentVersion},'collection.approve')}{s.state==='approved'&&act('Post receipt','post',{},'collection.post')}{s.state==='posted'&&can('collection.reverse')&&<Editor id={'revcol'+id} label="Reverse receipt" onSave={async d=>!!await cmd.run('POST','/collections/'+id+'/reverse',{entityId,ifMatch:s.version,body:{accountingDate:d.accountingDate,reason:d.reason}})}>{input('Reversal date','accountingDate',today(),'date',{required:true})}{input('Reason','reason','','text',{required:true})}</Editor>}</div>
   <ErrorPanel error={cmd.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/></section>
  {table(['Open item','Allocated'],s.allocations.map((a:Row)=>[a.openItemId.slice(0,8),money(a.amount)]),s.state==='posted'?'Nothing allocated yet: this receipt is an unapplied advance.':'Allocations are applied when the receipt posts.')}
  {s.state==='posted'&&unapplied>0&&can('collection.allocate')&&<section className="demo-card"><h2>Apply the remaining {money(unapplied)}</h2>{open.items===null?<Loading/>:<AllocationWorkbench items={open.items} amounts={amounts} setAmounts={setAmounts} max={unapplied}/>}<div className="action-row"><button disabled={cmd.busy||!Object.values(amounts).some(v=>Number(v)>0)} onClick={async()=>{const r=await cmd.run('POST','/collections/'+id+'/allocations',{entityId,ifMatch:s.version,body:{allocations:Object.entries(amounts).filter(([,v])=>Number(v)>0).map(([openItemId,amount])=>({openItemId,amount}))}});if(r)setAmounts({});}}>Apply allocations</button></div></section>}
 </>;
}

// ---------------------------------------------------------------------------
// Customers: open items, statement and aging
// ---------------------------------------------------------------------------
export function SalesCustomers({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('sales'))return <NotEnabled me={me}/>;
 const [partyId,setPartyId]=useState('');
 const refs=useSalesRefs(entityId,tick);
 const items=useList('/open-items',entityId,tick,partyId?{partyId,side:'AR'}:{side:'AR',open:'true'});
 const {bookId}=useBookId(entityId,tick,me);
 const [job,setJob]=useState<Row|null>(null),[report,setReport]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null);
 useEffect(()=>{if(!job||!['queued','running','retry_wait'].includes(job.state))return;const t=setTimeout(()=>api('GET','/jobs/'+job.id,{entityId}).then(r=>setJob(r.data)).catch(e=>setError(asError(e))),1500);return()=>clearTimeout(t);},[job]);
 useEffect(()=>{if(job?.state==='succeeded'&&job.resultResourceId&&!report){fetch('/api/v1/evidence/'+job.resultResourceId+'/content',{headers:{'x-entity-id':entityId}}).then(async r=>{if(!r.ok)throw await r.json();setReport(await r.json());}).catch(e=>setError(asError(e)));}},[job]);
 const byParty=useMemo(()=>{const m=new Map<string,{outstanding:number,count:number}>();for(const i of items.items||[]){const c=m.get(i.partyId)||{outstanding:0,count:0};c.outstanding+=Number(i.outstandingAmount);c.count++;m.set(i.partyId,c);}return m;},[items.items]);
 return <>
  <div className="filter-row"><label>Customer<select value={partyId} onChange={e=>setPartyId(e.target.value)}><option value="">All customers</option>{refs.customers.map(c=><option key={c.id} value={c.id}>{c.legalName}</option>)}</select></label></div>
  <ErrorPanel error={items.error||error} onReload={refresh}/>
  {!partyId&&<><h2>Receivables by customer</h2>{items.items===null?<Loading/>:table(['Customer','Open items','Outstanding'],[...byParty.entries()].map(([pid,c])=>[<button key={pid} type="button" className="link" onClick={()=>setPartyId(pid)}>{refs.customers.find(x=>x.id===pid)?.legalName||pid.slice(0,8)}</button>,c.count,money(c.outstanding)]),'No receivables.')}</>}
  {partyId&&<><h2>Statement · {refs.customers.find(c=>c.id===partyId)?.legalName}</h2>{items.items===null?<Loading/>:table(['Invoice','Due','Original','Allocated','Outstanding'],items.items.map(i=>[link('/sales/invoices/'+i.documentId,'Open invoice'),i.dueDate,money(i.originalAmount),money(i.allocatedAmount),money(i.outstandingAmount)]),'No open items for this customer.')}<p>Total outstanding {money((items.items||[]).reduce((s,i)=>s+Number(i.outstandingAmount),0))}</p></>}
  {can('report.generate')&&bookId&&<section className="demo-card"><h2>Aging</h2><Editor id={'aging'+entityId} label="Generate aging report" onSave={async d=>{setReport(null);setError(null);try{const r=await api('POST','/reports',{entityId,key:uuid(),body:{reportType:'aging',bookId,periodStart:d.asOf.slice(0,8)+'01',periodEnd:d.asOf,asOf:new Date().toISOString(),format:'json'}});setJob(r.data);return true;}catch(e){setError(asError(e));return false;}}}>{input('As of','asOf',today(),'date',{required:true})}</Editor>
   {job&&<p role="status" aria-live="polite">Aging job {job.state.replace('_',' ')}</p>}
   {report&&<>{table(['Customer','Current','1–30','31–60','61–90','Over 90','Total'],report.payload.parties.filter((p:Row)=>!partyId||p.partyId===partyId).map((p:Row)=>[p.legalName,money(p.buckets.current),money(p.buckets['1_30']),money(p.buckets['31_60']),money(p.buckets['61_90']),money(p.buckets.over_90),money(p.total)]),'Nothing outstanding as of '+report.payload.asOf)}<p>Total {money(report.payload.totals.total)} · snapshot version {report.versionNumber} · checksum {report.checksum.slice(0,12)}…</p></>}
  </section>}
 </>;
}

// ---------------------------------------------------------------------------
// Tax rules
// ---------------------------------------------------------------------------
export function TaxRules({entityId,me,can,tick,refresh}:Ctx){
 const list=useList('/tax-rules',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const act=(r:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void cmd.run('POST','/tax-rules/'+r.id+'/'+path,{entityId,ifMatch:r.version,body})}>{label}</button>:null;
 return <>{can('tax_rule.create')&&<><h2>New tax rule version</h2><p>Every version cites its source evidence and the golden accounting cases it must satisfy; approval and activation come from other principals, and an active version is immutable.</p><Editor id={'rule-new'+entityId} label="Save draft" resetOnSave onSave={async d=>!!await cmd.run('POST','/tax-rules',{entityId,body:{code:d.code,taxType:d.taxType,validFrom:d.validFrom,...(d.validTo?{validTo:d.validTo}:{}),rate:d.rate,basis:d.basis,recognition:d.recognition,rounding:d.rounding,applicabilityProfileId:d.applicabilityProfileId||uuid(),sourceEvidenceIds:[d.evidenceId],goldenCaseIds:String(d.goldenCaseIds).split(',').map(s=>s.trim()).filter(Boolean)}})}>
   {input('Code','code','VAT12','text',{required:true,pattern:'[A-Za-z0-9][A-Za-z0-9._-]{0,31}'})}{select('Tax type','taxType',[['vat','VAT'],['withholding','Withholding'],['percentage','Percentage tax'],['grt','Gross receipts tax'],['dst','Documentary stamp tax']],'vat')}{input('Rate (0.12 = 12%)','rate','0.12','text',{required:true,pattern:'\\d{1,12}(\\.\\d{1,12})?'})}{input('Valid from','validFrom','2026-01-01','date',{required:true})}{input('Valid to (optional)','validTo','','date')}{select('Basis','basis',[['net','Net'],['gross','Gross'],['instrument','Instrument'],['approved_expression','Approved expression']],'net')}{select('Recognition','recognition',[['issue','On issue'],['accrual','On accrual'],['payment','On payment'],['profile_event','Profile event']],'issue')}{select('Rounding','rounding',[['line_half_up','Per line, half up'],['document_half_up','Per document, half up (residual by remainder)']],'line_half_up')}
   <label>Source evidence<select name="evidenceId" required><option value="">Select available evidence</option>{(evidence.items||[]).map(e=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>{input('Golden cases (comma separated)','goldenCaseIds','AC-01','text',{required:true})}
  </Editor></>}
  <h2>Tax rule versions</h2>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['Code','Type','Rate','Valid from','Rounding','State','Actions'],list.items.map(r=>[r.code,r.taxType,Number(r.rate)*100+'%',r.validFrom,r.rounding.replace('_',' '),r.state.replace('_',' '),<div key="a" className="action-row">{['draft','pending_approval'].includes(r.state)&&act(r,'Approve','approve',{decision:'approve',contentVersion:r.contentVersion},'tax_rule.approve')}{r.state==='approved'&&can('tax_rule.activate')&&<Editor id={'activate'+r.id} label="Activate" onSave={async d=>!!await cmd.run('POST','/tax-rules/'+r.id+'/activate',{entityId,ifMatch:r.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No tax rules yet.')}</>;
}
