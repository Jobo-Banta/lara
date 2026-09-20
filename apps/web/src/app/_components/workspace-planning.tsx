"use client";
// P16 budgets, cost allocation and project accounting. Budgets: versions
// per period with buckets per account, approval and activation by other
// principals, budget versus actual and open commitments with the warnings
// and overrides recorded on the commitments. Allocations: rule versions with
// drivers, runs previewed with their lines (the residual placement shown),
// approved and posted once. Projects: contract versions (change orders),
// milestones certified on evidence, advances from posted collections,
// progress billing with retention and recoupment, retention aging and
// release, profitability from posted facts. No screen bypasses the API.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,useList,Loading,input,select,when,type Row,type ApiError} from './workspace-kit';
import {amount} from './workspace-fx';

type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
const today=()=>new Date().toISOString().slice(0,10);
const monthStart=()=>today().slice(0,8)+'01';
const monthEnd=()=>{const d=new Date();return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).toISOString().slice(0,10);};
const short=(id?:string|null)=>id?id.slice(0,8):'—';
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Planning not enabled</h2><p>The planning capability (budgets, cost allocation and project accounting) is activated per entity after inventory and assets, with finance's approval of the budget basis, drivers, project and retention profiles and contract evidence. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}
const MONEY={required:true,inputMode:'decimal',pattern:'[0-9]{1,18}(\\.[0-9]{1,6})?'};

