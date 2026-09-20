"use client";
// P11 assets, recurring work and recognition schedules: the asset register
// with capitalization from a posted bill, independent approval, the
// lifecycle events (transfer, split, merge, disposal, impairment,
// revaluation, capitalization from CIP) with their postings, the book/tax
// comparison; the schedule workbench with the deterministic preview, reviewed
// versions, approval, pause and resume, the run calendar with its results
// and the blocked-period tasks. No screen posts by itself; the worker
// executes approved schedules under the explicit schedule.execute authority.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,type Row,type ApiError} from './workspace-kit';
import {useBookId} from './workspace-ledger';

const money=(v:string|number|null|undefined)=>v==null?'—':new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(v));
const today=()=>new Date().toISOString().slice(0,10);
const short=(id?:string|null)=>id?id.slice(0,8):'—';
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Assets not enabled</h2><p>The assets capability is activated per entity after the general ledger and purchasing, with the controller's approved asset classes, recognition methods, opening register and disclosure boundary. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capability activation.</a>:'Ask the controller to request activation.'}</p></section>;}

// The register: capitalization drafts from posted bills, approval by
// another principal, lifecycle events and the book/tax comparison.
export function AssetRegister({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('assets'))return <NotEnabled me={me}/>;
 const classes=useList('/asset-classes',entityId,tick);
 const assets=useList('/assets',entityId,tick);
 const bills=useList('/bills',entityId,tick,{state:'posted'});
 const branches=useList('/branches',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const {bookId}=useBookId(entityId,tick,me);
 const books=useList('/books',entityId,tick);
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [open,setOpen]=useState<string|null>(null),[detail,setDetail]=useState<Row|null>(null);
 const [layersFor,setLayersFor]=useState<string|null>(null),[layers,setLayers]=useState<Row|null>(null);
 const [kind,setKind]=useState('transfer');
 useEffect(()=>{if(!open){setDetail(null);return;}setDetail(null);api('GET','/assets/'+open+'/events',{entityId}).then(r=>setDetail(r.data)).catch(e=>setError(asError(e)));},[open,tick]);
 useEffect(()=>{if(!layersFor){setLayers(null);return;}setLayers(null);api('GET','/assets/'+layersFor+'/layers',{entityId}).then(r=>setLayers(r.data)).catch(e=>setError(asError(e)));},[layersFor,tick]);
 const className=(id:string)=>(classes.items||[]).find(c=>c.id===id)?.code||short(id);
 const currency=(books.items||[]).find((b:Row)=>b.id===bookId)?.functionalCurrency||'PHP';
 const openAsset=(assets.items||[]).find(a=>a.id===open);
 return <>
  <ErrorPanel error={error||cmd.error||assets.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('asset.create')&&<section className="demo-card"><h2>New asset</h2><p>An asset is drafted from a posted bill whose lines sit on the asset clearing account; approval by another principal capitalizes it (or opens construction in progress when the class has a CIP account). Depreciation runs monthly from the in-service month; the residual and the final month follow the approved policy.</p><Editor id={'asset-new'+entityId} label="Create asset" resetOnSave onSave={async d=>!!await cmd.run('POST','/assets',{entityId,body:{tag:d.tag,classId:d.classId,cost:d.cost,residual:d.residual||'0',currency,inServiceDate:d.inServiceDate,usefulLifeMonths:Number(d.usefulLifeMonths),method:d.method,sourceDocumentId:d.sourceDocumentId,...(d.locationId?{locationId:d.locationId}:{})}})}>
   {input('Tag','tag','','text',{required:true,pattern:'[A-Za-z0-9][A-Za-z0-9._/-]{0,63}'})}
   <label>Class<select name="classId" required><option value="">Select class</option>{(classes.items||[]).map(c=><option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select></label>
   {input('Cost','cost','','text',{required:true,inputMode:'decimal'})}{input('Residual','residual','0','text',{inputMode:'decimal'})}
   {input('In-service date','inServiceDate',today(),'date',{required:true})}{input('Useful life (months)','usefulLifeMonths','60','number',{required:true,min:1})}
   {select('Method','method',[['straight_line','Straight line'],['declining_balance','Declining balance'],['sum_of_years',"Sum of the years' digits"]],'straight_line')}
   <label>Source bill<select name="sourceDocumentId" required><option value="">Select posted bill</option>{(bills.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{b.officialNumber||b.externalReference||short(b.id)} · {money(b.net)}</option>)}</select></label>
   <label>Location<select name="locationId"><option value="">Entity</option>{(branches.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select></label>
  </Editor></section>}
  <h2>Register</h2>
  {assets.items===null?<Loading/>:table(['Tag','Class','Cost','In service','Life','Method','State','Actions'],assets.items.map(a=>[a.tag,className(a.classId),money(a.cost),a.inServiceDate,a.usefulLifeMonths+' mo',a.method.replace(/_/g,' '),a.state,<div key="a" className="action-row"><button type="button" onClick={()=>setOpen(open===a.id?null:a.id)}>{open===a.id?'Hide':'Open'}</button><button type="button" onClick={()=>setLayersFor(layersFor===a.id?null:a.id)}>{layersFor===a.id?'Hide book/tax':'Book/tax'}</button>{a.state==='draft'&&can('asset.approve')&&<button type="button" disabled={cmd.busy} onClick={()=>void cmd.run('POST','/assets/'+a.id+'/approve',{entityId,ifMatch:a.version,body:{decision:'approve',contentVersion:a.contentVersion}})}>Approve</button>}{a.state==='draft'&&can('asset.approve')&&<Editor id={'reja'+a.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/assets/'+a.id+'/approve',{entityId,ifMatch:a.version,body:{decision:'reject',contentVersion:a.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No assets yet. Classes are approved by the controller from the signed register boundary.')}
  {open&&<section className="demo-card"><h2>Asset detail</h2>{detail===null?<Loading/>:<>
   <p>{detail.tag} · {detail.state} · {detail.stage==='cip'?'construction in progress':'in service'} · cost {money(detail.cost)} · accumulated depreciation {money(detail.accumulatedDepreciation)} · carrying amount <strong>{money(detail.carryingAmount)}</strong>{detail.capitalizedEntryId?' · capitalization entry '+short(detail.capitalizedEntryId):''}</p>
   {table(['#','Kind','Effective','Amount','Proceeds','Cost after','Accumulated after','Entry','Reason'],detail.events.map((e:Row)=>[e.sequence,e.kind.replace(/_/g,' '),e.effectiveDate,e.amount==null?'—':money(e.amount),e.proceeds==null?'—':money(e.proceeds),money(e.costAfter),money(e.accumulatedAfter),short(e.entryId),e.reason]),'No lifecycle events yet.')}
   {detail.components.length>0&&<>{table(['Component','Cost','Accumulated','Life'],detail.components.map((c:Row)=>[c.tag,money(c.cost),money(c.accumulatedDepreciation),c.usefulLifeMonths+' mo']),'')}</>}
   {openAsset&&openAsset.state==='approved'&&can('asset.events')&&<><h3>Record event</h3><p>Each event posts once and links to the asset; disposal removes cost and accumulated depreciation and recognizes the gain or loss on the proceeds; split and merge conserve totals; impairment and revaluation regenerate the open schedule periods prospectively. Posted periods are never rewritten.</p><Editor id={'ev'+openAsset.id+kind} label="Record event" resetOnSave onSave={async d=>!!await cmd.run('POST','/assets/'+openAsset.id+'/events',{entityId,ifMatch:openAsset.version,body:{kind,effectiveDate:d.effectiveDate,reason:d.reason,evidenceIds:[d.evidenceId],...(d.amount?{amount:d.amount}:{}),...(kind==='disposal'?{proceeds:d.proceeds||'0'}:{}),...(d.targetLocationId?{targetLocationId:d.targetLocationId}:{}),...(d.relatedAssetIds?{relatedAssetIds:d.relatedAssetIds.split(',').map((s:string)=>s.trim()).filter(Boolean)}:{})}})}>
    <label>Kind<select name="kind" value={kind} onChange={e=>setKind(e.target.value)}><option value="transfer">Transfer</option><option value="impairment">Impairment</option><option value="revaluation">Revaluation</option><option value="split">Split</option><option value="merge">Merge</option><option value="disposal">Disposal</option><option value="capitalize_cip">Capitalize from CIP</option></select></label>
    {input('Effective date','effectiveDate',today(),'date',{required:true})}
    {['impairment','revaluation','split'].includes(kind)&&input('Amount','amount','','text',{required:true,inputMode:'decimal'})}
    {kind==='disposal'&&input('Proceeds','proceeds','0','text',{required:true,inputMode:'decimal'})}
    {kind==='transfer'&&<label>Target location<select name="targetLocationId" required><option value="">Select branch</option>{(branches.items||[]).map((b:Row)=><option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select></label>}
    {kind==='merge'&&input('Absorbed asset ids (comma separated)','relatedAssetIds','','text',{required:true})}
    <label>Evidence<select name="evidenceId" required><option value="">Select available evidence</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
    {input('Reason','reason','','text',{required:true})}
   </Editor></>}
  </>}</section>}
  {layersFor&&<section className="demo-card"><h2>Book and tax</h2>{layers===null?<Loading/>:<>{table(['Period','Book depreciation','Tax depreciation','Book value','Tax value','Difference'],layers.layers.map((l:Row)=>[l.periodStart.slice(0,7),money(l.bookDepreciation),money(l.taxDepreciation),money(l.bookValue),money(l.taxValue),money(l.difference)]),'No depreciation posted yet.')}<p>Rule {layers.ruleVersion} · checksum {layers.checksum.slice(0,12)}…</p></>}</section>}
 </>;
}

// Schedules: the deterministic preview, reviewed versions, approval, pause,
// the run calendar and the blocked-period tasks.
export function AssetSchedules({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('assets'))return <NotEnabled me={me}/>;
 const schedules=useList('/schedules',entityId,tick);
 const assets=useList('/assets',entityId,tick,{state:'approved'});
 const runs=useList('/schedule-runs',entityId,tick);
 const {bookId}=useBookId(entityId,tick,me);
 const periods=useList('/periods',entityId,tick,bookId?{bookId}:{});
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [kind,setKind]=useState('depreciation');
 const [open,setOpen]=useState<string|null>(null),[detail,setDetail]=useState<Row|null>(null);
 useEffect(()=>{if(!open){setDetail(null);return;}setDetail(null);api('GET','/schedules/'+open+'/lines',{entityId}).then(r=>setDetail(r.data)).catch(e=>setError(asError(e)));},[open,tick]);
 const source=(s:Row)=>s.kind==='depreciation'?((assets.items||[]).find(a=>a.id===s.sourceId)?.tag||short(s.sourceId)):short(s.sourceId);
 const periodLabel=(id:string)=>{const p=(periods.items||[]).find((x:Row)=>x.id===id);return p?p.startsOn.slice(0,7):short(id);};
 return <>
  <ErrorPanel error={error||cmd.error||schedules.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('schedule.create')&&<section className="demo-card"><h2>New schedule</h2><p>One engine: depreciation from an approved asset, prepayments and deferred revenue from posted documents, recurring invoices and journals from a template, employee deductions from an employee. The lines are deterministic from the approved policy with the rounding residue in the final period; approval by another principal freezes the version and later changes are prospective versions.</p><Editor id={'sched-new'+entityId+kind} label="Create schedule" resetOnSave onSave={async d=>!!await cmd.run('POST','/schedules',{entityId,body:{kind,sourceId:d.sourceId,startDate:d.startDate,endDate:d.endDate,basisAmount:d.basisAmount,currency:d.currency,policyVersion:d.policyVersion}})}>
   <label>Kind<select name="kind" value={kind} onChange={e=>setKind(e.target.value)}><option value="depreciation">Depreciation</option><option value="prepayment">Prepayment</option><option value="deferred_revenue">Deferred revenue</option><option value="recurring_invoice">Recurring invoice</option><option value="recurring_journal">Recurring journal</option><option value="employee_deduction">Employee deduction</option></select></label>
   {kind==='depreciation'?<label>Asset<select name="sourceId" required><option value="">Select approved asset</option>{(assets.items||[]).map(a=><option key={a.id} value={a.id}>{a.tag} · {money(a.cost)}</option>)}</select></label>:input('Source id (document, journal or employee)','sourceId','','text',{required:true})}
   {input('Start date','startDate',today(),'date',{required:true})}{input('End date','endDate','','date',{required:true})}
   {input('Basis amount','basisAmount','','text',{required:true,inputMode:'decimal'})}{input('Currency','currency','PHP','text',{required:true,pattern:'[A-Z]{3}'})}
   {input('Policy code','policyVersion','','text',{required:true,pattern:'[a-z][a-z0-9_]{0,40}'})}
  </Editor></section>}
  <h2>Schedules</h2>
  {schedules.items===null?<Loading/>:table(['Kind','Source','Start','End','Basis','Policy','State','Actions'],schedules.items.map(s=>[s.kind.replace(/_/g,' '),source(s),s.startDate,s.endDate,money(s.basisAmount),s.policyVersion,s.state,<div key="a" className="action-row"><button type="button" onClick={()=>setOpen(open===s.id?null:s.id)}>{open===s.id?'Hide lines':'Lines'}</button>{can('schedule.approve')&&<button type="button" disabled={cmd.busy} onClick={()=>void cmd.run('POST','/schedules/'+s.id+'/approve',{entityId,ifMatch:s.version,body:{decision:'approve',contentVersion:s.contentVersion}})}>Approve</button>}{can('schedule.approve')&&s.state!=='completed'&&<Editor id={'rejs'+s.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/schedules/'+s.id+'/approve',{entityId,ifMatch:s.version,body:{decision:'reject',contentVersion:s.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}{['approved','paused'].includes(s.state)&&can('schedule.pause')&&<Editor id={'pause'+s.id} label={s.state==='paused'?'Resume':'Pause'} onSave={async d=>!!await cmd.run('POST','/schedules/'+s.id+'/pause',{entityId,ifMatch:s.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}{s.state==='approved'&&can('schedule.execute')&&<Editor id={'run'+s.id} label="Run period" onSave={async d=>!!await cmd.run('POST','/schedule-runs',{entityId,body:{periodId:d.periodId,scheduleIds:[s.id]}})}><label>Period<select name="periodId" required><option value="">Select period</option>{(periods.items||[]).map((p:Row)=><option key={p.id} value={p.id}>{p.startsOn.slice(0,7)} ({p.state})</option>)}</select></label></Editor>}</div>]),'No schedules yet.')}
  {open&&<section className="demo-card"><h2>Schedule lines</h2>{detail===null?<Loading/>:<>
   <p>{detail.kind.replace(/_/g,' ')} · {detail.state} · version {detail.versionNo} · planned {money(detail.totalPlanned)} · executed {money(detail.totalExecuted)} · checksum {detail.checksum.slice(0,12)}…</p>
   {table(['Version','Effective from','Method','Basis','Opening','Policy','Reason','State'],detail.versions.map((v:Row)=>[v.versionNo,v.effectiveFrom,v.method.replace(/_/g,' '),money(v.basisAmount),money(v.openingRecognized),v.policyVersion,v.reason,v.state]),'')}
   {table(['#','Period','Amount','Version','State','Entry','Draft','Task'],detail.lines.map((l:Row)=>[l.sequence,l.periodStart.slice(0,7),money(l.amount),l.versionNo,l.state,short(l.entryId),l.draftedResourceId?link(l.draftedResourceType==='journal'?'/ledger/journals':'/sales/invoices',l.draftedResourceType+' '+short(l.draftedResourceId)):'—',l.taskId?link('/work',short(l.taskId)):'—']),'No lines.')}
  </>}</section>}
  <h2>Run calendar</h2>
  <p>Runs execute in the worker under the requesting principal's schedule.execute authority, rechecked at execution. A period with an executed line answers already_executed and posts nothing; a locked or soft-closed period blocks the line and opens a task instead of a bypass.</p>
  {runs.items===null?<Loading/>:table(['Requested','Period','Schedules','State','Results'],runs.items.map(r=>[when(r.createdAt),periodLabel(r.periodId),r.scheduleIds.length,r.state,<ul key="r">{r.results.map((x:Row,i:number)=><li key={i}>{x.outcome}{x.entryId?' · entry '+short(x.entryId):''}{x.resourceId?' · draft '+short(x.resourceId):''}{x.taskId?<> · {link('/work','task '+short(x.taskId))}</>:''}{x.message?' · '+x.message:''}</li>)}{!r.results.length&&<li>queued</li>}</ul>]),'No runs yet.')}
 </>;
}
