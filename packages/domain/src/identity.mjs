// Identity module: principals, roles, memberships, delegation, actor context
// and revocation checks. Tenant and permissions are derived from committed
// membership rows, never from request payloads.
import {assertInput,audit,contentHash,emit,expectVersion,fail,isUuid,page,pageArgs,cursorClause,requireEntity,requirePermission,resource,cursorScope} from './core.mjs';

// OIDC issuer/subject is the durable identity. Invitation acceptance resolves
// the principal inside the tenant that issued the invitation.
export async function resolvePrincipal(tx,tenantId,{issuer,subject,displayName}){
 if(!issuer||!subject)fail('UNAUTHENTICATED','Identity token is missing issuer or subject.');
 const found=await tx.query('select id,status,revocation_version from lara.principals where tenant_id=$1 and oidc_issuer=$2 and oidc_subject=$3',[tenantId,issuer,subject]);
 if(found.rowCount)return found.rows[0];
 return (await tx.query('insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,$2,$3,$4) returning id,status,revocation_version',[tenantId,issuer,subject,displayName||subject])).rows[0];
}

// Effective permissions: active memberships whose role is approved plus active
// delegations, each limited to the current instant. Disabled principals have
// no access at all.
export async function actorContext(tx,tenantId,principalId,{traceId}={}){
 const principal=(await tx.query('select id,status,revocation_version from lara.principals where tenant_id=$1 and id=$2',[tenantId,principalId])).rows[0];
 if(!principal)fail('UNAUTHENTICATED','Unknown principal.');
 if(principal.status!=='active')fail('FORBIDDEN','This account is disabled.');
 const memberships=await tx.query(`select m.entity_id,m.branch_id,r.permissions from lara.memberships m join lara.roles r on r.tenant_id=m.tenant_id and r.id=m.role_id
  where m.tenant_id=$1 and m.principal_id=$2 and m.status='active' and m.valid_from<=now() and (m.valid_to is null or m.valid_to>now()) and r.status='approved'`,[tenantId,principalId]);
 const delegations=await tx.query(`select d.permission_scope,d.id from lara.delegation d join lara.principals p on p.tenant_id=d.tenant_id and p.id=d.principal_id
  where d.tenant_id=$1 and d.delegate_id=$2 and d.status='active' and d.valid_from<=now() and d.valid_to>now() and p.status='active'`,[tenantId,principalId]);
 const permissions=new Set(),entityIds=new Set(),branchIds=new Set();let tenantWide=false;
 for(const m of memberships.rows){for(const p of m.permissions)permissions.add(p);if(m.entity_id)entityIds.add(m.entity_id);else tenantWide=true;if(m.branch_id)branchIds.add(m.branch_id);}
 for(const d of delegations.rows)for(const p of d.permission_scope)permissions.add(p);
 if(tenantWide)for(const e of (await tx.query("select id from lara.entities where tenant_id=$1 and status<>'archived'",[tenantId])).rows)entityIds.add(e.id);
 return {tenantId,principalId,permissions,entityIds,branchIds,revocationVersion:Number(principal.revocation_version),traceId};
}

export function sessionContext(ctx){
 return {principalId:ctx.principalId,tenantId:ctx.tenantId,entityIds:[...ctx.entityIds],permissions:[...ctx.permissions].sort(),capabilities:ctx.capabilities||[],revocationVersion:ctx.revocationVersion,simulation:false};
}

// Queued work stores the requester's revocation version. A later membership
// change makes the stored version stale and the job must not run (CORE-14).
export async function assertJobStillAuthorized(tx,job,permission){
 if(!job.requested_by)fail('FORBIDDEN','Job has no requesting principal.');
 const current=await actorContext(tx,job.tenant_id,job.requested_by);
 if(Number(job.revocation_version)!==current.revocationVersion)fail('FORBIDDEN','Access changed after this job was queued.');
 if(permission&&!current.permissions.has(permission))fail('FORBIDDEN','Permission '+permission+' is no longer held.');
 if(job.entity_id&&!current.entityIds.has(job.entity_id))fail('FORBIDDEN','Entity access is no longer held.');
 return current;
}

