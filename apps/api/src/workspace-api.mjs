// /v1 workspace API: every route is looked up in the reviewed OpenAPI, the
// actor is resolved from committed memberships, headers follow the mutation
// conventions, bodies are validated against the contract, and each command
// runs in one tenant-bound transaction with its receipt, audit and outbox.
import {findOperation,operations,validateInput,accountingCases,accountingCaseDefinitions} from '@lara/contracts';
import {DomainError,command,inTransaction,enqueueJob,fail,isUuid,identity,organization,parties,evidence,workflow,ledger,sales,purchasing,treasury,compliance,fi,fx,inventory,assets,assistant,portals,firm,consolidation,planning,localops,extensibility,messagingProviderFromEnv,paymentProviderFromEnv} from '@lara/domain';
// Bank statements validate and commit through the import pipeline with treasury's rules.
const bankStatement={validate:treasury.validateStatement,commit:treasury.commitStatement};
// Source feeds (P08) ride the same import pipeline; overdue feeds gate the close.
const sourceFeed=fi.sourceFeed,feeds=fi.feeds;

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
 if(tenantHeader){
  match=rows.find(r=>r.tenant_id===tenantHeader);
  if(!match)fail('FORBIDDEN','No workspace membership in that tenant.');
 }else if(rows.length>1){
  // Without a header the home tenant is the one where the subject holds a membership (P14): a delegated identity in a client tenant is not a home; two homes need the header.
  const homes=await inTransaction(db,{tenantId:rows[0].tenant_id,principalId:null},async tx=>{const out=[];for(const r of rows){await tx.query("select set_config('lara.tenant_id',$1,true)",[r.tenant_id]);if((await tx.query("select 1 from lara.memberships where tenant_id=$1 and principal_id=$2 and status='active'",[r.tenant_id,r.principal_id])).rowCount)out.push(r);}return out;});
  if(homes.length!==1)fail('PRECONDITION_REQUIRED','X-Tenant-Id is required when the account belongs to several tenants.');
  match=homes[0];
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
  // Draft entities are requested; pending ones are approved. The domain
  // refuses self-approval and rechecks the content version.
  const state=(await tx.query('select status from lara.entities where tenant_id=$1 and id=$2',[ctx.tenantId,params.id])).rows[0]?.status;
  const r=state==='pending_activation'?await organization.activateEntity(tx,ctx,params.id,body,version):await organization.requestActivation(tx,ctx,params.id,body,version);
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
  if(r.outcome!=='rejected'&&ctx.portal?.role==='supplier')await portals.recordSubmission(tx,ctx,entityId,params.id,staged);
  if(r.outcome==='rejected')return {status:422,body:{code:'VALIDATION_FAILED',message:'Upload rejected: '+r.reasons.join('; ')+'.',traceId:ctx.traceId,fieldErrors:r.reasons.map(m=>({path:'content',message:m})),retryable:false}};
  return {status:202,body:r.job};},
 get_evidence:async(tx,ctx,{entityId,query})=>list(await evidence.listEvidence(tx,ctx,entityId,query)),
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
// P03 general ledger operations.
Object.assign(handlers,{
 // Reading books is served ahead of P09 so ledger screens can address the primary book; creating separate books stays disabled.
 get_books:async(tx,ctx,{entityId,query})=>list(await ledger.listBooks(tx,ctx,entityId,query)),
 post_accounts:async(tx,ctx,{entityId,body})=>created(await ledger.createAccount(tx,ctx,entityId,body)),
 get_accounts:async(tx,ctx,{entityId,query})=>list(await ledger.listAccounts(tx,ctx,entityId,query)),
 get_accounts_id:async(tx,ctx,{entityId,params})=>ok(await ledger.getAccount(tx,ctx,entityId,params.id)),
 patch_accounts_id:async(tx,ctx,{entityId,params,body,version})=>ok(await ledger.updateAccount(tx,ctx,entityId,params.id,version,body)),
 post_journals:async(tx,ctx,{entityId,body})=>created(await ledger.createJournal(tx,ctx,entityId,body)),
 get_journals:async(tx,ctx,{entityId,query})=>list(await ledger.listJournals(tx,ctx,entityId,query)),
 get_journals_id:async(tx,ctx,{entityId,params})=>ok(await ledger.getJournal(tx,ctx,entityId,params.id)),
 patch_journals_id:async(tx,ctx,{entityId,params,body,version})=>ok(await ledger.updateJournal(tx,ctx,entityId,params.id,version,body)),
 post_journals_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await ledger.submitJournal(tx,ctx,entityId,params.id,body,version)),
 post_journals_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await ledger.approveJournal(tx,ctx,entityId,params.id,body,version)),
 post_journals_id_post:async(tx,ctx,{entityId,params,body,version})=>{const r=await ledger.postJournal(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds}};},
 post_journals_id_reverse:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await ledger.reverseJournal(tx,ctx,entityId,params.id,body,version)),
 post_periods:async(tx,ctx,{entityId,body})=>created(await ledger.createPeriod(tx,ctx,entityId,body)),
 get_periods:async(tx,ctx,{entityId,query})=>list(await ledger.listPeriods(tx,ctx,entityId,query)),
 get_periods_id:async(tx,ctx,{entityId,params})=>ok(await ledger.getPeriod(tx,ctx,entityId,params.id)),
 patch_periods_id:async(tx,ctx,{entityId,params,body,version})=>ok(await ledger.updatePeriod(tx,ctx,entityId,params.id,version,body)),
 post_periods_id_soft_close:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await ledger.softClosePeriod(tx,ctx,entityId,params.id,body,version,{feeds})),
 post_periods_id_lock:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await ledger.lockPeriod(tx,ctx,entityId,params.id,body,version,{feeds})),
 post_periods_id_reopen:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await ledger.reopenPeriod(tx,ctx,entityId,params.id,body,version)),
 get_periods_id_close_tasks:async(tx,ctx,{entityId,params,query})=>list(await ledger.listCloseTasks(tx,ctx,entityId,params.id,query)),
 post_periods_id_close_tasks:async(tx,ctx,{entityId,params,body})=>created(await ledger.addCloseTask(tx,ctx,entityId,params.id,body)),
 post_close_tasks_id_complete:async(tx,ctx,{entityId,params,body,version})=>{const r=await ledger.completeCloseTask(tx,ctx,entityId,params.id,{evidenceId:(body.evidenceIds||[])[0],waiverReason:(body.evidenceIds||[]).length?undefined:body.reason},version);return result(ctx,r);},
 post_imports:async(tx,ctx,{entityId,body})=>created(await ledger.createImport(tx,ctx,entityId,body,{sourceFeed})),
 get_imports:async(tx,ctx,{entityId,query})=>list(await ledger.listImports(tx,ctx,entityId,query)),
 get_imports_id:async(tx,ctx,{entityId,params})=>ok(await ledger.getImport(tx,ctx,entityId,params.id)),
 patch_imports_id:async(tx,ctx,{entityId,params,body,version})=>ok(await ledger.updateImport(tx,ctx,entityId,params.id,version,body)),
 post_imports_id_validate:async(tx,ctx,{entityId,params,body,version,store})=>result(ctx,await ledger.validateImport(tx,ctx,entityId,params.id,body,version,{store,bankStatement,sourceFeed})),
 post_imports_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await ledger.approveImport(tx,ctx,entityId,params.id,body,version,{sourceFeed})),
 post_imports_id_commit:async(tx,ctx,{entityId,params,body,version,store})=>{const r=await ledger.commitImport(tx,ctx,entityId,params.id,body,version,{store,bankStatement,sourceFeed});return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds}};},
 // Reports run as jobs: the worker rechecks the requester, snapshots the report and stores the rendered file as restricted evidence.
 post_reports:async(tx,ctx,{entityId,body})=>{
  if(!ctx.permissions.has('report.generate'))fail('FORBIDDEN','Permission report.generate is required.');
  if(!['trial_balance','statements','aging','ap_aging','bank_reconciliation','branch_rollup','institution_tax','feed_reconciliation','inventory_valuation','asset_register'].includes(body.reportType))fail('FEATURE_NOT_ENABLED','Report type '+body.reportType+' arrives with a later module.');
  const job=await enqueueJob(tx,ctx,{entityId,kind:'report.generate',payload:body});
  return {status:202,body:{id:job.id,state:job.state,statusUrl:'/v1/jobs/'+job.id,traceId:ctx.traceId,resultResourceType:null,resultResourceId:null}};},
 // P04 sales: tax rules, invoices and credit notes, sales orders and quotations, collections, allocations, open items.
 post_tax_rules:async(tx,ctx,{entityId,body})=>created(await sales.createTaxRule(tx,ctx,entityId,body,{goldenCases:accountingCases})),
 get_tax_rules:async(tx,ctx,{entityId,query})=>list(await sales.listTaxRules(tx,ctx,entityId,query)),
 get_tax_rules_id:async(tx,ctx,{entityId,params})=>ok(await sales.getTaxRule(tx,ctx,entityId,params.id)),
 patch_tax_rules_id:async(tx,ctx,{entityId,params,body,version})=>ok(await sales.updateTaxRule(tx,ctx,entityId,params.id,version,body,{goldenCases:accountingCases})),
 post_tax_rules_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.approveTaxRule(tx,ctx,entityId,params.id,body,version)),
 post_tax_rules_id_activate:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.activateTaxRule(tx,ctx,entityId,params.id,body,version)),
 post_invoices:async(tx,ctx,{entityId,body})=>{if(!['invoice','credit_note'].includes(body.kind))fail('VALIDATION_FAILED','This operation creates invoices and credit notes.',{fieldErrors:[{path:'kind',message:'invoice or credit_note'}]});return created(await sales.createDocument(tx,ctx,entityId,body));},
 get_invoices:async(tx,ctx,{entityId,query})=>list(await sales.listDocuments(tx,ctx,entityId,query,{kinds:['invoice','credit_note']})),
 get_invoices_id:async(tx,ctx,{entityId,params})=>ok(await sales.getDocument(tx,ctx,entityId,params.id,{kinds:['invoice','credit_note']})),
 patch_invoices_id:async(tx,ctx,{entityId,params,body,version})=>ok(await sales.updateDocument(tx,ctx,entityId,params.id,version,body)),
 post_invoices_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.submitDocument(tx,ctx,entityId,params.id,body,version)),
 post_invoices_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.approveDocument(tx,ctx,entityId,params.id,body,version)),
 post_invoices_id_post:async(tx,ctx,{entityId,params,body,version})=>{const r=await sales.postDocument(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds||[]}};},
 post_invoices_id_correct:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.correctDocument(tx,ctx,entityId,params.id,body,version)),
 post_invoices_id_deliver:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.deliverDocument(tx,ctx,entityId,params.id,body,version)),
 post_sales_orders:async(tx,ctx,{entityId,body})=>{if(!['sales_order','quotation'].includes(body.kind))fail('VALIDATION_FAILED','This operation creates sales orders and quotations.',{fieldErrors:[{path:'kind',message:'sales_order or quotation'}]});return created(await sales.createDocument(tx,ctx,entityId,body));},
 get_sales_orders:async(tx,ctx,{entityId,query})=>list(await sales.listDocuments(tx,ctx,entityId,query,{kinds:['sales_order','quotation']})),
 get_sales_orders_id:async(tx,ctx,{entityId,params})=>ok(await sales.getDocument(tx,ctx,entityId,params.id,{kinds:['sales_order','quotation']})),
 patch_sales_orders_id:async(tx,ctx,{entityId,params,body,version})=>ok(await sales.updateDocument(tx,ctx,entityId,params.id,version,body)),
 post_sales_orders_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.submitDocument(tx,ctx,entityId,params.id,body,version)),
 post_sales_orders_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.approveDocument(tx,ctx,entityId,params.id,body,version)),
 post_sales_orders_id_convert:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.convertDocument(tx,ctx,entityId,params.id,body,version)),
 post_collections:async(tx,ctx,{entityId,body})=>created(await sales.createCollection(tx,ctx,entityId,body)),
 get_collections:async(tx,ctx,{entityId,query})=>list(await sales.listCollections(tx,ctx,entityId,query)),
 get_collections_id:async(tx,ctx,{entityId,params})=>ok(await sales.getCollection(tx,ctx,entityId,params.id)),
 patch_collections_id:async(tx,ctx,{entityId,params,body,version})=>ok(await sales.updateCollection(tx,ctx,entityId,params.id,version,body)),
 post_collections_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.submitCollection(tx,ctx,entityId,params.id,body,version)),
 post_collections_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.approveCollection(tx,ctx,entityId,params.id,body,version)),
 post_collections_id_post:async(tx,ctx,{entityId,params,body,version})=>{const r=await sales.postCollection(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds||[]}};},
 post_collections_id_reverse:async(tx,ctx,{entityId,params,body,version})=>{const r=await sales.reverseCollection(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds||[]}};},
 post_collections_id_allocations:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await sales.allocateCollection(tx,ctx,entityId,params.id,body,version)),
 post_allocations_id_reverse:async(tx,ctx,{entityId,params,body})=>result(ctx,await sales.reverseAllocation(tx,ctx,entityId,params.id,body)),
 get_open_items:async(tx,ctx,{entityId,query})=>list(await sales.listOpenItems(tx,ctx,entityId,query)),
});
// P05 purchasing: bills and supplier credits, purchase orders, expense claims, payment proposals and payment orders.
const posting=(ctx,r)=>({status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds||[]}});
const family=(kinds,label)=>(tx,ctx,{entityId,body})=>{if(!kinds.includes(body.kind))fail('VALIDATION_FAILED','This operation creates '+label+'.',{fieldErrors:[{path:'kind',message:kinds.join(' or ')}]});return purchasing.createDocument(tx,ctx,entityId,body).then(created);};
Object.assign(handlers,{
 post_bills:family(['bill'],'bills'),
 get_bills:async(tx,ctx,{entityId,query})=>list(await purchasing.listDocuments(tx,ctx,entityId,query,{kinds:['bill','credit_note']})),
 get_bills_id:async(tx,ctx,{entityId,params})=>ok(await purchasing.getDocument(tx,ctx,entityId,params.id,{kinds:['bill','credit_note']})),
 patch_bills_id:async(tx,ctx,{entityId,params,body,version})=>ok(await purchasing.updateDocument(tx,ctx,entityId,params.id,version,body)),
 post_bills_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.submitDocument(tx,ctx,entityId,params.id,body,version)),
 post_bills_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.approveDocument(tx,ctx,entityId,params.id,body,version)),
 post_bills_id_post:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await purchasing.postDocument(tx,ctx,entityId,params.id,body,version)),
 post_bills_id_correct:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.correctDocument(tx,ctx,entityId,params.id,body,version)),
 post_purchase_orders:family(['purchase_order'],'purchase orders'),
 get_purchase_orders:async(tx,ctx,{entityId,query})=>list(await purchasing.listDocuments(tx,ctx,entityId,query,{kinds:['purchase_order']})),
 get_purchase_orders_id:async(tx,ctx,{entityId,params})=>ok(await purchasing.getDocument(tx,ctx,entityId,params.id,{kinds:['purchase_order']})),
 patch_purchase_orders_id:async(tx,ctx,{entityId,params,body,version})=>ok(await purchasing.updateDocument(tx,ctx,entityId,params.id,version,body)),
 post_purchase_orders_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.submitDocument(tx,ctx,entityId,params.id,body,version)),
 post_purchase_orders_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.approveDocument(tx,ctx,entityId,params.id,body,version)),
 post_purchase_orders_id_cancel:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.cancelDocument(tx,ctx,entityId,params.id,body,version)),
 post_expense_claims:family(['expense_claim'],'expense claims'),
 get_expense_claims:async(tx,ctx,{entityId,query})=>list(await purchasing.listDocuments(tx,ctx,entityId,query,{kinds:['expense_claim']})),
 get_expense_claims_id:async(tx,ctx,{entityId,params})=>ok(await purchasing.getDocument(tx,ctx,entityId,params.id,{kinds:['expense_claim']})),
 patch_expense_claims_id:async(tx,ctx,{entityId,params,body,version})=>ok(await purchasing.updateDocument(tx,ctx,entityId,params.id,version,body)),
 post_expense_claims_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.submitDocument(tx,ctx,entityId,params.id,body,version)),
 post_expense_claims_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.approveDocument(tx,ctx,entityId,params.id,body,version)),
 post_expense_claims_id_post:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await purchasing.postDocument(tx,ctx,entityId,params.id,body,version)),
 post_settlements:async(tx,ctx,{entityId,body})=>created(await purchasing.createSettlement(tx,ctx,entityId,body)),
 get_settlements:async(tx,ctx,{entityId,query})=>list(await purchasing.listSettlements(tx,ctx,entityId,query)),
 get_settlements_id:async(tx,ctx,{entityId,params})=>ok(await purchasing.getSettlement(tx,ctx,entityId,params.id)),
 patch_settlements_id:async(tx,ctx,{entityId,params,body,version})=>ok(await purchasing.updateSettlement(tx,ctx,entityId,params.id,version,body)),
 post_settlements_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.submitSettlement(tx,ctx,entityId,params.id,body,version)),
 post_payments:async(tx,ctx,{entityId,body})=>created(await purchasing.createPayment(tx,ctx,entityId,body)),
 get_payments:async(tx,ctx,{entityId,query})=>list(await purchasing.listPayments(tx,ctx,entityId,query)),
 get_payments_id:async(tx,ctx,{entityId,params})=>ok(await purchasing.getPayment(tx,ctx,entityId,params.id)),
 patch_payments_id:async(tx,ctx,{entityId,params,body,version})=>ok(await purchasing.updatePayment(tx,ctx,entityId,params.id,version,body)),
 post_payments_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.submitPayment(tx,ctx,entityId,params.id,body,version)),
 post_payments_id_authorize:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await purchasing.authorizePayment(tx,ctx,entityId,params.id,body,version)),
 post_payments_id_release:async(tx,ctx,{entityId,params,body,version,store})=>result(ctx,await purchasing.releasePayment(tx,ctx,entityId,params.id,body,version,{bankFile:treasury.generateBankFile,store})),
 post_payments_id_settle:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await purchasing.settlePayment(tx,ctx,entityId,params.id,body,version)),
 post_payments_id_return:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await purchasing.returnPayment(tx,ctx,entityId,params.id,body,version)),
});
// P06 treasury: bank accounts, statement lines and reconciliation, matches, transfers, checks, cash sessions.
Object.assign(handlers,{
 post_bank_accounts:async(tx,ctx,{entityId,body})=>created(await treasury.createBankAccount(tx,ctx,entityId,body)),
 get_bank_accounts:async(tx,ctx,{entityId,query})=>list(await treasury.listBankAccounts(tx,ctx,entityId,query)),
 get_bank_accounts_id:async(tx,ctx,{entityId,params})=>ok(await treasury.getBankAccount(tx,ctx,entityId,params.id)),
 patch_bank_accounts_id:async(tx,ctx,{entityId,params,body,version})=>ok(await treasury.updateBankAccount(tx,ctx,entityId,params.id,version,body)),
 post_bank_accounts_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.approveBankAccount(tx,ctx,entityId,params.id,body,version)),
 get_bank_statement_lines:async(tx,ctx,{entityId,query})=>{if(!isUuid(query.bankAccountId))fail('VALIDATION_FAILED','bankAccountId is required.',{fieldErrors:[{path:'bankAccountId',message:'UUID'}]});return list({items:await treasury.listStatementLines(tx,ctx,entityId,{bankAccountId:query.bankAccountId,matchState:query.matchState||null}),nextCursor:null});},
 get_bank_reconciliation:async(tx,ctx,{entityId,query})=>{if(!isUuid(query.bankAccountId)||!/^\d{4}-\d{2}-\d{2}$/.test(query.asOf||''))fail('VALIDATION_FAILED','bankAccountId and asOf are required.',{fieldErrors:[{path:'asOf',message:'Date'}]});return {status:200,body:await treasury.reconciliationReport(tx,ctx,entityId,{bankAccountId:query.bankAccountId,asOf:query.asOf})};},
 post_bank_matches:async(tx,ctx,{entityId,body})=>created(await treasury.createMatch(tx,ctx,entityId,body)),
 get_bank_matches:async(tx,ctx,{entityId,query})=>list(await treasury.listMatches(tx,ctx,entityId,query)),
 get_bank_matches_id:async(tx,ctx,{entityId,params})=>ok(await treasury.getMatch(tx,ctx,entityId,params.id)),
 patch_bank_matches_id:async(tx,ctx,{entityId,params,body,version})=>ok(await treasury.updateMatch(tx,ctx,entityId,params.id,version,body)),
 post_bank_matches_id_confirm:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.confirmMatch(tx,ctx,entityId,params.id,body,version)),
 post_bank_matches_id_reverse:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.reverseMatch(tx,ctx,entityId,params.id,body,version)),
 post_transfers:async(tx,ctx,{entityId,body})=>created(await treasury.createTransfer(tx,ctx,entityId,body)),
 get_transfers:async(tx,ctx,{entityId,query})=>list(await treasury.listTransfers(tx,ctx,entityId,query)),
 get_transfers_id:async(tx,ctx,{entityId,params})=>ok(await treasury.getTransfer(tx,ctx,entityId,params.id)),
 patch_transfers_id:async(tx,ctx,{entityId,params,body,version})=>ok(await treasury.updateTransfer(tx,ctx,entityId,params.id,version,body)),
 post_transfers_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.submitTransfer(tx,ctx,entityId,params.id,body,version)),
 post_transfers_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.approveTransfer(tx,ctx,entityId,params.id,body,version)),
 post_transfers_id_post:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await treasury.postTransfer(tx,ctx,entityId,params.id,body,version)),
 post_checks:async(tx,ctx,{entityId,body})=>created(await treasury.createCheck(tx,ctx,entityId,body)),
 get_checks:async(tx,ctx,{entityId,query})=>list(await treasury.listChecks(tx,ctx,entityId,query)),
 get_checks_id:async(tx,ctx,{entityId,params})=>ok(await treasury.getCheck(tx,ctx,entityId,params.id)),
 patch_checks_id:async(tx,ctx,{entityId,params,body,version})=>ok(await treasury.updateCheck(tx,ctx,entityId,params.id,version,body)),
 post_checks_id_release:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.releaseCheck(tx,ctx,entityId,params.id,body,version)),
 post_checks_id_deposit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.depositCheck(tx,ctx,entityId,params.id,body,version)),
 post_checks_id_clear:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.clearCheck(tx,ctx,entityId,params.id,body,version)),
 post_checks_id_dishonor:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await treasury.dishonorCheck(tx,ctx,entityId,params.id,body,version,{reverseSettlement:sales.reverseSettlementEffect})),
 post_cash_sessions:async(tx,ctx,{entityId,body})=>created(await treasury.createCashSession(tx,ctx,entityId,body)),
 get_cash_sessions:async(tx,ctx,{entityId,query})=>list(await treasury.listCashSessions(tx,ctx,entityId,query)),
 get_cash_sessions_id:async(tx,ctx,{entityId,params})=>ok(await treasury.getCashSession(tx,ctx,entityId,params.id)),
 patch_cash_sessions_id:async(tx,ctx,{entityId,params,body,version})=>ok(await treasury.updateCashSession(tx,ctx,entityId,params.id,version,body)),
 post_cash_sessions_id_count:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.countCashSession(tx,ctx,entityId,params.id,body,version)),
 post_cash_sessions_id_close:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await treasury.closeCashSession(tx,ctx,entityId,params.id,body,version)),
 post_cash_sessions_id_handover:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await treasury.handoverCashSession(tx,ctx,entityId,params.id,body,version)),
});
// P07 compliance: return runs, transmissions and registration packs.
const jobBody=(ctx,job)=>({status:202,body:{id:job.id,state:job.state,statusUrl:'/v1/jobs/'+job.id,traceId:ctx.traceId,resultResourceType:null,resultResourceId:null}});
Object.assign(handlers,{
 post_returns:async(tx,ctx,{entityId,body})=>created(await compliance.createReturn(tx,ctx,entityId,body)),
 get_returns:async(tx,ctx,{entityId,query})=>list(await compliance.listReturns(tx,ctx,entityId,query)),
 get_returns_id:async(tx,ctx,{entityId,params})=>ok(await compliance.getReturn(tx,ctx,entityId,params.id)),
 get_returns_id_lines:async(tx,ctx,{entityId,params})=>({status:200,body:await compliance.returnLines(tx,ctx,entityId,params.id)}),
 patch_returns_id:async(tx,ctx,{entityId,params,body,version})=>ok(await compliance.updateReturn(tx,ctx,entityId,params.id,version,body)),
 post_returns_id_prepare:async(tx,ctx,{entityId,params,body,version,store})=>result(ctx,await compliance.prepareReturn(tx,ctx,entityId,params.id,body,version,{store})),
 post_returns_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await compliance.approveReturn(tx,ctx,entityId,params.id,body,version)),
 post_returns_id_filed:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await compliance.fileReturn(tx,ctx,entityId,params.id,body,version)),
 get_transmissions_id:async(tx,ctx,{entityId,params})=>ok(await compliance.getTransmission(tx,ctx,entityId,params.id)),
 get_transmissions:async(tx,ctx,{entityId,query})=>list({items:await compliance.listTransmissions(tx,ctx,entityId,{state:query.state||null,documentId:isUuid(query.documentId)?query.documentId:null}),nextCursor:null}),
 get_compliance_readiness:async(tx,ctx,{entityId})=>({status:200,body:await compliance.readiness(tx,ctx,entityId,process.env)}),
 post_transmissions_id_reconcile:async(tx,ctx,{entityId,params,body})=>jobBody(ctx,await compliance.requestReconcile(tx,ctx,entityId,params.id,body)),
 // P10 inventory costing and three-way matching
 get_warehouses:async(tx,ctx,{entityId,query})=>list(await inventory.listWarehouses(tx,ctx,entityId,query)),
 post_items:async(tx,ctx,{entityId,body})=>created(await inventory.createItem(tx,ctx,entityId,body)),
 get_items:async(tx,ctx,{entityId,query})=>list(await inventory.listItems(tx,ctx,entityId,query)),
 get_items_id:async(tx,ctx,{entityId,params})=>ok(await inventory.getItem(tx,ctx,entityId,params.id)),
 patch_items_id:async(tx,ctx,{entityId,params,body,version})=>ok(await inventory.updateItem(tx,ctx,entityId,params.id,version,body)),
 post_stock_movements:async(tx,ctx,{entityId,body})=>created(await inventory.createMovement(tx,ctx,entityId,body)),
 get_stock_movements:async(tx,ctx,{entityId,query})=>list(await inventory.listMovements(tx,ctx,entityId,query)),
 get_stock_movements_id:async(tx,ctx,{entityId,params})=>ok(await inventory.getMovement(tx,ctx,entityId,params.id)),
 get_stock_movements_id_recost:async(tx,ctx,{entityId,params})=>({status:200,body:await inventory.recostPreview(tx,ctx,entityId,params.id)}),
 patch_stock_movements_id:async(tx,ctx,{entityId,params,body,version})=>ok(await inventory.updateMovement(tx,ctx,entityId,params.id,version,body)),
 post_stock_movements_id_submit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await inventory.submitMovement(tx,ctx,entityId,params.id,body,version)),
 post_stock_movements_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await inventory.approveMovement(tx,ctx,entityId,params.id,body,version)),
 post_stock_movements_id_post:async(tx,ctx,{entityId,params,body,version})=>{const r=await inventory.postMovement(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds}};},
 get_stock_card:async(tx,ctx,{entityId,query})=>({status:200,body:await inventory.stockCard(tx,ctx,entityId,{itemId:query.itemId,warehouseId:query.warehouseId||null})}),
 get_inventory_valuation:async(tx,ctx,{entityId,query})=>({status:200,body:await inventory.inventoryValuation(tx,ctx,entityId,{bookId:query.bookId,asOf:query.asOf})}),
 post_stock_counts:async(tx,ctx,{entityId,body})=>created(await inventory.createCount(tx,ctx,entityId,body)),
 get_stock_counts:async(tx,ctx,{entityId,query})=>list(await inventory.listCounts(tx,ctx,entityId,query)),
 get_stock_counts_id:async(tx,ctx,{entityId,params})=>ok(await inventory.getCount(tx,ctx,entityId,params.id)),
 get_stock_counts_id_lines:async(tx,ctx,{entityId,params})=>({status:200,body:await inventory.countLines(tx,ctx,entityId,params.id)}),
 patch_stock_counts_id:async(tx,ctx,{entityId,params,body,version})=>ok(await inventory.updateCount(tx,ctx,entityId,params.id,version,body)),
 post_stock_counts_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await inventory.approveCount(tx,ctx,entityId,params.id,body,version)),
 post_stock_counts_id_post:async(tx,ctx,{entityId,params,body,version})=>{const r=await inventory.postCount(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds}};},
 post_landed_costs:async(tx,ctx,{entityId,body})=>created(await inventory.createLandedCost(tx,ctx,entityId,body)),
 get_landed_costs:async(tx,ctx,{entityId,query})=>list(await inventory.listLandedCosts(tx,ctx,entityId,query)),
 get_landed_costs_id:async(tx,ctx,{entityId,params})=>ok(await inventory.getLandedCost(tx,ctx,entityId,params.id)),
 get_landed_costs_id_lines:async(tx,ctx,{entityId,params})=>({status:200,body:await inventory.landedCostPreview(tx,ctx,entityId,params.id)}),
 patch_landed_costs_id:async(tx,ctx,{entityId,params,body,version})=>ok(await inventory.updateLandedCost(tx,ctx,entityId,params.id,version,body)),
 post_landed_costs_id_preview:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await inventory.previewLandedCost(tx,ctx,entityId,params.id,body,version)),
 post_landed_costs_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await inventory.approveLandedCost(tx,ctx,entityId,params.id,body,version)),
 post_landed_costs_id_post:async(tx,ctx,{entityId,params,body,version})=>{const r=await inventory.postLandedCost(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds}};},
 // P11 assets, recurring work and recognition schedules
 get_asset_classes:async(tx,ctx,{entityId,query})=>list(await assets.listAssetClasses(tx,ctx,entityId,query)),
 post_assets:async(tx,ctx,{entityId,body})=>created(await assets.createAsset(tx,ctx,entityId,body)),
 get_assets:async(tx,ctx,{entityId,query})=>list(await assets.listAssets(tx,ctx,entityId,query)),
 get_assets_id:async(tx,ctx,{entityId,params})=>ok(await assets.getAsset(tx,ctx,entityId,params.id)),
 patch_assets_id:async(tx,ctx,{entityId,params,body,version})=>ok(await assets.updateAsset(tx,ctx,entityId,params.id,version,body)),
 post_assets_id_approve:async(tx,ctx,{entityId,params,body,version})=>{const r=await assets.approveAsset(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds}};},
 post_assets_id_events:async(tx,ctx,{entityId,params,body,version})=>{const r=await assets.recordAssetEvent(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds}};},
 get_assets_id_events:async(tx,ctx,{entityId,params})=>({status:200,body:await assets.assetEvents(tx,ctx,entityId,params.id)}),
 get_assets_id_layers:async(tx,ctx,{entityId,params})=>({status:200,body:await assets.bookTaxLayers(tx,ctx,entityId,params.id)}),
 post_schedules:async(tx,ctx,{entityId,body})=>created(await assets.createSchedule(tx,ctx,entityId,body)),
 get_schedules:async(tx,ctx,{entityId,query})=>list(await assets.listSchedules(tx,ctx,entityId,query)),
 get_schedules_id:async(tx,ctx,{entityId,params})=>ok(await assets.getSchedule(tx,ctx,entityId,params.id)),
 get_schedules_id_lines:async(tx,ctx,{entityId,params})=>({status:200,body:await assets.scheduleLines(tx,ctx,entityId,params.id)}),
 patch_schedules_id:async(tx,ctx,{entityId,params,body,version})=>ok(await assets.updateSchedule(tx,ctx,entityId,params.id,version,body)),
 post_schedules_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await assets.approveSchedule(tx,ctx,entityId,params.id,body,version)),
 post_schedules_id_pause:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await assets.pauseSchedule(tx,ctx,entityId,params.id,body,version)),
 post_schedule_runs:async(tx,ctx,{entityId,body})=>jobBody(ctx,await assets.requestScheduleRun(tx,ctx,entityId,body)),
 get_schedule_runs:async(tx,ctx,{entityId,query})=>list(await assets.listScheduleRuns(tx,ctx,entityId,query)),
 // P12 evidence-backed AI assistance: runs are jobs; suggestions are reviewed by a named principal; nothing here posts.
 post_assistant_runs:async(tx,ctx,{entityId,body})=>jobBody(ctx,await assistant.requestRun(tx,ctx,entityId,body)),
 get_assistant_runs:async(tx,ctx,{entityId,query})=>list(await assistant.listRuns(tx,ctx,entityId,query)),
 get_assistant_runs_id:async(tx,ctx,{entityId,params})=>ok(await assistant.getRun(tx,ctx,entityId,params.id)),
 get_assistant_suggestions:async(tx,ctx,{entityId,query})=>list(await assistant.listSuggestions(tx,ctx,entityId,query)),
 get_assistant_suggestions_id:async(tx,ctx,{entityId,params})=>ok(await assistant.getSuggestion(tx,ctx,entityId,params.id)),
 post_assistant_suggestions_id_review:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await assistant.reviewSuggestion(tx,ctx,entityId,params.id,body,version)),
 get_assistant_features:async(tx,ctx,{entityId})=>list(await assistant.listFeatures(tx,ctx,entityId)),
 patch_assistant_features_feature:async(tx,ctx,{entityId,params,body,version})=>ok(await assistant.updateFeature(tx,ctx,entityId,params.feature,version,body)),
 // P13 portals and messaging: invites, memberships, messages authorized by a named principal and sent once, payment links whose settlement comes from verified provider events.
 post_portal_invites:async(tx,ctx,{entityId,body})=>created(await portals.createInvite(tx,ctx,entityId,body)),
 get_portal_invites:async(tx,ctx,{entityId,query})=>list(await portals.listInvites(tx,ctx,entityId,query)),
 get_portal_invites_id:async(tx,ctx,{entityId,params})=>ok(await portals.getInvite(tx,ctx,entityId,params.id)),
 patch_portal_invites_id:async(tx,ctx,{entityId,params,body,version})=>ok(await portals.updateInvite(tx,ctx,entityId,params.id,version,body)),
 post_portal_invites_id_revoke:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await portals.revokeInvite(tx,ctx,entityId,params.id,body,version)),
 get_portal_memberships:async(tx,ctx,{entityId,query})=>list(await portals.listMemberships(tx,ctx,entityId,query)),
 get_portal_me:async(tx,ctx,{entityId})=>({status:200,body:await portals.portalMe(tx,ctx,entityId)}),
 get_certificates:async(tx,ctx,{entityId,query})=>list({items:await purchasing.listCertificates(tx,ctx,entityId,{partyId:isUuid(query.partyId)?query.partyId:null}),nextCursor:null}),
 post_message_requests:async(tx,ctx,{entityId,body})=>created(await portals.createMessage(tx,ctx,entityId,body)),
 get_message_requests:async(tx,ctx,{entityId,query})=>list(await portals.listMessages(tx,ctx,entityId,query)),
 get_message_requests_id:async(tx,ctx,{entityId,params})=>ok(await portals.getMessage(tx,ctx,entityId,params.id)),
 get_message_requests_id_receipts:async(tx,ctx,{entityId,params})=>({status:200,body:await portals.listReceipts(tx,ctx,entityId,params.id)}),
 patch_message_requests_id:async(tx,ctx,{entityId,params,body,version})=>ok(await portals.updateMessage(tx,ctx,entityId,params.id,version,body)),
 post_message_requests_id_send:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await portals.sendMessage(tx,ctx,entityId,params.id,body,version)),
 post_payment_links:async(tx,ctx,{entityId,body,providers})=>created(await portals.createPaymentLink(tx,ctx,entityId,body,{provider:providers.pay})),
 get_payment_links:async(tx,ctx,{entityId,query})=>list(await portals.listPaymentLinks(tx,ctx,entityId,query)),
 get_payment_links_id:async(tx,ctx,{entityId,params})=>ok(await portals.getPaymentLink(tx,ctx,entityId,params.id)),
 patch_payment_links_id:async(tx,ctx,{entityId,params,body,version})=>ok(await portals.updatePaymentLink(tx,ctx,entityId,params.id,version,body)),
 post_payment_links_id_cancel:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await portals.cancelPaymentLink(tx,ctx,entityId,params.id,body,version)),
 post_payment_links_id_claim:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await portals.claimPayment(tx,ctx,entityId,params.id,body,version)),
 get_webhook_receipts:async(tx,ctx,{entityId,query})=>list({items:await portals.listWebhookReceipts(tx,ctx,entityId,{provider:query.provider||null}),nextCursor:null}),
 // P14 accounting firm multi-client workspace: firm records and staff in the firm tenant; mandates and assignments in each client tenant; scopes and roll-ups through the restricted functions.
 post_firms:async(tx,ctx,{body})=>created(await firm.createFirm(tx,ctx,body)),
 get_firms:async(tx,ctx)=>list(await firm.listFirms(tx,ctx)),
 post_firms_id_staff:async(tx,ctx,{params,body})=>created(await firm.addStaff(tx,ctx,params.id,body)),
 get_firms_id_staff:async(tx,ctx,{params})=>list(await firm.listStaff(tx,ctx,params.id)),
 get_firm_clients:async(tx,ctx)=>list(await firm.clientScopes(tx,ctx)),
 get_firm_rollup:async(tx,ctx)=>({status:200,body:await firm.rollup(tx,ctx)}),
 get_firm_snapshots:async(tx,ctx)=>list(await firm.listSnapshots(tx,ctx)),
 post_firm_bulk_reminders:async(tx,ctx,{body})=>{const {firmId,...result}=await firm.bulkReminders(tx,ctx,body,{portals});return {status:200,body:result,resourceType:'firm',resourceId:firmId};},
 post_firm_mandates:async(tx,ctx,{entityId,body})=>created(await firm.createMandate(tx,ctx,entityId,body)),
 get_firm_mandates:async(tx,ctx,{entityId,query})=>list(await firm.listMandates(tx,ctx,entityId,query)),
 get_firm_mandates_id:async(tx,ctx,{entityId,params})=>ok(await firm.getMandate(tx,ctx,entityId,params.id)),
 patch_firm_mandates_id:async(tx,ctx,{entityId,params,body,version})=>ok(await firm.updateMandate(tx,ctx,entityId,params.id,version,body)),
 post_firm_mandates_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await firm.approveMandate(tx,ctx,entityId,params.id,body,version)),
 post_firm_mandates_id_revoke:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await firm.revokeMandate(tx,ctx,entityId,params.id,body,version)),
 post_firm_assignments:async(tx,ctx,{entityId,body})=>created(await firm.createAssignment(tx,ctx,entityId,body)),
 get_firm_assignments:async(tx,ctx,{entityId,query})=>list(await firm.listAssignments(tx,ctx,entityId,query)),
 get_firm_assignments_id:async(tx,ctx,{entityId,params})=>ok(await firm.getAssignment(tx,ctx,entityId,params.id)),
 patch_firm_assignments_id:async(tx,ctx,{entityId,params,body,version})=>ok(await firm.updateAssignment(tx,ctx,entityId,params.id,version,body)),
 // P15 intercompany and consolidation: the group and its reporting book in the parent entity; pairs accepted and posted under each entity's own authority; runs from approved member snapshots.
 post_groups:async(tx,ctx,{entityId,body})=>created(await consolidation.createGroup(tx,ctx,entityId,body)),
 get_groups:async(tx,ctx,{entityId,query})=>list(await consolidation.listGroups(tx,ctx,entityId,query)),
 get_groups_id:async(tx,ctx,{entityId,params})=>ok(await consolidation.getGroup(tx,ctx,entityId,params.id)),
 patch_groups_id:async(tx,ctx,{entityId,params,body,version})=>ok(await consolidation.updateGroup(tx,ctx,entityId,params.id,version,body)),
 post_groups_id_activate:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await consolidation.activateGroup(tx,ctx,entityId,params.id,body,version)),
 post_groups_id_mappings:async(tx,ctx,{entityId,params,body})=>created(await consolidation.createMapping(tx,ctx,entityId,params.id,body)),
 get_groups_id_mappings:async(tx,ctx,{entityId,params})=>list(await consolidation.listMappings(tx,ctx,entityId,params.id)),
 post_group_mappings_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await consolidation.approveMapping(tx,ctx,entityId,params.id,body,version)),
 post_rate_sets:async(tx,ctx,{entityId,body})=>created(await consolidation.createRateSet(tx,ctx,entityId,body)),
 get_rate_sets:async(tx,ctx,{entityId,query})=>list(await consolidation.listRateSets(tx,ctx,entityId,query)),
 get_rate_sets_id:async(tx,ctx,{entityId,params})=>ok(await consolidation.getRateSet(tx,ctx,entityId,params.id)),
 post_rate_sets_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await consolidation.approveRateSet(tx,ctx,entityId,params.id,body,version)),
 post_intercompany_pairs:async(tx,ctx,{entityId,body})=>created(await consolidation.createPair(tx,ctx,entityId,body)),
 get_intercompany_pairs:async(tx,ctx,{entityId,query})=>list(query.detail==='1'?await consolidation.listPairDetails(tx,ctx,entityId,query):await consolidation.listPairs(tx,ctx,entityId,query)),
 get_intercompany_pairs_id:async(tx,ctx,{entityId,params})=>ok(await consolidation.getPair(tx,ctx,entityId,params.id)),
 patch_intercompany_pairs_id:async(tx,ctx,{entityId,params,body,version})=>ok(await consolidation.updatePair(tx,ctx,entityId,params.id,version,body)),
 post_intercompany_pairs_id_accept:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await consolidation.acceptPair(tx,ctx,entityId,params.id,body,version)),
 post_intercompany_pairs_id_post:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await consolidation.postPair(tx,ctx,entityId,params.id,body,version)),
 post_consolidations:async(tx,ctx,{entityId,body})=>created(await consolidation.createRun(tx,ctx,entityId,body)),
 get_consolidations:async(tx,ctx,{entityId,query})=>list(query.detail==='1'?await consolidation.listRunDetails(tx,ctx,entityId,query):await consolidation.listRuns(tx,ctx,entityId,query)),
 get_consolidations_id:async(tx,ctx,{entityId,params})=>ok(await consolidation.getRun(tx,ctx,entityId,params.id)),
 patch_consolidations_id:async(tx,ctx,{entityId,params,body,version})=>ok(await consolidation.updateRun(tx,ctx,entityId,params.id,version,body)),
 post_consolidations_id_preview:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await consolidation.previewRun(tx,ctx,entityId,params.id,body,version)),
 post_consolidations_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await consolidation.approveRun(tx,ctx,entityId,params.id,body,version)),
 post_consolidations_id_publish:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await consolidation.publishRun(tx,ctx,entityId,params.id,body,version)),
 get_groups_id_readiness:async(tx,ctx,{entityId,params,query})=>({status:200,body:await consolidation.readiness(tx,ctx,entityId,params.id,{periodEnd:query.periodEnd})}),
 post_consolidations_id_eliminations:async(tx,ctx,{entityId,params,body})=>({status:201,body:await consolidation.addElimination(tx,ctx,entityId,params.id,body)}),
 get_consolidations_id_worksheet:async(tx,ctx,{entityId,params})=>({status:200,body:await consolidation.worksheet(tx,ctx,entityId,params.id)}),
 // P16 budgets, cost allocation and project accounting.
 post_budgets:async(tx,ctx,{entityId,body})=>created(await planning.createBudget(tx,ctx,entityId,body)),
 get_budgets:async(tx,ctx,{entityId,query})=>list(await planning.listBudgets(tx,ctx,entityId,query)),
 get_budgets_id:async(tx,ctx,{entityId,params})=>ok(await planning.getBudget(tx,ctx,entityId,params.id)),
 patch_budgets_id:async(tx,ctx,{entityId,params,body,version})=>ok(await planning.updateBudget(tx,ctx,entityId,params.id,version,body)),
 post_budgets_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await planning.approveBudget(tx,ctx,entityId,params.id,body,version)),
 post_budgets_id_activate:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await planning.activateBudget(tx,ctx,entityId,params.id,body,version)),
 get_budgets_id_availability:async(tx,ctx,{entityId,params})=>({status:200,body:await planning.availability(tx,ctx,entityId,params.id)}),
 get_commitments:async(tx,ctx,{entityId,query})=>list(await planning.listCommitments(tx,ctx,entityId,query)),
 post_allocation_rules:async(tx,ctx,{entityId,body})=>created(await planning.createRule(tx,ctx,entityId,body)),
 get_allocation_rules:async(tx,ctx,{entityId,query})=>list(await planning.listRules(tx,ctx,entityId,query)),
 post_allocation_rules_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await planning.approveRule(tx,ctx,entityId,params.id,body,version)),
 post_allocation_runs:async(tx,ctx,{entityId,body})=>created(await planning.createRun(tx,ctx,entityId,body)),
 get_allocation_runs:async(tx,ctx,{entityId,query})=>list(await planning.listRuns(tx,ctx,entityId,query)),
 get_allocation_runs_id:async(tx,ctx,{entityId,params})=>ok(await planning.getRun(tx,ctx,entityId,params.id)),
 patch_allocation_runs_id:async(tx,ctx,{entityId,params,body,version})=>ok(await planning.updateRun(tx,ctx,entityId,params.id,version,body)),
 post_allocation_runs_id_preview:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await planning.previewRun(tx,ctx,entityId,params.id,body,version)),
 post_allocation_runs_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await planning.approveRun(tx,ctx,entityId,params.id,body,version)),
 post_allocation_runs_id_post:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await planning.postRun(tx,ctx,entityId,params.id,body,version)),
 get_allocation_runs_id_lines:async(tx,ctx,{entityId,params})=>({status:200,body:await planning.runLines(tx,ctx,entityId,params.id)}),
 post_projects:async(tx,ctx,{entityId,body})=>{const p=await planning.createProject(tx,ctx,entityId,body);const {contractVersionId,...body_}=p;return {status:201,body:body_,etag:p.version};},
 get_projects:async(tx,ctx,{entityId,query})=>list(await planning.listProjects(tx,ctx,entityId,query)),
 get_projects_id:async(tx,ctx,{entityId,params})=>ok(await planning.getProject(tx,ctx,entityId,params.id)),
 patch_projects_id:async(tx,ctx,{entityId,params,body,version})=>ok(await planning.updateProject(tx,ctx,entityId,params.id,version,body)),
 post_projects_id_progress_billing:async(tx,ctx,{entityId,params,body})=>result(ctx,await planning.progressBilling(tx,ctx,entityId,params.id,body)),
 post_projects_id_milestones:async(tx,ctx,{entityId,params,body})=>created(await planning.createMilestone(tx,ctx,entityId,params.id,body)),
 get_projects_id_milestones:async(tx,ctx,{entityId,params})=>list(await planning.listMilestones(tx,ctx,entityId,params.id)),
 post_milestones_id_certify:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await planning.certifyMilestone(tx,ctx,entityId,params.id,body,version)),
 post_projects_id_change_orders:async(tx,ctx,{entityId,params,body})=>created(await planning.createChangeOrder(tx,ctx,entityId,params.id,body)),
 get_projects_id_change_orders:async(tx,ctx,{entityId,params})=>list(await planning.listChangeOrders(tx,ctx,entityId,params.id)),
 post_change_orders_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await planning.approveChangeOrder(tx,ctx,entityId,params.id,body,version)),
 post_projects_id_advances:async(tx,ctx,{entityId,params,body})=>created(await planning.createAdvance(tx,ctx,entityId,params.id,body)),
 get_projects_id_advances:async(tx,ctx,{entityId,params})=>list(await planning.listAdvances(tx,ctx,entityId,params.id)),
 get_projects_id_retention:async(tx,ctx,{entityId,params})=>list(await planning.listRetention(tx,ctx,entityId,params.id)),
 post_retention_items_id_release:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await planning.releaseRetention(tx,ctx,entityId,params.id,body,version)),
 get_projects_id_profitability:async(tx,ctx,{entityId,params})=>({status:200,body:await planning.profitability(tx,ctx,entityId,params.id)}),
 // P17 local operations: leases, statutory discounts, marketplace and POS, payroll data, local obligations.
 post_leases:async(tx,ctx,{entityId,body})=>created(await localops.createLease(tx,ctx,entityId,body)),
 get_leases:async(tx,ctx,{entityId,query})=>list(await localops.listLeases(tx,ctx,entityId,query)),
 get_leases_id:async(tx,ctx,{entityId,params})=>ok(await localops.getLease(tx,ctx,entityId,params.id)),
 patch_leases_id:async(tx,ctx,{entityId,params,body,version})=>ok(await localops.updateLease(tx,ctx,entityId,params.id,version,body)),
 post_leases_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.approveLease(tx,ctx,entityId,params.id,body,version)),
 get_leases_id_schedule:async(tx,ctx,{entityId,params})=>({status:200,body:await localops.leaseScheduleFor(tx,ctx,entityId,params.id)}),
 post_leases_id_events:async(tx,ctx,{entityId,params,body})=>posting(ctx,await localops.leaseEvent(tx,ctx,entityId,params.id,body)),
 get_leases_id_events:async(tx,ctx,{entityId,params})=>list(await localops.listLeaseEvents(tx,ctx,entityId,params.id)),
 post_leases_id_bill:async(tx,ctx,{entityId,params,body})=>result(ctx,await localops.billLease(tx,ctx,entityId,params.id,body)),
 post_discount_eligibility:async(tx,ctx,{entityId,body})=>created(await localops.createEligibility(tx,ctx,entityId,body,process.env)),
 get_discount_eligibility:async(tx,ctx,{entityId,query})=>list(await localops.listEligibility(tx,ctx,entityId,query)),
 get_discount_eligibility_id:async(tx,ctx,{entityId,params})=>ok(await localops.getEligibility(tx,ctx,entityId,params.id)),
 patch_discount_eligibility_id:async(tx,ctx,{entityId,params,body,version})=>ok(await localops.updateEligibility(tx,ctx,entityId,params.id,version,body)),
 post_discount_eligibility_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.approveEligibility(tx,ctx,entityId,params.id,body,version)),
 post_invoices_id_statutory_discount:async(tx,ctx,{entityId,params,body})=>result(ctx,await localops.applyDiscount(tx,ctx,entityId,params.id,body)),
 get_invoices_id_statutory_discount:async(tx,ctx,{entityId,params})=>({status:200,body:await localops.discountLines(tx,ctx,entityId,params.id)}),
 post_channels:async(tx,ctx,{entityId,body})=>created(await localops.createChannel(tx,ctx,entityId,body)),
 get_channels:async(tx,ctx,{entityId,query})=>list(await localops.listChannels(tx,ctx,entityId,query)),
 post_payouts:async(tx,ctx,{entityId,body})=>created(await localops.createPayout(tx,ctx,entityId,body)),
 get_payouts:async(tx,ctx,{entityId,query})=>list(await localops.listPayouts(tx,ctx,entityId,query)),
 get_payouts_id:async(tx,ctx,{entityId,params})=>ok(await localops.getPayout(tx,ctx,entityId,params.id)),
 post_payouts_id_reconcile:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.reconcilePayout(tx,ctx,entityId,params.id,body,version)),
 post_payouts_id_post:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await localops.postPayout(tx,ctx,entityId,params.id,body,version)),
 post_pos_machines:async(tx,ctx,{entityId,body})=>created(await localops.createMachine(tx,ctx,entityId,body)),
 get_pos_machines:async(tx,ctx,{entityId,query})=>list(await localops.listMachines(tx,ctx,entityId,query)),
 post_pos_closings:async(tx,ctx,{entityId,body})=>created(await localops.createClosing(tx,ctx,entityId,body)),
 get_pos_closings:async(tx,ctx,{entityId,query})=>list(await localops.listClosings(tx,ctx,entityId,query)),
 post_pos_closings_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.approveClosing(tx,ctx,entityId,params.id,body,version)),
 post_pos_closings_id_match:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.matchClosing(tx,ctx,entityId,params.id,body,version)),
 post_payroll_batches:async(tx,ctx,{entityId,body})=>created(await localops.importPayroll(tx,ctx,entityId,body,process.env)),
 get_payroll_batches:async(tx,ctx,{entityId,query})=>list(await localops.listBatches(tx,ctx,entityId,query)),
 get_payroll_batches_id:async(tx,ctx,{entityId,params})=>ok(await localops.getBatch(tx,ctx,entityId,params.id)),
 get_payroll_batches_id_records:async(tx,ctx,{entityId,params})=>list(await localops.batchRecords(tx,ctx,entityId,params.id)),
 post_payroll_batches_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.approveBatch(tx,ctx,entityId,params.id,body,version)),
 post_payroll_batches_id_post:async(tx,ctx,{entityId,params,body,version})=>posting(ctx,await localops.postBatch(tx,ctx,entityId,params.id,body,version)),
 post_remittances:async(tx,ctx,{entityId,body})=>created(await localops.createRemittance(tx,ctx,entityId,body)),
 get_remittances:async(tx,ctx,{entityId,query})=>list(await localops.listRemittances(tx,ctx,entityId,query)),
 post_remittances_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.approveRemittance(tx,ctx,entityId,params.id,body,version)),
 post_remittances_id_remit:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.remit(tx,ctx,entityId,params.id,body,version)),
 post_local_obligations:async(tx,ctx,{entityId,body})=>created(await localops.createObligation(tx,ctx,entityId,body)),
 get_local_obligations:async(tx,ctx,{entityId,query})=>list(await localops.listObligations(tx,ctx,entityId,query)),
 get_local_obligations_id:async(tx,ctx,{entityId,params})=>ok(await localops.getObligation(tx,ctx,entityId,params.id)),
 patch_local_obligations_id:async(tx,ctx,{entityId,params,body,version})=>ok(await localops.updateObligation(tx,ctx,entityId,params.id,version,body)),
 post_local_obligations_id_complete:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.completeObligation(tx,ctx,entityId,params.id,body,version)),
 post_local_obligations_id_waive:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await localops.waiveObligation(tx,ctx,entityId,params.id,body,version)),
 // P18 controlled extensibility: report definitions and custom fields, rule proposals, client tool grants and runs, industry packs.
 get_report_catalog:async(tx,ctx)=>({status:200,body:extensibility.catalog()}),
 post_report_definitions:async(tx,ctx,{entityId,body})=>created(await extensibility.createDefinition(tx,ctx,entityId,body)),
 get_report_definitions:async(tx,ctx,{entityId,query})=>list(await extensibility.listDefinitions(tx,ctx,entityId,query)),
 get_report_definitions_id:async(tx,ctx,{entityId,params})=>ok(await extensibility.getDefinition(tx,ctx,entityId,params.id)),
 patch_report_definitions_id:async(tx,ctx,{entityId,params,body,version})=>ok(await extensibility.updateDefinition(tx,ctx,entityId,params.id,version,body)),
 post_report_definitions_id_publish:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await extensibility.publishDefinition(tx,ctx,entityId,params.id,body,version)),
 post_report_definitions_id_run:async(tx,ctx,{entityId,params,body})=>{const r=await extensibility.runDefinition(tx,ctx,entityId,params.id,body);return {status:200,body:r,resourceType:'report_run',resourceId:r.runId};},
 post_custom_fields:async(tx,ctx,{entityId,body})=>created(await extensibility.createCustomField(tx,ctx,entityId,body)),
 get_custom_fields:async(tx,ctx,{entityId,query})=>list(await extensibility.listCustomFields(tx,ctx,entityId,query)),
 post_custom_fields_id_publish:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await extensibility.publishCustomField(tx,ctx,entityId,params.id,body,version)),
 post_rule_proposals:async(tx,ctx,{entityId,body})=>created(await extensibility.createProposal(tx,ctx,entityId,body,{cases:accountingCases})),
 get_rule_proposals:async(tx,ctx,{entityId,query})=>list(await extensibility.listProposals(tx,ctx,entityId,query)),
 get_rule_proposals_id:async(tx,ctx,{entityId,params})=>ok(await extensibility.getProposal(tx,ctx,entityId,params.id)),
 patch_rule_proposals_id:async(tx,ctx,{entityId,params,body,version})=>ok(await extensibility.updateProposal(tx,ctx,entityId,params.id,version,body,{cases:accountingCases})),
 post_rule_proposals_id_impact:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await extensibility.assessProposal(tx,ctx,entityId,params.id,body,version,{caseDefinitions:accountingCaseDefinitions})),
 get_rule_proposals_id_impact:async(tx,ctx,{entityId,params})=>({status:200,body:await extensibility.proposalImpact(tx,ctx,entityId,params.id)}),
 post_rule_proposals_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await extensibility.approveProposal(tx,ctx,entityId,params.id,body,version)),
 post_tool_grants:async(tx,ctx,{entityId,body})=>created(await extensibility.createGrant(tx,ctx,entityId,body)),
 get_tool_grants:async(tx,ctx,{entityId,query})=>list(await extensibility.listGrants(tx,ctx,entityId,query)),
 get_tool_grants_id:async(tx,ctx,{entityId,params})=>ok(await extensibility.getGrant(tx,ctx,entityId,params.id)),
 patch_tool_grants_id:async(tx,ctx,{entityId,params,body,version})=>ok(await extensibility.updateGrant(tx,ctx,entityId,params.id,version,body)),
 post_tool_grants_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await extensibility.approveGrant(tx,ctx,entityId,params.id,body,version)),
 post_tool_grants_id_revoke:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await extensibility.revokeGrant(tx,ctx,entityId,params.id,body,version)),
 post_tool_runs:async(tx,ctx,{entityId,body})=>{const r=await extensibility.runTool(tx,ctx,entityId,body);return {status:200,body:r,resourceType:'tool_run',resourceId:r.runId};},
 get_tool_runs:async(tx,ctx,{entityId,query})=>list(await extensibility.listToolRuns(tx,ctx,entityId,query)),
 get_packs:async(tx,ctx,{entityId})=>({status:200,body:await extensibility.listPacks(tx,ctx,entityId)}),
 get_pack_installs:async(tx,ctx,{entityId,query})=>list(await extensibility.listInstalls(tx,ctx,entityId,query)),
 post_packs_install:async(tx,ctx,{entityId,body})=>{const {job,packVersionId}=await extensibility.requestInstall(tx,ctx,entityId,body);return {status:202,body:{id:job.id,state:job.state,statusUrl:'/v1/jobs/'+job.id,traceId:ctx.traceId,resultResourceType:'pack_version',resultResourceId:packVersionId},resourceType:'pack_version',resourceId:packVersionId};},
 post_pack_installs_id_rollback:async(tx,ctx,{entityId,params,body,version})=>{const job=await extensibility.requestRollback(tx,ctx,entityId,params.id,body,version);return {status:202,body:{id:job.id,state:job.state,statusUrl:'/v1/jobs/'+job.id,traceId:ctx.traceId,resultResourceType:'pack_version',resultResourceId:params.id},resourceType:'pack_version',resourceId:params.id};},
 // P09 multiple currencies and separate books
 post_books:async(tx,ctx,{entityId,body})=>created(await ledger.createBook(tx,ctx,entityId,body)),
 get_books_id:async(tx,ctx,{entityId,params})=>ok(await ledger.getBook(tx,ctx,entityId,params.id)),
 patch_books_id:async(tx,ctx,{entityId,params,body,version})=>ok(await ledger.updateBook(tx,ctx,entityId,params.id,version,body)),
 post_books_id_activate:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await ledger.activateBook(tx,ctx,entityId,params.id,body,version)),
 get_books_id_combined:async(tx,ctx,{entityId,params,query})=>({status:200,body:await fx.combinedView(tx,ctx,entityId,{viewBookId:params.id,asOf:query.asOf})}),
 get_currencies:async(tx,ctx,{entityId})=>{if(!ctx.permissions.has('book.read'))fail('FORBIDDEN','Permission book.read is required.');return {status:200,body:{items:await fx.listCurrencies(tx),nextCursor:null}};},
 post_fx_rates:async(tx,ctx,{entityId,body})=>created(await fx.createFxRate(tx,ctx,entityId,body)),
 get_fx_rates:async(tx,ctx,{entityId,query})=>list(await fx.listFxRates(tx,ctx,entityId,query)),
 get_fx_rates_id:async(tx,ctx,{entityId,params})=>ok(await fx.getFxRate(tx,ctx,entityId,params.id)),
 patch_fx_rates_id:async(tx,ctx,{entityId,params,body,version})=>ok(await fx.updateFxRate(tx,ctx,entityId,params.id,version,body)),
 post_fx_rates_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await fx.approveFxRate(tx,ctx,entityId,params.id,body,version)),
 get_fx_layers:async(tx,ctx,{entityId,query})=>({status:200,body:await fx.listLayers(tx,ctx,entityId,{openItemId:query.openItemId||null,partyId:query.partyId||null})}),
 post_revaluations:async(tx,ctx,{entityId,body})=>created(await fx.createRevaluation(tx,ctx,entityId,body)),
 get_revaluations:async(tx,ctx,{entityId,query})=>list(await fx.listRevaluations(tx,ctx,entityId,query)),
 get_revaluations_id:async(tx,ctx,{entityId,params})=>ok(await fx.getRevaluation(tx,ctx,entityId,params.id)),
 get_revaluations_id_lines:async(tx,ctx,{entityId,params})=>({status:200,body:await fx.revaluationPreview(tx,ctx,entityId,params.id)}),
 patch_revaluations_id:async(tx,ctx,{entityId,params,body,version})=>ok(await fx.updateRevaluation(tx,ctx,entityId,params.id,version,body)),
 post_revaluations_id_preview:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await fx.previewRevaluation(tx,ctx,entityId,params.id,body,version)),
 post_revaluations_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await fx.approveRevaluation(tx,ctx,entityId,params.id,body,version)),
 post_revaluations_id_post:async(tx,ctx,{entityId,params,body,version})=>{const r=await fx.postRevaluation(tx,ctx,entityId,params.id,body,version);return {status:200,body:{...result(ctx,r).body,journalEntryIds:r.journalEntryIds}};},
 // P08 financial institution coexistence
 post_source_ownership:async(tx,ctx,{entityId,body})=>created(await fi.createSourceOwnership(tx,ctx,entityId,body)),
 get_source_ownership:async(tx,ctx,{entityId,query})=>list(await fi.listSourceOwnership(tx,ctx,entityId,query)),
 get_source_ownership_id:async(tx,ctx,{entityId,params})=>ok(await fi.getSourceOwnership(tx,ctx,entityId,params.id)),
 patch_source_ownership_id:async(tx,ctx,{entityId,params,body,version})=>ok(await fi.updateSourceOwnership(tx,ctx,entityId,params.id,version,body)),
 post_source_ownership_id_approve:async(tx,ctx,{entityId,params,body,version})=>result(ctx,await fi.approveSourceOwnership(tx,ctx,entityId,params.id,body,version)),
 get_source_systems:async(tx,ctx,{entityId,query})=>list(await fi.listSourceSystems(tx,ctx,entityId,query)),
 get_mapping_versions:async(tx,ctx,{entityId,query})=>list(await fi.listMappingVersions(tx,ctx,entityId,query)),
 get_mapping_versions_id_lines:async(tx,ctx,{entityId,params,query})=>({status:200,body:await fi.mappingLines(tx,ctx,entityId,params.id,{againstId:query.againstId||null})}),
 get_source_batches:async(tx,ctx,{entityId,query})=>list(await fi.listSourceBatches(tx,ctx,entityId,query)),
 get_source_batches_id_rows:async(tx,ctx,{entityId,params,query})=>({status:200,body:await fi.sourceBatchRows(tx,ctx,entityId,params.id,{status:query.status||null})}),
 get_expected_batches:async(tx,ctx,{entityId,query})=>list(await fi.listExpectedBatches(tx,ctx,entityId,query)),
 get_feed_reconciliation:async(tx,ctx,{entityId,query})=>({status:200,body:await fi.feedReconciliation(tx,ctx,entityId,{bookId:query.bookId,asOf:query.asOf})}),
 get_branch_rollup:async(tx,ctx,{entityId,query})=>({status:200,body:await fi.branchRollup(tx,ctx,entityId,{bookId:query.bookId,periodStart:query.periodStart,periodEnd:query.periodEnd})}),
 get_institution_tax_worksheet:async(tx,ctx,{entityId,query})=>({status:200,body:await fi.institutionTaxWorksheet(tx,ctx,entityId,{periodStart:query.periodStart,periodEnd:query.periodEnd})}),
 post_transmissions_id_retry:async(tx,ctx,{entityId,params,body})=>jobBody(ctx,await compliance.requestRetry(tx,ctx,entityId,params.id,body)),
 // The registration pack is a job: reportType names the authority, the period the scope.
 post_registration_packs:async(tx,ctx,{entityId,body})=>{if(!ctx.permissions.has('registration.prepare'))fail('FORBIDDEN','Permission registration.prepare is required.');await compliance.requireCompliance(tx,ctx,entityId);const job=await enqueueJob(tx,ctx,{entityId,kind:'registration.pack',payload:{authority:body.reportType.trim().toUpperCase().slice(0,100),scope:body.periodStart+'..'+body.periodEnd}});return jobBody(ctx,job);},
});
handlers.post_approval_policies=handlers.get_approval_policies=handlers.get_approval_policies_id=handlers.patch_approval_policies_id=handlers.post_approval_policies_id_approve=handlers.post_approval_policies_id_activate=async()=>fail('FEATURE_NOT_ENABLED','Approval policy management is completed with the ledger approval routing.');

