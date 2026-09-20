"use client";
// P13 customer and supplier portals and messaging. For the internal team:
// invites and memberships, the communication timeline (drafts authorized by
// a named principal, delivery receipts and the failed-delivery task), payment
// links and the provider event log. For a portal member: their own invoices,
// statement and certificates, the supplier submission inbox with its review
// status, and the payment link with the customer-paid claim shown apart from
// the provider-settled receipt. No screen sends, settles or posts by itself.
import {useEffect,useState} from 'react';
import {api,asError,useCommand,ErrorPanel,Editor,table,link,useList,Loading,input,select,when,type Row,type ApiError} from './workspace-kit';

const money=(v:string|number|null|undefined,c='PHP')=>v==null?'—':new Intl.NumberFormat('en-PH',{style:'currency',currency:c}).format(Number(v));
const short=(id?:string|null)=>id?id.slice(0,8):'—';
const inDays=(d:number)=>new Date(Date.now()+d*86400000).toISOString();
type Ctx={entityId:string,me:Row,can:(p:string)=>boolean,tick:number,refresh:()=>void};
function NotEnabled({me}:{me:Row}){return <section className="demo-card"><h2>Portals not enabled</h2><p>The portals capability is activated per entity after sales, purchasing, treasury and compliance, once the qualified channel, the payment provider, the consent and notification policy, the terms and support are recorded in the portal profile. {me.permissions.includes('capability.activate')?<a href="/settings/capabilities">Open capability activation.</a>:'Ask the controller to request activation.'}</p></section>;}

