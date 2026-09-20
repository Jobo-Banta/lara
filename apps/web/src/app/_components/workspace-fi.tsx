"use client";
// P08 financial institution coexistence: the source ownership matrix, the
// batch monitor and error workbench for canonical feeds staged through the
// import pipeline, the mapping diff preview, the missing-feed calendar, the
// branch reconciliation dashboard with the interbranch roll-up, and the
// institution tax worksheet with drill-through to the instrument facts. The
// examiner scope reads everything and writes nothing. No screen posts by
// itself: staging, validation, approval and commit are the pipeline's steps.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,uuid,type Row,type ApiError} from './workspace-kit';
import {useBookId} from './workspace-ledger';

const money=(v:string|number|null|undefined)=>v==null?'—':new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(v));
const today=()=>new Date().toISOString().slice(0,10);
const monthStart=()=>today().slice(0,8)+'01';
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Institution coexistence not enabled</h2><p>The financial institution coexistence capability is activated per entity after compliance, with a signed feed matrix (entity, books, currency, tax and feed ownership) and an approved institution profile naming the interbranch accounts and the instrument classification rules. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}

// Source ownership matrix: which named system owns each transaction family
// of a book for a window, approved by a principal other than the author.
export function FiOwnership({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('fi_coexistence'))return <NotEnabled me={me}/>;
 const systems=useList('/source-systems',entityId,tick);
 const rows=useList('/source-ownership',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 return <>
  <ErrorPanel error={cmd.error||rows.error||systems.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <section className="demo-card"><h2>Source systems</h2>{systems.items===null?<Loading/>:table(['Code','Name','Owner','Granularity','Cutoff zone','State'],systems.items.map(s=>[s.code,s.name,s.ownerName,s.granularity,s.cutoffTimezone,s.state]),'No source system is named yet; an operator registers the pilot systems from the signed feed matrix.')}</section>
  {can('source_ownership.create')&&bookId&&<section className="demo-card"><h2>New ownership record</h2><p>Names the system that owns a transaction family in this book from a date, with the signed matrix as evidence. Ingestion needs an approved window effective on the batch cutoff; approved windows never overlap.</p><Editor id={'own-new'+entityId} label="Record ownership" resetOnSave onSave={async d=>!!await cmd.run('POST','/source-ownership',{entityId,body:{sourceSystem:d.sourceSystem,bookId,transactionFamily:d.transactionFamily,effectiveFrom:d.effectiveFrom,...(d.effectiveTo?{effectiveTo:d.effectiveTo}:{}),evidenceIds:[d.evidenceId]}})}>
   <label>Source system<select name="sourceSystem" required><option value="">Select system</option>{(systems.items||[]).map(s=><option key={s.id} value={s.code}>{s.code} · {s.name}</option>)}</select></label>
   {select('Transaction family','transactionFamily',[['journal','Canonical journal feed'],['balances','Subsidiary ledger balances'],['deposits','Deposits'],['loans','Loans'],['treasury','Treasury'],['fees','Fees and charges']],'journal')}
   {input('Effective from','effectiveFrom',today().slice(0,4)+'-01-01','date',{required:true})}{input('Effective to','effectiveTo','','date')}
   <label>Evidence (signed matrix)<select name="evidenceId" required><option value="">Select evidence</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
  </Editor></section>}
  <h2>Ownership matrix</h2>
  {rows.items===null?<Loading/>:table(['System','Family','Effective','State','Actions'],rows.items.map(o=>[o.sourceSystem,o.transactionFamily,o.effectiveFrom+(o.effectiveTo?' → '+o.effectiveTo:' → open'),o.state,<div key="a" className="action-row">{o.state==='draft'&&can('source_ownership.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/source-ownership/'+o.id+'/approve',{entityId,ifMatch:o.version,body:{decision:'approve',contentVersion:o.contentVersion}})}>Approve</button>}{o.state==='draft'&&can('source_ownership.approve')&&<Editor id={'rejo'+o.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/source-ownership/'+o.id+'/approve',{entityId,ifMatch:o.version,body:{decision:'reject',contentVersion:o.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No ownership recorded. Nothing can be ingested until a window is approved.')}
 </>;
}

// Batch monitor and error workbench: canonical feeds staged through
// POST /imports, with the manifest check, duplicates, replacements and the
// staged rows; the feed calendar with missing batches; mapping versions with
// the diff preview.
export function FiFeeds({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('fi_coexistence'))return <NotEnabled me={me}/>;
 const systems=useList('/source-systems',entityId,tick);
 const batches=useList('/source-batches',entityId,tick);
 const expected=useList('/expected-batches',entityId,tick);
 const mappings=useList('/mapping-versions',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [open,setOpen]=useState<string|null>(null),[rows,setRows]=useState<Row[]|null>(null),[onlyErrors,setOnlyErrors]=useState(true);
 useEffect(()=>{if(!open){setRows(null);return;}api('GET','/source-batches/'+open+'/rows'+(onlyErrors?'?status=error':''),{entityId}).then(r=>setRows(r.data.items)).catch(e=>setError(asError(e)));},[open,onlyErrors,tick]);
 const [diffFrom,setDiffFrom]=useState(''),[diffTo,setDiffTo]=useState(''),[diff,setDiff]=useState<Row|null>(null);
 useEffect(()=>{if(!diffTo){setDiff(null);return;}api('GET','/mapping-versions/'+diffTo+'/lines'+(diffFrom?'?againstId='+diffFrom:''),{entityId}).then(r=>setDiff(r.data)).catch(e=>setError(asError(e)));},[diffFrom,diffTo,tick]);
 // Pipeline actions run on the import behind the batch, with its current version.
 const step=async(b:Row,path:string,body:(imp:Row)=>Row)=>{setError(null);try{const imp=(await api('GET','/imports/'+b.importId,{entityId})).data;await cmd.run('POST','/imports/'+b.importId+'/'+path,{entityId,ifMatch:imp.version,body:body(imp)});}catch(e){setError(asError(e));}};
 const act=(b:Row,label:string,path:string,body:(imp:Row)=>Row,permission:string)=>can(permission)?<button key={path} disabled={cmd.busy} onClick={()=>void step(b,path,body)}>{label}</button>:null;
 const lineRow=(l:Row)=>[l.sourceAccount,l.targetAccountCode,Object.entries(l.dimensions||{}).map(([k,v])=>k+'='+v).join('; ')||'—',l.taxProfile||'—'];
 return <>
  <ErrorPanel error={error||cmd.error||batches.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('import.create')&&<section className="demo-card"><h2>Stage a feed batch</h2><p>Upload the canonical CSV as evidence first (lara-feed-1: external_line_id, accounting_date, book_code, branch_code, account_code, currency, debit, credit, source_document_ref, dimensions, tax_event_ref and the instrument columns, plus one MANIFEST row with count, sha256 and totals). The same batch id with the same checksum counts as a duplicate of the one batch; a different checksum is refused. A correction names the batch it replaces in its manifest.</p><Editor id={'feed-new'+entityId} label="Stage batch" resetOnSave onSave={async d=>!!await cmd.run('POST','/imports',{entityId,body:{kind:d.kind,evidenceId:d.evidenceId,mappingVersion:d.mappingVersion||'n/a',sourceId:d.sourceId,externalBatchId:d.externalBatchId,cutoffDate:d.cutoffDate}})}>
   {select('Kind','kind',[['journal','Canonical journal feed'],['source_balances','Subsidiary ledger balances']],'journal')}
   <label>Source system<select name="sourceId" required><option value="">Select system</option>{(systems.items||[]).map(s=><option key={s.id} value={s.code}>{s.code}</option>)}</select></label>
   <label>Feed CSV evidence<select name="evidenceId" required><option value="">Select available CSV</option>{(evidence.items||[]).filter((e:Row)=>e.mime==='text/csv').map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
   <label>Mapping version<select name="mappingVersion"><option value="">Not needed (balances)</option>{(mappings.items||[]).filter(m=>m.state==='approved').map(m=><option key={m.id} value={m.versionLabel}>{m.versionLabel}</option>)}</select></label>
   {input('External batch id','externalBatchId','','text',{required:true})}{input('Cutoff date','cutoffDate',today(),'date',{required:true})}
  </Editor></section>}
  <h2>Batch monitor</h2>
  {batches.items===null?<Loading/>:table(['Batch','Source','Kind','Rows','Errors','Debit','Credit','Duplicates','State','Actions'],batches.items.map(b=>[<span key="b">{b.externalBatchId}{b.replacesBatchId?' (replaces '+b.replacesBatchId.slice(0,8)+')':''}{b.replacedByBatchId?' (replaced)':''}</span>,b.sourceSystemCode,b.kind,b.rowCount,b.errorCount,money(b.debitTotal),money(b.creditTotal),b.duplicateCount,b.state,<div key="a" className="action-row"><button type="button" onClick={()=>setOpen(open===b.id?null:b.id)}>{open===b.id?'Hide rows':'Rows'}</button>{['staged','validated'].includes(b.state)&&act(b,'Validate','validate',()=>({}),'import.validate')}{b.state==='validated'&&act(b,'Approve','approve',imp=>({decision:'approve',contentVersion:imp.contentVersion}),'import.approve')}{b.state==='approved'&&act(b,'Post','commit',()=>({}),'import.commit')}{b.postedEntryId&&link('/ledger/journals','entry')}</div>]),'No feed batch staged yet.')}
  {open&&<section className="demo-card"><h2>Rows</h2><label><input type="checkbox" checked={onlyErrors} onChange={e=>setOnlyErrors(e.target.checked)}/> Only rows with errors</label>{rows===null?<Loading/>:table(['#','Line','Date','Branch','Source account','Debit','Credit','Reference','Status'],rows.map(r=>[r.rowNo,r.externalLineId,r.accountingDate||'—',r.branchCode,r.accountCode,money(r.debit),money(r.credit),r.sourceDocumentRef||'—',r.status==='error'?<strong key="e">{r.error}</strong>:'valid']),onlyErrors?'No row errors; manifest errors appear in the validation result.':'No rows staged.')}</section>}
  <h2>Feed calendar</h2><p>An expected batch past its deadline is missing: the affected period gains a required close task and cannot lock until the batch arrives or the task is resolved; other periods and entities are untouched.</p>
  {expected.items===null?<Loading/>:table(['Source','Kind','Period','Deadline','State'],expected.items.map(e=>[e.sourceSystemCode,e.kind,e.periodStart+' → '+e.periodEnd,when(e.deadlineAt),e.state==='missing'?<strong key="m">missing</strong>:e.state]),'No expected batches on the calendar.')}
  <h2>Mapping versions</h2>
  {mappings.items===null?<Loading/>:table(['Version','Lines','State','Hash'],mappings.items.map(m=>[m.versionLabel,m.lineCount,m.state,m.hash.slice(0,12)+'…']),'No mapping version imported; the reviewed account mapping enters as CSV evidence.')}
  <section className="demo-card"><h2>Mapping diff preview</h2><div className="demo-form"><label>Version<select value={diffTo} onChange={e=>setDiffTo(e.target.value)}><option value="">Select</option>{(mappings.items||[]).map(m=><option key={m.id} value={m.id}>{m.versionLabel} ({m.state})</option>)}</select></label><label>Compare against<select value={diffFrom} onChange={e=>setDiffFrom(e.target.value)}><option value="">None</option>{(mappings.items||[]).filter(m=>m.id!==diffTo).map(m=><option key={m.id} value={m.id}>{m.versionLabel} ({m.state})</option>)}</select></label></div>
   {diff&&<>{diff.diff.againstId?<p role="status">Against the other version: {diff.diff.added.length} added, {diff.diff.removed.length} removed, {diff.diff.changed.length} changed.</p>:<p role="status">{diff.lines.length} mapping line(s).</p>}
    {diff.diff.added.length>0&&table(['Added source account','Target','Dimensions','Tax profile'],diff.diff.added.map(lineRow),'')}
    {diff.diff.removed.length>0&&table(['Removed source account','Target','Dimensions','Tax profile'],diff.diff.removed.map(lineRow),'')}
    {diff.diff.changed.length>0&&table(['Changed source account','From','To'],diff.diff.changed.map((c:Row)=>[c.sourceAccount,c.from.targetAccountCode,c.to.targetAccountCode]),'')}
    {!diff.diff.againstId&&table(['Source account','Target','Dimensions','Tax profile'],diff.lines.map(lineRow),'No lines.')}</>}
  </section>
 </>;
}

// Branch reconciliation and missing-feed dashboard: per-branch totals with
// the interbranch pairs that cancel at the entity roll-up, and the source
// balances against the mapped ledger accounts.
export function FiBranches({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('fi_coexistence'))return <NotEnabled me={me}/>;
 const {bookId}=useBookId(entityId,tick,me);
 const [period,setPeriod]=useState({from:monthStart(),to:today()});
 const [roll,setRoll]=useState<Row|null>(null),[rec,setRec]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null);
 useEffect(()=>{if(!bookId)return;setRoll(null);setRec(null);Promise.all([api('GET','/branch-rollup?bookId='+bookId+'&periodStart='+period.from+'&periodEnd='+period.to,{entityId}),api('GET','/feed-reconciliation?bookId='+bookId+'&asOf='+period.to,{entityId})]).then(([a,b])=>{setRoll(a.data);setRec(b.data);setError(null);}).catch(e=>setError(asError(e)));},[bookId,period.from,period.to,tick]);
 const [job,setJob]=useState<Row|null>(null);
 useEffect(()=>{if(!job||!['queued','running','retry_wait'].includes(job.state))return;const t=setTimeout(()=>api('GET','/jobs/'+job.id,{entityId}).then(r=>setJob(r.data)).catch(e=>setError(asError(e))),1500);return()=>clearTimeout(t);},[job]);
 return <>
  <ErrorPanel error={error}/>
  <section className="demo-card"><h2>Period</h2><div className="demo-form"><label>From<input type="date" value={period.from} onChange={e=>setPeriod({...period,from:e.target.value})}/></label><label>To<input type="date" value={period.to} onChange={e=>setPeriod({...period,to:e.target.value})}/></label></div></section>
  <h2>Branch roll-up</h2>
  {!bookId?<p>No active book.</p>:roll===null?<Loading/>:<>{table(['Branch','Debit','Credit','Due from','Due to'],roll.branches.map((b:Row)=>[b.branchCode,money(b.debit),money(b.credit),money(b.dueFrom),money(b.dueTo)]),'No branches.')}
   <p role="status">Entity roll-up: due from {money(roll.rollup.dueFrom)} · due to {money(roll.rollup.dueTo)} · eliminated {money(roll.rollup.eliminated)} · {roll.rollup.difference==='0.00'?'interbranch pairs cancel':'open difference '+money(roll.rollup.difference)+' (asymmetric batch timing)'} · checksum {roll.checksum.slice(0,12)}…</p>
   <h3>Interbranch pairs</h3>{table(['From','To','Due from','Due to','Difference','Latest from','Latest to','State'],roll.pairs.map((p:Row)=>[p.fromBranch,p.toBranch,money(p.dueFrom),money(p.dueTo),money(p.difference),p.latestFromDate||'—',p.latestToDate||'—',p.state]),'No interbranch movements in the period.')}
   {can('report.generate')&&<><Editor id={'rollup-snap'+entityId} label="Record roll-up snapshot" onSave={async()=>{setError(null);try{const r=await api('POST','/reports',{entityId,key:uuid(),body:{reportType:'branch_rollup',bookId,periodStart:period.from,periodEnd:period.to,asOf:new Date().toISOString(),format:'json'}});setJob(r.data);return true;}catch(e){setError(asError(e));return false;}}}><p>Stores the manifest with its checksum as an immutable roll-up record and a report snapshot.</p></Editor>{job&&<p role="status" aria-live="polite">Snapshot job {job.state.replace('_',' ')}{job.state==='succeeded'&&job.resultResourceId&&<> · {link('/reports','open reports')}</>}</p>}</>}</>}
  <h2>Source balance reconciliation</h2>
  {rec===null?<Loading/>:<>{rec.sourceSystems.map((s:Row)=><section key={s.id} className="demo-card"><h3>{s.code}{s.latestCutoff?' · balances at '+s.latestCutoff:''}</h3>{table(['Source account','Branch','Currency','Source balance','Ledger balance','Difference','State'],s.accounts.map((a:Row)=>[a.accountCode+(a.targetAccountCode?' → '+a.targetAccountCode:''),a.branchCode||'—',a.currency,money(a.sourceBalance),a.ledgerBalance===null?'—':money(a.ledgerBalance),a.difference===null?'—':money(a.difference),a.state==='ties'?'ties':<strong key="s">{a.state}</strong>]),'No balance feed received for this system.')}</section>)}
   <h3>Missing feeds</h3>{table(['Source','Kind','Period','Deadline','State'],rec.expected.filter((e:Row)=>e.state!=='received').map((e:Row)=>[e.sourceSystemCode,e.kind,e.periodStart+' → '+e.periodEnd,when(e.deadlineAt),e.state==='missing'?<strong key="m">missing</strong>:e.state]),'Every expected batch up to the cutoff was received.')}</>}
 </>;
}

// Institution tax worksheet: instrument facts classified through the
// profile's reviewed rules with drill-through to the facts; unclassified
// facts are listed, never zeroed.
export function FiTax({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('fi_coexistence'))return <NotEnabled me={me}/>;
 const [period,setPeriod]=useState({from:monthStart(),to:today()});
 const [ws,setWs]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null),[drill,setDrill]=useState<string|null>(null);
 useEffect(()=>{setWs(null);api('GET','/institution-tax-worksheet?periodStart='+period.from+'&periodEnd='+period.to,{entityId}).then(r=>{setWs(r.data);setError(null);}).catch(e=>setError(asError(e)));},[period.from,period.to,tick]);
 return <>
  <ErrorPanel error={error}/>
  <section className="demo-card"><h2>Period</h2><div className="demo-form"><label>From<input type="date" value={period.from} onChange={e=>setPeriod({...period,from:e.target.value})}/></label><label>To<input type="date" value={period.to} onChange={e=>setPeriod({...period,to:e.target.value})}/></label></div><p>Each row is an active reviewed rule version (GRT, DST, final withholding) applied to the instrument facts the profile classifies to it by income category, instrument type and remaining maturity band. Every enabled rule carries the advisor's golden cases; a fact without a rule stays listed as unclassified.</p></section>
  <h2>Worksheet</h2>
  {ws===null?<Loading/>:<>{table(['Rule','Tax type','Rate','Income category','Facts','Basis','Tax','Drill-through'],ws.rows.map((r:Row)=>[r.ruleCode,r.taxType,r.rate,r.incomeCategory,r.facts,money(r.basis),money(r.tax),<button key="d" type="button" onClick={()=>setDrill(drill===r.ruleCode+r.incomeCategory?null:r.ruleCode+r.incomeCategory)}>{drill===r.ruleCode+r.incomeCategory?'Hide facts':'Facts'}</button>]),'No classified instrument facts in the period.')}
   <p role="status">Totals: basis {money(ws.totals.basis)} · tax {money(ws.totals.tax)} · checksum {ws.checksum.slice(0,12)}…</p>
   {drill&&<section className="demo-card"><h3>Facts behind {drill}</h3><ul>{(ws.rows.find((r:Row)=>r.ruleCode+r.incomeCategory===drill)?.factIds||[]).map((id:string)=><li key={id}>{id}</li>)}</ul><p>Fact ids reference the staged source rows of their batch (batch monitor → rows).</p></section>}
   <h3>Unclassified facts</h3>{table(['Instrument','Type','Category','Amount','Event date','Maturity','Reason'],ws.unclassified.map((u:Row)=>[u.instrumentRef,u.instrumentType,u.incomeCategory,money(u.amount),u.eventDate,u.maturityDate||'—',u.reason]),'Every fact in the period is classified.')}</>}
 </>;
}
