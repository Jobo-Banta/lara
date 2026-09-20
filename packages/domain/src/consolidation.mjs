// Intercompany and consolidation (P15): a group owned by its reporting
// entity with wholly-owned members under the full method and its own
// reporting book; approved account mapping versions from member charts to
// group accounts; approved rate sets (closing, average, historical per
// currency); intercompany pairs whose two sides are accepted and posted
// under each entity's own authority as a saga (an issued side is never
// rolled back, a failed second side is an exception); consolidation runs
// that consume approved member statement snapshots, translate, eliminate
// reciprocal balances and intra-group revenue and expense once, show every
// unresolved difference instead of plugging it, and yield a deterministic
// result whose hash is stable for the same inputs. Publishing writes a
// report snapshot in the group's book; subsidiary ledgers are never written.
import {createHash} from 'node:crypto';
import {assertInput,audit,canonical,contentHash,cursorClause,cursorScope,emit,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource,DomainError} from './core.mjs';
import {micros,signedMicros,decimal} from './ledger.mjs';
import {rateScaled,convert} from './fx.mjs';
import * as sales from './sales.mjs';
import * as purchasing from './purchasing.mjs';
import {linkEvidence} from './evidence.mjs';

const sha=v=>createHash('sha256').update(String(v)).digest('hex');
const money=v=>decimal(micros(String(v)),2);
const signed=v=>decimal(signedMicros(String(v)),2);
const ONE=rateScaled('1');
const dateKey=d=>String(d).slice(0,7);

