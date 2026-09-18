// Parties module: legal identities with roles, encrypted tax identifiers,
// archive and reviewed merge. Merging links the source to the target and
// archives it; nothing referenced by a posted snapshot is rewritten.
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {assertInput,audit,contentHash,cursorClause,emit,expectVersion,fail,page,pageArgs,requireEntity,requirePermission,resource} from './core.mjs';
import {invalidatePendingApprovals} from './identity.mjs';

// Field encryption for tax identifiers. The key comes from the deployment
// secret manager (32 bytes, hex or base64); no fallback key exists.
function fieldKey(env=process.env){
 const raw=env.FIELD_ENCRYPTION_KEY;
 if(!raw)fail('DEPENDENCY_UNAVAILABLE','Field encryption key is not configured.');
 const key=/^[0-9a-f]{64}$/i.test(raw)?Buffer.from(raw,'hex'):Buffer.from(raw,'base64');
 if(key.length!==32)fail('DEPENDENCY_UNAVAILABLE','Field encryption key must be 32 bytes.');
 return key;
}
export function encryptField(value,env){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',fieldKey(env),iv);
 const body=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
 return 'v1.'+iv.toString('base64url')+'.'+cipher.getAuthTag().toString('base64url')+'.'+body.toString('base64url');
}
export function decryptField(stored,env){
 const [version,iv,tag,body]=String(stored).split('.');
 if(version!=='v1')fail('DEPENDENCY_UNAVAILABLE','Unknown field encryption version.');
 const decipher=createDecipheriv('aes-256-gcm',fieldKey(env),Buffer.from(iv,'base64url'));decipher.setAuthTag(Buffer.from(tag,'base64url'));
 return Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8');
}
export const maskTaxId=value=>value?value.replace(/[^\p{L}\p{N}]/gu,'').replace(/.(?=.{3})/g,'•'):undefined;

// Tax identifiers are validated for shape only; no default or dummy values are
// ever written. A known identity must supply one; not_applicable may not.
function normalizeTaxId(input){
 const taxId=input.taxId?.normalize('NFC').trim();
 if(input.identityStatus==='known'&&!taxId)fail('VALIDATION_FAILED','A known identity requires its tax identifier.',{fieldErrors:[{path:'taxId',message:'Required for known identity'}]});
 if(input.identityStatus==='not_applicable'&&taxId)fail('VALIDATION_FAILED','Identity marked not applicable cannot carry a tax identifier.',{fieldErrors:[{path:'taxId',message:'Remove or change identityStatus'}]});
 if(taxId&&!/^[0-9A-Za-z-]{6,32}$/.test(taxId))fail('VALIDATION_FAILED','Tax identifier format is invalid.',{fieldErrors:[{path:'taxId',message:'6 to 32 letters, digits or hyphens'}]});
 return taxId||null;
}
const material=(input,taxId)=>({legalName:input.legalName.trim(),roles:[...new Set(input.roles)].sort(),identityStatus:input.identityStatus,address:input.address.trim(),taxId:taxId||null});
export const partyResource=(p,roles,env)=>resource(p,{legalName:p.legal_name,roles,identityStatus:p.identity_status,address:p.address_json.text||'',...(p.tax_id_encrypted?{taxIdMasked:maskTaxId(decryptField(p.tax_id_encrypted,env))}:{})});
async function rolesOf(tx,ctx,partyId){return (await tx.query('select role from lara.party_roles where tenant_id=$1 and party_id=$2 order by role',[ctx.tenantId,partyId])).rows.map(r=>r.role);}

