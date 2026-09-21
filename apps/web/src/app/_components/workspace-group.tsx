"use client";
// P15 intercompany and consolidation. Group setup in the reporting entity
// (members under the full method, account mapping versions drafted from the
// member charts and approved by a second principal, rate sets from source
// evidence); intercompany pairs raised in the source entity and accepted,
// posted or refused in the target under its own authority with the
// exception state on screen; member-close readiness; consolidation runs
// previewed into a worksheet (translation with its rates, eliminations,
// unresolved differences, consolidated statements with member and
// elimination drill-down), approved and published. Nothing here writes a
// subsidiary ledger; the reporting book receives the published snapshot.
import {useEffect,useMemo,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,useList,Loading,input,select,type Row,type ApiError} from './workspace-kit';
import {amount} from './workspace-fx';

type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
const today=()=>new Date().toISOString().slice(0,10);
const monthEnd=()=>{const d=new Date();return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).toISOString().slice(0,10);};
const short=(id?:string|null)=>id?id.slice(0,8):'—';
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Group accounting not enabled</h2><p>The group accounting capability is activated per reporting entity after multi-currency and assets, with the controller's approval of ownership, method, account mappings and rate policies. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capabilities</a>:'Ask a controller to activate it.'}</p></section>;}
// Entities are tenant-scoped: the members a group may name.
function useEntities(tick:number){
 const [items,setItems]=useState<Row[]|null>(null);
 useEffect(()=>{let live=true;api('GET','/entities?limit=200').then(r=>{if(live)setItems(r.data.items);}).catch(()=>{if(live)setItems([]);});return()=>{live=false;};},[tick]);
 return {items};
}
function useGroup(entityId:string,tick:number){
 const list=useList('/groups',entityId,tick);
 return {group:list.items?.find((g:Row)=>g.state!=='archived')||null,loaded:list.items!==null,error:list.error};
}

