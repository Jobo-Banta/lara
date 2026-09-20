"use client";
// P12 evidence-backed AI assistance: the feature switches with their
// evaluations, a run request over the evidence and records the requester may
// see, the run history with every tool call (allowed or denied), and the
// source/draft split view where a named reviewer accepts, edits or rejects
// each suggestion field by field with its evidence and uncertainty marker.
// Ask-your-books shows the scope banner and the report the number came from.
// Nothing here posts, sends or files; the accepted draft feeds the normal
// command the reviewer issues next.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,when,type Row,type ApiError} from './workspace-kit';
import {useBookId} from './workspace-ledger';

const short=(id?:string|null)=>id?id.slice(0,8):'—';
const FEATURES:[string,string][]=[['capture','Bill and receipt capture'],['coding','Smart coding'],['matching','Bank matching'],['explain','Explain a finding'],['ask_books','Ask your books'],['close_draft','Close draft'],['audit_pack','Audit request pack'],['registration_draft','Registration draft']];
const label=(f:string)=>FEATURES.find(([k])=>k===f)?.[1]||f;
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Assistance not enabled</h2><p>The AI assistance capability is activated per entity after compliance, once privacy and security approve the provider region, retention and training terms and Finance accepts the evaluation results. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capability activation.</a>:'Ask the controller to request activation.'}</p></section>;}

