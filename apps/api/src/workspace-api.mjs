// /v1 workspace API: every route is looked up in the reviewed OpenAPI, the
// actor is resolved from committed memberships, headers follow the mutation
// conventions, bodies are validated against the contract, and each command
// runs in one tenant-bound transaction with its receipt, audit and outbox.
import {findOperation,operations,validateInput} from '@lara/contracts';
import {DomainError,command,inTransaction,enqueueJob,fail,isUuid,identity,organization,parties,evidence,workflow} from '@lara/domain';

const MAX_JSON=1048576,MAX_UPLOAD=20971520;
const buckets=new Map();
// Per-principal token buckets: 120 reads and 30 writes per minute by default
// (07-security). Limits are versioned configuration raised only with
// capacity evidence; the environment may set them for a deployment.
const limits={reads:Number(process.env.RATE_LIMIT_READS_PER_MINUTE)||120,writes:Number(process.env.RATE_LIMIT_WRITES_PER_MINUTE)||30};
export function rateLimit(key,write,now=Date.now()){
 const limit=write?limits.writes:limits.reads,bucket=buckets.get(key+(write?':w':':r'))||{tokens:limit,at:now};
 bucket.tokens=Math.min(limit,bucket.tokens+((now-bucket.at)/60000)*limit);bucket.at=now;
 if(bucket.tokens<1){buckets.set(key+(write?':w':':r'),bucket);fail('RATE_LIMITED','Too many requests.');}
 bucket.tokens-=1;buckets.set(key+(write?':w':':r'),bucket);
 if(buckets.size>10000)buckets.clear();
}
async function readBody(request,limit=MAX_JSON){const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>limit)fail('VALIDATION_FAILED','Request body is too large.');chunks.push(chunk);}return Buffer.concat(chunks);}
function parseJson(bytes){if(!bytes.length)return undefined;try{return JSON.parse(bytes.toString('utf8'));}catch{fail('VALIDATION_FAILED','Invalid JSON body.',{fieldErrors:[{path:'',message:'Invalid JSON'}]});}}
function ifMatch(header){if(header===undefined)fail('PRECONDITION_REQUIRED','If-Match header is required.');const m=/^"?(\d{1,15})"?$/.exec(String(header).trim());if(!m)fail('VALIDATION_FAILED','If-Match must contain the quoted resource version.',{fieldErrors:[{path:'If-Match',message:'Quoted integer'}]});return Number(m[1]);}

// Tenant comes from the directory of committed memberships for the
// authenticated subject, never from the body. Several tenants require the
// caller to name one of them.
export async function resolveActor(db,identity_,{issuer,tenantHeader,traceId}){
 const rows=(await db.query('select tenant_id,principal_id from lara.principal_directory where oidc_issuer=$1 and oidc_subject=$2 order by tenant_id',[issuer,identity_.sub])).rows;
 if(!rows.length)fail('FORBIDDEN','No workspace membership for this account.');
 let match=rows[0];
 if(rows.length>1||tenantHeader){
  if(!tenantHeader)fail('PRECONDITION_REQUIRED','X-Tenant-Id is required when the account belongs to several tenants.');
  match=rows.find(r=>r.tenant_id===tenantHeader);
  if(!match)fail('FORBIDDEN','No workspace membership in that tenant.');
 }
 return inTransaction(db,{tenantId:match.tenant_id,principalId:match.principal_id},tx=>identity.actorContext(tx,match.tenant_id,match.principal_id,{traceId}));
}

const created=r=>({status:201,body:r,etag:r.version});
const ok=r=>({status:200,body:r,etag:r.version});
const result=(ctx,r)=>({status:200,body:{resourceType:r.resourceType,resourceId:r.resourceId,version:r.version,state:r.state,journalEntryIds:[],taskIds:r.taskIds||[],traceId:ctx.traceId,simulation:false,...(r.approvalRequestId?{}:{})}});
const list=r=>({status:200,body:r});

