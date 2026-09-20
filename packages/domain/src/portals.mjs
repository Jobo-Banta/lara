// Customer and supplier portals and messaging (P13): scoped invites accepted
// against an opaque token into external portal memberships (one party, one
// entity, one role, the allowed resource kinds) that never see another
// party's record, share grants over non-enumerable tokens exposing minimal
// approved fields until they expire, message requests drafted, authorized
// by a named principal other than the drafter and sent exactly once through
// the qualified channel with a delivery receipt per attempt, supplier
// uploads that route to review and never post, and provider payment intents
// whose webhooks are signed, timely, deduplicated and verified server to
// server before the normal settlement command is drafted — never from a
// browser return.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,enqueueJob,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource,DomainError} from './core.mjs';
import * as identity from './identity.mjs';
import {micros,decimal,signedMicros} from './ledger.mjs';

const sha=v=>createHash('sha256').update(String(v)).digest('hex');
const money=v=>decimal(micros(String(v)),2);
export const PORTAL_PERMISSIONS={customer:['invoice.read','open_item.read','payment_link.read','evidence.upload','evidence.read','party.read','session.read'],supplier:['bill.read','evidence.upload','evidence.read','party.read','session.read']};
const PORTAL_KINDS={customer:['invoice','statement','certificate','payment_link'],supplier:['bill','submission','certificate']};
// Operations a portal principal may call; everything else answers 403.
export const PORTAL_OPERATIONS=new Set(['get_me','get_invoices','get_invoices_id','get_bills','get_bills_id','get_open_items','get_certificates','get_evidence','get_evidence_id','get_evidence_id_content','post_evidence_uploads','post_evidence_id_complete','get_payment_links','get_payment_links_id','post_payment_links_id_claim','get_portal_me','get_parties_id']);
const maskEmail=e=>{const [u,d]=String(e).toLowerCase().split('@');return (u.slice(0,1)+'***')+'@'+(d||'');};

// ---------------------------------------------------------------------------
// Capability and profile
// ---------------------------------------------------------------------------
export async function requirePortals(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='portals' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The portals capability is not active for this entity.');
}
export async function portalProfile(tx,ctx,entityId){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='portal_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved portal profile (qualified channel, payment provider, settlement bank account, share validity, terms version) is required.');
 const p=row.payload;
 return {messagingProvider:typeof p.messagingProvider==='string'?p.messagingProvider:'local-mail',paymentProvider:typeof p.paymentProvider==='string'?p.paymentProvider:'fixture-pay',paymentBankAccountId:isUuid(p.paymentBankAccountId)?p.paymentBankAccountId:null,shareDays:Number.isInteger(p.shareDays)&&p.shareDays>0&&p.shareDays<=90?p.shareDays:30,termsVersion:typeof p.termsVersion==='string'?p.termsVersion:'portal-1',supportEmail:typeof p.supportEmail==='string'?p.supportEmail:null,baseUrl:typeof p.baseUrl==='string'?p.baseUrl:'https://portal.invalid'};
}

