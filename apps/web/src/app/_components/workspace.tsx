"use client";
// P02 finance workspace: real screens over /v1 through the BFF. Every command
// carries an Idempotency-Key that is reused on retry, every resource mutation
// sends If-Match, and every screen renders loading, empty, forbidden, stale
// and retry states from the typed API errors rather than hiding them.
import {useCallback,useEffect,useMemo,useState,type FormEvent,type ReactNode} from 'react';
import {usePathname} from 'next/navigation';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,uuid,RequestError,type Row,type ApiError} from './workspace-kit';
import {LedgerAccounts,LedgerJournals,LedgerJournalDetail,LedgerImports,LedgerPeriods,LedgerReports,Capabilities} from './workspace-ledger';
import {SalesInvoices,SalesInvoiceDetail,SalesOrders,SalesCollections,SalesCollectionDetail,SalesCustomers,TaxRules} from './workspace-sales';
import {PurchasingBills,PurchasingBillDetail,PurchasingOrders,PurchasingClaims,PurchasingPayments,PurchasingPaymentDetail,PurchasingSuppliers} from './workspace-purchasing';
import {TreasuryBankAccounts,TreasuryReconcile,TreasuryTransfers,TreasuryChecks,TreasuryCash} from './workspace-treasury';
import {ComplianceWorkbench} from './workspace-compliance';
import {FiOwnership,FiFeeds,FiBranches,FiTax} from './workspace-fi';
import {FxRates,FxRevaluations,Books} from './workspace-fx';
import {InventoryItems,InventoryMovements,InventoryCounts,InventoryLandedCosts} from './workspace-inventory';

