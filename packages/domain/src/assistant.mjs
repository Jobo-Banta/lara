// Evidence-backed AI assistance (P12): per-feature configurations that
// enable only behind a passing, Finance-accepted evaluation of the exact
// model and prompt versions, runs requested under assistant.suggest with the
// requester's own permissions (the assistant never sees what the requester
// cannot), masked evidence to the provider, an allowlisted tool gate that
// logs every request and denies everything else, fields validated against
// the tool schema with per-field evidence and uncertainty, abstention on
// missing or poor evidence, numeric answers computed from canonical reports
// (never from model prose), a named reviewer who accepts, edits or rejects,
// and no tool that approves, posts, sends, files or pays. Timeouts, budgets
// and revocation fail the run and leave the manual flows untouched.
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,enqueueJob,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,DomainError} from './core.mjs';
import * as identity from './identity.mjs';
import {micros,decimal,signedMicros} from './ledger.mjs';

export const FEATURES=['capture','coding','matching','explain','ask_books','close_draft','audit_pack','registration_draft'];
// Allowlisted tools per feature. Nothing here approves, posts, sends, files
// or pays; arbitrary SQL, filesystem, URLs and outbound communication are
// never offered and every request for them is denied and logged.
export const TOOLS={capture:['read_evidence','propose_draft'],coding:['read_source','read_evidence','propose_draft'],matching:['read_source','propose_draft'],explain:['read_source','explain_finding'],ask_books:['read_report'],close_draft:['read_source','read_report','propose_task'],audit_pack:['read_source','read_evidence','propose_task'],registration_draft:['read_source','read_evidence','propose_draft']};
// Field paths the tool schema accepts per feature; anything else is dropped.
const FIELD_PATHS={capture:/^(supplierName|supplierTin|invoiceNumber|documentDate|gross|tax|net|withholding|reference)$/,coding:/^lines\.\d+\.(accountId|taxCodeId|dimensions\.[a-z_]+)$/,matching:/^lines\.[0-9a-f-]{36}\.openItemId$/,explain:/^explanation$/,ask_books:/^answer$/,close_draft:/^tasks\.\d+\.(requirement|reason)$/,audit_pack:/^gaps\.\d+\.(documentId|reason)$/,registration_draft:/^(narrative|missingArtifacts\.\d+)$/};
const UNCERTAINTY=['low','medium','high','unknown'];
// Tenant-level configuration is audited against the actor's first entity (the audit log is entity-scoped).
const auditEntity=ctx=>[...(ctx.entityIds||[])][0]||null;
const PROVIDER_TIMEOUT_MS=Number(process.env.AI_PROVIDER_TIMEOUT_MS||1500);

// Masking before anything leaves the domain: tax identifiers and long
// account numbers never reach a provider.
export function maskText(text){
 return String(text).replace(/\b\d{3}-\d{3}-\d{3}(-\d{3,5})?\b/g,'TIN-MASKED').replace(/\b\d{10,19}\b/g,'ACCT-MASKED');
}