export function Assistant({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('ai_assistance'))return <NotEnabled me={me}/>;
 const features=useList('/assistant/features',entityId,tick);
 const runs=useList('/assistant/runs',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const {bookId}=useBookId(entityId,tick,me);
 const periods=useList('/periods',entityId,tick,bookId?{bookId}:{});
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [feature,setFeature]=useState('capture');
 const [open,setOpen]=useState<string|null>(null),[suggestion,setSuggestion]=useState<Row|null>(null);
 const [edits,setEdits]=useState<Record<string,string>>({});
 useEffect(()=>{if(!open){setSuggestion(null);return;}setSuggestion(null);setEdits({});api('GET','/assistant/suggestions/'+open,{entityId}).then(r=>setSuggestion(r.data)).catch(e=>setError(asError(e)));},[open,tick]);
 const enabled=(features.items||[]).filter(f=>f.enabled).map(f=>f.feature);
 const evidenceName=(id:string)=>(evidence.items||[]).find((e:Row)=>e.id===id)?.filename||short(id);
 const needsQuestion=feature==='ask_books';
 return <>
  <ErrorPanel error={error||cmd.error||runs.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <section className="demo-card"><h2>Features</h2><p>Each feature is switched on per company only behind a passing, Finance-accepted evaluation of the exact model and prompt versions; switching it off never touches accounting records. Deterministic controls stay authoritative: the assistant drafts, explains and answers from canonical reports, and a named person decides.</p>
   {features.items===null?<Loading/>:table(['Feature','Model / prompt','Evaluation','Budget','State','Actions'],features.items.map(f=>[label(f.feature),f.modelVersion+' / '+f.promptVersion,f.evaluation?(f.evaluation.passed?'passed':'failed')+' on '+f.evaluation.itemCount+' items'+(f.evaluation.acceptedBy?', accepted':''):'none',f.budgetMinor?'₱'+(f.spentMinor/100).toFixed(2)+' of ₱'+(f.budgetMinor/100).toFixed(2):'no cap',f.enabled?'on':'off',can('assistant.review')?<Editor key="t" id={'feat'+f.feature+entityId} label={f.enabled?'Switch off':'Switch on'} onSave={async d=>!!await cmd.run('PATCH','/assistant/features/'+f.feature,{entityId,ifMatch:f.version,body:{enabled:!f.enabled,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>:'—']),'No feature is configured. An operator records the model, prompt and tool schema versions, the budget and the provider policy; Finance accepts the evaluation.')}
  </section>
  {can('assistant.suggest')&&<section className="demo-card"><h2>New request</h2><p>The assistant reads only the evidence and records you can read yourself; documents are data, never instructions. Numbers come from the canonical report of the stated scope. Poor or missing evidence makes it abstain.</p><Editor id={'ai-run'+entityId+feature} label="Request suggestion" resetOnSave onSave={async d=>{const evidenceIds=Object.entries(d).filter(([k,v])=>k.startsWith('ev:')&&v==='on').map(([k])=>k.slice(3));const resourceIds=String(d.resourceIds||'').split(',').map(s=>s.trim()).filter(Boolean);const period=(periods.items||[]).find((p:Row)=>p.id===d.periodId);const body:Row={feature,evidenceIds,resourceIds,...(d.question?{question:d.question}:{}),...(needsQuestion&&period&&bookId?{reportRequest:{reportType:'trial_balance',bookId,periodStart:period.startsOn,periodEnd:period.endsOn,asOf:new Date(period.endsOn+'T23:59:59Z').toISOString(),currency:d.currency||'PHP',format:'json'}}:{})};return !!await cmd.run('POST','/assistant/runs',{entityId,body});}}>
   <label>Feature<select name="feature" value={feature} onChange={e=>setFeature(e.target.value)}>{FEATURES.map(([k,l])=><option key={k} value={k} disabled={!enabled.includes(k)}>{l}{enabled.includes(k)?'':' (off)'}</option>)}</select></label>
   {needsQuestion?<>{input('Question','question','','text',{required:true,placeholder:'What are the total debits? Balance of account 1010?'})}<label>Period<select name="periodId" required><option value="">Select period</option>{(periods.items||[]).map((p:Row)=><option key={p.id} value={p.id}>{p.startsOn.slice(0,7)} ({p.state})</option>)}</select></label>{input('Currency','currency','PHP','text',{pattern:'[A-Z]{3}'})}</>:<>
    <fieldset><legend>Evidence</legend>{(evidence.items||[]).map((e:Row)=><label key={e.id}><input type="checkbox" name={'ev:'+e.id}/> {e.filename}</label>)}{!(evidence.items||[]).length&&<p>No available evidence.</p>}</fieldset>
    {input('Record ids (comma separated: bill, statement line, task or period)','resourceIds','','text')}
   </>}
  </Editor></section>}
  <h2>Run history</h2>
  {runs.items===null?<Loading/>:table(['Requested','Feature','Model','State','Tool calls','Cost','Suggestion'],runs.items.map(r=>[when(r.createdAt),label(r.feature),r.modelVersion,r.state+(r.errorCode?' · '+r.errorCode:''),r.toolCalls.length+' ('+r.toolCalls.filter((c:Row)=>!c.allowed).length+' denied)','₱'+(r.costMinor/100).toFixed(2),r.suggestionId?<button key="o" type="button" onClick={()=>setOpen(open===r.suggestionId?null:r.suggestionId)}>{open===r.suggestionId?'Hide':'Review'}</button>:'—']),'No runs yet.')}
  {open&&<section className="demo-card"><h2>Review</h2>{suggestion===null?<Loading/>:<>
   <p>{label(suggestion.feature)} · {suggestion.state} · model {suggestion.modelVersion} · overall uncertainty <strong>{suggestion.uncertainty}</strong>{suggestion.reviewerId?' · reviewed ('+suggestion.reviewDecision+')':''}</p>
   {suggestion.scopeBanner&&<p role="status"><strong>Scope:</strong> {suggestion.scopeBanner}</p>}
   {suggestion.state==='abstained'&&<p role="status"><strong>Abstained.</strong> {suggestion.answer} Continue manually; nothing was drafted.</p>}
   {suggestion.answer&&suggestion.state!=='abstained'&&<p><strong>Answer:</strong> {suggestion.answer}</p>}
   <div className="split-panel">
    <section aria-label="Source"><h3>Source</h3>{suggestion.sources.length>0&&<ul>{suggestion.sources.map((s:Row,i:number)=><li key={i}>{s.kind}: {s.href?link(s.href,s.label):s.label}</li>)}</ul>}<ul>{[...new Set(suggestion.fields.map((f:Row)=>f.evidenceId).filter(Boolean))].map((id)=><li key={String(id)}>{link('/evidence',evidenceName(String(id)))}</li>)}</ul>{!suggestion.sources.length&&!suggestion.fields.some((f:Row)=>f.evidenceId)&&<p>No source.</p>}</section>
    <section aria-label="Draft"><h3>Draft</h3>{table(['Field','Value','Evidence','Locator','Uncertainty'],suggestion.fields.map((f:Row)=>[f.path,suggestion.state==='proposed'&&can('assistant.review')?<input key="v" aria-label={'Value of '+f.path} value={edits[f.path]??(f.value===null?'':String(f.value))} onChange={e=>setEdits(x=>({...x,[f.path]:e.target.value}))}/>:String(f.value??'—'),f.evidenceId?evidenceName(f.evidenceId):'report',f.sourceLocator,f.uncertainty==='low'?'low':<strong key="u">{f.uncertainty} ⚠</strong>]),'No fields proposed.')}</section>
   </div>
   {suggestion.state==='proposed'&&can('assistant.review')&&<div className="action-row">
    <Editor id={'acc'+suggestion.id} label="Accept as proposed" onSave={async d=>!!await cmd.run('POST','/assistant/suggestions/'+suggestion.id+'/review',{entityId,ifMatch:suggestion.version,body:{decision:'accept',fieldChanges:[],...(d.reason?{reason:d.reason}:{})}})}>{input('Reason (required when a field is uncertain)','reason','','text')}</Editor>
    <Editor id={'edit'+suggestion.id} label="Accept with edits" onSave={async d=>{const fieldChanges=Object.entries(edits).filter(([p,v])=>{const f=suggestion.fields.find((x:Row)=>x.path===p);return f&&String(f.value??'')!==v;}).map(([path,value])=>({path,value}));return !!await cmd.run('POST','/assistant/suggestions/'+suggestion.id+'/review',{entityId,ifMatch:suggestion.version,body:{decision:'edit',fieldChanges,...(d.reason?{reason:d.reason}:{})}});}}>{input('Reason','reason','','text')}</Editor>
    <Editor id={'rej'+suggestion.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/assistant/suggestions/'+suggestion.id+'/review',{entityId,ifMatch:suggestion.version,body:{decision:'reject',fieldChanges:[],reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>
   </div>}
   {suggestion.fieldChanges.length>0&&<p>Edits: {suggestion.fieldChanges.map((c:Row)=>c.path+' → '+String(c.value)).join('; ')}{suggestion.reviewReason?' · '+suggestion.reviewReason:''}</p>}
  </>}</section>}
 </>;
}