const nav:[string,string][]=[['My work','/work'],['Overview','/overview'],['Parties','/parties'],['Evidence','/evidence'],['Obligations','/obligations'],['Journals','/ledger/journals'],['Chart of accounts','/ledger/accounts'],['Periods and close','/ledger/periods'],['Imports','/ledger/imports'],['Reports','/reports'],['Invoices','/sales/invoices'],['Orders and quotes','/sales/orders'],['Receipts','/sales/collections'],['Customers','/sales/customers'],['Bills','/purchases/bills'],['Purchase orders','/purchases/orders'],['Expense claims','/purchases/claims'],['Payments','/payments'],['Suppliers','/purchases/suppliers'],['Bank accounts','/bank/accounts'],['Reconcile','/bank/reconcile'],['Transfers','/bank/transfers'],['Checks','/bank/checks'],['Cash','/bank/cash'],['Compliance','/compliance'],['Source ownership','/institution/ownership'],['Feeds','/institution/feeds'],['Branches','/institution/branches'],['Institution tax','/institution/tax'],['Books','/books'],['FX rates','/fx/rates'],['Revaluations','/fx/revaluations'],['Inventory','/inventory'],['Stock movements','/inventory/movements'],['Counts','/inventory/counts'],['Landed costs','/inventory/landed-costs'],['Assets','/assets']];
const roadmap:Record<string,string>={'/assets':'Assets, recurring work and recognition schedules arrive with P11.'};
export default function Workspace(){
 const path=usePathname();
 const [me,setMe]=useState<Row|null>(null),[meError,setMeError]=useState<ApiError|null>(null),[entityId,setEntityId]=useState<string|null>(null),[entity,setEntity]=useState<Row|null>(null),[tick,setTick]=useState(0);
 const refresh=useCallback(async()=>{setTick(t=>t+1);},[]);
 useEffect(()=>{(async()=>{try{const {data}=await api('GET','/me');setMe(data);setMeError(null);let chosen:string|null=null;try{chosen=sessionStorage.getItem('lara-entity');}catch{}if(!chosen||!data.entityIds.includes(chosen))chosen=data.entityIds[0]||null;setEntityId(chosen);}catch(e){setMeError(asError(e));}})();},[tick]);
 useEffect(()=>{if(!entityId){setEntity(null);return;}api('GET','/entities/'+entityId).then(r=>setEntity(r.data)).catch(()=>setEntity(null));},[entityId,tick]);
 const can=(p:string)=>!!me?.permissions?.includes(p);
 const id=path.split('/').filter(Boolean).at(-1)||'';
 let title='Workspace',content:ReactNode=null;
 if(meError)content=<section role="alert" className="error-panel"><h2>{meError.code==='UNAUTHENTICATED'?'Sign in to continue':'Workspace unavailable'}</h2><p>{meError.message}</p>{meError.code==='FORBIDDEN'&&<p>Your account has no workspace membership yet. Ask your security administrator for an invitation.</p>}<div className="action-row"><button type="button" onClick={refresh}>Retry</button>{meError.code==='UNAUTHENTICATED'&&<a className="button" href="/api/auth/login">Sign in</a>}</div></section>;
 else if(!me)content=<p role="status">Loading your workspace…</p>;
 else if(roadmap[path]){title='Coming in a later release';content=<section className="demo-card"><h2>{nav.find(([,u])=>u===path)?.[0]}</h2><p>{roadmap[path]}</p><p>Nothing here is enabled for your organization yet; the capability appears when its module release passes its gates.</p>{link('/work','Back to my work')}</section>;}
 else if(!entityId&&!path.startsWith('/settings/setup')){title='Set up your organization';content=<section className="demo-card"><p>{can('entity.create')?'No legal entity exists yet. Start the setup checklist to create one.':'No entity is assigned to your membership yet. Ask a controller to complete setup and assign you.'}</p>{can('entity.create')&&link('/settings/setup','Open setup checklist')}</section>;}
 else if(path==='/'||path==='/overview'){title=entity?entity.legalName:'Overview';content=<Overview entityId={entityId!} entity={entity} can={can} me={me} tick={tick}/>;}
 else if(path==='/work'){title='My work';content=<Work entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path.startsWith('/tasks/')){title='Task';content=<TaskDetail entityId={entityId!} id={id} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/parties'){title='Parties';content=<Parties entityId={entityId!} can={can} tick={tick} refresh={refresh}/>;}
 else if(path.startsWith('/parties/')){title='Party';content=<PartyDetail entityId={entityId!} id={id} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/evidence'){title='Evidence';content=<Evidence entityId={entityId!} can={can} tick={tick} refresh={refresh}/>;}
 else if(path.startsWith('/evidence/')){title='Evidence';content=<EvidenceDetail entityId={entityId!} id={id} can={can} tick={tick}/>;}
 else if(path==='/obligations'){title='Obligations';content=<Obligations entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/ledger/accounts'){title='Chart of accounts';content=<LedgerAccounts entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/ledger/journals'){title='Journals';content=<LedgerJournals entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path.startsWith('/ledger/journals/')){title='Journal';content=<LedgerJournalDetail entityId={entityId!} id={id} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/ledger/imports'){title='Opening imports';content=<LedgerImports entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/ledger/periods'||path.startsWith('/close')){title='Periods and close';content=<LedgerPeriods entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/reports'||path.startsWith('/reports/')){title='Reports';content=<LedgerReports entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/sales/invoices'||path==='/sales/invoices/new'){title='Invoices';content=<SalesInvoices entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path.startsWith('/sales/invoices/')){title='Invoice';content=<SalesInvoiceDetail entityId={entityId!} id={id} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/sales/orders'){title='Orders and quotations';content=<SalesOrders entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/sales/collections'){title='Receipts';content=<SalesCollections entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path.startsWith('/sales/collections/')){title='Receipt';content=<SalesCollectionDetail entityId={entityId!} id={id} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/sales/customers'){title='Customers';content=<SalesCustomers entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/purchases/bills'){title='Bills';content=<PurchasingBills entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path.startsWith('/purchases/bills/')){title='Bill';content=<PurchasingBillDetail entityId={entityId!} id={id} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/purchases/orders'){title='Purchase orders';content=<PurchasingOrders entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/purchases/claims'){title='Expense claims';content=<PurchasingClaims entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/purchases/suppliers'){title='Suppliers';content=<PurchasingSuppliers entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/payments'){title='Payments';content=<PurchasingPayments entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path.startsWith('/payments/')){title='Payment';content=<PurchasingPaymentDetail entityId={entityId!} id={id} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/bank/accounts'){title='Bank accounts';content=<TreasuryBankAccounts entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/bank/reconcile'){title='Bank reconciliation';content=<TreasuryReconcile entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/bank/transfers'){title='Transfers';content=<TreasuryTransfers entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/bank/checks'){title='Checks';content=<TreasuryChecks entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/bank/cash'){title='Cash sessions';content=<TreasuryCash entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/compliance'){title='Compliance';content=<ComplianceWorkbench entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/institution/ownership'){title='Source ownership';content=<FiOwnership entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/institution/feeds'){title='Feeds';content=<FiFeeds entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/institution/branches'){title='Branches';content=<FiBranches entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/institution/tax'){title='Institution tax';content=<FiTax entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/books'){title='Books';content=<Books entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/inventory'){title='Inventory';content=<InventoryItems entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/inventory/movements'){title='Stock movements';content=<InventoryMovements entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/inventory/counts'){title='Stock counts';content=<InventoryCounts entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/inventory/landed-costs'){title='Landed costs';content=<InventoryLandedCosts entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/fx/rates'){title='FX rates';content=<FxRates entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/fx/revaluations'){title='Revaluations';content=<FxRevaluations entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/settings/tax-rules'){title='Tax rules';content=<TaxRules entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path==='/settings/capabilities'){title='Capabilities';content=<Capabilities entityId={entityId!} me={me} can={can} tick={tick} refresh={refresh}/>;}
 else if(path.startsWith('/settings')){title='Setup checklist';content=<Setup entityId={entityId} entity={entity} me={me} can={can} tick={tick} refresh={refresh} choose={(e:string)=>{try{sessionStorage.setItem('lara-entity',e);}catch{}setEntityId(e);}}/>;}
 else{title='Not found';content=<p>This page is not part of the workspace.</p>;}
 return <div className="lara-shell"><a className="skip-link" href="#workspace">Skip to content</a><aside className="lara-nav"><a href="/"><img src="/assets/lara/logos/lara-logo-reverse.svg" alt="LARA" width="144" height="40"/></a><nav aria-label="Primary navigation">{nav.map(([label,url])=><a key={url} href={url} aria-current={path===url?'page':undefined}>{label}</a>)}{(can('entity.create')||can('entity.edit')||can('membership.create'))&&<a href="/settings/setup" aria-current={path==='/settings/setup'?'page':undefined}>Settings</a>}{can('capability.activate')&&<a href="/settings/capabilities" aria-current={path==='/settings/capabilities'?'page':undefined}>Capabilities</a>}{can('tax_rule.read')&&<a href="/settings/tax-rules" aria-current={path==='/settings/tax-rules'?'page':undefined}>Tax rules</a>}</nav></aside><div className="lara-content"><header className="lara-header"><div><strong>{entity?.legalName||'LARA'}</strong><p>{entity?`${entity.state==='active'?'Active':'Setup '+entity.state.replace('_',' ')} · ${entity.timezone}`:'Finance workspace'}</p></div>{me&&me.entityIds.length>1&&<label>Entity<select value={entityId||''} onChange={e=>{try{sessionStorage.setItem('lara-entity',e.target.value);}catch{}setEntityId(e.target.value);}}>{me.entityIds.map((e:string)=><option key={e} value={e}>{e===entityId&&entity?entity.legalName:e.slice(0,8)}</option>)}</select></label>}{me?<><span>{me.permissions.length} permissions</span><a href="/auth/logout">Sign out</a></>:<a className="button" href="/api/auth/login">Sign in</a>}</header><main id="workspace" className="workspace-page"><h1>{title}</h1>{content}</main></div></div>;
}

function Overview({entityId,entity,can,me,tick}:{entityId:string,entity:Row|null,can:(p:string)=>boolean,me:Row,tick:number}){
 const tasks=useList('/tasks',entityId,tick,{status:'open,assigned,in_progress,waiting_for_information'});
 const obligations=useList('/obligations',entityId,tick,{status:'open,in_progress'});
 const evidence=useList('/evidence',entityId,tick,{status:'quarantined,scanning'});
 const mine=tasks.items?.filter(t=>t.ownerId===me.principalId).length??0;
 const overdue=obligations.items?.filter(o=>new Date(o.dueAt)<new Date()).length??0;
 return <>{entity&&entity.state!=='active'&&<section className="demo-card"><h2>Activation pending</h2><p>This organization is {entity.state.replace('_',' ')}. Financial capabilities stay disabled until setup is approved.</p>{link('/settings/setup','Open setup checklist')}</section>}
  <div className="overview-grid"><article><span>My open tasks</span><strong>{tasks.items?mine:'…'}</strong>{link('/work','Open my work')}</article><article><span>Open obligations</span><strong>{obligations.items?obligations.items.length:'…'}</strong>{link('/obligations',overdue?overdue+' overdue':'View calendar')}</article><article><span>Evidence pending scan</span><strong>{evidence.items?evidence.items.length:'…'}</strong>{link('/evidence','Open evidence')}</article></div>
  <h2>Capabilities</h2><ul>{['workspace','general_ledger','sales','purchasing','treasury','compliance'].map(c=><li key={c}>{c.replace('_',' ')} · {me.capabilities.includes(c)?'enabled':c==='workspace'?(entity?.state==='active'?'enabled':'blocked until activation approval'):'not enabled in this release'}</li>)}</ul>
  {(tasks.error||obligations.error||evidence.error)&&<ErrorPanel error={tasks.error||obligations.error||evidence.error}/>}</>;
}

function Work({entityId,me,can,tick,refresh}:{entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void}){
 const [owner,setOwner]=useState(()=>{try{return new URL(window.location.href).searchParams.get('owner')||'me';}catch{return 'me';}});
 const [status,setStatus]=useState(()=>{try{return new URL(window.location.href).searchParams.get('status')||'open,assigned,in_progress,waiting_for_information';}catch{return 'open,assigned,in_progress,waiting_for_information';}});
 const [due,setDue]=useState('');
 const remember=(next:Record<string,string>)=>{const url=new URL(window.location.href);for(const [k,v] of Object.entries({owner,status,...next}))url.searchParams.set(k,v);history.replaceState(null,'',url.pathname+url.search);};
 const list=useList('/tasks',entityId,tick,{status,...(owner==='me'?{ownerId:me.principalId}:{}),...(due?{dueBefore:due+'T23:59:59+08:00'}:{})});
 const members=useList('/memberships',entityId,tick);
 const cmd=useCommand(refresh);
 const ownerName=(id?:string)=>id?(id===me.principalId?'Me':id.slice(0,8)):'Unassigned';
 return <><div className="filter-row"><label>Owner<select value={owner} onChange={e=>{setOwner(e.target.value);remember({owner:e.target.value});}}><option value="me">My tasks</option><option value="all">All tasks</option></select></label><label>Status<select value={status} onChange={e=>{setStatus(e.target.value);remember({status:e.target.value});}}><option value="open,assigned,in_progress,waiting_for_information">Active</option><option value="open">Open</option><option value="assigned">Assigned</option><option value="in_progress">In progress</option><option value="waiting_for_information">Waiting for information</option><option value="resolved">Resolved</option></select></label><label>Due on or before<input type="date" value={due} onChange={e=>setDue(e.target.value)}/></label></div>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null&&!list.error?<Loading/>:table(['Task','Source','Owner','Due','Status','Assign'],(list.items||[]).map(t=>[link('/tasks/'+t.id,t.reason),t.sourceType+' · '+t.sourceId.slice(0,8),ownerName(t.ownerId),t.dueAt?<span className={new Date(t.dueAt)<new Date()?'overdue':''}>{when(t.dueAt)}</span>:'—',t.state.replace(/_/g,' '),can('task.assign')&&!['resolved','cancelled'].includes(t.state)?<select aria-label={'Assign '+t.reason} value={t.ownerId||''} disabled={cmd.busy} onChange={e=>void cmd.run('POST','/tasks/'+t.id+'/assign',{entityId,ifMatch:t.version,body:{ownerId:e.target.value,reason:'Assigned from my work'}})}><option value="">Unassigned</option>{(members.items||[]).filter(m=>m.state==='active').map(m=><option key={m.id} value={m.principalId}>{ownerName(m.principalId)}</option>)}</select>:'—']),owner==='me'?'Your inbox is empty. Switch to all tasks or open a party to raise one.':'No tasks match these filters.')}</>;
}

function TaskDetail({entityId,id,me,can,tick,refresh}:{entityId:string,id:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void}){
 const [task,setTask]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null),[comments,setComments]=useState<Row[]>([]);
 useEffect(()=>{api('GET','/tasks/'+id,{entityId}).then(r=>{setTask(r.data);setError(null);}).catch(e=>setError(asError(e)));},[id,entityId,tick]);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 if(error)return <ErrorPanel error={error} onReload={refresh}/>;
 if(!task)return <Loading/>;
 const active=!['resolved','cancelled'].includes(task.state);
 return <><p>Status: {task.state.replace(/_/g,' ')} · Owner: {task.ownerId===me.principalId?'Me':task.ownerId?task.ownerId.slice(0,8):'Unassigned'} · Due: {when(task.dueAt)}</p><p>{task.reason}</p><p>Source: {task.sourceType} {task.sourceId}</p>
  <ErrorPanel error={cmd.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {active&&<div className="action-row">{can('task.edit')&&task.state!=='in_progress'&&<button disabled={cmd.busy||!task.ownerId} title={task.ownerId?'Start work':'Assign an owner first'} onClick={()=>void cmd.run('PATCH','/tasks/'+id+'?state=in_progress',{entityId,ifMatch:task.version,body:{kind:task.kind,sourceType:task.sourceType,sourceId:task.sourceId,reason:task.reason}})}>Start</button>}{can('task.edit')&&<Editor id={'wait'+id} label="Wait for information" onSave={async d=>!!await cmd.run('PATCH','/tasks/'+id+'?state=waiting_for_information',{entityId,ifMatch:task.version,body:{kind:task.kind,sourceType:task.sourceType,sourceId:task.sourceId,reason:task.reason,dueAt:new Date(d.dueAt+'T17:00:00+08:00').toISOString()}})}>{input('Follow up on','dueAt','','date',{required:true})}</Editor>}</div>}
  {active&&can('task.resolve')&&<><h2>Resolve</h2><Editor id={'resolve'+id} label="Resolve task" onSave={async d=>!!await cmd.run('POST','/tasks/'+id+'/resolve',{entityId,ifMatch:task.version,body:{reason:d.reason,evidenceIds:d.evidenceId?[d.evidenceId]:[]}})}>{input('Resolution','reason','','text',{required:true,maxLength:2000})}<label>Evidence{task.kind==='missing_evidence'?' (required)':''}<select name="evidenceId" required={task.kind==='missing_evidence'}><option value="">None</option>{(evidence.items||[]).map(e=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>{task.kind==='missing_evidence'&&!(evidence.items||[]).length&&<p>No available evidence yet. {link('/evidence','Upload evidence first')}</p>}</Editor></>}
  <h2>Comments</h2>{comments.map((c,i)=><p key={i}>{c.author}: {c.body} · {when(c.at)}</p>)}{!comments.length&&<p>Comments recorded in this session appear here.</p>}{can('task.comments')&&<Editor id={'comment'+id} label="Add comment" onSave={async d=>{const r=await cmd.run('POST','/tasks/'+id+'/comments',{entityId,ifMatch:task.version,body:{body:d.body}});if(r)setComments(c=>[...c,{author:'Me',body:d.body,at:new Date().toISOString()}]);return !!r;}}><label>Comment<textarea name="body" required maxLength={4000}/></label></Editor>}
  {link('/work','Back to my work')}</>;
}

function Parties({entityId,can,tick,refresh}:{entityId:string,can:(p:string)=>boolean,tick:number,refresh:()=>void}){
 const [q,setQ]=useState(()=>{try{return new URL(window.location.href).searchParams.get('q')||'';}catch{return '';}}),[role,setRole]=useState('');
 const list=useList('/parties',entityId,tick,{q,role,status:'active'});
 const cmd=useCommand(refresh);
 return <>{can('party.create')&&<><h2>New party</h2><Editor id={'party-new'+entityId} label="Create party" onSave={async d=>{const r=await cmd.run('POST','/parties',{entityId,body:{legalName:d.legalName,roles:[d.role],identityStatus:d.identityStatus,address:d.address,...(d.taxId?{taxId:d.taxId}:{})}});if(r)window.location.assign('/parties/'+r.data.id);return !!r;}}>{input('Legal name','legalName','','text',{required:true})}{select('Role','role',[['customer','Customer'],['supplier','Supplier'],['employee','Employee'],['bank','Bank']])}{select('Identity','identityStatus',[['unknown','Unknown — a task will ask for the document'],['known','Known — tax identifier below'],['not_applicable','Not applicable']],'unknown')}{input('Tax identifier','taxId','','text',{placeholder:'Required only for known identity'})}{input('Address','address','','text',{required:true})}</Editor></>}
  <h2>Directory</h2><div className="filter-row"><label>Search<input value={q} onChange={e=>{setQ(e.target.value);const url=new URL(window.location.href);url.searchParams.set('q',e.target.value);history.replaceState(null,'',url.pathname+url.search);}}/></label><label>Role<select value={role} onChange={e=>setRole(e.target.value)}><option value="">All</option><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="employee">Employee</option><option value="bank">Bank</option></select></label></div>
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {list.items===null&&!list.error?<Loading/>:table(['Party','Roles','Identity','Tax id'],(list.items||[]).map(p=>[link('/parties/'+p.id,p.legalName),p.roles.join(', '),p.identityStatus.replace('_',' '),p.taxIdMasked||'—']),q?'No party matches your search.':'No parties yet. Create the first customer or supplier above.')}</>;
}

function PartyDetail({entityId,id,can,tick,refresh}:{entityId:string,id:string,can:(p:string)=>boolean,tick:number,refresh:()=>void}){
 const [party,setParty]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null);
 useEffect(()=>{api('GET','/parties/'+id,{entityId}).then(r=>{setParty(r.data);setError(null);}).catch(e=>setError(asError(e)));},[id,entityId,tick]);
 const tasks=useList('/tasks',entityId,tick,{sourceId:id});
 const cmd=useCommand(refresh);
 if(error)return <ErrorPanel error={error} onReload={refresh}/>;
 if(!party)return <Loading/>;
 const archived=party.state==='archived';
 return <><p>{party.state}{party.mergedInto&&<> · merged into {link('/parties/'+party.mergedInto,'target party')}</>} · Roles: {party.roles.join(', ')} · Identity: {party.identityStatus.replace('_',' ')} {party.taxIdMasked&&'· Tax id '+party.taxIdMasked} · Version {party.version}</p>
  <ErrorPanel error={cmd.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {!archived&&can('party.edit')&&<Editor id={'party'+id+party.version} label="Save changes" onSave={async d=>!!await cmd.run('PATCH','/parties/'+id,{entityId,ifMatch:party.version,body:{legalName:d.legalName,roles:Array.from(new Set([...party.roles,...(d.role?[d.role]:[])])),identityStatus:d.identityStatus,address:d.address,...(d.taxId?{taxId:d.taxId}:{})}})}>{input('Legal name','legalName',party.legalName,'text',{required:true})}{select('Add role','role',[['','Keep current roles'],['customer','Customer'],['supplier','Supplier'],['employee','Employee'],['bank','Bank']])}{select('Identity','identityStatus',[['unknown','Unknown'],['known','Known — tax identifier below'],['not_applicable','Not applicable']],party.identityStatus)}{input('Tax identifier','taxId','','text',{placeholder:party.taxIdMasked?'Stored as '+party.taxIdMasked+'; enter again only to change':'Required for known identity'})}{input('Address','address',party.address,'text',{required:true})}</Editor>}
  {!archived&&can('party.archive')&&<div className="action-row"><button disabled={cmd.busy} onClick={()=>{const reason=window.prompt('Reason for archiving this party');if(reason)void cmd.run('POST','/parties/'+id+'/archive',{entityId,ifMatch:party.version,body:{reason}});}}>Archive party</button></div>}
  <h2>Related tasks</h2>{table(['Task','Status','Owner'],(tasks.items||[]).map(t=>[link('/tasks/'+t.id,t.reason),t.state.replace(/_/g,' '),t.ownerId?t.ownerId.slice(0,8):'Unassigned']),'No tasks for this party.')}
  {link('/parties','Back to parties')}</>;
}

async function sha256Hex(bytes:ArrayBuffer){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');}
function Evidence({entityId,can,tick,refresh}:{entityId:string,can:(p:string)=>boolean,tick:number,refresh:()=>void}){
 const [status,setStatus]=useState('');
 const list=useList('/evidence',entityId,tick,{status});
 const [progress,setProgress]=useState(''),[error,setError]=useState<ApiError|null>(null),[busy,setBusy]=useState(false);
 async function upload(e:FormEvent<HTMLFormElement>){
  e.preventDefault();const form=e.currentTarget;const file=(form.elements.namedItem('file') as HTMLInputElement).files?.[0];const classification=(form.elements.namedItem('classification') as HTMLSelectElement).value;
  if(!file)return;setBusy(true);setError(null);
  try{
   const bytes=await file.arrayBuffer();setProgress('Computing checksum…');
   const sha256=await sha256Hex(bytes);
   setProgress('Registering upload…');
   const reg=await api('POST','/evidence/uploads',{entityId,key:uuid(),body:{filename:file.name,mime:file.type||'application/octet-stream',byteCount:file.size,sha256,classification}});
   setProgress('Uploading '+file.name+'…');
   await api('PUT','/evidence/'+reg.data.evidenceId+'/content',{entityId,raw:bytes,headers:{'content-type':file.type||'application/octet-stream'}});
   setProgress('Verifying…');
   await api('POST','/evidence/'+reg.data.evidenceId+'/complete',{entityId,key:uuid(),ifMatch:reg.data.version,body:{}});
   setProgress('Queued for scanning. It becomes available after the scan completes.');form.reset();refresh();
  }catch(err){setError(asError(err));setProgress('');}
  finally{setBusy(false);}
 }
 return <>{can('evidence.upload')&&<><h2>Upload</h2><form className="demo-form" onSubmit={upload}><label>File (PDF, JPEG, PNG, CSV or XLSX up to 20 MB)<input name="file" type="file" required accept=".pdf,.jpg,.jpeg,.png,.csv,.xlsx,application/pdf,image/jpeg,image/png,text/csv"/></label>{select('Classification','classification',[['internal','Internal'],['confidential','Confidential'],['restricted','Restricted']],'confidential')}<p role="status" aria-live="polite">{progress||'The file is checked against its checksum and type, then scanned before it can be used.'}</p><button disabled={busy} type="submit">Upload evidence</button></form></>}
  <ErrorPanel error={error||list.error} onReload={refresh}/>
  <h2>Files</h2><div className="filter-row"><label>Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">All</option><option value="available">Available</option><option value="scanning">Scanning</option><option value="quarantined">Quarantined</option><option value="rejected">Rejected</option></select></label></div>
  {list.items===null&&!list.error?<Loading/>:table(['File','Type','Size','Status','Classification'],(list.items||[]).map(e=>[link('/evidence/'+e.id,e.filename),e.mime,Math.ceil(e.byteCount/1024)+' KB',e.state,e.classification]),'No evidence yet. Upload the first document above.')}</>;
}
function EvidenceDetail({entityId,id,can,tick}:{entityId:string,id:string,can:(p:string)=>boolean,tick:number}){
 const [item,setItem]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null),[poll,setPoll]=useState(0);
 useEffect(()=>{api('GET','/evidence/'+id,{entityId}).then(r=>{setItem(r.data);setError(null);}).catch(e=>setError(asError(e)));},[id,entityId,tick,poll]);
 useEffect(()=>{if(item&&['quarantined','scanning'].includes(item.state)){const t=setTimeout(()=>setPoll(p=>p+1),2000);return()=>clearTimeout(t);}},[item]);
 if(error)return <ErrorPanel error={error}/>;
 if(!item)return <Loading/>;
 return <><p>{item.filename} · {item.mime} · {Math.ceil(item.byteCount/1024)} KB · {item.classification}</p><p role="status">{item.state==='available'?'Available. Downloads are authorized on every request.':item.state==='rejected'?'Rejected: the content did not pass verification or scanning and was not stored.':item.state==='scanning'?'Scanning… this page refreshes automatically.':'Waiting for upload completion.'}</p><p className="eyebrow">SHA-256 {item.sha256}</p>{item.state==='available'&&can('evidence.read')&&<div className="action-row"><a className="button" href={'/api/v1/evidence/'+id+'/content'} onClick={e=>{e.preventDefault();fetch('/api/v1/evidence/'+id+'/content',{headers:{'x-entity-id':entityId}}).then(async r=>{if(!r.ok)throw new RequestError(r.status,await r.json());const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=item.filename;a.click();URL.revokeObjectURL(url);}).catch(e=>setError(asError(e)));}}>Download</a></div>}{link('/evidence','Back to evidence')}</>;
}

function Obligations({entityId,me,can,tick,refresh}:{entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void}){
 const list=useList('/obligations',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const members=useList('/memberships',entityId,tick);
 const cmd=useCommand(refresh);
 const byMonth=useMemo(()=>{const groups:Record<string,Row[]>={};for(const o of list.items||[]){const k=o.dueAt.slice(0,7);(groups[k]||=[]).push(o);}return Object.entries(groups).sort();},[list.items]);
 return <>{can('obligation.create')&&<><h2>New obligation</h2><Editor id={'obligation-new'+entityId} label="Create obligation" onSave={async d=>!!await cmd.run('POST','/obligations',{entityId,body:{kind:d.kind,periodKey:d.periodKey,dueAt:new Date(d.dueAt+'T17:00:00+08:00').toISOString(),ownerId:d.ownerId,ruleVersion:d.ruleVersion}})}>{input('Kind (e.g. vat_return)','kind','','text',{required:true,pattern:'[a-z][a-z0-9_]{0,63}'})}{input('Period (YYYY-MM)','periodKey','','text',{required:true,pattern:'[0-9]{4}(-[0-9]{2}){0,2}(-Q[1-4])?'})}{input('Due date','dueAt','','date',{required:true})}<label>Owner<select name="ownerId" required defaultValue={me.principalId}>{Array.from(new Set([me.principalId,...(members.items||[]).filter(m=>m.state==='active').map(m=>m.principalId)])).map(p=><option key={p} value={p}>{p===me.principalId?'Me':p.slice(0,8)}</option>)}</select></label>{input('Rule version','ruleVersion','2026.1','text',{required:true})}</Editor></>}
  <ErrorPanel error={cmd.error||list.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <h2>Calendar</h2>{list.items===null&&!list.error?<Loading/>:byMonth.length?byMonth.map(([month,items])=><section key={month} className="demo-card"><h3>{month}</h3>{table(['Obligation','Period','Due','Owner','Status','Complete'],items.map(o=>[o.kind,o.periodKey,<span className={o.state!=='completed'&&new Date(o.dueAt)<new Date()?'overdue':''}>{when(o.dueAt)}</span>,o.ownerId===me.principalId?'Me':o.ownerId.slice(0,8),o.state.replace('_',' '),o.state==='completed'?'Done':can('obligation.complete')?<Editor id={'complete'+o.id} label="Complete" onSave={async d=>!!await cmd.run('POST','/obligations/'+o.id+'/complete',{entityId,ifMatch:o.version,body:{reason:d.reason,evidenceIds:[d.evidenceId]}})}>{input('Note','reason','Filed','text',{required:true})}<label>Evidence<select name="evidenceId" required><option value="">Select available evidence</option>{(evidence.items||[]).map(e=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label></Editor>:'—']),'')}</section>):<p>No obligations yet. Add the first filing or reporting duty above.</p>}</>;
}

function Setup({entityId,entity,me,can,tick,refresh,choose}:{entityId:string|null,entity:Row|null,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void,choose:(id:string)=>void}){
 const branches=useList('/branches',entityId,tick);
 const members=useList('/memberships',entityId,tick);
 const roles=useList('/roles',entityId,tick);
 const cmd=useCommand(refresh);
 const step=!entity?1:!(branches.items||[]).length?2:entity.state==='draft'?3:entity.state==='pending_activation'?4:5;
 const steps=['Organization','Branches','Members','Activation','Complete'];
 const entityForm=<Editor id={'entity'+(entity?.id||'new')+(entity?.version||0)} label={entity?'Save organization':'Create organization'} disabled={!(entity?can('entity.edit'):can('entity.create'))} onSave={async d=>{const body={legalName:d.legalName,baseCurrency:'PHP',timezone:d.timezone,fiscalYearStartMonth:Number(d.fiscalYearStartMonth)};const r=entity?await cmd.run('PATCH','/entities/'+entity.id,{ifMatch:entity.version,body}):await cmd.run('POST','/entities',{body});if(r&&!entity)choose(r.data.id);return !!r;}}>{input('Legal name','legalName',entity?.legalName||'','text',{required:true})}{input('Base currency','baseCurrency','PHP','text',{readOnly:true})}<p className="eyebrow">PHP is fixed in this release; other currencies arrive with separate books (P09).</p>{select('Fiscal year starts in','fiscalYearStartMonth',['January','February','March','April','May','June','July','August','September','October','November','December'].map((m,i)=>[String(i+1),m] as [string,string]),String(entity?.fiscalYearStartMonth||1))}{select('Time zone','timezone',[['Asia/Manila','Asia/Manila'],['Asia/Singapore','Asia/Singapore'],['UTC','UTC']],entity?.timezone||'Asia/Manila')}</Editor>;
 return <><ol className="setup-steps" aria-label="Setup progress">{steps.map((s,i)=><li key={s} aria-current={step===i+1?'step':undefined}>{i+1}. {s}{step>i+1&&' ✓'}</li>)}</ol>
  <ErrorPanel error={cmd.error||branches.error||members.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <section className="demo-card"><h2>1. Organization</h2>{entity&&<p>{entity.legalName} · {entity.state.replace('_',' ')} · content version {entity.contentVersion}. Material edits return an active or pending organization to draft and require a new approval.</p>}{entityForm}</section>
  {entity&&<section className="demo-card"><h2>2. Branches</h2>{table(['Code','Name','Address'],(branches.items||[]).map(b=>[b.code,b.name,b.address]),'At least one branch is required before activation.')}{can('branch.create')&&<Editor id={'branch-new'+entity.id} label="Add branch" onSave={async d=>!!await cmd.run('POST','/branches',{entityId:entity.id,body:{code:d.code,name:d.name,address:d.address}})}>{input('Code','code','HQ','text',{required:true,pattern:'[A-Za-z0-9][A-Za-z0-9-]{0,15}'})}{input('Name','name','','text',{required:true})}{input('Address','address','','text',{required:true})}</Editor>}</section>}
  {entity&&<section className="demo-card"><h2>3. Members and roles</h2><p>An independent controller (a different person holding entity.activate) must exist before activation. Roles come from approved templates; security administration carries no accounting authority.</p>{table(['Principal','Role','Scope','Status','Revoke'],(members.items||[]).map(m=>[m.principalId===me.principalId?'Me':m.principalId.slice(0,8),(roles.items||[]).find(r=>r.id===m.roleId)?.name||m.roleId.slice(0,8),m.branchIds.length?'Branch':'Entity',m.state,m.state==='active'&&can('membership.revoke')?<button disabled={cmd.busy} onClick={()=>{const reason=window.prompt('Reason for revoking this membership');if(reason)void cmd.run('POST','/memberships/'+m.id+'/revoke',{entityId:entity.id,ifMatch:m.version,body:{reason}});}}>Revoke</button>:'—']),'No memberships on this entity yet.')}{can('membership.create')&&<Editor id={'member-new'+entity.id} label="Add membership" onSave={async d=>!!await cmd.run('POST','/memberships',{entityId:entity.id,body:{principalId:d.principalId,roleId:d.roleId,branchIds:[]}})}>{input('Principal id','principalId','','text',{required:true,pattern:'[0-9a-fA-F-]{36}',placeholder:'From the invitation record'})}<label>Role<select name="roleId" required>{(roles.items||[]).filter(r=>r.state==='approved').map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label></Editor>}</section>}
  {entity&&<section className="demo-card"><h2>4. Activation</h2><p>{entity.state==='active'?'Approved and active.':entity.state==='pending_activation'?'Requested. A controller other than the requester approves with the current content version.':'Request activation when the checklist is complete; blockers are listed here.'}</p><div className="action-row">{entity.state==='draft'&&can('entity.edit')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/entities/'+entity.id+'/activate',{ifMatch:entity.version,body:{reason:'Setup checklist complete'}})}>Request activation</button>}{entity.state==='pending_activation'&&can('entity.activate')&&<button disabled={cmd.busy} onClick={()=>void cmd.run('POST','/entities/'+entity.id+'/activate',{ifMatch:entity.version,body:{reason:'Reviewed setup checklist'}})}>Approve activation</button>}</div></section>}
  {entity?.state==='active'&&<section className="demo-card"><h2>5. Complete</h2><p>The workspace capability is enabled. Financial modules stay disabled until their own releases.</p>{link('/work','Go to my work')}</section>}</>;
}