// ---------------------------------------------------------------------------
// Capability and group
// ---------------------------------------------------------------------------
export async function requireGroupAccounting(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='group_accounting' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The group accounting capability is not active for this entity.');
}
const memberResource=m=>({entityId:m.entity_id,ownershipPercent:String(m.ownership_pct).replace(/\.?0+$/,''),method:m.method,effectiveFrom:iso(m.effective_from)});
const groupResource=(g,members)=>({id:g.id,version:Number(g.version),contentVersion:Number(g.content_version),state:g.state,createdAt:iso(g.created_at),updatedAt:iso(g.updated_at),simulation:false,name:g.name,reportingCurrency:g.reporting_currency,members:members.map(memberResource)});
async function membersOf(tx,ctx,groupId){return (await tx.query('select * from lara.group_members where tenant_id=$1 and group_id=$2 order by effective_from,entity_id',[ctx.tenantId,groupId])).rows;}
async function loadGroup(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Group not found.');
 const row=(await tx.query('select * from lara.groups where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Group not found.');return row;
}
async function validateMembers(tx,ctx,entityId,input){
 const seen=new Set();
 for(const [i,m] of input.members.entries()){
  if(seen.has(m.entityId))fail('VALIDATION_FAILED','Each member entity appears once.',{fieldErrors:[{path:'members['+i+'].entityId',message:'Duplicate'}]});seen.add(m.entityId);
  if(m.method!=='full')fail('FEATURE_NOT_ENABLED','Partial ownership and the equity method require an approved extension; this release consolidates wholly-owned members under the full method.');
  if(rateScaled(m.ownershipPercent)!==rateScaled('100'))fail('FEATURE_NOT_ENABLED','Full consolidation applies to wholly-owned members (100%). Minority interests block the member until an extension is approved.');
  const entity=(await tx.query("select id,status from lara.entities where tenant_id=$1 and id=$2",[ctx.tenantId,m.entityId])).rows[0];
  if(!entity||entity.status==='archived')fail('NOT_FOUND','Member entity '+m.entityId+' not found.');
 }
 if(!seen.has(entityId))fail('VALIDATION_FAILED','The reporting entity is itself a member of the group; list it with its own books.',{fieldErrors:[{path:'members',message:'Reporting entity missing'}]});
}
const groupMaterial=i=>({name:i.name,reportingCurrency:i.reportingCurrency,members:[...i.members].map(m=>({entityId:m.entityId,ownershipPercent:m.ownershipPercent,method:m.method,effectiveFrom:m.effectiveFrom})).sort((a,b)=>a.entityId<b.entityId?-1:1)});
async function writeMembers(tx,ctx,groupId,members){
 await tx.query('delete from lara.group_members where tenant_id=$1 and group_id=$2',[ctx.tenantId,groupId]);
 for(const m of members)await tx.query('insert into lara.group_members(tenant_id,group_id,entity_id,ownership_pct,method,effective_from,created_by) values($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,groupId,m.entityId,m.ownershipPercent,m.method,m.effectiveFrom,ctx.principalId]);
}
export async function createGroup(tx,ctx,entityId,input){
 requirePermission(ctx,'group.create');requireEntity(ctx,entityId);assertInput('GroupCreate',input);await requireGroupAccounting(tx,ctx,entityId);
 await validateMembers(tx,ctx,entityId,input);
 if(!(await tx.query('select 1 from lara.currency_metadata where code=$1',[input.reportingCurrency])).rowCount)fail('VALIDATION_FAILED','Unknown reporting currency.',{fieldErrors:[{path:'reportingCurrency',message:'Unknown'}]});
 if((await tx.query("select 1 from lara.groups where tenant_id=$1 and entity_id=$2 and state<>'archived'",[ctx.tenantId,entityId])).rowCount)fail('STATE_CONFLICT','This entity already reports a group; archive it before defining another.');
 // The separate reporting book: consolidated snapshots live here and never in a member ledger.
 const book=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'CONSOL','management',$3,'active',$4) on conflict (tenant_id,entity_id,code) do update set status='active' returning id",[ctx.tenantId,entityId,input.reportingCurrency,ctx.principalId])).rows[0];
 const row=(await tx.query('insert into lara.groups(tenant_id,entity_id,name,reporting_currency,book_id,created_by) values($1,$2,$3,$4,$5,$6) returning *',[ctx.tenantId,entityId,input.name,input.reportingCurrency,book.id,ctx.principalId])).rows[0];
 await writeMembers(tx,ctx,row.id,input.members);
 await audit(tx,ctx,{entityId,action:'group.create',resourceType:'group',resourceId:row.id,resourceVersion:1,afterRef:contentHash(groupMaterial(input))});
 return groupResource(row,await membersOf(tx,ctx,row.id));
}
export async function updateGroup(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'group.edit');requireEntity(ctx,entityId);assertInput('GroupCreate',input);
 const row=await loadGroup(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','An active group keeps its members and currency; archive it and define another.');
 await validateMembers(tx,ctx,entityId,input);
 const updated=(await tx.query('update lara.groups set name=$4,reporting_currency=$5,content_version=content_version+1 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,input.name,input.reportingCurrency])).rows[0];
 await tx.query('update lara.books set functional_currency=$4 where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,row.book_id,input.reportingCurrency]);
 await writeMembers(tx,ctx,id,input.members);
 await audit(tx,ctx,{entityId,action:'group.edit',resourceType:'group',resourceId:id,resourceVersion:Number(updated.version),afterRef:contentHash(groupMaterial(input))});
 return groupResource(updated,await membersOf(tx,ctx,id));
}
export async function getGroup(tx,ctx,entityId,id){requirePermission(ctx,'group.read');requireEntity(ctx,entityId);const row=await loadGroup(tx,ctx,entityId,id);return groupResource(row,await membersOf(tx,ctx,id));}
export async function listGroups(tx,ctx,entityId,query){
 requirePermission(ctx,'group.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.groups where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const members=await Promise.all(rows.map(r=>membersOf(tx,ctx,r.id)));
 return page(rows,limit,(r,i)=>groupResource(r,members[rows.indexOf(r)]),scope);
}
// Activation by a second principal: ownership, method and the mapping and
// rate policies become the approved basis for every later run.
export async function activateGroup(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'group.activate');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadGroup(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Group is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who defined the group cannot activate it.');
 if(!(await tx.query("select 1 from lara.group_mapping_versions where tenant_id=$1 and group_id=$2 and state='approved'",[ctx.tenantId,id])).rowCount)fail('STATE_CONFLICT','An approved account mapping version is required before the group activates.');
 const updated=(await tx.query("update lara.groups set state='active',activated_by=$4,activated_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'group.activate',resourceType:'group',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 await emit(tx,ctx,{entityId,aggregateType:'group',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'consolidation.group_activated.v1',payload:{groupId:id,reportingCurrency:row.reporting_currency}});
 return {resourceType:'group',resourceId:id,version:Number(updated.version),state:'active'};
}
// The active group two entities share, if any: pairs are only intra-group.
async function sharedGroup(tx,ctx,a,b){
 return (await tx.query("select g.* from lara.groups g where g.tenant_id=$1 and g.state='active' and exists(select 1 from lara.group_members m where m.tenant_id=g.tenant_id and m.group_id=g.id and m.entity_id=$2) and exists(select 1 from lara.group_members m where m.tenant_id=g.tenant_id and m.group_id=g.id and m.entity_id=$3) limit 1",[ctx.tenantId,a,b])).rows[0];
}

// ---------------------------------------------------------------------------
// Account mapping versions
// ---------------------------------------------------------------------------
const ROLES=['intercompany_receivable','intercompany_payable','intercompany_revenue','intercompany_expense','translation_reserve','retained_earnings'];
const entryResource=e=>({memberEntityId:e.member_entity_id,accountId:e.account_id,groupAccountCode:e.group_account_code,groupAccountName:e.group_account_name,groupCategory:e.group_category,role:e.role});
const mappingResource=(v,entries)=>({id:v.id,version:Number(v.version),contentVersion:1,state:v.state,createdAt:iso(v.created_at),updatedAt:iso(v.updated_at),simulation:false,groupId:v.group_id,mappingVersion:v.mapping_version,entries:entries.map(entryResource),contentHash:v.content_hash,approvedBy:v.approved_by});
async function entriesOf(tx,ctx,versionId){return (await tx.query('select * from lara.group_account_mappings where tenant_id=$1 and mapping_version_id=$2 order by member_entity_id,group_account_code,account_id',[ctx.tenantId,versionId])).rows;}
export async function createMapping(tx,ctx,entityId,groupId,input){
 requirePermission(ctx,'group.edit');requireEntity(ctx,entityId);assertInput('GroupMappingCreate',input);
 const group=await loadGroup(tx,ctx,entityId,groupId);
 if(group.state==='archived')fail('STATE_CONFLICT','Group is archived.');
 const members=new Set((await membersOf(tx,ctx,groupId)).map(m=>m.entity_id));
 const seen=new Set();const codes=new Map();
 for(const [i,e] of input.entries.entries()){
  if(!members.has(e.memberEntityId))fail('VALIDATION_FAILED','Entry names an entity outside the group.',{fieldErrors:[{path:'entries['+i+'].memberEntityId',message:'Not a member'}]});
  const acc=(await tx.query('select category from lara.accounts where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,e.memberEntityId,e.accountId])).rows[0];
  if(!acc)fail('NOT_FOUND','Account '+e.accountId+' not found in member '+e.memberEntityId+'.');
  const key=e.memberEntityId+'/'+e.accountId;if(seen.has(key))fail('VALIDATION_FAILED','An account maps once per version.',{fieldErrors:[{path:'entries['+i+'].accountId',message:'Duplicate'}]});seen.add(key);
  const prior=codes.get(e.groupAccountCode);if(prior&&prior!==e.groupCategory)fail('VALIDATION_FAILED','Group account '+e.groupAccountCode+' carries one category.',{fieldErrors:[{path:'entries['+i+'].groupCategory',message:'Conflicts with '+prior}]});codes.set(e.groupAccountCode,e.groupCategory);
  if(e.role&&!ROLES.includes(e.role))fail('VALIDATION_FAILED','Unknown mapping role.',{fieldErrors:[{path:'entries['+i+'].role',message:'Unknown'}]});
  if(e.role==='translation_reserve'||e.role==='retained_earnings'){if(e.groupCategory!=='equity')fail('VALIDATION_FAILED','Reserve and retained earnings roles are equity.',{fieldErrors:[{path:'entries['+i+'].groupCategory',message:'equity'}]});}
 }
 const material={mappingVersion:input.mappingVersion,entries:[...input.entries].map(e=>({...e,role:e.role||null})).sort((a,b)=>(a.memberEntityId+a.accountId)<(b.memberEntityId+b.accountId)?-1:1)};
 const hash=contentHash(material);
 if((await tx.query('select 1 from lara.group_mapping_versions where tenant_id=$1 and group_id=$2 and mapping_version=$3',[ctx.tenantId,groupId,input.mappingVersion])).rowCount)fail('STATE_CONFLICT','Mapping version '+input.mappingVersion+' exists; versions are immutable, add a new one.');
 const row=(await tx.query('insert into lara.group_mapping_versions(tenant_id,entity_id,group_id,mapping_version,entry_count,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[ctx.tenantId,entityId,groupId,input.mappingVersion,input.entries.length,hash,ctx.principalId])).rows[0];
 for(const e of input.entries)await tx.query('insert into lara.group_account_mappings(tenant_id,mapping_version_id,member_entity_id,account_id,group_account_code,group_account_name,group_category,role) values($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,row.id,e.memberEntityId,e.accountId,e.groupAccountCode,e.groupAccountName,e.groupCategory,e.role||null]);
 await audit(tx,ctx,{entityId,action:'group.mapping',resourceType:'group_mapping_version',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return mappingResource(row,await entriesOf(tx,ctx,row.id));
}
export async function listMappings(tx,ctx,entityId,groupId){
 requirePermission(ctx,'group.read');requireEntity(ctx,entityId);await loadGroup(tx,ctx,entityId,groupId);
 const rows=(await tx.query('select * from lara.group_mapping_versions where tenant_id=$1 and group_id=$2 order by created_at,id',[ctx.tenantId,groupId])).rows;
 const items=[];for(const r of rows)items.push(mappingResource(r,await entriesOf(tx,ctx,r.id)));
 return {items,nextCursor:null};
}
export async function approveMapping(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'group.activate');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 if(!isUuid(id))fail('NOT_FOUND','Mapping version not found.');
 const row=(await tx.query('select * from lara.group_mapping_versions where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Mapping version not found.');if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Mapping version is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who drafted the mapping cannot approve it.');
 if(input.contentVersion!==1)fail('VERSION_CONFLICT','The mapping changed since review.',{resourceVersion:Number(row.version)});
 const state=input.decision==='approve'?'approved':'rejected';
 if(state==='rejected'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const updated=(await tx.query('update lara.group_mapping_versions set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,state,state==='approved'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'group.mapping_'+state,resourceType:'group_mapping_version',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'group_mapping_version',resourceId:id,version:Number(updated.version),state};
}
async function approvedMapping(tx,ctx,groupId,mappingVersion){
 const v=(await tx.query("select * from lara.group_mapping_versions where tenant_id=$1 and group_id=$2 and mapping_version=$3 and state='approved'",[ctx.tenantId,groupId,mappingVersion])).rows[0];
 if(!v)fail('RULE_PROFILE_NOT_APPROVED','Mapping version '+mappingVersion+' is not approved for this group.');
 return {version:v,entries:await entriesOf(tx,ctx,v.id)};
}

// ---------------------------------------------------------------------------
// Rate sets
// ---------------------------------------------------------------------------
const rateSetResource=r=>resource({...r,status:r.state},{code:r.code,periodEnd:iso(r.period_end),reportingCurrency:r.reporting_currency,incomePolicy:r.income_policy,rates:r.rates,sourceEvidenceId:r.source_evidence_id,approvedBy:r.approved_by});
export async function createRateSet(tx,ctx,entityId,input){
 requirePermission(ctx,'consolidation.edit');requireEntity(ctx,entityId);assertInput('RateSetCreate',input);await requireGroupAccounting(tx,ctx,entityId);
 const group=(await tx.query("select * from lara.groups where tenant_id=$1 and entity_id=$2 and state<>'archived'",[ctx.tenantId,entityId])).rows[0];
 if(!group)fail('STATE_CONFLICT','Define the group before its rate sets.');
 const seen=new Set();
 for(const [i,r] of input.rates.entries()){
  if(seen.has(r.currency))fail('VALIDATION_FAILED','One rate per currency.',{fieldErrors:[{path:'rates['+i+'].currency',message:'Duplicate'}]});seen.add(r.currency);
  if(r.currency===group.reporting_currency)fail('VALIDATION_FAILED','The reporting currency needs no rate.',{fieldErrors:[{path:'rates['+i+'].currency',message:'Reporting currency'}]});
  for(const k of ['closing','average','historical'])if(rateScaled(r[k])<=0n)fail('VALIDATION_FAILED','Rates are positive.',{fieldErrors:[{path:'rates['+i+'].'+k,message:'Positive'}]});
 }
 const material={code:input.code,periodEnd:input.periodEnd,incomePolicy:input.incomePolicy||'period_average',rates:[...input.rates].sort((a,b)=>a.currency<b.currency?-1:1),sourceEvidenceId:input.sourceEvidenceId};
 const hash=contentHash(material);
 if((await tx.query('select 1 from lara.consolidation_rate_sets where tenant_id=$1 and entity_id=$2 and code=$3',[ctx.tenantId,entityId,input.code])).rowCount)fail('STATE_CONFLICT','Rate set '+input.code+' exists; rate sets are immutable, add a new code.');
 const row=(await tx.query('insert into lara.consolidation_rate_sets(tenant_id,entity_id,code,period_end,reporting_currency,income_policy,rates,source_evidence_id,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,input.code,input.periodEnd,group.reporting_currency,material.incomePolicy,JSON.stringify(material.rates),input.sourceEvidenceId,hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,[input.sourceEvidenceId],'consolidation_rate_set',row.id,1);
 await audit(tx,ctx,{entityId,action:'consolidation.rate_set',resourceType:'consolidation_rate_set',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return rateSetResource(row);
}
async function loadRateSet(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Rate set not found.');
 const row=(await tx.query('select * from lara.consolidation_rate_sets where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Rate set not found.');return row;
}
export async function getRateSet(tx,ctx,entityId,id){requirePermission(ctx,'consolidation.read');requireEntity(ctx,entityId);return rateSetResource(await loadRateSet(tx,ctx,entityId,id));}
export async function listRateSets(tx,ctx,entityId,query){
 requirePermission(ctx,'consolidation.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.consolidation_rate_sets where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,rateSetResource,scope);
}
export async function approveRateSet(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'consolidation.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadRateSet(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Rate set is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who entered the rates cannot approve them.');
 if(input.contentVersion!==Number(row.content_version??1))fail('VERSION_CONFLICT','The rate set changed since review.',{resourceVersion:Number(row.version)});
 const state=input.decision==='approve'?'approved':'rejected';
 if(state==='rejected'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const updated=(await tx.query('update lara.consolidation_rate_sets set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,state,state==='approved'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'consolidation.rate_set_'+state,resourceType:'consolidation_rate_set',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'consolidation_rate_set',resourceId:id,version:Number(updated.version),state};
}

// ---------------------------------------------------------------------------
// Intercompany pairs: a saga of two locally authorized transactions
// ---------------------------------------------------------------------------
const COUNTERPART={invoice:'bill',bill:'invoice'};
const pairResource=r=>({id:r.id,version:Number(r.version),contentVersion:Number(r.content_version),state:r.state,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false,sourceEntityId:r.source_entity_id,targetEntityId:r.target_entity_id,sourceDocumentId:r.source_document_id,targetDraft:r.target_draft});
export const pairDetail=r=>({...pairResource(r),targetDocumentId:r.target_document_id,sharedReference:r.shared_reference,sourcePostedAt:iso(r.source_posted_at),targetPostedAt:iso(r.target_posted_at),exceptionReason:r.exception_reason});
const pairMaterial=i=>({sourceEntityId:i.sourceEntityId,targetEntityId:i.targetEntityId,sourceDocumentId:i.sourceDocumentId,targetDraft:i.targetDraft});
async function validatePair(tx,ctx,entityId,input){
 if(input.sourceEntityId!==entityId)fail('VALIDATION_FAILED','A pair is raised in the source entity.',{fieldErrors:[{path:'sourceEntityId',message:'Must be the current entity'}]});
 if(input.sourceEntityId===input.targetEntityId)fail('VALIDATION_FAILED','Source and target are different entities.',{fieldErrors:[{path:'targetEntityId',message:'Same as source'}]});
 const group=await sharedGroup(tx,ctx,input.sourceEntityId,input.targetEntityId);
 if(!group)fail('STATE_CONFLICT','Both entities must be members of one active group.');
 const src=(await tx.query('select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.sourceDocumentId])).rows[0];
 if(!src)fail('NOT_FOUND','Source document not found.');
 if(!COUNTERPART[src.kind])fail('VALIDATION_FAILED','Intercompany pairs tie an invoice to a bill.',{fieldErrors:[{path:'sourceDocumentId',message:'invoice or bill'}]});
 if(src.state==='cancelled')fail('STATE_CONFLICT','The source document is cancelled.');
 if(input.targetDraft.kind!==COUNTERPART[src.kind])fail('VALIDATION_FAILED','The target draft is the counterpart of the source ('+COUNTERPART[src.kind]+').',{fieldErrors:[{path:'targetDraft.kind',message:COUNTERPART[src.kind]}]});
 if(input.targetDraft.currency!==src.currency)fail('VALIDATION_FAILED','Both sides carry the source currency.',{fieldErrors:[{path:'targetDraft.currency',message:src.currency}]});
 if(!(await tx.query('select 1 from lara.party where tenant_id=$1 and id=$2',[ctx.tenantId,input.targetDraft.partyId])).rowCount)fail('NOT_FOUND','Target party not found.');
 return {group,src};
}
export async function createPair(tx,ctx,entityId,input){
 requirePermission(ctx,'intercompany_pair.create');requireEntity(ctx,entityId);assertInput('IntercompanyCreate',input);
 await validatePair(tx,ctx,entityId,input);
 if((await tx.query('select 1 from lara.intercompany_pairs where tenant_id=$1 and source_document_id=$2',[ctx.tenantId,input.sourceDocumentId])).rowCount)fail('STATE_CONFLICT','This document already anchors a pair.');
 const seq=(await tx.query("select coalesce(max(substring(shared_reference from 5)::int),0)+1 as n from lara.intercompany_pairs where tenant_id=$1",[ctx.tenantId])).rows[0].n;
 const reference='ICP-'+String(seq).padStart(6,'0');
 const hash=contentHash(pairMaterial(input));
 const row=(await tx.query('insert into lara.intercompany_pairs(tenant_id,entity_id,source_entity_id,target_entity_id,source_document_id,shared_reference,target_draft,content_hash,created_by) values($1,$2,$2,$3,$4,$5,$6,$7,$8) returning *',[ctx.tenantId,entityId,input.targetEntityId,input.sourceDocumentId,reference,JSON.stringify({...input.targetDraft,externalReference:reference}),hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'intercompany_pair.create',resourceType:'intercompany_pair',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return pairResource(row);
}
// A pair is visible from either side; the target reads it under its own scope.
async function loadPair(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Intercompany pair not found.');
 const row=(await tx.query('select * from lara.intercompany_pairs where tenant_id=$1 and (source_entity_id=$2 or target_entity_id=$2) and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Intercompany pair not found.');return row;
}
export async function updatePair(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'intercompany_pair.edit');requireEntity(ctx,entityId);assertInput('IntercompanyCreate',input);
 const row=await loadPair(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.source_entity_id!==entityId)fail('FORBIDDEN','Only the source entity edits its draft pair.');
 if(row.state!=='draft')fail('STATE_CONFLICT','Only draft pairs change.');
 if(input.sourceDocumentId!==row.source_document_id)fail('VALIDATION_FAILED','A pair keeps its source document.',{fieldErrors:[{path:'sourceDocumentId',message:'Immutable'}]});
 await validatePair(tx,ctx,entityId,input);
 const hash=contentHash(pairMaterial(input));
 const updated=(await tx.query('update lara.intercompany_pairs set target_entity_id=$4,target_draft=$5,content_hash=$6,content_version=content_version+1 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,input.targetEntityId,JSON.stringify({...input.targetDraft,externalReference:row.shared_reference}),hash])).rows[0];
 await audit(tx,ctx,{entityId,action:'intercompany_pair.edit',resourceType:'intercompany_pair',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return pairResource(updated);
}
export async function getPair(tx,ctx,entityId,id){requirePermission(ctx,'intercompany_pair.read');requireEntity(ctx,entityId);return pairResource(await loadPair(tx,ctx,entityId,id));}
export async function listPairs(tx,ctx,entityId,query){
 requirePermission(ctx,'intercompany_pair.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.status){params.push(String(query.status).split(','));where+=' and state=any($'+params.length+'::text[])';}
 return page((await tx.query('select * from lara.intercompany_pairs where tenant_id=$1 and (source_entity_id=$2 or target_entity_id=$2)'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,pairResource,scope);
}
export async function listPairDetails(tx,ctx,entityId,query){const r=await listPairs(tx,ctx,entityId,query);const ids=r.items.map(i=>i.id);const rows=ids.length?(await tx.query('select * from lara.intercompany_pairs where tenant_id=$1 and id=any($2::uuid[])',[ctx.tenantId,ids])).rows:[];return {items:ids.map(id=>pairDetail(rows.find(x=>x.id===id))),nextCursor:r.nextCursor};}
// Acceptance in the target entity under its own authority: the target
// draft becomes that entity's own document (its preparer is the accepter;
// its approval and posting follow the entity's normal maker-checker).
export async function acceptPair(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'intercompany_pair.accept');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadPair(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.target_entity_id!==entityId)fail('FORBIDDEN','The target entity accepts the pair; the source entity raised it.');
 if(row.state!=='draft')fail('STATE_CONFLICT','Pair is '+row.state+'.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The pair changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'){
  if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
  const rej=(await tx.query("update lara.intercompany_pairs set state='rejected',exception_reason=$3,decided_by=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.reason,ctx.principalId])).rows[0];
  await audit(tx,ctx,{entityId,action:'intercompany_pair.reject',resourceType:'intercompany_pair',resourceId:id,resourceVersion:Number(rej.version),reason:input.reason});
  return {resourceType:'intercompany_pair',resourceId:id,version:Number(rej.version),state:'rejected'};
 }
 // Acceptance is the authority that prepares the target draft in the accepter's name; its submission, approval and posting follow the entity's own maker-checker, so the accepter never approves it.
 const module=row.target_draft.kind==='bill'?purchasing:sales;
 const preparer={...ctx,permissions:new Set([...ctx.permissions,row.target_draft.kind+'.prepare'])};
 const doc=await module.createDocument(tx,preparer,entityId,row.target_draft);
 const src=(await tx.query('select gross from lara.documents where tenant_id=$1 and id=$2',[ctx.tenantId,row.source_document_id])).rows[0];
 let updated=(await tx.query("update lara.intercompany_pairs set state='accepted',target_document_id=$3,decided_by=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,doc.id,ctx.principalId])).rows[0];
 let state='accepted';
 if(micros(String(src.gross))!==micros(String(doc.gross))){
  state='exception';
  updated=(await tx.query("update lara.intercompany_pairs set state='exception',exception_reason=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,'Gross differs: source '+money(src.gross)+', target '+money(doc.gross)+'.'])).rows[0];
 }
 await audit(tx,ctx,{entityId,action:'intercompany_pair.accept',resourceType:'intercompany_pair',resourceId:id,resourceVersion:Number(updated.version),afterRef:doc.id,reason:input.reason||null});
 await emit(tx,ctx,{entityId,aggregateType:'intercompany_pair',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'consolidation.pair_accepted.v1',payload:{pairId:id,targetDocumentId:doc.id,state}});
 return {resourceType:'intercompany_pair',resourceId:id,version:Number(updated.version),state,targetDocumentId:doc.id};
}
// Posting one side under that entity's authority. The side that posts stays
// posted whatever happens to the other; a failure on the second side is
// recorded as the pair's exception, never rolled back into the first.
export async function postPair(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'intercompany_pair.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadPair(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['accepted','exception'].includes(row.state))fail('STATE_CONFLICT','Pair is '+row.state+'; both sides post after acceptance.');
 const side=row.source_entity_id===entityId?'source':'target';
 if(side==='target'&&!row.target_document_id)fail('STATE_CONFLICT','The target side has no accepted document.');
 if(row[side+'_posted_at'])return {resourceType:'intercompany_pair',resourceId:id,version:Number(row.version),state:row.state,side,alreadyPosted:true};
 const docId=side==='source'?row.source_document_id:row.target_document_id;
 const kind=(await tx.query('select kind from lara.documents where tenant_id=$1 and id=$2',[ctx.tenantId,docId])).rows[0].kind;
 const module=kind==='bill'?purchasing:sales;
 await tx.query('savepoint icp_side');
 let outcome;
 try{
  const r=await module.postDocument(tx,ctx,entityId,docId,{},undefined,{commandId});
  await tx.query('release savepoint icp_side');
  outcome={ok:true,journalEntryIds:r.journalEntryIds||[]};
 }catch(e){
  await tx.query('rollback to savepoint icp_side');
  if(!(e instanceof DomainError))throw e;
  outcome={ok:false,reason:e.code+': '+e.message};
 }
 let updated;
 if(outcome.ok){
  const other=side==='source'?row.target_posted_at:row.source_posted_at;
  // A side that posts clears the exception it caused; the pair completes when both sides are posted.
  const state=other?'posted':'accepted';
  updated=(await tx.query('update lara.intercompany_pairs set '+side+'_posted_at=now(),state=$3,exception_reason=null where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,state])).rows[0];
  if(state==='posted')await emit(tx,ctx,{entityId,aggregateType:'intercompany_pair',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'consolidation.pair_posted.v1',payload:{pairId:id,sharedReference:row.shared_reference}});
 }else{
  updated=(await tx.query("update lara.intercompany_pairs set state='exception',exception_reason=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,side+' side: '+outcome.reason])).rows[0];
 }
 await audit(tx,ctx,{entityId,action:'intercompany_pair.post',resourceType:'intercompany_pair',resourceId:id,resourceVersion:Number(updated.version),reason:outcome.ok?side+' side posted':outcome.reason});
 return {resourceType:'intercompany_pair',resourceId:id,version:Number(updated.version),state:updated.state,side,journalEntryIds:outcome.ok?outcome.journalEntryIds:[],...(outcome.ok?{}:{exceptionReason:updated.exception_reason})};
}

// ---------------------------------------------------------------------------
// Consolidation runs
// ---------------------------------------------------------------------------
const runResource=r=>({id:r.id,version:Number(r.version),contentVersion:Number(r.content_version),state:r.state,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false,groupId:r.group_id,periodEnd:iso(r.period_end),memberSnapshotIds:r.member_snapshot_ids,rateSetId:r.rate_set_id,mappingVersion:r.mapping_version});
export const runDetail=r=>({...runResource(r),versionNumber:r.version_number,resultHash:r.result_hash,unresolvedCount:r.unresolved_count,approvedBy:r.approved_by,publishedSnapshotId:r.published_snapshot_id,publishedAt:iso(r.published_at)});
const runMaterial=i=>({groupId:i.groupId,periodEnd:i.periodEnd,memberSnapshotIds:[...i.memberSnapshotIds].sort(),rateSetId:i.rateSetId,mappingVersion:i.mappingVersion});
// The inputs of a run are validated as a whole: an active group of this
// entity, one approved statements snapshot per member whose period is
// frozen (soft-closed or locked), an approved rate set for the period end
// covering every member currency, an approved mapping version.
async function validateRun(tx,ctx,entityId,input){
 const group=await loadGroup(tx,ctx,entityId,input.groupId);
 if(group.state!=='active')fail('STATE_CONFLICT','The group is not active.');
 const members=(await membersOf(tx,ctx,group.id)).filter(m=>iso(m.effective_from)<=input.periodEnd&&(!m.effective_to||iso(m.effective_to)>=input.periodEnd));
 if(!members.length)fail('STATE_CONFLICT','No member is effective at the period end.');
 const ids=[...new Set(input.memberSnapshotIds)];
 if(ids.length!==input.memberSnapshotIds.length)fail('VALIDATION_FAILED','Snapshots are listed once.',{fieldErrors:[{path:'memberSnapshotIds',message:'Duplicate'}]});
 const snaps=(await tx.query("select s.*,b.functional_currency,e.legal_name from lara.report_snapshots s join lara.books b on b.tenant_id=s.tenant_id and b.id=s.book_id join lara.entities e on e.tenant_id=s.tenant_id and e.id=s.entity_id where s.tenant_id=$1 and s.id=any($2::uuid[])",[ctx.tenantId,ids])).rows;
 if(snaps.length!==ids.length)fail('NOT_FOUND','A member snapshot was not found.');
 const key=dateKey(input.periodEnd);
 const covered=new Set();
 for(const s of snaps){
  if(s.report_type!=='statements')fail('VALIDATION_FAILED','Member snapshots are statements snapshots.',{fieldErrors:[{path:'memberSnapshotIds',message:s.id+' is '+s.report_type}]});
  if(!members.some(m=>m.entity_id===s.entity_id))fail('VALIDATION_FAILED','Snapshot '+s.id+' belongs to an entity outside the group.',{fieldErrors:[{path:'memberSnapshotIds',message:'Not a member'}]});
  if(s.period_key!==key||s.parameters.periodEnd!==input.periodEnd)fail('VALIDATION_FAILED','Snapshot '+s.id+' is not for the period ending '+input.periodEnd+'.',{fieldErrors:[{path:'memberSnapshotIds',message:'Period differs'}]});
  if(covered.has(s.entity_id))fail('VALIDATION_FAILED','One snapshot per member.',{fieldErrors:[{path:'memberSnapshotIds',message:'Two for '+s.entity_id}]});covered.add(s.entity_id);
  const period=(await tx.query('select status from lara.periods where tenant_id=$1 and entity_id=$2 and book_id=$3 and $4 between starts_on and ends_on',[ctx.tenantId,s.entity_id,s.book_id,input.periodEnd])).rows[0];
  if(!period||period.status==='open')fail('STATE_CONFLICT','Member '+s.legal_name+' has not frozen its close for '+input.periodEnd+' (soft-close or lock the period first).');
 }
 const missing=members.filter(m=>!covered.has(m.entity_id));
 if(missing.length)fail('VALIDATION_FAILED','Every effective member needs a snapshot; missing: '+missing.map(m=>m.entity_id).join(', ')+'.',{fieldErrors:[{path:'memberSnapshotIds',message:'Members missing'}]});
 const rateSet=await loadRateSet(tx,ctx,entityId,input.rateSetId);
 if(rateSet.state!=='approved')fail('RULE_PROFILE_NOT_APPROVED','The rate set is not approved.');
 if(iso(rateSet.period_end)!==input.periodEnd)fail('VALIDATION_FAILED','The rate set is for '+iso(rateSet.period_end)+'.',{fieldErrors:[{path:'rateSetId',message:'Period differs'}]});
 for(const s of snaps){
  if(s.functional_currency===group.reporting_currency)continue;
  if(rateSet.income_policy==='transaction_rate')fail('FEATURE_NOT_ENABLED','Transaction-rate translation of income arrives with an approved extension; this release translates income at the approved period average.');
  if(!rateSet.rates.some(r=>r.currency===s.functional_currency))fail('VALIDATION_FAILED','The rate set has no rate for '+s.functional_currency+'.',{fieldErrors:[{path:'rateSetId',message:'Missing '+s.functional_currency}]});
 }
 const mapping=await approvedMapping(tx,ctx,group.id,input.mappingVersion);
 return {group,members,snaps,rateSet,mapping};
}
// Member-close readiness for a period end: what a run would consume.
export async function readiness(tx,ctx,entityId,groupId,{periodEnd}){
 requirePermission(ctx,'consolidation.read');requireEntity(ctx,entityId);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(periodEnd||'')))fail('VALIDATION_FAILED','periodEnd is a date.',{fieldErrors:[{path:'periodEnd',message:'YYYY-MM-DD'}]});
 const group=await loadGroup(tx,ctx,entityId,groupId);
 const members=(await membersOf(tx,ctx,groupId)).filter(m=>iso(m.effective_from)<=periodEnd&&(!m.effective_to||iso(m.effective_to)>=periodEnd));
 const rateSets=(await tx.query('select id,code,state,rates from lara.consolidation_rate_sets where tenant_id=$1 and entity_id=$2 and period_end=$3 order by created_at',[ctx.tenantId,entityId,periodEnd])).rows;
 const out=[];
 for(const m of members){
  const e=(await tx.query("select e.legal_name,b.id as book_id,b.functional_currency from lara.entities e join lara.books b on b.tenant_id=e.tenant_id and b.entity_id=e.id and b.kind='primary' and b.status<>'archived' where e.tenant_id=$1 and e.id=$2",[ctx.tenantId,m.entity_id])).rows[0];
  if(!e){out.push({entityId:m.entity_id,entityName:m.entity_id,currency:group.reporting_currency,periodStatus:null,snapshotId:null,snapshotVersion:null,checksum:null,rateCovered:false,ready:false});continue;}
  const period=(await tx.query('select status from lara.periods where tenant_id=$1 and entity_id=$2 and book_id=$3 and $4 between starts_on and ends_on',[ctx.tenantId,m.entity_id,e.book_id,periodEnd])).rows[0];
  const snap=(await tx.query("select id,version_number,checksum from lara.report_snapshots where tenant_id=$1 and entity_id=$2 and book_id=$3 and report_type='statements' and period_key=$4 and parameters->>'periodEnd'=$5 order by version_number desc limit 1",[ctx.tenantId,m.entity_id,e.book_id,dateKey(periodEnd),periodEnd])).rows[0];
  const rateCovered=e.functional_currency===group.reporting_currency||rateSets.some(r=>r.state==='approved'&&r.rates.some(x=>x.currency===e.functional_currency));
  out.push({entityId:m.entity_id,entityName:e.legal_name,currency:e.functional_currency,periodStatus:period?.status||null,snapshotId:snap?.id||null,snapshotVersion:snap?.version_number??null,checksum:snap?.checksum||null,rateCovered,ready:!!snap&&!!period&&period.status!=='open'&&rateCovered});
 }
 const mappings=(await tx.query("select id,mapping_version,state from lara.group_mapping_versions where tenant_id=$1 and group_id=$2 and state='approved' order by created_at",[ctx.tenantId,groupId])).rows;
 return {groupId,periodEnd,reportingCurrency:group.reporting_currency,members:out,rateSets:rateSets.map(r=>({id:r.id,code:r.code,state:r.state})),mappingVersions:mappings.map(v=>({id:v.id,mappingVersion:v.mapping_version,state:v.state}))};
}
export async function createRun(tx,ctx,entityId,input){
 requirePermission(ctx,'consolidation.create');requireEntity(ctx,entityId);assertInput('ConsolidationCreate',input);await requireGroupAccounting(tx,ctx,entityId);
 const {group}=await validateRun(tx,ctx,entityId,input);
 const version=((await tx.query('select coalesce(max(version_number),0)::int v from lara.consolidation_runs where tenant_id=$1 and group_id=$2 and period_end=$3',[ctx.tenantId,group.id,input.periodEnd])).rows[0].v)+1;
 const hash=contentHash(runMaterial(input));
 const row=(await tx.query('insert into lara.consolidation_runs(tenant_id,entity_id,group_id,period_end,version_number,member_snapshot_ids,rate_set_id,mapping_version,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,group.id,input.periodEnd,version,input.memberSnapshotIds,input.rateSetId,input.mappingVersion,hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'consolidation.create',resourceType:'consolidation_run',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return runResource(row);
}
async function loadRun(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Consolidation run not found.');
 const row=(await tx.query('select * from lara.consolidation_runs where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Consolidation run not found.');return row;
}
export async function updateRun(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'consolidation.edit');requireEntity(ctx,entityId);assertInput('ConsolidationCreate',input);
 const row=await loadRun(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','previewed'].includes(row.state))fail('STATE_CONFLICT','An approved run keeps its inputs; start a new run.');
 if(input.groupId!==row.group_id||input.periodEnd!==iso(row.period_end))fail('VALIDATION_FAILED','A run keeps its group and period end.',{fieldErrors:[{path:'periodEnd',message:'Immutable'}]});
 await validateRun(tx,ctx,entityId,input);
 const hash=contentHash(runMaterial(input));
 const updated=(await tx.query("update lara.consolidation_runs set member_snapshot_ids=$4,rate_set_id=$5,mapping_version=$6,content_hash=$7,content_version=content_version+1,state='draft',result=null,result_hash=null,unresolved_count=0 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,input.memberSnapshotIds,input.rateSetId,input.mappingVersion,hash])).rows[0];
 await audit(tx,ctx,{entityId,action:'consolidation.edit',resourceType:'consolidation_run',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return runResource(updated);
}
export async function getRun(tx,ctx,entityId,id){requirePermission(ctx,'consolidation.read');requireEntity(ctx,entityId);return runResource(await loadRun(tx,ctx,entityId,id));}
export async function listRuns(tx,ctx,entityId,query){
 requirePermission(ctx,'consolidation.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.consolidation_runs where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,runResource,scope);
}
export async function listRunDetails(tx,ctx,entityId,query){const r=await listRuns(tx,ctx,entityId,query);const ids=r.items.map(i=>i.id);const rows=ids.length?(await tx.query('select * from lara.consolidation_runs where tenant_id=$1 and id=any($2::uuid[])',[ctx.tenantId,ids])).rows:[];return {items:ids.map(id=>runDetail(rows.find(x=>x.id===id))),nextCursor:r.nextCursor};}

// Deterministic worksheet from the run's inputs alone. Amounts travel as
// signed micros (debit positive) until presentation.
function ratesFor(rateSet,currency,reporting){
 if(currency===reporting)return {closing:ONE,average:ONE,historical:ONE,text:{closing:'1',average:'1',historical:'1'}};
 const r=rateSet.rates.find(x=>x.currency===currency);
 return {closing:rateScaled(r.closing),average:rateScaled(r.average),historical:rateScaled(r.historical),text:{closing:r.closing,average:r.average,historical:r.historical}};
}
const policyFor=category=>category==='equity'?'historical':['income','expense'].includes(category)?'average':'closing';
const policyLabel={closing:'closing',average:'period_average',historical:'historical'};
export async function computeWorksheet(tx,ctx,entityId,run){
 const group=await loadGroup(tx,ctx,entityId,run.group_id);
 const rateSet=await loadRateSet(tx,ctx,entityId,run.rate_set_id);
 const mapping=await approvedMapping(tx,ctx,group.id,run.mapping_version);
 const periodEnd=iso(run.period_end);
 const snaps=(await tx.query("select s.*,b.functional_currency,e.legal_name from lara.report_snapshots s join lara.books b on b.tenant_id=s.tenant_id and b.id=s.book_id join lara.entities e on e.tenant_id=s.tenant_id and e.id=s.entity_id where s.tenant_id=$1 and s.id=any($2::uuid[]) order by e.legal_name,s.id",[ctx.tenantId,run.member_snapshot_ids])).rows;
 const mapOf=(entity,accountId)=>mapping.entries.find(e=>e.member_entity_id===entity&&e.account_id===accountId);
 const roleOf=(entity,role)=>mapping.entries.find(e=>e.member_entity_id===entity&&e.role===role);
 const units=(await tx.query('select minor_units from lara.currency_metadata where code=$1',[group.reporting_currency])).rows[0]?.minor_units??2;
 const groupLines=new Map();const unmapped=[];const translation=[];const members=[];const differences=[];
 const lineOf=(code,name,category)=>{if(!groupLines.has(code))groupLines.set(code,{groupAccountCode:code,groupAccountName:name,groupCategory:category,members:new Map(),eliminations:0n,translation:0n});return groupLines.get(code);};
 const add=(code,name,category,entity,amount)=>{const l=lineOf(code,name,category);l.members.set(entity,(l.members.get(entity)||0n)+amount);};
 const reserveCode=group.translation_reserve_code;
 for(const s of snaps){
  const rates=ratesFor(rateSet,s.functional_currency,group.reporting_currency);
  const payload=s.payload;
  const lines=[...payload.lines];
  // Prior-period earnings sit in equity at the historical rate: cumulative earnings less the period's result.
  const prior=signedMicros(payload.balanceSheet.currentEarnings)-signedMicros(payload.incomeStatement.netIncome);
  if(prior!==0n)lines.push({accountId:null,code:'RE',name:'Retained earnings (prior periods)',category:'equity',balance:decimal(prior,6)});
  const sums={balance_sheet:0n,income:0n,equity:0n};
  const out=[];
  // Snapshot balances are positive on the account's normal side; the worksheet works in signed debit-minus-credit micros.
  for(const l of lines){
   const bal=['asset','expense'].includes(l.category)?signedMicros(l.balance):-signedMicros(l.balance);
   const policy=policyFor(l.category);
   const rate=rates[policy];
   const translated=convert(bal,rate,units);
   const source=l.category==='equity'?'equity':['income','expense'].includes(l.category)?'income':'balance_sheet';
   sums[source]+=translated;
   // Prior-period earnings go to the member's retained earnings mapping when one is named, else to the group's own retained earnings line.
   const m=l.accountId?mapOf(s.entity_id,l.accountId):(roleOf(s.entity_id,'retained_earnings')||{group_account_code:'RE',group_account_name:'Retained earnings (prior periods)',group_category:'equity'});
   if(!m){if(bal!==0n)unmapped.push({entityId:s.entity_id,accountId:l.accountId,code:l.code,name:l.name});}
   else add(m.group_account_code,m.group_account_name,m.group_category,s.entity_id,translated);
   out.push({accountId:l.accountId,code:l.code,name:l.name,category:l.category,balance:decimal(bal,2),groupAccountCode:m?m.group_account_code:null,rate:rates.text[policy],translated:decimal(translated,2)});
  }
  const residual=sums.balance_sheet+sums.income+sums.equity;
  for(const [source,policy] of [['balance_sheet','closing'],['income','average'],['equity','historical']])translation.push({memberEntityId:s.entity_id,source,policy:policyLabel[policy],currency:s.functional_currency,rate:rates.text[policy],amount:decimal(sums[source],2)});
  if(residual!==0n){const l=lineOf(reserveCode,'Translation reserve','equity');l.translation-=residual;}
  members.push({entityId:s.entity_id,entityName:s.legal_name,snapshotId:s.id,currency:s.functional_currency,periodKey:s.period_key,lines:out});
 }
 // Eliminations from pairs posted on both sides between members: the
 // reciprocal receivable and payable still outstanding at the cutoff (any
 // pair dated up to the period end) and, for pairs dated in the period, the
 // intra-group revenue and expense from the posted journal lines — each
 // eliminated once. A difference between the two sides in the transaction
 // currency stays unresolved; a difference that only the rates cause goes
 // to the translation reserve with the rest of the translation.
 const eliminations=[];
 const memberIds=snaps.map(s=>s.entity_id);
 const periodStart=snaps[0]?.parameters?.periodStart||periodEnd.slice(0,8)+'01';
 const cutoff=snaps.reduce((m,s)=>m&&m<s.cutoff_posted_at?m:s.cutoff_posted_at,null);
 const pairs=(await tx.query("select p.*,ds.accounting_date,ds.net as source_net,dt.net as target_net,ds.currency,ds.posted_entry_id as source_entry,dt.posted_entry_id as target_entry from lara.intercompany_pairs p join lara.documents ds on ds.tenant_id=p.tenant_id and ds.id=p.source_document_id left join lara.documents dt on dt.tenant_id=p.tenant_id and dt.id=p.target_document_id where p.tenant_id=$1 and p.source_entity_id=any($2::uuid[]) and p.target_entity_id=any($2::uuid[]) and ds.accounting_date<=$3 and p.state<>'rejected' order by p.shared_reference",[ctx.tenantId,memberIds,periodEnd])).rows;
 const pairExceptions=[];
 const entryLines=async(entity,entryId)=>(await tx.query("select l.account_id,a.category,a.control_type,l.txn_debit,l.txn_credit,l.func_debit,l.func_credit from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entity_id=$2 and l.entry_id=$3 order by l.line_no",[ctx.tenantId,entity,entryId])).rows;
 const outstanding=async(entity,documentId)=>{const r=(await tx.query("select i.original_amount-coalesce((select sum(case when e.action='apply' then e.amount else -e.amount end) from lara.allocation_events e where e.tenant_id=i.tenant_id and e.open_item_id=i.id and e.created_at<=$3),0) as open from lara.open_items i where i.tenant_id=$1 and i.entity_id=$2 and i.document_id=$4",[ctx.tenantId,entity,cutoff,documentId])).rows[0];return r?micros(String(r.open<0?0:r.open)):0n;};
 for(const p of pairs){
  if(p.state!=='posted'){pairExceptions.push({pairId:p.id,sharedReference:p.shared_reference,state:p.state,reason:p.exception_reason||(p.state==='draft'?'Awaiting acceptance by the target entity.':'Awaiting posting on both sides.')});continue;}
  const srcRates=ratesFor(rateSet,snaps.find(s=>s.entity_id===p.source_entity_id).functional_currency,group.reporting_currency);
  const tgtRates=ratesFor(rateSet,snaps.find(s=>s.entity_id===p.target_entity_id).functional_currency,group.reporting_currency);
  const srcLines=await entryLines(p.source_entity_id,p.source_entry),tgtLines=await entryLines(p.target_entity_id,p.target_entry);
  const lines=[];let debit=0n,credit=0n,txnDebit=0n,txnCredit=0n;let missing=false;
  const push=(m,amount,side)=>{lines.push({groupAccountCode:m.group_account_code,debit:side==='debit'?decimal(amount,2):'0.00',credit:side==='credit'?decimal(amount,2):'0.00'});lineOf(m.group_account_code).eliminations+=side==='debit'?amount:-amount;if(side==='debit')debit+=amount;else credit+=amount;};
  // Balances: the control line of each side scaled to what is still outstanding at the cutoff.
  const control=(ls,type)=>ls.find(l=>l.control_type===type&&(micros(String(l.txn_debit))+micros(String(l.txn_credit)))>0n);
  const srcControl=control(srcLines,'ar')||control(srcLines,'ap'),tgtControl=control(tgtLines,'ap')||control(tgtLines,'ar');
  const srcOpen=await outstanding(p.source_entity_id,p.source_document_id),tgtOpen=await outstanding(p.target_entity_id,p.target_document_id);
  const funcOf=(l,txnOpen)=>{const txn=micros(String(l.txn_debit))+micros(String(l.txn_credit)),func=micros(String(l.func_debit))+micros(String(l.func_credit));return txn===0n?0n:func*txnOpen/txn;};
  if(srcControl&&tgtControl&&(srcOpen>0n||tgtOpen>0n)){
   const sm=mapOf(p.source_entity_id,srcControl.account_id),tm=mapOf(p.target_entity_id,tgtControl.account_id);
   if(!sm||!tm)missing=true;
   else{
    const srcAmt=convert(funcOf(srcControl,srcOpen),srcRates.closing,units),tgtAmt=convert(funcOf(tgtControl,tgtOpen),tgtRates.closing,units);
    const srcIsDebit=micros(String(srcControl.txn_debit))>0n;
    push(sm,srcAmt,srcIsDebit?'credit':'debit');push(tm,tgtAmt,srcIsDebit?'debit':'credit');
    txnDebit+=srcOpen;txnCredit+=tgtOpen;
   }
  }
  // Revenue and expense of pairs dated in the period.
  if(iso(p.accounting_date)>=periodStart){
   for(const l of srcLines){if(!['income','expense'].includes(l.category))continue;const m=mapOf(p.source_entity_id,l.account_id);if(!m){missing=true;continue;}const txn=micros(String(l.txn_credit))-micros(String(l.txn_debit));const amount=convert(micros(String(l.func_credit))-micros(String(l.func_debit)),srcRates.average,units);push(m,amount<0n?-amount:amount,amount<0n?'credit':'debit');txnDebit+=txn<0n?-txn:txn;}
   for(const l of tgtLines){if(!['income','expense'].includes(l.category))continue;const m=mapOf(p.target_entity_id,l.account_id);if(!m){missing=true;continue;}const txn=micros(String(l.txn_debit))-micros(String(l.txn_credit));const amount=convert(micros(String(l.func_debit))-micros(String(l.func_credit)),tgtRates.average,units);push(m,amount<0n?-amount:amount,amount<0n?'debit':'credit');txnCredit+=txn<0n?-txn:txn;}
  }
  let difference=debit-credit;
  if(txnDebit===txnCredit&&difference!==0n){const l=lineOf(reserveCode,'Translation reserve','equity');l.translation-=difference;difference=0n;}
  eliminations.push({id:null,runId:run.id,kind:'pair',pairId:p.id,lines,amount:decimal(debit,2),difference:decimal(difference,2),reason:'Intercompany pair '+p.shared_reference,evidenceIds:[],createdAt:null});
  if(difference!==0n)differences.push({source:'pair '+p.shared_reference,amount:decimal(difference,2),detail:'The two sides differ in '+p.currency+' (source '+decimal(txnDebit,2)+', target '+decimal(txnCredit,2)+').'});
  if(missing)differences.push({source:'pair '+p.shared_reference,amount:'0.00',detail:'A journal line of the pair maps to no group account.'});
 }
 // Manual eliminations recorded on the run.
 for(const m of (await tx.query('select * from lara.elimination_entries where tenant_id=$1 and run_id=$2 and kind=$3 order by created_at,id',[ctx.tenantId,run.id,'manual'])).rows){
  let debit=0n,credit=0n;
  for(const l of m.lines){const line=groupLines.get(l.groupAccountCode);if(!line){differences.push({source:'manual elimination',amount:'0.00',detail:'Group account '+l.groupAccountCode+' has no member balance.'});continue;}const d=micros(l.debit),c=micros(l.credit);line.eliminations+=d-c;debit+=d;credit+=c;}
  const difference=debit-credit;
  eliminations.push({id:m.id,runId:run.id,kind:'manual',pairId:null,lines:m.lines,amount:decimal(debit,2),difference:decimal(difference,2),reason:m.reason,evidenceIds:m.evidence_ids,createdAt:iso(m.created_at)});
  if(difference!==0n)differences.push({source:'manual elimination',amount:decimal(difference,2),detail:m.reason});
 }
 for(const u of unmapped)differences.push({source:'unmapped',amount:'0.00',detail:'Account '+u.code+' of '+u.entityId+' maps to no group account.'});
 const lines=[...groupLines.values()].sort((a,b)=>a.groupAccountCode<b.groupAccountCode?-1:a.groupAccountCode>b.groupAccountCode?1:0).map(l=>{const memberSum=[...l.members.values()].reduce((s,v)=>s+v,0n);const consolidated=memberSum+l.eliminations+l.translation;return {groupAccountCode:l.groupAccountCode,groupAccountName:l.groupAccountName,groupCategory:l.groupCategory,members:[...l.members.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([entityId,amount])=>({entityId,amount:decimal(amount,2)})),eliminations:decimal(l.eliminations,2),translation:decimal(l.translation,2),consolidated:decimal(consolidated,2),_c:consolidated};});
 const cat=c=>lines.filter(l=>l.groupCategory===c).reduce((s,l)=>s+l._c,0n);
 const assets=cat('asset'),liabilities=-cat('liability'),equity=-cat('equity'),income=-cat('income'),expense=cat('expense');
 const reserve=lines.find(l=>l.groupAccountCode===reserveCode);
 const totals={assets:decimal(assets,2),liabilities:decimal(liabilities,2),equity:decimal(equity,2),income:decimal(income,2),expense:decimal(expense,2),netIncome:decimal(income-expense,2),translationReserve:decimal(reserve?-reserve._c:0n,2),balanced:assets===liabilities+equity+income-expense};
 for(const l of lines)delete l._c;
 const result={runId:run.id,state:run.state,reportingCurrency:group.reporting_currency,periodEnd,resultHash:null,members,translation,eliminations,unmapped,pairExceptions,differences,lines,totals};
 const hashed={memberSnapshotIds:[...run.member_snapshot_ids].sort(),mappingHash:mapping.version.content_hash,rateSetHash:rateSet.content_hash,translation,eliminations:eliminations.map(e=>({kind:e.kind,pairId:e.pairId,lines:e.lines,difference:e.difference,reason:e.reason})),lines,totals,differences,pairExceptions:pairExceptions.map(p=>p.pairId),unmapped};
 result.resultHash=sha(canonical(hashed));
 return result;
}
export async function previewRun(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'consolidation.preview');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadRun(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','previewed'].includes(row.state))fail('STATE_CONFLICT','Run is '+row.state+'.');
 const ws=await computeWorksheet(tx,ctx,entityId,row);
 const unresolved=ws.differences.length+ws.pairExceptions.length;
 await tx.query("delete from lara.elimination_entries where tenant_id=$1 and run_id=$2 and kind='pair'",[ctx.tenantId,id]);
 await tx.query('delete from lara.translation_adjustments where tenant_id=$1 and run_id=$2',[ctx.tenantId,id]);
 for(const e of ws.eliminations.filter(e=>e.kind==='pair'))await tx.query('insert into lara.elimination_entries(tenant_id,entity_id,run_id,kind,pair_id,lines,amount,difference,reason,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[ctx.tenantId,entityId,id,'pair',e.pairId,JSON.stringify(e.lines),e.amount,e.difference,e.reason,ctx.principalId]);
 for(const t of ws.translation)await tx.query('insert into lara.translation_adjustments(tenant_id,entity_id,run_id,member_entity_id,source,policy,currency,rate,amount) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.tenantId,entityId,id,t.memberEntityId,t.source,t.policy,t.currency,t.rate,t.amount]);
 const updated=(await tx.query("update lara.consolidation_runs set state='previewed',result=$4,result_hash=$5,unresolved_count=$6 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,JSON.stringify({...ws,state:'previewed'}),ws.resultHash,unresolved])).rows[0];
 await audit(tx,ctx,{entityId,action:'consolidation.preview',resourceType:'consolidation_run',resourceId:id,resourceVersion:Number(updated.version),afterRef:ws.resultHash,reason:unresolved?unresolved+' unresolved':null});
 return {resourceType:'consolidation_run',resourceId:id,version:Number(updated.version),state:'previewed',resultHash:ws.resultHash,unresolvedCount:unresolved,balanced:ws.totals.balanced};
}
export async function worksheet(tx,ctx,entityId,id){
 requirePermission(ctx,'consolidation.read');requireEntity(ctx,entityId);
 const row=await loadRun(tx,ctx,entityId,id);
 if(row.result)return {...row.result,state:row.state};
 return computeWorksheet(tx,ctx,entityId,row);
}
export async function addElimination(tx,ctx,entityId,id,input){
 requirePermission(ctx,'consolidation.edit');requireEntity(ctx,entityId);assertInput('EliminationCreate',input);
 const row=await loadRun(tx,ctx,entityId,id,{lock:true});
 if(!['draft','previewed'].includes(row.state))fail('STATE_CONFLICT','An approved run takes no further eliminations; start a new run.');
 let debit=0n,credit=0n;
 for(const [i,l] of input.lines.entries()){const d=micros(l.debit),c=micros(l.credit);if((d>0n)===(c>0n))fail('VALIDATION_FAILED','Each line is a debit or a credit.',{fieldErrors:[{path:'lines['+i+']',message:'One side'}]});debit+=d;credit+=c;}
 const entry=(await tx.query('insert into lara.elimination_entries(tenant_id,entity_id,run_id,kind,lines,amount,difference,reason,evidence_ids,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,id,'manual',JSON.stringify(input.lines),decimal(debit,6),decimal(debit-credit,6),input.reason,JSON.stringify(input.evidenceIds),ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'elimination_entry',entry.id,1);
 // The stored preview no longer reflects the run: it returns to draft until previewed again.
 if(row.state==='previewed')await tx.query("update lara.consolidation_runs set state='draft',result=null,result_hash=null,unresolved_count=0 where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,id]);
 await audit(tx,ctx,{entityId,action:'consolidation.elimination',resourceType:'elimination_entry',resourceId:entry.id,resourceVersion:1,reason:input.reason});
 return {id:entry.id,runId:id,kind:'manual',pairId:null,lines:input.lines,amount:decimal(debit,2),difference:decimal(debit-credit,2),reason:input.reason,evidenceIds:input.evidenceIds,createdAt:iso(entry.created_at)};
}
export async function approveRun(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'consolidation.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadRun(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='previewed')fail('STATE_CONFLICT','Preview the run before deciding it.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who prepared the run cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The run changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'){
  if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
  const rej=(await tx.query("update lara.consolidation_runs set state='rejected' where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id])).rows[0];
  await audit(tx,ctx,{entityId,action:'consolidation.reject',resourceType:'consolidation_run',resourceId:id,resourceVersion:Number(rej.version),reason:input.reason});
  return {resourceType:'consolidation_run',resourceId:id,version:Number(rej.version),state:'rejected'};
 }
 if(row.unresolved_count>0)fail('STATE_CONFLICT','The run carries '+row.unresolved_count+' unresolved difference(s) or pair exception(s); resolve them, never plug them.');
 if(!row.result.totals.balanced)fail('STATE_CONFLICT','The consolidated statements do not balance.');
 const updated=(await tx.query("update lara.consolidation_runs set state='approved',approved_by=$4,approved_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'consolidation.approve',resourceType:'consolidation_run',resourceId:id,resourceVersion:Number(updated.version),afterRef:row.result_hash,reason:input.reason||null});
 return {resourceType:'consolidation_run',resourceId:id,version:Number(updated.version),state:'approved'};
}
// Publishing writes the consolidated statements as an immutable report
// snapshot in the group's book and supersedes the earlier published run
// for the same group and period end.
export async function publishRun(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'consolidation.publish');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadRun(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='approved')fail('STATE_CONFLICT','Only approved runs publish.');
 const group=await loadGroup(tx,ctx,entityId,row.group_id);
 const periodKey=dateKey(iso(row.period_end));
 const version=((await tx.query("select coalesce(max(version_number),0)::int v from lara.report_snapshots where tenant_id=$1 and entity_id=$2 and book_id=$3 and report_type='consolidated_statements' and period_key=$4",[ctx.tenantId,entityId,group.book_id,periodKey])).rows[0].v)+1;
 const snap=(await tx.query("insert into lara.report_snapshots(tenant_id,entity_id,book_id,report_type,period_key,version_number,cutoff_posted_at,rule_version,parameters,payload,checksum,created_by) values($1,$2,$3,'consolidated_statements',$4,$5,now(),'p15.1',$6,$7,$8,$9) returning id",[ctx.tenantId,entityId,group.book_id,periodKey,version,JSON.stringify({runId:id,groupId:group.id,periodEnd:iso(row.period_end),memberSnapshotIds:row.member_snapshot_ids,rateSetId:row.rate_set_id,mappingVersion:row.mapping_version}),JSON.stringify(row.result),row.result_hash,ctx.principalId])).rows[0];
 const prior=(await tx.query("update lara.consolidation_runs set state='superseded' where tenant_id=$1 and group_id=$2 and period_end=$3 and state='published' and id<>$4 returning id",[ctx.tenantId,group.id,row.period_end,id])).rows;
 const updated=(await tx.query("update lara.consolidation_runs set state='published',published_snapshot_id=$4,published_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,snap.id])).rows[0];
 await audit(tx,ctx,{entityId,action:'consolidation.publish',resourceType:'consolidation_run',resourceId:id,resourceVersion:Number(updated.version),afterRef:snap.id,reason:prior.length?'supersedes '+prior.map(p=>p.id).join(','):null});
 await emit(tx,ctx,{entityId,aggregateType:'consolidation_run',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'consolidation.published.v1',payload:{runId:id,groupId:group.id,periodEnd:iso(row.period_end),snapshotId:snap.id,resultHash:row.result_hash,superseded:prior.map(p=>p.id)}});
 return {resourceType:'consolidation_run',resourceId:id,version:Number(updated.version),state:'published',snapshotId:snap.id};
}
