// Sales module (P04): tax kernel (versioned rules and deterministic line and
// document computation), documents (quotations, sales orders, invoices, credit
// notes) with independent approval and single-effect issuance through
// lara.post_journal_entry, official numbering, deliveries, receipts
// (collections) and open-item allocations. Amounts travel as decimal strings;
// arithmetic happens in BigInt at 1e-12 precision and rounds half up once.
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,enqueueJob,expectVersion,fail,isUuid,iso,page,pageArgs,requireAnyPermission,requireEntity,requirePermission,resource} from './core.mjs';
import {linkEvidence} from './evidence.mjs';
import {micros,decimal} from './ledger.mjs';
import {checkGate} from './treasury.mjs';
import {queueTransmission} from './compliance.mjs';
import * as fx from './fx.mjs';

const PICO=10n**12n;
const MICRO=10n**6n;
export const money=v=>decimal(micros(String(v)),2);
export function rateScaled(value){
 if(typeof value!=='string'||!/^\d{1,12}(\.\d{1,12})?$/.test(value))fail('VALIDATION_FAILED','Rates are decimal strings with up to twelve decimals.',{fieldErrors:[{path:'rate',message:'Invalid rate'}]});
 const [whole,fraction='']=value.split('.');return BigInt(whole)*PICO+BigInt(fraction.padEnd(12,'0'));
}
// Nearest multiple of `unit` to num/den, halves rounded up; num and den are non-negative.
const roundDiv=(num,den,unit)=>((2n*num+den*unit)/(2n*den*unit))*unit;

// ---------------------------------------------------------------------------
// Tax kernel: computation is a pure function of lines and rule versions.
// Exclusive: net = round(q×price − discount); tax = round(net×rate).
// Inclusive: gross = round(q×price − discount); net = round(gross/(1+rate)); tax = gross − net.
// Document rounding: per rule version, tax = round(Σ exact line tax) and the
// residual against the floored line taxes goes to the largest fractional
// remainders, ties by line number. Results are micros.
// ---------------------------------------------------------------------------
export function computeLines(lines,rules,{scale=2}={}){
 const unitMicros=10n**BigInt(6-scale);
 const out=lines.map((l,i)=>{
  const q=micros(l.quantity),p=micros(l.unitPrice),d=micros(l.discount||'0');
  if(q<=0n)fail('VALIDATION_FAILED','Quantities are positive.',{fieldErrors:[{path:'lines.'+i+'.quantity',message:'Positive'}]});
  const basePico=q*p-d*MICRO;
  if(basePico<0n)fail('VALIDATION_FAILED','Discount exceeds the line amount.',{fieldErrors:[{path:'lines.'+i+'.discount',message:'Exceeds amount'}]});
  const base=roundDiv(basePico,MICRO,unitMicros);
  const rule=l.taxCodeId?rules.get(l.taxCodeId):null;
  if(l.taxCodeId&&!rule)fail('RULE_PROFILE_NOT_APPROVED','No active tax rule for line '+(i+1)+'.',{fieldErrors:[{path:'lines.'+i+'.taxCodeId',message:'No active rule version'}]});
  const R=rule?rateScaled(rule.rate):0n;
  // Exact tax as num/den in micros.
  const exact=l.priceBasis==='inclusive'?{num:base*R,den:PICO+R}:{num:base*R,den:PICO};
  return {index:i,rule,R,base,inclusive:l.priceBasis==='inclusive',exact,tax:null};
 });
 // Line rounding, or document rounding per rule version.
 const groups=new Map();
 for(const c of out){if(c.rule?.rounding==='document_half_up'){const k=c.rule.id;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(c);}else c.tax=roundDiv(c.exact.num,c.exact.den,unitMicros);}
 for(const members of groups.values()){
  const D=members.reduce((acc,c)=>acc*c.exact.den,1n);
  const scaled=members.map(c=>c.exact.num*(D/c.exact.den));
  const total=roundDiv(scaled.reduce((a,b)=>a+b,0n),D,unitMicros);
  const floors=scaled.map(n=>(n/(D*unitMicros))*unitMicros);
  let residual=(total-floors.reduce((a,b)=>a+b,0n))/unitMicros;
  const order=members.map((c,k)=>({k,rem:scaled[k]-floors[k]*D})).sort((a,b)=>a.rem===b.rem?a.k-b.k:(a.rem>b.rem?-1:1));
  members.forEach((c,k)=>c.tax=floors[k]);
  for(const {k} of order){if(residual<=0n)break;members[k].tax+=unitMicros;residual-=1n;}
 }
 return out.map(c=>{const gross=c.inclusive?c.base:c.base+c.tax,net=c.inclusive?c.base-c.tax:c.base;return {net,tax:c.tax,gross,rate:c.rule?c.rule.rate:'0',ruleVersionId:c.rule?c.rule.id:null};});
}
export const totals=computed=>computed.reduce((t,c)=>({net:t.net+c.net,tax:t.tax+c.tax,gross:t.gross+c.gross}),{net:0n,tax:0n,gross:0n});