// ---------------------------------------------------------------------------
// Capability, opt-out, feature configuration and evaluations
// ---------------------------------------------------------------------------
export async function requireAssistance(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='ai_assistance' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The AI assistance capability is not active for this entity.');
}
async function entityDisabled(tx,ctx,entityId,feature){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='ai_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 return Array.isArray(row?.payload?.disabledFeatures)&&row.payload.disabledFeatures.includes(feature);
}
const evalSummary=r=>r?{passed:r.passed,itemCount:r.item_count,metrics:r.metrics,acceptedBy:r.accepted_by,evaluatedAt:iso(r.evaluated_at)}:null;
// The recorded spend counts only while its month is the current one; a new month starts at zero before `finish` rolls the row.
const spentThisMonth=c=>iso(c.budget_month)?.slice(0,7)===new Date().toISOString().slice(0,7)?BigInt(c.spent_minor):0n;
const featureResource=(r,ev)=>({id:r.id,version:Number(r.version),feature:r.feature,enabled:r.enabled,budgetMinor:Number(r.budget_minor),spentMinor:Number(r.spent_minor),budgetMonth:iso(r.budget_month),providerPolicy:r.provider_policy,modelVersion:r.model_version,promptVersion:r.prompt_version,toolSchemaVersion:r.tool_schema_version,evaluationResultId:r.evaluation_result_id,evaluation:evalSummary(ev),approvedBy:r.approved_by,reason:r.reason,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
async function evaluationFor(tx,ctx,id){return id?(await tx.query('select * from lara.evaluation_results where tenant_id=$1 and id=$2',[ctx.tenantId,id])).rows[0]||null:null;}
// Configuration (no reviewed operation yet): the reviewer records the model,
// prompt and tool schema versions, the budget and the provider policy; the
// feature starts disabled.
export async function configureFeature(tx,ctx,{feature,modelVersion,promptVersion,toolSchemaVersion='tools-1',budgetMinor=0,providerPolicy={}}){
 requirePermission(ctx,'assistant.review');
 if(!FEATURES.includes(feature))fail('VALIDATION_FAILED','Unknown feature.',{fieldErrors:[{path:'feature',message:FEATURES.join('|')}]});
 if(providerPolicy.training===true)fail('VALIDATION_FAILED','Provider training on tenant data is never enabled from configuration; it needs explicit authorized consent and a privacy review recorded outside the system.',{fieldErrors:[{path:'providerPolicy.training',message:'Must be false'}]});
 const row=(await tx.query('insert into lara.model_feature_configs(tenant_id,feature,model_version,prompt_version,tool_schema_version,budget_minor,provider_policy,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tenant_id,feature) do update set model_version=excluded.model_version,prompt_version=excluded.prompt_version,tool_schema_version=excluded.tool_schema_version,budget_minor=excluded.budget_minor,provider_policy=excluded.provider_policy,enabled=false,approved_by=null,evaluation_result_id=null returning *',[ctx.tenantId,feature,modelVersion,promptVersion,toolSchemaVersion,budgetMinor,JSON.stringify({training:false,...providerPolicy,training:false}),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId:auditEntity(ctx),action:'assistant.configure',resourceType:'model_feature_config',resourceId:row.id,resourceVersion:Number(row.version),reason:feature+' '+modelVersion+'/'+promptVersion});
 return featureResource(row,null);
}
// Evaluation: a held-out set with its consent basis and the metrics against
// Finance's thresholds; the result passes only when every threshold holds,
// no unauthorized action ran and no control was bypassed.
export async function recordEvaluation(tx,ctx,{feature,version,hash,consentBasis,itemCount,modelVersion,promptVersion,metrics,thresholds,failures=[]}){
 requirePermission(ctx,'assistant.review');
 if(!FEATURES.includes(feature))fail('VALIDATION_FAILED','Unknown feature.');
 let set=(await tx.query('select * from lara.evaluation_sets where tenant_id=$1 and feature=$2 and version=$3',[ctx.tenantId,feature,version])).rows[0];
 if(set&&set.hash!==hash)fail('STATE_CONFLICT','Evaluation set '+version+' exists with another hash.');
 if(!set)set=(await tx.query('insert into lara.evaluation_sets(tenant_id,feature,version,hash,consent_basis,item_count,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[ctx.tenantId,feature,version,hash,consentBasis,itemCount,ctx.principalId])).rows[0];
 let passed=Number(metrics.unauthorizedActions||0)===0&&Number(metrics.controlBypasses||0)===0;
 for(const [k,limit] of Object.entries(thresholds))if(!(Number(metrics[k])<=Number(limit)))passed=false;
 const row=(await tx.query('insert into lara.evaluation_results(tenant_id,evaluation_set_id,feature,model_version,prompt_version,metrics,thresholds,failures,item_count,passed,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[ctx.tenantId,set.id,feature,modelVersion,promptVersion,JSON.stringify(metrics),JSON.stringify(thresholds),JSON.stringify(failures),itemCount,passed,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId:auditEntity(ctx),action:'assistant.evaluate',resourceType:'evaluation_result',resourceId:row.id,resourceVersion:1,reason:feature+' '+modelVersion+'/'+promptVersion+' '+(passed?'passed':'failed')});
 return {id:row.id,setId:set.id,passed,itemCount,metrics};
}
export async function acceptEvaluation(tx,ctx,resultId){
 requirePermission(ctx,'assistant.review');
 const row=(await tx.query('select * from lara.evaluation_results where tenant_id=$1 and id=$2 for update',[ctx.tenantId,resultId])).rows[0];
 if(!row)fail('NOT_FOUND','Evaluation result not found.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','Finance acceptance comes from a principal other than the evaluator.');
 if(!row.passed)fail('STATE_CONFLICT','A failed evaluation cannot be accepted; fix the model or prompt and evaluate again.');
 await tx.query('update lara.evaluation_results set accepted_by=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,resultId,ctx.principalId]);
 await audit(tx,ctx,{entityId:auditEntity(ctx),action:'assistant.accept_evaluation',resourceType:'evaluation_result',resourceId:resultId,resourceVersion:1});
 return {id:resultId,acceptedBy:ctx.principalId};
}
export async function listFeatures(tx,ctx,entityId){
 requirePermission(ctx,'assistant.read');requireEntity(ctx,entityId);
 const rows=(await tx.query('select * from lara.model_feature_configs where tenant_id=$1 order by feature',[ctx.tenantId])).rows;
 const items=[];for(const r of rows)items.push(featureResource(r,await evaluationFor(tx,ctx,r.evaluation_result_id)));
 return {items,nextCursor:null};
}
// Opt-in and opt-out per feature (versioned). Enabling binds the latest
// passing, accepted evaluation of the configured model and prompt; the
// database gate refuses anything else and a self-approval.
export async function updateFeature(tx,ctx,entityId,feature,expectedVersion,input){
 requirePermission(ctx,'assistant.review');requireEntity(ctx,entityId);assertInput('AiFeatureUpdate',input);
 const row=(await tx.query('select * from lara.model_feature_configs where tenant_id=$1 and feature=$2 for update',[ctx.tenantId,feature])).rows[0];
 if(!row)fail('NOT_FOUND','Feature '+feature+' is not configured.');
 expectVersion(row,expectedVersion);
 let evalId=row.evaluation_result_id;
 if(input.enabled){
  const ev=(await tx.query("select * from lara.evaluation_results where tenant_id=$1 and feature=$2 and model_version=$3 and prompt_version=$4 and passed and accepted_by is not null and item_count>=$5 order by evaluated_at desc limit 1",[ctx.tenantId,feature,row.model_version,row.prompt_version,feature==='capture'?200:1])).rows[0];
  if(!ev)fail('RULE_PROFILE_NOT_APPROVED','Feature '+feature+' has no passing, Finance-accepted evaluation for model '+row.model_version+' prompt '+row.prompt_version+(feature==='capture'?' on at least 200 held-out items':'')+'; it cannot activate.');
  if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who configured the feature cannot enable it.');
  evalId=ev.id;
 }
 const updated=(await tx.query('update lara.model_feature_configs set enabled=$3,approved_by=$4,evaluation_result_id=$5,reason=$6 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,row.id,input.enabled,input.enabled?ctx.principalId:row.approved_by,evalId,input.reason])).rows[0];
 await audit(tx,ctx,{entityId,action:input.enabled?'assistant.enable':'assistant.disable',resourceType:'model_feature_config',resourceId:row.id,resourceVersion:Number(updated.version),reason:input.reason});
 return featureResource(updated,await evaluationFor(tx,ctx,updated.evaluation_result_id));
}
async function enabledConfig(tx,ctx,entityId,feature){
 const row=(await tx.query('select * from lara.model_feature_configs where tenant_id=$1 and feature=$2',[ctx.tenantId,feature])).rows[0];
 if(!row||!row.enabled)fail('FEATURE_NOT_ENABLED','AI feature '+feature+' is switched off for this organization.');
 if(await entityDisabled(tx,ctx,entityId,feature))fail('FEATURE_NOT_ENABLED','AI feature '+feature+' is switched off for this entity.');
 return row;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
const runResource=(r,suggestionId=null)=>({id:r.id,version:Number(r.version),feature:r.feature,state:r.status,modelVersion:r.model_version,promptVersion:r.prompt_version,toolSchemaVersion:r.tool_schema_version,inputRefs:{evidenceIds:r.input_refs.evidenceIds||[],resourceIds:r.input_refs.resourceIds||[],question:r.input_refs.question??null,reportRequest:r.input_refs.reportRequest??null},scope:r.scope||{},toolCalls:r.tool_calls||[],errorCode:r.error_code,costMinor:Number(r.cost_minor),suggestionId,requestedBy:r.requested_by,startedAt:iso(r.started_at),completedAt:iso(r.completed_at),createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
async function withSuggestion(tx,ctx,r){const s=(await tx.query('select id from lara.ai_suggestions where tenant_id=$1 and run_id=$2',[ctx.tenantId,r.id])).rows[0];return runResource(r,s?.id||null);}
// The requester's own read permissions decide what the run may see; a
// resource the requester cannot read answers 404 exactly as the API does.
async function checkInputs(tx,ctx,entityId,input){
 const feature=input.feature;
 if(input.evidenceIds.length){requirePermission(ctx,'evidence.read');const found=(await tx.query("select id,status from lara.evidence where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[])",[ctx.tenantId,entityId,input.evidenceIds])).rows;if(found.length!==new Set(input.evidenceIds).size)fail('NOT_FOUND','Evidence not found.');}
 for(const id of input.resourceIds){
  if(!isUuid(id))fail('VALIDATION_FAILED','resourceIds must be UUIDs.',{fieldErrors:[{path:'resourceIds',message:'UUID'}]});
  const doc=(await tx.query('select kind from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];
  if(doc){requirePermission(ctx,['bill','purchase_order','expense_claim'].includes(doc.kind)?'bill.read':'invoice.read');continue;}
  if((await tx.query('select 1 from lara.tasks where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rowCount){requirePermission(ctx,'task.read');continue;}
  if((await tx.query('select 1 from lara.bank_statement_lines where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rowCount){requirePermission(ctx,'bank_match.read');continue;}
  if((await tx.query('select 1 from lara.periods where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rowCount){requirePermission(ctx,'period.read');continue;}
  if((await tx.query('select 1 from lara.registration_cases where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rowCount){requirePermission(ctx,'registration.prepare');continue;}
  fail('NOT_FOUND','Resource '+id+' not found.');
 }
 if(feature==='capture'&&!input.evidenceIds.length)fail('VALIDATION_FAILED','Capture reads evidence; select the scanned document.',{fieldErrors:[{path:'evidenceIds',message:'At least one'}]});
 if(['coding','matching','explain'].includes(feature)&&!input.resourceIds.length)fail('VALIDATION_FAILED',feature+' needs the records to work on.',{fieldErrors:[{path:'resourceIds',message:'At least one'}]});
 if(feature==='ask_books'){if(!input.question||!input.reportRequest)fail('VALIDATION_FAILED','Ask-your-books needs the question and the report scope (entity, book, period, currency, as-of).',{fieldErrors:[{path:'reportRequest',message:'Required'}]});requirePermission(ctx,'report.generate');}
 if(['close_draft','audit_pack','registration_draft'].includes(feature)&&!input.evidenceIds.length&&!input.resourceIds.length)fail('VALIDATION_FAILED',feature+' needs the period, case or evidence to draft from.',{fieldErrors:[{path:'resourceIds',message:'At least one'}]});
}
export async function requestRun(tx,ctx,entityId,input){
 requirePermission(ctx,'assistant.suggest');requireEntity(ctx,entityId);assertInput('AiRequest',input);await requireAssistance(tx,ctx,entityId);
 const config=await enabledConfig(tx,ctx,entityId,input.feature);
 if(Number(config.budget_minor)>0&&spentThisMonth(config)>=BigInt(config.budget_minor))fail('STATE_CONFLICT','BUDGET_EXCEEDED: the monthly budget for '+input.feature+' is spent; manual entry continues unchanged.');
 await checkInputs(tx,ctx,entityId,input);
 const scope={entityId,...(input.reportRequest?{bookId:input.reportRequest.bookId,periodStart:input.reportRequest.periodStart,periodEnd:input.reportRequest.periodEnd,currency:input.reportRequest.currency||null,asOf:input.reportRequest.asOf}:{})};
 const inputRefs={evidenceIds:input.evidenceIds,resourceIds:input.resourceIds,...(input.question?{question:String(input.question).slice(0,2000)}:{}),...(input.reportRequest?{reportRequest:input.reportRequest}:{})};
 const rv=(await tx.query('select revocation_version from lara.principals where tenant_id=$1 and id=$2',[ctx.tenantId,ctx.principalId])).rows[0].revocation_version;
 const row=(await tx.query('insert into lara.ai_runs(tenant_id,entity_id,feature,model_version,prompt_version,tool_schema_version,input_refs,scope,permission_context,requested_by,revocation_version,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10) returning *',[ctx.tenantId,entityId,input.feature,config.model_version,config.prompt_version,config.tool_schema_version,JSON.stringify(inputRefs),JSON.stringify(scope),JSON.stringify({permissionCount:ctx.permissions.size,entityIds:[...ctx.entityIds]}),ctx.principalId,rv])).rows[0];
 const job=await enqueueJob(tx,ctx,{entityId,kind:'assistant.run',payload:{runId:row.id,feature:input.feature}});
 await tx.query('update lara.ai_runs set job_id=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,row.id,job.id]);
 await audit(tx,ctx,{entityId,action:'assistant.request',resourceType:'ai_run',resourceId:row.id,resourceVersion:1,reason:input.feature});
 return {...job,runId:row.id};
}
export async function getRun(tx,ctx,entityId,id){requirePermission(ctx,'assistant.read');requireEntity(ctx,entityId);if(!isUuid(id))fail('NOT_FOUND','Run not found.');const row=(await tx.query('select * from lara.ai_runs where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Run not found.');return withSuggestion(tx,ctx,row);}
export async function listRuns(tx,ctx,entityId,query){
 requirePermission(ctx,'assistant.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.feature){params.push(String(query.feature));where+=' and feature=$'+params.length;}
 if(query?.status){params.push(String(query.status));where+=' and status=$'+params.length;}
 const rows=(await tx.query('select * from lara.ai_runs where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const items=[];for(const r of rows.slice(0,limit))items.push(await withSuggestion(tx,ctx,r));
 const last=rows.length>limit?rows[limit-1]:null;
 return {items,nextCursor:last?Buffer.from(JSON.stringify({createdAt:iso(last.created_at),id:last.id,scope})).toString('base64url'):null};
}

// Canonical questions answered from the trial balance of the stated scope.
// Anything else abstains: the model never supplies a number.
function parseQuestion(q){
 const t=String(q).toLowerCase();
 if(/total\s+debits?/.test(t))return {kind:'total_debit'};
 if(/total\s+credits?/.test(t))return {kind:'total_credit'};
 const m=/balance\s+(?:of|for)\s+(?:account\s+)?([0-9][0-9a-z.-]*)/.exec(t);
 if(m)return {kind:'account_balance',code:m[1]};
 if(/trial\s+balance\s+(balanced|balance\?|in balance)/.test(t)||/is the trial balance balanced/.test(t))return {kind:'balanced'};
 return null;
}
async function answerFromBooks(tx,actor,entityId,run,ledger,calls){
 const rr=run.input_refs.reportRequest;const parsed=parseQuestion(run.input_refs.question);
 if(!parsed)return {abstain:true,answer:null,reason:'Unsupported question; ask for a total, an account balance or whether the trial balance balances.'};
 calls.push({tool:'read_report',allowed:true,reason:'trial_balance',resourceId:rr.bookId});
 const tb=await ledger.trialBalance(tx,actor,entityId,{bookId:rr.bookId,periodStart:rr.periodStart,periodEnd:rr.periodEnd,asOf:rr.asOf});
 const banner='Entity '+entityId+' · book '+rr.bookId+' · period '+rr.periodStart+' to '+rr.periodEnd+' · '+(rr.currency||'functional currency')+' · as of '+rr.asOf;
 const sources=[{kind:'report',id:null,label:'Trial balance '+rr.periodStart+' to '+rr.periodEnd,href:'/reports'}];
 if(parsed.kind==='total_debit')return {answer:'Total debits '+tb.totals.debit,value:tb.totals.debit,banner,sources};
 if(parsed.kind==='total_credit')return {answer:'Total credits '+tb.totals.credit,value:tb.totals.credit,banner,sources};
 if(parsed.kind==='balanced')return {answer:'The trial balance '+(tb.totals.balanced?'balances':'does not balance')+' (debits '+tb.totals.debit+', credits '+tb.totals.credit+').',value:tb.totals.balanced?'balanced':'unbalanced',banner,sources};
 const line=tb.lines.find(l=>l.code.toLowerCase()===parsed.code);
 if(!line)return {abstain:true,answer:null,reason:'No account '+parsed.code+' in the scope.'};
 sources.push({kind:'account',id:line.accountId,label:line.code+' '+line.name,href:'/ledger/accounts'});
 return {answer:'Balance of '+line.code+' '+line.name+' is '+line.balance+' (debits '+line.debit+', credits '+line.credit+').',value:line.balance,banner,sources};
}
// Explanations restate the deterministic finding with its source and rule
// versions; without a recorded reason there is nothing to explain.
async function explainFinding(tx,actor,entityId,run,calls){
 const id=run.input_refs.resourceIds[0];
 calls.push({tool:'read_source',allowed:true,reason:'task',resourceId:id});
 const task=(await tx.query('select * from lara.tasks where tenant_id=$1 and entity_id=$2 and id=$3',[actor.tenantId,entityId,id])).rows[0];
 if(!task||!task.reason)return {abstain:true,reason:'No deterministic finding with a recorded reason.'};
 const audits=(await tx.query('select action,resource_version,reason,occurred_at from lara.audit_events where tenant_id=$1 and entity_id=$2 and resource_type=$3 and resource_id=$4 order by occurred_at desc limit 5',[actor.tenantId,entityId,task.source_type,task.source_id])).rows;
 calls.push({tool:'explain_finding',allowed:true,reason:task.kind,resourceId:id});
 const sources=[{kind:'task',id:task.id,label:task.kind.replace(/_/g,' '),href:'/work'},{kind:task.source_type,id:task.source_id,label:task.source_type+' '+task.source_id.slice(0,8),href:null},...audits.map(a=>({kind:'audit',id:null,label:a.action+' v'+a.resource_version+(a.reason?' — '+a.reason:''),href:null}))];
 return {answer:'This '+task.kind.replace(/_/g,' ')+' task was raised by a deterministic rule on '+task.source_type+' '+task.source_id.slice(0,8)+': '+task.reason+' Resolve it through the owning flow; the rule, not this explanation, decides.',sources,banner:null,fields:[{path:'explanation',value:task.reason,evidenceId:null,sourceLocator:'task:'+task.id,uncertainty:'low'}]};
}
// Coding candidates learn only from this tenant's posted documents and its
// reviewed suggestions: the account most often used by the same party for
// a line described the same way.
async function codingResources(tx,actor,entityId,run,calls){
 const out=[];
 for(const id of run.input_refs.resourceIds){
  const doc=(await tx.query('select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[actor.tenantId,entityId,id])).rows[0];
  if(!doc)continue;calls.push({tool:'read_source',allowed:true,reason:'document',resourceId:id});
  const lines=(await tx.query('select * from lara.document_lines where tenant_id=$1 and document_id=$2 order by line_no',[actor.tenantId,id])).rows;
  const evidenceId=(doc.evidence_ids||[])[0]||run.input_refs.evidenceIds[0]||null;
  const suggested=[];
  for(const l of lines){
   const hist=(await tx.query("select dl.account_id,count(*)::int as n from lara.document_lines dl join lara.documents d on d.tenant_id=dl.tenant_id and d.id=dl.document_id where d.tenant_id=$1 and d.entity_id=$2 and d.party_id=$3 and d.kind=$4 and d.state='posted' and d.id<>$5 and lower(split_part(dl.description,' ',1))=lower(split_part($6,' ',1)) group by dl.account_id order by n desc limit 2",[actor.tenantId,entityId,doc.party_id,doc.kind,id,l.description])).rows;
   suggested.push(hist.length?{suggestedAccountId:hist[0].account_id,uncertainty:hist[0].n>=3&&(!hist[1]||hist[1].n*2<hist[0].n)?'low':'medium'}:{});
  }
  out.push({id,evidenceId,lines:suggested});
 }
 return out;
}
// Matching never reconciles: one exact open item is a low-uncertainty
// proposal, several are an ambiguous (high) one the reviewer decides.
async function matchingResources(tx,actor,entityId,run,calls){
 const out=[];
 for(const id of run.input_refs.resourceIds){
  const line=(await tx.query("select * from lara.bank_statement_lines where tenant_id=$1 and entity_id=$2 and id=$3 and match_state<>'matched'",[actor.tenantId,entityId,id])).rows[0];
  if(!line)continue;calls.push({tool:'read_source',allowed:true,reason:'bank_statement_line',resourceId:id});
  const amt=signedMicros(String(line.signed_amount));const side=amt>0n?'AR':'AP';
  const items=(await tx.query("select id from lara.open_items where tenant_id=$1 and entity_id=$2 and side=$3 and currency=$4 and status in ('open','partially_settled') and original_amount-lara.open_item_allocated(tenant_id,id)=$5::numeric",[actor.tenantId,entityId,side,line.currency,decimal(amt<0n?-amt:amt,6)])).rows;
  const batch=(await tx.query('select o.evidence_id from lara.bank_statement_batches b join lara.opening_batches o on o.tenant_id=b.tenant_id and o.id=b.import_id where b.tenant_id=$1 and b.id=$2',[actor.tenantId,line.batch_id])).rows[0];
  out.push({id,evidenceId:batch?.evidence_id||run.input_refs.evidenceIds[0]||null,candidate:items[0]?.id||null,ambiguous:items.length>1});
 }
 return out;
}
async function draftResources(tx,actor,entityId,run,calls){
 // Close drafts list the open close tasks; audit packs list posted documents without evidence; registration drafts list the missing artifacts. All are read through the requester's permissions.
 const fields=[];const evidenceId=run.input_refs.evidenceIds[0]||null;
 if(run.feature==='close_draft'){for(const pid of run.input_refs.resourceIds){const p=(await tx.query('select * from lara.periods where tenant_id=$1 and entity_id=$2 and id=$3',[actor.tenantId,entityId,pid])).rows[0];if(!p)continue;calls.push({tool:'read_source',allowed:true,reason:'period',resourceId:pid});const open=(await tx.query("select requirement from lara.close_tasks where tenant_id=$1 and period_id=$2 and close_version=$3 and status<>'complete' order by created_at",[actor.tenantId,pid,p.close_version])).rows;open.forEach((t,i)=>{calls.push({tool:'propose_task',allowed:true,reason:t.requirement,resourceId:pid});fields.push({path:'tasks.'+i+'.requirement',value:t.requirement,evidenceId,sourceLocator:'period:'+pid+'#close-task',uncertainty:'low'});fields.push({path:'tasks.'+i+'.reason',value:'Open close requirement for '+iso(p.starts_on).slice(0,7),evidenceId,sourceLocator:'period:'+pid,uncertainty:'low'});});}}
 if(run.feature==='audit_pack'){const gaps=(await tx.query("select id,kind,official_number from lara.documents where tenant_id=$1 and entity_id=$2 and state='posted' and jsonb_array_length(evidence_ids)=0 order by posted_at limit 50",[actor.tenantId,entityId])).rows;calls.push({tool:'read_source',allowed:true,reason:'documents without evidence',resourceId:null});gaps.forEach((d,i)=>{fields.push({path:'gaps.'+i+'.documentId',value:d.id,evidenceId,sourceLocator:'document:'+d.id,uncertainty:'low'});fields.push({path:'gaps.'+i+'.reason',value:d.kind+' '+(d.official_number||d.id.slice(0,8))+' has no linked evidence; obtain it before release.',evidenceId,sourceLocator:'document:'+d.id,uncertainty:'low'});});}
 if(run.feature==='registration_draft'){const entity=(await tx.query('select legal_name from lara.entities where tenant_id=$1 and id=$2',[actor.tenantId,entityId])).rows[0];calls.push({tool:'read_source',allowed:true,reason:'entity',resourceId:entityId});const kinds=(await tx.query('select filename from lara.evidence where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[])',[actor.tenantId,entityId,run.input_refs.evidenceIds])).rows.map(r=>r.filename.toLowerCase());const required=['registration','permit','tin','articles'];const missing=required.filter(k=>!kinds.some(f=>f.includes(k)));if(evidenceId)fields.push({path:'narrative',value:'Draft application narrative for '+entity.legal_name+' assembled from '+kinds.length+' evidence file(s): '+kinds.join(', ')+'. This draft is not an attestation and is not signed.',evidenceId,sourceLocator:'evidence:'+evidenceId,uncertainty:missing.length?'medium':'low'});missing.forEach((k,i)=>fields.push({path:'missingArtifacts.'+i,value:k,evidenceId,sourceLocator:'checklist:'+k,uncertainty:'low'}));}
 return fields;
}
const worst=list=>list.reduce((w,u)=>UNCERTAINTY.indexOf(u)>UNCERTAINTY.indexOf(w)?u:w,'low');
function validateFields(feature,fields,evidenceIds){
 const out=[];
 for(const f of fields||[]){
  if(!f||typeof f.path!=='string'||!FIELD_PATHS[feature].test(f.path))continue;
  if(!(typeof f.value==='string'||typeof f.value==='number'||typeof f.value==='boolean'||f.value===null))continue;
  if(f.evidenceId!==null&&!evidenceIds.includes(f.evidenceId))continue;
  if(f.evidenceId===null&&feature!=='explain')continue;
  out.push({path:f.path,value:typeof f.value==='string'?maskText(f.value).slice(0,2000):f.value,evidenceId:f.evidenceId,sourceLocator:String(f.sourceLocator||'').slice(0,200),uncertainty:UNCERTAINTY.includes(f.uncertainty)?f.uncertainty:'unknown'});
 }
 return out;
}
async function finish(tx,ctx,run,{status,errorCode=null,cost=0n,calls}){
 const updated=(await tx.query('update lara.ai_runs set status=$3,error_code=$4,cost_minor=$5,tool_calls=$6,completed_at=now() where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,run.id,status,errorCode,String(cost),JSON.stringify(calls)])).rows[0];
 if(cost>0n)await tx.query("update lara.model_feature_configs set spent_minor=case when budget_month=date_trunc('month',now())::date then spent_minor+$3 else $3 end,budget_month=date_trunc('month',now())::date where tenant_id=$1 and feature=$2",[ctx.tenantId,run.feature,String(cost)]);
 await audit(tx,ctx,{entityId:run.entity_id,action:'assistant.run',resourceType:'ai_run',resourceId:run.id,resourceVersion:Number(updated.version),reason:status+(errorCode?' '+errorCode:''),afterRef:contentHash(calls)});
 return updated;
}
export async function executeRun(tx,ctx,entityId,runId,{provider,store,ledger}){
 const run=(await tx.query('select * from lara.ai_runs where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,runId])).rows[0];
 if(!run)fail('NOT_FOUND','AI run not found.');
 if(run.status!=='queued')return withSuggestion(tx,ctx,run);
 const calls=[];
 // The requester's authority is rechecked here: a revocation since the request ends the run without a result.
 let actor;
 try{actor=await identity.assertJobStillAuthorized(tx,{tenant_id:ctx.tenantId,entity_id:entityId,requested_by:run.requested_by,revocation_version:run.revocation_version},'assistant.suggest');}
 catch(e){if(e instanceof DomainError&&e.code==='FORBIDDEN'){return runResource(await finish(tx,ctx,run,{status:'revoked',errorCode:'ACTOR_REVOKED',calls}));}throw e;}
 actor={...actor,traceId:ctx.traceId};
 const config=(await tx.query('select * from lara.model_feature_configs where tenant_id=$1 and feature=$2',[ctx.tenantId,run.feature])).rows[0];
 if(!config||!config.enabled)return runResource(await finish(tx,ctx,run,{status:'failed',errorCode:'FEATURE_DISABLED',calls}));
 await tx.query("update lara.ai_runs set status='running',started_at=now() where tenant_id=$1 and id=$2",[ctx.tenantId,run.id]);
 const evidenceIds=run.input_refs.evidenceIds||[];
 // Evidence text is read through the requester's permission, masked, and never stored on the run.
 const evidence=[];
 for(const id of evidenceIds){
  const e=(await tx.query("select id,filename,mime,object_key,status from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,id])).rows[0];
  if(!e||e.status!=='available'){calls.push({tool:'read_evidence',allowed:false,reason:'not available',resourceId:id});continue;}
  if(!actor.permissions.has('evidence.read')){calls.push({tool:'read_evidence',allowed:false,reason:'evidence.read not held',resourceId:id});continue;}
  if(!TOOLS[run.feature].includes('read_evidence')){calls.push({tool:'read_evidence',allowed:false,reason:'not in the feature allowlist',resourceId:id});continue;}
  calls.push({tool:'read_evidence',allowed:true,reason:null,resourceId:id});
  let bytes;try{bytes=await store.get(e.object_key);}catch{bytes=Buffer.alloc(0);}
  evidence.push({id,filename:e.filename,text:maskText(bytes.toString('utf8').slice(0,200000))});
 }
 let fields=[],answer=null,banner=null,sources=[],abstainReason=null,cost=0n;
 try{
  if(run.feature==='ask_books'){
   const r=await answerFromBooks(tx,actor,entityId,run,ledger,calls);
   if(r.abstain)abstainReason=r.reason;else{answer=r.answer;banner=r.banner;sources=r.sources;fields=[{path:'answer',value:r.value,evidenceId:null,sourceLocator:'report:trial_balance',uncertainty:'low'}];}
  }else if(run.feature==='explain'){
   const r=await explainFinding(tx,actor,entityId,run,calls);
   if(r.abstain)abstainReason=r.reason;else{answer=r.answer;sources=r.sources;fields=r.fields;}
  }else{
   const resources=run.feature==='coding'?await codingResources(tx,actor,entityId,run,calls):run.feature==='matching'?await matchingResources(tx,actor,entityId,run,calls):[];
   const budgetLeft=Number(config.budget_minor)>0?BigInt(config.budget_minor)-spentThisMonth(config):null;
   if(budgetLeft!==null&&budgetLeft<=0n)throw new DomainError('STATE_CONFLICT','BUDGET_EXCEEDED');
   const timeout=Number(config.provider_policy?.timeoutMs||PROVIDER_TIMEOUT_MS);
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
   let result;
   try{result=await provider.complete({feature:run.feature,evidence,resources,question:run.input_refs.question||null,tools:TOOLS[run.feature]},{signal:controller.signal});}
   finally{clearTimeout(timer);}
   cost=BigInt(Math.max(0,Math.round(result.costMinor||0)));
   if(budgetLeft!==null&&cost>budgetLeft)throw new DomainError('STATE_CONFLICT','BUDGET_EXCEEDED');
   // Every tool the model asks for is gated: only the feature's allowlist passes, and none of it executes anything.
   for(const t of result.toolRequests||[]){const name=String(t.tool||'').slice(0,60);calls.push({tool:name,allowed:TOOLS[run.feature].includes(name),reason:TOOLS[run.feature].includes(name)?'requested by the model (already served by the domain)':'denied: not in the feature allowlist; document text is data, not instruction',resourceId:t.locator?String(t.locator).slice(0,120):null});}
   fields=validateFields(run.feature,result.fields,evidenceIds.concat(resources.map(r=>r.evidenceId).filter(Boolean)));
   if(['close_draft','audit_pack','registration_draft'].includes(run.feature))fields=fields.concat(validateFields(run.feature,await draftResources(tx,actor,entityId,run,calls),evidenceIds));
   if(!fields.length)abstainReason=evidence.length||resources.length?'No field could be read with evidence; the document may be poor or unsupported.':'No readable evidence or records.';
  }
 }catch(e){
  if(e instanceof DomainError&&(e.code==='DEPENDENCY_UNAVAILABLE'||e.message==='BUDGET_EXCEEDED'))return runResource(await finish(tx,ctx,run,{status:'failed',errorCode:e.message==='BUDGET_EXCEEDED'?'BUDGET_EXCEEDED':'PROVIDER_TIMEOUT',calls}));
  if(e instanceof DomainError&&e.code==='FORBIDDEN'){calls.push({tool:'read_report',allowed:false,reason:e.message,resourceId:null});return runResource(await finish(tx,ctx,run,{status:'failed',errorCode:'NOT_PERMITTED',calls}));}
  throw e;
 }
 // Completion is bound to the same authority: a revocation during the run leaves no retrievable result.
 try{await identity.assertJobStillAuthorized(tx,{tenant_id:ctx.tenantId,entity_id:entityId,requested_by:run.requested_by,revocation_version:run.revocation_version},'assistant.suggest');}
 catch(e){if(e instanceof DomainError&&e.code==='FORBIDDEN')return runResource(await finish(tx,ctx,run,{status:'revoked',errorCode:'ACTOR_REVOKED',calls}));throw e;}
 const abstained=!!abstainReason;
 const uncertainty=abstained?'unknown':worst(fields.map(f=>f.uncertainty));
 const suggestion=(await tx.query('insert into lara.ai_suggestions(tenant_id,entity_id,run_id,feature,fields_json,source_spans,uncertainty,answer,report_ref,model_version,state,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[ctx.tenantId,entityId,run.id,run.feature,JSON.stringify(fields),JSON.stringify(sources),uncertainty,abstained?abstainReason:answer,banner?JSON.stringify({banner,...run.scope}):null,run.model_version,abstained?'abstained':'proposed',run.requested_by])).rows[0];
 const updated=await finish(tx,ctx,run,{status:abstained?'abstained':'succeeded',cost,calls});
 await emit(tx,ctx,{entityId,aggregateType:'ai_suggestion',aggregateId:suggestion.id,aggregateVersion:1,eventType:'assistant.suggested.v1',payload:{runId:run.id,feature:run.feature,state:suggestion.state}});
 return runResource(updated,suggestion.id);
}

// ---------------------------------------------------------------------------
// Suggestions and review
// ---------------------------------------------------------------------------
const suggestionResource=r=>({id:r.id,version:Number(r.version),state:r.state,runId:r.run_id,feature:r.feature,fields:(r.fields_json||[]).map(f=>({path:f.path,value:f.value,evidenceId:f.evidenceId||null,sourceLocator:f.sourceLocator,uncertainty:f.uncertainty})),modelVersion:r.model_version,uncertainty:r.uncertainty,answer:r.answer,scopeBanner:r.report_ref?.banner||null,sources:r.source_spans||[],reviewDecision:r.review_decision,reviewerId:r.reviewer_id,reviewReason:r.review_reason,reviewedAt:iso(r.reviewed_at),fieldChanges:r.field_changes||[],createdAt:iso(r.created_at),simulation:false});
async function loadSuggestion(tx,ctx,entityId,id,{lock=false}={}){if(!isUuid(id))fail('NOT_FOUND','Suggestion not found.');const row=(await tx.query('select * from lara.ai_suggestions where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Suggestion not found.');return row;}
export async function getSuggestion(tx,ctx,entityId,id){requirePermission(ctx,'assistant.read');requireEntity(ctx,entityId);return suggestionResource(await loadSuggestion(tx,ctx,entityId,id));}
export async function listSuggestions(tx,ctx,entityId,query){
 requirePermission(ctx,'assistant.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.state){params.push(String(query.state));where+=' and state=$'+params.length;}
 if(query?.runId){if(!isUuid(query.runId))fail('VALIDATION_FAILED','runId must be a UUID.');params.push(query.runId);where+=' and run_id=$'+params.length;}
 const rows=(await tx.query('select * from lara.ai_suggestions where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,suggestionResource,scope);
}
// The named reviewer decides; the proposal itself never changes and an edit
// is recorded as field changes. The accepted fields feed the normal domain
// command the reviewer issues next — nothing here posts.
export async function reviewSuggestion(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'assistant.review');requireEntity(ctx,entityId);assertInput('AiReview',input);
 const row=await loadSuggestion(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='proposed')fail('STATE_CONFLICT','Only proposed suggestions are reviewed (this one is '+row.state+').');
 const paths=new Set((row.fields_json||[]).map(f=>f.path));
 if(input.decision==='edit'){if(!input.fieldChanges.length)fail('VALIDATION_FAILED','An edit names the fields changed.',{fieldErrors:[{path:'fieldChanges',message:'At least one'}]});for(const c of input.fieldChanges)if(!paths.has(c.path)&&!FIELD_PATHS[row.feature].test(c.path))fail('VALIDATION_FAILED','Field '+c.path+' is not part of this suggestion.',{fieldErrors:[{path:'fieldChanges',message:c.path}]});}
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 if(input.decision==='accept'&&(row.fields_json||[]).some(f=>f.uncertainty==='high'||f.uncertainty==='unknown')&&!input.reason)fail('VALIDATION_FAILED','Accepting uncertain fields as they stand needs a reason; edit them or state why.',{fieldErrors:[{path:'reason',message:'Required for uncertain fields'}]});
 const state=input.decision==='accept'?'accepted':input.decision==='edit'?'edited':'rejected';
 const updated=(await tx.query('update lara.ai_suggestions set state=$3,review_decision=$4,field_changes=$5,reviewer_id=$6,review_reason=$7,reviewed_at=now() where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,state,input.decision,JSON.stringify(input.fieldChanges.map(c=>({path:c.path,value:typeof c.value==='string'?maskText(c.value).slice(0,2000):c.value}))),ctx.principalId,input.reason||null])).rows[0];
 await audit(tx,ctx,{entityId,action:'assistant.review',resourceType:'ai_suggestion',resourceId:id,resourceVersion:Number(updated.version),reason:input.decision+(input.reason?': '+input.reason:'')});
 await emit(tx,ctx,{entityId,aggregateType:'ai_suggestion',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'assistant.reviewed.v1',payload:{suggestionId:id,decision:input.decision,feature:row.feature}});
 return {resourceType:'ai_suggestion',resourceId:id,version:Number(updated.version),state};
}
