"use client";
// P03 ledger screens: chart tree, journal editor with running difference and
// review actions, import staging with row errors, periods with close checklist,
// reports generated as jobs and rendered from their snapshot, and capability
// activation. Every action goes through the contract API with If-Match and a
// reusable idempotency key; no total is computed for posting on the client.
import {useEffect,useMemo,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,uuid,type Row,type ApiError} from './workspace-kit';

const money=(v:string|number)=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(v));
const cents=(v:string)=>{const m=/^(\d{1,18})(?:\.(\d{1,6}))?$/.exec((v||'0').trim());if(!m)return null;return BigInt(m[1])*1000000n+BigInt((m[2]||'').padEnd(6,'0'));};
const fromMicros=(m:bigint)=>{const neg=m<0n,a=neg?-m:m;return (neg?'-':'')+(a/1000000n).toString()+'.'+(a%1000000n).toString().padStart(6,'0').slice(0,2);};
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};

// The primary book: listed through GET /books when the actor may read books,
// otherwise taken from the first account or period the actor can see.
export function useBookId(entityId:string,tick:number,me:Row){
 const [bookId,setBookId]=useState<string|null>(null);
 useEffect(()=>{let live=true;if(!me.capabilities.includes('general_ledger'))return;(async()=>{
  try{if(me.permissions.includes('book.read')){const r=await api('GET','/books?limit=5',{entityId});const primary=r.data.items.find((b:Row)=>b.kind==='primary')||r.data.items[0];if(primary&&live){setBookId(primary.id);return;}}
   const a=await api('GET','/accounts?limit=1',{entityId});if(a.data.items[0]&&live){setBookId(a.data.items[0].bookId);return;}
   const p=await api('GET','/periods?limit=1',{entityId});if(p.data.items[0]&&live)setBookId(p.data.items[0].bookId);}catch{}
 })();return()=>{live=false;};},[entityId,tick,me]);
 return {bookId};
}
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>General ledger not enabled</h2><p>The ledger capability is activated per entity with evidence and an independent approval. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}