export async function createParty(tx,ctx,entityId,input,env){
 requirePermission(ctx,'party.create');requireEntity(ctx,entityId);assertInput('PartyCreate',input);
 const taxId=normalizeTaxId(input),m=material(input,taxId);
 const row=(await tx.query('insert into lara.party(tenant_id,entity_id,legal_name,tax_id_encrypted,identity_status,address_json,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[ctx.tenantId,entityId,m.legalName,taxId?encryptField(taxId,env):null,m.identityStatus,JSON.stringify({text:m.address}),contentHash(m),ctx.principalId])).rows[0];
 for(const role of m.roles)await tx.query('insert into lara.party_roles(tenant_id,entity_id,party_id,role,created_by) values($1,$2,$3,$4,$5)',[ctx.tenantId,entityId,row.id,role,ctx.principalId]);
 if(!taxId&&m.identityStatus==='unknown')await openIdentityTask(tx,ctx,entityId,row.id);
 await audit(tx,ctx,{entityId,action:'party.create',resourceType:'party',resourceId:row.id,resourceVersion:1});
 await emit(tx,ctx,{entityId,aggregateType:'party',aggregateId:row.id,aggregateVersion:1,eventType:'party.created.v1',payload:{partyId:row.id}});
 return partyResource(row,m.roles,env);
}
// Unknown identity opens exactly one task per party asking for the document.
async function openIdentityTask(tx,ctx,entityId,partyId){
 await tx.query(`insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,cause_key,severity,reason,created_by) values($1,$2,'missing_evidence','party',$3,'identity','normal','Party identity is unknown; obtain the registration document.',$4)
  on conflict (tenant_id,entity_id,source_type,source_id,kind,cause_key) where status not in ('resolved','cancelled') do nothing`,[ctx.tenantId,entityId,partyId,ctx.principalId]);
}
export async function updateParty(tx,ctx,entityId,id,expectedVersion,input,env){
 requirePermission(ctx,'party.edit');requireEntity(ctx,entityId);assertInput('PartyEdit',input);
 const row=(await tx.query('select * from lara.party where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Party not found.');expectVersion(row,expectedVersion);
 if(row.status==='archived')fail('STATE_CONFLICT','Archived parties cannot change; restore or create a new party.');
 const taxId=normalizeTaxId(input),m=material(input,taxId),hash=contentHash(m),changed=hash!==row.content_hash;
 const updated=(await tx.query('update lara.party set legal_name=$4,tax_id_encrypted=$5,identity_status=$6,address_json=$7,content_hash=$8,content_version=content_version+$9 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,m.legalName,taxId?encryptField(taxId,env):null,m.identityStatus,JSON.stringify({text:m.address}),hash,changed?1:0])).rows[0];
 const current=await rolesOf(tx,ctx,id);
 // Roles are added, never silently removed: a role with any history stays.
 for(const role of m.roles)if(!current.includes(role))await tx.query('insert into lara.party_roles(tenant_id,entity_id,party_id,role,created_by) values($1,$2,$3,$4,$5)',[ctx.tenantId,entityId,id,role,ctx.principalId]);
 if(changed){
  await invalidatePendingApprovals(tx,ctx,'party',id);
  if(taxId||m.identityStatus!=='unknown')await tx.query("update lara.tasks set status='resolved',resolution='Identity recorded on the party.' where tenant_id=$1 and entity_id=$2 and source_type='party' and source_id=$3 and kind='missing_evidence' and cause_key='identity' and status not in ('resolved','cancelled')",[ctx.tenantId,entityId,id]);
  else await openIdentityTask(tx,ctx,entityId,id);
 }
 await audit(tx,ctx,{entityId,action:'party.edit',resourceType:'party',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return partyResource(updated,await rolesOf(tx,ctx,id),env);
}
export async function archiveParty(tx,ctx,entityId,id,input){
 requirePermission(ctx,'party.archive');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=(await tx.query('select * from lara.party where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Party not found.');
 if(row.status==='archived')return {resourceType:'party',resourceId:id,version:Number(row.version),state:'archived'};
 const updated=(await tx.query("update lara.party set status='archived' where tenant_id=$1 and entity_id=$2 and id=$3 returning version",[ctx.tenantId,entityId,id])).rows[0];
 await tx.query("update lara.tasks set status='cancelled' where tenant_id=$1 and entity_id=$2 and source_type='party' and source_id=$3 and status not in ('resolved','cancelled')",[ctx.tenantId,entityId,id]);
 await audit(tx,ctx,{entityId,action:'party.archive',resourceType:'party',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'party',resourceId:id,version:Number(updated.version),state:'archived'};
}
// Merge: the source becomes an archived alias pointing at the target. Roles
// missing on the target are added; the target's own content is untouched.
export async function mergeParty(tx,ctx,entityId,sourceId,targetId,input){
 requirePermission(ctx,'party.archive');requirePermission(ctx,'party.edit');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 if(sourceId===targetId)fail('VALIDATION_FAILED','A party cannot merge into itself.',{fieldErrors:[{path:'targetId',message:'Must differ'}]});
 const [first,second]=[sourceId,targetId].sort();
 const rows=(await tx.query('select * from lara.party where tenant_id=$1 and entity_id=$2 and id in ($3,$4) order by id for update',[ctx.tenantId,entityId,first,second])).rows;
 const source=rows.find(r=>r.id===sourceId),target=rows.find(r=>r.id===targetId);
 if(!source||!target)fail('NOT_FOUND','Party not found.');
 if(target.status==='archived')fail('STATE_CONFLICT','Cannot merge into an archived party.');
 if(source.merged_into)fail('STATE_CONFLICT','Source party is already merged.');
 const sourceRoles=await rolesOf(tx,ctx,sourceId),targetRoles=await rolesOf(tx,ctx,targetId);
 for(const role of sourceRoles)if(!targetRoles.includes(role))await tx.query('insert into lara.party_roles(tenant_id,entity_id,party_id,role,created_by) values($1,$2,$3,$4,$5)',[ctx.tenantId,entityId,targetId,role,ctx.principalId]);
 const updated=(await tx.query("update lara.party set status='archived',merged_into=$4 where tenant_id=$1 and entity_id=$2 and id=$3 returning version",[ctx.tenantId,entityId,sourceId,targetId])).rows[0];
 await audit(tx,ctx,{entityId,action:'party.merge',resourceType:'party',resourceId:sourceId,resourceVersion:Number(updated.version),afterRef:targetId,reason:input.reason});
 await emit(tx,ctx,{entityId,aggregateType:'party',aggregateId:sourceId,aggregateVersion:Number(updated.version),eventType:'party.merged.v1',payload:{sourceId,targetId}});
 return {resourceType:'party',resourceId:targetId,version:Number(target.version),state:target.status,mergedSourceId:sourceId};
}
export async function getParty(tx,ctx,entityId,id,env){
 requirePermission(ctx,'party.read');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.party where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Party not found.');
 return {...partyResource(row,await rolesOf(tx,ctx,id),env),...(row.merged_into?{mergedInto:row.merged_into}:{})};
}
export async function listParties(tx,ctx,entityId,query,env){
 requirePermission(ctx,'party.read');requireEntity(ctx,entityId);const {limit,after}=pageArgs(query);
 const params=[ctx.tenantId,entityId,limit+1];
 let where='';
 if(query?.q){params.push('%'+String(query.q).toLowerCase().replace(/\s+/g,' ').trim()+'%');where+=' and normalized_name like $'+params.length;}
 if(query?.role){params.push(String(query.role));where+=' and exists(select 1 from lara.party_roles r where r.tenant_id=party.tenant_id and r.party_id=party.id and r.role=$'+params.length+')';}
 if(query?.status){params.push(String(query.status));where+=' and status=$'+params.length;}
 const rows=(await tx.query('select * from lara.party where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const roles=rows.length?(await tx.query('select party_id,role from lara.party_roles where tenant_id=$1 and party_id=any($2::uuid[]) order by role',[ctx.tenantId,rows.map(r=>r.id)])).rows:[];
 return page(rows,limit,p=>partyResource(p,roles.filter(r=>r.party_id===p.id).map(r=>r.role),env));
}
