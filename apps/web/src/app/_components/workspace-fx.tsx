"use client";
// P09 multiple currencies and separate books: rate import and review, the
// revaluation preview with differences per account before approval and a
// single posting, the book selector with partitions and activation, and the
// combined management view labelled with its basis and exclusions. A missing
// rate blocks on screen exactly as it does in the domain; nothing defaults to 1.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,type Row,type ApiError} from './workspace-kit';
import {useBookId} from './workspace-ledger';

export const amount=(v:string|number|null|undefined,currency='PHP')=>v==null?'—':new Intl.NumberFormat('en-PH',{style:'currency',currency}).format(Number(v));
const today=()=>new Date().toISOString().slice(0,10);
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Multi-currency not enabled</h2><p>The multi-currency capability is activated per entity after institution coexistence, with the controller's approval of the monetary account classification, FX sources, functional currencies and book boundaries recorded in the FX profile. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}

// Rate import and review: one base/quote pair per date, quoted in the
// functional currency per unit of the foreign currency, from source evidence.
export function FxRates({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('multi_currency'))return <NotEnabled me={me}/>;
 const rates=useList('/fx-rates',entityId,tick);
 const currencies=useList('/currencies',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const codes=(currencies.items||[]).map((c:Row)=>[c.code,c.code+' · '+c.name] as [string,string]);
 return <>
  <ErrorPanel error={cmd.error||rates.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('fx_rate.create')&&<section className="demo-card"><h2>Import a rate</h2><p>Quote the functional currency per one unit of the foreign currency (USD/PHP 56 means 1 USD = 56 PHP) with the source publication as evidence. An inverted pair or a value out of line with the recent approved rate is refused; approval is by another principal.</p><Editor id={'rate-new'+entityId} label="Save draft rate" resetOnSave onSave={async d=>!!await cmd.run('POST','/fx-rates',{entityId,body:{baseCurrency:d.baseCurrency,quoteCurrency:d.quoteCurrency,rateDate:d.rateDate,rate:d.rate,sourceEvidenceId:d.sourceEvidenceId}})}>
   {select('Foreign currency (base)','baseCurrency',codes.length?codes:[['USD','USD']],'USD')}{select('Functional currency (quote)','quoteCurrency',codes.length?codes:[['PHP','PHP']],'PHP')}
   {input('Rate date','rateDate',today(),'date',{required:true})}{input('Rate','rate','','text',{required:true,inputMode:'decimal',pattern:'[0-9]{1,12}(\\.[0-9]{1,12})?'})}
   <label>Source evidence<select name="sourceEvidenceId" required><option value="">Select evidence</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
  </Editor></section>}
  <h2>Rates</h2>
  {rates.items===null?<Loading/>:table(['Pair','Date','Rate','State','Actions'],rates.items.map(r=>[r.baseCurrency+'/'+r.quoteCurrency,r.rateDate,r.rate,r.state,<div key="a" className="action-row">{r.state==='draft'&&can('fx_rate.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/fx-rates/'+r.id+'/approve',{entityId,ifMatch:r.version,body:{decision:'approve',contentVersion:r.contentVersion}})}>Approve</button>}{r.state==='draft'&&can('fx_rate.approve')&&<Editor id={'rejr'+r.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/fx-rates/'+r.id+'/approve',{entityId,ifMatch:r.version,body:{decision:'reject',contentVersion:r.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No rates yet. Foreign-currency documents cannot post until an approved rate exists for their date.')}
 </>;
}

// Revaluation: monetary accounts at the period-end closing rate, previewed
// with the difference per account, approved independently, posted once.
export function FxRevaluations({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('multi_currency'))return <NotEnabled me={me}/>;
 const {bookId}=useBookId(entityId,tick,me);
 const runs=useList('/revaluations',entityId,tick);
 const periods=useList('/periods',entityId,tick);
 const rates=useList('/fx-rates',entityId,tick);
 const accounts=useList('/accounts',entityId,tick);
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [open,setOpen]=useState<string|null>(null),[preview,setPreview]=useState<Row|null>(null);
 useEffect(()=>{if(!open){setPreview(null);return;}api('GET','/revaluations/'+open+'/lines',{entityId}).then(r=>setPreview(r.data)).catch(e=>setError(asError(e)));},[open,tick]);
 const act=(r:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void cmd.run('POST','/revaluations/'+r.id+'/'+path,{entityId,ifMatch:r.version,body})}>{label}</button>:null;
 const periodOf=(id:string)=>(periods.items||[]).find(p=>p.id===id);
 const rateOf=(id:string)=>(rates.items||[]).find(r=>r.id===id);
 return <>
  <ErrorPanel error={error||cmd.error||runs.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('revaluation.create')&&bookId&&<section className="demo-card"><h2>New revaluation</h2><p>Revalues the selected monetary accounts' balances in the rate's foreign currency at the approved closing rate dated on the period end. Only accounts the controller classified as monetary in the FX profile are accepted; a second run for the same rate set is refused and a later rate set adjusts through a linked run.</p><Editor id={'reval-new'+entityId} label="Create run" resetOnSave onSave={async d=>{const accountIds=Object.entries(d).filter(([k,v])=>k.startsWith('acct:')&&v==='on').map(([k])=>k.slice(5));return !!await cmd.run('POST','/revaluations',{entityId,body:{bookId,periodId:d.periodId,rateSetId:d.rateSetId,accountIds,reverseNextPeriod:d.reverseNextPeriod==='on'}});}}>
   <label>Period<select name="periodId" required><option value="">Select period</option>{(periods.items||[]).filter(p=>p.bookId===bookId).map(p=><option key={p.id} value={p.id}>{p.startsOn} → {p.endsOn} ({p.state})</option>)}</select></label>
   <label>Closing rate set<select name="rateSetId" required><option value="">Select approved rate</option>{(rates.items||[]).filter(r=>r.state==='approved').map(r=><option key={r.id} value={r.id}>{r.baseCurrency}/{r.quoteCurrency} {r.rate} on {r.rateDate}</option>)}</select></label>
   <fieldset><legend>Monetary accounts</legend>{(accounts.items||[]).filter(a=>a.bookId===bookId&&['asset','liability'].includes(a.category)).map(a=><label key={a.id}><input type="checkbox" name={'acct:'+a.id}/> {a.code} {a.name}</label>)}</fieldset>
   <label><input type="checkbox" name="reverseNextPeriod"/> Reverse on the first day of the next period</label>
  </Editor></section>}
  <h2>Revaluation runs</h2>
  {runs.items===null?<Loading/>:table(['Period','Rate set','Accounts','Reverse','State','Actions'],runs.items.map(r=>{const p=periodOf(r.periodId),rt=rateOf(r.rateSetId);return [p?p.startsOn+' → '+p.endsOn:r.periodId.slice(0,8),rt?rt.baseCurrency+'/'+rt.quoteCurrency+' '+rt.rate:r.rateSetId.slice(0,8),r.accountIds.length,r.reverseNextPeriod?'yes':'no',r.state,<div key="a" className="action-row"><button type="button" onClick={()=>setOpen(open===r.id?null:r.id)}>{open===r.id?'Hide preview':'Preview'}</button>{['draft','previewed'].includes(r.state)&&act(r,'Compute preview','preview',{},'revaluation.preview')}{r.state==='previewed'&&act(r,'Approve','approve',{decision:'approve',contentVersion:r.contentVersion},'revaluation.approve')}{r.state==='previewed'&&can('revaluation.approve')&&<Editor id={'rejv'+r.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/revaluations/'+r.id+'/approve',{entityId,ifMatch:r.version,body:{decision:'reject',contentVersion:r.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}{r.state==='approved'&&act(r,'Post','post',{},'revaluation.post')}</div>];}),'No revaluation runs yet.')}
  {open&&<section className="demo-card"><h2>Preview</h2>{preview===null?<Loading/>:<>{preview.rate?<p>{preview.currency} at {preview.rate} ({preview.rateDate}) for balances to {preview.periodEnd}{preview.adjustsRunId?' · adjusts run '+preview.adjustsRunId.slice(0,8):''}</p>:<p>Not computed yet.</p>}{table(['Account','Balance ('+preview.currency+')','Carrying','Revalued','Difference'],preview.lines.map((l:Row)=>[l.accountCode+' '+l.accountName,amount(l.txnBalance,preview.currency),amount(l.carrying),amount(l.revalued),amount(l.difference)]),'Compute the preview to see the differences.')}<p role="status">Total difference {amount(preview.totalDifference)}{preview.entryId?' · posted entry '+preview.entryId.slice(0,8):''}{preview.reversalEntryId?' · reversal '+preview.reversalEntryId.slice(0,8):''}{preview.checksum?' · checksum '+preview.checksum.slice(0,12)+'…':''}</p></>}</section>}
 </>;
}

// Book selector and access: partitions with their currency and state,
// creation and activation, and the combined management view.
export function Books({entityId,me,can,tick,refresh}:Ctx){
 const books=useList('/books',entityId,tick);
 const currencies=useList('/currencies',entityId,tick);
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [viewId,setViewId]=useState(''),[asOf,setAsOf]=useState(today()),[combined,setCombined]=useState<Row|null>(null);
 useEffect(()=>{if(!viewId){setCombined(null);return;}setCombined(null);api('GET','/books/'+viewId+'/combined?asOf='+asOf,{entityId}).then(r=>{setCombined(r.data);setError(null);}).catch(e=>setError(asError(e)));},[viewId,asOf,tick]);
 const fxActive=me.capabilities.includes('multi_currency');
 const codes=(currencies.items||[]).map((c:Row)=>[c.code,c.code+' · '+c.name] as [string,string]);
 return <>
  <ErrorPanel error={error||cmd.error||books.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <h2>Books</h2>
  {books.items===null?<Loading/>:table(['Code','Kind','Currency','Source owner','State','Actions'],books.items.map(b=>[b.code,b.kind,b.functionalCurrency,b.sourceOwner,b.state,<div key="a" className="action-row">{b.state==='draft'&&can('book.activate')&&<Editor id={'act'+b.id} label="Activate" onSave={async d=>!!await cmd.run('POST','/books/'+b.id+'/activate',{entityId,ifMatch:b.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No books.')}
  {fxActive&&can('book.create')&&<section className="demo-card"><h2>New separate book</h2><p>RBU, FCDU and trust partitions keep their own postings, periods and access; a management view combines its linked source books without posting. A partition activates through a principal other than its creator and, once granted, is closed to everyone else. Trust and institutional books never mix postings.</p><Editor id={'book-new'+entityId} label="Create book" resetOnSave onSave={async d=>!!await cmd.run('POST','/books',{entityId,body:{code:d.code,kind:d.kind,functionalCurrency:d.functionalCurrency,sourceOwner:d.sourceOwner}})}>
   {input('Code','code','','text',{required:true,pattern:'[A-Za-z0-9][A-Za-z0-9-]{0,15}'})}{select('Kind','kind',[['rbu','RBU (regular banking unit)'],['fcdu','FCDU (foreign currency deposit unit)'],['trust','Trust'],['management','Management view']],'fcdu')}{select('Functional currency','functionalCurrency',codes.length?codes:[['PHP','PHP']],'PHP')}{input('Source owner','sourceOwner','lara','text',{required:true})}
  </Editor></section>}
  {fxActive&&<section className="demo-card"><h2>Combined management view</h2><div className="demo-form"><label>View<select value={viewId} onChange={e=>setViewId(e.target.value)}><option value="">Select management view</option>{(books.items||[]).filter(b=>b.kind==='management').map(b=><option key={b.id} value={b.id}>{b.code}</option>)}</select></label><label>As of<input type="date" value={asOf} onChange={e=>setAsOf(e.target.value)}/></label></div>
   {viewId&&(combined===null?<Loading/>:<><p role="status">Basis: {combined.basis}</p>
    {combined.books.map((b:Row)=><section key={b.bookId} className="demo-card"><h3>{b.code} · {b.kind} · {b.functionalCurrency}{b.rate!=='1'?' at '+b.rate:''} · {b.policy.replace('_',' ')}</h3>{table(['Account','Native balance','Translated'],b.accounts.map((a:Row)=>[a.code+' '+a.name,amount(a.nativeBalance,b.functionalCurrency),amount(a.translated,combined.currency)]),'No balances.')}</section>)}
    <h3>Combined ({combined.currency})</h3>{table(['Account','Balance'],combined.combined.map((a:Row)=>[a.code+' '+a.name,amount(a.balance,combined.currency)]),'Nothing combined.')}
    {combined.excluded.length>0&&<p>Excluded: {combined.excluded.map((e:Row)=>e.code+' ('+e.reason+')').join('; ')}</p>}
    {combined.blocked.length>0&&<section role="alert" className="error-panel"><h2>Blocked</h2><ul>{combined.blocked.map((b:Row)=><li key={b.bookId}><strong>{b.code}</strong>: {b.reason}</li>)}</ul></section>}
    <p>Checksum {combined.checksum.slice(0,12)}…</p></>)}
  </section>}
 </>;
}

// Transaction and functional side by side for a foreign-currency open item.
export function FxLayersPanel({entityId,openItemId,currency,tick}:{entityId:string,openItemId:string,currency:string,tick:number}){
 const [layers,setLayers]=useState<Row[]|null>(null);
 useEffect(()=>{api('GET','/fx-layers?openItemId='+openItemId,{entityId}).then(r=>setLayers(r.data.items)).catch(()=>setLayers([]));},[openItemId,tick]);
 if(layers===null)return <Loading/>;
 if(!layers.length)return null;
 const last=layers[layers.length-1];
 return <section className="demo-card"><h2>Foreign currency</h2><p role="status">Remaining {amount(last.txnRemaining,currency)} · functional carrying {amount(last.funcCarrying)} · last rate {last.rate}</p>{table(['Event','Rate','Consumed ('+currency+')','Consumed (functional)','Realized FX','Remaining','Carrying'],layers.map(l=>[l.event,l.rate,amount(l.txnConsumed,currency),amount(l.funcConsumed),amount(l.realizedFx),amount(l.txnRemaining,currency),amount(l.funcCarrying)]),'')}</section>;
}