export function Capabilities({entityId,me,can,tick,refresh}:Ctx){
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [rows,setRows]=useState<string[]|null>(null);
 useEffect(()=>{api('GET','/me').then(r=>setRows(r.data.capabilities)).catch(()=>setRows([]));},[tick]);
 const caps:[string,string][]=[['workspace','Finance workspace (P02)'],['general_ledger','General ledger and close (P03)'],['sales','Sales invoicing and receivables (P04)'],['purchasing','Purchasing payables and expenses (P05)'],['treasury','Treasury cash and bank reconciliation (P06)'],['compliance','Tax compliance and e-invoicing (P07)'],['fi_coexistence','Financial institution coexistence (P08)'],['multi_currency','Multiple currencies and separate books (P09)'],['inventory','Inventory costing and three-way matching (P10)'],['assets','Assets, recurring work and recognition schedules (P11)'],['ai_assistance','Evidence-backed AI assistance (P12)']];
 return <>{caps.map(([code,label])=><section key={code} className="demo-card"><h2>{label}</h2><p>{rows?.includes(code)?'Active on this entity.':'Not active. Request activation with the evidence the profile requires; a different principal approves.'}</p>{!rows?.includes(code)&&can('capability.activate')&&<Editor id={'cap'+code+entityId} label="Request or approve activation" onSave={async d=>!!await cmd.run('POST','/capabilities/activate',{entityId,body:{capability:code,profileVersion:d.profileVersion,evidenceIds:[d.evidenceId],reason:d.reason}})}>{input('Profile version','profileVersion',code==='workspace'?'p02.1':code==='sales'?'p04.1':code==='purchasing'?'p05.1':code==='treasury'?'p06.1':code==='compliance'?'p07.1':code==='fi_coexistence'?'p08.1':code==='multi_currency'?'p09.1':code==='inventory'?'p10.1':code==='assets'?'p11.1':code==='ai_assistance'?'p12.1':'p03.1','text',{required:true})}<label>Activation evidence<select name="evidenceId" required><option value="">Select available evidence</option>{(evidence.items||[]).map(e=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>{input('Reason','reason','','text',{required:true})}</Editor>}</section>)}<ErrorPanel error={cmd.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/></>;
}

export function LedgerAccounts({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('general_ledger'))return <NotEnabled me={me}/>;
 const list=useList('/accounts',entityId,tick);
 const cmd=useCommand(refresh);
 const {bookId}=useBookId(entityId,tick,me);
 const tree=useMemo(()=>{const items=list.items||[];const byParent=new Map<string|null,Row[]>();for(const a of items)(byParent.get(a.parentId||null)||byParent.set(a.parentId||null,[]).get(a.parentId||null))!.push(a);const out:{a:Row,depth:number}[]=[];const walk=(p:string|null,d:number)=>{for(const a of (byParent.get(p)||[]).sort((x,y)=>x.code.localeCompare(y.code))){out.push({a,depth:d});walk(a.id,d+1);}};walk(null,0);return out;},[list.items]);
 return <>{can('account.create')&&bookId&&<><h2>New account</h2><Editor id={'acct-new'+entityId} label="Create account" resetOnSave onSave={async d=>!!await cmd.run('POST','/accounts',{entityId,body:{bookId,code:d.code,name:d.name,category:d.category,controlType:d.controlType,...(d.parentId?{parentId:d.parentId}:{}),requiredDimensions:String(d.requiredDimensions||'').split(',').map(s=>s.trim()).filter(Boolean)}})}>{input('Code','code','','text',{required:true,pattern:'[A-Za-z0-9][A-Za-z0-9.-]{0,31}'})}{input('Name','name','','text',{required:true})}{select('Category','category',[['asset','Asset'],['liability','Liability'],['equity','Equity'],['income','Income'],['expense','Expense']],'asset')}<label>Parent<select name="parentId"><option value="">None (top level)</option>{(list.items||[]).map(a=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>{select('Control type','controlType',[['none','None (manual postings allowed)'],['ar','Receivables control'],['ap','Payables control'],['inventory','Inventory control'],['input_tax','Input tax'],['output_tax','Output tax'],['advance','Advances']],'none')}{input('Required dimensions (comma separated)','requiredDimensions','','text',{placeholder:'cost_center'})}</Editor></>}
  {can('account.create')&&!bookId&&<p>The primary book is not visible to this role yet; a controller creates the first period or account.</p>}
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <h2>Chart</h2>{list.items===null&&!list.error?<Loading/>:table(['Code','Account','Category','Control','Dimensions','State'],tree.map(({a,depth})=>[<span style={{paddingLeft:depth*16}}>{a.code}</span>,a.name,a.category,a.controlType==='none'?'—':a.controlType,a.requiredDimensions.join(', ')||'—',a.state]),'No accounts yet. Create the top-level accounts first, then their children.')}</>;
}

function JournalEditor({entityId,bookId,accounts,branches,initial,onSave,label}:{entityId:string,bookId:string,accounts:Row[],branches:Row[],initial?:Row,onSave:(body:Row)=>Promise<boolean>,label:string}){
 const [lines,setLines]=useState<Row[]>(initial?.lines?.map((l:Row)=>({...l}))||[{accountId:'',branchId:branches[0]?.id||'',debit:'',credit:''},{accountId:'',branchId:branches[0]?.id||'',debit:'',credit:''}]);
 // Branches load after the editor mounts; default each line to the first branch once known.
 useEffect(()=>{if(branches.length)setLines(ls=>ls.map(l=>l.branchId?l:{...l,branchId:branches[0].id}));},[branches.length]);
 const totals=useMemo(()=>{let d=0n,c=0n,bad=false;for(const l of lines){const dv=cents(l.debit||'0'),cv=cents(l.credit||'0');if(dv===null||cv===null){bad=true;continue;}d+=dv;c+=cv;}return {debit:fromMicros(d),credit:fromMicros(c),difference:fromMicros(d-c),balanced:!bad&&d===c&&d>0n,bad};},[lines]);
 const update=(i:number,k:string,v:string)=>setLines(ls=>ls.map((l,j)=>j===i?{...l,[k]:v}:l));
 return <Editor id={'journal'+(initial?.id||'new')+entityId+(initial?.version||0)} label={label} disabled={!totals.balanced} onSave={async d=>onSave({bookId,accountingDate:d.accountingDate,documentDate:d.documentDate,currency:'PHP',description:d.description,lines:lines.map(l=>({accountId:l.accountId,branchId:l.branchId,debit:l.debit||'0',credit:l.credit||'0',dimensions:{}})),evidenceIds:[]})}>
  {input('Accounting date','accountingDate',initial?.accountingDate||'2026-09-18','date',{required:true})}{input('Document date','documentDate',initial?.documentDate||'2026-09-18','date',{required:true})}{input('Description','description',initial?.description||'','text',{required:true,maxLength:500})}
  <div className="table-scroll" tabIndex={0} role="region" aria-label="Journal lines"><table><thead><tr><th>Account</th><th>Branch</th><th>Debit</th><th>Credit</th><th></th></tr></thead><tbody>{lines.map((l,i)=><tr key={i}><td><select aria-label={'Line '+(i+1)+' account'} value={l.accountId} onChange={e=>update(i,'accountId',e.target.value)} required><option value="">Select account</option>{accounts.filter(a=>a.state==='active').map(a=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td><td><select aria-label={'Line '+(i+1)+' branch'} value={l.branchId} onChange={e=>update(i,'branchId',e.target.value)}>{branches.map(b=><option key={b.id} value={b.id}>{b.code}</option>)}</select></td><td><input aria-label={'Line '+(i+1)+' debit'} inputMode="decimal" value={l.debit} onChange={e=>update(i,'debit',e.target.value)} placeholder="0.00"/></td><td><input aria-label={'Line '+(i+1)+' credit'} inputMode="decimal" value={l.credit} onChange={e=>update(i,'credit',e.target.value)} placeholder="0.00"/></td><td>{lines.length>2&&<button type="button" aria-label={'Remove line '+(i+1)} onClick={()=>setLines(ls=>ls.filter((_,j)=>j!==i))}>×</button>}</td></tr>)}</tbody></table></div>
  <div className="action-row"><button type="button" onClick={()=>setLines(ls=>[...ls,{accountId:'',branchId:branches[0]?.id||'',debit:'',credit:''}])}>Add line</button></div>
  <p role="status" aria-live="polite">Debits {money(totals.debit)} · Credits {money(totals.credit)} · Difference {money(totals.difference)}{totals.balanced?' · Balanced':totals.bad?' · Enter amounts with up to six decimals':' · Balance the entry before saving'}</p>
 </Editor>;
}

export function LedgerJournals({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('general_ledger'))return <NotEnabled me={me}/>;
 const [status,setStatus]=useState('draft,submitted,changes_requested,approved');
 const list=useList('/journals',entityId,tick,{status});
 const accounts=useList('/accounts',entityId,tick);
 const branches=useList('/branches',entityId,tick);
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 return <>{can('journal.prepare')&&bookId&&<><h2>New journal</h2><JournalEditor entityId={entityId} bookId={bookId} accounts={accounts.items||[]} branches={branches.items||[]} label="Save draft" onSave={async body=>{const r=await cmd.run('POST','/journals',{entityId,body});if(r)window.location.assign('/ledger/journals/'+r.data.id);return !!r;}}/></>}
  {!bookId&&<p>Create the chart of accounts first; the journal editor opens once the primary book has accounts.</p>}
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <h2>Journals</h2><div className="filter-row"><label>Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="draft,submitted,changes_requested,approved">In review</option><option value="submitted">Awaiting approval</option><option value="approved">Approved, not posted</option><option value="posted">Posted</option><option value="cancelled">Cancelled</option></select></label></div>
  {list.items===null&&!list.error?<Loading/>:table(['Date','Description','Lines','State'],(list.items||[]).map(j=>[j.accountingDate,link('/ledger/journals/'+j.id,j.description),String(j.lines.length),j.state.replace(/_/g,' ')]),'No journals in this state.')}</>;
}

export function LedgerJournalDetail({entityId,id,me,can,tick,refresh}:Ctx&{id:string}){
 const [j,setJ]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null);
 useEffect(()=>{api('GET','/journals/'+id,{entityId}).then(r=>{setJ(r.data);setError(null);}).catch(e=>setError(asError(e)));},[id,entityId,tick]);
 const accounts=useList('/accounts',entityId,tick);
 const branches=useList('/branches',entityId,tick);
 const cmd=useCommand(refresh);
 if(error)return <ErrorPanel error={error} onReload={refresh}/>;
 if(!j)return <Loading/>;
 const acct=(aid:string)=>{const a=(accounts.items||[]).find(x=>x.id===aid);return a?a.code+' '+a.name:aid.slice(0,8);};
 const editable=['draft','changes_requested'].includes(j.state);
 const act=(label:string,path:string,body:Row,permission:string,extra:Row={})=>can(permission)?<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/journals/'+id+'/'+path,{entityId,ifMatch:j.version,body,...extra})}>{label}</button>:null;
 return <><p>State: {j.state.replace(/_/g,' ')} · {j.accountingDate} · Content version {j.contentVersion} · Version {j.version}</p><p>{j.description}</p>
  <ErrorPanel error={cmd.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {table(['Account','Branch','Debit','Credit'],j.lines.map((l:Row)=>[acct(l.accountId),(branches.items||[]).find(b=>b.id===l.branchId)?.code||l.branchId.slice(0,8),money(l.debit),money(l.credit)]),'')}
  <div className="action-row">{editable&&act('Submit for approval','submit',{},'journal.submit')}{j.state==='submitted'&&act('Approve','approve',{decision:'approve',contentVersion:j.contentVersion},'journal.approve')}{j.state==='submitted'&&can('journal.approve')&&<Editor id={'reject'+id} label="Request changes" onSave={async d=>!!await cmd.run('POST','/journals/'+id+'/approve',{entityId,ifMatch:j.version,body:{decision:'reject',contentVersion:j.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}{j.state==='approved'&&act('Post to ledger','post',{},'journal.post')}{j.state==='posted'&&can('journal.reverse')&&<Editor id={'reverse'+id} label="Prepare reversal" onSave={async d=>{const r=await cmd.run('POST','/journals/'+id+'/reverse',{entityId,ifMatch:j.version,body:{accountingDate:d.accountingDate,reason:d.reason}});if(r)window.location.assign('/ledger/journals/'+r.data.resourceId);return !!r;}}>{input('Reversal date','accountingDate',j.accountingDate,'date',{required:true})}{input('Reason','reason','','text',{required:true})}</Editor>}</div>
  {j.state==='posted'&&<p>Posted journals are immutable. Corrections are linked reversals.</p>}
  {editable&&can('journal.edit')&&<><h2>Edit draft</h2><JournalEditor entityId={entityId} bookId={j.bookId} accounts={accounts.items||[]} branches={branches.items||[]} initial={j} label="Save changes" onSave={async body=>!!await cmd.run('PATCH','/journals/'+id,{entityId,ifMatch:j.version,body})}/></>}
  {link('/ledger/journals','Back to journals')}</>;
}

export function LedgerImports({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('general_ledger'))return <NotEnabled me={me}/>;
 const list=useList('/imports',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [selected,setSelected]=useState<string|null>(null),[rows,setRows]=useState<Row|null>(null);
 useEffect(()=>{if(!selected){setRows(null);return;}api('GET','/imports/'+selected,{entityId}).then(r=>setRows(r.data)).catch(()=>setRows(null));},[selected,tick]);
 const act=(imp:Row,label:string,path:string,body:Row,permission:string)=>can(permission)?<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/imports/'+imp.id+'/'+path,{entityId,ifMatch:imp.version,body})}>{label}</button>:null;
 return <>{can('import.create')&&<><h2>New import</h2><p>Upload the CSV as evidence first. Openings: source_key, account_code, branch_code, accounting_date, debit, credit; commit posts one opening entry. Bank statements (treasury): source_line_key, booked_date, value_date, signed_amount, currency, reference, description plus opening_balance and closing_balance rows, with the approved bank account id as the source; commit stages the lines for reconciliation. Approval must come from a different principal.</p><Editor id={'import-new'+entityId} label="Stage import" resetOnSave onSave={async d=>!!await cmd.run('POST','/imports',{entityId,body:{kind:d.kind,evidenceId:d.evidenceId,mappingVersion:d.mappingVersion,sourceId:d.sourceId,externalBatchId:d.externalBatchId,cutoffDate:d.cutoffDate}})}>{select('Kind','kind',[['openings','Opening balances'],['bank_statement','Bank statement'],['journal','Source journal feed (institution)'],['source_balances','Source balances (institution)']],'openings')}<label>CSV evidence<select name="evidenceId" required><option value="">Select available CSV</option>{(evidence.items||[]).filter(e=>e.mime==='text/csv').map(e=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>{input('Mapping version','mappingVersion','v1','text',{required:true})}{input('Source system or bank account id','sourceId','legacy-gl','text',{required:true})}{input('External batch id','externalBatchId','','text',{required:true})}{input('Cutoff date','cutoffDate','','date',{required:true})}</Editor></>}
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <h2>Imports</h2>{list.items===null&&!list.error?<Loading/>:table(['Batch','Cutoff','State','Actions'],(list.items||[]).map(i=>[<button type="button" onClick={()=>setSelected(i.id)}>{i.sourceId} · {i.externalBatchId}</button>,i.cutoffDate,i.state,<div className="action-row">{['staged','validated'].includes(i.state)&&act(i,'Validate','validate',{},'import.validate')}{i.state==='validated'&&act(i,'Approve','approve',{decision:'approve',contentVersion:i.contentVersion},'import.approve')}{i.state==='approved'&&act(i,'Commit','commit',{},'import.commit')}</div>]),'No imports yet.')}
  {rows&&<section className="demo-card"><h3>Import {rows.externalBatchId}</h3><p>{rows.state} · mapping {rows.mappingVersion} · evidence {rows.evidenceId.slice(0,8)}</p><p>Row-level errors appear after validation in the API response; rows that fail keep the import staged until the source is corrected and re-uploaded.</p></section>}</>;
}

export function LedgerPeriods({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('general_ledger'))return <NotEnabled me={me}/>;
 const list=useList('/periods',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const {bookId}=useBookId(entityId,tick,me);
 const cmd=useCommand(refresh);
 const [open,setOpen]=useState<string|null>(null);
 const tasks=useList(open?'/periods/'+open+'/close-tasks':'/periods',open?entityId:null,tick);
 const act=(p:Row,label:string,path:string,permission:string,reason:string)=>can(permission)?<button disabled={cmd.busy} onClick={()=>{const r=window.prompt(reason);if(r)void cmd.run('POST','/periods/'+p.id+'/'+path,{entityId,ifMatch:p.version,body:{reason:r}});}}>{label}</button>:null;
 return <>{can('period.create')&&bookId&&<><h2>New period</h2><Editor id={'period-new'+entityId} label="Create period" resetOnSave onSave={async d=>!!await cmd.run('POST','/periods',{entityId,body:{bookId,startsOn:d.startsOn,endsOn:d.endsOn}})}>{input('Starts on','startsOn','','date',{required:true})}{input('Ends on','endsOn','','date',{required:true})}</Editor></>}
  <ErrorPanel error={cmd.error||list.error||tasks.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <h2>Periods</h2>{list.items===null&&!list.error?<Loading/>:table(['Period','State','Close checklist','Actions'],(list.items||[]).sort((a,b)=>a.startsOn.localeCompare(b.startsOn)).map(p=>[p.startsOn+' → '+p.endsOn,p.state.replace('_',' '),<button type="button" onClick={()=>setOpen(p.id)}>Open checklist</button>,<div className="action-row">{p.state==='open'&&act(p,'Soft close','soft-close','period.soft_close','Reason for soft close')}{p.state==='soft_closed'&&act(p,'Lock','lock','period.lock','Reason for locking (required tasks must be complete)')}{p.state!=='open'&&act(p,'Reopen','reopen','period.reopen','Reason for reopening (starts a new close version)')}</div>]),'No periods yet.')}
  {open&&<section className="demo-card"><h3>Close checklist</h3>{table(['Requirement','Required','State','Complete'],(tasks.items||[]).map(t=>[t.requirement.replace(/_/g,' '),t.required?'Yes':'No',t.state,t.state==='open'&&can('period.edit')?<Editor id={'ct'+t.id} label="Complete" onSave={async d=>!!await cmd.run('POST','/close-tasks/'+t.id+'/complete',{entityId,ifMatch:t.version,body:{reason:d.reason,evidenceIds:d.evidenceId?[d.evidenceId]:[]}})}>{input('Note or waiver reason','reason','Reconciled','text',{required:true})}<label>Evidence{t.required?' (required)':''}<select name="evidenceId" required={t.required}><option value="">{t.required?'Select evidence':'None (waive)'}</option>{(evidence.items||[]).map(e=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label></Editor>:t.state]),'No close tasks for this close version.')}{can('period.edit')&&<Editor id={'ct-new'+open} label="Add requirement" resetOnSave onSave={async d=>!!await cmd.run('POST','/periods/'+open+'/close-tasks',{entityId,body:{requirement:d.requirement,required:d.required==='yes'}})}>{input('Requirement code','requirement','bank_reconciliation','text',{required:true,pattern:'[a-z][a-z0-9_]{0,63}'})}{select('Required before lock','required',[['yes','Yes'],['no','No — may be waived']],'yes')}</Editor>}</section>}</>;
}

export function LedgerReports({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('general_ledger'))return <NotEnabled me={me}/>;
 const {bookId}=useBookId(entityId,tick,me);
 const [job,setJob]=useState<Row|null>(null),[report,setReport]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null),[busy,setBusy]=useState(false);
 useEffect(()=>{if(!job||!['queued','running','retry_wait'].includes(job.state))return;const t=setTimeout(()=>api('GET','/jobs/'+job.id,{entityId}).then(r=>setJob(r.data)).catch(e=>setError(asError(e))),1500);return()=>clearTimeout(t);},[job]);
 useEffect(()=>{if(job?.state==='succeeded'&&job.resultResourceId&&!report){fetch('/api/v1/evidence/'+job.resultResourceId+'/content',{headers:{'x-entity-id':entityId}}).then(async r=>{if(!r.ok)throw await r.json();setReport(await r.json());}).catch(e=>setError(asError(e)));}},[job]);
 async function generate(d:Row){setBusy(true);setError(null);setReport(null);try{const r=await api('POST','/reports',{entityId,key:uuid(),body:{reportType:d.reportType,bookId,periodStart:d.periodStart,periodEnd:d.periodEnd,asOf:new Date().toISOString(),format:'json'}});setJob(r.data);return true;}catch(e){setError(asError(e));return false;}finally{setBusy(false);}}
 return <>{can('report.generate')&&bookId?<><h2>Generate</h2><Editor id={'report'+entityId} label="Generate report" disabled={busy} onSave={generate}>{select('Report','reportType',[['trial_balance','Trial balance'],['statements','Management statements']],'trial_balance')}{input('Period start','periodStart','2026-09-01','date',{required:true})}{input('Period end','periodEnd','2026-09-30','date',{required:true})}</Editor></>:<p>{bookId?'Report generation requires report.generate.':'Create the chart of accounts first.'}</p>}
  <ErrorPanel error={error} onReload={refresh}/>
  {job&&<p role="status" aria-live="polite">Report job {job.state.replace('_',' ')}{job.state==='succeeded'?' · snapshot stored as restricted evidence':''}</p>}
  {report&&<section className="demo-card"><h2>{report.reportType==='trial_balance'?'Trial balance':'Management statements'} · version {report.versionNumber} · checksum {report.checksum.slice(0,12)}…</h2><p>Management statements — not statutory presentation. Cutoff {when(report.payload.asOf)}.</p>{report.payload.totals&&<p>Totals: debit {money(report.payload.totals.debit)} · credit {money(report.payload.totals.credit)} · {report.payload.totals.balanced?'balanced':'NOT BALANCED'}</p>}{report.payload.incomeStatement&&<p>Income {money(report.payload.incomeStatement.income)} · Expense {money(report.payload.incomeStatement.expense)} · Net income {money(report.payload.incomeStatement.netIncome)} · Assets {money(report.payload.balanceSheet.assets)} = Liabilities {money(report.payload.balanceSheet.liabilities)} + Equity {money(report.payload.balanceSheet.equity)} + Current earnings {money(report.payload.balanceSheet.currentEarnings)}</p>}{table(['Code','Account','Category','Debit','Credit','Balance'],report.payload.lines.map((l:Row)=>[l.code,l.name,l.category,money(l.debit),money(l.credit),money(l.balance)]),'No accounts in this report.')}{link('/evidence/'+job?.resultResourceId,'Open stored snapshot evidence')}</section>}</>;
}