export function createWorkspaceApi({pool,issuer,store,mode}){
 const providers={mail:messagingProviderFromEnv(process.env,store),pay:paymentProviderFromEnv(process.env,store)};
 return async function handle(request,response,{identity:identity_,path,method,traceId,send}){
  const db=await pool.connect();
  try{
   const url=new URL(request.url,'http://localhost');
   const query=Object.fromEntries(url.searchParams);
   // Public verification (P13): a non-enumerable token, minimal fields, rate limited per address.
   const verify=/^\/verify\/([0-9a-f-]{36}\.[a-f0-9]{48})$/.exec(path);
   if(verify&&method==='GET'){
    rateLimit('public:'+(request.socket?.remoteAddress||'unknown'),false);
    const tenant=portals.tenantOfToken(verify[1]);
    const view=await inTransaction(db,{tenantId:tenant,principalId:null},tx=>portals.verifyShare(tx,tenant,verify[1]));
    return send(response,200,view);
   }
   if(/^\/verify\//.test(path))return send(response,404,{code:'NOT_FOUND',message:'No such link.',traceId,fieldErrors:[],retryable:false});
   // Signed provider webhook (P13): verified, deduplicated and reconciled server to server; the answer is always 200 so the provider stops retrying, the receipt records the verdict.
   const hook=/^\/webhooks\/([a-z0-9-]{1,100})$/.exec(path);
   if(hook&&method==='POST'){
    rateLimit('public:'+(request.socket?.remoteAddress||'unknown'),true);
    const tenantId=request.headers['x-tenant-id'];
    if(!isUuid(tenantId))return send(response,400,{code:'VALIDATION_FAILED',message:'X-Tenant-Id header must be a UUID.',traceId,fieldErrors:[{path:'X-Tenant-Id',message:'Required UUID'}],retryable:false});
    const rawBody=(await readBody(request)).toString('utf8');
    const outcome=await inTransaction(db,{tenantId,principalId:null},tx=>portals.receiveWebhook(tx,{tenantId,providerName:hook[1],headers:{'x-webhook-timestamp':request.headers['x-webhook-timestamp'],'x-webhook-signature':request.headers['x-webhook-signature'],'x-trace-id':traceId},rawBody,provider:providers.pay}));
    return send(response,200,{outcome:outcome.outcome,reason:outcome.reason||null,eventId:outcome.eventId,intentId:outcome.intentId||null,settlementId:outcome.settlementId||null});
   }
   if(/^\/webhooks\//.test(path))return send(response,404,{code:'NOT_FOUND',message:'No such operation.',traceId,fieldErrors:[],retryable:false});
   if(!identity_)return send(response,401,{code:'UNAUTHENTICATED',message:'Authentication required.',traceId,fieldErrors:[],retryable:false});
   // Invite acceptance (P13): the invited identity has no membership yet, so the token and the tenant header carry the proof.
   const accept=/^\/portal-invites\/([0-9a-f-]{36})\/accept$/.exec(path);
   if(accept&&method==='POST'){
    rateLimit('accept:'+identity_.sub,true);
    const tenantId=request.headers['x-tenant-id'];
    if(!isUuid(tenantId))fail('VALIDATION_FAILED','X-Tenant-Id header must be a UUID.',{fieldErrors:[{path:'X-Tenant-Id',message:'Required UUID'}]});
    const body=parseJson(await readBody(request));
    const v=validateInput('post_portal_invites_id_accept',body);if(!v.ok)fail('VALIDATION_FAILED','Request does not match the reviewed contract.',{fieldErrors:v.fieldErrors});
    const r=await inTransaction(db,{tenantId,principalId:null},tx=>portals.acceptInvite(tx,{tenantId,inviteId:accept[1],token:body.token,issuer,subject:identity_.sub,email:body.email||identity_.sub,displayName:null}));
    return send(response,200,{resourceType:r.resourceType,resourceId:r.resourceId,version:r.version,state:r.state,journalEntryIds:[],taskIds:[],traceId,simulation:false});
   }
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
   if(!handlers[op.operationId])return send(response,409,{code:'FEATURE_NOT_ENABLED',message:'This capability is not enabled in this release.',traceId,fieldErrors:[],retryable:false});
   if(op.path.startsWith('/demo/')&&mode!=='demo')return send(response,404,{code:'NOT_FOUND',message:'No such operation.',traceId,fieldErrors:[],retryable:false});
   const ctx=await resolveActor(db,identity_,{issuer,tenantHeader:request.headers['x-tenant-id'],traceId});
   // Portal members (P13) reach the portal allowlist only; every other operation is refused before any read.
   if(ctx.portal&&!portals.PORTAL_OPERATIONS.has(op.operationId))fail('FORBIDDEN','Portal members may not perform this operation.');
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
   const parts={params,query,entityId,body,version,store,providers};
   let out;
   if(!write)out=await inTransaction(db,ctx,tx=>handlers[op.operationId](tx,ctx,parts));
   else{
    const key=request.headers['idempotency-key'];
    if(op.requiresIdempotencyKey&&!key)fail('PRECONDITION_REQUIRED','Idempotency-Key header is required.');
    if(op.requiresIdempotencyKey){
     const r=await command(db,ctx,{operation:op.operationId,idempotencyKey:key,entityId,body:{...(body??{}),__path:params,__version:version??null},traceId},async tx=>{const h=await handlers[op.operationId](tx,ctx,parts);return {resourceType:h.resourceType||h.body?.resourceType||op.response||'result',resourceId:h.resourceId||h.body?.resourceId||h.body?.id||h.body?.evidenceId||params.id||null,response:{status:h.status,body:h.body,etag:h.etag??null}};});
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
