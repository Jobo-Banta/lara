"use client";
// P05 purchasing screens: supplier bills (source review, draft editor, the
// four statuses, approval with the duplicate disposition, supplier credit
// preview), purchase orders with the two-way match, expense claims against
// employee advances, payment proposals with the payable allocation workbench
// and payment orders through authority, manual release and settlement with
// evidence, and supplier open items with aging. Totals shown while editing
// are a preview; the server computes and records the amounts on save.
import {useEffect,useMemo,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,uuid,type Row,type ApiError} from './workspace-kit';
import {useBookId} from './workspace-ledger';

const money=(v:string|number|null|undefined)=>v==null?'—':new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(v));
const today=()=>new Date().toISOString().slice(0,10);
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
const kindLabel:Record<string,string>={bill:'Bill',credit_note:'Supplier credit',purchase_order:'Purchase order',expense_claim:'Expense claim'};
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Purchasing not enabled</h2><p>The purchasing capability is activated per entity after sales, with an approved purchasing profile (payables, input tax, withholding timing, PO policy). {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}
const Statuses=({d}:{d:Row})=><dl className="status-grid" aria-label="Document statuses"><div><dt>Document</dt><dd>{d.state.replace('_',' ')}</dd></div><div><dt>Delivery</dt><dd>{d.deliveryState.replace('_',' ')}</dd></div><div><dt>Reporting</dt><dd>{d.reportingState.replace('_',' ')}</dd></div><div><dt>Settlement</dt><dd>{d.settlementState.replace('_',' ')}</dd></div></dl>;
const previewTax=(lines:Row[],rules:Row[])=>{let net=0,tax=0;for(const l of lines){const q=Number(l.quantity||0),p=Number(l.unitPrice||0),d=Number(l.discount||0),rate=Number(rules.find(r=>r.id===l.taxCodeId)?.rate||0);const base=Math.round((q*p-d)*100)/100;if(l.priceBasis==='inclusive'){const n=Math.round(base/(1+rate)*100)/100;net+=n;tax+=base-n;}else{net+=base;tax+=Math.round(base*rate*100)/100;}}return {net,tax,gross:net+tax};};
function usePurchasingRefs(entityId:string,tick:number){
 const suppliers=useList('/parties',entityId,tick,{role:'supplier',status:'active'});
 const employees=useList('/parties',entityId,tick,{role:'employee',status:'active'});
 const accounts=useList('/accounts',entityId,tick);
 const rules=useList('/tax-rules',entityId,tick);
 const branches=useList('/branches',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 return {suppliers:suppliers.items||[],employees:employees.items||[],accounts:accounts.items||[],rules:(rules.items||[]).filter((r:Row)=>r.state==='active'&&r.taxType!=='withholding'),branches:branches.items||[],evidence:evidence.items||[]};
}
const partyName=(refs:Row,id:string)=>[...refs.suppliers,...refs.employees].find((p:Row)=>p.id===id)?.legalName||id.slice(0,8);

// ---------------------------------------------------------------------------
// Document editor (bills, purchase orders, expense claims)
// ---------------------------------------------------------------------------
function DocumentEditor({entityId,bookId,kind,refs,orders,initial,onSave,label}:{entityId:string,bookId:string,kind:string,refs:Row,orders:Row[],initial?:Row,onSave:(body:Row)=>Promise<boolean>,label:string}){
 const blank=()=>({description:'',quantity:'1',unitPrice:'',discount:'0',priceBasis:'exclusive',accountId:'',taxCodeId:''});
 const [lines,setLines]=useState<Row[]>(initial?.lines?.map((l:Row)=>({...l,taxCodeId:l.taxCodeId||'',discount:l.discount||'0'}))||[blank()]);
 const update=(i:number,k:string,v:string)=>setLines(ls=>ls.map((l,j)=>j===i?{...l,[k]:v}:l));
 const preview=useMemo(()=>previewTax(lines,refs.rules),[lines,refs.rules]);
 const expense=refs.accounts.filter((a:Row)=>a.state==='active'&&a.controlType==='none'&&['expense','asset'].includes(a.category));
 const parties=kind==='expense_claim'?refs.employees:refs.suppliers;
 return <Editor id={'pdoc'+(initial?.id||'new')+kind+entityId+(initial?.version||0)} label={label} onSave={async d=>onSave({kind,branchId:d.branchId,bookId,partyId:d.partyId,documentDate:d.documentDate,accountingDate:d.accountingDate,currency:'PHP',ruleProfileVersion:d.ruleProfileVersion,...(d.externalReference?{externalReference:d.externalReference}:{}),...(initial?.sourceDocumentId?{sourceDocumentId:initial.sourceDocumentId}:d.sourceDocumentId?{sourceDocumentId:d.sourceDocumentId}:{}),lines:lines.map(l=>({description:l.description,quantity:l.quantity,unitPrice:l.unitPrice,discount:l.discount||'0',priceBasis:l.priceBasis,accountId:l.accountId,...(l.taxCodeId?{taxCodeId:l.taxCodeId}:{}),dimensions:{}})),evidenceIds:d.evidenceId?[d.evidenceId]:(initial?.evidenceIds||[])})}>
  <label>{kind==='expense_claim'?'Employee':'Supplier'}<select name="partyId" defaultValue={initial?.partyId||''} required disabled={!!initial}><option value="">Select {kind==='expense_claim'?'employee':'supplier'}</option>{parties.map((c:Row)=><option key={c.id} value={c.id}>{c.legalName}</option>)}</select></label>
  <label>Branch<select name="branchId" defaultValue={initial?.branchId||refs.branches[0]?.id||''} required>{refs.branches.map((b:Row)=><option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select></label>
  {input('Document date','documentDate',initial?.documentDate||today(),'date',{required:true})}{input('Accounting date','accountingDate',initial?.accountingDate||today(),'date',{required:true})}
  {input('Tax profile version','ruleProfileVersion',initial?.ruleProfileVersion||'ph-2026','text',{required:true})}
  {kind==='bill'?input('Supplier invoice reference','externalReference',initial?.externalReference||'','text',{required:true,maxLength:500}):input('Reference (optional)','externalReference',initial?.externalReference||'','text',{maxLength:500})}
  {kind==='bill'&&!initial&&<label>Purchase order (optional)<select name="sourceDocumentId" defaultValue=""><option value="">Non-PO bill</option>{orders.map(o=><option key={o.id} value={o.id}>{o.documentDate} · {partyName(refs,o.partyId)} · {money(o.net)}</option>)}</select></label>}
  {kind!=='purchase_order'&&<label>Source evidence{initial?' (replace)':''}<select name="evidenceId" required={!initial}><option value="">{initial?'Keep current evidence':'Select the scanned document'}</option>{refs.evidence.map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>}
  <div className="table-scroll" tabIndex={0} role="region" aria-label="Document lines"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Discount</th><th>Basis</th><th>Expense account</th><th>Tax</th><th></th></tr></thead><tbody>{lines.map((l,i)=><tr key={i}>
   <td><input aria-label={'Line '+(i+1)+' description'} value={l.description} onChange={e=>update(i,'description',e.target.value)} required maxLength={500}/></td>
   <td><input aria-label={'Line '+(i+1)+' quantity'} inputMode="decimal" value={l.quantity} onChange={e=>update(i,'quantity',e.target.value)} required/></td>
   <td><input aria-label={'Line '+(i+1)+' unit price'} inputMode="decimal" value={l.unitPrice} onChange={e=>update(i,'unitPrice',e.target.value)} required placeholder="0.00"/></td>
   <td><input aria-label={'Line '+(i+1)+' discount'} inputMode="decimal" value={l.discount} onChange={e=>update(i,'discount',e.target.value)}/></td>
   <td><select aria-label={'Line '+(i+1)+' price basis'} value={l.priceBasis} onChange={e=>update(i,'priceBasis',e.target.value)}><option value="exclusive">Tax exclusive</option><option value="inclusive">Tax inclusive</option></select></td>
   <td><select aria-label={'Line '+(i+1)+' expense account'} value={l.accountId} onChange={e=>update(i,'accountId',e.target.value)} required><option value="">Select account</option>{expense.map((a:Row)=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td>
   <td><select aria-label={'Line '+(i+1)+' tax rule'} value={l.taxCodeId} onChange={e=>update(i,'taxCodeId',e.target.value)}><option value="">No tax</option>{refs.rules.map((r:Row)=><option key={r.id} value={r.id}>{r.code} {Number(r.rate)*100}%</option>)}</select></td>
   <td>{lines.length>1&&<button type="button" aria-label={'Remove line '+(i+1)} onClick={()=>setLines(ls=>ls.filter((_,j)=>j!==i))}>×</button>}</td></tr>)}</tbody></table></div>
  <div className="action-row"><button type="button" onClick={()=>setLines(ls=>[...ls,blank()])}>Add line</button></div>
  <p role="status" aria-live="polite">Preview: net {money(preview.net)} · tax {money(preview.tax)} · gross {money(preview.gross)} · the server computes the amounts and any supplier withholding on save.</p>
 </Editor>;
}
// Approval with the reviewer's disposition: a bill flagged as a possible
// duplicate needs a reason; the server refuses approval without one.
function Approve({path,d,cmd,entityId,permission,can}:{path:string,d:Row,cmd:ReturnType<typeof useCommand>,entityId:string,permission:string,can:(p:string)=>boolean}){
 if(d.state!=='submitted'||!can(permission))return null;
 return <><Editor id={'approve'+d.id+d.version} label="Approve" onSave={async x=>!!await cmd.run('POST',path+'/'+d.id+'/approve',{entityId,ifMatch:d.version,body:{decision:'approve',contentVersion:d.contentVersion,...(x.reason?{reason:x.reason}:{})}})}>{input('Disposition (required for possible duplicates)','reason','','text',{maxLength:500})}</Editor>
  <Editor id={'reject'+d.id+d.version} label="Request changes" onSave={async x=>!!await cmd.run('POST',path+'/'+d.id+'/approve',{entityId,ifMatch:d.version,body:{decision:'reject',contentVersion:d.contentVersion,reason:x.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor></>;
}

// ---------------------------------------------------------------------------
// Bills and supplier credits
// ---------------------------------------------------------------------------
export function PurchasingBills({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('purchasing'))return <NotEnabled me={me}/>;
 const [state,setState]=useState('');
 const list=useList('/bills',entityId,tick,{state});
 const orders=useList('/purchase-orders',entityId,tick,{state:'approved'});
 const refs=usePurchasingRefs(entityId,tick);
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 return <>{can('bill.prepare')&&bookId&&<><h2>New bill</h2><p>Record the supplier invoice from its scanned source. The supplier reference is checked for duplicates (case, spacing and punctuation ignored); a PO-linked bill is matched against the ordered amount.</p><DocumentEditor entityId={entityId} bookId={bookId} kind="bill" refs={refs} orders={orders.items||[]} label="Save draft" onSave={async body=>{const r=await cmd.run('POST','/bills',{entityId,body});if(r)window.location.assign('/purchases/bills/'+r.data.id);return !!r;}}/></>}
  <h2>Bills and supplier credits</h2>
  <div className="filter-row"><label>State<select value={state} onChange={e=>setState(e.target.value)}><option value="">All</option>{['draft','submitted','changes_requested','approved','posted','cancelled'].map(s=><option key={s} value={s}>{s.replace('_',' ')}</option>)}</select></label></div>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['Reference','Kind','Supplier','Date','Gross','Document','Settlement'],list.items.map(d=>[link('/purchases/bills/'+d.id,d.externalReference||d.officialNumber||'Draft '+d.id.slice(0,8)),kindLabel[d.kind],partyName(refs,d.partyId),d.documentDate,money(d.gross),d.state.replace('_',' '),d.settlementState.replace('_',' ')]),'No bills yet.')}</>;
}
export function PurchasingBillDetail({entityId,id,me,can,tick,refresh}:Ctx&{id:string}){
 const [d,setD]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null),[items,setItems]=useState<Row[]>([]),[tasks,setTasks]=useState<Row[]>([]);
 useEffect(()=>{api('GET','/bills/'+id,{entityId}).then(r=>{setD(r.data);setError(null);}).catch(e=>setError(asError(e)));},[id,entityId,tick]);
 useEffect(()=>{if(!d)return;api('GET','/open-items?side=AP&partyId='+d.partyId,{entityId}).then(r=>setItems(r.data.items)).catch(()=>setItems([]));api('GET','/tasks?sourceId='+id,{entityId}).then(r=>setTasks(r.data.items.filter((t:Row)=>t.kind==='duplicate_review'))).catch(()=>setTasks([]));},[d?.partyId,tick]);
 const refs=usePurchasingRefs(entityId,tick);
 const cmd=useCommand(refresh);
 if(error)return <ErrorPanel error={error} onReload={refresh}/>;
 if(!d)return <Loading/>;
 const editable=['draft','changes_requested'].includes(d.state);
 const act=(label:string,path:string,body:Row,permission:string)=>can(permission)?<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/bills/'+id+'/'+path,{entityId,ifMatch:d.version,body})}>{label}</button>:null;
 const item=items.find(i=>i.documentId===id);
 return <>
  <section className="demo-card"><h2>{kindLabel[d.kind]} {d.externalReference||d.officialNumber||'(draft)'}</h2><p>{partyName(refs,d.partyId)} · {d.documentDate} · accounting {d.accountingDate}{d.officialNumber?' · '+d.officialNumber:''}{d.sourceDocumentId&&<> · from {link(d.kind==='credit_note'?'/purchases/bills/'+d.sourceDocumentId:'/purchases/orders','linked document')}</>}</p>
   <Statuses d={d}/>
   <p>Net {money(d.net)} · Tax {money(d.tax)} · <strong>Gross {money(d.gross)}</strong>{item&&<> · Payable {money(item.originalAmount)} (net of accrued withholding) · outstanding {money(item.outstandingAmount)}, due {item.dueDate}</>}</p>
   {tasks.map(t=><p key={t.id} role="alert" className="notice">Possible duplicate: {t.reason} {t.state==='resolved'?'· resolved':'· approval records the disposition'}</p>)}
   <div className="action-row">{editable&&act('Submit for approval','submit',{},'bill.submit')}{d.state==='approved'&&act(d.kind==='credit_note'?'Post supplier credit':'Post bill','post',{},'bill.post')}</div>
   <Approve path="/bills" d={d} cmd={cmd} entityId={entityId} permission="bill.approve" can={can}/>
   <ErrorPanel error={cmd.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
   {d.state==='posted'&&<p>Posted documents are immutable; corrections are new linked documents.</p>}
  </section>
  {table(['#','Description','Qty','Unit price','Discount','Basis','Account','Tax rule'],d.lines.map((l:Row,i:number)=>[i+1,l.description,l.quantity,money(l.unitPrice),money(l.discount),l.priceBasis,refs.accounts.find((a:Row)=>a.id===l.accountId)?.code||'—',refs.rules.find((r:Row)=>r.id===l.taxCodeId)?.code||(l.taxCodeId?'inactive rule':'none')]),'No lines.')}
  <section className="demo-card"><h2>Timeline</h2><ol className="timeline"><li>Created {when(d.createdAt)} · content version {d.contentVersion}</li>{d.evidenceIds.length>0&&<li>Evidence {d.evidenceIds.map((e:string)=><span key={e}>{link('/evidence/'+e,'source '+e.slice(0,8))} </span>)}</li>}{d.state!=='draft'&&<li>{d.state==='cancelled'?'Cancelled':'Submitted for approval'}</li>}{['approved','posted'].includes(d.state)&&<li>Approved (bound to content version {d.contentVersion})</li>}{d.state==='posted'&&<li>Posted{d.officialNumber?' as '+d.officialNumber:''} · journal entry posted</li>}{d.settlementState!=='unpaid'&&<li>Settlement {d.settlementState.replace('_',' ')}</li>}<li>Last change {when(d.updatedAt)} · version {d.version}</li></ol></section>
  {editable&&can('bill.edit')&&<><h2>Edit draft</h2><DocumentEditor entityId={entityId} bookId={d.bookId} kind={d.kind} refs={refs} orders={[]} initial={d} label="Save changes" onSave={async body=>!!await cmd.run('PATCH','/bills/'+id,{entityId,ifMatch:d.version,body})}/></>}
  {d.state==='posted'&&d.kind==='bill'&&can('bill.correct')&&<CreditPreview entityId={entityId} d={d} refs={refs} cmd={cmd}/>}
 </>;
}
function CreditPreview({entityId,d,refs,cmd}:{entityId:string,d:Row,refs:Row,cmd:ReturnType<typeof useCommand>}){
 const [credits,setCredits]=useState<Row[]|null>(null);
 useEffect(()=>{api('GET','/bills?state=posted',{entityId}).then(r=>setCredits(r.data.items.filter((x:Row)=>x.kind==='credit_note'&&x.sourceDocumentId===d.id))).catch(()=>setCredits([]));},[d.id,entityId]);
 const [amounts,setAmounts]=useState<Record<string,string>>({});
 const remaining=useMemo(()=>{const m:Record<string,number>={};for(const l of d.lines){const q=Number(l.quantity),p=Number(l.unitPrice),disc=Number(l.discount||0);const base=Math.round((q*p-disc)*100)/100;const rate=Number(refs.rules.find((r:Row)=>r.id===l.taxCodeId)?.rate||0);const net=l.priceBasis==='inclusive'?Math.round(base/(1+rate)*100)/100:base;m[l.accountId]=(m[l.accountId]||0)+net;}for(const c of credits||[])for(const l of c.lines)m[l.accountId]=(m[l.accountId]||0)-Number(l.unitPrice)*Number(l.quantity);return m;},[d,credits,refs.rules]);
 const [kind,setKind]=useState('credit_note');
 const lines=Object.entries(amounts).filter(([,v])=>Number(v)>0).map(([accountId,v])=>{const src=d.lines.find((l:Row)=>l.accountId===accountId);return {description:'Credit: '+(src?.description||''),quantity:'1',unitPrice:v,discount:'0',priceBasis:'exclusive',accountId,...(src?.taxCodeId?{taxCodeId:src.taxCodeId}:{}),dimensions:{}};});
 const over=Object.entries(amounts).some(([a,v])=>Number(v)>(remaining[a]??0)+1e-9);
 return <section className="demo-card"><h2>Correct this bill</h2><p>A supplier credit reduces the payable through a linked document that travels through review. Eligible amounts are what remains after earlier credits.</p>
  {credits===null?<Loading/>:table(['Expense account','Original net','Remaining creditable','Credit net'],Object.entries(remaining).map(([accountId,left])=>[refs.accounts.find((a:Row)=>a.id===accountId)?.code||accountId.slice(0,8),money(d.lines.filter((l:Row)=>l.accountId===accountId).reduce((s:number,l:Row)=>s+Number(l.unitPrice)*Number(l.quantity)-Number(l.discount||0),0)),money(left),<input key={accountId} aria-label={'Credit for '+(refs.accounts.find((a:Row)=>a.id===accountId)?.code||accountId)} inputMode="decimal" value={amounts[accountId]||''} onChange={e=>setAmounts(m=>({...m,[accountId]:e.target.value}))} placeholder="0.00"/>]),'No expense lines.')}
  <Editor id={'correctbill'+d.id} label={kind==='reversal'?'Prepare full reversal':'Prepare supplier credit'} disabled={kind!=='reversal'&&(!lines.length||over)} onSave={async x=>{const body:Row={kind,accountingDate:x.accountingDate,reason:x.reason,evidenceIds:x.evidenceId?[x.evidenceId]:[],lines:kind==='reversal'?d.lines.map((l:Row)=>({description:l.description,quantity:l.quantity,unitPrice:l.unitPrice,discount:l.discount||'0',priceBasis:l.priceBasis,accountId:l.accountId,...(l.taxCodeId?{taxCodeId:l.taxCodeId}:{}),dimensions:{}})):lines};const r=await cmd.run('POST','/bills/'+d.id+'/correct',{entityId,ifMatch:d.version,body});if(r)window.location.assign('/purchases/bills/'+r.data.resourceId);return !!r;}}>
   <label>Correction<select name="kind" value={kind} onChange={e=>setKind(e.target.value)}><option value="credit_note">Partial supplier credit</option><option value="reversal">Full reversal (credit everything)</option></select></label>{input('Accounting date','accountingDate',today(),'date',{required:true})}{input('Reason','reason','','text',{required:true})}<label>Supplier credit evidence<select name="evidenceId" required><option value="">Select the scanned credit note</option>{refs.evidence.map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
   <p role="status">{over?'A credit exceeds the remaining eligible amount.':kind==='reversal'?'Credits the full '+money(d.gross)+'.':lines.length?'Credit net '+money(lines.reduce((s,l)=>s+Number(l.unitPrice),0))+' before tax.':'Enter credit amounts above.'}</p>
  </Editor></section>;
}

// ---------------------------------------------------------------------------
// Purchase orders with the two-way match
// ---------------------------------------------------------------------------
export function PurchasingOrders({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('purchasing'))return <NotEnabled me={me}/>;
 const list=useList('/purchase-orders',entityId,tick);
 const bills=useList('/bills',entityId,tick);
 const refs=usePurchasingRefs(entityId,tick);
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 const invoiced=(o:Row)=>(bills.items||[]).filter(b=>b.kind==='bill'&&b.sourceDocumentId===o.id&&b.state!=='cancelled').reduce((s,b)=>s+Number(b.net),0);
 const act=(o:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void cmd.run('POST','/purchase-orders/'+o.id+'/'+path,{entityId,ifMatch:o.version,body})}>{label}</button>:null;
 return <>{can('purchase_order.create')&&bookId&&<><h2>New purchase order</h2><DocumentEditor entityId={entityId} bookId={bookId} kind="purchase_order" refs={refs} orders={[]} label="Save draft" onSave={async body=>!!await cmd.run('POST','/purchase-orders',{entityId,body})}/></>}
  <h2>Purchase orders</h2><p>Approved orders are billed against their ordered net; the two-way match refuses bills beyond it, and receipts of service gate PO bills where the policy requires them. Utility and other non-PO bills need no dummy order.</p>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['Supplier','Date','Ordered net','Billed net','Difference','State','Actions'],list.items.map(o=>[partyName(refs,o.partyId),o.documentDate,money(o.net),money(invoiced(o)),money(Number(o.net)-invoiced(o)),o.state.replace('_',' '),<div key="a" className="action-row">{['draft','changes_requested'].includes(o.state)&&act(o,'Submit','submit',{},'purchase_order.submit')}<Approve path="/purchase-orders" d={o} cmd={cmd} entityId={entityId} permission="purchase_order.approve" can={can}/>{['draft','submitted','approved'].includes(o.state)&&can('purchase_order.cancel')&&<Editor id={'cancelpo'+o.id} label="Cancel order" onSave={async x=>!!await cmd.run('POST','/purchase-orders/'+o.id+'/cancel',{entityId,ifMatch:o.version,body:{reason:x.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No purchase orders yet.')}</>;
}

// ---------------------------------------------------------------------------
// Expense claims and advances
// ---------------------------------------------------------------------------
export function PurchasingClaims({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('purchasing'))return <NotEnabled me={me}/>;
 const list=useList('/expense-claims',entityId,tick);
 const refs=usePurchasingRefs(entityId,tick);
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 const act=(c:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void cmd.run('POST','/expense-claims/'+c.id+'/'+path,{entityId,ifMatch:c.version,body})}>{label}</button>:null;
 return <>{can('expense_claim.prepare')&&bookId&&<><h2>New expense claim</h2><p>Claims liquidate the employee's oldest open advance when they post; any excess opens a payable to the employee, and an unused remainder is returned as a receipt.</p><DocumentEditor entityId={entityId} bookId={bookId} kind="expense_claim" refs={refs} orders={[]} label="Save draft" onSave={async body=>!!await cmd.run('POST','/expense-claims',{entityId,body})}/></>}
  <h2>Expense claims</h2>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null?<Loading/>:table(['Employee','Date','Gross','Document','Settlement','Actions'],list.items.map(c=>[partyName(refs,c.partyId),c.documentDate,money(c.gross),c.state.replace('_',' '),c.settlementState.replace('_',' '),<div key="a" className="action-row">{['draft','changes_requested'].includes(c.state)&&act(c,'Submit','submit',{},'expense_claim.submit')}<Approve path="/expense-claims" d={c} cmd={cmd} entityId={entityId} permission="expense_claim.approve" can={can}/>{c.state==='approved'&&act(c,'Post claim','post',{},'expense_claim.post')}</div>]),'No expense claims yet.')}</>;
}

// ---------------------------------------------------------------------------
// Payments: proposals, authority, release and settlement evidence
// ---------------------------------------------------------------------------
function AllocationWorkbench({items,amounts,setAmounts,max}:{items:Row[],amounts:Record<string,string>,setAmounts:(f:(m:Record<string,string>)=>Record<string,string>)=>void,max:number}){
 const total=Object.values(amounts).reduce((s,v)=>s+Number(v||0),0);
 return <><div className="table-scroll" tabIndex={0} role="region" aria-label="Payables to settle"><table><thead><tr><th>Document</th><th>Due</th><th>Payable</th><th>Outstanding</th><th>Pay</th></tr></thead><tbody>{items.map(i=><tr key={i.id}><td>{link('/purchases/bills/'+i.documentId,'Open document')}</td><td>{i.dueDate}</td><td>{money(i.originalAmount)}</td><td>{money(i.outstandingAmount)}</td><td><input aria-label={'Pay item due '+i.dueDate} inputMode="decimal" value={amounts[i.id]||''} onChange={e=>setAmounts(m=>({...m,[i.id]:e.target.value}))} placeholder="0.00"/> <button type="button" onClick={()=>setAmounts(m=>({...m,[i.id]:i.outstandingAmount}))}>Full</button></td></tr>)}</tbody></table>{!items.length&&<p>No open payables for this party; a payment to an employee without allocations is an advance.</p>}</div>
  <p role="status" aria-live="polite">Allocated {money(total)} of {money(max)}{total>max+1e-9?' · exceeds the payment':total<max-1e-9&&items.length?' · supplier payments allocate the full amount':' · ready'}</p></>;
}
export function PurchasingPayments({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('purchasing'))return <NotEnabled me={me}/>;
 const proposals=useList('/settlements',entityId,tick);
 const refs=usePurchasingRefs(entityId,tick);
 const cmd=useCommand(refresh);
 const [partyId,setPartyId]=useState(''),[amounts,setAmounts]=useState<Record<string,string>>({}),[gross,setGross]=useState('');
 const open=useList('/open-items',partyId?entityId:null,tick,{partyId,side:'AP',open:'true'});
 return <>{can('settlements.create')&&<><h2>New payment proposal</h2><p>A proposal settles open payables (or issues an employee advance). Gross equals cash plus withholding recognized at payment; the server states the withholding the allocated bills carry. Nothing moves money: authority, release and settlement are recorded separately with evidence.</p>
  <Editor id={'proposal-new'+entityId} label="Save proposal" resetOnSave onSave={async d=>{const allocations=Object.entries(amounts).filter(([,v])=>Number(v)>0).map(([openItemId,amount])=>({openItemId,amount}));const r=await cmd.run('POST','/settlements',{entityId,body:{direction:'payment',partyId:d.partyId,currency:'PHP',valueDate:d.valueDate,grossAmount:d.grossAmount,cashAmount:d.cashAmount,withholdingAmount:d.withholdingAmount||'0',method:d.method,allocations,evidenceIds:[]}});if(r){setAmounts({});window.location.assign('/payments/'+r.data.id);}return !!r;}}>
   <label>Payee<select name="partyId" value={partyId} onChange={e=>{setPartyId(e.target.value);setAmounts({});}} required><option value="">Select supplier or employee</option>{refs.suppliers.map((c:Row)=><option key={c.id} value={c.id}>{c.legalName}</option>)}{refs.employees.map((c:Row)=><option key={c.id} value={c.id}>{c.legalName} (employee)</option>)}</select></label>
   {input('Value date','valueDate',today(),'date',{required:true})}<label>Gross payment<input name="grossAmount" inputMode="decimal" value={gross} onChange={e=>setGross(e.target.value)} required placeholder="0.00"/></label>{input('Cash amount','cashAmount','','text',{required:true,inputMode:'decimal',placeholder:'0.00'})}{input('Withholding at payment','withholdingAmount','0','text',{inputMode:'decimal'})}{select('Method','method',[['transfer','Bank transfer'],['check','Check'],['cash','Cash'],['wallet','E-wallet']],'transfer')}
   {partyId&&(open.items===null?<Loading/>:<AllocationWorkbench items={open.items} amounts={amounts} setAmounts={setAmounts} max={Number(gross||0)}/>)}
  </Editor></>}
  <h2>Payment proposals</h2>
  <ErrorPanel error={cmd.error||proposals.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {proposals.items===null?<Loading/>:table(['Value date','Payee','Gross','Cash','Withholding','Allocated','State'],proposals.items.map(s=>[link('/payments/'+s.id,s.valueDate),partyName(refs,s.partyId),money(s.grossAmount),money(s.cashAmount),money(s.withholdingAmount),money(s.allocations.reduce((t:number,a:Row)=>t+Number(a.amount),0)),s.state]),'No payment proposals yet.')}</>;
}
export function PurchasingPaymentDetail({entityId,id,me,can,tick,refresh}:Ctx&{id:string}){
 const [s,setS]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null),[orders,setOrders]=useState<Row[]|null>(null);
 useEffect(()=>{api('GET','/settlements/'+id,{entityId}).then(r=>{setS(r.data);setError(null);}).catch(e=>setError(asError(e)));api('GET','/payments?settlementId='+id,{entityId}).then(r=>setOrders(r.data.items)).catch(()=>setOrders([]));},[id,entityId,tick]);
 const refs=usePurchasingRefs(entityId,tick);
 const cmd=useCommand(refresh);
 if(error)return <ErrorPanel error={error} onReload={refresh}/>;
 if(!s)return <Loading/>;
 const order=(orders||[]).find(o=>!['cancelled','failed'].includes(o.state))||null;
 const sact=(label:string,path:string,body:Row,permission:string)=>can(permission)?<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/settlements/'+id+'/'+path,{entityId,ifMatch:s.version,body})}>{label}</button>:null;
 const pact=(o:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/payments/'+o.id+'/'+path,{entityId,ifMatch:o.version,body})}>{label}</button>:null;
 const evidenceSelect=<label>Evidence<select name="evidenceId" required><option value="">Select the bank confirmation</option>{refs.evidence.map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>;
 return <>
  <section className="demo-card"><h2>Payment proposal {s.valueDate} · {partyName(refs,s.partyId)}</h2><p>State {s.state} · gross {money(s.grossAmount)} = cash {money(s.cashAmount)} + withholding {money(s.withholdingAmount)} · method {s.method}</p>
   {table(['Open item','Amount'],s.allocations.map((a:Row)=>[a.openItemId.slice(0,8),money(a.amount)]),'No allocations: an employee advance.')}
   <div className="action-row">{s.state==='draft'&&sact('Submit proposal','submit',{},'settlements.submit')}</div>
   <ErrorPanel error={cmd.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/></section>
  <section className="demo-card"><h2>Payment authority and release</h2>
   {orders===null?<Loading/>:!order?<>{['draft','submitted'].includes(s.state)&&can('payment.create')?<Editor id={'order-new'+id} label="Create payment order" onSave={async d=>!!await cmd.run('POST','/payments',{entityId,body:{settlementId:id,beneficiaryVersionId:d.beneficiaryVersionId,scheduledDate:d.scheduledDate,...(d.reason?{reason:d.reason}:{})}})}><p>The beneficiary version is the reviewed payee bank record approved for this party (its identifier is issued by the treasury review; there is no screen for it in this release).</p>{input('Approved beneficiary version id','beneficiaryVersionId','','text',{required:true,pattern:'[0-9a-fA-F-]{36}'})}{input('Scheduled date','scheduledDate',today(),'date',{required:true})}{input('Reason (optional)','reason','','text')}</Editor>:<p>No payment order yet.</p>}</>:<>
    <p>Payment {order.state.replace('_',' ')} · scheduled {order.scheduledDate} · beneficiary version {order.beneficiaryVersionId.slice(0,8)} · content version {order.contentVersion}{order.reason?' · '+order.reason:''}</p>
    <ol className="timeline"><li>Proposal {s.state}</li><li>{['submitted','authorized','released','settled','returned'].includes(order.state)?'Submitted for authority':'Awaiting submission'}</li><li>{['authorized','released','settled','returned'].includes(order.state)?'Authorized (bound to the proposal and beneficiary)':'Awaiting independent authority'}</li><li>{['released','settled','returned'].includes(order.state)?'Released manually with evidence':'Not released'}</li><li>{['settled','returned'].includes(order.state)?'Settled with bank evidence · journal posted':'Not settled'}</li>{order.state==='returned'&&<li>Returned · mirrored entry posted</li>}</ol>
    <div className="action-row">{order.state==='draft'&&s.state==='submitted'&&pact(order,'Submit for authority','submit',{},'payment.submit')}{order.state==='submitted'&&pact(order,'Authorize payment','authorize',{decision:'approve',contentVersion:order.contentVersion},'payment.authorize')}</div>
    {order.state==='authorized'&&can('payment.release')&&<Editor id={'release'+order.id} label="Record manual release" onSave={async d=>!!await cmd.run('POST','/payments/'+order.id+'/release',{entityId,ifMatch:order.version,body:{channel:'manual',externalReference:d.externalReference,evidenceIds:[d.evidenceId]}})}>{input('Bank transaction reference','externalReference','','text',{required:true})}{evidenceSelect}</Editor>}
    {order.state==='released'&&can('payment.settle')&&<Editor id={'settle'+order.id} label="Record settlement" onSave={async d=>!!await cmd.run('POST','/payments/'+order.id+'/settle',{entityId,ifMatch:order.version,body:{externalReference:d.externalReference,settledAt:new Date(d.valueDate+'T00:00:00Z').toISOString(),valueDate:d.valueDate,evidenceIds:[d.evidenceId]}})}>{input('Bank settlement reference','externalReference','','text',{required:true})}{input('Value date','valueDate',today(),'date',{required:true})}{evidenceSelect}</Editor>}
    {order.state==='settled'&&can('payment.return')&&<Editor id={'return'+order.id} label="Record bank return" onSave={async d=>!!await cmd.run('POST','/payments/'+order.id+'/return',{entityId,ifMatch:order.version,body:{accountingDate:d.accountingDate,reason:d.reason}})}>{input('Return date','accountingDate',today(),'date',{required:true})}{input('Reason','reason','','text',{required:true})}</Editor>}
   </>}
  </section>
 </>;
}

// ---------------------------------------------------------------------------
// Suppliers: open payables and aging
// ---------------------------------------------------------------------------
export function PurchasingSuppliers({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('purchasing'))return <NotEnabled me={me}/>;
 const [partyId,setPartyId]=useState('');
 const refs=usePurchasingRefs(entityId,tick);
 const items=useList('/open-items',entityId,tick,partyId?{partyId,side:'AP'}:{side:'AP',open:'true'});
 const {bookId}=useBookId(entityId,tick,me);
 const [job,setJob]=useState<Row|null>(null),[report,setReport]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null);
 useEffect(()=>{if(!job||!['queued','running','retry_wait'].includes(job.state))return;const t=setTimeout(()=>api('GET','/jobs/'+job.id,{entityId}).then(r=>setJob(r.data)).catch(e=>setError(asError(e))),1500);return()=>clearTimeout(t);},[job]);
 useEffect(()=>{if(job?.state==='succeeded'&&job.resultResourceId&&!report){fetch('/api/v1/evidence/'+job.resultResourceId+'/content',{headers:{'x-entity-id':entityId}}).then(async r=>{if(!r.ok)throw await r.json();setReport(await r.json());}).catch(e=>setError(asError(e)));}},[job]);
 const byParty=useMemo(()=>{const m=new Map<string,{outstanding:number,count:number}>();for(const i of items.items||[]){const c=m.get(i.partyId)||{outstanding:0,count:0};c.outstanding+=Number(i.outstandingAmount);c.count++;m.set(i.partyId,c);}return m;},[items.items]);
 return <>
  <div className="filter-row"><label>Payee<select value={partyId} onChange={e=>setPartyId(e.target.value)}><option value="">All payees</option>{[...refs.suppliers,...refs.employees].map((c:Row)=><option key={c.id} value={c.id}>{c.legalName}</option>)}</select></label></div>
  <ErrorPanel error={items.error||error} onReload={refresh}/>
  {!partyId&&<><h2>Payables by payee</h2>{items.items===null?<Loading/>:table(['Payee','Open items','Outstanding'],[...byParty.entries()].map(([pid,c])=>[<button key={pid} type="button" className="link" onClick={()=>setPartyId(pid)}>{partyName(refs,pid)}</button>,c.count,money(c.outstanding)]),'No payables.')}</>}
  {partyId&&<><h2>Statement · {partyName(refs,partyId)}</h2>{items.items===null?<Loading/>:table(['Document','Due','Payable','Allocated','Outstanding'],items.items.map(i=>[link('/purchases/bills/'+i.documentId,'Open document'),i.dueDate,money(i.originalAmount),money(i.allocatedAmount),money(i.outstandingAmount)]),'No open items for this payee.')}<p>Total outstanding {money((items.items||[]).reduce((s,i)=>s+Number(i.outstandingAmount),0))}</p></>}
  {can('report.generate')&&bookId&&<section className="demo-card"><h2>Supplier aging</h2><Editor id={'apaging'+entityId} label="Generate supplier aging" onSave={async d=>{setReport(null);setError(null);try{const r=await api('POST','/reports',{entityId,key:uuid(),body:{reportType:'ap_aging',bookId,periodStart:d.asOf.slice(0,8)+'01',periodEnd:d.asOf,asOf:new Date().toISOString(),format:'json'}});setJob(r.data);return true;}catch(e){setError(asError(e));return false;}}}>{input('As of','asOf',today(),'date',{required:true})}</Editor>
   {job&&<p role="status" aria-live="polite">Supplier aging job {job.state.replace('_',' ')}</p>}
   {report&&<>{table(['Payee','Current','1–30','31–60','61–90','Over 90','Total'],report.payload.parties.filter((p:Row)=>!partyId||p.partyId===partyId).map((p:Row)=>[p.legalName,money(p.buckets.current),money(p.buckets['1_30']),money(p.buckets['31_60']),money(p.buckets['61_90']),money(p.buckets.over_90),money(p.total)]),'Nothing payable as of '+report.payload.asOf)}<p>Total {money(report.payload.totals.total)} · snapshot version {report.versionNumber} · checksum {report.checksum.slice(0,12)}…</p></>}
  </section>}
 </>;
}
