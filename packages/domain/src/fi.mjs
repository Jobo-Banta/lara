// Financial institution coexistence (P08): named source systems with approved
// ownership windows, reviewed account mapping versions, canonical journal and
// balance feeds staged through the import pipeline with manifests checked
// before approval, one posting per batch with linked replacements, expected
// batch deadlines that block only the affected close, source balance
// reconciliation, instrument facts classified through reviewed tax rules, and
// branch roll-ups whose interbranch pairs cancel at the entity without any
// cross-entity consolidation. Core banking, valuation, lending and ECL stay in
// their authoritative systems.
import {createHash} from 'node:crypto';
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {linkEvidence} from './evidence.mjs';
import {micros,decimal,signedMicros,addCloseTask} from './ledger.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const money=v=>decimal(micros(String(v)),2);
const MICRO=1000000n;
const CODE=/^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const FAMILY=/^[a-z][a-z0-9_]{0,63}$/;

// ---------------------------------------------------------------------------
// Capability and profile
// ---------------------------------------------------------------------------
export async function requireFi(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='fi_coexistence' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The financial institution coexistence capability is not active for this entity.');
}
// The approved institution profile: interbranch accounts and the reviewed
// instrument classification (income category and maturity band → tax rule code).
export async function fiProfile(tx,ctx,entityId){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='fi_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved institution profile (interbranch accounts, instrument classification) is required.');
 const p=row.payload;
 const rules=Array.isArray(p.instrumentRules)?p.instrumentRules.filter(r=>r&&typeof r.ruleCode==='string'&&typeof r.incomeCategory==='string'):[];
 return {dueFromAccountId:isUuid(p.dueFromAccountId)?p.dueFromAccountId:null,dueToAccountId:isUuid(p.dueToAccountId)?p.dueToAccountId:null,instrumentRules:rules.map(r=>({incomeCategory:r.incomeCategory,instrumentType:typeof r.instrumentType==='string'?r.instrumentType:null,maxMaturityYears:Number.isFinite(r.maxMaturityYears)?r.maxMaturityYears:null,minMaturityYears:Number.isFinite(r.minMaturityYears)?r.minMaturityYears:null,ruleCode:r.ruleCode})),vatRegistered:p.vatRegistered!==false,profileVersion:typeof p.profileVersion==='string'?p.profileVersion:'fi-1'};
}