const roleFields=r=>({code:r.code,name:r.name,permissions:r.permissions});
export const roleResource=r=>resource(r,roleFields(r));
export async function createRole(tx,ctx,input){
 requirePermission(ctx,'role.create');assertInput('RoleCreate',input);
 const hash=contentHash({code:input.code,name:input.name,permissions:[...input.permissions].sort()});
 const row=(await tx.query('insert into lara.roles(tenant_id,code,name,permissions,content_hash,created_by) values($1,$2,$3,$4,$5,$6) returning *',[ctx.tenantId,input.code,input.name,JSON.stringify([...new Set(input.permissions)].sort()),hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{action:'role.create',resourceType:'role',resourceId:row.id,resourceVersion:1});
 return roleResource(row);
}
// Protected/approved roles change permissions only through a new approval:
// the edit returns the role to draft with a new content version.
export async function updateRole(tx,ctx,id,expectedVersion,input){
 requirePermission(ctx,'role.edit');assertInput('RoleCreate',input);
 const row=(await tx.query('select * from lara.roles where tenant_id=$1 and id=$2 for update',[ctx.tenantId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Role not found.');expectVersion(row,expectedVersion);
 if(row.status==='archived')fail('STATE_CONFLICT','Archived roles cannot change.');
 const permissions=[...new Set(input.permissions)].sort(),hash=contentHash({code:input.code,name:input.name,permissions});
 const material=hash!==row.content_hash;
 const updated=(await tx.query("update lara.roles set code=$3,name=$4,permissions=$5,content_hash=$6,content_version=content_version+$7,status=case when $7=1 then 'draft' else status end where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.code,input.name,JSON.stringify(permissions),hash,material?1:0])).rows[0];
 if(material)await invalidatePendingApprovals(tx,ctx,'role',id);
 await audit(tx,ctx,{action:'role.edit',resourceType:'role',resourceId:id,resourceVersion:Number(updated.version)});
 return roleResource(updated);
}
export async function approveRole(tx,ctx,id,input,expectedVersion){
 requirePermission(ctx,'role.approve');assertInput('ApprovalDecision',input);
 const row=(await tx.query('select * from lara.roles where tenant_id=$1 and id=$2 for update',[ctx.tenantId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Role not found.');if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The role author cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The role content changed since review.',{resourceVersion:Number(row.version)});
 if(row.status==='approved')fail('STATE_CONFLICT','Role is already approved.');
 const status=input.decision==='approve'?'approved':'draft';
 const updated=(await tx.query('update lara.roles set status=$3 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,status])).rows[0];
 await audit(tx,ctx,{action:'role.'+input.decision,resourceType:'role',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'role',resourceId:id,version:Number(updated.version),state:updated.status};
}
export async function getRole(tx,ctx,id){requirePermission(ctx,'role.read');const row=(await tx.query('select * from lara.roles where tenant_id=$1 and id=$2',[ctx.tenantId,id])).rows[0];if(!row)fail('NOT_FOUND','Role not found.');return roleResource(row);}
export async function listRoles(tx,ctx,query){requirePermission(ctx,'role.read');const scope=cursorScope(ctx,typeof entityId==='string'?entityId:null,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,limit+1];const rows=(await tx.query('select * from lara.roles where tenant_id=$1'+cursorClause(after,params)+' order by created_at,id limit $2',params)).rows;return page(rows,limit,roleResource,scope);}

const membershipFields=m=>({principalId:m.principal_id,roleId:m.role_id,branchIds:m.branch_id?[m.branch_id]:[],...(m.valid_to?{validUntil:m.valid_to.toISOString()}:{})});
export const membershipResource=m=>resource(m,membershipFields(m));
// Memberships bind an approved role to a principal within one entity (the
// X-Entity-Id of the command). Security administration carries no accounting
// authority: the actor needs membership.create, nothing about the role's verbs.
export async function createMembership(tx,ctx,entityId,input){
 requirePermission(ctx,'membership.create');requireEntity(ctx,entityId);assertInput('MembershipCreate',input);
 const role=(await tx.query('select id,status from lara.roles where tenant_id=$1 and id=$2',[ctx.tenantId,input.roleId])).rows[0];
 if(!role)fail('NOT_FOUND','Role not found.');
 if(role.status!=='approved')fail('STATE_CONFLICT','Only approved roles can be assigned.');
 if(input.branchIds.length>1)fail('VALIDATION_FAILED','One branch per membership; create one membership per branch.',{fieldErrors:[{path:'branchIds',message:'At most one branch'}]});
 if(!(await tx.query('select 1 from lara.principals where tenant_id=$1 and id=$2',[ctx.tenantId,input.principalId])).rowCount)fail('NOT_FOUND','Principal not found.');
 if(input.validUntil&&new Date(input.validUntil)<=new Date())fail('VALIDATION_FAILED','validUntil must be in the future.',{fieldErrors:[{path:'validUntil',message:'Must be in the future'}]});
 const row=(await tx.query('insert into lara.memberships(tenant_id,principal_id,entity_id,branch_id,role_id,valid_to,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[ctx.tenantId,input.principalId,entityId,input.branchIds[0]||null,input.roleId,input.validUntil||null,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'membership.create',resourceType:'membership',resourceId:row.id,resourceVersion:1});
 await emit(tx,ctx,{entityId,aggregateType:'membership',aggregateId:row.id,aggregateVersion:1,eventType:'membership.changed.v1',payload:{membershipId:row.id,principalId:input.principalId}});
 return membershipResource(row);
}
export async function revokeMembership(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'membership.revoke');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=(await tx.query('select * from lara.memberships where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Membership not found.');if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status==='revoked')return {resourceType:'membership',resourceId:id,version:Number(row.version),state:'revoked'};
 const updated=(await tx.query("update lara.memberships set status='revoked',revoked_reason=$3,valid_to=least(coalesce(valid_to,now()),now()) where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.reason])).rows[0];
 await audit(tx,ctx,{entityId,action:'membership.revoke',resourceType:'membership',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 await emit(tx,ctx,{entityId,aggregateType:'membership',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'membership.changed.v1',payload:{membershipId:id,principalId:row.principal_id,revoked:true}});
 return {resourceType:'membership',resourceId:id,version:Number(updated.version),state:'revoked'};
}
export async function updateMembership(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'membership.edit');requireEntity(ctx,entityId);assertInput('MembershipCreate',input);
 const row=(await tx.query('select * from lara.memberships where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Membership not found.');expectVersion(row,expectedVersion);
 if(row.status==='revoked')fail('STATE_CONFLICT','Revoked memberships are immutable; create a new membership.');
 if(row.principal_id!==input.principalId)fail('VALIDATION_FAILED','A membership cannot move to another principal.',{fieldErrors:[{path:'principalId',message:'Immutable'}]});
 const role=(await tx.query("select 1 from lara.roles where tenant_id=$1 and id=$2 and status='approved'",[ctx.tenantId,input.roleId])).rowCount;
 if(!role)fail('STATE_CONFLICT','Only approved roles can be assigned.');
 const updated=(await tx.query('update lara.memberships set role_id=$3,branch_id=$4,valid_to=$5 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.roleId,input.branchIds[0]||null,input.validUntil||null])).rows[0];
 await audit(tx,ctx,{entityId,action:'membership.edit',resourceType:'membership',resourceId:id,resourceVersion:Number(updated.version)});
 return membershipResource(updated);
}
export async function getMembership(tx,ctx,entityId,id){requirePermission(ctx,'membership.read');requireEntity(ctx,entityId);const row=(await tx.query('select * from lara.memberships where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Membership not found.');return membershipResource(row);}
// Tenant-wide memberships (no entity) apply to every entity and are listed with it.
export async function listMemberships(tx,ctx,entityId,query){requirePermission(ctx,'membership.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,typeof entityId==='string'?entityId:null,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];const rows=(await tx.query('select * from lara.memberships where tenant_id=$1 and (entity_id=$2 or entity_id is null)'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;return page(rows,limit,membershipResource,scope);}

// Any pending approval bound to an older content version is invalidated when
// material content changes; the decision chain must restart on the new hash.
export async function invalidatePendingApprovals(tx,ctx,resourceType,resourceId){
 const r=await tx.query("update lara.approval_requests set status='invalidated' where tenant_id=$1 and resource_type=$2 and resource_id=$3 and status='pending' returning id",[ctx.tenantId,resourceType,resourceId]);
 for(const row of r.rows)await audit(tx,ctx,{entityId:(await tx.query('select entity_id from lara.approval_requests where id=$1',[row.id])).rows[0].entity_id,action:'approval.invalidate',resourceType:'approval_request',resourceId:row.id});
 return r.rowCount;
}
export {isUuid};
