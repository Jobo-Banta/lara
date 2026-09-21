// Controlled extensibility and advanced assistance (P18). P18A report
// definitions over an allowlisted catalog compiled to parameterized queries
// (no raw SQL, no joins beyond the catalog, no masked fields) under a cost
// budget, published by another principal, run under the caller's scope with
// the aggregate over the entities in scope; custom fields kept apart from
// statutory and accounting fields. P18B rule proposals from cited issuances
// with an impact run over the golden cases and the affected profiles and
// periods, approved only by an independent reviewer when every case passes,
// never rewriting history. P18C tool grants for client integrations:
// scoped, expiring, rate-limited identities that read authorized reports
// and evidence metadata and propose drafts or tasks only; anything else is
// denied and recorded. P18D versioned industry packs installed by a job as
// reviewed configuration with the profile snapshot kept for rollback. No
// runtime tenant scripting engine exists.
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {assertInput,audit,canonical,contentHash,cursorClause,cursorScope,emit,enqueueJob,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {micros,signedMicros,decimal} from './ledger.mjs';
import {computeLines} from './sales.mjs';
import {rateScaled} from './fx.mjs';
import * as organization from './organization.mjs';
import * as workflow from './workflow.mjs';
import {linkEvidence} from './evidence.mjs';

const sha=v=>createHash('sha256').update(String(v)).digest('hex');
const money=v=>decimal(micros(String(v)),2);
async function requireCapability(tx,ctx,entityId,code,label){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability=$3 and status='active'",[ctx.tenantId,entityId,code])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The '+label+' feature is not active for this entity.');
}

// ---------------------------------------------------------------------------
// P18A report catalog, definitions, runs and custom fields
// ---------------------------------------------------------------------------
// The allowlist: every metric names the SQL it compiles to, its unit and the
// permission it needs; every dimension names its column. Nothing outside this
// catalog is reachable, and masked fields (identities, tax ids) are not in it.
export const CATALOG={
 metrics:{
  revenue:{label:'Revenue (posted, functional)',unit:'money',permission:'journal.read',sql:"sum(case when a.category='income' then l.func_credit-l.func_debit else 0 end)"},
  expense:{label:'Expense (posted, functional)',unit:'money',permission:'journal.read',sql:"sum(case when a.category='expense' then l.func_debit-l.func_credit else 0 end)"},
  net_income:{label:'Net income (posted)',unit:'money',permission:'journal.read',sql:"sum(case when a.category='income' then l.func_credit-l.func_debit when a.category='expense' then l.func_debit-l.func_credit else 0 end)"},
  debits:{label:'Debits (posted, functional)',unit:'money',permission:'journal.read',sql:'sum(l.func_debit)'},
  credits:{label:'Credits (posted, functional)',unit:'money',permission:'journal.read',sql:'sum(l.func_credit)'},
  line_count:{label:'Posted lines',unit:'count',permission:'journal.read',sql:'count(*)'}
 },
 dimensions:{
  entity:{label:'Entity',sql:'e.entity_id',filterable:true},
  branch:{label:'Branch',sql:'l.branch_id',filterable:true},
  account:{label:'Account code',sql:'a.code',filterable:true},
  account_category:{label:'Account category',sql:'a.category',filterable:true},
  month:{label:'Accounting month',sql:"to_char(e.accounting_date,'YYYY-MM')",filterable:true},
  source_type:{label:'Source type',sql:'e.source_type',filterable:true}
 },
 budget:{maxRows:2000,maxCost:50,timeoutMs:5000}
};
export function catalog(){return {metrics:Object.entries(CATALOG.metrics).map(([id,m])=>({id,label:m.label,permission:m.permission,unit:m.unit})),dimensions:Object.entries(CATALOG.dimensions).map(([id,d])=>({id,label:d.label,filterable:d.filterable})),budget:CATALOG.budget};}
// The query AST: validated against the catalog, versioned, and the only
// thing the compiler reads. Cost = metrics + dimensions × 2 + filters + sort.
export function compileAst(input){
 const unknownM=input.metricIds.filter(m=>!CATALOG.metrics[m]);if(unknownM.length)fail('VALIDATION_FAILED','Metric not in the allowlist: '+unknownM.join(', ')+'.',{fieldErrors:[{path:'metricIds',message:'Not allowlisted'}]});
 const unknownD=input.dimensionIds.filter(d=>!CATALOG.dimensions[d]);if(unknownD.length)fail('VALIDATION_FAILED','Dimension not in the allowlist: '+unknownD.join(', ')+'.',{fieldErrors:[{path:'dimensionIds',message:'Not allowlisted'}]});
 for(const [i,f] of input.filters.entries()){if(!CATALOG.dimensions[f.field]||!CATALOG.dimensions[f.field].filterable)fail('VALIDATION_FAILED','Filter field not in the allowlist: '+f.field+'.',{fieldErrors:[{path:'filters['+i+'].field',message:'Not allowlisted'}]});if(['gte','lte'].includes(f.operator)&&f.values.length!==1)fail('VALIDATION_FAILED','Range filters take one value.',{fieldErrors:[{path:'filters['+i+'].values',message:'One value'}]});if(f.values.some(v=>v.length>200))fail('VALIDATION_FAILED','Filter values are at most 200 characters.',{fieldErrors:[{path:'filters['+i+'].values',message:'Too long'}]});}
 for(const [i,s] of input.sort.entries()){if(!CATALOG.metrics[s.field]&&!CATALOG.dimensions[s.field])fail('VALIDATION_FAILED','Sort field not in the allowlist: '+s.field+'.',{fieldErrors:[{path:'sort['+i+'].field',message:'Not allowlisted'}]});if(![...input.metricIds,...input.dimensionIds].includes(s.field))fail('VALIDATION_FAILED','Sort fields are selected metrics or dimensions.',{fieldErrors:[{path:'sort['+i+'].field',message:'Not selected'}]});}
 if(new Set(input.metricIds).size!==input.metricIds.length||new Set(input.dimensionIds).size!==input.dimensionIds.length)fail('VALIDATION_FAILED','Metrics and dimensions are listed once.',{fieldErrors:[{path:'metricIds',message:'Duplicate'}]});
 const cost=input.metricIds.length+input.dimensionIds.length*2+input.filters.length+input.sort.length;
 if(cost>CATALOG.budget.maxCost)fail('VALIDATION_FAILED','The definition exceeds the query cost budget ('+cost+' > '+CATALOG.budget.maxCost+').',{fieldErrors:[{path:'metricIds',message:'Over budget'}]});
 return {version:'ast-1',select:{metrics:[...input.metricIds],dimensions:[...input.dimensionIds]},where:input.filters.map(f=>({field:f.field,operator:f.operator,values:[...f.values]})),orderBy:input.sort.map(s=>({field:s.field,direction:s.direction})),cost};
}
const definitionResource=r=>resource({...r,status:r.state},{name:r.name,metricIds:r.metric_ids,dimensionIds:r.dimension_ids,filters:r.filters,sort:r.sort});
export const definitionDetail=r=>({...definitionResource(r),versionNumber:r.version_number,astVersion:r.ast_version,cost:r.ast?.cost??null,publishedBy:r.published_by});
export async function createDefinition(tx,ctx,entityId,input){
 requirePermission(ctx,'report_definition.create');requireEntity(ctx,entityId);assertInput('ReportDefinitionCreate',input);await requireCapability(tx,ctx,entityId,'report_authoring','report authoring');
 const ast=compileAst(input);
 const version=((await tx.query('select coalesce(max(version_number),0)::int v from lara.report_definitions where tenant_id=$1 and entity_id=$2 and name=$3',[ctx.tenantId,entityId,input.name])).rows[0].v)+1;
 const hash=contentHash(ast);
 const row=(await tx.query('insert into lara.report_definitions(tenant_id,entity_id,name,version_number,metric_ids,dimension_ids,filters,sort,ast,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[ctx.tenantId,entityId,input.name,version,input.metricIds,input.dimensionIds,JSON.stringify(input.filters),JSON.stringify(input.sort),JSON.stringify(ast),hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'report_definition.create',resourceType:'report_definition',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return definitionResource(row);
}
async function loadDefinition(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Report definition not found.');
 const row=(await tx.query('select * from lara.report_definitions where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Report definition not found.');return row;
}
export async function updateDefinition(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'report_definition.edit');requireEntity(ctx,entityId);assertInput('ReportDefinitionCreate',input);
 const row=await loadDefinition(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','A published definition is immutable; create the next version.');
 const ast=compileAst(input);const hash=contentHash(ast);
 const updated=(await tx.query('update lara.report_definitions set name=$4,metric_ids=$5,dimension_ids=$6,filters=$7,sort=$8,ast=$9,content_hash=$10,content_version=content_version+1 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,input.name,input.metricIds,input.dimensionIds,JSON.stringify(input.filters),JSON.stringify(input.sort),JSON.stringify(ast),hash])).rows[0];
 await audit(tx,ctx,{entityId,action:'report_definition.edit',resourceType:'report_definition',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return definitionResource(updated);
}
export async function getDefinition(tx,ctx,entityId,id){requirePermission(ctx,'report_definition.read');requireEntity(ctx,entityId);return definitionResource(await loadDefinition(tx,ctx,entityId,id));}
export async function listDefinitions(tx,ctx,entityId,query){
 requirePermission(ctx,'report_definition.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.report_definitions where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,query?.detail==='1'?definitionDetail:definitionResource,scope);
}
export async function publishDefinition(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'report_definition.publish');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadDefinition(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Definition is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The author cannot publish the definition.');
 await tx.query("update lara.report_definitions set state='retired' where tenant_id=$1 and entity_id=$2 and name=$3 and state='published' and id<>$4",[ctx.tenantId,entityId,row.name,id]);
 const updated=(await tx.query("update lara.report_definitions set state='published',published_by=$4,published_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'report_definition.publish',resourceType:'report_definition',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'report_definition',resourceId:id,version:Number(updated.version),state:'published'};
}
// Compile the AST to one parameterized statement over posted journal lines.
// The entity scope is the caller's (an explicit entityIds subset of it is
// allowed); the statement runs under a local timeout and a row cap.
export function compileQuery(ast,{tenantId,entityIds,periodStart,periodEnd}){
 const params=[tenantId,entityIds,periodStart,periodEnd];
 const dims=ast.select.dimensions.map(d=>CATALOG.dimensions[d].sql+' as "'+d+'"');
 const mets=ast.select.metrics.map(m=>CATALOG.metrics[m].sql+' as "'+m+'"');
 const where=["l.tenant_id=$1","l.entity_id=any($2::uuid[])","e.accounting_date between $3 and $4","e.purpose='posting'"];
 for(const f of ast.where){const col=CATALOG.dimensions[f.field].sql;if(f.operator==='eq'){params.push(f.values[0]);where.push(col+'::text=$'+params.length);}else if(f.operator==='in'){params.push(f.values);where.push(col+'::text=any($'+params.length+'::text[])');}else if(f.operator==='gte'){params.push(f.values[0]);where.push(col+'::text>=$'+params.length);}else{params.push(f.values[0]);where.push(col+'::text<=$'+params.length);}}
 const order=ast.orderBy.map(s=>'"'+s.field+'" '+(s.direction==='desc'?'desc':'asc'));
 const sql='select '+[...dims,...mets].join(',')+' from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where '+where.join(' and ')+(dims.length?' group by '+ast.select.dimensions.map((d,i)=>String(i+1)).join(','):'')+(order.length?' order by '+order.join(','):'')+' limit '+(CATALOG.budget.maxRows+1);
 return {sql,params};
}
export async function runDefinition(tx,ctx,entityId,id,input){
 requirePermission(ctx,'report_definition.run');requireEntity(ctx,entityId);assertInput('ReportRun',input);
 const row=await loadDefinition(tx,ctx,entityId,id);
 if(row.state!=='published')fail('STATE_CONFLICT','Only published definitions run; a draft is previewed by its author after publication.');
 const ast=row.ast;
 // The caller's scope: every metric's permission and the entities requested must be held.
 for(const m of ast.select.metrics)if(!ctx.permissions.has(CATALOG.metrics[m].permission))fail('FORBIDDEN','Metric '+m+' needs '+CATALOG.metrics[m].permission+'.');
 const requested=input.entityIds?.length?input.entityIds:[...ctx.entityIds];
 const outside=requested.filter(e=>!ctx.entityIds.has(e));
 if(outside.length)fail('NOT_FOUND','Entity not found.');
 const {sql,params}=compileQuery(ast,{tenantId:ctx.tenantId,entityIds:requested,periodStart:input.periodStart,periodEnd:input.periodEnd});
 await tx.query('set local statement_timeout = '+CATALOG.budget.timeoutMs);
 let rows;
 try{rows=(await tx.query(sql,params)).rows;}catch(e){if(e.code==='57014')fail('VALIDATION_FAILED','The report exceeded its time budget ('+CATALOG.budget.timeoutMs+' ms); narrow the filters.');throw e;}
 finally{await tx.query('set local statement_timeout = 0').catch(()=>{});}
 if(rows.length>CATALOG.budget.maxRows)fail('VALIDATION_FAILED','The report exceeded its row budget ('+CATALOG.budget.maxRows+' rows); add dimensions filters or narrow the period.');
 const fmt=(m,v)=>CATALOG.metrics[m].unit==='count'?Number(v):decimal(signedMicros(String(v??'0')),2);
 const out=rows.map(r=>({dimensions:Object.fromEntries(ast.select.dimensions.map(d=>[d,r[d]])),metrics:Object.fromEntries(ast.select.metrics.map(m=>[m,fmt(m,r[m])]))}));
 // The aggregate is the metric over the entities in scope (the same rows summed), never beyond them.
 const aggregate=Object.fromEntries(ast.select.metrics.map(m=>[m,CATALOG.metrics[m].unit==='count'?rows.reduce((s,r)=>s+Number(r[m]),0):decimal(rows.reduce((s,r)=>s+signedMicros(String(r[m]??'0')),0n),2)]));
 const payload={rows:out,aggregate};
 const checksum=sha(canonical({definition:row.content_hash,periodStart:input.periodStart,periodEnd:input.periodEnd,entityIds:[...requested].sort(),payload}));
 const run=(await tx.query('insert into lara.report_runs(tenant_id,entity_id,definition_id,parameters,row_count,cost,checksum,payload,scope_entity_ids,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id,created_at',[ctx.tenantId,entityId,id,JSON.stringify({periodStart:input.periodStart,periodEnd:input.periodEnd}),out.length,ast.cost,checksum,JSON.stringify(payload),requested,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'report_definition.run',resourceType:'report_run',resourceId:run.id,resourceVersion:1,afterRef:checksum});
 return {runId:run.id,definitionId:id,astVersion:row.ast_version,rows:out,aggregate,rowCount:out.length,cost:ast.cost,checksum,scopeEntityIds:requested,asOf:iso(run.created_at)};
}
// Custom fields: never a statutory or accounting key, validated shape only.
const RESERVED=/^(cf_(tin|tax_id|vat|official_number|amount|net|tax|gross|account|debit|credit))$/;
const fieldResource=f=>({id:f.id,version:Number(f.version),resourceType:f.resource_type,key:f.key,label:f.label,fieldType:f.field_type,validation:f.validation,visibility:f.visibility,state:f.state,publishedBy:f.published_by,createdAt:iso(f.created_at),updatedAt:iso(f.updated_at)});
export async function createCustomField(tx,ctx,entityId,input){
 requirePermission(ctx,'custom_field.create');requireEntity(ctx,entityId);assertInput('CustomFieldCreate',input);await requireCapability(tx,ctx,entityId,'report_authoring','report authoring');
 if(RESERVED.test(input.key))fail('VALIDATION_FAILED','Custom fields never replace statutory or accounting fields.',{fieldErrors:[{path:'key',message:'Reserved'}]});
 const v=input.validation||{};
 if(input.fieldType==='choice'&&!(Array.isArray(v.choices)&&v.choices.length))fail('VALIDATION_FAILED','A choice field lists its choices.',{fieldErrors:[{path:'validation.choices',message:'Required'}]});
 if(v.pattern!==undefined){try{new RegExp(v.pattern);}catch{fail('VALIDATION_FAILED','validation.pattern is not a valid pattern.',{fieldErrors:[{path:'validation.pattern',message:'Invalid'}]});}}
 if((await tx.query('select 1 from lara.custom_fields where tenant_id=$1 and entity_id=$2 and resource_type=$3 and key=$4',[ctx.tenantId,entityId,input.resourceType,input.key])).rowCount)fail('STATE_CONFLICT','Field '+input.key+' exists on '+input.resourceType+'.');
 const hash=contentHash({resourceType:input.resourceType,key:input.key,label:input.label,fieldType:input.fieldType,validation:v,visibility:input.visibility||'internal'});
 const row=(await tx.query('insert into lara.custom_fields(tenant_id,entity_id,resource_type,key,label,field_type,validation,visibility,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,input.resourceType,input.key,input.label,input.fieldType,JSON.stringify(v),input.visibility||'internal',hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'custom_field.create',resourceType:'custom_field',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return fieldResource(row);
}
export async function listCustomFields(tx,ctx,entityId,query){
 requirePermission(ctx,'custom_field.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.custom_fields where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,fieldResource,scope);
}
export async function publishCustomField(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'custom_field.publish');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 if(!isUuid(id))fail('NOT_FOUND','Custom field not found.');
 const row=(await tx.query('select * from lara.custom_fields where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Custom field not found.');if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Field is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The author cannot publish the field.');
 const updated=(await tx.query("update lara.custom_fields set state='published',published_by=$4,published_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'custom_field.publish',resourceType:'custom_field',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'custom_field',resourceId:id,version:Number(updated.version),state:'published'};
}

// ---------------------------------------------------------------------------
// P18B rule proposals
// ---------------------------------------------------------------------------
const proposalResource=r=>resource({...r,status:r.state},{sourceEvidenceIds:r.source_evidence_ids,affectedProfileIds:r.affected_profile_ids,proposedRuleIds:r.proposed_rule_ids,goldenCaseIds:r.golden_case_ids,summary:r.summary,impactPassed:r.impact_passed});
const proposalMaterial=i=>({sourceEvidenceIds:[...i.sourceEvidenceIds].sort(),affectedProfileIds:[...i.affectedProfileIds].sort(),proposedRuleIds:[...i.proposedRuleIds].sort(),goldenCaseIds:[...i.goldenCaseIds].sort(),summary:i.summary||null});
async function validateProposal(tx,ctx,entityId,input,{cases}){
 for(const id of input.affectedProfileIds)if(!(await tx.query('select 1 from lara.settings_versions where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rowCount)fail('NOT_FOUND','Affected profile '+id+' not found.');
 for(const id of input.proposedRuleIds){const r=(await tx.query('select status from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!r)fail('NOT_FOUND','Proposed rule '+id+' not found.');if(r.status==='active')fail('STATE_CONFLICT','Proposed rules are drafts; an active rule is not a proposal.');}
 if(cases){const unknown=input.goldenCaseIds.filter(c=>!cases.has(c));if(unknown.length)fail('VALIDATION_FAILED','Unknown golden cases: '+unknown.join(', ')+'.',{fieldErrors:[{path:'goldenCaseIds',message:'Unknown'}]});}
}
export async function createProposal(tx,ctx,entityId,input,{cases=null}={}){
 requirePermission(ctx,'rule_proposal.create');requireEntity(ctx,entityId);assertInput('RuleProposalCreate',input);await requireCapability(tx,ctx,entityId,'rule_proposals','rule proposals');
 await validateProposal(tx,ctx,entityId,input,{cases});
 const hash=contentHash(proposalMaterial(input));
 const row=(await tx.query('insert into lara.rule_proposals(tenant_id,entity_id,source_evidence_ids,affected_profile_ids,proposed_rule_ids,golden_case_ids,summary,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,JSON.stringify(input.sourceEvidenceIds),JSON.stringify(input.affectedProfileIds),JSON.stringify(input.proposedRuleIds),JSON.stringify(input.goldenCaseIds),input.summary||null,hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.sourceEvidenceIds,'rule_proposal',row.id,1);
 await audit(tx,ctx,{entityId,action:'rule_proposal.create',resourceType:'rule_proposal',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return proposalResource(row);
}
async function loadProposal(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Rule proposal not found.');
 const row=(await tx.query('select * from lara.rule_proposals where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Rule proposal not found.');return row;
}
export async function updateProposal(tx,ctx,entityId,id,expectedVersion,input,{cases=null}={}){
 requirePermission(ctx,'rule_proposal.edit');requireEntity(ctx,entityId);assertInput('RuleProposalCreate',input);
 const row=await loadProposal(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','assessed'].includes(row.state))fail('STATE_CONFLICT','An approved proposal is immutable.');
 await validateProposal(tx,ctx,entityId,input,{cases});
 const hash=contentHash(proposalMaterial(input));
 const updated=(await tx.query("update lara.rule_proposals set source_evidence_ids=$4,affected_profile_ids=$5,proposed_rule_ids=$6,golden_case_ids=$7,summary=$8,content_hash=$9,content_version=content_version+1,state='draft',impact=null,impact_hash=null,impact_passed=null where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,JSON.stringify(input.sourceEvidenceIds),JSON.stringify(input.affectedProfileIds),JSON.stringify(input.proposedRuleIds),JSON.stringify(input.goldenCaseIds),input.summary||null,hash])).rows[0];
 await audit(tx,ctx,{entityId,action:'rule_proposal.edit',resourceType:'rule_proposal',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return proposalResource(updated);
}
export async function getProposal(tx,ctx,entityId,id){requirePermission(ctx,'rule_proposal.read');requireEntity(ctx,entityId);return proposalResource(await loadProposal(tx,ctx,entityId,id));}
export async function listProposals(tx,ctx,entityId,query){
 requirePermission(ctx,'rule_proposal.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.rule_proposals where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,proposalResource,scope);
}
// The impact run: each golden case's tax effect recomputed with the proposed
// rule versions through the deterministic kernel, the affected profiles with
// their open periods and posted documents. History is read, never touched.
export async function assessProposal(tx,ctx,entityId,id,input,expectedVersion,{caseDefinitions=null}={}){
 requirePermission(ctx,'rule_proposal.impact');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadProposal(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','assessed'].includes(row.state))fail('STATE_CONFLICT','Proposal is '+row.state+'.');
 const rules=(await tx.query('select * from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[])',[ctx.tenantId,entityId,row.proposed_rule_ids])).rows;
 const cases=[];
 for(const caseId of row.golden_case_ids){
  const def=caseDefinitions?.get(caseId);
  if(!def){cases.push({caseId,ruleVersionId:null,expected:{},actual:{},passed:false,reason:'Golden case definition not shipped with this release.'});continue;}
  const base=def.lines.find(l=>['Revenue','Expense'].includes(l.account));const taxLine=def.lines.find(l=>['OutputTax','InputTax'].includes(l.account));
  if(!base||!taxLine){cases.push({caseId,ruleVersionId:null,expected:{},actual:{},passed:true,reason:'No tax effect in this case.'});continue;}
  const amount=base.account==='Revenue'?base.credit:base.debit;const expectedTax=taxLine.account==='OutputTax'?taxLine.credit:taxLine.debit;
  if(!rules.length){cases.push({caseId,ruleVersionId:null,expected:{tax:money(expectedTax)},actual:{},passed:false,reason:'No proposed rule to evaluate.'});continue;}
  for(const rule of rules){
   const computed=computeLines([{quantity:'1',unitPrice:money(amount),discount:'0',priceBasis:'exclusive',taxCodeId:rule.id}],new Map([[rule.id,{id:rule.id,rate:String(rule.rate),rounding:rule.rounding}]]));
   const actual=money(decimal(computed[0].tax,6));
   cases.push({caseId,ruleVersionId:rule.id,expected:{base:money(amount),tax:money(expectedTax)},actual:{base:money(amount),tax:actual,rate:String(rule.rate)},passed:actual===money(expectedTax),reason:actual===money(expectedTax)?null:'Proposed rate '+rule.rate+' yields '+actual+' on '+money(amount)+'; the case expects '+money(expectedTax)+'.'});
  }
 }
 const profiles=[];
 for(const pid of row.affected_profile_ids){
  const p=(await tx.query('select id,kind,version_number from lara.settings_versions where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,pid])).rows[0];
  const open=(await tx.query("select count(*)::int n from lara.periods where tenant_id=$1 and entity_id=$2 and status='open'",[ctx.tenantId,entityId])).rows[0].n;
  const posted=(await tx.query("select count(distinct d.id)::int n from lara.documents d join lara.document_lines l on l.tenant_id=d.tenant_id and l.document_id=d.id where d.tenant_id=$1 and d.entity_id=$2 and d.state='posted' and l.tax_code_id=any(select tax_code_id from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[]))",[ctx.tenantId,entityId,row.proposed_rule_ids])).rows[0].n;
  profiles.push({profileId:p.id,kind:p.kind,versionNumber:p.version_number,openPeriods:open,postedDocuments:posted});
 }
 const passed=cases.length>0&&cases.every(c=>c.passed);
 const impact={cases,profiles,historyUnchanged:true};
 const impactHash=sha(canonical({content:row.content_hash,impact}));
 const updated=(await tx.query("update lara.rule_proposals set state='assessed',impact=$4,impact_hash=$5,impact_passed=$6 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,JSON.stringify(impact),impactHash,passed])).rows[0];
 await audit(tx,ctx,{entityId,action:'rule_proposal.impact',resourceType:'rule_proposal',resourceId:id,resourceVersion:Number(updated.version),afterRef:impactHash,reason:passed?'all cases pass':'cases fail'});
 return {resourceType:'rule_proposal',resourceId:id,version:Number(updated.version),state:'assessed'};
}
export async function proposalImpact(tx,ctx,entityId,id){
 requirePermission(ctx,'rule_proposal.read');requireEntity(ctx,entityId);
 const row=await loadProposal(tx,ctx,entityId,id);
 return {proposalId:id,state:row.state,impactHash:row.impact_hash,passed:row.impact_passed,cases:row.impact?.cases||[],profiles:row.impact?.profiles||[],historyUnchanged:true,assessedAt:row.impact?iso(row.updated_at):null};
}
export async function approveProposal(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'rule_proposal.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadProposal(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='assessed')fail('STATE_CONFLICT','Run the impact assessment before deciding the proposal.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The proposer cannot approve the proposal; qualified review is independent.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The proposal changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'){if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});const rej=(await tx.query("update lara.rule_proposals set state='rejected' where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id])).rows[0];await audit(tx,ctx,{entityId,action:'rule_proposal.reject',resourceType:'rule_proposal',resourceId:id,resourceVersion:Number(rej.version),reason:input.reason});return {resourceType:'rule_proposal',resourceId:id,version:Number(rej.version),state:'rejected'};}
 if(!row.impact_passed)fail('STATE_CONFLICT','The proposal cannot be approved while a golden case fails; the software release assessment comes first.');
 const updated=(await tx.query("update lara.rule_proposals set state='approved',approved_by=$4,approved_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'rule_proposal.approve',resourceType:'rule_proposal',resourceId:id,resourceVersion:Number(updated.version),afterRef:row.impact_hash,reason:input.reason||null});
 await emit(tx,ctx,{entityId,aggregateType:'rule_proposal',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'rules.proposal_approved.v1',payload:{proposalId:id,proposedRuleIds:row.proposed_rule_ids,impactHash:row.impact_hash}});
 return {resourceType:'rule_proposal',resourceId:id,version:Number(updated.version),state:'approved'};
}

// ---------------------------------------------------------------------------
// P18C tool grants and runs
// ---------------------------------------------------------------------------
const TOOLS=['read_report','read_evidence','propose_draft','propose_task'];
const grantResource=g=>resource({...g,status:g.state},{clientId:g.client_id,tools:g.tools,entityIds:g.entity_ids,expiresAt:iso(g.expires_at),rateLimitPerMinute:g.rate_limit_per_minute,revokedReason:g.revoked_reason});
const grantMaterial=i=>({clientId:i.clientId,tools:[...i.tools].sort(),entityIds:[...i.entityIds].sort(),expiresAt:i.expiresAt,rateLimitPerMinute:i.rateLimitPerMinute||60});
async function validateGrant(tx,ctx,entityId,input){
 const client=(await tx.query("select id from lara.principals where tenant_id=$1 and id=$2 and status='active'",[ctx.tenantId,input.clientId])).rows[0];
 if(!client)fail('NOT_FOUND','Client principal not found.');
 if((await tx.query("select 1 from lara.memberships where tenant_id=$1 and principal_id=$2 and status='active'",[ctx.tenantId,input.clientId])).rowCount)fail('VALIDATION_FAILED','A client integration is a scoped identity without membership; a member does not need a grant.',{fieldErrors:[{path:'clientId',message:'Has a membership'}]});
 for(const e of input.entityIds)if(!ctx.entityIds.has(e))fail('NOT_FOUND','Entity not found.');
 if(new Date(input.expiresAt).getTime()<=Date.now())fail('VALIDATION_FAILED','The grant expires in the future.',{fieldErrors:[{path:'expiresAt',message:'Past'}]});
 if(new Date(input.expiresAt).getTime()>Date.now()+366*86400000)fail('VALIDATION_FAILED','Grants expire within a year.',{fieldErrors:[{path:'expiresAt',message:'Beyond a year'}]});
}
export async function createGrant(tx,ctx,entityId,input){
 requirePermission(ctx,'tool_grant.create');requireEntity(ctx,entityId);assertInput('ToolGrantCreate',input);await requireCapability(tx,ctx,entityId,'client_tools','client tools');
 await validateGrant(tx,ctx,entityId,input);
 const hash=contentHash(grantMaterial(input));
 const row=(await tx.query('insert into lara.tool_grants(tenant_id,entity_id,client_id,tools,entity_ids,expires_at,rate_limit_per_minute,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,input.clientId,input.tools,input.entityIds,input.expiresAt,input.rateLimitPerMinute||60,hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'tool_grant.create',resourceType:'tool_grant',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return grantResource(row);
}
async function loadGrant(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Tool grant not found.');
 const row=(await tx.query('select * from lara.tool_grants where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Tool grant not found.');return row;
}
export async function updateGrant(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'tool_grant.edit');requireEntity(ctx,entityId);assertInput('ToolGrantCreate',input);
 const row=await loadGrant(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','An approved grant never widens; revoke it and grant another.');
 await validateGrant(tx,ctx,entityId,input);
 const hash=contentHash(grantMaterial(input));
 const updated=(await tx.query('update lara.tool_grants set client_id=$4,tools=$5,entity_ids=$6,expires_at=$7,rate_limit_per_minute=$8,content_hash=$9,content_version=content_version+1 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,input.clientId,input.tools,input.entityIds,input.expiresAt,input.rateLimitPerMinute||60,hash])).rows[0];
 await audit(tx,ctx,{entityId,action:'tool_grant.edit',resourceType:'tool_grant',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return grantResource(updated);
}
export async function getGrant(tx,ctx,entityId,id){requirePermission(ctx,'tool_grant.read');requireEntity(ctx,entityId);return grantResource(await loadGrant(tx,ctx,entityId,id));}
export async function listGrants(tx,ctx,entityId,query){
 requirePermission(ctx,'tool_grant.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.tool_grants where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,grantResource,scope);
}
export async function approveGrant(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'tool_grant.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadGrant(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Grant is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who drafted the grant cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The grant changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'){if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});const rej=(await tx.query("update lara.tool_grants set state='revoked',revoked_reason=$4 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,input.reason])).rows[0];await audit(tx,ctx,{entityId,action:'tool_grant.reject',resourceType:'tool_grant',resourceId:id,resourceVersion:Number(rej.version),reason:input.reason});return {resourceType:'tool_grant',resourceId:id,version:Number(rej.version),state:'revoked'};}
 const updated=(await tx.query("update lara.tool_grants set state='approved',approved_by=$4,approved_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,ctx.principalId])).rows[0];
 await tx.query('update lara.principals set revocation_version=revocation_version+1 where tenant_id=$1 and id=$2',[ctx.tenantId,row.client_id]);
 await audit(tx,ctx,{entityId,action:'tool_grant.approve',resourceType:'tool_grant',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'tool_grant',resourceId:id,version:Number(updated.version),state:'approved'};
}
export async function revokeGrant(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'tool_grant.revoke');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadGrant(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','approved'].includes(row.state))fail('STATE_CONFLICT','Grant is '+row.state+'.');
 const updated=(await tx.query("update lara.tool_grants set state='revoked',revoked_reason=$4 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,input.reason])).rows[0];
 await tx.query('update lara.principals set revocation_version=revocation_version+1 where tenant_id=$1 and id=$2',[ctx.tenantId,row.client_id]);
 await audit(tx,ctx,{entityId,action:'tool_grant.revoke',resourceType:'tool_grant',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'tool_grant',resourceId:id,version:Number(updated.version),state:'revoked'};
}
// Identity scope for a client integration (identity.actorContext): the
// approved, unexpired grants of the principal give tool.execute over their
// entities and nothing else; the grant ids travel on the context.
export async function toolScope(tx,tenantId,principalId){
 const rows=(await tx.query("select id,entity_id,entity_ids,tools,expires_at,rate_limit_per_minute from lara.tool_grants where tenant_id=$1 and client_id=$2 and state='approved' and expires_at>now() order by created_at",[tenantId,principalId])).rows;
 if(!rows.length)return null;
 return {grants:rows.map(g=>({id:g.id,entityId:g.entity_id,entityIds:g.entity_ids,tools:g.tools,expiresAt:iso(g.expires_at),rateLimitPerMinute:g.rate_limit_per_minute})),entityIds:[...new Set(rows.flatMap(g=>g.entity_ids))]};
}
// A tool request under the grant: the tool must be granted, the request must
// match its schema, and every action is a read or a proposal. Denials are
// recorded with the reason so an injected instruction leaves evidence.
export async function runTool(tx,ctx,entityId,input,{caseDefinitions=null,commandId=null}={}){
 requirePermission(ctx,'tool.execute');requireEntity(ctx,entityId);assertInput('ToolRunRequest',input);
 // The grant that covers the entity and names the tool serves the call; when no grant names the tool, the first covering grant records the denial.
 const covering=(ctx.tool?.grants||[]).filter(g=>g.entityIds.includes(entityId));
 const grant=covering.find(g=>g.tools.includes(input.tool))||covering[0];
 if(!grant)fail('FORBIDDEN','No approved grant covers this entity.');
 const requestHash=sha(canonical({tool:input.tool,input:input.input}));
 const record=async(outcome,reason,resultType=null,resultId=null)=>(await tx.query('insert into lara.tool_runs(tenant_id,entity_id,grant_id,tool,request_hash,outcome,reason,result_resource_type,result_resource_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',[ctx.tenantId,entityId,grant.id,String(input.tool).slice(0,64),requestHash,outcome,reason,resultType,resultId,ctx.principalId])).rows[0].id;
 const deny=async reason=>{const id=await record('denied',reason);await audit(tx,ctx,{entityId,action:'tool.denied',resourceType:'tool_run',resourceId:id,resourceVersion:1,reason});return {runId:id,grantId:grant.id,tool:String(input.tool).slice(0,64),outcome:'denied',reason,result:null,resultResourceType:null,resultResourceId:null};};
 if(!TOOLS.includes(input.tool))return deny('Tool "'+String(input.tool).slice(0,64)+'" is not a client tool; clients read reports and evidence metadata and propose drafts or tasks only.');
 if(!grant.tools.includes(input.tool))return deny('Tool '+input.tool+' is not in the grant.');
 const recent=(await tx.query("select count(*)::int n from lara.tool_runs where tenant_id=$1 and grant_id=$2 and created_at>now()-interval '1 minute'",[ctx.tenantId,grant.id])).rows[0].n;
 if(recent>=grant.rateLimitPerMinute){const id=await record('rate_limited','Rate limit of '+grant.rateLimitPerMinute+' requests per minute reached.');return {runId:id,grantId:grant.id,tool:input.tool,outcome:'rate_limited',reason:'Rate limit reached; retry later.',result:null,resultResourceType:null,resultResourceId:null};}
 const arg=input.input||{};
 if(input.tool==='read_report'){
  if(!isUuid(arg.definitionId))return deny('read_report names a published report definition.');
  const def=(await tx.query("select * from lara.report_definitions where tenant_id=$1 and entity_id=$2 and id=$3 and state='published'",[ctx.tenantId,entityId,arg.definitionId])).rows[0];
  if(!def)return deny('The report definition is not published on this entity.');
  const actor={...ctx,permissions:new Set([...ctx.permissions,'report_definition.run',...def.ast.select.metrics.map(m=>CATALOG.metrics[m].permission)]),entityIds:new Set([entityId])};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(arg.periodStart))||!/^\d{4}-\d{2}-\d{2}$/.test(String(arg.periodEnd)))return deny('read_report needs periodStart and periodEnd.');
  const result=await runDefinition(tx,actor,entityId,def.id,{periodStart:arg.periodStart,periodEnd:arg.periodEnd,entityIds:[entityId]});
  const id=await record('served',null,'report_run',result.runId);
  return {runId:id,grantId:grant.id,tool:input.tool,outcome:'served',reason:null,result:{rows:result.rows,aggregate:result.aggregate,checksum:result.checksum},resultResourceType:'report_run',resultResourceId:result.runId};
 }
 if(input.tool==='read_evidence'){
  if(!isUuid(arg.evidenceId))return deny('read_evidence names an evidence id.');
  const e=(await tx.query("select id,filename,mime,byte_count,status,classification,created_at from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,arg.evidenceId])).rows[0];
  if(!e)return deny('Evidence not found on this entity.');
  if(e.classification==='restricted')return deny('Restricted evidence is not readable by client tools.');
  const id=await record('served',null,'evidence',e.id);
  return {runId:id,grantId:grant.id,tool:input.tool,outcome:'served',reason:null,result:{id:e.id,filename:e.filename,mime:e.mime,byteCount:e.byte_count,state:e.status,classification:e.classification,createdAt:iso(e.created_at)},resultResourceType:'evidence',resultResourceId:e.id};
 }
 // Proposals become tasks for a human: nothing posts, approves, pays, files or sends.
 const actor={...ctx,permissions:new Set([...ctx.permissions,'task.create'])};
 const reason=String(arg.reason||'').trim();
 if(!reason||reason.length>500)return deny('A proposal carries a reason of at most 500 characters.');
 if(input.tool==='propose_draft'){
  if(!Array.isArray(arg.lines)||!arg.lines.length||arg.lines.length>50)return deny('propose_draft carries 1–50 lines.');
  for(const l of arg.lines){if(!isUuid(l.accountId)||!/^\d{1,18}(\.\d{1,6})?$/.test(String(l.debit||'0'))||!/^\d{1,18}(\.\d{1,6})?$/.test(String(l.credit||'0')))return deny('Draft lines name an account and decimal amounts.');}
  const t=await workflow.openTask(tx,actor,entityId,{kind:'draft_proposal',sourceType:'tool_grant',sourceId:grant.id,reason:'Client draft proposal: '+reason+' | '+JSON.stringify(arg.lines).slice(0,1500)},{causeKey:requestHash.slice(0,16)});
  const id=await record('proposed',null,'task',t.task.id);
  await audit(tx,ctx,{entityId,action:'tool.propose_draft',resourceType:'task',resourceId:t.task.id,resourceVersion:1,reason});
  return {runId:id,grantId:grant.id,tool:input.tool,outcome:'proposed',reason:null,result:{taskId:t.task.id,state:t.task.state},resultResourceType:'task',resultResourceId:t.task.id};
 }
 const t=await workflow.openTask(tx,actor,entityId,{kind:'client_request',sourceType:'tool_grant',sourceId:grant.id,reason:'Client task proposal: '+reason},{causeKey:requestHash.slice(0,16)});
 const id=await record('proposed',null,'task',t.task.id);
 await audit(tx,ctx,{entityId,action:'tool.propose_task',resourceType:'task',resourceId:t.task.id,resourceVersion:1,reason});
 return {runId:id,grantId:grant.id,tool:input.tool,outcome:'proposed',reason:null,result:{taskId:t.task.id,state:t.task.state},resultResourceType:'task',resultResourceId:t.task.id};
}
export async function listToolRuns(tx,ctx,entityId,query){
 requirePermission(ctx,'tool_grant.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.grantId){if(!isUuid(query.grantId))fail('VALIDATION_FAILED','grantId must be a UUID.');params.push(query.grantId);where+=' and grant_id=$'+params.length;}
 return page((await tx.query('select * from lara.tool_runs where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,r=>({id:r.id,grantId:r.grant_id,tool:r.tool,outcome:r.outcome,reason:r.reason,resultResourceType:r.result_resource_type,resultResourceId:r.result_resource_id,createdAt:iso(r.created_at)}),scope);
}

// ---------------------------------------------------------------------------
// P18D industry packs
// ---------------------------------------------------------------------------
// The catalog ships with the release: packages/packs/<packId>/<version>/manifest.json.
export function packCatalog(root=new URL('../../packs/',import.meta.url)){
 const items=[];
 try{
  for(const packId of readdirSync(root)){
   const dir=new URL(packId+'/',root);
   let versions=[];try{versions=readdirSync(dir);}catch{continue;}
   for(const version of versions){
    const file=new URL(version+'/manifest.json',dir);
    if(!existsSync(file))continue;
    const raw=readFileSync(file,'utf8');const manifest=JSON.parse(raw);
    items.push({packId,version,title:manifest.title||packId,dependencies:manifest.dependencies||[],manifestHash:sha(canonical(manifest)),upgradesFrom:manifest.upgradesFrom||[],manifest});
   }
  }
 }catch{}
 return items.sort((a,b)=>a.packId===b.packId?(a.version<b.version?-1:1):(a.packId<b.packId?-1:1));
}
const packResource=p=>({id:p.id,versionNo:Number(p.version_no),packId:p.pack_id,version:p.version,manifestHash:p.manifest_hash,dependencies:p.dependencies,state:p.state,failureReason:p.failure_reason,jobId:p.job_id,previousId:p.previous_id,applied:p.applied,createdAt:iso(p.created_at),updatedAt:iso(p.updated_at)});
export async function listPacks(tx,ctx,entityId){requirePermission(ctx,'pack.read');requireEntity(ctx,entityId);return {items:packCatalog().map(({manifest,...rest})=>rest),nextCursor:null};}
export async function listInstalls(tx,ctx,entityId,query){
 requirePermission(ctx,'pack.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.pack_versions where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,packResource,scope);
}
// Install: the manifest hash must match the reviewed catalog, dependencies
// (capabilities and packs) must be satisfied, an upgrade must name a
// supported path; the row is created and a job applies it.
// Manifest versions compare numerically per component ('1.10.0' is later than '1.2.0').
export function compareVersions(a,b){const x=String(a).split('.').map(Number),y=String(b).split('.').map(Number);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)<(y[i]||0)?-1:1;}return 0;}
export async function requestInstall(tx,ctx,entityId,input,{catalog=null}={}){
 requirePermission(ctx,'pack.install');requireEntity(ctx,entityId);assertInput('PackInstall',input);await requireCapability(tx,ctx,entityId,'industry_packs','industry packs');
 const entry=(catalog||packCatalog()).find(p=>p.packId===input.packId&&p.version===input.version);
 if(!entry)fail('NOT_FOUND','Pack '+input.packId+' '+input.version+' is not in the reviewed catalog.');
 if(entry.manifestHash!==input.manifestHash)fail('VALIDATION_FAILED','The manifest hash does not match the reviewed catalog ('+entry.manifestHash+').',{fieldErrors:[{path:'manifestHash',message:'Mismatch'}]});
 const installed=(await tx.query("select * from lara.pack_versions where tenant_id=$1 and entity_id=$2 and pack_id=$3 and state='installed'",[ctx.tenantId,entityId,input.packId])).rows[0];
 if(installed){if(installed.version===input.version)fail('STATE_CONFLICT','This version is already installed.');if(!entry.upgradesFrom.includes(installed.version))fail('STATE_CONFLICT','Version '+input.version+' does not upgrade from the installed '+installed.version+'; unsupported paths stay disabled.');}
 else if(entry.upgradesFrom.length)fail('STATE_CONFLICT','Version '+input.version+' is an upgrade from '+entry.upgradesFrom.join(', ')+'; install a base version first.');
 for(const dep of entry.dependencies){
  const [kind,name,minVersion]=dep.split(':');
  if(kind==='capability'){if(!(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability=$3 and status='active'",[ctx.tenantId,entityId,name])).rowCount)fail('FEATURE_NOT_ENABLED','The pack needs the '+name+' capability active.');}
  else if(kind==='pack'){const p=(await tx.query("select version from lara.pack_versions where tenant_id=$1 and entity_id=$2 and pack_id=$3 and state='installed'",[ctx.tenantId,entityId,name])).rows[0];if(!p||(minVersion&&compareVersions(p.version,minVersion)<0))fail('STATE_CONFLICT','The pack needs '+name+(minVersion?' '+minVersion+' or later':'')+' installed.');}
  else fail('VALIDATION_FAILED','Unknown dependency kind in the manifest: '+kind+'.');
 }
 // An attempt whose job ended without applying (refused authority, dead letter) is closed as failed here so the pack is not locked forever; a live job still blocks.
 for(const p of (await tx.query("select p.id,j.state as job_state,j.error_code from lara.pack_versions p left join lara.jobs j on j.tenant_id=p.tenant_id and j.id=p.job_id where p.tenant_id=$1 and p.entity_id=$2 and p.pack_id=$3 and p.state='installing' for update of p",[ctx.tenantId,entityId,input.packId])).rows){
  if(p.job_state&&!['failed','dead_letter','cancelled','succeeded'].includes(p.job_state))fail('STATE_CONFLICT','An installation of this pack is in progress.');
  if(!p.job_state)fail('STATE_CONFLICT','An installation of this pack is in progress.');
  await tx.query("update lara.pack_versions set state='failed',failure_reason=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,p.id,'Install job '+p.job_state+(p.error_code?' ('+p.error_code+')':'')+' before the manifest was applied.']);
 }
 const row=(await tx.query('insert into lara.pack_versions(tenant_id,entity_id,pack_id,version,manifest,manifest_hash,dependencies,evidence_ids,previous_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,input.packId,input.version,JSON.stringify(entry.manifest),entry.manifestHash,JSON.stringify(entry.dependencies),JSON.stringify(input.evidenceIds),installed?.id||null,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'pack_version',row.id,1);
 const job=await enqueueJob(tx,ctx,{entityId,kind:'pack.install',payload:{packVersionId:row.id}});
 await tx.query('update lara.pack_versions set job_id=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,row.id,job.id]);
 await audit(tx,ctx,{entityId,action:'pack.install',resourceType:'pack_version',resourceId:row.id,resourceVersion:1,afterRef:entry.manifestHash});
 return {job,packVersionId:row.id};
}
// Worker: snapshot the profiles the manifest touches, apply the manifest's
// settings and report definitions as drafts under the installer's identity,
// mark installed and supersede the previous version.
export async function applyInstall(tx,ctx,packVersionId){
 const row=(await tx.query("select * from lara.pack_versions where tenant_id=$1 and id=$2 and state='installing' for update",[ctx.tenantId,packVersionId])).rows[0];
 if(!row)return null;
 const entityId=row.entity_id;
 // The application runs under a savepoint: a failure leaves the version `failed` with its reason and nothing applied, and the job completes with that outcome.
 await tx.query('savepoint pack_apply');
 try{
  const kinds=Object.keys(row.manifest.settings||{});
  const snapshot={settings:{},reportDefinitions:[]};
  for(const kind of kinds){const cur=(await tx.query("select id,version_number,payload,status from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind=$3 order by version_number desc limit 1",[ctx.tenantId,entityId,kind])).rows[0];snapshot.settings[kind]=cur?{id:cur.id,versionNumber:cur.version_number,payload:cur.payload,status:cur.status}:null;}
  const applied={settings:{},reportDefinitions:[]};
  const actor={...ctx,principalId:row.created_by,permissions:new Set(['entity.edit','report_definition.create','entity.read']),entityIds:new Set([entityId]),traceId:'pack-'+row.id};
  for(const [kind,payload] of Object.entries(row.manifest.settings||{})){const s=await organization.saveSettings(tx,actor,entityId,kind,{...payload,packId:row.pack_id,packVersion:row.version});applied.settings[kind]={id:s.id,versionNumber:s.versionNumber??null};}
  for(const def of row.manifest.reportDefinitions||[]){const d=await createDefinition(tx,actor,entityId,{name:def.name,metricIds:def.metricIds,dimensionIds:def.dimensionIds||[],filters:def.filters||[],sort:def.sort||[]});applied.reportDefinitions.push(d.id);}
  if(row.previous_id)await tx.query("update lara.pack_versions set state='superseded' where tenant_id=$1 and id=$2",[ctx.tenantId,row.previous_id]);
  await tx.query("update lara.pack_versions set state='installed',snapshot=$3,applied=$4 where tenant_id=$1 and id=$2",[ctx.tenantId,row.id,JSON.stringify(snapshot),JSON.stringify(applied)]);
  await audit(tx,{...ctx,principalId:row.created_by},{entityId,action:'pack.installed',resourceType:'pack_version',resourceId:row.id,resourceVersion:2,afterRef:row.manifest_hash});
  return {resourceType:'pack_version',resourceId:row.id};
 }catch(e){
  await tx.query('rollback to savepoint pack_apply');
  await tx.query("update lara.pack_versions set state='failed',failure_reason=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,row.id,String(e.message).slice(0,500)]);
  await audit(tx,{...ctx,principalId:row.created_by},{entityId,action:'pack.install_failed',resourceType:'pack_version',resourceId:row.id,resourceVersion:2,reason:String(e.message).slice(0,500)});
  return {resourceType:'pack_version',resourceId:row.id,state:'failed'};
 }
}
// Rollback: the installed version's snapshot is restored as new draft
// settings versions (never a rewrite of history), its report definitions are
// retired and the previous version, if any, becomes installed again.
export async function requestRollback(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'pack.install');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 if(!isUuid(id))fail('NOT_FOUND','Pack version not found.');
 const row=(await tx.query('select * from lara.pack_versions where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Pack version not found.');if(expectedVersion!==undefined)expectVersion({version:row.version_no},expectedVersion);
 if(row.state!=='installed')fail('STATE_CONFLICT','Only an installed version rolls back.');
 const job=await enqueueJob(tx,ctx,{entityId,kind:'pack.rollback',payload:{packVersionId:id,reason:input.reason}});
 await audit(tx,ctx,{entityId,action:'pack.rollback',resourceType:'pack_version',resourceId:id,resourceVersion:Number(row.version_no),reason:input.reason});
 return job;
}
export async function applyRollback(tx,ctx,packVersionId,reason){
 const row=(await tx.query("select * from lara.pack_versions where tenant_id=$1 and id=$2 and state='installed' for update",[ctx.tenantId,packVersionId])).rows[0];
 if(!row)return null;
 const entityId=row.entity_id;
 const actor={...ctx,principalId:row.created_by,permissions:new Set(['entity.edit','report_definition.create','entity.read']),entityIds:new Set([entityId]),traceId:'pack-rollback-'+row.id};
 for(const [kind,prior] of Object.entries(row.snapshot.settings||{})){if(prior&&prior.payload)await organization.saveSettings(tx,actor,entityId,kind,prior.payload);}
 for(const defId of row.applied.reportDefinitions||[])await tx.query("update lara.report_definitions set state='retired' where tenant_id=$1 and id=$2 and state<>'retired'",[ctx.tenantId,defId]);
 await tx.query("update lara.pack_versions set state='rolled_back' where tenant_id=$1 and id=$2",[ctx.tenantId,row.id]);
 if(row.previous_id)await tx.query("update lara.pack_versions set state='installed' where tenant_id=$1 and id=$2 and state='superseded'",[ctx.tenantId,row.previous_id]).catch(()=>{});
 await audit(tx,{...ctx,principalId:row.created_by},{entityId,action:'pack.rolled_back',resourceType:'pack_version',resourceId:row.id,resourceVersion:Number(row.version_no)+1,reason});
 return {resourceType:'pack_version',resourceId:row.id};
}