// ---------------------------------------------------------------------------
// Source systems
// ---------------------------------------------------------------------------
const systemResource=r=>({id:r.id,version:Number(r.version),code:r.code,name:r.name,ownerName:r.owner_name,ownerPrincipalId:r.owner_principal_id,granularity:r.granularity,cutoffTimezone:r.cutoff_timezone,feedFormat:r.feed_format,state:r.status,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
export async function createSourceSystem(tx,ctx,entityId,{code,name,ownerName,ownerPrincipalId=null,granularity='detail',cutoffTimezone='Asia/Manila'}){
 requirePermission(ctx,'source_ownership.create');requireEntity(ctx,entityId);await requireFi(tx,ctx,entityId);
 if(!CODE.test(String(code||'')))fail('VALIDATION_FAILED','Source system codes are upper-case identifiers.',{fieldErrors:[{path:'code',message:'Invalid code'}]});
 if(!['detail','summary'].includes(granularity))fail('VALIDATION_FAILED','granularity is detail or summary.',{fieldErrors:[{path:'granularity',message:'Invalid'}]});
 const row=(await tx.query('insert into lara.source_systems(tenant_id,entity_id,code,name,owner_name,owner_principal_id,granularity,cutoff_timezone,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,code,String(name||code).trim(),String(ownerName||'unassigned').trim(),ownerPrincipalId,granularity,cutoffTimezone,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'source_system.create',resourceType:'source_system',resourceId:row.id,resourceVersion:1});
 return systemResource(row);
}
export async function listSourceSystems(tx,ctx,entityId,query){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.source_systems where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,systemResource,scope);
}
async function systemByCode(tx,ctx,entityId,code){
 const row=(await tx.query("select * from lara.source_systems where tenant_id=$1 and entity_id=$2 and code=$3 and status='active'",[ctx.tenantId,entityId,String(code||'').trim().toUpperCase()])).rows[0];
 if(!row)fail('VALIDATION_FAILED','sourceId names an active source system code.',{fieldErrors:[{path:'sourceId',message:'Unknown source system'}]});
 return row;
}

// ---------------------------------------------------------------------------
// Source ownership: reviewed operations
// ---------------------------------------------------------------------------
const ownershipResource=r=>resource(r,{sourceSystem:r.source_system,bookId:r.book_id,transactionFamily:r.transaction_family,effectiveFrom:iso(r.effective_from),...(r.effective_to?{effectiveTo:iso(r.effective_to)}:{}),evidenceIds:r.evidence_ids});
async function loadOwnership(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Source ownership not found.');const row=(await tx.query('select * from lara.source_ownership where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Source ownership not found.');return row;}
async function checkOwnershipInput(tx,ctx,entityId,input){
 if(!CODE.test(input.sourceSystem))fail('VALIDATION_FAILED','sourceSystem is an upper-case system code.',{fieldErrors:[{path:'sourceSystem',message:'Invalid code'}]});
 if(!FAMILY.test(input.transactionFamily))fail('VALIDATION_FAILED','transactionFamily is a lower-case identifier.',{fieldErrors:[{path:'transactionFamily',message:'Invalid'}]});
 if(input.effectiveTo&&input.effectiveTo<input.effectiveFrom)fail('VALIDATION_FAILED','effectiveTo precedes effectiveFrom.',{fieldErrors:[{path:'effectiveTo',message:'Before start'}]});
 const book=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,input.bookId])).rows[0];
 if(!book)fail('NOT_FOUND','Book not found.');
 const evidence=(await tx.query("select count(*)::int n from lara.evidence where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[]) and status='available'",[ctx.tenantId,entityId,input.evidenceIds])).rows[0].n;
 if(evidence!==input.evidenceIds.length)fail('EVIDENCE_NOT_READY','Every ownership evidence file must be available.');
}
export async function createSourceOwnership(tx,ctx,entityId,input){
 requirePermission(ctx,'source_ownership.create');requireEntity(ctx,entityId);assertInput('SourceOwnershipCreate',input);await requireFi(tx,ctx,entityId);
 await checkOwnershipInput(tx,ctx,entityId,input);
 const row=(await tx.query('insert into lara.source_ownership(tenant_id,entity_id,book_id,source_system,transaction_family,effective_from,effective_to,evidence_ids,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,input.bookId,input.sourceSystem,input.transactionFamily,input.effectiveFrom,input.effectiveTo||null,JSON.stringify([...input.evidenceIds].sort()),ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'source_ownership',row.id,1);
 await audit(tx,ctx,{entityId,action:'source_ownership.create',resourceType:'source_ownership',resourceId:row.id,resourceVersion:1});
 return ownershipResource(row);
}
export async function updateSourceOwnership(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'source_ownership.edit');requireEntity(ctx,entityId);assertInput('SourceOwnershipCreate',input);
 const row=await loadOwnership(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(row.status!=='draft')fail('STATE_CONFLICT','Only draft source ownership changes; approved records are replaced by a new one.');
 await checkOwnershipInput(tx,ctx,entityId,input);
 const updated=(await tx.query('update lara.source_ownership set book_id=$3,source_system=$4,transaction_family=$5,effective_from=$6,effective_to=$7,evidence_ids=$8,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.bookId,input.sourceSystem,input.transactionFamily,input.effectiveFrom,input.effectiveTo||null,JSON.stringify([...input.evidenceIds].sort())])).rows[0];
 await audit(tx,ctx,{entityId,action:'source_ownership.edit',resourceType:'source_ownership',resourceId:id,resourceVersion:Number(updated.version)});
 return ownershipResource(updated);
}
export async function approveSourceOwnership(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'source_ownership.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadOwnership(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='draft')fail('STATE_CONFLICT','Source ownership is '+row.status+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The author cannot approve the ownership record.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The record changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const updated=(await tx.query('update lara.source_ownership set status=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.decision==='approve'?'approved':'rejected',input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'source_ownership.'+input.decision,resourceType:'source_ownership',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'source_ownership',resourceId:id,version:Number(updated.version),state:updated.status};
}
export async function getSourceOwnership(tx,ctx,entityId,id){requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);return ownershipResource(await loadOwnership(tx,ctx,entityId,id,{lock:false}));}
export async function listSourceOwnership(tx,ctx,entityId,query){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.source_ownership where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,ownershipResource,scope);
}
// Ingestion requires an approved window for the system, book and family on the cutoff date.
export async function effectiveOwnership(tx,ctx,entityId,{bookId,sourceSystem,family,onDate}){
 const row=(await tx.query("select * from lara.source_ownership where tenant_id=$1 and entity_id=$2 and book_id=$3 and transaction_family=$4 and status='approved' and effective_from<=$5::date and (effective_to is null or effective_to>=$5::date)",[ctx.tenantId,entityId,bookId,family,onDate])).rows[0];
 if(!row)fail('STATE_CONFLICT','No approved source ownership covers family '+family+' in this book on '+onDate+'; ingestion needs effective ownership.');
 if(row.source_system!==sourceSystem)fail('STATE_CONFLICT','Family '+family+' is owned by '+row.source_system+' on '+onDate+', not '+sourceSystem+'.');
 return row;
}

// ---------------------------------------------------------------------------
// Mapping versions: source account → target account, dimensions, tax profile
// ---------------------------------------------------------------------------
const mappingResource=r=>({id:r.id,version:Number(r.version),contentVersion:Number(r.content_version),sourceSystemId:r.source_system_id,versionLabel:r.version_label,evidenceId:r.evidence_id,hash:r.hash,lineCount:r.line_count,state:r.status,approvedBy:r.approved_by,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
const cells=l=>{const out=[];let cur='',q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'&&l[i+1]==='"'){cur+='"';i++;}else if(ch==='"')q=false;else cur+=ch;}else if(ch==='"')q=true;else if(ch===','){out.push(cur);cur='';}else cur+=ch;}out.push(cur);return out.map(c=>c.trim());};
const parseCsv=(text,required,label)=>{
 const lines=text.replace(/\r\n/g,'\n').split('\n').filter(l=>l.trim());
 if(lines.length<2)fail('VALIDATION_FAILED','The '+label+' CSV needs a header and at least one row.');
 const header=cells(lines[0]).map(h=>h.toLowerCase());
 for(const r of required)if(!header.includes(r))fail('VALIDATION_FAILED',label+' CSV header lacks '+r+'.',{fieldErrors:[{path:'header',message:'Missing '+r}]});
 return {header,rows:lines.slice(1).map((l,i)=>{const c=cells(l);const row={};header.forEach((h,j)=>{row[h]=c[j]??'';});row.rowNo=i+1;row.raw=l;return row;})};
};
const parseDims=text=>{if(!text)return {};const t=text.trim();if(t.startsWith('{')){try{const o=JSON.parse(t);return o&&typeof o==='object'&&!Array.isArray(o)?o:null;}catch{return null;}}const out={};for(const part of t.split(';')){const [k,...v]=part.split('=');if(!k.trim()||!v.length)return null;out[k.trim()]=v.join('=').trim();}return out;};
export function parseMappingCsv(text){
 const {rows}=parseCsv(text,['source_account','target_account_code'],'mapping');
 return rows.map(r=>{
  if(!r.source_account)fail('VALIDATION_FAILED','Mapping row '+r.rowNo+' lacks a source account.',{fieldErrors:[{path:'rows.'+r.rowNo,message:'source_account'}]});
  if(!r.target_account_code)fail('VALIDATION_FAILED','Mapping row '+r.rowNo+' lacks a target account.',{fieldErrors:[{path:'rows.'+r.rowNo,message:'target_account_code'}]});
  const dims=parseDims(r.dimensions||'');if(dims===null)fail('VALIDATION_FAILED','Mapping row '+r.rowNo+' has invalid dimensions.',{fieldErrors:[{path:'rows.'+r.rowNo,message:'dimensions'}]});
  if(r.tax_profile&&!FAMILY.test(r.tax_profile))fail('VALIDATION_FAILED','Mapping row '+r.rowNo+' has an invalid tax profile.',{fieldErrors:[{path:'rows.'+r.rowNo,message:'tax_profile'}]});
  return {sourceAccount:r.source_account,targetAccountCode:r.target_account_code.toUpperCase(),dimensions:dims,taxProfile:r.tax_profile||null};
 });
}
export async function importMappingVersion(tx,ctx,entityId,{sourceSystemId,bookId,versionLabel,evidenceId},{store}){
 requirePermission(ctx,'source_ownership.create');requireEntity(ctx,entityId);await requireFi(tx,ctx,entityId);
 const system=(await tx.query("select * from lara.source_systems where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,sourceSystemId])).rows[0];
 if(!system)fail('NOT_FOUND','Source system not found.');
 const evidence=(await tx.query("select * from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,evidenceId])).rows[0];
 if(!evidence)fail('NOT_FOUND','Evidence not found.');
 if(evidence.status!=='available')fail('EVIDENCE_NOT_READY','Mapping evidence must be available.');
 const bytes=await store.get(evidence.object_key);
 const hash=sha(bytes);if(hash!==evidence.sha256)fail('STATE_CONFLICT','Evidence content no longer matches its recorded hash.');
 const lines=parseMappingCsv(bytes.toString('utf8'));
 const accounts=new Map((await tx.query("select id,code,status,(select count(*) from lara.accounts c where c.tenant_id=a.tenant_id and c.parent_id=a.id and c.status<>'archived') as children from lara.accounts a where tenant_id=$1 and entity_id=$2 and book_id=$3",[ctx.tenantId,entityId,bookId])).rows.map(a=>[a.code,a]));
 const seen=new Set();
 for(const l of lines){
  if(seen.has(l.sourceAccount))fail('VALIDATION_FAILED','Source account '+l.sourceAccount+' is mapped twice.',{fieldErrors:[{path:l.sourceAccount,message:'Duplicate'}]});seen.add(l.sourceAccount);
  const a=accounts.get(l.targetAccountCode);
  if(!a)fail('VALIDATION_FAILED','Target account '+l.targetAccountCode+' does not exist in the book.',{fieldErrors:[{path:l.sourceAccount,message:'Unknown target'}]});
  if(a.status!=='active'||Number(a.children)>0)fail('VALIDATION_FAILED','Target account '+l.targetAccountCode+' must be an active leaf.',{fieldErrors:[{path:l.sourceAccount,message:'Not postable'}]});
  l.targetAccountId=a.id;
 }
 const row=(await tx.query('insert into lara.mapping_versions(tenant_id,entity_id,source_system_id,version_label,evidence_id,hash,line_count,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[ctx.tenantId,entityId,sourceSystemId,String(versionLabel).trim(),evidenceId,hash,lines.length,ctx.principalId])).rows[0];
 for(const l of lines)await tx.query('insert into lara.mapping_lines(tenant_id,entity_id,mapping_version_id,source_account,target_account_id,dimensions_json,tax_profile) values($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,entityId,row.id,l.sourceAccount,l.targetAccountId,JSON.stringify(l.dimensions),l.taxProfile]);
 await linkEvidence(tx,ctx,entityId,[evidenceId],'mapping_version',row.id,1);
 await audit(tx,ctx,{entityId,action:'mapping_version.import',resourceType:'mapping_version',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return mappingResource(row);
}
export async function approveMappingVersion(tx,ctx,entityId,id,{decision='approve',reason=null}={}){
 requirePermission(ctx,'source_ownership.approve');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.mapping_versions where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Mapping version not found.');
 if(row.status!=='draft')fail('STATE_CONFLICT','Mapping version is '+row.status+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The importer cannot approve the mapping version.');
 if(decision==='reject'&&!reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const updated=(await tx.query('update lara.mapping_versions set status=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,decision==='approve'?'approved':'rejected',decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'mapping_version.'+decision,resourceType:'mapping_version',resourceId:id,resourceVersion:Number(updated.version),reason,afterRef:row.hash});
 return mappingResource(updated);
}
export async function listMappingVersions(tx,ctx,entityId,query){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.sourceSystemId){if(!isUuid(query.sourceSystemId))fail('VALIDATION_FAILED','sourceSystemId must be a UUID.');params.push(query.sourceSystemId);where+=' and source_system_id=$'+params.length;}
 const rows=(await tx.query('select * from lara.mapping_versions where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,mappingResource,scope);
}
async function mappingLineRows(tx,ctx,id){
 return (await tx.query('select l.source_account,l.target_account_id,a.code as target_account_code,l.dimensions_json,l.tax_profile from lara.mapping_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.target_account_id where l.tenant_id=$1 and l.mapping_version_id=$2 order by l.source_account',[ctx.tenantId,id])).rows.map(l=>({sourceAccount:l.source_account,targetAccountId:l.target_account_id,targetAccountCode:l.target_account_code,dimensions:l.dimensions_json,taxProfile:l.tax_profile}));
}
// Lines of a version with the diff against another version of the same
// source system (added, removed and changed source accounts).
export async function mappingLines(tx,ctx,entityId,id,{againstId=null}={}){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);
 if(!isUuid(id))fail('NOT_FOUND','Mapping version not found.');
 const row=(await tx.query('select * from lara.mapping_versions where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Mapping version not found.');
 const lines=await mappingLineRows(tx,ctx,id);
 let diff={againstId:null,added:[],removed:[],changed:[]};
 if(againstId){
  if(!isUuid(againstId))fail('VALIDATION_FAILED','againstId must be a UUID.',{fieldErrors:[{path:'againstId',message:'UUID'}]});
  const other=(await tx.query('select id from lara.mapping_versions where tenant_id=$1 and entity_id=$2 and id=$3 and source_system_id=$4',[ctx.tenantId,entityId,againstId,row.source_system_id])).rows[0];
  if(!other)fail('NOT_FOUND','The comparison version is not a version of the same source system.');
  const before=new Map((await mappingLineRows(tx,ctx,againstId)).map(l=>[l.sourceAccount,l]));
  const same=(a,b)=>a.targetAccountId===b.targetAccountId&&contentHash(a.dimensions)===contentHash(b.dimensions)&&a.taxProfile===b.taxProfile;
  diff={againstId,added:lines.filter(l=>!before.has(l.sourceAccount)),removed:[...before.values()].filter(b=>!lines.some(l=>l.sourceAccount===b.sourceAccount)),changed:lines.filter(l=>before.has(l.sourceAccount)&&!same(l,before.get(l.sourceAccount))).map(l=>({sourceAccount:l.sourceAccount,from:before.get(l.sourceAccount),to:l}))};
 }
 return {id:row.id,versionLabel:row.version_label,state:row.status,lines,diff};
}

// ---------------------------------------------------------------------------
// Canonical feed contract (lara-feed-1)
// Journal: external_line_id, accounting_date, book_code, branch_code,
//   account_code, currency, debit, credit, source_document_ref, dimensions,
//   tax_event_ref, and optional instrument_ref, instrument_type, maturity_date,
//   income_category. Balances: external_line_id, cutoff_date, book_code,
//   branch_code, account_code, currency, balance. The MANIFEST row declares
//   count=<n>;sha256=<hex of the data lines> in account_code, the debit and
//   credit (or balance) totals, currency totals as JSON in dimensions,
//   replaces=<external batch id> in source_document_ref for a correction and
//   partial_ok in tax_event_ref when the batch is not atomic.
// ---------------------------------------------------------------------------
export function parseFeedCsv(text,kind){
 const required=kind==='journal'?['external_line_id','accounting_date','book_code','branch_code','account_code','currency','debit','credit','source_document_ref','dimensions','tax_event_ref']:['external_line_id','cutoff_date','book_code','branch_code','account_code','currency','balance'];
 const {rows}=parseCsv(text,required,kind==='journal'?'journal feed':'balance feed');
 const data=rows.filter(r=>r.external_line_id!=='MANIFEST'),manifests=rows.filter(r=>r.external_line_id==='MANIFEST');
 let manifest=null;
 if(manifests.length===1){
  const m=manifests[0];const fields={};for(const part of String(m.account_code||'').split(';')){const [k,...v]=part.split('=');if(k.trim())fields[k.trim()]=v.join('=').trim();}
  const totals=kind==='journal'?{debit:m.debit||'0',credit:m.credit||'0'}:{balance:m.balance||'0'};
  manifest={count:fields.count!==undefined?Number(fields.count):null,sha256:fields.sha256||null,...totals,currencyTotals:parseDims(m.dimensions||'')||{},replaces:(m.source_document_ref||'').startsWith('replaces=')?m.source_document_ref.slice(9).trim():null,atomic:kind!=='journal'||(m.tax_event_ref||'').trim()!=='partial_ok'};
 }
 const dataHash=sha(data.map(r=>r.raw.replace(/\r$/,'')).join('\n'));
 return {rows:data,manifest,manifestCount:manifests.length,dataHash};
}
const batchResource=r=>({id:r.id,version:Number(r.version),contentVersion:Number(r.content_version),importId:r.import_id,sourceSystemId:r.source_system_id,sourceSystemCode:r.source_code||r.sourceSystemCode||'',bookId:r.book_id,kind:r.kind,externalBatchId:r.external_batch_id,checksum:r.checksum,mappingVersionId:r.mapping_version_id,atomic:r.atomic,manifest:r.manifest_json,rowCount:r.row_count,errorCount:r.error_count,debitTotal:money(r.debit_total),creditTotal:money(r.credit_total),currencyTotals:r.currency_totals,duplicateCount:r.duplicate_count,replacesBatchId:r.replaces_batch_id,replacedByBatchId:r.replaced_by_batch_id,postedEntryId:r.posted_entry_id,reversalEntryId:r.reversal_entry_id,state:r.state,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
const familyOf=kind=>kind==='journal'?'journal':'balances';

// The import pipeline hooks (ledger.createImport/validateImport/approveImport/commitImport).
export const sourceFeed={
 // Before staging: capability, source system, effective ownership, the
 // mapping version, and the duplicate rule — the same batch id with the same
 // checksum is the same batch (counted, never re-staged); a different checksum
 // under the same id is a conflict, never a silent overwrite.
 async prepare(tx,ctx,entityId,input){
  await requireFi(tx,ctx,entityId);
  const system=await systemByCode(tx,ctx,entityId,input.sourceId);
  const evidence=(await tx.query("select id,sha256,status from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,input.evidenceId])).rows[0];
  if(!evidence)fail('NOT_FOUND','Evidence not found.');
  const existing=(await tx.query("select * from lara.source_batches where tenant_id=$1 and entity_id=$2 and source_system_id=$3 and external_batch_id=$4 and state<>'rejected' order by created_at desc limit 1 for update",[ctx.tenantId,entityId,system.id,input.externalBatchId.trim()])).rows[0];
  if(existing){
   if(existing.checksum!==evidence.sha256)fail('DUPLICATE_SOURCE','Batch '+input.externalBatchId.trim()+' from '+system.code+' was already presented with a different checksum; a correction is a new batch that names the one it replaces.',{fieldErrors:[{path:'externalBatchId',message:'Checksum conflict'}]});
   await tx.query('update lara.source_batches set duplicate_count=duplicate_count+1 where tenant_id=$1 and id=$2',[ctx.tenantId,existing.id]);
   await audit(tx,ctx,{entityId,action:'source_batch.duplicate',resourceType:'source_batch',resourceId:existing.id,resourceVersion:Number(existing.version),reason:'presented again with the same checksum'});
   const imp=(await tx.query('select * from lara.opening_batches where tenant_id=$1 and id=$2',[ctx.tenantId,existing.import_id])).rows[0];
   return {existing:imp};
  }
  const bookId=input.bookId||(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary' and status='active'",[ctx.tenantId,entityId])).rows[0]?.id;
  if(!bookId)fail('STATE_CONFLICT','No active primary book.');
  await effectiveOwnership(tx,ctx,entityId,{bookId,sourceSystem:system.code,family:familyOf(input.kind),onDate:input.cutoffDate});
  let mapping=null;
  if(input.kind==='journal'){
   mapping=(await tx.query("select * from lara.mapping_versions where tenant_id=$1 and entity_id=$2 and source_system_id=$3 and version_label=$4 and status='approved'",[ctx.tenantId,entityId,system.id,input.mappingVersion.trim()])).rows[0];
   if(!mapping)fail('VALIDATION_FAILED','mappingVersion names an approved mapping version of '+system.code+'.',{fieldErrors:[{path:'mappingVersion',message:'No approved mapping version'}]});
  }
  return {bookId,system,mapping};
 },
 async created(tx,ctx,entityId,imp,feed){
  const row=(await tx.query('insert into lara.source_batches(tenant_id,entity_id,book_id,source_system_id,import_id,kind,external_batch_id,checksum,mapping_version_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,imp.book_id,feed.system.id,imp.id,imp.kind,imp.external_batch_id,imp.checksum,feed.mapping?.id||null,ctx.principalId])).rows[0];
  await audit(tx,ctx,{entityId,action:'source_batch.stage',resourceType:'source_batch',resourceId:row.id,resourceVersion:1,afterRef:imp.checksum});
 },
 // Validation stages the canonical rows and checks the declared manifest:
 // a count, total or hash mismatch is an error the batch cannot carry into
 // approval (P08-T03).
 async validate(tx,ctx,entityId,imp,text){
  const batch=(await tx.query('select * from lara.source_batches where tenant_id=$1 and import_id=$2 for update',[ctx.tenantId,imp.id])).rows[0];
  const system=(await tx.query('select * from lara.source_systems where tenant_id=$1 and id=$2',[ctx.tenantId,batch.source_system_id])).rows[0];
  const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,batch.book_id])).rows[0];
  const parsed=parseFeedCsv(text,batch.kind);
  const branches=new Map((await tx.query("select id,code from lara.branches where tenant_id=$1 and entity_id=$2 and status='active'",[ctx.tenantId,entityId])).rows.map(b=>[b.code,b.id]));
  const mapping=batch.mapping_version_id?new Map((await tx.query('select l.*,a.status as account_status,(select count(*) from lara.accounts c where c.tenant_id=a.tenant_id and c.parent_id=a.id and c.status<>\'archived\') as children from lara.mapping_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.target_account_id where l.tenant_id=$1 and l.mapping_version_id=$2',[ctx.tenantId,batch.mapping_version_id])).rows.map(l=>[l.source_account,l])):new Map();
  const cutoff=iso(imp.cutoff);
  let debit=0n,credit=0n,errors=0;const ccy={};const seen=new Set();const dates=new Set();const fieldErrors=[];
  const out=[];
  for(const r of parsed.rows){
   let error=null,branchId=null,targetId=null,d=0n,c=0n,dims={},instrument=null;
   const amountField=batch.kind==='journal'?null:'balance';
   if(!r.external_line_id)error='external line id required';
   else if(seen.has(r.external_line_id))error='duplicate external line id';
   seen.add(r.external_line_id);
   const date=batch.kind==='journal'?r.accounting_date:r.cutoff_date;
   if(!error&&!/^\d{4}-\d{2}-\d{2}$/.test(date))error='invalid date';
   else if(!error&&date>cutoff)error='date after cutoff';
   if(!error&&r.book_code.toUpperCase()!==book.code)error='book '+r.book_code+' is not this book';
   if(!error){branchId=branches.get(r.branch_code.toUpperCase())||null;if(!branchId)error='unknown branch '+r.branch_code;}
   if(!error&&r.currency!==book.functional_currency)error='currency '+r.currency+' is outside this book until separate books (P09)';
   if(!error&&batch.kind==='journal'){
    const m=mapping.get(r.account_code);
    if(!m)error='unmapped source account '+r.account_code;
    else if(m.account_status!=='active'||Number(m.children)>0)error='target account for '+r.account_code+' is not postable';
    else{targetId=m.target_account_id;const rowDims=parseDims(r.dimensions);if(rowDims===null)error='invalid dimensions';else dims={...m.dimensions_json,...rowDims};}
    if(!error){try{d=micros(r.debit||'0');c=micros(r.credit||'0');if((d>0n)===(c>0n))error='exactly one of debit or credit';}catch{error='invalid amount';}}
    if(!error&&system.granularity==='summary'&&!r.source_document_ref)error='summarized posting needs a durable detail reference';
    if(!error&&r.instrument_ref){
     if(!['loan','deposit','lease','share_issuance','security','other'].includes(r.instrument_type))error='instrument type for '+r.instrument_ref+' is invalid';
     else if(!FAMILY.test(r.income_category||''))error='income category for '+r.instrument_ref+' is invalid';
     else if(r.maturity_date&&(!/^\d{4}-\d{2}-\d{2}$/.test(r.maturity_date)||r.maturity_date<date))error='maturity for '+r.instrument_ref+' precedes the event';
     else instrument={ref:r.instrument_ref,type:r.instrument_type,maturity:r.maturity_date||null,category:r.income_category,amount:d>0n?d:c};
    }
   }
   if(!error&&batch.kind==='source_balances'){
    const m=(await tx.query("select l.target_account_id from lara.mapping_lines l join lara.mapping_versions v on v.tenant_id=l.tenant_id and v.id=l.mapping_version_id where l.tenant_id=$1 and v.source_system_id=$2 and v.status='approved' and l.source_account=$3 order by v.created_at desc limit 1",[ctx.tenantId,system.id,r.account_code])).rows[0];
    targetId=m?.target_account_id||null;
    try{const b=signedMicros(r.balance||'0');if(b>=0n)d=b;else c=-b;}catch{error='invalid balance';}
   }
   if(!error){debit+=d;credit+=c;const k=r.currency||'';ccy[k]=ccy[k]||{debit:0n,credit:0n};ccy[k].debit+=d;ccy[k].credit+=c;dates.add(date);}
   else{errors++;if(fieldErrors.length<50)fieldErrors.push({path:'rows.'+r.rowNo,message:error});}
   out.push({r,error,branchId,targetId,d,c,dims,instrument,date});
  }
  // Manifest and batch-level rules.
  const batchErrors=[];
  if(parsed.manifestCount!==1)batchErrors.push('exactly one MANIFEST row is required');
  else{
   const m=parsed.manifest;
   if(m.count!==parsed.rows.length)batchErrors.push('manifest count '+m.count+' differs from '+parsed.rows.length+' rows');
   if(!m.sha256||m.sha256.toLowerCase()!==parsed.dataHash)batchErrors.push('manifest sha256 does not match the data lines');
   if(batch.kind==='journal'){
    let md=0n,mc=0n;try{md=micros(m.debit);mc=micros(m.credit);}catch{batchErrors.push('manifest totals are invalid');}
    if(md!==debit||mc!==credit)batchErrors.push('manifest totals '+decimal(md)+'/'+decimal(mc)+' differ from staged '+decimal(debit)+'/'+decimal(credit));
    for(const [k,v] of Object.entries(m.currencyTotals||{})){const t=ccy[k];const want=typeof v==='object'&&v?[v.debit,v.credit]:[v,v];try{if(!t||micros(String(want[0]))!==t.debit||micros(String(want[1]))!==t.credit)batchErrors.push('manifest currency total for '+k+' differs');}catch{batchErrors.push('manifest currency total for '+k+' is invalid');}}
   }else{let mb=0n;try{mb=signedMicros(m.balance);}catch{batchErrors.push('manifest balance total is invalid');}if(mb!==debit-credit)batchErrors.push('manifest balance total differs from staged '+decimal(debit-credit));}
  }
  if(batch.kind==='journal'&&dates.size>1)batchErrors.push('a batch carries one accounting date; split the feed by date');
  if(batch.kind==='journal'&&(parsed.manifest?.atomic??true)&&debit!==credit)batchErrors.push('atomic batch does not balance: debits '+decimal(debit)+' credits '+decimal(credit));
  if(parsed.manifest?.replaces){
   const target=(await tx.query("select id,state from lara.source_batches where tenant_id=$1 and entity_id=$2 and source_system_id=$3 and external_batch_id=$4 and state<>'rejected'",[ctx.tenantId,entityId,system.id,parsed.manifest.replaces])).rows[0];
   if(!target||target.state!=='posted')batchErrors.push('replaced batch '+parsed.manifest.replaces+' is not a posted batch of this source');
   else if(target.id===batch.id)batchErrors.push('a batch cannot replace itself');
   else await tx.query('update lara.source_batches set replaces_batch_id=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,batch.id,target.id]);
  }
  for(const e of batchErrors){errors++;fieldErrors.push({path:'manifest',message:e});}
  // Re-validation replaces the staged rows; committed batches never reach here.
  await tx.query('delete from lara.source_rows where tenant_id=$1 and batch_id=$2',[ctx.tenantId,batch.id]);
  for(const o of out){
   await tx.query('insert into lara.source_rows(tenant_id,entity_id,batch_id,row_no,external_line_id,accounting_date,book_code,branch_code,branch_id,account_code,target_account_id,currency,debit,credit,source_document_ref,dimensions_json,tax_event_ref,instrument_ref,instrument_type,maturity_date,income_category,status,error) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)',
    [ctx.tenantId,entityId,batch.id,o.r.rowNo,o.r.external_line_id||('row-'+o.r.rowNo),/^\d{4}-\d{2}-\d{2}$/.test(o.date)?o.date:null,o.r.book_code,o.r.branch_code,o.branchId,o.r.account_code,o.targetId,/^[A-Z]{3}$/.test(o.r.currency)?o.r.currency:'',decimal(o.d,6),decimal(o.c,6),o.r.source_document_ref||'',JSON.stringify(o.dims),o.r.tax_event_ref||null,o.instrument?.ref||null,o.instrument?.type||null,o.instrument?.maturity||null,o.instrument?.category||null,o.error?'error':'valid',o.error]);
  }
  const currencyTotals=Object.fromEntries(Object.entries(ccy).map(([k,v])=>[k,{debit:decimal(v.debit),credit:decimal(v.credit)}]));
  const updated=(await tx.query("update lara.source_batches set state=$3,row_count=$4,error_count=$5,debit_total=$6,credit_total=$7,currency_totals=$8,manifest_json=$9,atomic=$10,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,batch.id,errors?'staged':'validated',parsed.rows.length,errors,decimal(debit,6),decimal(credit,6),JSON.stringify(currencyTotals),JSON.stringify(parsed.manifest||{}),parsed.manifest?.atomic??true])).rows[0];
  await audit(tx,ctx,{entityId,action:'source_batch.validate',resourceType:'source_batch',resourceId:batch.id,resourceVersion:Number(updated.version),reason:errors?errors+' error(s): '+[...batchErrors,...fieldErrors.slice(0,3).map(f=>f.message)].join('; ').slice(0,500):'valid'});
  return {rows:parsed.rows.length,errors,debit:decimal(debit,6),credit:decimal(credit,6),message:batchErrors.join(' '),fieldErrors};
 },
 async decided(tx,ctx,entityId,imp,input){
  const state=input.decision==='approve'?'approved':'rejected';
  const row=(await tx.query('update lara.source_batches set state=$3 where tenant_id=$1 and import_id=$2 returning *',[ctx.tenantId,imp.id,state])).rows[0];
  if(row)await audit(tx,ctx,{entityId,action:'source_batch.'+input.decision,resourceType:'source_batch',resourceId:row.id,resourceVersion:Number(row.version),reason:input.reason||null});
 },
 // Commit posts exactly one entry for a journal batch (the posting function
 // makes a retry idempotent), records instrument facts, reverses the replaced
 // batch as a linked reversal, writes balance snapshots for a balance batch,
 // and marks the expected batch received.
 async commit(tx,ctx,entityId,imp,{commandId=null}={}){
  const batch=(await tx.query('select * from lara.source_batches where tenant_id=$1 and import_id=$2 for update',[ctx.tenantId,imp.id])).rows[0];
  if(batch.state==='posted')return {entryId:batch.posted_entry_id,batchId:batch.id};
  if(batch.state!=='approved')fail('STATE_CONFLICT','Source batch is '+batch.state+'.');
  const system=(await tx.query('select * from lara.source_systems where tenant_id=$1 and id=$2',[ctx.tenantId,batch.source_system_id])).rows[0];
  const rows=(await tx.query("select * from lara.source_rows where tenant_id=$1 and batch_id=$2 and status='valid' order by row_no",[ctx.tenantId,batch.id])).rows;
  if(!rows.length)fail('STATE_CONFLICT','No valid rows to post.');
  let entryId=null,reversalId=null;
  if(batch.kind==='journal'){
   const date=iso(rows[0].accounting_date);
   const lines=rows.map(r=>({accountId:r.target_account_id,branchId:r.branch_id,debit:money(r.debit),credit:money(r.credit),dimensions:r.dimensions_json}));
   entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:batch.book_id,sourceType:'source_batch',sourceId:batch.id,sourceVersion:Number(batch.content_version),purpose:'posting',accountingDate:date,documentDate:date,description:'Source batch '+batch.external_batch_id+' from '+system.code,currency:rows[0].currency,manual:false,postingActor:ctx.principalId,commandId,lines})])).rows[0].id;
   if(batch.replaces_batch_id){
    const old=(await tx.query('select * from lara.source_batches where tenant_id=$1 and id=$2 for update',[ctx.tenantId,batch.replaces_batch_id])).rows[0];
    if(old.state!=='posted')fail('STATE_CONFLICT','The replaced batch is '+old.state+'.');
    const oldLines=(await tx.query('select account_id,branch_id,func_debit::text as d,func_credit::text as c,dimensions_json from lara.journal_lines where tenant_id=$1 and entry_id=$2 order by line_no',[ctx.tenantId,old.posted_entry_id])).rows;
    reversalId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:batch.book_id,sourceType:'source_batch_reversal',sourceId:batch.id,sourceVersion:Number(batch.content_version),purpose:'reversal',reversalOf:old.posted_entry_id,accountingDate:date,documentDate:date,description:'Reversal of source batch '+old.external_batch_id+' replaced by '+batch.external_batch_id,currency:rows[0].currency,manual:false,postingActor:ctx.principalId,commandId,lines:oldLines.map(l=>({accountId:l.account_id,branchId:l.branch_id,debit:money(l.c),credit:money(l.d),dimensions:l.dimensions_json}))})])).rows[0].id;
    await tx.query("update lara.source_batches set state='replaced',replaced_by_batch_id=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,old.id,batch.id]);
    await tx.query("update lara.tax_instrument_facts set status='superseded',superseded_by_batch_id=$3 where tenant_id=$1 and batch_id=$2 and status='active'",[ctx.tenantId,old.id,batch.id]);
    await audit(tx,ctx,{entityId,action:'source_batch.replace',resourceType:'source_batch',resourceId:old.id,resourceVersion:Number(old.version)+1,afterRef:reversalId,reason:'replaced by '+batch.external_batch_id});
   }
   for(const r of rows)if(r.instrument_ref)await tx.query('insert into lara.tax_instrument_facts(tenant_id,entity_id,source_system_id,batch_id,row_id,instrument_ref,instrument_type,maturity_date,amount,currency,income_category,event_date,tax_event_ref,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (tenant_id,row_id) do nothing',[ctx.tenantId,entityId,system.id,batch.id,r.id,r.instrument_ref,r.instrument_type,r.maturity_date,decimal(micros(String(r.debit))>0n?micros(String(r.debit)):micros(String(r.credit)),6),r.currency,r.income_category,iso(r.accounting_date),r.tax_event_ref,ctx.principalId]);
  }else{
   for(const r of rows)await tx.query('insert into lara.source_balance_snapshots(tenant_id,entity_id,source_system_id,batch_id,book_id,account_code,target_account_id,branch_code,currency,balance,cutoff) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (tenant_id,entity_id,source_system_id,account_code,branch_code,currency,cutoff) do nothing',[ctx.tenantId,entityId,system.id,batch.id,batch.book_id,r.account_code,r.target_account_id,r.branch_code,r.currency,decimal(micros(String(r.debit))-micros(String(r.credit)),6),iso(r.accounting_date)]);
  }
  const updated=(await tx.query("update lara.source_batches set state='posted',posted_entry_id=$3,reversal_entry_id=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,batch.id,entryId,reversalId])).rows[0];
  // The feed calendar: the batch satisfies the expected batch whose period covers its date.
  const onDate=iso(rows[0].accounting_date);
  const expected=(await tx.query("select * from lara.expected_batches where tenant_id=$1 and entity_id=$2 and source_system_id=$3 and kind=$4 and book_id=$5 and period_start<=$6::date and period_end>=$6::date and state in ('expected','missing') order by period_start limit 1 for update",[ctx.tenantId,entityId,system.id,batch.kind,batch.book_id,onDate])).rows[0];
  if(expected){
   await tx.query("update lara.expected_batches set state='received',received_batch_id=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,expected.id,batch.id]);
   if(expected.close_task_id){
    const task=(await tx.query("select * from lara.close_tasks where tenant_id=$1 and id=$2 for update",[ctx.tenantId,expected.close_task_id])).rows[0];
    if(task&&task.status==='open'){await linkEvidence(tx,ctx,entityId,[imp.evidence_id],'close_task',task.id,Number(task.version)+1);await tx.query("update lara.close_tasks set status='complete',evidence_id=$3,completed_by=$4,completed_at=now() where tenant_id=$1 and id=$2",[ctx.tenantId,task.id,imp.evidence_id,ctx.principalId]);await audit(tx,ctx,{entityId,action:'close_task.complete',resourceType:'close_task',resourceId:task.id,reason:'source batch '+batch.external_batch_id+' received'});}
   }
  }
  await audit(tx,ctx,{entityId,action:'source_batch.post',resourceType:'source_batch',resourceId:batch.id,resourceVersion:Number(updated.version),afterRef:entryId||batch.checksum});
  await emit(tx,ctx,{entityId,aggregateType:'source_batch',aggregateId:batch.id,aggregateVersion:Number(updated.version),eventType:'source_batch.posted.v1',payload:{batchId:batch.id,externalBatchId:batch.external_batch_id,sourceSystem:system.code,entryId,reversalEntryId:reversalId,kind:batch.kind}});
  return {entryId,batchId:batch.id};
 }
};
export async function listSourceBatches(tx,ctx,entityId,query){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.sourceSystemId){if(!isUuid(query.sourceSystemId))fail('VALIDATION_FAILED','sourceSystemId must be a UUID.');params.push(query.sourceSystemId);where+=' and b.source_system_id=$'+params.length;}
 if(query?.state){params.push(String(query.state));where+=' and b.state=$'+params.length;}
 const rows=(await tx.query('select b.*,s.code as source_code from lara.source_batches b join lara.source_systems s on s.tenant_id=b.tenant_id and s.id=b.source_system_id where b.tenant_id=$1 and b.entity_id=$2'+where+cursorClause(after,params).replace(/\(created_at,id\)/,'(b.created_at,b.id)')+' order by b.created_at,b.id limit $3',params)).rows;
 return page(rows,limit,batchResource,scope);
}
export async function getSourceBatch(tx,ctx,entityId,id){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);if(!isUuid(id))fail('NOT_FOUND','Source batch not found.');
 const row=(await tx.query('select b.*,s.code as source_code from lara.source_batches b join lara.source_systems s on s.tenant_id=b.tenant_id and s.id=b.source_system_id where b.tenant_id=$1 and b.entity_id=$2 and b.id=$3',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Source batch not found.');return batchResource(row);
}
export async function sourceBatchRows(tx,ctx,entityId,id,{status=null}={}){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);if(!isUuid(id))fail('NOT_FOUND','Source batch not found.');
 const batch=(await tx.query('select id from lara.source_batches where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];
 if(!batch)fail('NOT_FOUND','Source batch not found.');
 const params=[ctx.tenantId,id];let where='';if(status){params.push(status);where=' and status=$3';}
 const rows=(await tx.query('select * from lara.source_rows where tenant_id=$1 and batch_id=$2'+where+' order by row_no',params)).rows;
 return {items:rows.map(r=>({rowNo:r.row_no,externalLineId:r.external_line_id,accountingDate:iso(r.accounting_date),bookCode:r.book_code,branchCode:r.branch_code,accountCode:r.account_code,targetAccountId:r.target_account_id,currency:r.currency,debit:money(r.debit),credit:money(r.credit),sourceDocumentRef:r.source_document_ref,dimensions:r.dimensions_json,taxEventRef:r.tax_event_ref,instrumentRef:r.instrument_ref,status:r.status,error:r.error})),nextCursor:null};
}

// ---------------------------------------------------------------------------
// Expected batches: the feed calendar and the close gate (P08-T02)
// ---------------------------------------------------------------------------
const expectedResource=r=>({id:r.id,version:Number(r.version),sourceSystemId:r.source_system_id,sourceSystemCode:r.source_code||'',bookId:r.book_id,kind:r.kind,periodStart:iso(r.period_start),periodEnd:iso(r.period_end),deadlineAt:iso(r.deadline_at),state:r.state,receivedBatchId:r.received_batch_id,closeTaskId:r.close_task_id,waiverReason:r.waiver_reason,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
export async function expectBatch(tx,ctx,entityId,{sourceSystemId,bookId,kind='journal',periodStart,periodEnd,deadlineAt}){
 requirePermission(ctx,'source_ownership.create');requireEntity(ctx,entityId);await requireFi(tx,ctx,entityId);
 if(!['journal','source_balances'].includes(kind))fail('VALIDATION_FAILED','kind is journal or source_balances.',{fieldErrors:[{path:'kind',message:'Invalid'}]});
 if(!periodStart||!periodEnd||periodEnd<periodStart)fail('VALIDATION_FAILED','periodEnd precedes periodStart.',{fieldErrors:[{path:'periodEnd',message:'Invalid'}]});
 const row=(await tx.query('insert into lara.expected_batches(tenant_id,entity_id,source_system_id,book_id,kind,period_start,period_end,deadline_at,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,sourceSystemId,bookId,kind,periodStart,periodEnd,deadlineAt,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'expected_batch.create',resourceType:'expected_batch',resourceId:row.id,resourceVersion:1});
 return expectedResource(row);
}
const overdue=(r,now)=>r.state==='expected'&&Date.parse(iso(r.deadline_at))<now.getTime()?'missing':r.state;
export async function listExpectedBatches(tx,ctx,entityId,query,{now=new Date()}={}){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.sourceSystemId){if(!isUuid(query.sourceSystemId))fail('VALIDATION_FAILED','sourceSystemId must be a UUID.');params.push(query.sourceSystemId);where+=' and e.source_system_id=$'+params.length;}
 const rows=(await tx.query('select e.*,s.code as source_code from lara.expected_batches e join lara.source_systems s on s.tenant_id=e.tenant_id and s.id=e.source_system_id where e.tenant_id=$1 and e.entity_id=$2'+where+cursorClause(after,params).replace(/\(created_at,id\)/,'(e.created_at,e.id)')+' order by e.created_at,e.id limit $3',params)).rows;
 const p=page(rows,limit,r=>({...expectedResource(r),state:overdue(r,now)}),scope);
 if(query?.state)p.items=p.items.filter(i=>i.state===query.state);
 return p;
}
// Overdue expected batches for a book and period become required close tasks
// on that period; nothing else is touched (an unrelated entity or period never
// blocks).
export async function sweepExpectedBatches(tx,ctx,entityId,{bookId=null,periodStart=null,periodEnd=null,now=new Date()}={}){
 const params=[ctx.tenantId,entityId,now.toISOString()];let where='';
 if(bookId){params.push(bookId);where+=' and e.book_id=$'+params.length;}
 if(periodStart&&periodEnd){params.push(periodStart,periodEnd);where+=' and e.period_end>=$'+(params.length-1)+'::date and e.period_start<=$'+params.length+'::date';}
 const due=(await tx.query("select e.*,s.code as source_code from lara.expected_batches e join lara.source_systems s on s.tenant_id=e.tenant_id and s.id=e.source_system_id where e.tenant_id=$1 and e.entity_id=$2 and e.state='expected' and e.deadline_at<$3::timestamptz"+where+' order by e.deadline_at for update of e',params)).rows;
 const tasks=[];
 for(const e of due){
  const period=(await tx.query("select id,close_version,status from lara.periods where tenant_id=$1 and entity_id=$2 and book_id=$3 and starts_on<=$4::date and ends_on>=$4::date",[ctx.tenantId,entityId,e.book_id,iso(e.period_end)])).rows[0];
  let taskId=null;
  if(period&&period.status!=='locked'){
   const requirement=('source_feed_'+e.source_code+'_'+iso(e.period_start).replace(/-/g,'')).toLowerCase().replace(/[^a-z0-9_]/g,'_').slice(0,64);
   const task=(await tx.query('insert into lara.close_tasks(tenant_id,entity_id,period_id,close_version,requirement,required,owner_id,created_by) values($1,$2,$3,$4,$5,true,$6,$7) on conflict (tenant_id,entity_id,period_id,close_version,requirement) do update set required=true returning *',[ctx.tenantId,entityId,period.id,period.close_version,requirement,ctx.principalId,ctx.principalId])).rows[0];
   taskId=task.id;tasks.push(task.id);
   await audit(tx,ctx,{entityId,action:'close_task.add',resourceType:'close_task',resourceId:task.id,resourceVersion:Number(task.version),reason:'missing source feed '+e.source_code+' '+iso(e.period_start)+'..'+iso(e.period_end)});
  }
  await tx.query("update lara.expected_batches set state='missing',close_task_id=coalesce($3,close_task_id) where tenant_id=$1 and id=$2",[ctx.tenantId,e.id,taskId]);
  await audit(tx,ctx,{entityId,action:'expected_batch.missing',resourceType:'expected_batch',resourceId:e.id,resourceVersion:Number(e.version)+1,reason:'deadline '+iso(e.deadline_at)+' passed'});
 }
 return {missing:due.length,tasks};
}
// The close hook: before a soft close or lock of a period, overdue feeds of
// that book and period raise their close tasks so the existing gate refuses.
export const feeds={async beforeClose(tx,ctx,entityId,period){await sweepExpectedBatches(tx,ctx,entityId,{bookId:period.book_id,periodStart:iso(period.starts_on),periodEnd:iso(period.ends_on)});}};

// ---------------------------------------------------------------------------
// Reconciliation views
// ---------------------------------------------------------------------------
export async function feedReconciliation(tx,ctx,entityId,{bookId,asOf}){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);
 if(!isUuid(bookId))fail('VALIDATION_FAILED','bookId must be a UUID.',{fieldErrors:[{path:'bookId',message:'UUID'}]});
 if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf||''))fail('VALIDATION_FAILED','asOf is a date.',{fieldErrors:[{path:'asOf',message:'Date'}]});
 const systems=(await tx.query("select * from lara.source_systems where tenant_id=$1 and entity_id=$2 and status='active' order by code",[ctx.tenantId,entityId])).rows;
 const out=[];
 for(const s of systems){
  const snaps=(await tx.query('select distinct on (account_code,branch_code,currency) n.*,a.code as target_code from lara.source_balance_snapshots n left join lara.accounts a on a.tenant_id=n.tenant_id and a.id=n.target_account_id where n.tenant_id=$1 and n.entity_id=$2 and n.source_system_id=$3 and n.book_id=$4 and n.cutoff<=$5::date order by account_code,branch_code,currency,cutoff desc',[ctx.tenantId,entityId,s.id,bookId,asOf])).rows;
  const accounts=[];
  for(const n of snaps){
   let ledger=null;
   if(n.target_account_id){
    const branch=n.branch_code?(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and code=$3",[ctx.tenantId,entityId,n.branch_code])).rows[0]?.id:null;
    const params=[ctx.tenantId,bookId,n.target_account_id,iso(n.cutoff)];let where='';if(branch){params.push(branch);where=' and l.branch_id=$5';}
    ledger=signedMicros((await tx.query('select coalesce(sum(l.func_debit-l.func_credit),0)::text as b from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.book_id=$2 and l.account_id=$3 and e.accounting_date<=$4::date'+where,params)).rows[0].b);
   }
   const source=signedMicros(n.balance);
   accounts.push({accountCode:n.account_code,targetAccountId:n.target_account_id,targetAccountCode:n.target_code||null,branchCode:n.branch_code,currency:n.currency,sourceBalance:decimal(source),ledgerBalance:ledger===null?null:decimal(ledger),difference:ledger===null?null:decimal(source-ledger),cutoff:iso(n.cutoff),state:ledger===null?'unmapped':source===ledger?'ties':'differs'});
  }
  out.push({id:s.id,code:s.code,latestCutoff:snaps.length?snaps.map(n=>iso(n.cutoff)).sort().pop():null,accounts});
 }
 const expected=(await listExpectedBatches(tx,ctx,entityId,{limit:200})).items.filter(e=>e.bookId===bookId&&e.periodStart<=asOf);
 const view={bookId,asOf,sourceSystems:out,expected};
 return {...view,checksum:contentHash(view)};
}
// Per-branch totals and interbranch pairs: a due-from in one branch cancels
// against the due-to in the counter branch (dimension counter_branch) at the
// entity roll-up; unequal sides stay visible with the latest date on each side.
export async function branchRollup(tx,ctx,entityId,{bookId,periodStart,periodEnd},{record=false}={}){
 requirePermission(ctx,'source_ownership.read');requireEntity(ctx,entityId);
 if(!isUuid(bookId))fail('VALIDATION_FAILED','bookId must be a UUID.',{fieldErrors:[{path:'bookId',message:'UUID'}]});
 for(const [k,v] of [['periodStart',periodStart],['periodEnd',periodEnd]])if(!/^\d{4}-\d{2}-\d{2}$/.test(v||''))fail('VALIDATION_FAILED',k+' is a date.',{fieldErrors:[{path:k,message:'Date'}]});
 let profile={dueFromAccountId:null,dueToAccountId:null};try{profile=await fiProfile(tx,ctx,entityId);}catch{}
 const totals=(await tx.query("select b.id as branch_id,b.code,coalesce(t.debit,0)::text as debit,coalesce(t.credit,0)::text as credit,coalesce(t.due_from,0)::text as due_from,coalesce(t.due_to,0)::text as due_to from lara.branches b left join (select l.branch_id,sum(l.func_debit) as debit,sum(l.func_credit) as credit,sum(case when l.account_id=$5::uuid then l.func_debit-l.func_credit else 0 end) as due_from,sum(case when l.account_id=$6::uuid then l.func_credit-l.func_debit else 0 end) as due_to from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.entity_id=$2 and l.book_id=$3 and e.accounting_date between $4::date and $7::date group by l.branch_id) t on t.branch_id=b.id where b.tenant_id=$1 and b.entity_id=$2 and b.status='active' order by b.code",[ctx.tenantId,entityId,bookId,periodStart,profile.dueFromAccountId||'00000000-0000-0000-0000-000000000000',profile.dueToAccountId||'00000000-0000-0000-0000-000000000000',periodEnd])).rows;
 const branches=totals.map(t=>({branchId:t.branch_id,branchCode:t.code,debit:decimal(signedMicros(t.debit)),credit:decimal(signedMicros(t.credit)),dueFrom:decimal(signedMicros(t.due_from)),dueTo:decimal(signedMicros(t.due_to))}));
 const pairs=[];
 if(profile.dueFromAccountId&&profile.dueToAccountId){
  const inter=(await tx.query("select b.code as branch,upper(coalesce(l.dimensions_json->>'counter_branch','')) as counter,l.account_id,sum(l.func_debit-l.func_credit)::text as net,max(e.accounting_date) as latest from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id join lara.branches b on b.tenant_id=l.tenant_id and b.id=l.branch_id where l.tenant_id=$1 and l.entity_id=$2 and l.book_id=$3 and e.accounting_date between $4::date and $5::date and l.account_id in ($6::uuid,$7::uuid) group by b.code,counter,l.account_id",[ctx.tenantId,entityId,bookId,periodStart,periodEnd,profile.dueFromAccountId,profile.dueToAccountId])).rows;
  const key=(a,b)=>a+'→'+b;const map=new Map();
  for(const r of inter){
   const from=r.account_id===profile.dueFromAccountId;const k=from?key(r.branch,r.counter):key(r.counter,r.branch);
   const p=map.get(k)||{fromBranch:from?r.branch:r.counter,toBranch:from?r.counter:r.branch,dueFrom:0n,dueTo:0n,latestFromDate:null,latestToDate:null};
   if(from){p.dueFrom+=signedMicros(r.net);p.latestFromDate=iso(r.latest);}else{p.dueTo+=-signedMicros(r.net);p.latestToDate=iso(r.latest);}
   map.set(k,p);
  }
  for(const p of [...map.values()].sort((a,b)=>(a.fromBranch+a.toBranch).localeCompare(b.fromBranch+b.toBranch)))pairs.push({fromBranch:p.fromBranch,toBranch:p.toBranch,dueFrom:decimal(p.dueFrom),dueTo:decimal(p.dueTo),difference:decimal(p.dueFrom-p.dueTo),latestFromDate:p.latestFromDate,latestToDate:p.latestToDate,state:p.dueFrom===p.dueTo?'cancels':'open'});
 }
 const sum=(k)=>branches.reduce((t,b)=>t+signedMicros(b[k]),0n);
 const dueFrom=sum('dueFrom'),dueTo=sum('dueTo');
 const eliminated=pairs.reduce((t,p)=>{const a=signedMicros(p.dueFrom),b=signedMicros(p.dueTo);return t+(a<b?a:b);},0n);
 const view={bookId,periodStart,periodEnd,cutoffAt:new Date().toISOString(),branches,pairs,rollup:{debit:decimal(sum('debit')),credit:decimal(sum('credit')),dueFrom:decimal(dueFrom),dueTo:decimal(dueTo),eliminated:decimal(eliminated),difference:decimal(dueFrom-dueTo)}};
 const checksum=contentHash({...view,cutoffAt:undefined});
 let rollupId=null;
 if(record){
  const row=(await tx.query('insert into lara.branch_rollups(tenant_id,entity_id,book_id,period_start,period_end,cutoff_at,checksum,manifest_json,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',[ctx.tenantId,entityId,bookId,periodStart,periodEnd,view.cutoffAt,checksum,JSON.stringify({...view,checksum}),ctx.principalId])).rows[0];
  rollupId=row.id;
  await audit(tx,ctx,{entityId,action:'branch_rollup.record',resourceType:'branch_rollup',resourceId:rollupId,resourceVersion:1,afterRef:checksum});
 }
 return {...view,checksum,rollupId};
}

// ---------------------------------------------------------------------------
// Institution tax worksheet: instrument facts classified through the profile's
// reviewed rules (income category, instrument type, remaining maturity band)
// to an active tax rule version on the event date; unclassified facts are
// listed, never zeroed (P08-T05 golden cases live on the rule versions).
// ---------------------------------------------------------------------------
const yearsBetween=(from,to)=>(Date.parse(to)-Date.parse(from))/(365.25*86400000);
export async function institutionTaxWorksheet(tx,ctx,entityId,{periodStart,periodEnd}){
 requirePermission(ctx,'tax_rule.read');requireEntity(ctx,entityId);
 for(const [k,v] of [['periodStart',periodStart],['periodEnd',periodEnd]])if(!/^\d{4}-\d{2}-\d{2}$/.test(v||''))fail('VALIDATION_FAILED',k+' is a date.',{fieldErrors:[{path:k,message:'Date'}]});
 let profile={instrumentRules:[]};try{profile=await fiProfile(tx,ctx,entityId);}catch{}
 const facts=(await tx.query("select * from lara.tax_instrument_facts where tenant_id=$1 and entity_id=$2 and status='active' and event_date between $3::date and $4::date order by event_date,instrument_ref,id",[ctx.tenantId,entityId,periodStart,periodEnd])).rows;
 const rules=new Map();const rows=new Map();const unclassified=[];
 for(const f of facts){
  const eventDate=iso(f.event_date);const years=f.maturity_date?yearsBetween(eventDate,iso(f.maturity_date)):null;
  const rule=profile.instrumentRules.find(r=>r.incomeCategory===f.income_category&&(!r.instrumentType||r.instrumentType===f.instrument_type)&&(r.maxMaturityYears===null||(years!==null&&years<=r.maxMaturityYears))&&(r.minMaturityYears===null||(years!==null&&years>r.minMaturityYears)));
  if(!rule){unclassified.push({factId:f.id,instrumentRef:f.instrument_ref,incomeCategory:f.income_category,instrumentType:f.instrument_type,amount:money(f.amount),eventDate,maturityDate:iso(f.maturity_date),reason:'no profile rule for '+f.income_category+(years===null?' without maturity':' at '+years.toFixed(2)+' years')});continue;}
  const k=rule.ruleCode+'|'+eventDate;
  if(!rules.has(k))rules.set(k,(await tx.query("select * from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and code=$3 and status='active' and valid_from<=$4::date and (valid_to is null or valid_to>=$4::date)",[ctx.tenantId,entityId,rule.ruleCode,eventDate])).rows[0]||null);
  const version=rules.get(k);
  if(!version){unclassified.push({factId:f.id,instrumentRef:f.instrument_ref,incomeCategory:f.income_category,instrumentType:f.instrument_type,amount:money(f.amount),eventDate,maturityDate:iso(f.maturity_date),reason:'rule '+rule.ruleCode+' has no active version on '+eventDate});continue;}
  const basis=micros(String(f.amount));
  const rate=BigInt(Math.round(Number(version.rate)*1e12));
  const tax=((basis*rate+5n*10n**11n)/10n**12n);
  const rk=version.code+'|'+f.income_category;
  const row=rows.get(rk)||{ruleCode:version.code,taxType:version.tax_type,rate:String(version.rate),incomeCategory:f.income_category,facts:0,basis:0n,tax:0n,factIds:[]};
  row.facts++;row.basis+=basis;row.tax+=tax;row.factIds.push(f.id);rows.set(rk,row);
 }
 const out=[...rows.values()].sort((a,b)=>(a.ruleCode+a.incomeCategory).localeCompare(b.ruleCode+b.incomeCategory)).map(r=>({...r,basis:decimal(r.basis),tax:decimal(r.tax)}));
 const totals={basis:decimal(out.reduce((t,r)=>t+micros(r.basis),0n)),tax:decimal(out.reduce((t,r)=>t+micros(r.tax),0n))};
 const view={periodStart,periodEnd,rows:out,unclassified,totals};
 return {...view,checksum:contentHash(view)};
}
// Report builders for ledger.snapshotReport (report types branch_rollup,
// institution_tax and feed_reconciliation).
export const reportBuilders={
 branch_rollup:(tx,ctx,entityId,input)=>branchRollup(tx,ctx,entityId,{bookId:input.bookId,periodStart:input.periodStart,periodEnd:input.periodEnd},{record:true}),
 institution_tax:(tx,ctx,entityId,input)=>institutionTaxWorksheet(tx,ctx,entityId,{periodStart:input.periodStart,periodEnd:input.periodEnd}),
 feed_reconciliation:(tx,ctx,entityId,input)=>feedReconciliation(tx,ctx,entityId,{bookId:input.bookId,asOf:input.periodEnd})
};
