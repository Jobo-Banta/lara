// Organization module: tenants, entities, branches, settings versions and
// capability activation. Activation is a maker-checker flow bound to the
// entity content version; the database re-validates profile and onboarding
// gates for live tenants.
import {assertInput,audit,contentHash,cursorClause,emit,expectVersion,fail,page,pageArgs,requireEntity,requirePermission,resource,cursorScope} from './core.mjs';
import {invalidatePendingApprovals} from './identity.mjs';

// Provisioning a tenant is an operator action outside membership scope: the
// caller supplies the tenant id so RLS context and the row agree.
export async function provisionTenant(tx,{id,slug,name,mode}){
 if(!['demo','live'].includes(mode))fail('VALIDATION_FAILED','mode must be demo or live.',{fieldErrors:[{path:'mode',message:'demo or live'}]});
 return (await tx.query('insert into lara.tenants(id,slug,name,mode) values($1,$2,$3,$4) returning id,slug,name,mode,status',[id,slug,name,mode])).rows[0];
}

const entityMaterial=i=>({legalName:i.legalName,baseCurrency:i.baseCurrency,timezone:i.timezone,fiscalYearStartMonth:i.fiscalYearStartMonth,registrationProfileId:i.registrationProfileId??null});
const entityFields=e=>({legalName:e.legal_name,baseCurrency:e.base_currency,timezone:e.timezone,fiscalYearStartMonth:e.fiscal_year_start_month,...(e.registration_profile_id?{registrationProfileId:e.registration_profile_id}:{})});
export const entityResource=e=>resource(e,entityFields(e));
function validateTimezone(tz){try{new Intl.DateTimeFormat('en-PH',{timeZone:tz});}catch{fail('VALIDATION_FAILED','Unknown IANA time zone.',{fieldErrors:[{path:'timezone',message:'Unknown time zone'}]});}}