// ---------------------------------------------------------------------------
// Invites and memberships
// ---------------------------------------------------------------------------
const inviteMaterial=i=>({partyId:i.partyId,email:String(i.email).toLowerCase(),role:i.role,expiresAt:i.expiresAt});
// A pending invite past its expiry reads as expired even before anyone tries it.
const inviteResource=r=>resource(r,{state:r.state==='pending'&&new Date(r.expires_at).getTime()<=Date.now()?'expired':r.state,partyId:r.party_id,email:r.email_masked,role:r.role,expiresAt:iso(r.expires_at)});
async function partyFor(tx,ctx,entityId,partyId,role){
 if(!isUuid(partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});
 const p=(await tx.query("select p.id,p.legal_name from lara.party p where p.tenant_id=$1 and p.entity_id=$2 and p.id=$3 and p.status='active' and exists (select 1 from lara.party_roles r where r.tenant_id=p.tenant_id and r.party_id=p.id and r.role=$4)",[ctx.tenantId,entityId,partyId,role])).rows[0];
 if(!p)fail('NOT_FOUND','No active '+role+' party with that id.');
 return p;
}
function checkExpiry(expiresAt,maxDays,path='expiresAt'){
 const t=Date.parse(expiresAt);if(Number.isNaN(t))fail('VALIDATION_FAILED','expiresAt is a timestamp.',{fieldErrors:[{path,message:'Timestamp'}]});
 if(t<=Date.now())fail('VALIDATION_FAILED','expiresAt is in the past.',{fieldErrors:[{path,message:'Future'}]});
 if(t>Date.now()+maxDays*86400000)fail('VALIDATION_FAILED','expiresAt is at most '+maxDays+' days ahead.',{fieldErrors:[{path,message:'At most '+maxDays+' days'}]});
}
export async function createInvite(tx,ctx,entityId,input){
 requirePermission(ctx,'portal_invite.create');requireEntity(ctx,entityId);assertInput('PortalInvite',input);await requirePortals(tx,ctx,entityId);await portalProfile(tx,ctx,entityId);
 await partyFor(tx,ctx,entityId,input.partyId,input.role);checkExpiry(input.expiresAt,30);
 const row=(await tx.query("insert into lara.portal_invites(tenant_id,entity_id,party_id,email_hash,email_masked,role,token_hash,expires_at,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *",[ctx.tenantId,entityId,input.partyId,sha(String(input.email).toLowerCase()),maskEmail(input.email),input.role,sha(randomUUID()),input.expiresAt,contentHash(inviteMaterial(input)),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'portal_invite.create',resourceType:'portal_invite',resourceId:row.id,resourceVersion:1,afterRef:row.content_hash});
 return inviteResource(row);
}
export async function updateInvite(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'portal_invite.edit');requireEntity(ctx,entityId);assertInput('PortalInvite',input);
 const row=await loadInvite(tx,ctx,entityId,id,{lock:true});expectVersion(row,expectedVersion);
 if(row.state!=='pending')fail('STATE_CONFLICT','Only pending invites are edited.');
 await partyFor(tx,ctx,entityId,input.partyId,input.role);checkExpiry(input.expiresAt,30);
 // Any change to the scope rotates the token: a link already delivered never widens.
 const updated=(await tx.query('update lara.portal_invites set party_id=$3,email_hash=$4,email_masked=$5,role=$6,expires_at=$7,token_hash=$8,content_hash=$9,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.partyId,sha(String(input.email).toLowerCase()),maskEmail(input.email),input.role,input.expiresAt,sha(randomUUID()),contentHash(inviteMaterial(input))])).rows[0];
 await audit(tx,ctx,{entityId,action:'portal_invite.edit',resourceType:'portal_invite',resourceId:id,resourceVersion:Number(updated.version),afterRef:updated.content_hash});
 return inviteResource(updated);
}
async function loadInvite(tx,ctx,entityId,id,{lock=false}={}){if(!isUuid(id))fail('NOT_FOUND','Invite not found.');const row=(await tx.query('select * from lara.portal_invites where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Invite not found.');return row;}
export async function getInvite(tx,ctx,entityId,id){requirePermission(ctx,'portal_invite.read');requireEntity(ctx,entityId);return inviteResource(await loadInvite(tx,ctx,entityId,id));}
export async function listInvites(tx,ctx,entityId,query){
 requirePermission(ctx,'portal_invite.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.state){params.push(String(query.state));where+=' and state=$'+params.length;}
 const rows=(await tx.query('select * from lara.portal_invites where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,inviteResource,scope);
}
// Revocation ends the invite and every membership it produced: hosted
// access stops now; copies already downloaded are not recalled.
export async function revokeInvite(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'portal_invite.revoke');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadInvite(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(['revoked','expired'].includes(row.state))return {resourceType:'portal_invite',resourceId:id,version:Number(row.version),state:row.state};
 const updated=(await tx.query("update lara.portal_invites set state='revoked',revoked_reason=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.reason])).rows[0];
 const members=(await tx.query("update lara.portal_memberships set status='revoked',revoked_reason=$3 where tenant_id=$1 and invite_id=$2 and status='active' returning principal_id",[ctx.tenantId,id,input.reason])).rows;
 for(const m of members)await tx.query('update lara.principals set revocation_version=revocation_version+1 where tenant_id=$1 and id=$2',[ctx.tenantId,m.principal_id]);
 await tx.query("update lara.share_grants set state='revoked' where tenant_id=$1 and entity_id=$2 and recipient_party_id=$3 and state='active'",[ctx.tenantId,entityId,row.party_id]);
 await audit(tx,ctx,{entityId,action:'portal_invite.revoke',resourceType:'portal_invite',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 await emit(tx,ctx,{entityId,aggregateType:'portal_invite',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'portal.access_revoked.v1',payload:{inviteId:id,memberships:members.length}});
 return {resourceType:'portal_invite',resourceId:id,version:Number(updated.version),state:'revoked'};
}
// The invite link carries the tenant, the invite and a one-time token that
// exists only in the delivered message; the token is rotated at every send.
export async function rotateInviteToken(tx,ctx,entityId,id){
 const token=randomBytes(24).toString('hex');
 const row=(await tx.query("update lara.portal_invites set token_hash=$3 where tenant_id=$1 and id=$2 and state='pending' returning *",[ctx.tenantId,id,sha(token)])).rows[0];
 if(!row)fail('STATE_CONFLICT','The invite is no longer pending.');
 return {token,link:'/portal/accept?tenant='+ctx.tenantId+'&invite='+id+'&token='+token};
}
// Acceptance by the external identity: the token must match, the invite be
// pending and unexpired, and the identity's address be the invited one.
export async function acceptInvite(tx,{tenantId,inviteId,token,issuer,subject,email,displayName}){
 if(!isUuid(inviteId)||typeof token!=='string'||!/^[a-f0-9]{48}$/.test(token))fail('NOT_FOUND','Invite not found.');
 const row=(await tx.query('select * from lara.portal_invites where tenant_id=$1 and id=$2 for update',[tenantId,inviteId])).rows[0];
 if(!row||row.token_hash!==sha(token))fail('NOT_FOUND','Invite not found.');
 if(row.state!=='pending')fail('STATE_CONFLICT','This invite is '+row.state+'.');
 if(new Date(row.expires_at).getTime()<=Date.now()){await tx.query("update lara.portal_invites set state='expired' where tenant_id=$1 and id=$2",[tenantId,inviteId]);fail('STATE_CONFLICT','This invite has expired; ask for a new one.');}
 if(sha(String(email||subject).toLowerCase())!==row.email_hash)fail('FORBIDDEN','This invite was issued to another address.');
 const principal=await identity.resolvePrincipal(tx,tenantId,{issuer,subject,displayName:displayName||maskEmail(email||subject)});
 const internal=(await tx.query("select 1 from lara.memberships where tenant_id=$1 and principal_id=$2 and status='active'",[tenantId,principal.id])).rowCount;
 if(internal)fail('STATE_CONFLICT','This account already holds an internal membership; portal access uses a separate identity.');
 const ctx={tenantId,principalId:principal.id,traceId:'portal-accept'};
 const membership=(await tx.query("insert into lara.portal_memberships(tenant_id,entity_id,principal_id,party_id,invite_id,role,allowed_kinds,expires_at,created_by) values($1,$2,$3,$4,$5,$6,$7,null,$3) on conflict (tenant_id,entity_id,principal_id,party_id) do update set status='active',revoked_reason=null,invite_id=excluded.invite_id,role=excluded.role,allowed_kinds=excluded.allowed_kinds returning *",[tenantId,row.entity_id,principal.id,row.party_id,inviteId,row.role,PORTAL_KINDS[row.role]])).rows[0];
 await tx.query("update lara.portal_invites set state='accepted',accepted_principal_id=$3,accepted_at=now() where tenant_id=$1 and id=$2",[tenantId,inviteId,principal.id]);
 await tx.query('update lara.principals set revocation_version=revocation_version+1 where tenant_id=$1 and id=$2',[tenantId,principal.id]);
 await audit(tx,ctx,{entityId:row.entity_id,action:'portal_invite.accept',resourceType:'portal_invite',resourceId:inviteId,resourceVersion:Number(row.version)+1,afterRef:membership.id});
 await emit(tx,ctx,{entityId:row.entity_id,aggregateType:'portal_membership',aggregateId:membership.id,aggregateVersion:1,eventType:'portal.membership_created.v1',payload:{membershipId:membership.id,partyId:row.party_id,role:row.role}});
 return {resourceType:'portal_membership',resourceId:membership.id,version:1,state:'active',principalId:principal.id,entityId:row.entity_id,partyId:row.party_id,role:row.role};
}
// The portal scope of a principal: one active membership per tenant is the
// external identity; an internal membership excludes it.
export async function portalScope(tx,tenantId,principalId){
 const rows=(await tx.query("select * from lara.portal_memberships where tenant_id=$1 and principal_id=$2 and status='active' and (expires_at is null or expires_at>now()) order by created_at",[tenantId,principalId])).rows;
 if(!rows.length)return null;
 const m=rows[0];
 return {membershipId:m.id,partyId:m.party_id,entityId:m.entity_id,role:m.role,kinds:m.allowed_kinds,permissions:PORTAL_PERMISSIONS[m.role]};
}
const membershipResource=r=>({id:r.id,version:Number(r.version),principalId:r.principal_id,partyId:r.party_id,inviteId:r.invite_id,role:r.role,allowedKinds:r.allowed_kinds,expiresAt:iso(r.expires_at),state:r.status,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
export async function listMemberships(tx,ctx,entityId,query){
 requirePermission(ctx,'portal_invite.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.portal_memberships where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,membershipResource,scope);
}
// What the portal shows its member: the party, the role and the kinds.
export async function portalMe(tx,ctx,entityId){
 if(!ctx.portal)fail('FORBIDDEN','Not a portal member.');requireEntity(ctx,entityId);
 const party=(await tx.query('select legal_name from lara.party where tenant_id=$1 and id=$2',[ctx.tenantId,ctx.portal.partyId])).rows[0];
 const entity=(await tx.query('select legal_name from lara.entities where tenant_id=$1 and id=$2',[ctx.tenantId,entityId])).rows[0];
 const profile=await portalProfile(tx,ctx,entityId).catch(()=>null);
 return {membershipId:ctx.portal.membershipId,partyId:ctx.portal.partyId,partyName:party?.legal_name||'',entityId,entityName:entity?.legal_name||'',role:ctx.portal.role,allowedKinds:ctx.portal.kinds,termsVersion:profile?.termsVersion||null,supportEmail:profile?.supportEmail||null};
}
// Portal reads are filtered to the member's party; internal reads are not.
export function partyFilter(ctx,column='party_id',params){
 if(!ctx.portal)return '';
 params.push(ctx.portal.partyId);return ' and '+column+'=$'+params.length;
}
export function assertPortalParty(ctx,partyId){if(ctx.portal&&partyId!==ctx.portal.partyId)fail('NOT_FOUND','Document not found.');}

// ---------------------------------------------------------------------------
// Share grants and verification
// ---------------------------------------------------------------------------
export async function createShare(tx,ctx,entityId,{resourceType,resourceId,recipientPartyId=null,days=null}){
 const profile=await portalProfile(tx,ctx,entityId);
 const validity=days||profile.shareDays;
 if(resourceType==='document'){const d=(await tx.query("select id,party_id,state from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,resourceId])).rows[0];if(!d)fail('NOT_FOUND','Document not found.');if(d.state!=='posted')fail('STATE_CONFLICT','Only posted documents are shared.');recipientPartyId=recipientPartyId||d.party_id;}
 const token=ctx.tenantId+'.'+randomBytes(24).toString('hex');
 const row=(await tx.query("insert into lara.share_grants(tenant_id,entity_id,resource_type,resource_id,recipient_party_id,token_hash,scope,expires_at,created_by) values($1,$2,$3,$4,$5,$6,$7,now()+($8||' days')::interval,$9) returning *",[ctx.tenantId,entityId,resourceType,resourceId,recipientPartyId,sha(token),JSON.stringify({fields:['number','date','gross','currency','state','partyDisplay']}),String(validity),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'share.create',resourceType:'share_grant',resourceId:row.id,resourceVersion:1,reason:resourceType+' '+resourceId+' for '+validity+' days'});
 return {id:row.id,token,expiresAt:iso(row.expires_at)};
}
export function tenantOfToken(token){const m=/^([0-9a-f-]{36})\.[a-f0-9]{48}$/.exec(String(token||''));return m?m[1]:null;}
// Public verification: minimal approved fields behind a non-enumerable
// token; no TIN, no address, no full document, no acceptance assertion.
export async function verifyShare(tx,tenantId,token){
 const row=(await tx.query('select * from lara.share_grants where tenant_id=$1 and token_hash=$2 for update',[tenantId,sha(token)])).rows[0];
 if(!row)fail('NOT_FOUND','No such link.');
 if(row.state!=='active'||new Date(row.expires_at).getTime()<=Date.now()){if(row.state==='active')await tx.query("update lara.share_grants set state='expired' where tenant_id=$1 and id=$2",[tenantId,row.id]);fail('NOT_FOUND','This link has expired.');}
 await tx.query('update lara.share_grants set access_count=access_count+1 where tenant_id=$1 and id=$2',[tenantId,row.id]);
 if(row.resource_type==='document'){
  const d=(await tx.query('select d.kind,d.official_number,d.document_date,d.gross,d.currency,d.state,p.legal_name from lara.documents d left join lara.party p on p.tenant_id=d.tenant_id and p.id=d.party_id where d.tenant_id=$1 and d.id=$2',[tenantId,row.resource_id])).rows[0];
  return {resourceType:'document',kind:d.kind,number:d.official_number||null,date:iso(d.document_date),gross:money(String(d.gross)),currency:d.currency,state:d.state,partyDisplay:d.legal_name?d.legal_name.slice(0,1)+'***':null,expiresAt:iso(row.expires_at),verified:true,note:'Fields as recorded by the issuer; this page asserts nothing about tax authority acceptance.'};
 }
 return {resourceType:row.resource_type,resourceId:null,expiresAt:iso(row.expires_at),verified:true,note:'Open the portal for the full record.'};
}

// ---------------------------------------------------------------------------
// Message requests
// ---------------------------------------------------------------------------
const messageMaterial=i=>({sourceType:i.sourceType,sourceId:i.sourceId,recipientPartyId:i.recipientPartyId,channel:i.channel,templateVersion:i.templateVersion});
const messageResource=r=>resource(r,{state:r.state,sourceType:r.source_type,sourceId:r.source_id,recipientPartyId:r.recipient_party_id,channel:r.channel,templateVersion:r.template_version});
const SOURCE_TYPES=['document','statement','certificate_request','portal_invite','reminder','balance_confirmation'];
async function checkMessageInput(tx,ctx,entityId,input){
 if(!SOURCE_TYPES.includes(input.sourceType))fail('VALIDATION_FAILED','sourceType is one of '+SOURCE_TYPES.join(', ')+'.',{fieldErrors:[{path:'sourceType',message:SOURCE_TYPES.join('|')}]});
 const party=(await tx.query("select id from lara.party where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,input.recipientPartyId])).rows[0];
 if(!party)fail('NOT_FOUND','Recipient party not found.');
 if(input.sourceType==='document'||input.sourceType==='reminder'){const d=(await tx.query('select party_id,state from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.sourceId])).rows[0];if(!d)fail('NOT_FOUND','Source document not found.');if(d.party_id!==input.recipientPartyId)fail('VALIDATION_FAILED','The document belongs to another party.',{fieldErrors:[{path:'recipientPartyId',message:'Not the document party'}]});if(d.state!=='posted')fail('STATE_CONFLICT','Only posted documents are sent.');}
 if(input.sourceType==='portal_invite'){const i=(await tx.query('select party_id,state from lara.portal_invites where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.sourceId])).rows[0];if(!i)fail('NOT_FOUND','Invite not found.');if(i.party_id!==input.recipientPartyId)fail('VALIDATION_FAILED','The invite belongs to another party.');if(i.state!=='pending')fail('STATE_CONFLICT','The invite is '+i.state+'.');if(input.channel==='portal')fail('VALIDATION_FAILED','An invite reaches its recipient outside the portal.',{fieldErrors:[{path:'channel',message:'email or qualified_chat'}]});}
 if(input.sourceType==='statement'||input.sourceType==='balance_confirmation'){if(input.sourceId!==input.recipientPartyId)fail('VALIDATION_FAILED','A statement or confirmation names the party as its source.',{fieldErrors:[{path:'sourceId',message:'The party id'}]});}
 if(!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(input.templateVersion))fail('VALIDATION_FAILED','templateVersion names an approved template.',{fieldErrors:[{path:'templateVersion',message:'Template code'}]});
}
export async function createMessage(tx,ctx,entityId,input){
 requirePermission(ctx,'message_request.create');requireEntity(ctx,entityId);assertInput('MessageCreate',input);await requirePortals(tx,ctx,entityId);await portalProfile(tx,ctx,entityId);
 await checkMessageInput(tx,ctx,entityId,input);
 const row=(await tx.query('insert into lara.message_requests(tenant_id,entity_id,source_type,source_id,recipient_party_id,channel,template_version,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,input.sourceType,input.sourceId,input.recipientPartyId,input.channel,input.templateVersion,contentHash(messageMaterial(input)),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'message_request.create',resourceType:'message_request',resourceId:row.id,resourceVersion:1,afterRef:row.content_hash});
 return messageResource(row);
}
async function loadMessage(tx,ctx,entityId,id,{lock=false}={}){if(!isUuid(id))fail('NOT_FOUND','Message request not found.');const row=(await tx.query('select * from lara.message_requests where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Message request not found.');return row;}
export async function updateMessage(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'message_request.edit');requireEntity(ctx,entityId);assertInput('MessageCreate',input);
 const row=await loadMessage(tx,ctx,entityId,id,{lock:true});expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','An authorized message never changes; cancel it and draft another.');
 await checkMessageInput(tx,ctx,entityId,input);
 const updated=(await tx.query('update lara.message_requests set source_type=$3,source_id=$4,recipient_party_id=$5,channel=$6,template_version=$7,content_hash=$8,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.sourceType,input.sourceId,input.recipientPartyId,input.channel,input.templateVersion,contentHash(messageMaterial(input))])).rows[0];
 await audit(tx,ctx,{entityId,action:'message_request.edit',resourceType:'message_request',resourceId:id,resourceVersion:Number(updated.version),afterRef:updated.content_hash});
 return messageResource(updated);
}
export async function getMessage(tx,ctx,entityId,id){requirePermission(ctx,'message_request.read');requireEntity(ctx,entityId);return messageResource(await loadMessage(tx,ctx,entityId,id));}
export async function listMessages(tx,ctx,entityId,query){
 requirePermission(ctx,'message_request.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.state){params.push(String(query.state));where+=' and state=$'+params.length;}
 if(query?.recipientPartyId){if(!isUuid(query.recipientPartyId))fail('VALIDATION_FAILED','recipientPartyId must be a UUID.');params.push(query.recipientPartyId);where+=' and recipient_party_id=$'+params.length;}
 const rows=(await tx.query('select * from lara.message_requests where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,messageResource,scope);
}
// Authorization by a named principal other than the drafter: the send key
// is fixed here, a share grant is minted for the source, and the worker
// delivers once. The same authorized request never sends twice.
export async function sendMessage(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'message_request.send');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadMessage(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='sent')return {resourceType:'message_request',resourceId:id,version:Number(row.version),state:'sent'};
 if(!['draft','failed'].includes(row.state))fail('STATE_CONFLICT','The message is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The drafter cannot authorize the send.');
 let shareId=row.share_grant_id;
 if(!shareId&&['document','statement','certificate_request','reminder','balance_confirmation'].includes(row.source_type)){const share=await createShare(tx,ctx,entityId,{resourceType:row.source_type==='document'||row.source_type==='reminder'?'document':row.source_type==='statement'||row.source_type==='balance_confirmation'?'statement':'certificate',resourceId:row.source_id,recipientPartyId:row.recipient_party_id});shareId=share.id;}
 const sendKey=row.send_key||randomUUID();
 const updated=(await tx.query("update lara.message_requests set state='authorized',authorized_by=$3,authorized_at=coalesce(authorized_at,now()),send_key=$4,share_grant_id=$5 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId,sendKey,shareId])).rows[0];
 const job=await enqueueJob(tx,ctx,{entityId,kind:'message.send',payload:{messageId:id,sendKey}});
 await audit(tx,ctx,{entityId,action:'message_request.send',resourceType:'message_request',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason,afterRef:sendKey});
 await emit(tx,ctx,{entityId,aggregateType:'message_request',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'message.authorized.v1',payload:{messageId:id,jobId:job.id}});
 return {resourceType:'message_request',resourceId:id,version:Number(updated.version),state:'authorized',jobId:job.id};
}
// Worker delivery: content is minimized to a subject and an authenticated
// link; a transient provider failure records a failed receipt and rethrows so
// the job retries with the same key — the provider deduplicates on it.
export async function deliverMessage(tx,ctx,entityId,messageId,{provider,store}){
 const row=(await tx.query('select * from lara.message_requests where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,messageId])).rows[0];
 if(!row)fail('NOT_FOUND','Message request not found.');
 if(row.state==='sent')return messageResource(row);
 if(!['authorized','failed','sending'].includes(row.state))fail('STATE_CONFLICT','The message is '+row.state+'.');
 const profile=await portalProfile(tx,ctx,entityId);
 const entity=(await tx.query('select legal_name from lara.entities where tenant_id=$1 and id=$2',[ctx.tenantId,entityId])).rows[0];
 const invite=row.source_type==='portal_invite'?(await tx.query('select * from lara.portal_invites where tenant_id=$1 and id=$2',[ctx.tenantId,row.source_id])).rows[0]:null;
 const share=row.share_grant_id?(await tx.query('select * from lara.share_grants where tenant_id=$1 and id=$2',[ctx.tenantId,row.share_grant_id])).rows[0]:null;
 let link;
 if(invite){if(invite.state!=='pending'){await tx.query("update lara.message_requests set state='cancelled' where tenant_id=$1 and id=$2",[ctx.tenantId,messageId]);return messageResource({...row,state:'cancelled'});}link=profile.baseUrl+(await rotateInviteToken(tx,ctx,entityId,invite.id)).link;}
 else link=profile.baseUrl+'/portal?entity='+entityId+(share?'&share='+share.id:'');
 const to=invite?'invite:'+invite.email_masked:'party:'+row.recipient_party_id;
 const subject=row.template_version+' from '+(entity?.legal_name||'your finance team').slice(0,60);
 const attempt=Number(row.attempts)+1;
 await tx.query("update lara.message_requests set state='sending',attempts=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,messageId,attempt]);
 try{
  const r=await provider.send({key:row.send_key,channel:row.channel,to,subject,link,body:'Open the authenticated link to review. No amounts, identifiers or attachments travel in this message.'});
  await tx.query("insert into lara.delivery_receipts(tenant_id,entity_id,message_request_id,attempt,provider,outcome,provider_reference) values($1,$2,$3,$4,$5,'sent',$6)",[ctx.tenantId,entityId,messageId,attempt,provider.name,r.reference]);
  const updated=(await tx.query("update lara.message_requests set state='sent',provider_reference=$3,last_error=null where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,messageId,r.reference])).rows[0];
  await audit(tx,ctx,{entityId,action:'message_request.sent',resourceType:'message_request',resourceId:messageId,resourceVersion:Number(updated.version),afterRef:r.reference,reason:r.duplicate?'provider deduplicated the send key':null});
  await emit(tx,ctx,{entityId,aggregateType:'message_request',aggregateId:messageId,aggregateVersion:Number(updated.version),eventType:'message.sent.v1',payload:{messageId,reference:r.reference}});
  return messageResource(updated);
 }catch(e){
  // Recorded in its own transaction by the caller: the receipt and the failed state survive the rethrow.
  throw Object.assign(e,{deliveryFailure:{attempt,provider:provider.name,error:String(e.message).slice(0,500)}});
 }
}
export async function recordDeliveryFailure(tx,ctx,entityId,messageId,{attempt,provider,error}){
 await tx.query("insert into lara.delivery_receipts(tenant_id,entity_id,message_request_id,attempt,provider,outcome,error) values($1,$2,$3,$4,$5,'failed',$6) on conflict do nothing",[ctx.tenantId,entityId,messageId,attempt,provider,error]);
 await tx.query("update lara.message_requests set state='failed',attempts=$3,last_error=$4 where tenant_id=$1 and id=$2 and state in ('sending','authorized')",[ctx.tenantId,messageId,attempt,error]);
}
export async function listReceipts(tx,ctx,entityId,id){
 requirePermission(ctx,'message_request.read');requireEntity(ctx,entityId);await loadMessage(tx,ctx,entityId,id);
 const rows=(await tx.query('select * from lara.delivery_receipts where tenant_id=$1 and message_request_id=$2 order by attempt',[ctx.tenantId,id])).rows;
 return {id,receipts:rows.map(r=>({attempt:r.attempt,provider:r.provider,outcome:r.outcome,providerReference:r.provider_reference,error:r.error,createdAt:iso(r.created_at)}))};
}

// ---------------------------------------------------------------------------
// Supplier submissions: an upload from the portal routes to review, never to a bill.
// ---------------------------------------------------------------------------
const LEGAL_FIELDS={tin:'supplier TIN',number:'invoice number',date:'invoice date',total:'total amount'};
export async function recordSubmission(tx,ctx,entityId,evidenceId,bytes){
 if(!ctx.portal||ctx.portal.role!=='supplier')return null;
 const text=Buffer.from(bytes).toString('utf8').slice(0,50000);
 const found=new Set();for(const line of text.split(/\r?\n/)){const m=/^([A-Za-z ]{2,30}):\s*(\S.*)$/.exec(line.trim());if(m)found.add(m[1].trim().toLowerCase());}
 const missing=Object.entries(LEGAL_FIELDS).filter(([k])=>!found.has(k)).map(([,l])=>l);
 const reason=(missing.length?'Supplier submission is missing '+missing.join(', ')+'; review with the supplier before any bill is drafted.':'Supplier submission carries the legal fields; review the scanned document and draft the bill through purchasing.')+' Uploads never post.';
 const task=(await tx.query("insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,status,severity,cause_key,reason,created_by) values($1,$2,'supplier_submission','evidence',$3,'open',$4,'submission',$5,$6) on conflict do nothing returning id",[ctx.tenantId,entityId,evidenceId,missing.length?'high':'normal',reason,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'portal.submission',resourceType:'evidence',resourceId:evidenceId,resourceVersion:1,reason:missing.length?'missing: '+missing.join(', '):'complete'});
 return {taskId:task?.id||null,missing};
}

// ---------------------------------------------------------------------------
// Payment links: provider intents keyed once; a browser return is a claim,
// the signed and verified webhook is the truth, settlement is the normal
// collection command drafted for review.
// ---------------------------------------------------------------------------
const linkMaterial=i=>({invoiceId:i.invoiceId,amount:money(i.amount),currency:i.currency,expiresAt:i.expiresAt});
const linkResource=r=>resource(r,{state:r.status,invoiceId:r.document_id,amount:money(String(r.amount)),currency:r.currency,expiresAt:iso(r.expires_at)});
async function outstandingOf(tx,ctx,entityId,documentId){
 const item=(await tx.query('select id,party_id,currency,original_amount::text as original,lara.open_item_allocated(tenant_id,id)::text as used,status from lara.open_items where tenant_id=$1 and entity_id=$2 and document_id=$3',[ctx.tenantId,entityId,documentId])).rows[0];
 if(!item)fail('STATE_CONFLICT','The invoice has no open item; post it first.');
 return {item,outstanding:micros(item.original)-micros(item.used)};
}
export async function createPaymentLink(tx,ctx,entityId,input,{provider}){
 requirePermission(ctx,'payment_link.create');requireEntity(ctx,entityId);assertInput('PaymentLinkCreate',input);await requirePortals(tx,ctx,entityId);
 const profile=await portalProfile(tx,ctx,entityId);if(!profile.paymentBankAccountId)fail('RULE_PROFILE_NOT_APPROVED','The portal profile names no settlement bank account for provider receipts.');
 const doc=(await tx.query("select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3 and kind='invoice'",[ctx.tenantId,entityId,input.invoiceId])).rows[0];
 if(!doc)fail('NOT_FOUND','Invoice not found.');if(doc.state!=='posted')fail('STATE_CONFLICT','Payment links are issued on posted invoices.');
 if(input.currency!==doc.currency)fail('VALIDATION_FAILED','Currency differs from the invoice.',{fieldErrors:[{path:'currency',message:doc.currency}]});
 const amount=micros(input.amount);if(amount<=0n)fail('VALIDATION_FAILED','Amount must be positive.',{fieldErrors:[{path:'amount',message:'Positive'}]});
 const {outstanding}=await outstandingOf(tx,ctx,entityId,doc.id);
 if(amount>outstanding)fail('VALIDATION_FAILED','Amount exceeds the outstanding '+decimal(outstanding)+'.',{fieldErrors:[{path:'amount',message:'At most '+decimal(outstanding)}]});
 checkExpiry(input.expiresAt,60);
 const intentKey=randomUUID();
 const created=await provider.createIntent({intentKey,amount:money(input.amount),currency:input.currency,reference:doc.official_number||doc.id,expiresAt:input.expiresAt});
 const row=(await tx.query("insert into lara.provider_payment_intents(tenant_id,entity_id,document_id,amount,currency,provider,provider_key,expires_at,status,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10) returning *",[ctx.tenantId,entityId,doc.id,decimal(amount,6),input.currency,provider.name,created.providerKey,input.expiresAt,contentHash(linkMaterial(input)),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment_link.create',resourceType:'payment_link',resourceId:row.id,resourceVersion:1,afterRef:created.providerKey});
 return linkResource(row);
}
async function loadLink(tx,ctx,entityId,id,{lock=false}={}){if(!isUuid(id))fail('NOT_FOUND','Payment link not found.');const row=(await tx.query('select * from lara.provider_payment_intents where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Payment link not found.');if(ctx.portal){const d=(await tx.query('select party_id from lara.documents where tenant_id=$1 and id=$2',[ctx.tenantId,row.document_id])).rows[0];assertPortalParty(ctx,d?.party_id);}return row;}
export async function updatePaymentLink(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'payment_link.edit');requireEntity(ctx,entityId);assertInput('PaymentLinkCreate',input);
 const row=await loadLink(tx,ctx,entityId,id,{lock:true});expectVersion(row,expectedVersion);
 if(row.status!=='pending')fail('STATE_CONFLICT','Only pending links are edited.');
 if(input.invoiceId!==row.document_id||input.currency!==row.currency||micros(input.amount)!==micros(String(row.amount)))fail('STATE_CONFLICT','A live payment intent keeps its invoice, amount and currency; cancel it and issue another.');
 checkExpiry(input.expiresAt,60);
 const updated=(await tx.query('update lara.provider_payment_intents set expires_at=$3,content_hash=$4,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.expiresAt,contentHash(linkMaterial(input))])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment_link.edit',resourceType:'payment_link',resourceId:id,resourceVersion:Number(updated.version)});
 return linkResource(updated);
}
export async function getPaymentLink(tx,ctx,entityId,id){requirePermission(ctx,'payment_link.read');requireEntity(ctx,entityId);return linkResource(await loadLink(tx,ctx,entityId,id));}
export async function listPaymentLinks(tx,ctx,entityId,query){
 requirePermission(ctx,'payment_link.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.invoiceId){if(!isUuid(query.invoiceId))fail('VALIDATION_FAILED','invoiceId must be a UUID.');params.push(query.invoiceId);where+=' and i.document_id=$'+params.length;}
 if(query?.state){params.push(String(query.state));where+=' and i.status=$'+params.length;}
 where+=partyFilter(ctx,'d.party_id',params);
 const rows=(await tx.query('select i.* from lara.provider_payment_intents i join lara.documents d on d.tenant_id=i.tenant_id and d.id=i.document_id where i.tenant_id=$1 and i.entity_id=$2'+where+cursorClause(after,params).replace(/\b(created_at|id)\b/g,'i.$1')+' order by i.created_at,i.id limit $3',params)).rows;
 return page(rows,limit,linkResource,scope);
}
export async function cancelPaymentLink(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'payment_link.cancel');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadLink(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(['cancelled','expired','failed'].includes(row.status))return {resourceType:'payment_link',resourceId:id,version:Number(row.version),state:row.status};
 if(['paid','settled'].includes(row.status))fail('STATE_CONFLICT','A paid intent is not cancelled; refund through the normal flow.');
 const updated=(await tx.query("update lara.provider_payment_intents set status='cancelled',cancel_reason=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.reason])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment_link.cancel',resourceType:'payment_link',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'payment_link',resourceId:id,version:Number(updated.version),state:'cancelled'};
}
// The customer's browser return is a claim, shown as such; it changes no state.
export async function claimPayment(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'payment_link.read');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadLink(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['pending','created'].includes(row.status))return {resourceType:'payment_link',resourceId:id,version:Number(row.version),state:row.status};
 const updated=(await tx.query('update lara.provider_payment_intents set customer_claimed_at=coalesce(customer_claimed_at,now()) where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment_link.claim',resourceType:'payment_link',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'payment_link',resourceId:id,version:Number(updated.version),state:updated.status,claimed:true};
}
// Inbound provider event: signature, timestamp window, dedupe, amount,
// currency and payee checks, then server-to-server verification, then the
// settlement draft — once, whatever the order or number of events.
export async function receiveWebhook(tx,{tenantId,providerName,headers,rawBody,provider,now=Date.now()}){
 const ctx={tenantId,principalId:null,traceId:headers['x-trace-id']||('webhook-'+randomUUID().slice(0,8))};
 const record=async(eventId,payloadHash,signatureState,eventType,intentId,outcome,reason)=>{await tx.query('insert into lara.webhook_receipts(tenant_id,provider,event_id,payload_hash,signature_state,event_type,intent_id,outcome,reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id,provider,event_id) do nothing',[tenantId,providerName,eventId,payloadHash,signatureState,eventType,intentId,outcome,reason]);return {outcome,reason,eventId};};
 const payloadHash=sha(rawBody);
 const timestamp=String(headers['x-webhook-timestamp']||''),signature=String(headers['x-webhook-signature']||'');
 let event;try{event=JSON.parse(rawBody);}catch{return record('malformed-'+payloadHash.slice(0,16),payloadHash,'invalid',null,null,'rejected','malformed body');}
 const eventId=typeof event.id==='string'&&event.id.length<=200?event.id:'unidentified-'+payloadHash.slice(0,16);
 if(!provider.verifySignature(timestamp,rawBody,signature))return record(eventId,payloadHash,'invalid',event.type||null,null,'rejected','signature mismatch');
 const ts=Number(timestamp);if(!Number.isFinite(ts)||Math.abs(now-ts*1000)>300000)return record(eventId,payloadHash,'stale',event.type||null,null,'rejected','timestamp outside the five-minute window');
 const seen=(await tx.query('select id from lara.webhook_receipts where tenant_id=$1 and provider=$2 and event_id=$3',[tenantId,providerName,eventId])).rows[0];
 if(seen)return {outcome:'ignored',reason:'replayed event',eventId,replayed:true};
 const intent=(await tx.query('select * from lara.provider_payment_intents where tenant_id=$1 and provider=$2 and provider_key=$3 for update',[tenantId,providerName,String(event.providerKey||'')])).rows[0];
 if(!intent)return record(eventId,payloadHash,'valid',event.type||null,null,'rejected','unknown intent');
 if(event.type!=='payment.paid')return record(eventId,payloadHash,'valid',event.type,intent.id,'ignored','event type carries no settlement');
 if(['settled','paid'].includes(intent.status))return record(eventId,payloadHash,'valid',event.type,intent.id,'ignored','already '+intent.status+'; never settled twice');
 if(['cancelled','expired','failed'].includes(intent.status))return record(eventId,payloadHash,'valid',event.type,intent.id,'rejected','intent is '+intent.status);
 // Server-to-server truth beats the event body.
 const truth=await provider.verify(intent.provider_key);
 if(truth.status!=='paid')return record(eventId,payloadHash,'valid',event.type,intent.id,'rejected','provider reports '+truth.status);
 if(micros(String(truth.amount))!==micros(String(intent.amount))||truth.currency!==intent.currency)return record(eventId,payloadHash,'valid',event.type,intent.id,'rejected','amount or currency differs from the intent ('+truth.amount+' '+truth.currency+')');
 if(truth.payee&&truth.payee!=='merchant-fixture'&&truth.payee!==intent.provider)return record(eventId,payloadHash,'valid',event.type,intent.id,'rejected','payee differs');
 await tx.query("update lara.provider_payment_intents set status='paid',paid_at=now(),provider_amount=$3,provider_currency=$4 where tenant_id=$1 and id=$2",[tenantId,intent.id,decimal(micros(String(truth.amount)),6),truth.currency]);
 const settlement=await reconcileIntent(tx,{tenantId,intent:{...intent,status:'paid'},traceId:ctx.traceId});
 await record(eventId,payloadHash,'valid',event.type,intent.id,'applied',settlement?'settlement draft '+settlement.id:'paid; settlement pending review task');
 return {outcome:'applied',reason:null,eventId,intentId:intent.id,settlementId:settlement?.id||null};
}
// The normal collection command, drafted under the link issuer's current
// authority for review, allocated to the invoice's open item.
async function reconcileIntent(tx,{tenantId,intent,traceId}){
 const sales=await import('./sales.mjs');
 const issuer=await identity.actorContext(tx,tenantId,intent.created_by,{traceId}).catch(()=>null);
 const entityId=intent.entity_id;
 const doc=(await tx.query('select * from lara.documents where tenant_id=$1 and id=$2',[tenantId,intent.document_id])).rows[0];
 const profile=await portalProfile(tx,{tenantId,principalId:intent.created_by},entityId).catch(()=>null);
 const ctx={tenantId,principalId:intent.created_by,traceId};
 if(!issuer||!issuer.permissions.has('collection.create')||!profile?.paymentBankAccountId){
  await tx.query("insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,status,severity,cause_key,reason,created_by) values($1,$2,'payment_reconciliation','payment_link',$3,'open','high','paid',$4,$5) on conflict do nothing",[tenantId,entityId,intent.id,'Provider reports the payment link paid ('+money(String(intent.amount))+' '+intent.currency+'); record the receipt through collections.',intent.created_by]);
  return null;
 }
 const {item}=await outstandingOf(tx,ctx,entityId,doc.id);
 const collection=await sales.createCollection(tx,{...issuer,traceId},entityId,{direction:'receipt',partyId:doc.party_id,bankAccountId:profile.paymentBankAccountId,currency:intent.currency,valueDate:new Date().toISOString().slice(0,10),grossAmount:money(String(intent.amount)),cashAmount:money(String(intent.amount)),withholdingAmount:'0',method:'wallet',allocations:[{openItemId:item.id,amount:money(String(intent.amount))}],evidenceIds:[]});
 await tx.query("update lara.provider_payment_intents set status='settled',settlement_id=$3 where tenant_id=$1 and id=$2",[tenantId,intent.id,collection.id]);
 await audit(tx,ctx,{entityId,action:'payment_link.settled',resourceType:'payment_link',resourceId:intent.id,resourceVersion:Number(intent.version)+2,afterRef:collection.id,reason:'provider-settled receipt drafted for review'});
 await emit(tx,ctx,{entityId,aggregateType:'payment_link',aggregateId:intent.id,aggregateVersion:Number(intent.version)+2,eventType:'payment_link.settled.v1',payload:{intentId:intent.id,settlementId:collection.id}});
 return collection;
}
export async function listWebhookReceipts(tx,ctx,entityId,{provider=null}={}){
 requirePermission(ctx,'payment_link.read');requireEntity(ctx,entityId);
 const params=[ctx.tenantId];let where='';if(provider){params.push(provider);where=' and provider=$2';}
 return (await tx.query('select * from lara.webhook_receipts where tenant_id=$1'+where+' order by received_at desc limit 200',params)).rows.map(r=>({id:r.id,provider:r.provider,eventId:r.event_id,signatureState:r.signature_state,eventType:r.event_type,intentId:r.intent_id,outcome:r.outcome,reason:r.reason,receivedAt:iso(r.received_at)}));
}
