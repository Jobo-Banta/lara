"use client";
// P18 controlled extensibility. Reports: a builder over the allowlisted
// catalog (metrics, dimensions, filters, sort) with the cost budget shown,
// versions published by another principal and runs under the caller's scope
// with the aggregate over the entities in scope and a checksum; custom
// fields kept apart from statutory and accounting fields. Rules: proposals
// from cited issuances, the impact run over golden cases and affected
// profiles, independent approval. Tools: client grants (scoped, expiring,
// rate-limited), approval and revocation, the request log with denials.
// Packs: the reviewed catalog, installation as a job with the profile
// snapshot, upgrade paths and rollback. Nothing here runs client code.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,useList,Loading,input,select,when,type Row,type ApiError} from './workspace-kit';

type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
const today=()=>new Date().toISOString().slice(0,10);
const monthStart=()=>today().slice(0,8)+'01';
const short=(id?:string|null)=>id?id.slice(0,8):'—';
function NotEnabled({me,feature,after}:{me:Row,feature:string,after:string}){return <section className="demo-card"><h2>{feature} not enabled</h2><p>This feature release is activated per entity after {after}, once security and finance accept its allowlist, provider contracts and tests. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}
const evidenceSelect=(items:Row[]|null,name:string,label:string)=><label>{label}<select name={name} required><option value="">Select evidence</option>{(items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>;

// P18A reports and custom fields.
export function Reports({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('report_authoring'))return <NotEnabled me={me} feature="Report authoring" after="the general ledger"/>;
 const [catalog,setCatalog]=useState<Row|null>(null);
 useEffect(()=>{let live=true;api('GET','/report-catalog',{entityId}).then(r=>{if(live)setCatalog(r.data);}).catch(()=>{if(live)setCatalog({metrics:[],dimensions:[],budget:{}});});return()=>{live=false;};},[entityId,tick]);
 const definitions=useList('/report-definitions',entityId,tick,{detail:'1'});
 const fields=useList('/custom-fields',entityId,tick);
 const cmd=useCommand(refresh);
 const [run,setRun]=useState<Row|null>(null),[runError,setRunError]=useState<ApiError|null>(null),[runFor,setRunFor]=useState<string|null>(null);
 const runIt=async(id:string,periodStart:string,periodEnd:string)=>{setRun(null);setRunError(null);setRunFor(id);try{const r=await api('POST','/report-definitions/'+id+'/run',{entityId,body:{periodStart,periodEnd},key:crypto.randomUUID()});setRun(r.data);}catch(e){setRunError(asError(e));}};
 return <>
  <ErrorPanel error={cmd.error||definitions.error||runError} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <section className="demo-card"><h2>Catalog</h2><p>Reports name only these metrics and dimensions; the definition compiles to a parameterized query with no raw SQL, no joins beyond the catalog and no masked fields. Budget: {catalog?String(catalog.budget.maxRows)+' rows, cost '+catalog.budget.maxCost+', '+catalog.budget.timeoutMs+' ms':'…'}.</p>
   {catalog===null?<Loading/>:<>{table(['Metric','Unit','Needs'],catalog.metrics.map((m:Row)=>[m.id+' — '+m.label,m.unit,m.permission]),'')}{table(['Dimension','Filterable'],catalog.dimensions.map((d:Row)=>[d.id+' — '+d.label,d.filterable?'yes':'no']),'')}</>}
  </section>
  {can('report_definition.create')&&catalog&&<section className="demo-card"><h2>Build a report</h2>
   <Editor id={'rd-new'+entityId} label="Save definition draft" resetOnSave onSave={async d=>{const metricIds=catalog.metrics.filter((m:Row)=>d['m:'+m.id]==='on').map((m:Row)=>m.id);const dimensionIds=catalog.dimensions.filter((x:Row)=>d['d:'+x.id]==='on').map((x:Row)=>x.id);const filters=d.filterField&&d.filterValues?[{field:d.filterField,operator:d.filterOperator,values:String(d.filterValues).split(',').map(v=>v.trim()).filter(Boolean)}]:[];const sort=d.sortField?[{field:d.sortField,direction:d.sortDirection}]:[];return !!await cmd.run('POST','/report-definitions',{entityId,body:{name:d.name,metricIds,dimensionIds,filters,sort}});}}>
    {input('Name','name','','text',{required:true})}
    <fieldset><legend>Metrics</legend>{catalog.metrics.map((m:Row)=><label key={m.id}><input type="checkbox" name={'m:'+m.id}/> {m.label}</label>)}</fieldset>
    <fieldset><legend>Dimensions</legend>{catalog.dimensions.map((x:Row)=><label key={x.id}><input type="checkbox" name={'d:'+x.id}/> {x.label}</label>)}</fieldset>
    <div className="action-row">{select('Filter field','filterField',[['','—'],...catalog.dimensions.filter((x:Row)=>x.filterable).map((x:Row)=>[x.id,x.label] as [string,string])],'')}{select('Filter operator','filterOperator',[['eq','equals'],['in','in list'],['gte','at least'],['lte','at most']],'eq')}{input('Filter values (comma separated)','filterValues','','text')}</div>
    <div className="action-row">{input('Sort field','sortField','','text',{pattern:'[a-z_]{1,32}'})}{select('Sort direction','sortDirection',[['asc','ascending'],['desc','descending']],'asc')}</div>
   </Editor></section>}
  <h2>Definitions</h2>
  {definitions.items===null?<Loading/>:table(['Name','Version','Metrics','Dimensions','Cost','State','Actions'],definitions.items.map((r:Row)=>[r.name,'v'+r.versionNumber,r.metricIds.join(', '),r.dimensionIds.join(', ')||'—',String(r.cost??'—'),r.state,<div key="a" className="action-row">
   {r.state==='draft'&&can('report_definition.publish')&&<Editor id={'pub'+r.id} label="Publish" onSave={async d=>!!await cmd.run('POST','/report-definitions/'+r.id+'/publish',{entityId,ifMatch:r.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}
   {r.state==='published'&&can('report_definition.run')&&<Editor id={'run'+r.id} label="Run" onSave={async d=>{await runIt(r.id,d.periodStart,d.periodEnd);return true;}}>{input('Period start','periodStart',monthStart(),'date',{required:true})}{input('Period end','periodEnd',today(),'date',{required:true})}</Editor>}
  </div>]),'No report definition yet.')}
  {runFor&&(run===null?(runError?null:<Loading/>):<section className="demo-card"><h2>Result · {run.rowCount} rows · cost {run.cost} · checksum {String(run.checksum).slice(0,12)}…</h2>
   <p>Scope: {run.scopeEntityIds.length} entity(ies) · as of {when(run.asOf)}. The aggregate sums only the entities in your scope.</p>
   {table([...Object.keys(run.rows[0]?.dimensions||{}),...Object.keys(run.aggregate)],run.rows.map((row:Row)=>[...Object.values(row.dimensions).map(v=>String(v??'—')),...Object.keys(run.aggregate).map(m=>String(row.metrics[m]))]),'No row for the period.')}
   <p role="status">Aggregate: {Object.entries(run.aggregate).map(([k,v])=>k+' '+String(v)).join(' · ')}</p>
  </section>)}
  <section className="demo-card"><h2>Custom fields</h2><p>Custom fields never replace statutory or accounting fields and never bypass validation; publication is by another principal.</p>
   {fields.items===null?<Loading/>:table(['Resource','Key','Label','Type','Visibility','State','Actions'],fields.items.map((f:Row)=>[f.resourceType,f.key,f.label,f.fieldType,f.visibility,f.state,<div key="a" className="action-row">{f.state==='draft'&&can('custom_field.publish')&&<Editor id={'pf'+f.id} label="Publish" onSave={async d=>!!await cmd.run('POST','/custom-fields/'+f.id+'/publish',{entityId,ifMatch:f.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No custom field yet.')}
   {can('custom_field.create')&&<Editor id={'cf-new'+entityId} label="Save custom field" resetOnSave onSave={async d=>!!await cmd.run('POST','/custom-fields',{entityId,body:{resourceType:d.resourceType,key:d.key,label:d.label,fieldType:d.fieldType,validation:d.choices?{choices:String(d.choices).split(',').map(x=>x.trim()).filter(Boolean)}:{},visibility:d.visibility}})}>
    {select('Resource','resourceType',[['party','Party'],['document','Document'],['journal','Journal'],['asset','Asset'],['project','Project']],'party')}{input('Key (cf_…)','key','cf_','text',{required:true,pattern:'cf_[a-z][a-z0-9_]{1,31}'})}{input('Label','label','','text',{required:true})}{select('Type','fieldType',[['text','Text'],['number','Number'],['date','Date'],['boolean','Yes/no'],['choice','Choice']],'text')}{input('Choices (comma separated, for choice fields)','choices','','text')}{select('Visibility','visibility',[['internal','Internal'],['portal','Portal'],['masked','Masked']],'internal')}
   </Editor>}
  </section>
 </>;
}

// P18B rule proposals.
export function RuleProposals({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('rule_proposals'))return <NotEnabled me={me} feature="Rule proposals" after="compliance"/>;
 const proposals=useList('/rule-proposals',entityId,tick);
 const rules=useList('/tax-rules',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [open,setOpen]=useState<string|null>(null),[impact,setImpact]=useState<Row|null>(null),[impactError,setImpactError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setImpact(null);if(!open)return;api('GET','/rule-proposals/'+open+'/impact',{entityId}).then(r=>{if(live){setImpact(r.data);setImpactError(null);}}).catch(e=>{if(live)setImpactError(asError(e));});return()=>{live=false;};},[open,entityId,tick]);
 return <>
  <ErrorPanel error={cmd.error||proposals.error||impactError} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <p>A proposal cites the issuance, names the affected profile versions, the draft rule versions it proposes and the golden cases that must pass. The impact run recomputes the cases with the proposed rules and counts the open periods and posted documents affected; approval is independent and never rewrites history. Activation stays a separate step with a software release assessment.</p>
  {can('rule_proposal.create')&&<section className="demo-card"><h2>Draft a proposal</h2>
   <Editor id={'rp-new'+entityId} label="Save proposal" resetOnSave onSave={async d=>!!await cmd.run('POST','/rule-proposals',{entityId,body:{sourceEvidenceIds:[d.evidenceId],affectedProfileIds:String(d.profileIds).split(/[\s,]+/).filter(Boolean),proposedRuleIds:(rules.items||[]).filter((r:Row)=>d['r:'+r.id]==='on').map((r:Row)=>r.id),goldenCaseIds:String(d.caseIds).split(/[\s,]+/).filter(Boolean),...(d.summary?{summary:d.summary}:{})}})}>
    {evidenceSelect(evidence.items,'evidenceId','Issuance (source evidence)')}{input('Affected profile version ids (settings versions, comma separated)','profileIds','','text',{required:true})}
    <fieldset><legend>Proposed rule versions (drafts)</legend>{(rules.items||[]).filter((r:Row)=>r.state!=='active').map((r:Row)=><label key={r.id}><input type="checkbox" name={'r:'+r.id}/> {r.code} v{r.versionNumber} · {r.rate} · {r.state}</label>)}</fieldset>
    {input('Golden case ids (comma separated)','caseIds','AC-01','text',{required:true})}{input('Summary','summary','','text')}
   </Editor></section>}
  <h2>Proposals</h2>
  {proposals.items===null?<Loading/>:table(['Summary','Rules','Cases','Impact','State','Actions'],proposals.items.map((p:Row)=>[p.summary||short(p.id),String(p.proposedRuleIds.length),p.goldenCaseIds.join(', '),p.impactPassed==null?'not assessed':p.impactPassed?'all cases pass':'a case fails',p.state,<div key="a" className="action-row">
   <button type="button" onClick={()=>setOpen(open===p.id?null:p.id)}>{open===p.id?'Hide impact':'Impact'}</button>
   {['draft','assessed'].includes(p.state)&&can('rule_proposal.impact')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/rule-proposals/'+p.id+'/impact',{entityId,ifMatch:p.version,body:{}})}>Assess impact</button>}
   {p.state==='assessed'&&can('rule_proposal.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/rule-proposals/'+p.id+'/approve',{entityId,ifMatch:p.version,body:{decision:'approve',contentVersion:p.contentVersion}})}>Approve</button>}
   {p.state==='assessed'&&can('rule_proposal.approve')&&<Editor id={'rej'+p.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/rule-proposals/'+p.id+'/approve',{entityId,ifMatch:p.version,body:{decision:'reject',contentVersion:p.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}
  </div>]),'No proposal yet.')}
  {open&&(impact===null?(impactError?null:<Loading/>):<section className="demo-card"><h2>Impact · {impact.passed==null?'not assessed':impact.passed?'passed':'failed'}</h2>
   {table(['Case','Rule','Expected','Actual','Passed','Reason'],impact.cases.map((c:Row)=>[c.caseId,short(c.ruleVersionId),JSON.stringify(c.expected),JSON.stringify(c.actual),c.passed?'yes':'no',c.reason||'—']),'No case assessed yet.')}
   {table(['Profile','Kind','Version','Open periods','Posted documents'],impact.profiles.map((p:Row)=>[short(p.profileId),p.kind,String(p.versionNumber),String(p.openPeriods),String(p.postedDocuments)]),'')}
   <p>History unchanged: {impact.historyUnchanged?'yes — posted documents keep the rule version that applied at their date':'no'}.</p>
  </section>)}
 </>;
}

// P18C tool grants and runs.
export function ToolGrants({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('client_tools'))return <NotEnabled me={me} feature="Client draft tools" after="AI assistance"/>;
 const grants=useList('/tool-grants',entityId,tick);
 const runs=useList('/tool-runs',entityId,tick);
 const cmd=useCommand(refresh);
 return <>
  <ErrorPanel error={cmd.error||grants.error||runs.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <p>A client integration is a scoped identity without membership: its grant names the tools (read reports, read evidence metadata, propose drafts, propose tasks), the entities, an expiry within a year and a rate limit; approval is by another principal and a grant never widens. Every request is logged; anything beyond reading and proposing is denied and kept as evidence. Nothing posts, approves, pays, files or sends.</p>
  {can('tool_grant.create')&&<section className="demo-card"><h2>Draft a grant</h2>
   <Editor id={'tg-new'+entityId} label="Save grant draft" resetOnSave onSave={async d=>!!await cmd.run('POST','/tool-grants',{entityId,body:{clientId:d.clientId,tools:['read_report','read_evidence','propose_draft','propose_task'].filter(t=>d['t:'+t]==='on'),entityIds:[entityId],expiresAt:new Date(d.expiresAt+'T23:59:59Z').toISOString(),rateLimitPerMinute:Number(d.rate||60)}})}>
    {input('Client principal id','clientId','','text',{required:true,pattern:'[0-9a-fA-F-]{36}'})}
    <fieldset><legend>Tools</legend>{[['read_report','Read published reports'],['read_evidence','Read evidence metadata'],['propose_draft','Propose journal drafts (as tasks)'],['propose_task','Propose tasks']].map(([t,l])=><label key={t}><input type="checkbox" name={'t:'+t} defaultChecked={t==='read_report'}/> {l}</label>)}</fieldset>
    {input('Expires on','expiresAt','','date',{required:true})}{input('Rate limit per minute','rate','60','number',{min:1,max:600})}
   </Editor></section>}
  <h2>Grants</h2>
  {grants.items===null?<Loading/>:table(['Client','Tools','Expires','Rate','State','Actions'],grants.items.map((g:Row)=>[short(g.clientId),g.tools.join(', '),when(g.expiresAt),String(g.rateLimitPerMinute)+'/min',g.state+(g.revokedReason?' · '+g.revokedReason:''),<div key="a" className="action-row">
   {g.state==='draft'&&can('tool_grant.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/tool-grants/'+g.id+'/approve',{entityId,ifMatch:g.version,body:{decision:'approve',contentVersion:g.contentVersion}})}>Approve</button>}
   {['draft','approved'].includes(g.state)&&can('tool_grant.revoke')&&<Editor id={'rv'+g.id} label="Revoke" onSave={async d=>!!await cmd.run('POST','/tool-grants/'+g.id+'/revoke',{entityId,ifMatch:g.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}
  </div>]),'No grant yet.')}
  <h2>Requests</h2>
  {runs.items===null?<Loading/>:table(['When','Grant','Tool','Outcome','Reason','Result'],runs.items.map((r:Row)=>[when(r.createdAt),short(r.grantId),r.tool,r.outcome,r.reason||'—',r.resultResourceType?r.resultResourceType+' '+short(r.resultResourceId):'—']),'No request yet.')}
 </>;
}

// P18D industry packs.
export function Packs({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('industry_packs'))return <NotEnabled me={me} feature="Industry packs" after="the general ledger"/>;
 const [catalog,setCatalog]=useState<Row[]|null>(null);
 useEffect(()=>{let live=true;api('GET','/packs',{entityId}).then(r=>{if(live)setCatalog(r.data.items);}).catch(()=>{if(live)setCatalog([]);});return()=>{live=false;};},[entityId,tick]);
 const installs=useList('/pack-installs',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [job,setJob]=useState<Row|null>(null);
 useEffect(()=>{if(!job||['succeeded','failed','dead_letter'].includes(job.state))return;const t=setTimeout(()=>{api('GET','/jobs/'+job.id,{entityId}).then(r=>{setJob(r.data);if(['succeeded','failed','dead_letter'].includes(r.data.state))refresh();}).catch(()=>{});},1500);return()=>clearTimeout(t);},[job,entityId,refresh]);
 const installed=(installs.items||[]).filter((p:Row)=>p.state==='installed');
 return <>
  <ErrorPanel error={cmd.error||installs.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <p>Packs ship with the release as reviewed configuration (settings drafts and report definitions), never customer forks or runtime code. Installation checks the manifest hash against the catalog and the dependencies, keeps a snapshot of the profiles it touches and runs as a job; upgrades follow the declared paths only; rollback restores the snapshot as new drafts and never changes financial facts.</p>
  <h2>Catalog</h2>
  {catalog===null?<Loading/>:table(['Pack','Version','Title','Dependencies','Upgrades from','Actions'],catalog.map((p:Row)=>{const cur=installed.find((i:Row)=>i.packId===p.packId);const allowed=cur?(cur.version!==p.version&&p.upgradesFrom.includes(cur.version)):p.upgradesFrom.length===0;return [p.packId,p.version,p.title,p.dependencies.join(', ')||'—',p.upgradesFrom.join(', ')||'—',<div key="a" className="action-row">{can('pack.install')&&(allowed?<Editor id={'inst'+p.packId+p.version} label={cur?'Upgrade':'Install'} onSave={async d=>{const r=await cmd.run('POST','/packs/install',{entityId,body:{packId:p.packId,version:p.version,manifestHash:p.manifestHash,evidenceIds:[d.evidenceId]}});if(r)setJob(r.data);return !!r;}}>{evidenceSelect(evidence.items,'evidenceId','Review evidence')}</Editor>:<span>{cur?.version===p.version?'installed':'unsupported path — disabled'}</span>)}</div>];}),'No pack in the catalog.')}
  {job&&<p role="status">Pack job {short(job.id)}: {job.state}</p>}
  <h2>Installed versions</h2>
  {installs.items===null?<Loading/>:table(['Pack','Version','State','Applied','Actions'],installs.items.map((p:Row)=>[p.packId,p.version,p.state+(p.failureReason?' · '+p.failureReason:''),(Object.keys(p.applied?.settings||{}).length+' setting(s), '+(p.applied?.reportDefinitions?.length||0)+' report(s)'),<div key="a" className="action-row">{p.state==='installed'&&can('pack.install')&&<Editor id={'rb'+p.id} label="Roll back" onSave={async d=>{const r=await cmd.run('POST','/pack-installs/'+p.id+'/rollback',{entityId,ifMatch:p.versionNo,body:{reason:d.reason}});if(r)setJob(r.data);return !!r;}}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No pack installed.')}
 </>;
}