// Budgets, availability and commitments.
export function Budgets({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('planning'))return <NotEnabled me={me}/>;
 const budgets=useList('/budgets',entityId,tick);
 const accounts=useList('/accounts',entityId,tick);
 const commitments=useList('/commitments',entityId,tick);
 const cmd=useCommand(refresh);
 const [open,setOpen]=useState<string|null>(null),[avail,setAvail]=useState<Row|null>(null),[availError,setAvailError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setAvail(null);if(!open)return;api('GET','/budgets/'+open+'/availability',{entityId}).then(r=>{if(live){setAvail(r.data);setAvailError(null);}}).catch(e=>{if(live)setAvailError(asError(e));});return()=>{live=false;};},[open,entityId,tick]);
 const expense=(accounts.items||[]).filter((a:Row)=>a.category==='expense'&&a.controlType==='none');
 const names=new Map((accounts.items||[]).map((a:Row)=>[a.id,a.code+' '+a.name]));
 return <>
  <ErrorPanel error={cmd.error||budgets.error||availError} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('budget.create')&&<section className="demo-card"><h2>Draft a budget version</h2><p>One bucket per expense account for the period, in the book's functional currency. Under a blocking policy an order beyond the available balance needs an authorized override with a recorded reason; a warning policy records the warning on the commitment.</p>
   <Editor id={'budget-new'+entityId} label="Save budget draft" resetOnSave onSave={async d=>{const lines=[1,2,3].filter(i=>d['account'+i]&&d['amount'+i]).map(i=>({accountId:d['account'+i],dimensions:{},amount:d['amount'+i]}));return !!await cmd.run('POST','/budgets',{entityId,body:{periodStart:d.periodStart,periodEnd:d.periodEnd,currency:'PHP',policy:d.policy,lines}});}}>
    {input('Period start','periodStart',monthStart(),'date',{required:true})}{input('Period end','periodEnd',monthEnd(),'date',{required:true})}{select('Policy','policy',[['block','Block beyond budget'],['warn','Warn beyond budget']],'block')}
    {[1,2,3].map(i=><div key={i} className="action-row"><label>Account {i}<select name={'account'+i}><option value="">—</option>{expense.map((a:Row)=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>{input('Amount '+i,'amount'+i,'','text',{inputMode:'decimal',pattern:'[0-9]{1,18}(\\.[0-9]{1,6})?'})}</div>)}
   </Editor></section>}
  <h2>Budget versions</h2>
  {budgets.items===null?<Loading/>:table(['Period','Policy','Buckets','State','Actions'],budgets.items.map((b:Row)=>[b.periodStart+' → '+b.periodEnd,b.policy,String(b.lines.length),b.state,<div key="a" className="action-row">
   <button type="button" onClick={()=>setOpen(open===b.id?null:b.id)}>{open===b.id?'Hide':'Budget vs actual'}</button>
   {b.state==='draft'&&can('budget.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/budgets/'+b.id+'/approve',{entityId,ifMatch:b.version,body:{decision:'approve',contentVersion:b.contentVersion}})}>Approve</button>}
   {b.state==='approved'&&can('budget.activate')&&<Editor id={'act'+b.id} label="Activate" onSave={async d=>!!await cmd.run('POST','/budgets/'+b.id+'/activate',{entityId,ifMatch:b.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}
  </div>]),'No budget yet.')}
  {open&&(avail===null?<Loading/>:<section className="demo-card"><h2>Budget versus actual and commitments · {avail.periodStart} → {avail.periodEnd} · {avail.policy}</h2>
   {table(['Account','Budget','Actual','Open commitments','Available','Warnings','Overrides'],avail.lines.map((l:Row)=>[l.code+' '+l.name,amount(l.budget),amount(l.actual),amount(l.committed),amount(l.available),String(l.warnings),String(l.overrides)]),'No bucket.')}
   <p>Available = approved budget − posted spend in the period − open commitments; a bill posting against its order consumes the commitment so nothing is counted twice.</p>
  </section>)}
  <h2>Commitments</h2>
  {commitments.items===null?<Loading/>:table(['Order','Line','Account','Amount','Consumed','State','Warning / override'],commitments.items.map((c:Row)=>[<a key="o" href={'/purchases/orders/'+c.sourceId}>{short(c.sourceId)}</a>,String(c.lineNo),names.get(c.accountId)||short(c.accountId),amount(c.amount),amount(c.consumed),c.state,c.overrideReason?'override: '+c.overrideReason:c.warning||'—']),'No commitment: approved purchase orders reserve one per line.')}
 </>;
}

// Allocation rules and runs.
export function Allocations({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('planning'))return <NotEnabled me={me}/>;
 const rules=useList('/allocation-rules',entityId,tick);
 const runs=useList('/allocation-runs',entityId,tick);
 const accounts=useList('/accounts',entityId,tick);
 const periods=useList('/periods',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [open,setOpen]=useState<string|null>(null),[lines,setLines]=useState<Row|null>(null),[linesError,setLinesError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setLines(null);if(!open)return;api('GET','/allocation-runs/'+open+'/lines',{entityId}).then(r=>{if(live){setLines(r.data);setLinesError(null);}}).catch(e=>{if(live)setLinesError(asError(e));});return()=>{live=false;};},[open,entityId,tick]);
 const expense=(accounts.items||[]).filter((a:Row)=>a.category==='expense'&&a.controlType==='none');
 const names=new Map((accounts.items||[]).map((a:Row)=>[a.id,a.code+' '+a.name]));
 return <>
  <ErrorPanel error={cmd.error||rules.error||runs.error||linesError} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('allocation_run.edit')&&<section className="demo-card"><h2>Draft an allocation rule version</h2><p>The pool is the posted balance of the source accounts in the period as of the cutoff; the drivers share it by weight into the target account per dimension value. The driver total must be positive; approval is by another principal.</p>
   <Editor id={'rule-new'+entityId} label="Save rule draft" resetOnSave onSave={async d=>{const sourceAccountIds=expense.filter((a:Row)=>d['s:'+a.id]==='on').map((a:Row)=>a.id);const drivers=[1,2,3].filter(i=>d['dv'+i]&&d['dw'+i]).map(i=>({dimensions:{[d.dimension||'cost_center']:d['dv'+i]},weight:d['dw'+i]}));return !!await cmd.run('POST','/allocation-rules',{entityId,body:{code:d.code,name:d.name,bookId:expense[0]?.bookId,sourceAccountIds,targetAccountId:d.targetAccountId,drivers,effectiveFrom:d.effectiveFrom}});}}>
    {input('Code','code','OVH','text',{required:true,pattern:'[A-Za-z0-9._-]{1,64}'})}{input('Name','name','Overhead allocation','text',{required:true})}{input('Effective from','effectiveFrom',today().slice(0,4)+'-01-01','date',{required:true})}
    <fieldset><legend>Source accounts (the pool)</legend>{expense.map((a:Row)=><label key={a.id}><input type="checkbox" name={'s:'+a.id}/> {a.code} {a.name}</label>)}</fieldset>
    <label>Target account<select name="targetAccountId" required><option value="">Select</option>{expense.map((a:Row)=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
    {input('Driver dimension','dimension','cost_center','text',{required:true,pattern:'[a-z][a-z0-9_]{0,31}'})}
    {[1,2,3].map(i=><div key={i} className="action-row">{input('Driver '+i+' value id','dv'+i,'','text',{pattern:'[0-9a-fA-F-]{36}'})}{input('Driver '+i+' weight','dw'+i,'','text',{inputMode:'decimal',pattern:'[0-9]{1,12}(\\.[0-9]{1,12})?'})}</div>)}
   </Editor></section>}
  <h2>Rule versions</h2>
  {rules.items===null?<Loading/>:table(['Code','Version','Name','Sources','Target','Drivers','State','Actions'],rules.items.map((r:Row)=>[r.code,'v'+r.versionNumber,r.name,r.sourceAccountIds.map((id:string)=>names.get(id)||short(id)).join(', '),names.get(r.targetAccountId)||short(r.targetAccountId),r.drivers.map((d:Row)=>Object.values(d.dimensions).map((v:any)=>short(String(v))).join('/')+' × '+d.weight).join('; '),r.state,<div key="a" className="action-row">{r.state==='draft'&&can('allocation_run.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/allocation-rules/'+r.id+'/approve',{entityId,ifMatch:r.version,body:{decision:'approve',contentVersion:1}})}>Approve rule</button>}</div>]),'No allocation rule yet.')}
  {can('allocation_run.create')&&<section className="demo-card"><h2>Start a run</h2>
   <Editor id={'run-new'+entityId} label="Create run" resetOnSave onSave={async d=>!!await cmd.run('POST','/allocation-runs',{entityId,body:{ruleVersionId:d.ruleVersionId,periodId:d.periodId,sourceCutoff:new Date(d.sourceCutoff+'T23:59:59Z').toISOString(),driverEvidenceId:d.driverEvidenceId}})}>
    <label>Rule version<select name="ruleVersionId" required><option value="">Select an approved rule</option>{(rules.items||[]).filter((r:Row)=>r.state==='approved').map((r:Row)=><option key={r.id} value={r.id}>{r.code} v{r.versionNumber}</option>)}</select></label>
    <label>Period<select name="periodId" required><option value="">Select</option>{(periods.items||[]).map((p:Row)=><option key={p.id} value={p.id}>{p.startsOn} → {p.endsOn} ({p.state})</option>)}</select></label>
    {input('Source cutoff (postings up to end of day)','sourceCutoff',today(),'date',{required:true})}
    <label>Driver evidence<select name="driverEvidenceId" required><option value="">Select evidence</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
   </Editor></section>}
  <h2>Runs</h2>
  {runs.items===null?<Loading/>:table(['Rule','Cutoff','State','Actions'],runs.items.map((r:Row)=>{const rule=(rules.items||[]).find((x:Row)=>x.id===r.ruleVersionId);return [rule?rule.code+' v'+rule.versionNumber:short(r.ruleVersionId),when(r.sourceCutoff),r.state,<div key="a" className="action-row">
   <button type="button" onClick={()=>setOpen(open===r.id?null:r.id)}>{open===r.id?'Hide lines':'Lines'}</button>
   {['draft','previewed'].includes(r.state)&&can('allocation_run.preview')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/allocation-runs/'+r.id+'/preview',{entityId,ifMatch:r.version,body:{}})}>Preview</button>}
   {r.state==='previewed'&&can('allocation_run.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/allocation-runs/'+r.id+'/approve',{entityId,ifMatch:r.version,body:{decision:'approve',contentVersion:r.contentVersion}})}>Approve</button>}
   {r.state==='approved'&&can('allocation_run.post')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/allocation-runs/'+r.id+'/post',{entityId,ifMatch:r.version,body:{}})}>Post</button>}
  </div>];}),'No run yet.')}
  {open&&(lines===null?<Loading/>:<section className="demo-card"><h2>Run lines · pool {amount(lines.pool)} · {lines.state}</h2>
   {table(['Source account','Amount'],lines.sources.map((s:Row)=>[s.code,amount(s.amount)]),'No source balance as of the cutoff.')}
   {table(['Target dimensions','Weight','Allocated','Residual'],lines.lines.map((l:Row)=>[Object.entries(l.dimensions).map(([k,v])=>k+'='+short(String(v))).join(', '),l.weight,amount(l.amount),l.residual?'carries the rounding residual':'—']),'No driver.')}
   <p>The allocated amounts sum exactly to the pool; the rounding residual sits on the first driver in stable order. A source posting after the preview changes the pool and the preview is redone before approval.{lines.entryId&&<> Posted as entry <code>{short(lines.entryId)}</code>.</>}</p>
  </section>)}
 </>;
}

// Projects: contract versions, milestones, advances, progress billing, retention, profitability.
export function Projects({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('planning'))return <NotEnabled me={me}/>;
 const projects=useList('/projects',entityId,tick);
 const parties=useList('/parties',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const collections=useList('/collections',entityId,tick);
 const cmd=useCommand(refresh);
 const [open,setOpen]=useState<string|null>(null);
 const [detail,setDetail]=useState<{milestones:Row[],versions:Row[],advances:Row[],retention:Row[],profit:Row}|null>(null),[detailError,setDetailError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setDetail(null);if(!open)return;Promise.all([api('GET','/projects/'+open+'/milestones',{entityId}),api('GET','/projects/'+open+'/change-orders',{entityId}),api('GET','/projects/'+open+'/advances',{entityId}),api('GET','/projects/'+open+'/retention',{entityId}),api('GET','/projects/'+open+'/profitability',{entityId})]).then(([m,v,a,r,p])=>{if(live){setDetail({milestones:m.data.items,versions:v.data.items,advances:a.data.items,retention:r.data.items,profit:p.data});setDetailError(null);}}).catch(e=>{if(live)setDetailError(asError(e));});return()=>{live=false;};},[open,entityId,tick]);
 const customers=(parties.items||[]).filter((p:Row)=>(p.roles||[]).includes('customer'));
 const project=(projects.items||[]).find((p:Row)=>p.id===open)||null;
 const cur=project?.currency||'PHP';
 const evidenceSelect=(name:string,label:string)=><label>{label}<select name={name} required><option value="">Select evidence</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>;
 return <>
  <ErrorPanel error={cmd.error||projects.error||detailError} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('project.create')&&<section className="demo-card"><h2>Open a project</h2><p>A customer contract with its evidence; the contract version needs approval before billing, and a change order is the next version.</p>
   <Editor id={'project-new'+entityId} label="Open project" resetOnSave onSave={async d=>!!await cmd.run('POST','/projects',{entityId,body:{code:d.code,customerId:d.customerId,contractAmount:d.contractAmount,currency:'PHP',evidenceIds:[d.evidenceId]}})}>
    {input('Code','code','','text',{required:true,pattern:'[A-Za-z0-9._-]{1,32}'})}<label>Customer<select name="customerId" required><option value="">Select</option>{customers.map((p:Row)=><option key={p.id} value={p.id}>{p.legalName}</option>)}</select></label>{input('Contract amount','contractAmount','','text',MONEY)}{evidenceSelect('evidenceId','Contract evidence')}
   </Editor></section>}
  <h2>Projects</h2>
  {projects.items===null?<Loading/>:table(['Code','Customer','Contract','State','Actions'],projects.items.map((p:Row)=>[p.code,customers.find((c:Row)=>c.id===p.customerId)?.legalName||short(p.customerId),amount(p.contractAmount,p.currency),p.state,<div key="a" className="action-row"><button type="button" onClick={()=>setOpen(open===p.id?null:p.id)}>{open===p.id?'Close':'Open'}</button></div>]),'No project yet.')}
  {project&&(detail===null?<Loading/>:<>
   <section className="demo-card"><h2>{project.code} · contract versions</h2>
    {table(['Version','Contract','Reason','State','Actions'],detail.versions.map((v:Row)=>[String(v.versionNumber),amount(v.contractAmount,cur),v.reason,v.state,<div key="a" className="action-row">{v.state==='draft'&&can('project.progress_billing')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/change-orders/'+v.id+'/approve',{entityId,ifMatch:v.version,body:{decision:'approve',contentVersion:1}})}>Approve version</button>}</div>]),'')}
    {can('project.edit')&&<Editor id={'co'+project.id} label="Draft change order" resetOnSave onSave={async d=>!!await cmd.run('POST','/projects/'+project.id+'/change-orders',{entityId,body:{contractAmount:d.contractAmount,reason:d.reason,evidenceIds:[d.evidenceId]}})}>{input('New contract amount','contractAmount','','text',MONEY)}{input('Reason','reason','','text',{required:true})}{evidenceSelect('evidenceId','Change order evidence')}</Editor>}
   </section>
   <section className="demo-card"><h2>Milestones</h2>
    {table(['#','Milestone','Amount','Certified','Billed','State','Actions'],detail.milestones.map((m:Row)=>[String(m.sequence),m.name,amount(m.amount,cur),amount(m.certifiedValue,cur),amount(m.billedValue,cur),m.state,<div key="a" className="action-row">{can('project.progress_billing')&&<Editor id={'cert'+m.id+m.version} label="Certify" onSave={async d=>!!await cmd.run('POST','/milestones/'+m.id+'/certify',{entityId,ifMatch:m.version,body:{certifiedValue:d.certifiedValue,evidenceIds:[d.evidenceId]}})}>{input('Certified value','certifiedValue',m.certifiedValue,'text',MONEY)}{evidenceSelect('evidenceId','Certificate')}</Editor>}</div>]),'No milestone yet.')}
    {can('project.edit')&&<Editor id={'ms'+project.id} label="Add milestone" resetOnSave onSave={async d=>!!await cmd.run('POST','/projects/'+project.id+'/milestones',{entityId,body:{name:d.name,amount:d.amount}})}>{input('Milestone','name','','text',{required:true})}{input('Amount','amount','','text',MONEY)}</Editor>}
   </section>
   <section className="demo-card"><h2>Advances</h2><p>A documented advance is a posted collection from the customer with an unapplied remainder; progress billing recoups it by allocation, never as revenue twice.</p>
    {table(['Collection','Amount','Recouped','Remaining'],detail.advances.map((a:Row)=>[short(a.collectionId),amount(a.amount,cur),amount(a.recouped,cur),amount(a.remaining,cur)]),'No advance recorded.')}
    {can('project.edit')&&<Editor id={'adv'+project.id} label="Record advance" resetOnSave onSave={async d=>!!await cmd.run('POST','/projects/'+project.id+'/advances',{entityId,body:{collectionId:d.collectionId,amount:d.amount}})}><label>Posted collection<select name="collectionId" required><option value="">Select</option>{(collections.items||[]).filter((c:Row)=>c.state==='posted'&&c.partyId===project.customerId).map((c:Row)=><option key={c.id} value={c.id}>{c.valueDate} · {c.currency} {c.grossAmount}</option>)}</select></label>{input('Amount','amount','','text',MONEY)}</Editor>}
   </section>
   {can('project.progress_billing')&&<section className="demo-card"><h2>Progress billing</h2><p>Bills the certified amount less retention on the milestone; the retention moves to its receivable and the advance is recouped when the invoice posts through the usual review.</p>
    <Editor id={'pb'+project.id} label="Draft progress invoice" resetOnSave onSave={async d=>!!await cmd.run('POST','/projects/'+project.id+'/progress-billing',{entityId,body:{milestoneId:d.milestoneId,certifiedAmount:d.certifiedAmount,retentionAmount:d.retentionAmount||'0.00',advanceRecoupment:d.advanceRecoupment||'0.00',accountingDate:d.accountingDate,evidenceIds:[d.evidenceId]}})}>
     <label>Milestone<select name="milestoneId" required><option value="">Select</option>{detail.milestones.filter((m:Row)=>Number(m.certifiedValue)>Number(m.billedValue)).map((m:Row)=><option key={m.id} value={m.id}>{m.sequence} {m.name} · certified {m.certifiedValue} · billed {m.billedValue}</option>)}</select></label>
     {input('Certified amount to bill','certifiedAmount','','text',MONEY)}{input('Retention held','retentionAmount','0.00','text',{inputMode:'decimal',pattern:'[0-9]{1,18}(\\.[0-9]{1,6})?'})}{input('Advance recoupment','advanceRecoupment','0.00','text',{inputMode:'decimal',pattern:'[0-9]{1,18}(\\.[0-9]{1,6})?'})}{input('Accounting date','accountingDate',today(),'date',{required:true})}{evidenceSelect('evidenceId','Progress certificate')}
    </Editor></section>}
   <section className="demo-card"><h2>Retention</h2>
    {table(['Invoice','Held','Released','Due condition','State','Actions'],detail.retention.map((r:Row)=>[<a key="i" href={'/sales/invoices/'+r.invoiceId}>{short(r.invoiceId)}</a>,amount(r.held,cur),amount(r.released,cur),r.dueCondition,r.state+(r.releaseInvoiceId&&r.state==='held'?' (release invoice drafted)':''),<div key="a" className="action-row">{r.state==='held'&&!r.releaseInvoiceId&&can('project.progress_billing')&&<Editor id={'rel'+r.id} label="Release" onSave={async d=>!!await cmd.run('POST','/retention-items/'+r.id+'/release',{entityId,ifMatch:r.version,body:{accountingDate:d.accountingDate,evidenceIds:[d.evidenceId],reason:d.reason}})}>{input('Accounting date','accountingDate',today(),'date',{required:true})}{input('Reason','reason','','text',{required:true})}{evidenceSelect('evidenceId','Acceptance evidence')}</Editor>}</div>]),'No retention held.')}
   </section>
   <section className="demo-card"><h2>Profitability</h2>
    <p role="status">Contract {amount(detail.profit.contractAmount,cur)} (v{detail.profit.contractVersion}) · certified {amount(detail.profit.certified,cur)} · billed {amount(detail.profit.billed,cur)} · retention held {amount(detail.profit.retentionHeld,cur)} · advances recouped {amount(detail.profit.advancesRecouped,cur)} of {amount(detail.profit.advances,cur)} · revenue posted {amount(detail.profit.revenuePosted,cur)} · cost posted {amount(detail.profit.costPosted,cur)} · margin {amount(detail.profit.margin,cur)}</p>
    <p>{detail.profit.workInProgressExcluded}</p>
   </section>
  </>)}
 </>;
}
