// Shared command mechanics for every module: typed errors, canonical content
// hashing, tenant-scoped transactions, idempotent command receipts, audit and
// outbox writes. Modules never open their own transactions; they receive `tx`.
import {createHash,randomUUID} from 'node:crypto';
import {errorStatus,retryableCodes,validate} from '@lara/contracts';

export class DomainError extends Error {
 constructor(code,message,{fieldErrors=[],resourceVersion}={}) {
  super(message);this.code=code;this.status=errorStatus[code]||500;this.fieldErrors=fieldErrors;this.retryable=retryableCodes.has(code);this.resourceVersion=resourceVersion;
 }
 body(traceId){return {code:this.code,message:this.message,traceId,fieldErrors:this.fieldErrors,retryable:this.retryable,...(this.resourceVersion?{resourceVersion:this.resourceVersion}:{})};}
}
export const fail=(code,message,extra)=>{throw new DomainError(code,message,extra);};
export function assertInput(schema,value){const r=validate(schema,value);if(!r.ok)fail('VALIDATION_FAILED','Request does not match the reviewed contract.',{fieldErrors:r.fieldErrors});return value;}

// Canonical JSON: sorted keys, no undefined, arrays in order. Material content
// hashes are computed from this so approvals bind exactly what was reviewed.
export function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
export const contentHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export const requestHash=(operation,body)=>createHash('sha256').update(operation+'\n'+canonical(body??null)).digest('hex');

export const NIL_ENTITY='00000000-0000-0000-0000-000000000000';
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid=v=>typeof v==='string'&&UUID.test(v);

// Actor context resolved by the identity module before a command runs.
// permissions are the union of active memberships/delegations; entityIds are
// the entities the actor may address. tenantId comes from membership, never
// from the request body.
export function requirePermission(ctx,permission){if(!ctx.permissions.has(permission))fail('FORBIDDEN','Permission '+permission+' is required.');}
// Reference data (chart, tax rules) is readable by anyone who prepares documents against it.
export function requireAnyPermission(ctx,permissions){if(!permissions.some(p=>ctx.permissions.has(p)))fail('FORBIDDEN','Permission '+permissions[0]+' is required.');}
export function requireEntity(ctx,entityId){
 if(!isUuid(entityId))fail('VALIDATION_FAILED','X-Entity-Id must be a UUID.',{fieldErrors:[{path:'X-Entity-Id',message:'Invalid entity id'}]});
 // Inaccessible entities are reported as not found so scope is not disclosed.
 if(!ctx.entityIds.has(entityId))fail('NOT_FOUND','Entity not found.');
}

// Runs fn inside a transaction bound to the tenant and principal. Locks are the
// caller's responsibility; serialization failures are retried up to three times.
export async function inTransaction(db,ctx,fn,{isolation='read committed'}={}) {
 for(let attempt=1;;attempt++){
  await db.query('begin isolation level '+isolation);
  try{
   await db.query("select set_config('lara.tenant_id',$1,true),set_config('lara.principal_id',$2,true)",[ctx.tenantId,ctx.principalId||'']);
   const result=await fn(db);
   await db.query('commit');return result;
  }catch(error){
   await db.query('rollback').catch(()=>{});
   if(['40001','40P01'].includes(error.code)&&attempt<3){await new Promise(r=>setTimeout(r,25*attempt+Math.floor(Math.random()*25)));continue;}
   throw translate(error);
  }
 }
}

// Database-raised rule violations carry their code as a message prefix.
export function translate(error){
 if(error instanceof DomainError)return error;
 const m=/^(SELF_APPROVAL|STATE_CONFLICT|FEATURE_NOT_ENABLED|RULE_PROFILE_NOT_APPROVED|VALIDATION_FAILED|NOT_FOUND|APPEND_ONLY|PERIOD_LOCKED|UNBALANCED_ENTRY|DUPLICATE_SOURCE|ALLOCATION_EXCEEDS_BALANCE|EVIDENCE_NOT_READY|FORBIDDEN):\s*(.*)$/.exec(error.message||'');
 if(m)return new DomainError(m[1]==='APPEND_ONLY'?'STATE_CONFLICT':m[1],m[2]);
 if(error.code==='23505')return new DomainError('STATE_CONFLICT','A record with the same unique key already exists.');
 if(error.code==='23514'||error.code==='23502')return new DomainError('VALIDATION_FAILED','The change violates a database rule: '+(error.constraint||error.column||'constraint'));
 if(error.code==='23503')return new DomainError('NOT_FOUND','A referenced record does not exist in this scope.');
 if(error.code==='42501')return new DomainError('FORBIDDEN','The database role may not perform this operation.');
 if(error.code==='57014'||error.code==='08006'||error.code==='08001'||error.code==='53300')return new DomainError('DEPENDENCY_UNAVAILABLE','Dependency unavailable');
 return error;
}

