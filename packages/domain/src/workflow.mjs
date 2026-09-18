// Workflow module: tasks, comments, obligations and the shared approval
// engine. Every module raises tasks and approvals through these functions so
// there is one task table, one approval chain and one place for maker-checker.
import {assertInput,audit,cursorClause,emit,expectVersion,fail,isUuid,page,pageArgs,requireEntity,requirePermission,resource,cursorScope} from './core.mjs';
import {linkEvidence} from './evidence.mjs';

const taskFields=t=>({kind:t.kind,sourceType:t.source_type,sourceId:t.source_id,...(t.owner_id?{ownerId:t.owner_id}:{}),...(t.due_at?{dueAt:t.due_at.toISOString()}:{}),reason:t.reason});
export const taskResource=t=>resource(t,taskFields(t));
export const activeStates=['open','assigned','in_progress','waiting_for_information'];

// Opening a task is idempotent per source/kind/cause: a second request for the
// same cause returns the existing active task instead of a duplicate.
export async function openTask(tx,ctx,entityId,input,{causeKey='default',severity='normal'}={}){
 requirePermission(ctx,'task.create');requireEntity(ctx,entityId);assertInput('TaskCreate',input);
 if(input.ownerId&&!(await tx.query("select 1 from lara.principals where tenant_id=$1 and id=$2 and status='active'",[ctx.tenantId,input.ownerId])).rowCount)fail('NOT_FOUND','Owner principal not found.');
 const existing=(await tx.query("select * from lara.tasks where tenant_id=$1 and entity_id=$2 and source_type=$3 and source_id=$4 and kind=$5 and cause_key=$6 and status=any($7::text[]) for update",[ctx.tenantId,entityId,input.sourceType,input.sourceId,input.kind,causeKey,activeStates])).rows[0];
 if(existing)return {task:taskResource(existing),created:false};
 const status=input.ownerId?'assigned':'open';
 const row=(await tx.query('insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,owner_id,due_at,status,severity,cause_key,reason,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[ctx.tenantId,entityId,input.kind,input.sourceType,input.sourceId,input.ownerId||null,input.dueAt||null,status,severity,causeKey,input.reason.trim(),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'task.open',resourceType:'task',resourceId:row.id,resourceVersion:1,reason:input.reason});
 await emit(tx,ctx,{entityId,aggregateType:'task',aggregateId:row.id,aggregateVersion:1,eventType:'task.opened.v1',payload:{taskId:row.id,kind:input.kind,ownerId:input.ownerId||null}});
 return {task:taskResource(row),created:true};
}
async function loadTask(tx,ctx,entityId,id){
 const row=(await tx.query('select * from lara.tasks where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Task not found.');return row;
}
export async function assignTask(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'task.assign');requireEntity(ctx,entityId);assertInput('AssignTask',input);
 const row=await loadTask(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!activeStates.includes(row.status))fail('STATE_CONFLICT','Task is '+row.status+'.');
 if(!(await tx.query("select 1 from lara.principals where tenant_id=$1 and id=$2 and status='active'",[ctx.tenantId,input.ownerId])).rowCount)fail('NOT_FOUND','Owner principal not found.');
 const status=row.status==='open'?'assigned':row.status;
 const updated=(await tx.query('update lara.tasks set owner_id=$3,due_at=coalesce($4,due_at),status=$5 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.ownerId,input.dueAt||null,status])).rows[0];
 await audit(tx,ctx,{entityId,action:'task.assign',resourceType:'task',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason,afterRef:input.ownerId});
 return {resourceType:'task',resourceId:id,version:Number(updated.version),state:updated.status};
}
// PATCH: owner starts work or parks the task waiting for information. Waiting
// keeps the owner and requires a due date so nothing is silently dropped.
export async function updateTask(tx,ctx,entityId,id,expectedVersion,input,{state}={}){
 requirePermission(ctx,'task.edit');requireEntity(ctx,entityId);assertInput('TaskCreate',input);
 const row=await loadTask(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(!activeStates.includes(row.status))fail('STATE_CONFLICT','Task is '+row.status+'.');
 if(row.kind!==input.kind||row.source_type!==input.sourceType||row.source_id!==input.sourceId)fail('VALIDATION_FAILED','Task kind and source are immutable.',{fieldErrors:[{path:'sourceId',message:'Immutable'}]});
 let status=row.status;
 if(state){
  if(!['in_progress','waiting_for_information','open'].includes(state))fail('VALIDATION_FAILED','Unsupported task state.',{fieldErrors:[{path:'state',message:'in_progress, waiting_for_information or open'}]});
  if(state!=='open'&&!(input.ownerId||row.owner_id))fail('STATE_CONFLICT','Assign an owner first.');
  if(state==='waiting_for_information'&&!(input.dueAt||row.due_at))fail('STATE_CONFLICT','Waiting for information requires a due date.');
  status=state;
 }
 const updated=(await tx.query('update lara.tasks set owner_id=coalesce($3,owner_id),due_at=coalesce($4,due_at),reason=$5,status=$6,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.ownerId||null,input.dueAt||null,input.reason.trim(),status])).rows[0];
 await audit(tx,ctx,{entityId,action:'task.edit',resourceType:'task',resourceId:id,resourceVersion:Number(updated.version)});
 return taskResource(updated);
}
// Resolving links the supplied available evidence and, for missing-evidence
// tasks raised by onboarding checks, marks the related check passed. Related
// checks update in place; no second task is created.
export async function resolveTask(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'task.resolve');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadTask(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status==='resolved')return {resourceType:'task',resourceId:id,version:Number(row.version),state:'resolved'};
 if(row.status==='cancelled')fail('STATE_CONFLICT','Cancelled tasks cannot be resolved.');
 if(row.kind==='missing_evidence'&&!(input.evidenceIds||[]).length)fail('EVIDENCE_NOT_READY','Attach the available evidence that resolves this task.');
 await linkEvidence(tx,ctx,entityId,input.evidenceIds||[],'task',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.tasks set status='resolved',resolution=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.reason.trim()])).rows[0];
 if(row.source_type==='onboarding_check'){
  await tx.query("update lara.onboarding_checks set status='passed',evidence_id=$4 where tenant_id=$1 and entity_id=$2 and id=$3 and status in ('pending','failed')",[ctx.tenantId,entityId,row.source_id,(input.evidenceIds||[])[0]||null]);
 }
 await audit(tx,ctx,{entityId,action:'task.resolve',resourceType:'task',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 await emit(tx,ctx,{entityId,aggregateType:'task',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'task.resolved.v1',payload:{taskId:id,sourceType:row.source_type,sourceId:row.source_id}});
 return {resourceType:'task',resourceId:id,version:Number(updated.version),state:'resolved'};
}
export async function commentTask(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'task.comments');requireEntity(ctx,entityId);assertInput('CommentCreate',input);
 const row=await loadTask(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 const evidenceId=(input.evidenceIds||[])[0]||null;
 if(evidenceId)await linkEvidence(tx,ctx,entityId,[evidenceId],'task',id,Number(row.version));
 const comment=(await tx.query('insert into lara.task_comments(tenant_id,entity_id,task_id,body,evidence_id,created_by) values($1,$2,$3,$4,$5,$6) returning id',[ctx.tenantId,entityId,id,input.body.trim(),evidenceId,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'task.comment',resourceType:'task_comment',resourceId:comment.id,resourceVersion:1});
 return {resourceType:'task_comment',resourceId:comment.id,version:1,state:'recorded'};
}
export async function getTask(tx,ctx,entityId,id){requirePermission(ctx,'task.read');requireEntity(ctx,entityId);const row=(await tx.query('select * from lara.tasks where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Task not found.');return taskResource(row);}
// My work: filtered by owner, status and due window; ordering is stable.
export async function listTasks(tx,ctx,entityId,query){
 requirePermission(ctx,'task.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,typeof entityId==='string'?entityId:null,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.ownerId){if(!isUuid(query.ownerId))fail('VALIDATION_FAILED','ownerId must be a UUID.',{fieldErrors:[{path:'ownerId',message:'UUID'}]});params.push(query.ownerId);where+=' and owner_id=$'+params.length;}
 if(query?.status){params.push(String(query.status).split(','));where+=' and status=any($'+params.length+'::text[])';}
 if(query?.dueBefore){params.push(String(query.dueBefore));where+=' and due_at<=$'+params.length+'::timestamptz';}
 if(query?.sourceId){if(!isUuid(query.sourceId))fail('VALIDATION_FAILED','sourceId must be a UUID.',{fieldErrors:[{path:'sourceId',message:'UUID'}]});params.push(query.sourceId);where+=' and source_id=$'+params.length;}
 const rows=(await tx.query('select * from lara.tasks where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,taskResource,scope);
}
export async function taskComments(tx,ctx,entityId,id){
 requirePermission(ctx,'task.read');requireEntity(ctx,entityId);
 return (await tx.query('select id,body,evidence_id,created_by,created_at from lara.task_comments where tenant_id=$1 and entity_id=$2 and task_id=$3 order by created_at,id',[ctx.tenantId,entityId,id])).rows.map(c=>({id:c.id,body:c.body,evidenceId:c.evidence_id,authorId:c.created_by,createdAt:c.created_at.toISOString()}));
}

// Obligations instantiate from versioned templates. Re-running a template with
// a new rule version updates open obligations and leaves completed ones with
// their evidence and original rule version intact.
const obligationFields=o=>({kind:o.kind,periodKey:o.period_key,dueAt:o.due_at.toISOString(),ownerId:o.owner_id,ruleVersion:o.rule_version});
export const obligationResource=o=>resource(o,obligationFields(o));
export async function createObligation(tx,ctx,entityId,input,{ruleProfile='default'}={}){
 requirePermission(ctx,'obligation.create');requireEntity(ctx,entityId);assertInput('ObligationCreate',input);
 if(!(await tx.query("select 1 from lara.principals where tenant_id=$1 and id=$2 and status='active'",[ctx.tenantId,input.ownerId])).rowCount)fail('NOT_FOUND','Owner principal not found.');
 const existing=(await tx.query('select * from lara.obligations where tenant_id=$1 and entity_id=$2 and kind=$3 and period_key=$4 and rule_profile=$5 for update',[ctx.tenantId,entityId,input.kind,input.periodKey,ruleProfile])).rows[0];
 if(existing){
  if(existing.status==='completed')return {obligation:obligationResource(existing),created:false,retained:true};
  const updated=(await tx.query('update lara.obligations set due_at=$3,owner_id=$4,rule_version=$5,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,existing.id,input.dueAt,input.ownerId,input.ruleVersion])).rows[0];
  await audit(tx,ctx,{entityId,action:'obligation.reinstantiate',resourceType:'obligation',resourceId:existing.id,resourceVersion:Number(updated.version),afterRef:input.ruleVersion});
  return {obligation:obligationResource(updated),created:false,retained:false};
 }
 const row=(await tx.query('insert into lara.obligations(tenant_id,entity_id,kind,period_key,rule_profile,rule_version,due_at,owner_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,input.kind,input.periodKey,ruleProfile,input.ruleVersion,input.dueAt,input.ownerId,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'obligation.create',resourceType:'obligation',resourceId:row.id,resourceVersion:1});
 return {obligation:obligationResource(row),created:true,retained:false};
}
export async function updateObligation(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'obligation.edit');requireEntity(ctx,entityId);assertInput('ObligationCreate',input);
 const row=(await tx.query('select * from lara.obligations where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Obligation not found.');expectVersion(row,expectedVersion);
 if(row.status==='completed')fail('STATE_CONFLICT','Completed obligations retain their evidence and rule version.');
 if(row.kind!==input.kind||row.period_key!==input.periodKey)fail('VALIDATION_FAILED','Kind and period are immutable; create another obligation.',{fieldErrors:[{path:'periodKey',message:'Immutable'}]});
 const updated=(await tx.query('update lara.obligations set due_at=$3,owner_id=$4,rule_version=$5,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.dueAt,input.ownerId,input.ruleVersion])).rows[0];
 await audit(tx,ctx,{entityId,action:'obligation.edit',resourceType:'obligation',resourceId:id,resourceVersion:Number(updated.version)});
 return obligationResource(updated);
}
export async function completeObligation(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'obligation.complete');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=(await tx.query('select * from lara.obligations where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Obligation not found.');if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status==='completed')return {resourceType:'obligation',resourceId:id,version:Number(row.version),state:'completed'};
 const evidenceId=(input.evidenceIds||[])[0];
 if(!evidenceId)fail('EVIDENCE_NOT_READY','Completion requires the configured evidence.');
 await linkEvidence(tx,ctx,entityId,[evidenceId],'obligation',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.obligations set status='completed',evidence_id=$3,completed_at=now(),completed_by=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,evidenceId,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'obligation.complete',resourceType:'obligation',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 await emit(tx,ctx,{entityId,aggregateType:'obligation',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'obligation.completed.v1',payload:{obligationId:id,kind:row.kind,periodKey:row.period_key}});
 return {resourceType:'obligation',resourceId:id,version:Number(updated.version),state:'completed'};
}
export async function getObligation(tx,ctx,entityId,id){requirePermission(ctx,'obligation.read');requireEntity(ctx,entityId);const row=(await tx.query('select * from lara.obligations where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Obligation not found.');return obligationResource(row);}
export async function listObligations(tx,ctx,entityId,query){
 requirePermission(ctx,'obligation.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,typeof entityId==='string'?entityId:null,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.status){params.push(String(query.status).split(','));where+=' and status=any($'+params.length+'::text[])';}
 if(query?.from){params.push(String(query.from));where+=' and due_at>=$'+params.length+'::timestamptz';}
 if(query?.to){params.push(String(query.to));where+=' and due_at<=$'+params.length+'::timestamptz';}
 const rows=(await tx.query('select * from lara.obligations where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,obligationResource,scope);
}

// Approval engine shared by every controlled resource. A request binds the
// resource's content version and hash; decisions come from a different
// principal, one per actor, and a decision on stale content is refused.
export async function requestApproval(tx,ctx,entityId,{resourceType,resourceId,contentVersion,contentHash,policyId=null,policyVersion=1,step=1,requiredRoleId=null}){
 await tx.query("update lara.approval_requests set status='invalidated' where tenant_id=$1 and entity_id=$2 and resource_type=$3 and resource_id=$4 and status='pending' and content_version<>$5",[ctx.tenantId,entityId,resourceType,resourceId,contentVersion]);
 const existing=(await tx.query("select * from lara.approval_requests where tenant_id=$1 and entity_id=$2 and resource_type=$3 and resource_id=$4 and content_version=$5 and step=$6",[ctx.tenantId,entityId,resourceType,resourceId,contentVersion,step])).rows[0];
 if(existing){if(existing.content_hash!==contentHash)fail('STATE_CONFLICT','Content hash differs for the same content version.');return existing;}
 const row=(await tx.query('insert into lara.approval_requests(tenant_id,entity_id,resource_type,resource_id,content_version,content_hash,policy_id,policy_version,step,required_role_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[ctx.tenantId,entityId,resourceType,resourceId,contentVersion,contentHash,policyId,policyVersion,step,requiredRoleId,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'approval.request',resourceType:'approval_request',resourceId:row.id,resourceVersion:1,afterRef:contentHash});
 return row;
}
export async function decideApproval(tx,ctx,entityId,requestId,{decision,contentVersion,reason},current){
 const request=(await tx.query('select * from lara.approval_requests where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,requestId])).rows[0];
 if(!request)fail('NOT_FOUND','Approval request not found.');
 if(request.status!=='pending')fail('STATE_CONFLICT','Approval request is '+request.status+'.');
 if(request.created_by===ctx.principalId)fail('SELF_APPROVAL','The requesting principal cannot decide.');
 if(Number(request.content_version)!==Number(contentVersion))fail('VERSION_CONFLICT','The decision does not reference the reviewed content version.',{resourceVersion:Number(request.content_version)});
 if(current&&(Number(current.contentVersion)!==Number(request.content_version)||current.contentHash!==request.content_hash)){
  await tx.query("update lara.approval_requests set status='invalidated' where id=$1",[requestId]);
  fail('STATE_CONFLICT','The resource changed after review; the request has been invalidated.');
 }
 if(request.required_role_id&&!ctx.roleIds?.has(request.required_role_id))fail('FORBIDDEN','A member of the required approver role must decide this step.');
 if(decision==='reject'&&!reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 await tx.query('insert into lara.approval_decisions(tenant_id,entity_id,request_id,actor_id,decision,reason) values($1,$2,$3,$4,$5,$6)',[ctx.tenantId,entityId,requestId,ctx.principalId,decision,reason||null]);
 const status=decision==='approve'?'approved':'rejected';
 const updated=(await tx.query('update lara.approval_requests set status=$2 where id=$1 returning *',[requestId,status])).rows[0];
 await audit(tx,ctx,{entityId,action:'approval.'+decision,resourceType:'approval_request',resourceId:requestId,resourceVersion:Number(updated.version),reason:reason||null});
 return updated;
}