export async function createEntity(tx,ctx,input){
 requirePermission(ctx,'entity.create');assertInput('EntityCreate',input);validateTimezone(input.timezone);
 if(input.baseCurrency!=='PHP')fail('VALIDATION_FAILED','P02 entities keep PHP as base currency; other currencies arrive with P09.',{fieldErrors:[{path:'baseCurrency',message:'PHP required'}]});
 const row=(await tx.query('insert into lara.entities(tenant_id,legal_name,registration_profile_id,fiscal_year_start_month,base_currency,timezone,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[ctx.tenantId,input.legalName.trim(),input.registrationProfileId||null,input.fiscalYearStartMonth,input.baseCurrency,input.timezone,contentHash(entityMaterial(input)),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId:row.id,action:'entity.create',resourceType:'entity',resourceId:row.id,resourceVersion:1});
 return entityResource(row);
}
// Material edits return a pending or active entity to draft with a new
// content version, so activation approval must be repeated on the new content.
export async function updateEntity(tx,ctx,id,expectedVersion,input){
 requirePermission(ctx,'entity.edit');requireEntity(ctx,id);assertInput('EntityCreate',input);validateTimezone(input.timezone);
 const row=(await tx.query('select * from lara.entities where tenant_id=$1 and id=$2 for update',[ctx.tenantId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Entity not found.');expectVersion(row,expectedVersion);
 if(row.status==='archived')fail('STATE_CONFLICT','Archived entities cannot change.');
 if(input.baseCurrency!=='PHP')fail('VALIDATION_FAILED','Base currency is fixed to PHP in this release.',{fieldErrors:[{path:'baseCurrency',message:'PHP required'}]});
 const hash=contentHash(entityMaterial(input)),material=hash!==row.content_hash;
 const updated=(await tx.query("update lara.entities set legal_name=$3,registration_profile_id=$4,fiscal_year_start_month=$5,timezone=$6,content_hash=$7,content_version=content_version+$8,status=case when $8=1 and status in ('pending_activation','active') then 'draft' else status end where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.legalName.trim(),input.registrationProfileId||null,input.fiscalYearStartMonth,input.timezone,hash,material?1:0])).rows[0];
 if(material)await invalidatePendingApprovals(tx,ctx,'entity',id);
 await audit(tx,ctx,{entityId:id,action:'entity.edit',resourceType:'entity',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return entityResource(updated);
}
export async function getEntity(tx,ctx,id){requirePermission(ctx,'entity.read');requireEntity(ctx,id);const row=(await tx.query('select * from lara.entities where tenant_id=$1 and id=$2',[ctx.tenantId,id])).rows[0];if(!row)fail('NOT_FOUND','Entity not found.');return entityResource(row);}
export async function listEntities(tx,ctx,query){
 requirePermission(ctx,'entity.read');const scope=cursorScope(ctx,typeof entityId==='string'?entityId:null,query||{});const {limit,after}=pageArgs(query,scope);
 const ids=[...ctx.entityIds];if(!ids.length)return {items:[],nextCursor:null};
 const params=[ctx.tenantId,ids,limit+1];
 const rows=(await tx.query('select * from lara.entities where tenant_id=$1 and id=any($2::uuid[])'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,entityResource,scope);
}

// Setup completeness rule from the P02 specification.
export async function activationBlockers(tx,ctx,entity,requesterId=ctx.principalId){
 const blockers=[];
 if(!entity.legal_name?.trim())blockers.push('legal_name');
 if(entity.base_currency!=='PHP')blockers.push('base_currency');
 if(!(entity.fiscal_year_start_month>=1&&entity.fiscal_year_start_month<=12))blockers.push('fiscal_year_start');
 if(!entity.timezone)blockers.push('timezone');
 if(!(await tx.query("select 1 from lara.branches where tenant_id=$1 and entity_id=$2 and status='active' limit 1",[ctx.tenantId,entity.id])).rowCount)blockers.push('branch');
 // An independent controller: an active membership on this entity (or tenant
 // wide) whose approved role grants entity.activate, held by someone other
 // than the requester.
 const controller=await tx.query(`select 1 from lara.memberships m join lara.roles r on r.tenant_id=m.tenant_id and r.id=m.role_id
  where m.tenant_id=$1 and (m.entity_id=$2 or m.entity_id is null) and m.status='active' and (m.valid_to is null or m.valid_to>now()) and r.status='approved'
  and r.permissions ? 'entity.activate' and m.principal_id<>$3 limit 1`,[ctx.tenantId,entity.id,requesterId]);
 if(!controller.rowCount)blockers.push('independent_controller');
 const tenant=(await tx.query('select mode from lara.tenants where id=$1',[ctx.tenantId])).rows[0];
 if(tenant.mode==='live'){
  if(!entity.registration_profile_id)blockers.push('registration_profile');
  const checks=(await tx.query("select count(*)::int n from lara.onboarding_checks where tenant_id=$1 and entity_id=$2 and status in ('pending','failed')",[ctx.tenantId,entity.id])).rows[0].n;
  if(checks)blockers.push('onboarding_checks');
 }
 return blockers;
}

// Step 1: the preparer requests activation, which opens an approval request
// bound to the current content version and hash. Step 2: a different
// principal with entity.activate approves; the database re-validates gates.
export async function requestActivation(tx,ctx,id,input,expectedVersion){
 requirePermission(ctx,'entity.edit');requireEntity(ctx,id);assertInput('ReasonAction',input);
 const entity=(await tx.query('select * from lara.entities where tenant_id=$1 and id=$2 for update',[ctx.tenantId,id])).rows[0];
 if(!entity)fail('NOT_FOUND','Entity not found.');if(expectedVersion!==undefined)expectVersion(entity,expectedVersion);
 if(entity.status==='active')fail('STATE_CONFLICT','Entity is already active.');
 if(entity.status==='archived')fail('STATE_CONFLICT','Archived entities cannot activate.');
 const blockers=await activationBlockers(tx,ctx,entity);
 if(blockers.length)fail('STATE_CONFLICT','Setup is incomplete: '+blockers.join(', ')+'.',{fieldErrors:blockers.map(b=>({path:b,message:'Required before activation'}))});
 // Re-requesting the same content version is idempotent; a pending request
 // for an older version is invalidated first.
 await tx.query("update lara.approval_requests set status='invalidated' where tenant_id=$1 and entity_id=$2 and resource_type='entity' and resource_id=$2 and status='pending' and content_version<>$3",[ctx.tenantId,id,entity.content_version]);
 const pending=(await tx.query("select id from lara.approval_requests where tenant_id=$1 and entity_id=$2 and resource_type='entity' and resource_id=$2 and status='pending' and content_version=$3",[ctx.tenantId,id,entity.content_version])).rows[0];
 const request=pending||(await tx.query("insert into lara.approval_requests(tenant_id,entity_id,resource_type,resource_id,content_version,content_hash,policy_version,step,created_by) values($1,$2,'entity',$2,$3,$4,1,1,$5) returning id",[ctx.tenantId,id,entity.content_version,entity.content_hash,ctx.principalId])).rows[0];
 const updated=(await tx.query("update lara.entities set status='pending_activation' where tenant_id=$1 and id=$2 returning version",[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId:id,action:'entity.request_activation',resourceType:'entity',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'entity',resourceId:id,version:Number(updated.version),state:'pending_activation',approvalRequestId:request.id};
}
export async function activateEntity(tx,ctx,id,input,expectedVersion){
 requirePermission(ctx,'entity.activate');requireEntity(ctx,id);assertInput('ReasonAction',input);
 const entity=(await tx.query('select * from lara.entities where tenant_id=$1 and id=$2 for update',[ctx.tenantId,id])).rows[0];
 if(!entity)fail('NOT_FOUND','Entity not found.');if(expectedVersion!==undefined)expectVersion(entity,expectedVersion);
 if(entity.status!=='pending_activation')fail('STATE_CONFLICT','Request activation before approving it.');
 const request=(await tx.query("select * from lara.approval_requests where tenant_id=$1 and entity_id=$2 and resource_type='entity' and resource_id=$2 and status='pending' order by created_at desc limit 1 for update",[ctx.tenantId,id])).rows[0];
 if(!request)fail('STATE_CONFLICT','No pending activation request.');
 if(request.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who requested activation cannot approve it.');
 if(Number(request.content_version)!==Number(entity.content_version)||request.content_hash!==entity.content_hash)fail('VERSION_CONFLICT','Entity content changed after the request; request activation again.',{resourceVersion:Number(entity.version)});
 const blockers=await activationBlockers(tx,ctx,entity,request.created_by);
 if(blockers.length)fail('STATE_CONFLICT','Setup is incomplete: '+blockers.join(', ')+'.');
 await tx.query("insert into lara.approval_decisions(tenant_id,entity_id,request_id,actor_id,decision,reason) values($1,$2,$3,$4,'approve',$5)",[ctx.tenantId,id,request.id,ctx.principalId,input.reason]);
 await tx.query("update lara.approval_requests set status='approved' where id=$1",[request.id]);
 const updated=(await tx.query("update lara.entities set status='active' where tenant_id=$1 and id=$2 returning version",[ctx.tenantId,id])).rows[0];
 await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'workspace','active','p02.1',$3,now(),$4) on conflict (tenant_id,entity_id,capability) do update set status='active',approved_by=excluded.approved_by,activated_at=now()",[ctx.tenantId,id,ctx.principalId,request.created_by]);
 await audit(tx,ctx,{entityId:id,action:'entity.activate',resourceType:'entity',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 await emit(tx,ctx,{entityId:id,aggregateType:'entity',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'entity.activated.v1',payload:{entityId:id,capability:'workspace'}});
 return {resourceType:'entity',resourceId:id,version:Number(updated.version),state:'active'};
}

const branchFields=b=>({code:b.code,name:b.name,address:b.address_json.text||''});
export const branchResource=b=>resource(b,branchFields(b));
export async function createBranch(tx,ctx,entityId,input){
 requirePermission(ctx,'branch.create');requireEntity(ctx,entityId);assertInput('BranchCreate',input);
 const code=input.code.trim().toUpperCase();
 if(!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(code))fail('VALIDATION_FAILED','Branch code uses letters, digits and hyphens, up to 16 characters.',{fieldErrors:[{path:'code',message:'Invalid code'}]});
 const address={text:input.address.trim()};
 const row=(await tx.query('insert into lara.branches(tenant_id,entity_id,code,name,address_json,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[ctx.tenantId,entityId,code,input.name.trim(),JSON.stringify(address),contentHash({code,name:input.name.trim(),address}),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'branch.create',resourceType:'branch',resourceId:row.id,resourceVersion:1});
 return branchResource(row);
}
export async function updateBranch(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'branch.edit');requireEntity(ctx,entityId);assertInput('BranchCreate',input);
 const row=(await tx.query('select * from lara.branches where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Branch not found.');expectVersion(row,expectedVersion);
 if(row.code!==input.code.trim().toUpperCase())fail('VALIDATION_FAILED','Branch code is immutable once created.',{fieldErrors:[{path:'code',message:'Immutable'}]});
 const address={text:input.address.trim()},hash=contentHash({code:row.code,name:input.name.trim(),address});
 const updated=(await tx.query('update lara.branches set name=$4,address_json=$5,content_hash=$6,content_version=content_version+$7 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,input.name.trim(),JSON.stringify(address),hash,hash!==row.content_hash?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:'branch.edit',resourceType:'branch',resourceId:id,resourceVersion:Number(updated.version)});
 return branchResource(updated);
}
export async function getBranch(tx,ctx,entityId,id){requirePermission(ctx,'branch.read');requireEntity(ctx,entityId);const row=(await tx.query('select * from lara.branches where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Branch not found.');return branchResource(row);}
export async function listBranches(tx,ctx,entityId,query){requirePermission(ctx,'branch.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,typeof entityId==='string'?entityId:null,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];const rows=(await tx.query('select * from lara.branches where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;return page(rows,limit,branchResource,scope);}

// Settings versions (P02-T03): a draft carries a payload hash; approval by a
// different principal binds that hash; a material change creates the next
// version number and invalidates any pending approval of the old draft.
export async function saveSettings(tx,ctx,entityId,kind,payload){
 requirePermission(ctx,'entity.edit');requireEntity(ctx,entityId);
 if(!/^[a-z][a-z0-9_]{0,63}$/.test(kind))fail('VALIDATION_FAILED','Invalid settings kind.',{fieldErrors:[{path:'kind',message:'Invalid'}]});
 if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('VALIDATION_FAILED','Settings payload must be an object.',{fieldErrors:[{path:'payload',message:'Object required'}]});
 const hash=contentHash(payload);
 const latest=(await tx.query('select * from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind=$3 order by version_number desc limit 1 for update',[ctx.tenantId,entityId,kind])).rows[0];
 if(latest&&latest.payload_hash===hash&&latest.status!=='rejected')return settingsResource(latest,false);
 if(latest&&latest.status==='draft'){
  const updated=(await tx.query("update lara.settings_versions set payload=$2,payload_hash=$3,content_version=content_version+1 where id=$1 returning *",[latest.id,JSON.stringify(payload),hash])).rows[0];
  await tx.query("update lara.approval_requests set status='invalidated' where tenant_id=$1 and entity_id=$2 and resource_type='settings_version' and resource_id=$3 and status='pending'",[ctx.tenantId,entityId,latest.id]);
  await audit(tx,ctx,{entityId,action:'settings.edit',resourceType:'settings_version',resourceId:latest.id,resourceVersion:Number(updated.version),afterRef:hash});
  return settingsResource(updated,true);
 }
 const next=(latest?latest.version_number:0)+1;
 const row=(await tx.query('insert into lara.settings_versions(tenant_id,entity_id,kind,version_number,payload,payload_hash,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[ctx.tenantId,entityId,kind,next,JSON.stringify(payload),hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'settings.draft',resourceType:'settings_version',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return settingsResource(row,true);
}
export const settingsResource=(s,changed)=>({id:s.id,kind:s.kind,versionNumber:s.version_number,payloadHash:s.payload_hash,state:s.status,version:Number(s.version),contentVersion:Number(s.content_version),changed,effectiveAt:s.effective_at?s.effective_at.toISOString():null});
export async function approveSettings(tx,ctx,entityId,id,{payloadHash,reason}){
 requirePermission(ctx,'entity.activate');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.settings_versions where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Settings version not found.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The settings author cannot approve them.');
 if(row.status!=='draft'&&row.status!=='pending_approval')fail('STATE_CONFLICT','Settings version is '+row.status+'.');
 if(row.payload_hash!==payloadHash)fail('VERSION_CONFLICT','Settings changed since review; approve the current hash.',{resourceVersion:Number(row.version)});
 await tx.query("update lara.settings_versions set status='superseded' where tenant_id=$1 and entity_id=$2 and kind=$3 and status='approved'",[ctx.tenantId,entityId,row.kind]);
 const updated=(await tx.query("update lara.settings_versions set status='approved',approved_by=$2,effective_at=now() where id=$1 returning *",[id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'settings.approve',resourceType:'settings_version',resourceId:id,resourceVersion:Number(updated.version),afterRef:row.payload_hash,reason:reason||null});
 return settingsResource(updated,false);
}

// Capability activation for anything beyond the workspace: evidence is
// required, dependencies are checked by the database and the approver must
// differ from the requester recorded on the request.
export async function activateCapability(tx,ctx,entityId,input){
 requirePermission(ctx,'capability.activate');requireEntity(ctx,entityId);assertInput('CapabilityActivation',input);
 const def=(await tx.query('select code from lara.capability_definitions where code=$1',[input.capability])).rows[0];
 if(!def)fail('VALIDATION_FAILED','Unknown capability.',{fieldErrors:[{path:'capability',message:'Unknown'}]});
 const available=(await tx.query("select count(*)::int n from lara.evidence where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[]) and status='available'",[ctx.tenantId,entityId,input.evidenceIds])).rows[0].n;
 if(available!==input.evidenceIds.length)fail('EVIDENCE_NOT_READY','Every activation evidence item must be available.');
 const existing=(await tx.query('select * from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability=$3 for update',[ctx.tenantId,entityId,input.capability])).rows[0];
 if(existing?.status==='active')fail('STATE_CONFLICT','Capability is already active.');
 if(!existing){
  const row=(await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,evidence_manifest,created_by) values($1,$2,$3,'requested',$4,$5,$6) returning *",[ctx.tenantId,entityId,input.capability,input.profileVersion,JSON.stringify(input.evidenceIds),ctx.principalId])).rows[0];
  await audit(tx,ctx,{entityId,action:'capability.request',resourceType:'capability_activation',resourceId:row.id,resourceVersion:1,reason:input.reason});
  return {resourceType:'capability_activation',resourceId:row.id,version:1,state:'requested'};
 }
 if(existing.created_by===ctx.principalId)fail('SELF_APPROVAL','A different principal must approve the activation request.');
 const updated=(await tx.query("update lara.capability_activations set status='active',approved_by=$2,activated_at=now(),profile_version=$3 where id=$1 returning *",[existing.id,ctx.principalId,input.profileVersion])).rows[0];
 await audit(tx,ctx,{entityId,action:'capability.activate',resourceType:'capability_activation',resourceId:existing.id,resourceVersion:Number(updated.version),reason:input.reason});
 await emit(tx,ctx,{entityId,aggregateType:'capability_activation',aggregateId:existing.id,aggregateVersion:Number(updated.version),eventType:'capability.activated.v1',payload:{entityId,capability:input.capability}});
 // The ledger opens with one primary PHP book owned by LARA; separate books arrive with P09.
 if(input.capability==='general_ledger')await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) select $1,$2,'MAIN','primary','PHP','lara','active',$3 where not exists (select 1 from lara.books b where b.tenant_id=$1 and b.entity_id=$2 and b.kind='primary' and b.status<>'archived')",[ctx.tenantId,entityId,ctx.principalId]);
 return {resourceType:'capability_activation',resourceId:existing.id,version:Number(updated.version),state:'active'};
}
export async function activeCapabilities(tx,ctx,entityId){
 return (await tx.query("select capability from lara.capability_activations where tenant_id=$1 and entity_id=$2 and status='active' order by capability",[ctx.tenantId,entityId])).rows.map(r=>r.capability);
}