// Idempotent command envelope. Same key and hash returns the committed result;
// same key with a different request is a conflict; the effect and its receipt
// commit together. `fn` returns {resourceType,resourceId,response}.
export async function command(db,ctx,{operation,idempotencyKey,entityId=null,body,traceId},fn){
 if(!idempotencyKey||typeof idempotencyKey!=='string'||idempotencyKey.length>200)fail('PRECONDITION_REQUIRED','Idempotency-Key header is required.');
 const hash=requestHash(operation,body);
 return inTransaction(db,ctx,async tx=>{
  const existing=await tx.query('select status,request_hash,response_json,resource_type,resource_id from lara.command_receipts where tenant_id=$1 and coalesce(entity_id,$4::uuid)=coalesce($2::uuid,$4::uuid) and idempotency_key=$3 for update',[ctx.tenantId,entityId,idempotencyKey,NIL_ENTITY]);
  if(existing.rowCount){
   const prior=existing.rows[0];
   if(prior.request_hash!==hash)fail('IDEMPOTENCY_CONFLICT','Idempotency-Key was already used for a different request.');
   if(prior.status==='committed')return {replayed:true,resourceType:prior.resource_type,resourceId:prior.resource_id,response:prior.response_json};
   fail('STATE_CONFLICT','The original command did not complete; retry with a new key.');
  }
  const receipt=(await tx.query('insert into lara.command_receipts(tenant_id,entity_id,actor_id,operation,idempotency_key,request_hash,trace_id) values($1,$2,$3,$4,$5,$6,$7) returning id',[ctx.tenantId,entityId,ctx.principalId,operation,idempotencyKey,hash,traceId||null])).rows[0];
  const result=await fn(tx);
  await tx.query("update lara.command_receipts set status='committed',response_json=$2,resource_type=$3,resource_id=$4,completed_at=now() where id=$1",[receipt.id,JSON.stringify(result.response),result.resourceType,result.resourceId]);
  return {replayed:false,...result};
 });
}

export async function audit(tx,ctx,{entityId=NIL_ENTITY,action,resourceType,resourceId=null,resourceVersion=null,beforeRef=null,afterRef=null,reason=null,traceId}){
 await tx.query('insert into lara.audit_events(tenant_id,entity_id,actor_id,action,resource_type,resource_id,resource_version,before_ref,after_ref,reason,trace_id,sequence,previous_hash,hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$12)',[ctx.tenantId,entityId,ctx.principalId||null,action,resourceType,resourceId,resourceVersion,beforeRef,afterRef,reason,traceId||ctx.traceId||randomUUID(),'0'.repeat(64)]);
}
export async function emit(tx,ctx,{entityId=null,aggregateType,aggregateId,aggregateVersion,eventType,payload,traceId}){
 await tx.query('insert into lara.outbox_events(tenant_id,entity_id,aggregate_type,aggregate_id,aggregate_version,event_type,payload,trace_id) values($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,entityId,aggregateType,aggregateId,aggregateVersion,eventType,JSON.stringify(payload),traceId||ctx.traceId||null]);
}
export async function enqueueJob(tx,ctx,{entityId=null,kind,payload,runAfter=null,traceId}){
 const rv=ctx.principalId?(await tx.query('select revocation_version from lara.principals where tenant_id=$1 and id=$2',[ctx.tenantId,ctx.principalId])).rows[0]?.revocation_version:null;
 return (await tx.query('insert into lara.jobs(tenant_id,entity_id,kind,payload_ref,run_after,requested_by,revocation_version,trace_id) values($1,$2,$3,$4,coalesce($5,now()),$6,$7,$8) returning id,state',[ctx.tenantId,entityId,kind,JSON.stringify(payload),runAfter,ctx.principalId||null,rv,traceId||ctx.traceId||null])).rows[0];
}

// Optimistic concurrency: the caller passes the version from If-Match.
export function expectVersion(row,expected){
 if(expected===undefined||expected===null)fail('PRECONDITION_REQUIRED','If-Match header is required.');
 if(Number(row.version)!==Number(expected))fail('VERSION_CONFLICT','The record changed since it was read.',{resourceVersion:Number(row.version)});
}
export const iso=v=>v==null?v:(v instanceof Date?v.toISOString():v);
export function resource(row,fields){
 return {id:row.id,version:Number(row.version),contentVersion:Number(row.content_version??1),state:row.status,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),simulation:false,...fields};
}
// Cursors bind the scope they were issued for (tenant, entity and filters);
// a cursor presented under a different scope is rejected, never reinterpreted.
export const cursorScope=(ctx,entityId,query={})=>createHash('sha256').update(canonical({tenant:ctx.tenantId,entity:entityId||null,filters:Object.fromEntries(Object.entries(query).filter(([k])=>!['cursor','limit'].includes(k)))})).digest('hex').slice(0,16);
export function pageArgs(query,scope){
 const limit=query?.limit===undefined?50:Number(query.limit);
 if(!Number.isInteger(limit)||limit<1||limit>200)fail('VALIDATION_FAILED','limit must be an integer from 1 to 200.',{fieldErrors:[{path:'limit',message:'1 to 200'}]});
 let after=null;
 if(query?.cursor){try{const d=JSON.parse(Buffer.from(String(query.cursor),'base64url').toString('utf8'));if(!d.createdAt||!isUuid(d.id))throw 0;after=d;}catch{fail('VALIDATION_FAILED','Invalid cursor.',{fieldErrors:[{path:'cursor',message:'Invalid'}]});}
  if(scope!==undefined&&after.scope!==scope)fail('VALIDATION_FAILED','Cursor does not belong to this scope or filter set.',{fieldErrors:[{path:'cursor',message:'Scope mismatch'}]});}
 return {limit,after};
}
export function page(rows,limit,map,scope=null){
 const items=rows.slice(0,limit).map(map);
 const last=rows.length>limit?rows[limit-1]:null;
 return {items,nextCursor:last?Buffer.from(JSON.stringify({createdAt:iso(last.created_at),id:last.id,scope:scope??last.tenant_id})).toString('base64url'):null};
}
export const cursorClause=(after,params)=>after?` and (created_at,id) > ($${params.push(after.createdAt)}::timestamptz,$${params.push(after.id)}::uuid)`:'';
