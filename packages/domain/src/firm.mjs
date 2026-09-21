// Accounting firm multi-client workspace (P14): a firm and its staff in the
// firm's own tenant; mandates granted and approved inside each client
// tenant with entities, permissions, expiry and evidence; delegated
// identities (assignments) that act in the client tenant with a subset of
// the mandate, revoked with it; client scopes and aggregate counts resolved
// through the restricted authorization functions keyed by the caller's own
// identity; per-client fan-out of bulk actions as independent drafts; and
// snapshots invalidated the moment a mandate is revoked. Maker-checker holds
// inside each client because the same identity is one principal there,
// whether it arrives by membership or by mandate.
import {createHash} from 'node:crypto';
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource,DomainError} from './core.mjs';
import * as identity from './identity.mjs';
import {linkEvidence} from './evidence.mjs';

const sha=v=>createHash('sha256').update(String(v)).digest('hex');
// Authorities a client may never delegate to a firm: tenant security and the firm records themselves.
const NEVER_DELEGATED=/^(role\.|membership\.|entity\.activate|capability\.activate|firm_mandate\.|tool_grant\.)/;

// ---------------------------------------------------------------------------
// Firm tenant: the firm record and its staff
// ---------------------------------------------------------------------------
const firmResource=r=>({id:r.id,version:Number(r.version),name:r.name,ownerPrincipalId:r.owner_principal_id,plan:r.plan,state:r.status,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
const staffResource=r=>({id:r.id,version:Number(r.version),firmId:r.firm_id,principalId:r.principal_id,role:r.role,state:r.status,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
export async function createFirm(tx,ctx,{name,plan={}}){
 requirePermission(ctx,'firm_assignment.create');
 if(typeof name!=='string'||!name.trim()||name.length>200)fail('VALIDATION_FAILED','name is 1–200 characters.',{fieldErrors:[{path:'name',message:'1–200 characters'}]});
 if(![...ctx.entityIds][0])fail('STATE_CONFLICT','Register the legal entity of the firm first; firm records are audited against it.');
 const existing=(await tx.query('select id from lara.firms where tenant_id=$1',[ctx.tenantId])).rows[0];
 if(existing)fail('STATE_CONFLICT','This organization already is a firm ('+existing.id+').');
 const row=(await tx.query('insert into lara.firms(tenant_id,name,owner_principal_id,plan,created_by) values($1,$2,$3,$4,$3) returning *',[ctx.tenantId,name.trim(),ctx.principalId,JSON.stringify(plan&&typeof plan==='object'?plan:{})])).rows[0];
 await audit(tx,ctx,{entityId:[...ctx.entityIds][0]||null,action:'firm.create',resourceType:'firm',resourceId:row.id,resourceVersion:1});
 return firmResource(row);
}
export async function listFirms(tx,ctx){
 requirePermission(ctx,'firm_assignment.read');
 return {items:(await tx.query('select * from lara.firms where tenant_id=$1',[ctx.tenantId])).rows.map(firmResource),nextCursor:null};
}
async function firmFor(tx,ctx,id){if(!isUuid(id))fail('NOT_FOUND','Firm not found.');const row=(await tx.query("select * from lara.firms where tenant_id=$1 and id=$2 and status='active'",[ctx.tenantId,id])).rows[0];if(!row)fail('NOT_FOUND','Firm not found.');return row;}
export async function addStaff(tx,ctx,firmId,{principalId,role}){
 requirePermission(ctx,'firm_assignment.create');
 const firm=await firmFor(tx,ctx,firmId);
 if(firm.owner_principal_id!==ctx.principalId&&!(await tx.query("select 1 from lara.firm_staff where tenant_id=$1 and firm_id=$2 and principal_id=$3 and role='partner' and status='active'",[ctx.tenantId,firmId,ctx.principalId])).rowCount)fail('FORBIDDEN','Only the firm owner or a partner adds staff.');
 if(!['partner','manager','staff'].includes(role))fail('VALIDATION_FAILED','role is partner, manager or staff.',{fieldErrors:[{path:'role',message:'partner|manager|staff'}]});
 if(!isUuid(principalId)||!(await tx.query("select 1 from lara.principals where tenant_id=$1 and id=$2 and status='active'",[ctx.tenantId,principalId])).rowCount)fail('NOT_FOUND','Principal not found in this firm.');
 const row=(await tx.query("insert into lara.firm_staff(tenant_id,firm_id,principal_id,role,created_by) values($1,$2,$3,$4,$5) on conflict (tenant_id,firm_id,principal_id) do update set role=excluded.role,status='active',revoked_reason=null returning *",[ctx.tenantId,firmId,principalId,role,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId:[...ctx.entityIds][0]||null,action:'firm.staff',resourceType:'firm_staff',resourceId:row.id,resourceVersion:Number(row.version),reason:role});
 return staffResource(row);
}
export async function listStaff(tx,ctx,firmId){
 requirePermission(ctx,'firm_assignment.read');await firmFor(tx,ctx,firmId);
 return {items:(await tx.query('select * from lara.firm_staff where tenant_id=$1 and firm_id=$2 order by created_at',[ctx.tenantId,firmId])).rows.map(staffResource),nextCursor:null};
}
async function identityOf(tx,ctx){const p=(await tx.query('select oidc_issuer,oidc_subject from lara.principals where tenant_id=$1 and id=$2',[ctx.tenantId,ctx.principalId])).rows[0];if(!p)fail('UNAUTHENTICATED','Unknown principal.');return p;}
// The caller's delegated client scopes, from the restricted function and the caller's own identity only.
export async function clientScopes(tx,ctx){
 requirePermission(ctx,'firm_mandate.read');
 const me=await identityOf(tx,ctx);
 const rows=(await tx.query('select * from lara.firm_scopes($1,$2)',[me.oidc_issuer,me.oidc_subject])).rows;
 return {items:rows.map(r=>({tenantId:r.client_tenant_id,tenantName:r.client_tenant_name,entityId:r.client_entity_id,entityName:r.client_entity_name,mandateId:r.mandate_id,assignmentId:r.assignment_id,principalId:r.principal_id,firmId:r.firm_id,permissions:r.permissions||[],validTo:iso(r.valid_to)})),nextCursor:null};
}
// Deadline and exception roll-up: one row per client scope with its own
// counts and open items labelled by currency; nothing is summed across
// clients or currencies. Every row is snapshotted under the mandate.
export async function rollup(tx,ctx){
 requirePermission(ctx,'firm_mandate.read');
 const me=await identityOf(tx,ctx);
 const firm=(await tx.query('select id from lara.firms where tenant_id=$1',[ctx.tenantId])).rows[0];
 const scopes=(await clientScopes(tx,ctx)).items;
 const items=[];
 for(const s of scopes){
  let counts;
  // A scope whose aggregate fails (mandate revoked between the listing and the read) is reported as unavailable without aborting the transaction for the others.
  await tx.query('savepoint firm_scope');
  try{counts=(await tx.query('select lara.firm_aggregate($1,$2,$3,$4) as c',[me.oidc_issuer,me.oidc_subject,s.tenantId,s.entityId])).rows[0].c;await tx.query('release savepoint firm_scope');}
  catch(e){await tx.query('rollback to savepoint firm_scope');items.push({...s,counts:null,error:'not available'});continue;}
  if(firm){const scopeHash=sha(s.tenantId+'|'+s.entityId);await tx.query('delete from lara.aggregate_snapshots where tenant_id=$1 and actor_principal_id=$2 and scope_hash=$3',[ctx.tenantId,ctx.principalId,scopeHash]);await tx.query('insert into lara.aggregate_snapshots(tenant_id,firm_id,actor_principal_id,mandate_id,client_tenant_id,client_entity_id,scope_hash,counts) values($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,firm.id,ctx.principalId,s.mandateId,s.tenantId,s.entityId,scopeHash,JSON.stringify(counts)]);}
  items.push({...s,counts:{openTasks:counts.openTasks??null,openObligations:counts.openObligations??null,overdueObligations:counts.overdueObligations??null,openPeriods:counts.openPeriods??null,openItems:counts.openItems||[]},error:null});
 }
 return {asOf:new Date().toISOString(),items,checksum:contentHash(items.map(i=>[i.tenantId,i.entityId,i.counts]))};
}
// Snapshots the firm still holds; a revoked mandate leaves none.
export async function listSnapshots(tx,ctx){
 requirePermission(ctx,'firm_mandate.read');
 return {items:(await tx.query('select * from lara.aggregate_snapshots where tenant_id=$1 and actor_principal_id=$2 order by as_of desc',[ctx.tenantId,ctx.principalId])).rows.map(r=>({id:r.id,mandateId:r.mandate_id,clientTenantId:r.client_tenant_id,clientEntityId:r.client_entity_id,scopeHash:r.scope_hash,asOf:iso(r.as_of),counts:r.counts})),nextCursor:null};
}
// Bulk fan-out: one independent command per client under that client's
// delegated identity and tenant, each in its own savepoint; an outcome per
// client; nothing crosses from one client to another.
export async function bulkReminders(tx,ctx,{clients,templateVersion,channel='email'},{portals}){
 requirePermission(ctx,'firm_mandate.read');
 const own=(await tx.query("select id from lara.firms where tenant_id=$1 and status='active'",[ctx.tenantId])).rows[0];
 if(!own)fail('STATE_CONFLICT','This organization is not registered as a firm.');
 if(!Array.isArray(clients)||!clients.length||clients.length>50)fail('VALIDATION_FAILED','clients names 1–50 client scopes.',{fieldErrors:[{path:'clients',message:'1–50'}]});
 const me=await identityOf(tx,ctx);
 const scopes=(await tx.query('select * from lara.firm_scopes($1,$2)',[me.oidc_issuer,me.oidc_subject])).rows;
 const outcomes=[];
 for(const [i,c] of clients.entries()){
  const scope=scopes.find(s=>s.client_tenant_id===c.tenantId&&s.client_entity_id===c.entityId);
  if(!scope){outcomes.push({tenantId:c.tenantId,entityId:c.entityId,outcome:'refused',reason:'No delegated scope for that client.',resourceIds:[]});continue;}
  await tx.query('savepoint client_'+i);
  try{
   await tx.query("select set_config('lara.tenant_id',$1,false)",[scope.client_tenant_id]);
   const actor=await identity.actorContext(tx,scope.client_tenant_id,scope.principal_id,{traceId:ctx.traceId});
   const parties=(await tx.query("select i.party_id from lara.open_items i where i.tenant_id=$1 and i.entity_id=$2 and i.side='AR' and i.status in ('open','partially_settled') and i.due_date<current_date"+(c.partyId?' and i.party_id=$3':'')+' group by i.party_id',[scope.client_tenant_id,scope.client_entity_id,...(c.partyId?[c.partyId]:[])])).rows;
   const ids=[];
   for(const p of parties){
    const doc=(await tx.query("select d.id from lara.documents d join lara.open_items i on i.tenant_id=d.tenant_id and i.document_id=d.id where d.tenant_id=$1 and d.entity_id=$2 and d.party_id=$3 and d.state='posted' and i.status in ('open','partially_settled') order by i.due_date limit 1",[scope.client_tenant_id,scope.client_entity_id,p.party_id])).rows[0];
    if(!doc)continue;
    const m=await portals.createMessage(tx,actor,scope.client_entity_id,{sourceType:'reminder',sourceId:doc.id,recipientPartyId:p.party_id,channel,templateVersion});
    ids.push(m.id);
   }
   await tx.query('release savepoint client_'+i);
   outcomes.push({tenantId:c.tenantId,entityId:c.entityId,outcome:ids.length?'drafted':'nothing_due',reason:ids.length?ids.length+' reminder draft(s) await authorization in the client':'No overdue receivable.',resourceIds:ids});
  }catch(e){
   await tx.query('rollback to savepoint client_'+i);
   outcomes.push({tenantId:c.tenantId,entityId:c.entityId,outcome:'failed',reason:e instanceof DomainError?e.code+': '+e.message:'error',resourceIds:[]});
  }
 }
 await tx.query("select set_config('lara.tenant_id',$1,false)",[ctx.tenantId]);
 await audit(tx,ctx,{entityId:[...ctx.entityIds][0]||null,action:'firm.bulk_reminders',resourceType:'firm',resourceId:own.id,resourceVersion:1,reason:outcomes.map(o=>o.outcome).join(',')});
 return {firmId:own.id,outcomes};
}

// ---------------------------------------------------------------------------
// Client tenant: mandates and assignments
// ---------------------------------------------------------------------------
const mandateMaterial=i=>({firmId:i.firmId,permissions:[...i.permissions].sort(),entityIds:[...i.entityIds].sort(),validUntil:i.validUntil,evidenceIds:[...i.evidenceIds].sort()});
const mandateResource=r=>resource(r,{state:r.state,firmId:r.firm_id,permissions:r.permissions,entityIds:r.entity_ids,validUntil:iso(r.valid_to),evidenceIds:r.evidence_ids});
async function checkMandateInput(tx,ctx,entityId,input){
 const firm=(await tx.query('select * from lara.firm_lookup($1)',[input.firmId])).rows[0];
 if(!firm)fail('NOT_FOUND','Firm not found; ask the firm for its id.',{fieldErrors:[{path:'firmId',message:'Unknown firm'}]});
 if(firm.id===ctx.tenantId||(await tx.query('select 1 from lara.firms where tenant_id=$1 and id=$2',[ctx.tenantId,firm.id])).rowCount)fail('VALIDATION_FAILED','A firm does not mandate itself.',{fieldErrors:[{path:'firmId',message:'Own firm'}]});
 const known=new Set((await tx.query('select code from lara.permission_definitions')).rows.map(r=>r.code));
 const perms=[...new Set(input.permissions)];
 for(const p of perms){if(!known.has(p))fail('VALIDATION_FAILED','Unknown permission '+p+'.',{fieldErrors:[{path:'permissions',message:p}]});if(NEVER_DELEGATED.test(p))fail('VALIDATION_FAILED','Permission '+p+' is never delegated to a firm.',{fieldErrors:[{path:'permissions',message:p}]});}
 const ents=[...new Set(input.entityIds)];
 for(const e of ents){if(!isUuid(e)||!ctx.entityIds.has(e))fail('NOT_FOUND','Entity '+e+' is not in your scope.');}
 if(!ents.includes(entityId))fail('VALIDATION_FAILED','The mandate covers the entity of the request.',{fieldErrors:[{path:'entityIds',message:'Include '+entityId}]});
 const t=Date.parse(input.validUntil);if(Number.isNaN(t)||t<=Date.now())fail('VALIDATION_FAILED','validUntil is a future timestamp.',{fieldErrors:[{path:'validUntil',message:'Future'}]});
 if(t>Date.now()+366*86400000)fail('VALIDATION_FAILED','A mandate runs at most one year; renew it.',{fieldErrors:[{path:'validUntil',message:'At most one year'}]});
 return {firm,perms,ents};
}
export async function createMandate(tx,ctx,entityId,input){
 requirePermission(ctx,'firm_mandate.create');requireEntity(ctx,entityId);assertInput('FirmMandateCreate',input);
 if(ctx.firm)fail('FORBIDDEN','A delegated firm identity does not grant mandates.');
 const {firm,perms,ents}=await checkMandateInput(tx,ctx,entityId,input);
 const row=(await tx.query('insert into lara.client_mandates(tenant_id,entity_id,firm_id,firm_name,entity_ids,permissions,valid_to,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,firm.id,firm.name,ents,perms,input.validUntil,JSON.stringify(input.evidenceIds),contentHash(mandateMaterial(input)),ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'client_mandate',row.id,1);
 await audit(tx,ctx,{entityId,action:'firm_mandate.create',resourceType:'client_mandate',resourceId:row.id,resourceVersion:1,afterRef:row.content_hash,reason:firm.name});
 return mandateResource(row);
}
async function loadMandate(tx,ctx,entityId,id,{lock=false}={}){if(!isUuid(id))fail('NOT_FOUND','Mandate not found.');const row=(await tx.query('select * from lara.client_mandates where tenant_id=$1 and id=$2 and $3=any(entity_ids)'+(lock?' for update':''),[ctx.tenantId,id,entityId])).rows[0];if(!row)fail('NOT_FOUND','Mandate not found.');return row;}
export async function updateMandate(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'firm_mandate.edit');requireEntity(ctx,entityId);assertInput('FirmMandateCreate',input);
 if(ctx.firm)fail('FORBIDDEN','A delegated firm identity does not edit mandates.');
 const row=await loadMandate(tx,ctx,entityId,id,{lock:true});expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','An approved mandate never widens; revoke it and grant another.');
 const {firm,perms,ents}=await checkMandateInput(tx,ctx,entityId,input);
 const updated=(await tx.query('update lara.client_mandates set firm_id=$3,firm_name=$4,entity_ids=$5,permissions=$6,valid_to=$7,evidence_ids=$8,content_hash=$9,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,firm.id,firm.name,ents,perms,input.validUntil,JSON.stringify(input.evidenceIds),contentHash(mandateMaterial(input))])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'client_mandate',id,Number(updated.content_version));
 await audit(tx,ctx,{entityId,action:'firm_mandate.edit',resourceType:'client_mandate',resourceId:id,resourceVersion:Number(updated.version),afterRef:updated.content_hash});
 return mandateResource(updated);
}
export async function getMandate(tx,ctx,entityId,id){requirePermission(ctx,'firm_mandate.read');requireEntity(ctx,entityId);return mandateResource(await loadMandate(tx,ctx,entityId,id));}
export async function listMandates(tx,ctx,entityId,query){
 requirePermission(ctx,'firm_mandate.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.state){params.push(String(query.state));where+=' and state=$'+params.length;}
 const rows=(await tx.query('select * from lara.client_mandates where tenant_id=$1 and $2=any(entity_ids)'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,mandateResource,scope);
}
// The delegated identity of a firm member inside this tenant: one principal
// per OIDC identity, so a direct member and a firm delegate are the same
// principal and maker-checker holds either way.
async function delegatedPrincipal(tx,ctx,firmId,firmPrincipalId){
 const who=(await tx.query('select * from lara.firm_identity($1,$2)',[firmId,firmPrincipalId])).rows[0];
 if(!who)fail('NOT_FOUND','That principal is not active staff of the firm.');
 const principal=await identity.resolvePrincipal(tx,ctx.tenantId,{issuer:who.oidc_issuer,subject:who.oidc_subject,displayName:who.display_name+' ('+who.firm_name+')'});
 return {principal,who};
}
// Approval by a second client principal activates the mandate and seats
// the firm owner as its first delegate with the full mandate.
export async function approveMandate(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'firm_mandate.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 if(ctx.firm)fail('FORBIDDEN','A delegated firm identity does not approve mandates.');
 const row=await loadMandate(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Only draft mandates are decided.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who drafted the mandate cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The mandate changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'){if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});const rej=(await tx.query("update lara.client_mandates set state='revoked',revoked_reason=$3,revoked_at=now() where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.reason])).rows[0];await audit(tx,ctx,{entityId,action:'firm_mandate.reject',resourceType:'client_mandate',resourceId:id,resourceVersion:Number(rej.version),reason:input.reason});return {resourceType:'client_mandate',resourceId:id,version:Number(rej.version),state:'revoked'};}
 const firm=(await tx.query('select * from lara.firm_lookup($1)',[row.firm_id])).rows[0];
 if(!firm)fail('STATE_CONFLICT','The firm is no longer active.');
 const updated=(await tx.query("update lara.client_mandates set state='approved',approved_by=$3,approved_at=now() where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 const {principal,who}=await delegatedPrincipal(tx,ctx,row.firm_id,firm.owner_principal_id);
 const assignment=(await tx.query("insert into lara.client_assignments(tenant_id,entity_id,mandate_id,principal_id,firm_principal_id,firm_role,entity_ids,permission_subset,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id,mandate_id,principal_id) do update set state='active',revoked_reason=null,entity_ids=excluded.entity_ids,permission_subset=excluded.permission_subset returning *",[ctx.tenantId,entityId,id,principal.id,firm.owner_principal_id,who.firm_role||'partner',row.entity_ids,row.permissions,ctx.principalId])).rows[0];
 await tx.query('update lara.principals set revocation_version=revocation_version+1 where tenant_id=$1 and id=$2',[ctx.tenantId,principal.id]);
 await audit(tx,ctx,{entityId,action:'firm_mandate.approve',resourceType:'client_mandate',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:assignment.id});
 await emit(tx,ctx,{entityId,aggregateType:'client_mandate',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'firm.mandate_approved.v1',payload:{mandateId:id,firmId:row.firm_id,ownerAssignmentId:assignment.id}});
 return {resourceType:'client_mandate',resourceId:id,version:Number(updated.version),state:'approved',assignmentId:assignment.id};
}
// Revocation ends every assignment, bumps the delegates' revocation version
// (sessions and queued jobs fail their recheck) and deletes the firm's
// snapshots for the mandate across tenants.
export async function revokeMandate(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'firm_mandate.revoke');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 if(ctx.firm)fail('FORBIDDEN','A delegated firm identity does not revoke mandates.');
 const row=await loadMandate(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(['revoked','expired'].includes(row.state))return {resourceType:'client_mandate',resourceId:id,version:Number(row.version),state:row.state};
 const updated=(await tx.query("update lara.client_mandates set state='revoked',revoked_reason=$3,revoked_at=now() where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.reason])).rows[0];
 const delegates=(await tx.query("update lara.client_assignments set state='revoked',revoked_reason=$3 where tenant_id=$1 and mandate_id=$2 and state='active' returning principal_id",[ctx.tenantId,id,input.reason])).rows;
 for(const d of delegates)await tx.query('update lara.principals set revocation_version=revocation_version+1 where tenant_id=$1 and id=$2',[ctx.tenantId,d.principal_id]);
 const invalidated=(await tx.query('select lara.firm_invalidate_snapshots($1) as n',[id])).rows[0].n;
 await audit(tx,ctx,{entityId,action:'firm_mandate.revoke',resourceType:'client_mandate',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason+' ('+delegates.length+' delegate(s), '+invalidated+' snapshot(s))'});
 await emit(tx,ctx,{entityId,aggregateType:'client_mandate',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'firm.mandate_revoked.v1',payload:{mandateId:id,delegates:delegates.length,snapshots:Number(invalidated)}});
 return {resourceType:'client_mandate',resourceId:id,version:Number(updated.version),state:'revoked',delegates:delegates.length,snapshots:Number(invalidated)};
}
// Assignments are made inside the client tenant by a delegate who holds
// firm_assignment.create under the mandate: a subset of the mandate for one
// of the firm's staff, never wider than the mandate.
const assignmentResource=r=>resource(r,{state:r.state,mandateId:r.mandate_id,principalId:r.firm_principal_id,entityIds:r.entity_ids,permissionSubset:r.permission_subset});
async function checkAssignment(tx,ctx,mandate,input){
 const subset=[...new Set(input.permissionSubset)];
 for(const p of subset)if(!mandate.permissions.includes(p))fail('VALIDATION_FAILED','Permission '+p+' is outside the mandate.',{fieldErrors:[{path:'permissionSubset',message:p}]});
 const ents=[...new Set(input.entityIds)];
 for(const e of ents)if(!mandate.entity_ids.includes(e))fail('VALIDATION_FAILED','Entity '+e+' is outside the mandate.',{fieldErrors:[{path:'entityIds',message:e}]});
 return {subset,ents};
}
export async function createAssignment(tx,ctx,entityId,input){
 requirePermission(ctx,'firm_assignment.create');requireEntity(ctx,entityId);assertInput('FirmAssignment',input);
 if(!ctx.firm)fail('FORBIDDEN','Assignments are made by the firm under its mandate.');
 const mandate=await loadMandate(tx,ctx,entityId,input.mandateId,{lock:true});
 if(mandate.id!==ctx.firm.mandateId)fail('FORBIDDEN','Assignments are made under your own mandate.');
 if(mandate.state!=='approved'||new Date(mandate.valid_to).getTime()<=Date.now())fail('STATE_CONFLICT','The mandate is not approved or has expired.');
 const {subset,ents}=await checkAssignment(tx,ctx,mandate,input);
 const {principal,who}=await delegatedPrincipal(tx,ctx,mandate.firm_id,input.principalId);
 const row=(await tx.query("insert into lara.client_assignments(tenant_id,entity_id,mandate_id,principal_id,firm_principal_id,firm_role,entity_ids,permission_subset,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id,mandate_id,principal_id) do update set state='active',revoked_reason=null,entity_ids=excluded.entity_ids,permission_subset=excluded.permission_subset,content_version=lara.client_assignments.content_version+1 returning *",[ctx.tenantId,entityId,mandate.id,principal.id,input.principalId,who.firm_role||'staff',ents,subset,ctx.principalId])).rows[0];
 await tx.query('update lara.principals set revocation_version=revocation_version+1 where tenant_id=$1 and id=$2',[ctx.tenantId,principal.id]);
 await audit(tx,ctx,{entityId,action:'firm_assignment.create',resourceType:'client_assignment',resourceId:row.id,resourceVersion:Number(row.version),reason:who.display_name});
 return assignmentResource(row);
}
async function loadAssignment(tx,ctx,entityId,id,{lock=false}={}){if(!isUuid(id))fail('NOT_FOUND','Assignment not found.');const row=(await tx.query('select * from lara.client_assignments where tenant_id=$1 and id=$2 and $3=any(entity_ids)'+(lock?' for update':''),[ctx.tenantId,id,entityId])).rows[0];if(!row)fail('NOT_FOUND','Assignment not found.');return row;}
export async function updateAssignment(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'firm_assignment.edit');requireEntity(ctx,entityId);assertInput('FirmAssignment',input);
 if(!ctx.firm)fail('FORBIDDEN','Assignments are edited by the firm under its mandate.');
 const row=await loadAssignment(tx,ctx,entityId,id,{lock:true});expectVersion(row,expectedVersion);
 const mandate=await loadMandate(tx,ctx,entityId,row.mandate_id);
 if(mandate.id!==ctx.firm.mandateId||input.mandateId!==mandate.id||input.principalId!==row.firm_principal_id)fail('FORBIDDEN','An assignment keeps its mandate and staff member.');
 const {subset,ents}=await checkAssignment(tx,ctx,mandate,input);
 const updated=(await tx.query('update lara.client_assignments set entity_ids=$3,permission_subset=$4,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,ents,subset])).rows[0];
 await tx.query('update lara.principals set revocation_version=revocation_version+1 where tenant_id=$1 and id=$2',[ctx.tenantId,row.principal_id]);
 await audit(tx,ctx,{entityId,action:'firm_assignment.edit',resourceType:'client_assignment',resourceId:id,resourceVersion:Number(updated.version)});
 return assignmentResource(updated);
}
export async function getAssignment(tx,ctx,entityId,id){requirePermission(ctx,'firm_assignment.read');requireEntity(ctx,entityId);return assignmentResource(await loadAssignment(tx,ctx,entityId,id));}
export async function listAssignments(tx,ctx,entityId,query){
 requirePermission(ctx,'firm_assignment.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.mandateId){if(!isUuid(query.mandateId))fail('VALIDATION_FAILED','mandateId must be a UUID.');params.push(query.mandateId);where+=' and mandate_id=$'+params.length;}
 const rows=(await tx.query('select * from lara.client_assignments where tenant_id=$1 and $2=any(entity_ids)'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,assignmentResource,scope);
}
// The delegated scope of a principal in this tenant: active assignment,
// approved and unexpired mandate; permissions are the subset that the
// mandate still carries.
export async function firmScope(tx,tenantId,principalId){
 const rows=(await tx.query("select a.*,m.permissions as mandate_permissions,m.firm_id,m.firm_name,m.valid_to from lara.client_assignments a join lara.client_mandates m on m.tenant_id=a.tenant_id and m.id=a.mandate_id where a.tenant_id=$1 and a.principal_id=$2 and a.state='active' and m.state='approved' and m.valid_from<=now() and m.valid_to>now() order by a.created_at",[tenantId,principalId])).rows;
 if(!rows.length)return null;
 const a=rows[0];
 return {mandateId:a.mandate_id,assignmentId:a.id,firmId:a.firm_id,firmName:a.firm_name,role:a.firm_role,entityIds:a.entity_ids,permissions:a.permission_subset.filter(p=>a.mandate_permissions.includes(p)),validTo:iso(a.valid_to)};
}
