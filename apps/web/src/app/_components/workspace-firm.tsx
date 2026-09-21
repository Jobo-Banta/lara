"use client";
// P14 accounting firm multi-client workspace. In the firm's own organization:
// the firm record and staff, the assigned-client list with the client
// switcher (an explicit client context carried on every call), the deadline
// and exception roll-up labelled by entity and currency, and the bulk
// reminder fan-out with one outcome per client. In a client organization:
// the mandates the client grants (drafted, approved by a second principal,
// revoked) and the staff assignments the firm makes under its mandate. No
// screen crosses a client boundary; every action runs under one tenant.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,useList,Loading,input,select,when,type Row,type ApiError} from './workspace-kit';

const short=(id?:string|null)=>id?id.slice(0,8):'—';
const inDays=(d:number)=>new Date(Date.now()+d*86400000).toISOString();
type Ctx={entityId:string|null,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
export const DELEGABLE:[string,string][]=[['task.read','Tasks (read)'],['task.create','Tasks (create)'],['obligation.read','Obligations (read)'],['open_item.read','Open items (read)'],['period.read','Periods (read)'],['invoice.read','Invoices (read)'],['bill.read','Bills (read)'],['journal.read','Journals (read)'],['journal.prepare','Journals (prepare)'],['journal.approve','Journals (approve)'],['party.read','Parties (read)'],['report.generate','Reports'],['evidence.read','Evidence (read)'],['message_request.create','Messages (draft)'],['message_request.read','Messages (read)'],['firm_assignment.create','Firm assignments (create)'],['firm_assignment.read','Firm assignments (read)'],['firm_assignment.edit','Firm assignments (edit)']];

// The firm side.
export function FirmWorkspace({me,can,tick,refresh}:Ctx){
 const [firmsLoaded,setFirmsLoaded]=useState<Row[]|null>(null);
 useEffect(()=>{api('GET','/firms').then(r=>setFirmsLoaded(r.data.items)).catch(()=>setFirmsLoaded([]));},[tick]);
 const firm=firmsLoaded?.[0]||null;
 const [staff,setStaff]=useState<Row[]|null>(null);
 useEffect(()=>{if(!firm){setStaff(null);return;}api('GET','/firms/'+firm.id+'/staff').then(r=>setStaff(r.data.items)).catch(()=>setStaff([]));},[firm?.id,tick]);
 const [clients,setClients]=useState<Row[]|null>(null),[rollup,setRollup]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null),[bulk,setBulk]=useState<Row|null>(null);
 useEffect(()=>{api('GET','/firm/clients').then(r=>setClients(r.data.items)).catch(e=>{setClients([]);setError(asError(e));});},[tick]);
 const cmd=useCommand(refresh);
 const openClient=(c:Row)=>{try{sessionStorage.setItem('lara-tenant',c.tenantId);sessionStorage.setItem('lara-entity',c.entityId);sessionStorage.setItem('lara-client-label',c.entityName+' ('+c.tenantName+')');}catch{}window.location.href='/work';};
 return <>
  <ErrorPanel error={error||cmd.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <section className="demo-card"><h2>Firm</h2>{firmsLoaded===null?<Loading/>:firm?<><p><strong>{firm.name}</strong> · firm id <code>{firm.id}</code> — give this id to a client so it can grant a mandate. Plan: {JSON.stringify(firm.plan)} (commercial metadata, never authorization).</p>
   <h3>Staff</h3>{staff===null?<Loading/>:table(['Principal','Role','State','Since'],staff.map(s=>[short(s.principalId),s.role,s.state,when(s.createdAt)]),'No staff enrolled yet; the owner acts alone.')}
   {can('firm_assignment.create')&&<Editor id={'staff'+firm.id} label="Enrol staff" resetOnSave onSave={async d=>!!await cmd.run('POST','/firms/'+firm.id+'/staff',{body:{principalId:d.principalId,role:d.role}})}>{input('Principal id (a member of this organization)','principalId','','text',{required:true})}{select('Role','role',[['staff','Staff'],['manager','Manager'],['partner','Partner']],'staff')}</Editor>}
  </>:can('firm_assignment.create')?<><p>This organization is not registered as a firm yet. Registering creates the firm record whose id clients use to grant mandates; it grants no access by itself.</p><Editor id={'firm-new'} label="Register firm" onSave={async d=>!!await cmd.run('POST','/firms',{body:{name:d.name}})}>{input('Firm name','name','','text',{required:true})}</Editor></>:<p>This organization is not registered as a firm.</p>}</section>
  <h2>Assigned clients</h2>
  <p>Only clients whose approved mandate names you appear here; opening one sets an explicit client context on every call until you leave it.</p>
  {clients===null?<Loading/>:table(['Client','Organization','Permissions','Mandate until','Actions'],clients.map(c=>[c.entityName,c.tenantName,c.permissions.length+' permission(s)',when(c.validTo),<div key="a" className="action-row"><button type="button" onClick={()=>openClient(c)}>Open client</button></div>]),'No client has mandated you yet.')}
  <h2>Deadline and exception roll-up</h2>
  <div className="action-row"><button type="button" onClick={()=>{setRollup(null);api('GET','/firm/rollup').then(r=>setRollup(r.data)).catch(e=>setError(asError(e)));}}>Refresh roll-up</button></div>
  {rollup&&table(['Client','Open tasks','Overdue obligations','Open periods','Open items by currency'],rollup.items.map((i:Row)=>[i.entityName+' ('+i.tenantName+')',i.counts?String(i.counts.openTasks??'—'):'—',i.counts?String(i.counts.overdueObligations??'—'):'—',i.counts?String(i.counts.openPeriods??'—'):'—',i.counts?<ul key="c">{i.counts.openItems.map((o:Row,k:number)=><li key={k}>{o.side} {o.currency} {o.outstanding} ({o.count})</li>)}{!i.counts.openItems.length&&<li>none</li>}</ul>:(i.error||'—')]),'No client scope to roll up.')}
  {rollup&&<p>As of {when(rollup.asOf)} · checksum {rollup.checksum.slice(0,12)}… · amounts stay per client and currency; nothing is summed across them.</p>}
  <h2>Bulk reminders</h2>
  <p>One independent reminder draft per selected client, under your delegated identity there; each client's own authorizer still sends.</p>
  {clients&&clients.length>0&&<Editor id="bulk" label="Draft reminders" onSave={async d=>{const chosen=clients.filter(c=>d['c:'+c.assignmentId]==='on').map(c=>({tenantId:c.tenantId,entityId:c.entityId}));const r=await cmd.run('POST','/firm/bulk-reminders',{body:{clients:chosen,templateVersion:d.templateVersion,channel:'email'}});if(r)setBulk(r.data);return !!r;}}>
   <fieldset><legend>Clients</legend>{clients.map(c=><label key={c.assignmentId}><input type="checkbox" name={'c:'+c.assignmentId}/> {c.entityName}</label>)}</fieldset>
   {input('Template','templateVersion','reminder-2026','text',{required:true,pattern:'[a-z0-9][a-z0-9._-]{0,99}'})}
  </Editor>}
  {bulk&&table(['Client','Outcome','Detail'],bulk.outcomes.map((o:Row)=>[clients?.find(c=>c.entityId===o.entityId)?.entityName||short(o.entityId),o.outcome,o.reason||'—']),'')}
 </>;
}

// The client side: mandates the client grants and assignments the firm makes.
export function ClientMandates({entityId,me,can,tick,refresh}:Ctx){
 const mandates=useList('/firm-mandates',entityId,tick);
 const assignments=useList('/firm-assignments',entityId,tick);
 const evidence=useList('/evidence',entityId,tick,{status:'available'});
 const cmd=useCommand(refresh);
 const [error]=useState<ApiError|null>(null);
 const delegate=!me.permissions.includes('firm_mandate.create')&&me.permissions.includes('firm_assignment.create');
 return <>
  <ErrorPanel error={error||cmd.error||mandates.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('firm_mandate.create')&&<section className="demo-card"><h2>Grant a mandate</h2><p>A mandate names the firm (by its id), the entities, the permissions it may exercise and an expiry within a year, on the signed engagement letter. A second principal approves; an approved mandate never widens — revoke it and grant another. Security authorities are never delegated.</p><Editor id={'mandate-new'+entityId} label="Draft mandate" resetOnSave onSave={async d=>{const permissions=DELEGABLE.map(([k])=>k).filter(k=>d['p:'+k]==='on');return !!await cmd.run('POST','/firm-mandates',{entityId,body:{firmId:d.firmId,permissions,entityIds:[entityId],validUntil:inDays(Number(d.days||90)),evidenceIds:[d.evidenceId]}});}}>
   {input('Firm id','firmId','','text',{required:true})}
   <fieldset><legend>Permissions</legend>{DELEGABLE.map(([k,l])=><label key={k}><input type="checkbox" name={'p:'+k} defaultChecked={['task.read','obligation.read','open_item.read','period.read'].includes(k)}/> {l}</label>)}</fieldset>
   {input('Valid for (days)','days','90','number',{min:1,max:366})}
   <label>Engagement evidence<select name="evidenceId" required><option value="">Select available evidence</option>{(evidence.items||[]).map((e:Row)=><option key={e.id} value={e.id}>{e.filename}</option>)}</select></label>
  </Editor></section>}
  <h2>Mandates</h2>
  {mandates.items===null?<Loading/>:table(['Firm','Permissions','Entities','Valid until','State','Actions'],mandates.items.map(m=>[short(m.firmId),m.permissions.length,m.entityIds.length,when(m.validUntil),m.state,<div key="a" className="action-row">{m.state==='draft'&&can('firm_mandate.approve')&&<button type="button" disabled={cmd.busy} onClick={()=>void cmd.run('POST','/firm-mandates/'+m.id+'/approve',{entityId,ifMatch:m.version,body:{decision:'approve',contentVersion:m.contentVersion}})}>Approve</button>}{['draft','approved'].includes(m.state)&&can('firm_mandate.revoke')&&<Editor id={'revm'+m.id} label="Revoke" onSave={async d=>!!await cmd.run('POST','/firm-mandates/'+m.id+'/revoke',{entityId,ifMatch:m.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No mandate granted.')}
  <h2>Firm assignments</h2>
  {delegate&&<section className="demo-card"><h3>Assign a staff member</h3><p>Under your mandate only, a subset of its permissions, for your firm's staff (their principal id in the firm).</p><Editor id={'assign-new'+entityId} label="Assign" resetOnSave onSave={async d=>{const subset=DELEGABLE.map(([k])=>k).filter(k=>d['s:'+k]==='on');return !!await cmd.run('POST','/firm-assignments',{entityId,body:{mandateId:d.mandateId,principalId:d.principalId,entityIds:[entityId],permissionSubset:subset}});}}>
   <label>Mandate<select name="mandateId" required><option value="">Select</option>{(mandates.items||[]).filter(m=>m.state==='approved').map(m=><option key={m.id} value={m.id}>{short(m.id)} · until {when(m.validUntil)}</option>)}</select></label>
   {input('Staff principal id (in the firm)','principalId','','text',{required:true})}
   <fieldset><legend>Permission subset</legend>{DELEGABLE.map(([k,l])=><label key={k}><input type="checkbox" name={'s:'+k}/> {l}</label>)}</fieldset>
  </Editor></section>}
  {assignments.items===null?<Loading/>:table(['Mandate','Staff principal','Permissions','State','Since'],assignments.items.map(a=>[short(a.mandateId),short(a.principalId),a.permissionSubset.join(', '),a.state,when(a.createdAt)]),'No assignments.')}
 </>;
}