// Internal: invites, members, messages, payment links.
export function PortalAdmin({entityId,me,can,tick,refresh}:Ctx){
 if(!me.capabilities.includes('portals'))return <NotEnabled me={me}/>;
 const invites=useList('/portal-invites',entityId,tick);
 const members=useList('/portal-memberships',entityId,tick);
 const parties=useList('/parties',entityId,tick);
 const messages=useList('/message-requests',entityId,tick);
 const links=useList('/payment-links',entityId,tick);
 const invoices=useList('/invoices',entityId,tick,{state:'posted'});
 const hooks=useList('/webhook-receipts',entityId,tick);
 const cmd=useCommand(refresh);
 const [error,setError]=useState<ApiError|null>(null);
 const [openReceipts,setOpenReceipts]=useState<string|null>(null),[receipts,setReceipts]=useState<Row|null>(null);
 useEffect(()=>{if(!openReceipts){setReceipts(null);return;}setReceipts(null);api('GET','/message-requests/'+openReceipts+'/receipts',{entityId}).then(r=>setReceipts(r.data)).catch(e=>setError(asError(e)));},[openReceipts,tick]);
 const partyName=(id:string)=>(parties.items||[]).find((p:Row)=>p.id===id)?.legalName||short(id);
 const customers=(parties.items||[]).filter((p:Row)=>(p.roles||[]).includes('customer')),suppliers=(parties.items||[]).filter((p:Row)=>(p.roles||[]).includes('supplier'));
 return <>
  <ErrorPanel error={error||cmd.error||invites.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  {can('portal_invite.create')&&<section className="demo-card"><h2>Invite a customer or supplier</h2><p>An invite binds one address to one party and one role for at most 30 days; the link travels only in the authorized message and is rotated at every send. Revocation ends hosted access at once.</p><Editor id={'inv-new'+entityId} label="Create invite" resetOnSave onSave={async d=>!!await cmd.run('POST','/portal-invites',{entityId,body:{partyId:d.partyId,email:d.email,role:d.role,expiresAt:inDays(Number(d.days||7))}})}>
   {select('Role','role',[['customer','Customer'],['supplier','Supplier']],'customer')}
   <label>Party<select name="partyId" required><option value="">Select party</option>{[...customers,...suppliers].map((p:Row)=><option key={p.id} value={p.id}>{p.legalName} ({(p.roles||[]).join(', ')})</option>)}</select></label>
   {input('Email','email','','email',{required:true})}{input('Valid for (days)','days','7','number',{min:1,max:30})}
  </Editor></section>}
  <h2>Invites</h2>
  {invites.items===null?<Loading/>:table(['Party','Address','Role','Expires','State','Actions'],invites.items.map(i=>[partyName(i.partyId),i.email,i.role,when(i.expiresAt),i.state,<div key="a" className="action-row">{i.state==='pending'&&can('message_request.create')&&<button type="button" disabled={cmd.busy} onClick={()=>void cmd.run('POST','/message-requests',{entityId,body:{sourceType:'portal_invite',sourceId:i.id,recipientPartyId:i.partyId,channel:'email',templateVersion:'invite-2026'}})}>Draft invite message</button>}{['pending','accepted'].includes(i.state)&&can('portal_invite.revoke')&&<Editor id={'rev'+i.id} label="Revoke" onSave={async d=>!!await cmd.run('POST','/portal-invites/'+i.id+'/revoke',{entityId,ifMatch:i.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No invites yet.')}
  <h2>Members</h2>
  {members.items===null?<Loading/>:table(['Party','Role','Kinds','State','Since'],members.items.map(m=>[partyName(m.partyId),m.role,m.allowedKinds.join(', '),m.state,when(m.createdAt)]),'No portal members yet.')}
  <h2>Communication timeline</h2>
  <p>Drafts name the source, the recipient and the approved template; a principal other than the drafter authorizes the send, which happens once through the qualified channel with a receipt per attempt. Content carries only an authenticated link.</p>
  {can('message_request.create')&&<section className="demo-card"><h3>New message</h3><Editor id={'msg-new'+entityId} label="Draft message" resetOnSave onSave={async d=>!!await cmd.run('POST','/message-requests',{entityId,body:{sourceType:d.sourceType,sourceId:d.sourceType==='statement'||d.sourceType==='balance_confirmation'?d.recipientPartyId:d.sourceId,recipientPartyId:d.recipientPartyId,channel:d.channel,templateVersion:d.templateVersion}})}>
   {select('Source','sourceType',[['document','Posted document'],['reminder','Reminder on a document'],['statement','Statement'],['balance_confirmation','Balance confirmation']],'document')}
   <label>Recipient<select name="recipientPartyId" required><option value="">Select party</option>{(parties.items||[]).map((p:Row)=><option key={p.id} value={p.id}>{p.legalName}</option>)}</select></label>
   <label>Document (for document or reminder)<select name="sourceId"><option value="">None</option>{(invoices.items||[]).map((d:Row)=><option key={d.id} value={d.id}>{d.officialNumber||short(d.id)} · {partyName(d.partyId)} · {money(d.gross,d.currency)}</option>)}</select></label>
   {select('Channel','channel',[['email','Email'],['portal','Portal'],['qualified_chat','Qualified chat']],'email')}{input('Template','templateVersion','invoice-2026','text',{required:true,pattern:'[a-z0-9][a-z0-9._-]{0,99}'})}
  </Editor></section>}
  {messages.items===null?<Loading/>:table(['Created','Source','Recipient','Channel','Template','State','Actions'],messages.items.map(m=>[when(m.createdAt),m.sourceType.replace(/_/g,' ')+' '+short(m.sourceId),partyName(m.recipientPartyId),m.channel,m.templateVersion,m.state,<div key="a" className="action-row"><button type="button" onClick={()=>setOpenReceipts(openReceipts===m.id?null:m.id)}>{openReceipts===m.id?'Hide receipts':'Receipts'}</button>{['draft','failed'].includes(m.state)&&can('message_request.send')&&<Editor id={'send'+m.id} label="Authorize and send" onSave={async d=>!!await cmd.run('POST','/message-requests/'+m.id+'/send',{entityId,ifMatch:m.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No messages yet.')}
  {openReceipts&&<section className="demo-card"><h3>Delivery receipts</h3>{receipts===null?<Loading/>:table(['Attempt','Provider','Outcome','Reference','Error','At'],receipts.receipts.map((r:Row)=>[r.attempt,r.provider,r.outcome,r.providerReference||'—',r.error||'—',when(r.createdAt)]),'No attempts yet; the worker sends authorized messages.')}</section>}
  <h2>Payment links</h2>
  <p>A link is a provider intent for a posted invoice, keyed once. The customer's browser return is only a claim; the provider's signed event, verified server to server, drafts the receipt for the normal collection review.</p>
  {can('payment_link.create')&&<section className="demo-card"><h3>New payment link</h3><Editor id={'pl-new'+entityId} label="Create link" resetOnSave onSave={async d=>{const inv=(invoices.items||[]).find((x:Row)=>x.id===d.invoiceId);return !!await cmd.run('POST','/payment-links',{entityId,body:{invoiceId:d.invoiceId,amount:d.amount,currency:inv?.currency||'PHP',expiresAt:inDays(Number(d.days||14))}});}}>
   <label>Invoice<select name="invoiceId" required><option value="">Select posted invoice</option>{(invoices.items||[]).map((d:Row)=><option key={d.id} value={d.id}>{d.officialNumber||short(d.id)} · {partyName(d.partyId)} · {money(d.gross,d.currency)}</option>)}</select></label>
   {input('Amount','amount','','text',{required:true,inputMode:'decimal'})}{input('Valid for (days)','days','14','number',{min:1,max:60})}
  </Editor></section>}
  {links.items===null?<Loading/>:table(['Invoice','Amount','Expires','State','Actions'],links.items.map(l=>[short(l.invoiceId),money(l.amount,l.currency),when(l.expiresAt),l.state,<div key="a" className="action-row">{['pending','created'].includes(l.state)&&can('payment_link.cancel')&&<Editor id={'cancel'+l.id} label="Cancel" onSave={async d=>!!await cmd.run('POST','/payment-links/'+l.id+'/cancel',{entityId,ifMatch:l.version,body:{reason:d.reason}})}>{input('Reason','reason','','text',{required:true})}</Editor>}</div>]),'No payment links yet.')}
  <h3>Provider events</h3>
  {hooks.items===null?<Loading/>:table(['Received','Provider','Event','Type','Signature','Outcome','Reason'],hooks.items.map((h:Row)=>[when(h.receivedAt),h.provider,h.eventId,h.eventType||'—',h.signatureState,h.outcome,h.reason||'—']),'No provider events yet.')}
 </>;
}

// A portal member's home: own records only, uploads to review, claims apart from receipts.
export function PortalHome({entityId,me,tick,refresh}:Ctx){
 const [scope,setScope]=useState<Row|null>(null),[error,setError]=useState<ApiError|null>(null);
 useEffect(()=>{api('GET','/portal/me',{entityId}).then(r=>setScope(r.data)).catch(e=>setError(asError(e)));},[entityId,tick]);
 const isCustomer=scope?.role==='customer';
 const invoices=useList(isCustomer?'/invoices':'/bills',entityId,tick);
 const items=useList('/open-items',entityId,tick,{open:'true'});
 const certificates=useList('/certificates',entityId,tick);
 const uploads=useList('/evidence',entityId,tick);
 const links=useList(isCustomer?'/payment-links':'/evidence',entityId,tick);
 const cmd=useCommand(refresh);
 const [uploadError,setUploadError]=useState<ApiError|null>(null);
 async function submit(file:File){
  try{
   const bytes=new Uint8Array(await file.arrayBuffer());
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
   const reg=await api('POST','/evidence/uploads',{entityId,key:crypto.randomUUID(),body:{filename:file.name,mime:file.type||'text/csv',byteCount:bytes.length,sha256:digest,classification:'internal'}});
   await api('PUT','/evidence/'+reg.data.evidenceId+'/content',{entityId,raw:bytes,headers:{'content-type':'application/octet-stream'}});
   await api('POST','/evidence/'+reg.data.evidenceId+'/complete',{entityId,key:crypto.randomUUID(),ifMatch:1});
   setUploadError(null);await refresh();
  }catch(e){setUploadError(asError(e));}
 }
 if(error)return <ErrorPanel error={error}/>;
 if(!scope)return <Loading/>;
 return <>
  <ErrorPanel error={uploadError||cmd.error||invoices.error} onRetry={cmd.retry} onReload={cmd.reload} canRetry={cmd.canRetry}/>
  <section className="demo-card"><h2>{scope.partyName}</h2><p>{scope.role==='customer'?'Customer':'Supplier'} portal of {scope.entityName}. You see only your own records; requests are reviewed by the finance team. {scope.supportEmail?'Support: '+scope.supportEmail+'.':''} {scope.termsVersion?'Terms '+scope.termsVersion+'.':''}</p></section>
  <h2>{isCustomer?'Invoices':'Bills'}</h2>
  {invoices.items===null?<Loading/>:table(['Number','Date','Amount','State','Settlement'],invoices.items.map((d:Row)=>[d.officialNumber||short(d.id),d.documentDate,money(d.gross,d.currency),d.state,d.settlementState]),isCustomer?'No invoices yet.':'No bills yet.')}
  {isCustomer&&<><h2>Statement</h2>{items.items===null?<Loading/>:table(['Document','Due','Original','Outstanding','State'],items.items.map((i:Row)=>[short(i.documentId),i.dueDate,money(i.originalAmount,i.currency),money(i.outstandingAmount,i.currency),Number(i.outstandingAmount)>0?'open':'settled']),'Nothing outstanding.')}
   <h2>Payment links</h2><p>"I have paid" records your claim; the receipt is recorded only when the provider confirms the payment to us.</p>
   {links.items===null?<Loading/>:table(['Invoice','Amount','Expires','State','Actions'],links.items.map((l:Row)=>[short(l.invoiceId),money(l.amount,l.currency),when(l.expiresAt),l.state==='settled'?'provider-settled (receipt drafted)':l.state,<div key="a" className="action-row">{['pending','created'].includes(l.state)&&<Editor id={'claim'+l.id} label="I have paid" onSave={async d=>!!await cmd.run('POST','/payment-links/'+l.id+'/claim',{entityId,ifMatch:l.version,body:{reason:d.reason||'Customer reports payment'}})}>{input('Reference (optional)','reason','','text')}</Editor>}</div>]),'No payment links.')}</>}
  <h2>Certificates</h2>
  {certificates.items===null?<Loading/>:table(['Period','Basis','Tax','State','Issued'],certificates.items.map((c:Row)=>[c.periodKey,money(c.basisTotal),money(c.taxTotal),c.state,when(c.issuedAt)]),'No certificates yet.')}
  <h2>{isCustomer?'Upload a 2307':'Submit an invoice'}</h2>
  <p>{isCustomer?'Upload your withholding certificate for our review.':'Upload your invoice (with TIN, number, date and total); it is quarantined, scanned and reviewed by the finance team — never posted from the upload.'}</p>
  <div className="demo-form"><label>File<input type="file" aria-label="Submission file" onChange={e=>{const f=e.target.files?.[0];if(f)void submit(f);}}/></label></div>
  <h3>Your uploads</h3>
  {uploads.items===null?<Loading/>:table(['File','Size','State','Uploaded'],uploads.items.map((u:Row)=>[u.filename,u.byteCount+' bytes',u.state,when(u.createdAt)]),'No uploads yet.')}
 </>;
}

// Acceptance of an invite link by the invited identity (outside the shell:
// the identity has no membership until the token is accepted).
export function PortalAccept(){
 const [state,setState]=useState<'idle'|'busy'|'done'|'error'>('idle'),[error,setError]=useState<ApiError|null>(null),[params,setParams]=useState<Record<string,string>>({});
 useEffect(()=>{const p=new URLSearchParams(window.location.search);setParams({tenant:p.get('tenant')||'',invite:p.get('invite')||'',token:p.get('token')||''});},[]);
 async function accept(e:{preventDefault:()=>void,currentTarget:HTMLFormElement}){
  e.preventDefault();setState('busy');
  const email=String(new FormData(e.currentTarget).get('email')||'');
  try{await api('POST','/portal-invites/'+params.invite+'/accept',{key:crypto.randomUUID(),headers:{'x-tenant-id':params.tenant},body:{token:params.token,...(email?{email}:{})}});setState('done');}
  catch(err){setError(asError(err));setState('error');}
 }
 return <main className="workspace-page"><h1>Accept your portal invite</h1>
  {state==='done'?<section className="demo-card" role="status"><h2>Welcome</h2><p>Your portal access is active. <a href="/portal">Open the portal.</a></p></section>:<>
   {!params.token&&<p role="alert">This link is incomplete; ask for a new invite.</p>}
   {error&&<ErrorPanel error={error}/>}
   <form className="demo-form" onSubmit={accept}><label>Email address on the invite<input name="email" type="email" required/></label><p>Accepting binds this sign-in to the invited party only; another company's invite needs its own acceptance.</p><button type="submit" disabled={state==='busy'||!params.token}>Accept invite</button></form>
  </>}
 </main>;
}