// ---------------------------------------------------------------------------
// Capability, profile and shared lookups
// ---------------------------------------------------------------------------
async function requireSales(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='sales' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The sales capability is not active for this entity.');
}
// The approved sales profile names the control accounts, rounding scale and
// whether the customer profile requires official reporting (blocked until P07).
export async function salesProfile(tx,ctx,entityId){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='sales_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved sales profile (control accounts, rounding) is required.');
 const p=row.payload;
 for(const k of ['arAccountId','outputTaxAccountId','cashAccountId'])if(!isUuid(p[k]))fail('RULE_PROFILE_NOT_APPROVED','The sales profile lacks '+k+'.');
 return {arAccountId:p.arAccountId,outputTaxAccountId:p.outputTaxAccountId,cashAccountId:p.cashAccountId,withholdingReceivableAccountId:p.withholdingReceivableAccountId||null,scale:Number.isInteger(p.scale)?p.scale:2,dueDays:Number.isInteger(p.dueDays)?p.dueDays:30,reportingRequired:p.reportingRequired===true,enforceCreditLimits:p.enforceCreditLimits===true};
}
export async function bookFor(tx,ctx,entityId,bookId){
 if(!isUuid(bookId))fail('VALIDATION_FAILED','bookId must be a UUID.',{fieldErrors:[{path:'bookId',message:'UUID'}]});
 const book=(await tx.query("select * from lara.books where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,bookId])).rows[0];
 if(!book)fail('NOT_FOUND','Book not found.');
 if(book.kind==='management')fail('STATE_CONFLICT','A management view never posts; it combines its source books.');
 return book;
}
async function customerFor(tx,ctx,entityId,partyId){
 if(!isUuid(partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});
 const party=(await tx.query("select p.* from lara.party p where p.tenant_id=$1 and p.entity_id=$2 and p.id=$3",[ctx.tenantId,entityId,partyId])).rows[0];
 if(!party)fail('NOT_FOUND','Party not found.');
 if(party.status!=='active')fail('STATE_CONFLICT','The party is '+party.status+'.');
 const customer=(await tx.query("select 1 from lara.party_roles where tenant_id=$1 and entity_id=$2 and party_id=$3 and role='customer'",[ctx.tenantId,entityId,partyId])).rowCount;
 if(!customer)fail('VALIDATION_FAILED','The party is not onboarded as a customer.',{fieldErrors:[{path:'partyId',message:'Customer role required'}]});
 return party;
}
export async function branchFor(tx,ctx,entityId,branchId){
 if(!isUuid(branchId))fail('VALIDATION_FAILED','branchId must be a UUID.',{fieldErrors:[{path:'branchId',message:'UUID'}]});
 const b=(await tx.query("select * from lara.branches where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,branchId])).rows[0];
 if(!b)fail('NOT_FOUND','Branch not found.');return b;
}
// Resolves each referenced tax code to the version active on the tax date.
// A taxCodeId is the id of any version of the rule; the code is what matters.
export async function resolveRules(tx,ctx,entityId,lines,taxDate){
 const ids=[...new Set(lines.map(l=>l.taxCodeId).filter(Boolean))];
 const rules=new Map();
 for(const id of ids){
  if(!isUuid(id))fail('VALIDATION_FAILED','taxCodeId must be a UUID.',{fieldErrors:[{path:'lines',message:'taxCodeId'}]});
  const active=(await tx.query("select a.* from lara.tax_rule_versions r join lara.tax_rule_versions a on a.tenant_id=r.tenant_id and a.entity_id=r.entity_id and a.code=r.code and a.status='active' where r.tenant_id=$1 and r.entity_id=$2 and r.id=$3 and a.valid_from<=$4::date and (a.valid_to is null or a.valid_to>=$4::date)",[ctx.tenantId,entityId,id,taxDate])).rows[0];
  if(!active)fail('RULE_PROFILE_NOT_APPROVED','No active tax rule version applies on '+taxDate+' for the referenced code.');
  rules.set(id,{id:active.id,code:active.code,rate:String(active.rate),rounding:active.rounding,recognition:active.recognition,taxType:active.tax_type});
 }
 return rules;
}

// ---------------------------------------------------------------------------
// Tax rule versions: draft → (pending_approval →) approved → active → superseded
// ---------------------------------------------------------------------------
const ruleFields=r=>({code:r.code,taxType:r.tax_type,validFrom:iso(r.valid_from),...(r.valid_to?{validTo:iso(r.valid_to)}:{}),rate:String(r.rate).replace(/0+$/,'').replace(/\.$/,'.0'),basis:r.basis,recognition:r.recognition,rounding:r.rounding,applicabilityProfileId:r.applicability_profile_id,sourceEvidenceIds:r.source_evidence_ids,goldenCaseIds:r.golden_case_ids});
export const taxRuleResource=r=>resource(r,ruleFields(r));
const ruleMaterial=i=>({code:i.code.trim().toUpperCase(),taxType:i.taxType,validFrom:i.validFrom,validTo:i.validTo||null,rate:i.rate,basis:i.basis,recognition:i.recognition,rounding:i.rounding,applicabilityProfileId:i.applicabilityProfileId,sourceEvidenceIds:[...i.sourceEvidenceIds].sort(),goldenCaseIds:[...i.goldenCaseIds].sort()});
function validateRule(m,goldenCases){
 if(!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(m.code))fail('VALIDATION_FAILED','Tax rule codes use letters, digits, dots, underscores and hyphens.',{fieldErrors:[{path:'code',message:'Invalid code'}]});
 const R=rateScaled(m.rate);if(R>PICO)fail('VALIDATION_FAILED','Rates are between 0 and 1.',{fieldErrors:[{path:'rate',message:'0 to 1'}]});
 if(m.validTo&&m.validTo<m.validFrom)fail('VALIDATION_FAILED','validTo precedes validFrom.',{fieldErrors:[{path:'validTo',message:'Before validFrom'}]});
 if(goldenCases){const unknown=m.goldenCaseIds.filter(c=>!goldenCases.has(c));if(unknown.length)fail('VALIDATION_FAILED','Unknown golden cases: '+unknown.join(', ')+'.',{fieldErrors:[{path:'goldenCaseIds',message:'Unknown case'}]});}
}
export async function createTaxRule(tx,ctx,entityId,input,{goldenCases=null}={}){
 requirePermission(ctx,'tax_rule.create');requireEntity(ctx,entityId);assertInput('TaxRuleCreate',input);
 const m=ruleMaterial(input);validateRule(m,goldenCases);
 const next=((await tx.query('select coalesce(max(version_number),0)::int v from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and code=$3',[ctx.tenantId,entityId,m.code])).rows[0].v)+1;
 const hash=contentHash(m);
 const row=(await tx.query('insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,valid_to,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *',[ctx.tenantId,entityId,m.code,next,m.taxType,m.validFrom,m.validTo,m.rate,m.basis,m.recognition,m.rounding,m.applicabilityProfileId,JSON.stringify(m.sourceEvidenceIds),JSON.stringify(m.goldenCaseIds),hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,m.sourceEvidenceIds,'tax_rule',row.id,1);
 await audit(tx,ctx,{entityId,action:'tax_rule.create',resourceType:'tax_rule',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return taxRuleResource(row);
}
async function loadRule(tx,ctx,entityId,id){const row=(await tx.query('select * from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Tax rule not found.');return row;}
export async function updateTaxRule(tx,ctx,entityId,id,expectedVersion,input,{goldenCases=null}={}){
 requirePermission(ctx,'tax_rule.edit');requireEntity(ctx,entityId);assertInput('TaxRuleCreate',input);
 const row=await loadRule(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(!['draft','pending_approval','rejected'].includes(row.status))fail('STATE_CONFLICT','Approved tax rule versions are immutable; create a new version.');
 const m=ruleMaterial(input);validateRule(m,goldenCases);
 if(m.code!==row.code)fail('VALIDATION_FAILED','A version cannot change its code.',{fieldErrors:[{path:'code',message:'Immutable'}]});
 const hash=contentHash(m),material=hash!==row.content_hash;
 const updated=(await tx.query("update lara.tax_rule_versions set status='draft',tax_type=$3,valid_from=$4,valid_to=$5,rate=$6,basis=$7,recognition=$8,rounding=$9,applicability_profile_id=$10,source_evidence_ids=$11,golden_case_ids=$12,content_hash=$13,content_version=content_version+$14 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,m.taxType,m.validFrom,m.validTo,m.rate,m.basis,m.recognition,m.rounding,m.applicabilityProfileId,JSON.stringify(m.sourceEvidenceIds),JSON.stringify(m.goldenCaseIds),hash,material?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:'tax_rule.edit',resourceType:'tax_rule',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return taxRuleResource(updated);
}
export async function approveTaxRule(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'tax_rule.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadRule(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','pending_approval'].includes(row.status))fail('STATE_CONFLICT','Tax rule version is '+row.status+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The rule author cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The rule changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 if(row.status==='draft')await tx.query("update lara.tax_rule_versions set status='pending_approval' where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 const status=input.decision==='approve'?'approved':'rejected';
 const updated=(await tx.query('update lara.tax_rule_versions set status=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,status,input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'tax_rule.'+input.decision,resourceType:'tax_rule',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.content_hash});
 return {resourceType:'tax_rule',resourceId:id,version:Number(updated.version),state:status};
}
// Activation supersedes the active version of the same code in the same
// transaction and publishes rule.activated.v1. Nothing else changes rates.
export async function activateTaxRule(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'tax_rule.activate');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadRule(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='approved')fail('STATE_CONFLICT','Only approved tax rule versions activate.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The rule author cannot activate it.');
 await tx.query("update lara.tax_rule_versions set status='superseded' where tenant_id=$1 and entity_id=$2 and code=$3 and status='active'",[ctx.tenantId,entityId,row.code]);
 const updated=(await tx.query("update lara.tax_rule_versions set status='active',activated_by=$3,activated_at=now() where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'tax_rule.activate',resourceType:'tax_rule',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason,afterRef:row.content_hash});
 await emit(tx,ctx,{entityId,aggregateType:'tax_rule',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'rule.activated.v1',payload:{ruleProfileId:row.applicability_profile_id,version:row.version_number,effectiveFrom:iso(row.valid_from)}});
 return {resourceType:'tax_rule',resourceId:id,version:Number(updated.version),state:'active'};
}
const RULE_READERS=['tax_rule.read','invoice.prepare','invoice.read','sales_order.create'];
export async function getTaxRule(tx,ctx,entityId,id){requireAnyPermission(ctx,RULE_READERS);requireEntity(ctx,entityId);const row=(await tx.query('select * from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Tax rule not found.');return taxRuleResource(row);}
export async function listTaxRules(tx,ctx,entityId,query){requireAnyPermission(ctx,RULE_READERS);requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];const rows=(await tx.query('select * from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;return page(rows,limit,taxRuleResource,scope);}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
const SALES_KINDS={invoice:'invoice',credit_note:'invoice',quotation:'sales_order',sales_order:'sales_order'};
const permissionFor=(kind,action)=>{const family=SALES_KINDS[kind];if(!family)fail('FEATURE_NOT_ENABLED','Documents of kind '+kind+' arrive with purchasing (P05).');return family==='invoice'?({create:'invoice.prepare',edit:'invoice.edit',read:'invoice.read',submit:'invoice.submit',approve:'invoice.approve',post:'invoice.post'})[action]:({create:'sales_order.create',edit:'sales_order.edit',read:'sales_order.read',submit:'sales_order.submit',approve:'sales_order.approve',convert:'sales_order.convert'})[action];};
export const lineMaterial=l=>({description:l.description.trim(),itemId:l.itemId||null,quantity:decimal(micros(l.quantity),6),unitPrice:decimal(micros(l.unitPrice),6),discount:decimal(micros(l.discount||'0'),6),priceBasis:l.priceBasis,accountId:l.accountId,taxCodeId:l.taxCodeId||null,dimensions:Object.fromEntries(Object.entries(l.dimensions||{}).sort())});
export const documentMaterial=i=>({kind:i.kind,branchId:i.branchId,bookId:i.bookId,partyId:i.partyId,documentDate:i.documentDate,accountingDate:i.accountingDate,currency:i.currency,ruleProfileVersion:i.ruleProfileVersion.trim(),externalReference:i.externalReference?.trim()||null,sourceDocumentId:i.sourceDocumentId||null,lines:i.lines.map(lineMaterial),evidenceIds:[...(i.evidenceIds||[])].sort()});
export const lineResource=l=>({description:l.description,...(l.item_id?{itemId:l.item_id}:{}),quantity:decimal(micros(String(l.quantity)),6).replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1'),unitPrice:decimal(micros(String(l.unit_price)),6).replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1'),discount:money(l.discount),priceBasis:l.price_basis,accountId:l.account_id,...(l.tax_code_id?{taxCodeId:l.tax_code_id}:{}),dimensions:l.dimensions_json||{}});
export async function lineRows(tx,ctx,documentId){return (await tx.query('select * from lara.document_lines where tenant_id=$1 and document_id=$2 order by line_no',[ctx.tenantId,documentId])).rows;}
export async function documentResource(tx,ctx,d){
 const lines=await lineRows(tx,ctx,d.id);
 return resource({...d,status:d.state},{kind:d.kind,branchId:d.branch_id,bookId:d.book_id,partyId:d.party_id,documentDate:iso(d.document_date),accountingDate:iso(d.accounting_date),currency:d.currency,ruleProfileVersion:d.rule_profile_version,...(d.external_reference?{externalReference:d.external_reference}:{}),...(d.source_document_id?{sourceDocumentId:d.source_document_id}:{}),lines:lines.map(lineResource),evidenceIds:d.evidence_ids,net:money(d.net),tax:money(d.tax),gross:money(d.gross),officialNumber:d.official_number,deliveryState:d.delivery_state,reportingState:d.reporting_state,settlementState:d.settlement_state});
}
// Validates references, resolves rules and computes the server-side totals.
async function prepareDocument(tx,ctx,entityId,input,profile){
 const book=await bookFor(tx,ctx,entityId,input.bookId);
 if(input.currency!==book.functional_currency&&!(await fx.isFxActive(tx,ctx,entityId)))fail('FEATURE_NOT_ENABLED','Foreign-currency documents need the multi-currency capability (P09).');
 await fx.requireBookAccess(tx,ctx,book,'post');
 await branchFor(tx,ctx,entityId,input.branchId);
 await customerFor(tx,ctx,entityId,input.partyId);
 if(input.accountingDate<input.documentDate)fail('VALIDATION_FAILED','The accounting date cannot precede the document date.',{fieldErrors:[{path:'accountingDate',message:'Before document date'}]});
 for(const [i,l] of input.lines.entries()){
  const acct=(await tx.query("select * from lara.accounts where tenant_id=$1 and entity_id=$2 and book_id=$3 and id=$4",[ctx.tenantId,entityId,input.bookId,l.accountId])).rows[0];
  if(!acct)fail('NOT_FOUND','Line '+(i+1)+' account not found in this book.');
  if(acct.status!=='active')fail('STATE_CONFLICT','Line '+(i+1)+' account is '+acct.status+'.');
  if(acct.control_type!=='none')fail('VALIDATION_FAILED','Line '+(i+1)+' posts to a control account; choose a revenue account.',{fieldErrors:[{path:'lines.'+i+'.accountId',message:'Control account'}]});
  if(input.sourceDocumentId===null&&l.itemId)fail('FEATURE_NOT_ENABLED','Items arrive with inventory (P10).');
 }
 const rules=await resolveRules(tx,ctx,entityId,input.lines,input.documentDate);
 const computed=computeLines(input.lines,rules,{scale:profile.scale});
 return {computed,total:totals(computed)};
}
export async function writeLines(tx,ctx,entityId,documentId,input,computed){
 await tx.query('delete from lara.document_lines where tenant_id=$1 and document_id=$2',[ctx.tenantId,documentId]);
 for(const [i,l] of input.lines.entries()){
  const c=computed[i];
  await tx.query('insert into lara.document_lines(tenant_id,entity_id,document_id,line_no,item_id,description,quantity,unit_price,discount,price_basis,account_id,tax_code_id,tax_rule_version_id,tax_rate,net,tax,gross,dimensions_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',[ctx.tenantId,entityId,documentId,i+1,l.itemId||null,l.description.trim(),decimal(micros(l.quantity),6),decimal(micros(l.unitPrice),6),decimal(micros(l.discount||'0'),6),l.priceBasis,l.accountId,l.taxCodeId||null,c.ruleVersionId,c.rate,decimal(c.net,6),decimal(c.tax,6),decimal(c.gross,6),JSON.stringify(l.dimensions||{})]);
 }
}
export const dueSchedule=(input,total,profile)=>{const due=new Date(input.documentDate+'T00:00:00Z');due.setUTCDate(due.getUTCDate()+profile.dueDays);return [{amount:decimal(total.gross,6),dueDate:due.toISOString().slice(0,10)}];};
export async function createDocument(tx,ctx,entityId,input){
 requireEntity(ctx,entityId);assertInput('DocumentCreate',input);requirePermission(ctx,permissionFor(input.kind,'create'));
 return insertDocument(tx,ctx,entityId,input);
}
// Corrections and conversions derive documents under their own permission.
async function insertDocument(tx,ctx,entityId,input,{sourceRelation=null}={}){
 assertInput('DocumentCreate',input);await requireSales(tx,ctx,entityId);
 const profile=await salesProfile(tx,ctx,entityId);
 if(input.sourceDocumentId){const src=(await tx.query('select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.sourceDocumentId])).rows[0];if(!src)fail('NOT_FOUND','Source document not found.');if(src.party_id!==input.partyId)fail('VALIDATION_FAILED','The source document belongs to another customer.',{fieldErrors:[{path:'partyId',message:'Differs from source'}]});}
 const {computed,total}=await prepareDocument(tx,ctx,entityId,input,profile);
 const m=documentMaterial(input),hash=contentHash(m);
 const row=(await tx.query("insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,net,tax,gross,rule_profile_version,external_reference,source_document_id,due_schedule,evidence_ids,payload_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *",[ctx.tenantId,entityId,input.bookId,input.kind,input.branchId,input.partyId,input.documentDate,input.accountingDate,input.currency,decimal(total.net,6),decimal(total.tax,6),decimal(total.gross,6),m.ruleProfileVersion,m.externalReference,m.sourceDocumentId,JSON.stringify(dueSchedule(input,total,profile)),JSON.stringify(m.evidenceIds),hash,ctx.principalId])).rows[0];
 await writeLines(tx,ctx,entityId,row.id,input,computed);
 if(input.sourceDocumentId&&sourceRelation)await tx.query('insert into lara.document_relations(tenant_id,entity_id,source_id,target_id,relation,amount,created_by) values($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,entityId,row.id,input.sourceDocumentId,sourceRelation,decimal(total.gross,6),ctx.principalId]);
 await audit(tx,ctx,{entityId,action:input.kind+'.create',resourceType:'document',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return documentResource(tx,ctx,row);
}
export async function loadDocument(tx,ctx,entityId,id){const row=(await tx.query('select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Document not found.');return row;}
export async function updateDocument(tx,ctx,entityId,id,expectedVersion,input){
 requireEntity(ctx,entityId);assertInput('DocumentCreate',input);
 const row=await loadDocument(tx,ctx,entityId,id);requirePermission(ctx,permissionFor(row.kind,'edit'));expectVersion(row,expectedVersion);
 if(['posted','cancelled'].includes(row.state))fail('STATE_CONFLICT','Posted or cancelled documents cannot change; corrections are new linked documents.');
 if(row.kind!==input.kind||row.book_id!==input.bookId||row.party_id!==input.partyId)fail('VALIDATION_FAILED','Kind, book and customer are fixed for a document.',{fieldErrors:[{path:'kind',message:'Immutable'}]});
 const profile=await salesProfile(tx,ctx,entityId);
 const {computed,total}=await prepareDocument(tx,ctx,entityId,input,profile);
 const m=documentMaterial(input),hash=contentHash(m),material=hash!==row.payload_hash;
 // Material edits invalidate approval and return the document to draft; the
 // database refuses a payload change in any other state.
 if(material&&row.state!=='draft')await tx.query("update lara.documents set state='draft',approved_by=null,submitted_by=null,approved_version=null where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 await writeLines(tx,ctx,entityId,id,input,computed);
 const updated=(await tx.query('update lara.documents set branch_id=$3,document_date=$4,accounting_date=$5,net=$6,tax=$7,gross=$8,rule_profile_version=$9,external_reference=$10,due_schedule=$11,evidence_ids=$12,payload_hash=$13,content_version=content_version+$14 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.branchId,input.documentDate,input.accountingDate,decimal(total.net,6),decimal(total.tax,6),decimal(total.gross,6),m.ruleProfileVersion,m.externalReference,JSON.stringify(dueSchedule(input,total,profile)),JSON.stringify(m.evidenceIds),hash,material?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:row.kind+'.edit',resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return documentResource(tx,ctx,updated);
}
const result=(row,extra={})=>({resourceType:'document',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
async function creditExposure(tx,ctx,entityId,partyId,currency){
 const r=(await tx.query("select coalesce(sum(original_amount-lara.open_item_allocated(tenant_id,id)),0)::text as outstanding from lara.open_items where tenant_id=$1 and entity_id=$2 and party_id=$3 and currency=$4 and side='AR' and status<>'written_off'",[ctx.tenantId,entityId,partyId,currency])).rows[0];
 return micros(r.outstanding.replace(/^-/,''));
}
export async function submitDocument(tx,ctx,entityId,id,input,expectedVersion){
 requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadDocument(tx,ctx,entityId,id);requirePermission(ctx,permissionFor(row.kind,'submit'));if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','changes_requested'].includes(row.state))fail('STATE_CONFLICT','Document is '+row.state+'.');
 if(row.kind==='invoice'){
  const profile=await salesProfile(tx,ctx,entityId);
  if(profile.enforceCreditLimits){
   const limit=(await tx.query("select limit_amount::text as amount from lara.credit_limits where tenant_id=$1 and entity_id=$2 and party_id=$3 and currency=$4 and status='approved'",[ctx.tenantId,entityId,row.party_id,row.currency])).rows[0];
   if(limit){const exposure=await creditExposure(tx,ctx,entityId,row.party_id,row.currency);if(exposure+micros(String(row.gross))>micros(limit.amount))fail('STATE_CONFLICT','Credit limit '+money(limit.amount)+' would be exceeded (outstanding '+decimal(exposure)+').');}
  }
 }
 if(row.state==='changes_requested')await tx.query("update lara.documents set state='draft' where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 if(row.evidence_ids.length)await linkEvidence(tx,ctx,entityId,row.evidence_ids,'document',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.documents set state='submitted',submitted_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:row.kind+'.submit',resourceType:'document',resourceId:id,resourceVersion:Number(updated.version)});
 return result(updated);
}
export async function approveDocument(tx,ctx,entityId,id,input,expectedVersion){
 requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadDocument(tx,ctx,entityId,id);requirePermission(ctx,permissionFor(row.kind,'approve'));if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='submitted')fail('STATE_CONFLICT','Only submitted documents are decided.');
 if(row.created_by===ctx.principalId||row.submitted_by===ctx.principalId)fail('SELF_APPROVAL','The preparer or submitter cannot approve this document.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The document changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const state=input.decision==='approve'?'approved':'changes_requested';
 const updated=(await tx.query('update lara.documents set state=$3,approved_by=$4,approved_version=$5 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,state,input.decision==='approve'?ctx.principalId:null,input.decision==='approve'?row.content_version:null])).rows[0];
 await audit(tx,ctx,{entityId,action:row.kind+'.'+input.decision,resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.payload_hash});
 return result(updated);
}
// Allocates the next number of the active series for the branch and kind under
// a row lock; the number event is written in the same transaction as the
// document, so a rolled-back issuance never consumes a number.
export async function allocateNumber(tx,ctx,entityId,row){
 const series=(await tx.query("select * from lara.document_series where tenant_id=$1 and entity_id=$2 and branch_id=$3 and kind=$4 and status='active' for update",[ctx.tenantId,entityId,row.branch_id,row.kind])).rows[0];
 if(!series)fail('RULE_PROFILE_NOT_APPROVED','No active numbering series for '+row.kind+' on this branch.');
 const n=Number(series.next_number);
 if(series.maximum_number!==null&&n>Number(series.maximum_number)){await tx.query("update lara.document_series set status='exhausted' where tenant_id=$1 and id=$2",[ctx.tenantId,series.id]);fail('STATE_CONFLICT','Numbering series '+series.prefix+' is exhausted.');}
 const officialNumber=series.prefix+'-'+String(n).padStart(6,'0');
 await tx.query("insert into lara.number_events(tenant_id,entity_id,series_id,number,document_id,event) values($1,$2,$3,$4,$5,'issued')",[ctx.tenantId,entityId,series.id,n,row.id]);
 await tx.query('update lara.document_series set next_number=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,series.id,n+1]);
 return {seriesId:series.id,officialNumber};
}
// Journal lines for an invoice (AC-01) or credit note (AC-06): receivable
// against revenue per account and dimensions, output tax per rule version.
function documentJournalLines(row,lines,profile){
 const credit=row.kind==='credit_note';
 const side=(amount,debit)=>debit!==credit?{debit:decimal(amount,6),credit:'0'}:{debit:'0',credit:decimal(amount,6)};
 const out=[{accountId:profile.arAccountId,branchId:row.branch_id,dimensions:{},...side(micros(String(row.gross)),true)}];
 const revenue=new Map();
 for(const l of lines){const k=l.account_id+'|'+JSON.stringify(l.dimensions_json||{});const cur=revenue.get(k)||{accountId:l.account_id,dimensions:l.dimensions_json||{},amount:0n};cur.amount+=micros(String(l.net));revenue.set(k,cur);}
 for(const r of revenue.values())if(r.amount>0n)out.push({accountId:r.accountId,branchId:row.branch_id,dimensions:r.dimensions,...side(r.amount,false)});
 const tax=lines.reduce((t,l)=>t+micros(String(l.tax)),0n);
 if(tax>0n)out.push({accountId:profile.outputTaxAccountId,branchId:row.branch_id,dimensions:{},...side(tax,false)});
 return out;
}
export async function refreshSettlementState(tx,ctx,documentId){
 const item=(await tx.query('select original_amount::text as original,lara.open_item_allocated(tenant_id,id)::text as used from lara.open_items where tenant_id=$1 and document_id=$2',[ctx.tenantId,documentId])).rows[0];
 if(!item)return;
 const used=micros(item.used.replace(/^-/,'')),original=micros(item.original);
 const state=used<=0n?'unpaid':used>=original?'paid':'partial';
 await tx.query('update lara.documents set settlement_state=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,documentId,state]);
}
// Issuance is the single financial effect: number, party snapshot, tax
// events, journal entry through the posting function, open item, and for a
// credit note the application against the original invoice. A retry after
// commit finds the document posted and returns the same entry.
export async function postDocument(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadDocument(tx,ctx,entityId,id);requirePermission(ctx,permissionFor(row.kind,'post'));if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return result(row,{journalEntryIds:[row.posted_entry_id]});
 if(row.state!=='approved')fail('STATE_CONFLICT','Approval is required before issuing.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot both approve and issue.');
 const profile=await salesProfile(tx,ctx,entityId);
 if(profile.reportingRequired){const compliance=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='compliance' and status='active'",[ctx.tenantId,entityId])).rowCount;if(!compliance)fail('FEATURE_NOT_ENABLED','This customer profile requires official reporting; issuance stays blocked until the compliance capability (P07) is active.');}
 const lines=await lineRows(tx,ctx,id);
 const party=(await tx.query('select * from lara.party where tenant_id=$1 and id=$2',[ctx.tenantId,row.party_id])).rows[0];
 const {seriesId,officialNumber}=await allocateNumber(tx,ctx,entityId,row);
 const snapshot={legalName:party.legal_name,identityStatus:party.identity_status,address:party.address_json,officialNumber,documentDate:iso(row.document_date)};
 await tx.query('insert into lara.party_snapshots(document_id,tenant_id,entity_id,immutable_json,snapshot_hash) values($1,$2,$3,$4,$5)',[id,ctx.tenantId,entityId,JSON.stringify(snapshot),contentHash(snapshot)]);
 // A foreign-currency document posts both amounts at the approved rate of its document date (P09); the control line carries the residual.
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,row.book_id])).rows[0];
 const fxRate=row.currency!==book.functional_currency?await fx.rateFor(tx,ctx,entityId,{base:row.currency,quote:book.functional_currency,onDate:iso(row.document_date)}):null;
 let journalLines=documentJournalLines(row,lines,profile);
 if(fxRate)journalLines=fx.translateLines(journalLines,fxRate.rate,{controlAccountId:profile.arAccountId});
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'document',sourceId:id,sourceVersion:Number(row.approved_version),purpose:'posting',accountingDate:iso(row.accounting_date),documentDate:iso(row.document_date),description:(row.kind==='credit_note'?'Credit note ':'Invoice ')+officialNumber+' '+party.legal_name,currency:row.currency,manual:false,postingActor:ctx.principalId,commandId,...(fxRate?fx.postingFx(fxRate):{}),lines:journalLines})])).rows[0].id;
 for(const l of lines)if(l.tax_rule_version_id&&micros(String(l.tax))>0n){
  const rule=(await tx.query('select recognition from lara.tax_rule_versions where tenant_id=$1 and id=$2',[ctx.tenantId,l.tax_rule_version_id])).rows[0];
  if(['issue','accrual'].includes(rule.recognition))await tx.query("insert into lara.tax_events(tenant_id,entity_id,document_id,line_id,tax_rule_version_id,tax_point,recognition,basis,amount,recognition_entry_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[ctx.tenantId,entityId,id,l.id,l.tax_rule_version_id,rule.recognition==='issue'?iso(row.document_date):iso(row.accounting_date),rule.recognition,l.net,l.tax,entryId]);
 }
 const updated=(await tx.query("update lara.documents set state='posted',posted_entry_id=$3,posted_by=$4,posted_at=now(),series_id=$5,official_number=$6,tax_date=document_date where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId,ctx.principalId,seriesId,officialNumber])).rows[0];
 const journalEntryIds=[entryId];
 if(row.kind==='invoice'){
  const item=(await tx.query("insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AR',$4,$5,$6,$7) returning id",[ctx.tenantId,entityId,id,row.party_id,row.gross,row.currency,row.due_schedule[0]?.dueDate||iso(row.document_date)])).rows[0];
  if(fxRate)await fx.openLayer(tx,ctx,entityId,{openItemId:item.id,txn:micros(String(row.gross)),func:fx.controlFunc(journalLines,profile.arAccountId),rate:fxRate});
 }else{
  // Apply the credit to the original invoice's open item up to its outstanding.
  const relation=(await tx.query("select target_id from lara.document_relations where tenant_id=$1 and source_id=$2 and relation in ('credit','reversal') limit 1",[ctx.tenantId,id])).rows[0];
  if(relation){
   const item=(await tx.query('select id,(original_amount-lara.open_item_allocated(tenant_id,id))::text as outstanding from lara.open_items where tenant_id=$1 and document_id=$2',[ctx.tenantId,relation.target_id])).rows[0];
   if(item){const outstanding=micros(item.outstanding.replace(/^-/,''));const apply=outstanding<micros(String(row.gross))?outstanding:micros(String(row.gross));
    if(apply>0n){await tx.query("insert into lara.allocation_events(tenant_id,entity_id,credit_document_id,open_item_id,amount,action,command_id,created_by) values($1,$2,$3,$4,$5,'apply',$6,$7)",[ctx.tenantId,entityId,id,item.id,decimal(apply,6),commandId,ctx.principalId]);await refreshSettlementState(tx,ctx,relation.target_id);
     if(fxRate){const s=await fx.settleLayers(tx,ctx,entityId,{settlementId:null,allocations:[{openItemId:item.id,amount:decimal(apply)}],rate:fxRate,side:'AR'});const fxEntry=await fx.postRealized(tx,ctx,entityId,{bookId:row.book_id,sourceType:'document_fx',sourceId:id,sourceVersion:Number(row.approved_version),accountingDate:iso(row.accounting_date),description:'Credit note '+officialNumber,controlAccountId:profile.arAccountId,branchId:row.branch_id,side:'AR',cashFunc:s.cashFunc,consumed:s.consumed,commandId});if(fxEntry)journalEntryIds.push(fxEntry);}}
    await tx.query('update lara.documents set settlement_state=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,id,apply<micros(String(row.gross))?'credit_balance':'paid']);}
  }else await tx.query("update lara.documents set settlement_state='credit_balance' where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 }
 await audit(tx,ctx,{entityId,action:row.kind+'.post',resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'document',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'document.posted.v1',payload:{documentId:id,journalEntryId:entryId,ruleProfileVersion:row.rule_profile_version,payloadHash:row.payload_hash}});
 // Reporting-required profiles queue the e-invoice transmission with the issuance (P07); the job sends after commit.
 let jobId=null;
 if(profile.reportingRequired)jobId=(await queueTransmission(tx,ctx,entityId,id,{commandId})).jobId;
 return result(updated,{journalEntryIds,...(jobId?{jobId}:{})});
}
// Corrections never edit a posted document: a credit note (partial, within the
// remaining creditable amount per revenue account), an additional invoice, or a
// full reversal credit, each a new linked draft that travels through review.
export async function correctDocument(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'invoice.correct');requireEntity(ctx,entityId);assertInput('DocumentCorrection',input);
 const row=await loadDocument(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='posted'||row.kind!=='invoice')fail('STATE_CONFLICT','Only posted invoices are corrected.');
 const original=await lineRows(tx,ctx,id);
 const base={branchId:row.branch_id,bookId:row.book_id,partyId:row.party_id,documentDate:input.accountingDate,accountingDate:input.accountingDate,currency:row.currency,ruleProfileVersion:row.rule_profile_version,sourceDocumentId:id,evidenceIds:input.evidenceIds||[]};
 let created;
 if(input.kind==='additional_invoice')created=await insertDocument(tx,ctx,entityId,{...base,kind:'invoice',externalReference:'Correction of '+row.official_number+': '+input.reason,lines:input.lines},{sourceRelation:'correction'});
 else{
  const lines=input.kind==='reversal'?original.map(lineResource):input.lines;
  // Eligible credit per revenue account: original net minus net already credited by posted or pending credit notes.
  const credited=(await tx.query("select l.account_id,coalesce(sum(l.net),0)::text as net from lara.document_relations r join lara.documents d on d.tenant_id=r.tenant_id and d.id=r.source_id join lara.document_lines l on l.tenant_id=d.tenant_id and l.document_id=d.id where r.tenant_id=$1 and r.target_id=$2 and r.relation in ('credit','reversal') and d.state<>'cancelled' group by l.account_id",[ctx.tenantId,id])).rows;
  const remaining=new Map();for(const l of original){remaining.set(l.account_id,(remaining.get(l.account_id)||0n)+micros(String(l.net)));}
  for(const c of credited)remaining.set(c.account_id,(remaining.get(c.account_id)||0n)-micros(c.net));
  const profile=await salesProfile(tx,ctx,entityId);
  const rules=await resolveRules(tx,ctx,entityId,lines,input.accountingDate);
  const computed=computeLines(lines,rules,{scale:profile.scale});
  const requested=new Map();lines.forEach((l,i)=>requested.set(l.accountId,(requested.get(l.accountId)||0n)+computed[i].net));
  for(const [accountId,net] of requested){const left=remaining.get(accountId)??0n;if(net>left)fail('STATE_CONFLICT','Credit '+decimal(net)+' exceeds the remaining creditable '+decimal(left<0n?0n:left)+' for account '+accountId+'.');}
  created=await insertDocument(tx,ctx,entityId,{...base,kind:'credit_note',externalReference:(input.kind==='reversal'?'Reversal of ':'Credit against ')+row.official_number+': '+input.reason,lines},{sourceRelation:input.kind==='reversal'?'reversal':'credit'});
 }
 await audit(tx,ctx,{entityId,action:'invoice.correct',resourceType:'document',resourceId:id,resourceVersion:Number(row.version),reason:input.reason,afterRef:created.id});
 return {resourceType:'document',resourceId:created.id,version:1,state:'draft'};
}
export async function cancelDocument(tx,ctx,entityId,id,input,expectedVersion){
 requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadDocument(tx,ctx,entityId,id);requirePermission(ctx,permissionFor(row.kind,'edit'));if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','submitted'].includes(row.state))fail('STATE_CONFLICT','Only drafts and submitted documents cancel; posted ones are corrected.');
 const updated=(await tx.query("update lara.documents set state='cancelled' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:row.kind+'.cancel',resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return result(updated);
}
// Delivery: a queued delivery record and a worker job; the document keeps
// only the projection state. Recipients are stored as a hash.
export async function deliverDocument(tx,ctx,entityId,id,input,expectedVersion,{recipient=null}={}){
 requirePermission(ctx,'invoice.deliver');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadDocument(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='posted')fail('STATE_CONFLICT','Only issued documents are delivered.');
 const party=(await tx.query('select address_json from lara.party where tenant_id=$1 and id=$2',[ctx.tenantId,row.party_id])).rows[0];
 // Without an email on file the delivery is a rendered copy for manual handover; the adapter decides the channel.
 const address=recipient||party.address_json?.email||null;
 const delivery=(await tx.query("insert into lara.deliveries(tenant_id,entity_id,document_id,recipient_hash,template_version,created_by) values($1,$2,$3,$4,'invoice-email-1',$5) returning *",[ctx.tenantId,entityId,id,contentHash({partyId:row.party_id,address}),ctx.principalId])).rows[0];
 const updated=(await tx.query("update lara.documents set delivery_state='queued' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];
 const jobId=await enqueueJob(tx,ctx,{entityId,kind:'document.deliver',payload:{documentId:id,deliveryId:delivery.id,recipient:address}});
 await audit(tx,ctx,{entityId,action:'invoice.deliver',resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),afterRef:delivery.id});
 return result(updated,{taskIds:[],jobId});
}
// Converts an approved order or quotation into an invoice draft for the
// remaining billable quantity per line; the source link is immutable.
export async function convertDocument(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'sales_order.convert');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadDocument(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['quotation','sales_order'].includes(row.kind))fail('STATE_CONFLICT','Only quotations and sales orders convert.');
 if(row.state!=='approved')fail('STATE_CONFLICT','Only approved orders convert.');
 const lines=await lineRows(tx,ctx,id);
 const billed=(await tx.query("select l.line_no,coalesce(sum(l.quantity),0)::text as quantity from lara.document_relations r join lara.documents d on d.tenant_id=r.tenant_id and d.id=r.source_id join lara.document_lines l on l.tenant_id=d.tenant_id and l.document_id=d.id where r.tenant_id=$1 and r.target_id=$2 and r.relation='order' and d.state<>'cancelled' group by l.line_no",[ctx.tenantId,id])).rows;
 const used=new Map(billed.map(b=>[Number(b.line_no),micros(b.quantity)]));
 const remaining=lines.map(l=>({...lineResource(l),quantity:decimal(micros(String(l.quantity))-(used.get(l.line_no)||0n),6)})).filter(l=>micros(l.quantity)>0n);
 if(!remaining.length)fail('STATE_CONFLICT','The order is fully billed.');
 const today=new Date().toISOString().slice(0,10);
 const created=await insertDocument(tx,ctx,entityId,{kind:'invoice',branchId:row.branch_id,bookId:row.book_id,partyId:row.party_id,documentDate:today,accountingDate:today,currency:row.currency,ruleProfileVersion:row.rule_profile_version,sourceDocumentId:id,...(row.external_reference?{externalReference:row.external_reference}:{}),lines:remaining.map(l=>({...l,dimensions:l.dimensions||{}})),evidenceIds:[]},{sourceRelation:'order'});
 await audit(tx,ctx,{entityId,action:'sales_order.convert',resourceType:'document',resourceId:id,resourceVersion:Number(row.version),afterRef:created.id});
 return {resourceType:'document',resourceId:created.id,version:1,state:'draft'};
}
// Credit notes raised against a bill are supplier credits and belong to purchasing.
export const SUPPLIER_CREDIT="(d.kind='credit_note' and exists (select 1 from lara.documents s where s.tenant_id=d.tenant_id and s.id=d.source_document_id and s.kind='bill'))";
export async function getDocument(tx,ctx,entityId,id,{kinds}){
 requireEntity(ctx,entityId);requirePermission(ctx,permissionFor(kinds[0],'read'));
 const row=(await tx.query('select d.* from lara.documents d where d.tenant_id=$1 and d.entity_id=$2 and d.id=$3 and not '+SUPPLIER_CREDIT,[ctx.tenantId,entityId,id])).rows[0];
 if(!row||!kinds.includes(row.kind))fail('NOT_FOUND','Document not found.');
 requirePermission(ctx,permissionFor(row.kind,'read'));
 return documentResource(tx,ctx,row);
}
export async function listDocuments(tx,ctx,entityId,query,{kinds}){
 requireEntity(ctx,entityId);requirePermission(ctx,permissionFor(kinds[0],'read'));
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,kinds,limit+1];
 let where='';
 if(query?.state)where+=' and state=$'+params.push(String(query.state));
 if(query?.partyId){if(!isUuid(query.partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});where+=' and party_id=$'+params.push(query.partyId);}
 const rows=(await tx.query('select d.* from lara.documents d where d.tenant_id=$1 and d.entity_id=$2 and d.kind=any($3::text[]) and not '+SUPPLIER_CREDIT+where+cursorClause(after,params)+' order by created_at,id limit $4',params)).rows;
 const items=[];for(const r of rows.slice(0,limit))items.push(await documentResource(tx,ctx,r));
 return {items,nextCursor:page(rows,limit,r=>r,scope).nextCursor};
}

// ---------------------------------------------------------------------------
// Collections (receipts) and allocations
// ---------------------------------------------------------------------------
export const settlementMaterial=i=>({direction:i.direction,partyId:i.partyId,bankAccountId:i.bankAccountId||null,currency:i.currency,valueDate:i.valueDate,grossAmount:money(i.grossAmount),cashAmount:money(i.cashAmount),withholdingAmount:money(i.withholdingAmount),method:i.method,allocations:i.allocations.map(a=>({openItemId:a.openItemId,amount:money(a.amount)})),evidenceIds:[...i.evidenceIds].sort()});
export async function settlementResource(tx,ctx,s){
 const allocations=(await tx.query("select open_item_id,sum(case when action='apply' then amount else -amount end)::text as amount from lara.allocation_events where tenant_id=$1 and settlement_id=$2 group by open_item_id having sum(case when action='apply' then amount else -amount end)>0 order by open_item_id",[ctx.tenantId,s.id])).rows;
 const intended=s.state==='posted'||s.state==='reversed'?allocations.map(a=>({openItemId:a.open_item_id,amount:money(a.amount)})):(s.allocation_intents||[]);
 return resource({...s,status:s.state},{direction:s.direction,partyId:s.party_id,...(s.bank_account_id?{bankAccountId:s.bank_account_id}:{}),currency:s.currency,valueDate:iso(s.value_date),grossAmount:money(s.gross_amount),cashAmount:money(s.cash_amount),withholdingAmount:money(s.withholding_amount),method:s.payment_method,allocations:intended,evidenceIds:s.evidence_ids});
}
// A receipt from a party that is an employee but not a customer returns an
// unliquidated advance (P05): no allocations, no withholding, and open
// advances with at least that remainder must exist.
async function advanceReturn(tx,ctx,entityId,partyId){
 const roles=(await tx.query('select role from lara.party_roles where tenant_id=$1 and entity_id=$2 and party_id=$3',[ctx.tenantId,entityId,partyId])).rows.map(r=>r.role);
 return roles.includes('employee')&&!roles.includes('customer');
}
async function validateSettlement(tx,ctx,entityId,input,profile){
 if(input.direction!=='receipt')fail('VALIDATION_FAILED','Supplier payments are proposed through /settlements and paid through /payments.',{fieldErrors:[{path:'direction',message:'receipt'}]});
 const gross=micros(input.grossAmount),cash=micros(input.cashAmount),wht=micros(input.withholdingAmount);
 if(gross<=0n)fail('VALIDATION_FAILED','Receipts are positive.',{fieldErrors:[{path:'grossAmount',message:'Positive'}]});
 if(gross!==cash+wht)fail('VALIDATION_FAILED','Gross must equal cash plus withholding.',{fieldErrors:[{path:'grossAmount',message:'cash + withholding'}]});
 if(isUuid(input.partyId)&&await advanceReturn(tx,ctx,entityId,input.partyId)){
  if(input.allocations.length||wht>0n)fail('VALIDATION_FAILED','An advance return carries no allocations or withholding.',{fieldErrors:[{path:'allocations',message:'Empty for advance returns'}]});
  const open=(await tx.query("select coalesce(sum(amount-lara.advance_used(tenant_id,id)),0)::text as remaining from lara.advances where tenant_id=$1 and entity_id=$2 and party_id=$3 and status<>'closed'",[ctx.tenantId,entityId,input.partyId])).rows[0];
  if(micros(open.remaining)<gross)fail('ALLOCATION_EXCEEDS_BALANCE','The employee has '+money(open.remaining)+' of unliquidated advances; the return exceeds it.');
  return;
 }
 await customerFor(tx,ctx,entityId,input.partyId);
 if(wht>0n&&!profile.withholdingReceivableAccountId)fail('RULE_PROFILE_NOT_APPROVED','The sales profile has no withholding receivable account.');
 let sum=0n;
 for(const [i,a] of input.allocations.entries()){
  const item=(await tx.query("select * from lara.open_items where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,a.openItemId])).rows[0];
  if(!item)fail('NOT_FOUND','Open item '+a.openItemId+' not found.');
  if(item.party_id!==input.partyId||item.currency!==input.currency||item.side!=='AR')fail('VALIDATION_FAILED','Allocation '+(i+1)+' targets another customer, currency or side.',{fieldErrors:[{path:'allocations.'+i,message:'Mismatch'}]});
  const amount=micros(a.amount);if(amount<=0n)fail('VALIDATION_FAILED','Allocations are positive.',{fieldErrors:[{path:'allocations.'+i+'.amount',message:'Positive'}]});sum+=amount;
 }
 if(sum>gross)fail('ALLOCATION_EXCEEDS_BALANCE','Allocations '+decimal(sum)+' exceed the receipt '+decimal(gross)+'.');
}
export async function createCollection(tx,ctx,entityId,input){
 requirePermission(ctx,'collection.create');requireEntity(ctx,entityId);assertInput('SettlementCreate',input);await requireSales(tx,ctx,entityId);
 const profile=await salesProfile(tx,ctx,entityId);await validateSettlement(tx,ctx,entityId,input,profile);
 const book=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary' and status='active'",[ctx.tenantId,entityId])).rows[0];
 if(!book)fail('FEATURE_NOT_ENABLED','No primary book.');
 const m=settlementMaterial(input),hash=contentHash(m);
 const row=(await tx.query("insert into lara.settlements(tenant_id,entity_id,book_id,direction,party_id,bank_account_id,payment_method,currency,gross_amount,cash_amount,withholding_amount,value_date,evidence_ids,payload_hash,allocation_intents,created_by) values($1,$2,$3,'receipt',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *",[ctx.tenantId,entityId,book.id,input.partyId,input.bankAccountId||null,input.method,input.currency,m.grossAmount,m.cashAmount,m.withholdingAmount,input.valueDate,JSON.stringify(m.evidenceIds),hash,JSON.stringify(m.allocations),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'collection.create',resourceType:'collection',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return settlementResource(tx,ctx,row);
}
async function loadSettlement(tx,ctx,entityId,id){const row=(await tx.query("select * from lara.settlements where tenant_id=$1 and entity_id=$2 and id=$3 and direction='receipt' for update",[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Collection not found.');return row;}
export async function updateCollection(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'collection.edit');requireEntity(ctx,entityId);assertInput('SettlementCreate',input);
 const row=await loadSettlement(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(['posted','reversed','cancelled'].includes(row.state))fail('STATE_CONFLICT','Posted collections cannot change; reverse them.');
 const profile=await salesProfile(tx,ctx,entityId);await validateSettlement(tx,ctx,entityId,input,profile);
 const m=settlementMaterial(input),hash=contentHash(m),material=hash!==row.payload_hash;
 if(material&&row.state!=='draft')await tx.query("update lara.settlements set state='draft',approved_by=null,submitted_by=null where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 const updated=(await tx.query('update lara.settlements set party_id=$3,bank_account_id=$4,payment_method=$5,currency=$6,gross_amount=$7,cash_amount=$8,withholding_amount=$9,value_date=$10,evidence_ids=$11,payload_hash=$12,allocation_intents=$13,content_version=content_version+$14 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.partyId,input.bankAccountId||null,input.method,input.currency,m.grossAmount,m.cashAmount,m.withholdingAmount,input.valueDate,JSON.stringify(m.evidenceIds),hash,JSON.stringify(m.allocations),material?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:'collection.edit',resourceType:'collection',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return settlementResource(tx,ctx,updated);
}
const sresult=(row,extra={})=>({resourceType:'collection',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
export async function submitCollection(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'collection.submit');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadSettlement(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Collection is '+row.state+'.');
 if(row.evidence_ids.length)await linkEvidence(tx,ctx,entityId,row.evidence_ids,'collection',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.settlements set state='submitted',submitted_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'collection.submit',resourceType:'collection',resourceId:id,resourceVersion:Number(updated.version)});
 return sresult(updated);
}
export async function approveCollection(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'collection.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadSettlement(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='submitted')fail('STATE_CONFLICT','Only submitted collections are decided.');
 if(row.created_by===ctx.principalId||row.submitted_by===ctx.principalId)fail('SELF_APPROVAL','The preparer or submitter cannot approve this collection.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The collection changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const state=input.decision==='approve'?'approved':'draft';
 const updated=(await tx.query('update lara.settlements set state=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,state,input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'collection.'+input.decision,resourceType:'collection',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.payload_hash});
 return sresult(updated);
}
// AC-02 / AC-05: Dr cash (and withholding receivable), Cr receivable; then the
// intended allocations are applied through the guarded allocation events. An
// advance return credits the employee advance account instead.
function settlementJournalLines(row,profile,{creditAccountId=profile.arAccountId}={}){
 const out=[{accountId:profile.cashAccountId,branchId:row.branch_id,dimensions:{},debit:decimal(micros(String(row.cash_amount)),6),credit:'0'}];
 if(micros(String(row.withholding_amount))>0n)out.push({accountId:profile.withholdingReceivableAccountId,branchId:row.branch_id,dimensions:{},debit:decimal(micros(String(row.withholding_amount)),6),credit:'0'});
 out.push({accountId:creditAccountId,branchId:row.branch_id,dimensions:{},debit:'0',credit:decimal(micros(String(row.gross_amount)),6)});
 return out.filter(l=>micros(l.debit)>0n||micros(l.credit)>0n);
}
async function recordAdvanceReturn(tx,ctx,entityId,row,{commandId}){
 const profile=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='purchasing_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0]?.payload;
 if(!isUuid(profile?.advanceAccountId))fail('RULE_PROFILE_NOT_APPROVED','An approved purchasing profile with an employee advance account is required.');
 let left=micros(String(row.gross_amount));
 const advances=(await tx.query("select id,(amount-lara.advance_used(tenant_id,id))::text as remaining from lara.advances where tenant_id=$1 and entity_id=$2 and party_id=$3 and status<>'closed' order by created_at,id for update",[ctx.tenantId,entityId,row.party_id])).rows;
 for(const a of advances){if(left<=0n)break;const take=micros(a.remaining)<left?micros(a.remaining):left;if(take<=0n)continue;await tx.query("insert into lara.advance_events(tenant_id,entity_id,advance_id,kind,amount,settlement_id,command_id,created_by) values($1,$2,$3,'return',$4,$5,$6,$7)",[ctx.tenantId,entityId,a.id,decimal(take,6),row.id,commandId,ctx.principalId]);left-=take;}
 if(left>0n)fail('ALLOCATION_EXCEEDS_BALANCE','The return exceeds the unliquidated advances by '+decimal(left)+'.');
 return profile.advanceAccountId;
}
export async function applyAllocations(tx,ctx,entityId,settlementId,allocations,{commandId=null,reason=null}={}){
 const ids=[];
 for(const a of allocations){
  const id=(await tx.query("insert into lara.allocation_events(tenant_id,entity_id,settlement_id,open_item_id,amount,action,command_id,reason,created_by) values($1,$2,$3,$4,$5,'apply',$6,$7,$8) returning id",[ctx.tenantId,entityId,settlementId,a.openItemId,money(a.amount),commandId,reason,ctx.principalId])).rows[0].id;
  ids.push(id);
  const item=(await tx.query('select document_id from lara.open_items where tenant_id=$1 and id=$2',[ctx.tenantId,a.openItemId])).rows[0];
  await refreshSettlementState(tx,ctx,item.document_id);
 }
 return ids;
}
export async function postCollection(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'collection.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadSettlement(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return sresult(row,{journalEntryIds:[row.posted_entry_id]});
 if(row.state!=='approved')fail('STATE_CONFLICT','Approval is required before posting.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot both approve and post.');
 await checkGate(tx,ctx,id);
 const profile=await salesProfile(tx,ctx,entityId);
 const branch=(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and status='active' order by created_at limit 1",[ctx.tenantId,entityId])).rows[0];
 const party=(await tx.query('select legal_name from lara.party where tenant_id=$1 and id=$2',[ctx.tenantId,row.party_id])).rows[0];
 const advance=await advanceReturn(tx,ctx,entityId,row.party_id);
 const creditAccountId=advance?await recordAdvanceReturn(tx,ctx,entityId,row,{commandId}):profile.arAccountId;
 // A foreign-currency receipt settles at the approved rate of its value date: the
 // transaction entry moves cash and the control at that rate, the layers give the
 // consumed carrying value and the realized difference posts as a functional adjustment (P09).
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,row.book_id])).rows[0];
 const fxRate=row.currency!==book.functional_currency?await fx.rateFor(tx,ctx,entityId,{base:row.currency,quote:book.functional_currency,onDate:iso(row.value_date)}):null;
 const intents=row.allocation_intents||[];
 if(fxRate){if(advance)fail('FEATURE_NOT_ENABLED','Foreign-currency advance returns are not supported.');if(micros(String(row.withholding_amount))>0n)fail('FEATURE_NOT_ENABLED','Withholding on foreign-currency receipts is not supported.');const allocated=intents.reduce((t,a)=>t+micros(String(a.amount)),0n);if(allocated!==micros(String(row.gross_amount)))fail('STATE_CONFLICT','A foreign-currency receipt allocates its full amount at posting so the realized FX is known.');}
 let journalLines=settlementJournalLines({...row,branch_id:branch.id},profile,{creditAccountId});
 if(fxRate)journalLines=fx.translateLines(journalLines,fxRate.rate,{controlAccountId:creditAccountId});
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'settlement',sourceId:id,sourceVersion:Number(row.content_version),purpose:'posting',accountingDate:iso(row.value_date),documentDate:iso(row.value_date),description:(advance?'Advance returned by ':'Receipt from ')+party.legal_name,currency:row.currency,manual:false,postingActor:ctx.principalId,commandId,...(fxRate?fx.postingFx(fxRate):{}),lines:journalLines})])).rows[0].id;
 const updated=(await tx.query("update lara.settlements set state='posted',posted_entry_id=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId])).rows[0];
 await applyAllocations(tx,ctx,entityId,id,intents,{commandId});
 const journalEntryIds=[entryId];
 if(fxRate){const s=await fx.settleLayers(tx,ctx,entityId,{settlementId:id,allocations:intents,rate:fxRate,side:'AR'});const fxEntry=await fx.postRealized(tx,ctx,entityId,{bookId:row.book_id,sourceType:'settlement_fx',sourceId:id,sourceVersion:Number(row.content_version),accountingDate:iso(row.value_date),description:'Receipt from '+party.legal_name,controlAccountId:profile.arAccountId,branchId:branch.id,side:'AR',cashFunc:fx.controlFunc(journalLines,profile.arAccountId),consumed:s.consumed,commandId});if(fxEntry)journalEntryIds.push(fxEntry);}
 await audit(tx,ctx,{entityId,action:'collection.post',resourceType:'collection',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 return sresult(updated,{journalEntryIds});
}
export async function allocateCollection(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'collection.allocate');requireEntity(ctx,entityId);assertInput('ApplyAllocations',input);
 const row=await loadSettlement(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='posted')fail('STATE_CONFLICT','Only posted collections allocate.');
 for(const [i,a] of input.allocations.entries()){const item=(await tx.query('select * from lara.open_items where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,a.openItemId])).rows[0];if(!item)fail('NOT_FOUND','Open item not found.');if(micros(a.amount)<=0n)fail('VALIDATION_FAILED','Allocations are positive.',{fieldErrors:[{path:'allocations.'+i+'.amount',message:'Positive'}]});if(await fx.layerState(tx,ctx,item.id))fail('STATE_CONFLICT','Foreign-currency open items are allocated when the receipt posts, at its approved rate.');}
 const ids=await applyAllocations(tx,ctx,entityId,id,input.allocations,{commandId,reason:input.reason||null});
 const updated=(await tx.query('update lara.settlements set content_version=content_version where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:'collection.allocate',resourceType:'collection',resourceId:id,resourceVersion:Number(updated.version),afterRef:ids.join(',')});
 return sresult(updated,{allocationIds:ids});
}
export async function reverseAllocation(tx,ctx,entityId,id,input){
 requirePermission(ctx,'allocation.reverse');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const ev=(await tx.query("select * from lara.allocation_events where tenant_id=$1 and entity_id=$2 and id=$3 and action='apply'",[ctx.tenantId,entityId,id])).rows[0];
 if(!ev)fail('NOT_FOUND','Allocation not found.');
 const reversed=(await tx.query('select 1 from lara.allocation_events where tenant_id=$1 and reverses_id=$2',[ctx.tenantId,id])).rowCount;
 if(reversed)fail('STATE_CONFLICT','This allocation is already reversed.');
 const rid=(await tx.query("insert into lara.allocation_events(tenant_id,entity_id,settlement_id,credit_document_id,open_item_id,amount,action,reverses_id,reason,created_by) values($1,$2,$3,$4,$5,$6,'reverse',$7,$8,$9) returning id",[ctx.tenantId,entityId,ev.settlement_id,ev.credit_document_id,ev.open_item_id,ev.amount,id,input.reason,ctx.principalId])).rows[0].id;
 const item=(await tx.query('select document_id from lara.open_items where tenant_id=$1 and id=$2',[ctx.tenantId,ev.open_item_id])).rows[0];
 await refreshSettlementState(tx,ctx,item.document_id);
 await audit(tx,ctx,{entityId,action:'allocation.reverse',resourceType:'allocation',resourceId:id,resourceVersion:1,reason:input.reason,afterRef:rid});
 return {resourceType:'allocation',resourceId:rid,version:1,state:'reversed'};
}
// Reversing a posted receipt posts the mirrored entry and unwinds its
// allocations; the receipt itself stays as an immutable fact in state reversed.
export async function reverseCollection(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'collection.reverse');requireEntity(ctx,entityId);assertInput('Reversal',input);
 const row=await loadSettlement(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 return reverseSettlementEffect(tx,ctx,entityId,row,input,{commandId,action:'collection.reverse'});
}
// The reversal effect of a posted settlement (receipt or payment): mirrored
// entry, open allocations unwound, the settlement left as a reversed fact.
// Callers hold their own permission (collection.reverse, check.dishonor).
export async function reverseSettlementEffect(tx,ctx,entityId,row,input,{commandId=null,action='collection.reverse'}={}){
 const id=row.id;
 if(row.state!=='posted')fail('STATE_CONFLICT','Only posted settlements are reversed.');
 const entry=(await tx.query('select * from lara.journal_entries where tenant_id=$1 and id=$2',[ctx.tenantId,row.posted_entry_id])).rows[0];
 const lines=(await tx.query('select * from lara.journal_lines where tenant_id=$1 and entry_id=$2 order by line_no',[ctx.tenantId,row.posted_entry_id])).rows;
 const fxEntry=entry.transaction_currency!==entry.functional_currency;
 const reversalId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'settlement',sourceId:id,sourceVersion:Number(row.content_version),purpose:'reversal',accountingDate:input.accountingDate,documentDate:input.accountingDate,description:'Reversal: '+entry.description+' — '+input.reason,currency:row.currency,manual:false,postingActor:ctx.principalId,commandId,reversalOf:row.posted_entry_id,...(fxEntry?{rate:String(entry.fx_rate),rateId:entry.fx_rate_id}:{}),lines:lines.map(l=>({accountId:l.account_id,branchId:l.branch_id,dimensions:l.dimensions_json||{},debit:String(l.txn_credit),credit:String(l.txn_debit),...(fxEntry?{funcDebit:String(l.func_credit),funcCredit:String(l.func_debit)}:{})}))})])).rows[0].id;
 // The realized FX of the settlement reverses at its original amounts, never at today's rate.
 const fxAdjust=fxEntry?(await tx.query("select * from lara.journal_entries where tenant_id=$1 and source_type='settlement_fx' and source_id=$2 and purpose='adjustment' and reversal_of is null",[ctx.tenantId,id])).rows[0]:null;
 if(fxAdjust){const al=(await tx.query('select * from lara.journal_lines where tenant_id=$1 and entry_id=$2 order by line_no',[ctx.tenantId,fxAdjust.id])).rows;await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'settlement_fx',sourceId:id,sourceVersion:Number(row.content_version),purpose:'reversal',reversalOf:fxAdjust.id,accountingDate:input.accountingDate,documentDate:input.accountingDate,description:'Reversal: '+fxAdjust.description,currency:entry.functional_currency,manual:false,postingActor:ctx.principalId,commandId,lines:al.map(l=>({accountId:l.account_id,branchId:l.branch_id,dimensions:l.dimensions_json||{},debit:String(l.func_credit),credit:String(l.func_debit)}))})]);}
 if(fxEntry)await fx.reverseLayers(tx,ctx,entityId,{settlementId:id});
 const applies=(await tx.query("select a.* from lara.allocation_events a where a.tenant_id=$1 and a.settlement_id=$2 and a.action='apply' and not exists (select 1 from lara.allocation_events r where r.tenant_id=a.tenant_id and r.reverses_id=a.id)",[ctx.tenantId,id])).rows;
 for(const a of applies){await tx.query("insert into lara.allocation_events(tenant_id,entity_id,settlement_id,open_item_id,amount,action,reverses_id,reason,created_by) values($1,$2,$3,$4,$5,'reverse',$6,$7,$8)",[ctx.tenantId,entityId,id,a.open_item_id,a.amount,a.id,'Receipt reversed: '+input.reason,ctx.principalId]);const item=(await tx.query('select document_id from lara.open_items where tenant_id=$1 and id=$2',[ctx.tenantId,a.open_item_id])).rows[0];await refreshSettlementState(tx,ctx,item.document_id);}
 const updated=(await tx.query("update lara.settlements set state='reversed',reversal_entry_id=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,reversalId])).rows[0];
 await audit(tx,ctx,{entityId,action,resourceType:row.direction==='receipt'?'collection':'settlement',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason,afterRef:reversalId});
 return sresult(updated,{journalEntryIds:[reversalId]});
}
export async function getCollection(tx,ctx,entityId,id){requirePermission(ctx,'collection.read');requireEntity(ctx,entityId);const row=(await tx.query("select * from lara.settlements where tenant_id=$1 and entity_id=$2 and id=$3 and direction='receipt'",[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Collection not found.');return settlementResource(tx,ctx,row);}
export async function listCollections(tx,ctx,entityId,query){
 requirePermission(ctx,'collection.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';if(query?.partyId){if(!isUuid(query.partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});where+=' and party_id=$'+params.push(query.partyId);}
 const rows=(await tx.query("select * from lara.settlements where tenant_id=$1 and entity_id=$2 and direction='receipt'"+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const items=[];for(const r of rows.slice(0,limit))items.push(await settlementResource(tx,ctx,r));
 return {items,nextCursor:page(rows,limit,r=>r,scope).nextCursor};
}

// ---------------------------------------------------------------------------
// Open items and aging
// ---------------------------------------------------------------------------
const openItemView=r=>({id:r.id,documentId:r.document_id,partyId:r.party_id,side:r.side,currency:r.currency,originalAmount:money(r.original_amount),allocatedAmount:money(r.allocated.replace(/^-/,'')),outstandingAmount:money(r.outstanding.replace(/^-/,'')),dueDate:iso(r.due_date),version:Number(r.version)});
export async function listOpenItems(tx,ctx,entityId,query){
 requirePermission(ctx,'open_item.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';
 if(query?.partyId){if(!isUuid(query.partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});where+=' and party_id=$'+params.push(query.partyId);}
 if(query?.side){if(!['AR','AP'].includes(query.side))fail('VALIDATION_FAILED','side is AR or AP.',{fieldErrors:[{path:'side',message:'AR or AP'}]});where+=' and side=$'+params.push(query.side);}
 if(query?.open==='true')where+=" and status in ('open','partially_settled')";
 const rows=(await tx.query('select *,lara.open_item_allocated(tenant_id,id)::text as allocated,(original_amount-lara.open_item_allocated(tenant_id,id))::text as outstanding from lara.open_items where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,openItemView,scope);
}
// Customer aging as of a date: buckets by days past due over outstanding
// receivables, per party and in total. Deterministic from open items and
// allocation events recorded on or before the cutoff.
export async function agingReport(tx,ctx,entityId,{asOf,partyId=null,side='AR'}){
 requirePermission(ctx,'open_item.read');requireEntity(ctx,entityId);
 if(!['AR','AP'].includes(side))fail('VALIDATION_FAILED','side is AR or AP.');
 const params=[ctx.tenantId,entityId,asOf,side];
 const partyWhere=partyId?' and i.party_id=$'+params.push(partyId):'';
 const rows=(await tx.query("select i.id,i.party_id,p.legal_name,i.document_id,d.official_number,i.currency,i.due_date,i.original_amount::text as original,coalesce((select sum(case when e.action='apply' then e.amount else -e.amount end) from lara.allocation_events e where e.tenant_id=i.tenant_id and e.open_item_id=i.id and e.created_at<=($3::date+1)::timestamptz),0)::text as allocated from lara.open_items i join lara.party p on p.tenant_id=i.tenant_id and p.id=i.party_id join lara.documents d on d.tenant_id=i.tenant_id and d.id=i.document_id where i.tenant_id=$1 and i.entity_id=$2 and i.side=$4 and i.created_at<=($3::date+1)::timestamptz"+partyWhere+' order by p.legal_name,i.due_date,i.id',params)).rows;
 const buckets=['current','1_30','31_60','61_90','over_90'];
 const bucketOf=days=>days<=0?'current':days<=30?'1_30':days<=60?'31_60':days<=90?'61_90':'over_90';
 const parties=new Map();const total=Object.fromEntries(buckets.map(b=>[b,0n]));let grand=0n;
 for(const r of rows){
  const outstanding=micros(r.original)-micros(r.allocated.replace(/^-/,''))*(r.allocated.startsWith('-')?-1n:1n);
  if(outstanding<=0n)continue;
  const days=Math.round((Date.parse(asOf)-Date.parse(iso(r.due_date)))/86400000);
  const b=bucketOf(days);
  const party=parties.get(r.party_id)||{partyId:r.party_id,legalName:r.legal_name,currency:r.currency,buckets:Object.fromEntries(buckets.map(x=>[x,0n])),total:0n,items:[]};
  party.buckets[b]+=outstanding;party.total+=outstanding;party.items.push({openItemId:r.id,documentId:r.document_id,officialNumber:r.official_number,dueDate:iso(r.due_date),daysPastDue:days,outstanding:decimal(outstanding)});
  parties.set(r.party_id,party);total[b]+=outstanding;grand+=outstanding;
 }
 const fmt=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,decimal(v)]));
 return {asOf,side,parties:[...parties.values()].map(p=>({...p,buckets:fmt(p.buckets),total:decimal(p.total)})),totals:{...fmt(total),total:decimal(grand)}};
}