// Group, members, mappings and rate sets.
export function GroupSetup({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('group_accounting'))return <NotEnabled me={me}/>;
 const {group,loaded,error}=useGroup(entityId,tick);
 const entities=useEntities(tick);
 const cmd=useCommand(refresh);
 const [mappings,setMappings]=useState<Row[]|null>(null);
 useEffect(()=>{let live=true;if(!group){setMappings(null);return;}api('GET','/groups/'+group.id+'/mappings',{entityId}).then(r=>{if(live)setMappings(r.data.items);}).catch(()=>{if(live)setMappings([]);});return()=>{live=false;};},[group?.id,entityId,tick]);
 const rateSets=useList('/rate-sets',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const currencies=useList('/currencies',entityId,tick);
 const codes=(currencies.items||[]).map((c:Row)=>[c.code,c.code+' · '+c.name] as [string,string]);
 const names=useMemo(()=>new Map((entities.items||[]).map((e:Row)=>[e.id,e.legalName])),[entities.items]);
 const memberOptions=(entities.items||[]).filter((e:Row)=>e.state!=='archived');
 // A mapping version drafted from the member charts: every account maps to a group account of the same code and category; roles by account code apply across members.
 async function draftMapping(d:Row){
  if(!group)return false;
  const roleFor=(code:string)=>{for(const [role,key] of [['intercompany_receivable','icReceivable'],['intercompany_payable','icPayable'],['intercompany_revenue','icRevenue'],['intercompany_expense','icExpense'],['retained_earnings','retained'],['translation_reserve','reserve']]){const list=String(d[key]||'').split(',').map(s=>s.trim()).filter(Boolean);if(list.includes(code))return role;}return null;};
  const entries:Row[]=[];
  for(const m of group.members){const r=await api('GET','/accounts?limit=200',{entityId:m.entityId});for(const a of r.data.items as Row[]){if(a.state==='archived')continue;entries.push({memberEntityId:m.entityId,accountId:a.id,groupAccountCode:'G'+a.code,groupAccountName:a.name,groupCategory:a.category,role:roleFor(a.code)});}}
  return !!await cmd.run('POST','/groups/'+group.id+'/mappings',{entityId,body:{mappingVersion:d.mappingVersion,entries}});
 }
 return <>
  <ErrorPanel error={cmd.error||error||rateSets.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <section className="demo-card"><h2>Group</h2>
   {!loaded?<Loading/>:group?<>
    <p><strong>{group.name}</strong> · reporting currency {group.reportingCurrency} · state <strong>{group.state}</strong>. Consolidation writes only the group's own reporting book; member ledgers stay untouched.</p>
    {table(['Member','Ownership','Method','Effective from'],group.members.map((m:Row)=>[names.get(m.entityId)||short(m.entityId),m.ownershipPercent+'%',m.method,m.effectiveFrom]),'')}
    {group.state==='draft'&&can('group.activate')&&<Editor id={'act'+group.id} label="Activate group" onSave={async d=>!!await cmd.run('POST','/groups/'+group.id+'/activate',{entityId,ifMatch:group.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}<p>Activation approves the ownership, method and mapping basis; it needs an approved mapping version and a principal other than the definer.</p></Editor>}
   </>:can('group.create')?<><p>No group is defined for this reporting entity. Members are wholly owned under the full method; partial ownership or the equity method needs an approved extension before a member can join.</p>
    <Editor id={'group-new'+entityId} label="Define group" onSave={async d=>{const members=memberOptions.filter((e:Row)=>d['m:'+e.id]==='on').map((e:Row)=>({entityId:e.id,ownershipPercent:'100',method:'full',effectiveFrom:d.effectiveFrom}));return !!await cmd.run('POST','/groups',{entityId,body:{name:d.name,reportingCurrency:d.reportingCurrency,members}});}}>
     {input('Group name','name','','text',{required:true})}{select('Reporting currency','reportingCurrency',codes.length?codes:[['PHP','PHP']],'PHP')}{input('Effective from','effectiveFrom',today().slice(0,4)+'-01-01','date',{required:true})}
     <fieldset><legend>Members (100%, full method)</legend>{memberOptions.map((e:Row)=><label key={e.id}><input type="checkbox" name={'m:'+e.id} defaultChecked={e.id===entityId}/> {e.legalName}</label>)}</fieldset>
    </Editor></>:<p>No group is defined for this reporting entity.</p>}
  </section>
  {group&&<section className="demo-card"><h2>Account mappings</h2>
   <p>Each version maps every member account to a group account and names the intercompany, retained earnings and translation reserve roles; approved versions are immutable and a run names the version it used.</p>
   {mappings===null?<Loading/>:table(['Version','Entries','State','Actions'],mappings.map((v:Row)=>[v.mappingVersion,String(v.entries.length),v.state,<div key="a" className="action-row">{v.state==='draft'&&can('group.activate')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/group-mappings/'+v.id+'/approve',{entityId,ifMatch:v.version,body:{decision:'approve',contentVersion:1}})}>Approve mapping</button>}{v.state==='draft'&&can('group.activate')&&<Editor id={'rejm'+v.id} label="Reject" onSave={async d=>!!await cmd.run('POST','/group-mappings/'+v.id+'/approve',{entityId,ifMatch:v.version,body:{decision:'reject',contentVersion:1,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No mapping version yet.')}
   {can('group.edit')&&group.state!=='archived'&&<Editor id={'map-new'+group.id} label="Draft mapping from member charts" resetOnSave onSave={draftMapping}>
    {input('Mapping version','mappingVersion',today().slice(0,4)+'.1','text',{required:true,pattern:'[A-Za-z0-9._-]{1,64}'})}
    {input('Intercompany receivable account codes','icReceivable','','text')}{input('Intercompany payable account codes','icPayable','','text')}{input('Intercompany revenue account codes','icRevenue','','text')}{input('Intercompany expense account codes','icExpense','','text')}{input('Retained earnings account codes','retained','','text')}{input('Translation reserve account codes','reserve','','text')}
    <p>Comma-separated member account codes; every other account maps to a group account of the same code and category.</p>
   </Editor>}
  </section>}
  {group&&<section className="demo-card"><h2>Rate sets</h2>
   <p>Closing, average and historical rates in {group.reportingCurrency} per one unit of each member currency for a period end, from the source publication; approval by another principal. Balance sheets translate at closing, income at the approved period average, equity at historical; nothing defaults to 1.</p>
   {rateSets.items===null?<Loading/>:table(['Code','Period end','Rates','State','Actions'],rateSets.items.map((r:Row)=>[r.code,r.periodEnd,r.rates.map((x:Row)=>x.currency+' '+x.closing+'/'+x.average+'/'+x.historical).join('; ')||'reporting currency only',r.state,<div key="a" className="action-row">{r.state==='draft'&&can('consolidation.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/rate-sets/'+r.id+'/approve',{entityId,ifMatch:r.version,body:{decision:'approve',contentVersion:r.contentVersion}})}>Approve rate set</button>}</div>]),'No rate set yet.')}
   {can('consolidation.edit')&&<Editor id={'rs-new'+group.id} label="Save rate set" resetOnSave onSave={async d=>{const rates=d.currency?[{currency:d.currency,closing:d.closing,average:d.average,historical:d.historical}]:[];return !!await cmd.run('POST','/rate-sets',{entityId,body:{code:d.code,periodEnd:d.periodEnd,rates,sourceEvidenceId:d.sourceEvidenceId}});}}>
    {input('Code','code',monthEnd().slice(0,7),'text',{required:true,pattern:'[A-Za-z0-9._-]{1,64}'})}{input('Period end','periodEnd',monthEnd(),'date',{required:true})}
    {select('Member currency (leave blank when every member reports in '+group.reportingCurrency+')','currency',[['','—'],...codes.filter(([c])=>c!==group.reportingCurrency)],'')}
    {input('Closing rate','closing','','text',{inputMode:'decimal',pattern:'[0-9]{1,12}(\\.[0-9]{1,12})?'})}{input('Average rate','average','','text',{inputMode:'decimal',pattern:'[0-9]{1,12}(\\.[0-9]{1,12})?'})}{input('Historical rate','historical','','text',{inputMode:'decimal',pattern:'[0-9]{1,12}(\\.[0-9]{1,12})?'})}
    <label>Source evidence<select name="sourceEvidenceId" required><option value="">Select evidence</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
   </Editor>}
  </section>}
 </>;
}

// Intercompany pairs from either side of the current entity.
export function IntercompanyPairs({entityId,me,can,tick,refresh}:Ctx){
 const pairs=useList('/intercompany-pairs',entityId,tick,{detail:'1'});
 const entities=useEntities(tick);
 const invoices=useList('/invoices',entityId,tick);
 const cmd=useCommand(refresh);
 const [target,setTarget]=useState<string>('');
 const [targetData,setTargetData]=useState<{parties:Row[],accounts:Row[],branches:Row[],books:Row[],evidence:Row[]}|null>(null);
 const [error,setError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setTargetData(null);if(!target)return;Promise.all([api('GET','/parties?limit=200',{entityId:target}),api('GET','/accounts?limit=200',{entityId:target}),api('GET','/branches?limit=50',{entityId:target}),api('GET','/books?limit=20',{entityId:target}),api('GET','/evidence?status=available&limit=200',{entityId:target})]).then(([p,a,b,k,e])=>{if(live)setTargetData({parties:p.data.items,accounts:a.data.items,branches:b.data.items,books:k.data.items,evidence:e.data.items});}).catch(e=>{if(live)setError(asError(e));});return()=>{live=false;};},[target]);
 const names=useMemo(()=>new Map((entities.items||[]).map((e:Row)=>[e.id,e.legalName])),[entities.items]);
 const others=(entities.items||[]).filter((e:Row)=>e.id!==entityId&&e.state!=='archived');
 return <>
  <ErrorPanel error={cmd.error||pairs.error||error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <p>A pair ties an invoice of this entity to the bill the target entity accepts into its own books. Each side posts under its own authority; an issued side is never rolled back, and a second side that cannot post is an exception shown here until it is resolved.</p>
  {pairs.items===null?<Loading/>:table(['Reference','Source','Target','State','Sides posted','Exception','Actions'],pairs.items.map((p:Row)=>{const isSource=p.sourceEntityId===entityId,isTarget=p.targetEntityId===entityId;return [p.sharedReference,names.get(p.sourceEntityId)||short(p.sourceEntityId),names.get(p.targetEntityId)||short(p.targetEntityId),p.state,(p.sourcePostedAt?'source':'')+(p.sourcePostedAt&&p.targetPostedAt?', ':'')+(p.targetPostedAt?'target':'')||'none',p.exceptionReason||'—',<div key="a" className="action-row">
   {p.state==='draft'&&isTarget&&can('intercompany_pair.accept')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/intercompany-pairs/'+p.id+'/accept',{entityId,ifMatch:p.version,body:{decision:'approve',contentVersion:p.contentVersion}})}>Accept into our books</button>}
   {p.state==='draft'&&isTarget&&can('intercompany_pair.accept')&&<Editor id={'rejp'+p.id} label="Refuse" onSave={async d=>!!await cmd.run('POST','/intercompany-pairs/'+p.id+'/accept',{entityId,ifMatch:p.version,body:{decision:'reject',contentVersion:p.contentVersion,reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}
   {['accepted','exception'].includes(p.state)&&((isSource&&!p.sourcePostedAt)||(isTarget&&!p.targetPostedAt))&&can('intercompany_pair.post')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/intercompany-pairs/'+p.id+'/post',{entityId,ifMatch:p.version,body:{}})}>Post our side</button>}
   {p.targetDocumentId&&isTarget&&<a href={'/purchases/bills/'+p.targetDocumentId}>Open bill</a>}{isSource&&<a href={'/sales/invoices/'+p.sourceDocumentId}>Open invoice</a>}
  </div>];}),'No intercompany pair involves this entity.')}
  {can('intercompany_pair.create')&&<section className="demo-card"><h2>Raise a pair</h2>
   <label>Target entity<select value={target} onChange={e=>setTarget(e.target.value)}><option value="">Select the counterparty entity</option>{others.map((e:Row)=><option key={e.id} value={e.id}>{e.legalName}</option>)}</select></label>
   {target&&(targetData===null?<Loading/>:<Editor id={'pair-new'+entityId+target} label="Raise pair" resetOnSave onSave={async d=>{const src=(invoices.items||[]).find((i:Row)=>i.id===d.sourceDocumentId);if(!src)return false;const book=targetData.books.find((b:Row)=>b.kind==='primary')||targetData.books[0];const targetDraft={kind:'bill',branchId:d.branchId,bookId:book?.id,partyId:d.partyId,documentDate:src.documentDate,accountingDate:src.accountingDate,currency:src.currency,ruleProfileVersion:src.ruleProfileVersion,lines:[{description:d.description,quantity:'1',unitPrice:src.net,discount:'0',priceBasis:'exclusive',accountId:d.accountId,dimensions:{}}],evidenceIds:[d.evidenceId]};return !!await cmd.run('POST','/intercompany-pairs',{entityId,body:{sourceEntityId:entityId,targetEntityId:target,sourceDocumentId:d.sourceDocumentId,targetDraft}});}}>
    <label>Source invoice<select name="sourceDocumentId" required><option value="">Select an invoice</option>{(invoices.items||[]).map((i:Row)=><option key={i.id} value={i.id}>{(i.officialNumber||short(i.id))+' · '+i.currency+' '+i.gross+' · '+i.state}</option>)}</select></label>
    <label>Supplier party in {names.get(target)||'the target'}<select name="partyId" required><option value="">Select the party that represents this entity there</option>{targetData.parties.map((p:Row)=><option key={p.id} value={p.id}>{p.legalName}</option>)}</select></label>
    <label>Expense account in the target<select name="accountId" required><option value="">Select an account</option>{targetData.accounts.filter((a:Row)=>a.category==='expense').map((a:Row)=><option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
    <label>Branch in the target<select name="branchId" required>{targetData.branches.map((b:Row)=><option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select></label>
    {input('Line description','description','Intercompany services','text',{required:true})}
    <label>Evidence in the target (the invoice copy the bill rests on)<select name="evidenceId" required><option value="">Select evidence</option>{targetData.evidence.map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
    <p>The bill draft carries the invoice's net amount, dates and currency and the pair's shared reference; the target entity accepts it before either side posts.</p>
   </Editor>)}
  </section>}
 </>;
}

// Readiness, runs and the worksheet.
export function Consolidations({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('group_accounting'))return <NotEnabled me={me}/>;
 const {group,loaded,error}=useGroup(entityId,tick);
 const runs=useList('/consolidations',entityId,tick,{detail:'1'});
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [periodEnd,setPeriodEnd]=useState(monthEnd());
 const [readiness,setReadiness]=useState<Row|null>(null),[readyError,setReadyError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setReadiness(null);if(!group||!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd))return;api('GET','/groups/'+group.id+'/readiness?periodEnd='+periodEnd,{entityId}).then(r=>{if(live){setReadiness(r.data);setReadyError(null);}}).catch(e=>{if(live)setReadyError(asError(e));});return()=>{live=false;};},[group?.id,periodEnd,entityId,tick]);
 const [open,setOpen]=useState<string|null>(null),[ws,setWs]=useState<Row|null>(null),[wsError,setWsError]=useState<ApiError|null>(null);
 useEffect(()=>{let live=true;setWs(null);if(!open)return;api('GET','/consolidations/'+open+'/worksheet',{entityId}).then(r=>{if(live){setWs(r.data);setWsError(null);}}).catch(e=>{if(live)setWsError(asError(e));});return()=>{live=false;};},[open,entityId,tick]);
 const names=useMemo(()=>new Map((readiness?.members||[]).map((m:Row)=>[m.entityId,m.entityName])),[readiness]);
 const cur=ws?.reportingCurrency||group?.reportingCurrency||'PHP';
 return <>
  <ErrorPanel error={cmd.error||error||runs.error||readyError||wsError} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {!loaded?<Loading/>:!group?<p>Define and activate the group first.</p>:<>
  <section className="demo-card"><h2>Member-close readiness</h2>
   <label>Period end<input type="date" value={periodEnd} onChange={e=>setPeriodEnd(e.target.value)}/></label>
   {readiness===null?<Loading/>:table(['Member','Currency','Period','Statements snapshot','Rate','Ready'],readiness.members.map((m:Row)=>[m.entityName,m.currency,m.periodStatus||'no period',m.snapshotId?'v'+m.snapshotVersion+' · '+String(m.checksum).slice(0,12)+'…':'none',m.rateCovered?'covered':'missing',m.ready?'yes':'no']),'No member is effective at this period end.')}
   <p>A run consumes the latest statements snapshot of each member for the period end; the member's period must be soft-closed or locked and every member currency covered by an approved rate set.</p>
   {can('consolidation.create')&&readiness&&<Editor id={'run-new'+group.id+periodEnd} label="Create run" resetOnSave onSave={async d=>!!await cmd.run('POST','/consolidations',{entityId,body:{groupId:group.id,periodEnd,memberSnapshotIds:readiness.members.map((m:Row)=>m.snapshotId).filter(Boolean),rateSetId:d.rateSetId,mappingVersion:d.mappingVersion}})}>
    <label>Rate set<select name="rateSetId" required><option value="">Select an approved rate set</option>{readiness.rateSets.filter((r:Row)=>r.state==='approved').map((r:Row)=><option key={r.id} value={r.id}>{r.code}</option>)}</select></label>
    <label>Mapping version<select name="mappingVersion" required><option value="">Select an approved mapping</option>{readiness.mappingVersions.map((v:Row)=><option key={v.id} value={v.mappingVersion}>{v.mappingVersion}</option>)}</select></label>
   </Editor>}
  </section>
  <h2>Runs</h2>
  {runs.items===null?<Loading/>:table(['Period end','Version','State','Result hash','Unresolved','Actions'],runs.items.map((r:Row)=>[r.periodEnd,'v'+r.versionNumber,r.state,r.resultHash?r.resultHash.slice(0,12)+'…':'—',String(r.unresolvedCount),<div key="a" className="action-row">
   <button type="button" onClick={()=>setOpen(open===r.id?null:r.id)}>{open===r.id?'Hide worksheet':'Worksheet'}</button>
   {['draft','previewed'].includes(r.state)&&can('consolidation.preview')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/consolidations/'+r.id+'/preview',{entityId,ifMatch:r.version,body:{}})}>Preview</button>}
   {r.state==='previewed'&&can('consolidation.approve')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/consolidations/'+r.id+'/approve',{entityId,ifMatch:r.version,body:{decision:'approve',contentVersion:r.contentVersion}})}>Approve</button>}
   {r.state==='approved'&&can('consolidation.publish')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/consolidations/'+r.id+'/publish',{entityId,ifMatch:r.version,body:{}})}>Publish</button>}
  </div>]),'No consolidation run yet.')}
  {open&&(ws===null?<Loading/>:<section className="demo-card"><h2>Worksheet · {ws.periodEnd} · {ws.state}</h2>
   <p>Reporting currency {cur}{ws.resultHash&&<> · result hash <code>{ws.resultHash.slice(0,16)}…</code></>}. The same member snapshots, mapping and rates always yield this hash.</p>
   {ws.pairExceptions.length>0&&<><h3>Pair exceptions</h3>{table(['Pair','State','Reason'],ws.pairExceptions.map((p:Row)=>[p.sharedReference,p.state,p.reason||'—']),'')}</>}
   {ws.differences.length>0&&<><h3>Unresolved differences</h3>{table(['Source','Amount','Detail'],ws.differences.map((d:Row)=>[d.source,amount(d.amount,cur),d.detail]),'')}<p>Differences are shown, never plugged; the run cannot be approved while any remains.</p></>}
   <h3>Consolidated statements</h3>
   {table(['Group account','Category',...ws.members.map((m:Row)=>m.entityName),'Eliminations','Translation','Consolidated'],ws.lines.map((l:Row)=>[l.groupAccountCode+' '+l.groupAccountName,l.groupCategory,...ws.members.map((m:Row)=>amount(l.members.find((x:Row)=>x.entityId===m.entityId)?.amount??'0',cur)),amount(l.eliminations,cur),amount(l.translation,cur),amount(l.consolidated,cur)]),'No lines.')}
   <p role="status">Assets {amount(ws.totals.assets,cur)} · Liabilities {amount(ws.totals.liabilities,cur)} · Equity {amount(ws.totals.equity,cur)} · Net income {amount(ws.totals.netIncome,cur)} · Translation reserve {amount(ws.totals.translationReserve,cur)} · {ws.totals.balanced?'balanced':'not balanced'}</p>
   <h3>Translation</h3>
   {table(['Member','Source','Policy','Currency','Rate','Translated'],ws.translation.map((t:Row)=>[names.get(t.memberEntityId)||ws.members.find((m:Row)=>m.entityId===t.memberEntityId)?.entityName||short(t.memberEntityId),t.source,t.policy,t.currency,t.rate,amount(t.amount,cur)]),'Every member reports in the reporting currency; nothing to translate.')}
   <h3>Eliminations</h3>
   {table(['Kind','Reason','Lines','Amount','Difference'],ws.eliminations.map((e:Row)=>[e.kind,e.reason,<ul key="l">{e.lines.map((l:Row,i:number)=><li key={i}>{l.groupAccountCode}: Dr {l.debit} / Cr {l.credit}</li>)}</ul>,amount(e.amount,cur),amount(e.difference,cur)]),'No elimination.')}
   {['draft','previewed'].includes(ws.state)&&can('consolidation.edit')&&<Editor id={'elim'+open} label="Add manual elimination" resetOnSave onSave={async d=>!!await cmd.run('POST','/consolidations/'+open+'/eliminations',{entityId,body:{lines:[{groupAccountCode:d.debitCode,debit:d.debitAmount,credit:'0.00'},{groupAccountCode:d.creditCode,debit:'0.00',credit:d.creditAmount}],reason:d.reason,evidenceIds:[d.evidenceId]}})}>
    {input('Debit group account','debitCode','','text',{required:true})}{input('Debit amount','debitAmount','','text',{required:true,inputMode:'decimal',pattern:'[0-9]{1,18}(\\.[0-9]{1,6})?'})}{input('Credit group account','creditCode','','text',{required:true})}{input('Credit amount','creditAmount','','text',{required:true,inputMode:'decimal',pattern:'[0-9]{1,18}(\\.[0-9]{1,6})?'})}
    {input('Reason','reason','','text',{required:true})}<label>Evidence<select name="evidenceId" required><option value="">Select evidence</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
    <p>A manual elimination returns the run to draft; preview it again to see the effect.</p>
   </Editor>}
   <h3>Member balances</h3>
   {ws.members.map((m:Row)=><details key={m.entityId}><summary>{m.entityName} · {m.currency} · snapshot {short(m.snapshotId)}</summary>{table(['Account','Category','Balance','Group account','Rate','Translated'],m.lines.map((l:Row)=>[l.code+' '+l.name,l.category,amount(l.balance,m.currency),l.groupAccountCode||'unmapped',l.rate||'—',l.translated?amount(l.translated,cur):'—']),'')}</details>)}
  </section>)}
  </>}
 </>;
}