// operationId → handler. Handlers receive the transaction, actor context and
// request parts; the wrapper decides between a read transaction and the
// idempotent command envelope.
const handlers={
 get_me:async(tx,ctx)=>{
  const capabilities=ctx.entityIds.size?(await tx.query("select distinct capability from lara.capability_activations where tenant_id=$1 and entity_id=any($2::uuid[]) and status='active' order by capability",[ctx.tenantId,[...ctx.entityIds]])).rows.map(r=>r.capability):[];
  return {status:200,body:identity.sessionContext({...ctx,capabilities})};},
 post_entities:async(tx,ctx,{body})=>created(await organization.createEntity(tx,ctx,body)),
 get_entities:async(tx,ctx,{query})=>list(await organization.listEntities(tx,ctx,query)),
 get_entities_id:async(tx,ctx,{params})=>ok(await organization.getEntity(tx,ctx,params.id)),
 patch_entities_id:async(tx,ctx,{params,body,version})=>ok(await organization.updateEntity(tx,ctx,params.id,version,body)),
 post_entities_id_activate:async(tx,ctx,{params,body,version})=>{
  // The preparer requests; a principal holding entity.activate approves.
  const r=ctx.permissions.has('entity.activate')&&(await tx.query("select 1 from lara.approval_requests where tenant_id=$1 and resource_type='entity' and resource_id=$2 and status='pending' and created_by<>$3",[ctx.tenantId,params.id,ctx.principalId])).rowCount
   ?await organization.activateEntity(tx,ctx,params.id,body,version):await organization.requestActivation(tx,ctx,params.id,body,version);
  return result(ctx,r);},
 post_branches:async(tx,ctx,{entityId,body})=>created(await organization.createBranch(tx,ctx,entityId,body)),
 get_branches:async(tx,ctx,{entityId,query})=>list(await organization.listBranches(tx,ctx,entityId,query)),
 get_branches_id:async(tx,ctx,{entityId,params})=>ok(await organization.getBranch(tx,ctx,entityId,params.id)),
 patch_branches_id:async(tx,ctx,{entityId,params,body,version})=>ok(await organization.updateBranch(tx,ctx,entityId,params.id,version,body)),
 post_parties:async(tx,ctx,{entityId,body})=>created(await parties.createParty(tx,ctx,entityId,body)),
 get_parties:async(tx,ctx,{entityId,query})=>list(await parties.listParties(tx,ctx,entityId,query)),
 get_parties_id:async(tx,ctx,{entityId,params})=>ok(await parties.getParty(tx,ctx,entityId,params.id)),
 patch_parties_id:async(tx,ctx,{entityId,params,body,version})=>ok(await parties.updateParty(tx,ctx,entityId,params.id,version,body)),
 post_parties_id_archive:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await parties.archiveParty(tx,ctx,entityId,params.id,body,version)),
 post_memberships:async(tx,ctx,{entityId,body})=>created(await identity.createMembership(tx,ctx,entityId,body)),
 get_memberships:async(tx,ctx,{entityId,query})=>list(await identity.listMemberships(tx,ctx,entityId,query)),
 get_memberships_id:async(tx,ctx,{entityId,params})=>ok(await identity.getMembership(tx,ctx,entityId,params.id)),
 patch_memberships_id:async(tx,ctx,{entityId,params,body,version})=>ok(await identity.updateMembership(tx,ctx,entityId,params.id,version,body)),
 post_memberships_id_revoke:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await identity.revokeMembership(tx,ctx,entityId,params.id,body,version)),
 post_roles:async(tx,ctx,{body})=>created(await identity.createRole(tx,ctx,body)),
 get_roles:async(tx,ctx,{query})=>list(await identity.listRoles(tx,ctx,query)),
 get_roles_id:async(tx,ctx,{params})=>ok(await identity.getRole(tx,ctx,params.id)),
 patch_roles_id:async(tx,ctx,{params,body,version})=>ok(await identity.updateRole(tx,ctx,params.id,version,body)),
 post_roles_id_approve:async(tx,ctx,{params,body,version})=>result(ctx,await identity.approveRole(tx,ctx,params.id,body,version)),
 post_capabilities_activate:async(tx,ctx,{entityId,body})=>result(ctx,await organization.activateCapability(tx,ctx,entityId,body)),
 post_tasks:async(tx,ctx,{entityId,body})=>{const r=await workflow.openTask(tx,ctx,entityId,body);return {status:r.created?201:200,body:r.task,etag:r.task.version};},
 get_tasks:async(tx,ctx,{entityId,query})=>list(await workflow.listTasks(tx,ctx,entityId,query)),
 get_tasks_id:async(tx,ctx,{entityId,params})=>ok(await workflow.getTask(tx,ctx,entityId,params.id)),
 patch_tasks_id:async(tx,ctx,{entityId,params,body,version,query})=>ok(await workflow.updateTask(tx,ctx,entityId,params.id,version,body,{state:query.state})),
 post_tasks_id_assign:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await workflow.assignTask(tx,ctx,entityId,params.id,body,version)),
 post_tasks_id_resolve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await workflow.resolveTask(tx,ctx,entityId,params.id,body,version)),
 post_tasks_id_comments:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await workflow.commentTask(tx,ctx,entityId,params.id,body,version)),
 post_obligations:async(tx,ctx,{entityId,body})=>{const r=await workflow.createObligation(tx,ctx,entityId,body);return {status:r.created?201:200,body:r.obligation,etag:r.obligation.version};},
 get_obligations:async(tx,ctx,{entityId,query})=>list(await workflow.listObligations(tx,ctx,entityId,query)),
 get_obligations_id:async(tx,ctx,{entityId,params})=>ok(await workflow.getObligation(tx,ctx,entityId,params.id)),
 patch_obligations_id:async(tx,ctx,{entityId,params,body,version})=>ok(await workflow.updateObligation(tx,ctx,entityId,params.id,version,body)),
 post_obligations_id_complete:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await workflow.completeObligation(tx,ctx,entityId,params.id,body,version)),
 post_evidence_uploads:async(tx,ctx,{entityId,body})=>{const r=await evidence.registerUpload(tx,ctx,entityId,body,{uploadBase:'/v1/evidence'});return {status:201,body:r,etag:r.version};},
 post_evidence_id_complete:async(tx,ctx,{entityId,params,store,version})=>{
  const staged=await store.get('staging/'+params.id).catch(()=>null);
  if(!staged)fail('STATE_CONFLICT','Upload the content to the upload URL before completing.');
  const r=await evidence.completeUpload(tx,ctx,entityId,params.id,staged,store,version);
  await store.dispose('staging/'+params.id);
  if(r.outcome==='rejected')return {status:422,body:{code:'VALIDATION_FAILED',message:'Upload rejected: '+r.reasons.join('; ')+'.',traceId:ctx.traceId,fieldErrors:r.reasons.map(m=>({path:'content',message:m})),retryable:false}};
  return {status:202,body:r.job};},
 get_evidence_id:async(tx,ctx,{entityId,params})=>ok(await evidence.getEvidence(tx,ctx,entityId,params.id)),
 get_evidence_id_content:async(tx,ctx,{entityId,params,store})=>{const r=await evidence.readContent(tx,ctx,entityId,params.id,store);return {status:200,raw:r.bytes,headers:{'content-type':r.evidence.mime,'content-disposition':'attachment; filename="'+r.evidence.filename.replace(/["\r\n]/g,'_')+'"','x-content-sha256':r.evidence.sha256}};},
 post_exports:async(tx,ctx,{entityId,body})=>{
  if(!ctx.permissions.has('evidence.export'))fail('FORBIDDEN','Permission evidence.export is required.');
  if(body.kind==='report'&&!body.report)fail('VALIDATION_FAILED','kind=report requires report.',{fieldErrors:[{path:'report',message:'Required'}]});
  if(body.kind!=='report'&&body.report)fail('VALIDATION_FAILED','report is only valid for kind=report.',{fieldErrors:[{path:'report',message:'Not allowed'}]});
  if(body.kind==='report')fail('FEATURE_NOT_ENABLED','Report exports arrive with the ledger module.');
  const job=await enqueueJob(tx,ctx,{entityId,kind:'export.'+body.kind,payload:{format:body.format,resourceIds:body.resourceIds,cutoff:new Date().toISOString()}});
  return {status:202,body:{id:job.id,state:job.state,statusUrl:'/v1/jobs/'+job.id,traceId:ctx.traceId,resultResourceType:null,resultResourceId:null}};},
 get_jobs_id:async(tx,ctx,{params})=>{
  if(!isUuid(params.id))fail('NOT_FOUND','Job not found.');
  const job=(await tx.query('select * from lara.jobs where tenant_id=$1 and id=$2',[ctx.tenantId,params.id])).rows[0];
  if(!job||(job.entity_id&&!ctx.entityIds.has(job.entity_id)))fail('NOT_FOUND','Job not found.');
  if(job.requested_by!==ctx.principalId&&!ctx.permissions.has('job.read'))fail('NOT_FOUND','Job not found.');
  return {status:200,body:{id:job.id,state:job.state,statusUrl:'/v1/jobs/'+job.id,traceId:job.trace_id||ctx.traceId,resultResourceType:job.result_resource_type,resultResourceId:job.result_resource_id}};},
 get_commands_key:async(tx,ctx,{entityId,params})=>{
  // Replay never bypasses current authorization: the receipt is returned only
  // to a member who can still read the committed resource type.
  const r=(await tx.query('select * from lara.command_receipts where tenant_id=$1 and idempotency_key=$2 and (entity_id=$3 or entity_id is null) order by created_at desc limit 1',[ctx.tenantId,params.key,entityId])).rows[0];
  if(!r)fail('NOT_FOUND','Command not found.');
  const op=Object.values(operations).find(o=>o.operationId===r.operation);
  if(op&&!ctx.permissions.has(op.permission))fail('NOT_FOUND','Command not found.');
  return {status:200,body:{resourceType:r.resource_type||'command',resourceId:r.resource_id||r.id,version:1,state:r.status,journalEntryIds:[],taskIds:[],traceId:r.trace_id||ctx.traceId,simulation:false}};},
};
handlers.post_approval_policies=handlers.get_approval_policies=handlers.get_approval_policies_id=handlers.patch_approval_policies_id=handlers.post_approval_policies_id_approve=handlers.post_approval_policies_id_activate=async()=>fail('FEATURE_NOT_ENABLED','Approval policy management is completed with the ledger approval routing.');

export function createWorkspaceApi({pool,issuer,store,mode}){
 return async function handle(request,response,{identity:identity_,path,method,traceId,send}){
  const db=await pool.connect();
  try{
   const url=new URL(request.url,'http://localhost');
   const query=Object.fromEntries(url.searchParams);
   // Local-stream upload endpoint (06-api §Attachments step 2): raw bytes are
   // staged until POST /evidence/{id}/complete verifies them.
   const upload=/^\/evidence\/([0-9a-f-]{36})\/content$/.exec(path);
   if(upload&&method==='PUT'){
    const ctx=await resolveActor(db,identity_,{issuer,tenantHeader:request.headers['x-tenant-id'],traceId});
    rateLimit(ctx.principalId,true);
    const entityId=request.headers['x-entity-id'];
    await inTransaction(db,ctx,tx=>evidence.getEvidence(tx,ctx,entityId,upload[1]).then(e=>{if(e.state!=='quarantined')fail('STATE_CONFLICT','Upload is already '+e.state+'.');}));
    const bytes=await readBody(request,MAX_UPLOAD);
    await store.put('staging/'+upload[1],bytes);
    return send(response,204,'');
   }
   const found=findOperation(method,path);
   if(!found)return send(response,404,{code:'NOT_FOUND',message:'No such operation.',traceId,fieldErrors:[],retryable:false});
   const {operation:op,params}=found;
   if(op.phase!=='P02'||!handlers[op.operationId])return send(response,409,{code:'FEATURE_NOT_ENABLED',message:'This capability is not enabled in this release.',traceId,fieldErrors:[],retryable:false});
   if(op.path.startsWith('/demo/')&&mode!=='demo')return send(response,404,{code:'NOT_FOUND',message:'No such operation.',traceId,fieldErrors:[],retryable:false});
   const ctx=await resolveActor(db,identity_,{issuer,tenantHeader:request.headers['x-tenant-id'],traceId});
   const write=op.method!=='GET';
   rateLimit(ctx.principalId,write);
   const entityId=op.requiresEntity?request.headers['x-entity-id']:null;
   if(op.requiresEntity&&!isUuid(entityId))fail('VALIDATION_FAILED','X-Entity-Id header must be a UUID.',{fieldErrors:[{path:'X-Entity-Id',message:'Required UUID'}]});
   if(op.requiresEntity&&!ctx.entityIds.has(entityId))fail('NOT_FOUND','Entity not found.');
   const version=op.requiresIfMatch?ifMatch(request.headers['if-match']):undefined;
   let body;
   if(write){
    body=parseJson(await readBody(request));
    if(op.input){const v=validateInput(op.operationId,body);if(!v.ok)fail('VALIDATION_FAILED','Request does not match the reviewed contract.',{fieldErrors:v.fieldErrors});}
    else if(body!==undefined&&Object.keys(body).length)fail('VALIDATION_FAILED','This operation takes no body.',{fieldErrors:[{path:'',message:'No body'}]});
   }
   const parts={params,query,entityId,body,version,store};
   let out;
   if(!write)out=await inTransaction(db,ctx,tx=>handlers[op.operationId](tx,ctx,parts));
   else{
    const key=request.headers['idempotency-key'];
    if(op.requiresIdempotencyKey&&!key)fail('PRECONDITION_REQUIRED','Idempotency-Key header is required.');
    if(op.requiresIdempotencyKey){
     const r=await command(db,ctx,{operation:op.operationId,idempotencyKey:key,entityId,body:{...(body??{}),__path:params,__version:version??null},traceId},async tx=>{const h=await handlers[op.operationId](tx,ctx,parts);return {resourceType:h.body?.resourceType||op.response||'result',resourceId:h.body?.resourceId||h.body?.id||h.body?.evidenceId||params.id||null,response:{status:h.status,body:h.body,etag:h.etag??null}};});
     out=r.response;
    }else out=await inTransaction(db,ctx,tx=>handlers[op.operationId](tx,ctx,parts));
   }
   if(out.raw){for(const [k,v] of Object.entries(out.headers||{}))response.setHeader(k,v);response.statusCode=out.status;return response.end(out.raw);}
   if(out.etag!==undefined&&out.etag!==null)response.setHeader('etag','"'+out.etag+'"');
   return send(response,out.status,out.body);
  }catch(error){
   if(error instanceof DomainError){if(error.code==='RATE_LIMITED')response.setHeader('retry-after','5');return send(response,error.status,error.body(traceId));}
   throw error;
  }finally{db.release();}
 };
}
