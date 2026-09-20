// Purchasing module (P05): purchase orders, supplier bills and supplier
// credits with duplicate-reference and two-way match rules, expense claims
// liquidating employee advances, payment settlements proposed separately from
// bills, reviewed beneficiary versions, payment orders whose authority binds
// the proposal and the beneficiary and whose release and settlement only
// record what happened outside with evidence, and withholding certificates
// derived from tax events. Documents share the P04 kernel: server-side tax
// computation, one financial effect through lara.post_journal_entry, open
// items whose balances derive from append-only allocation events.
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {linkEvidence} from './evidence.mjs';
import {encryptField} from './parties.mjs';
import * as fx from './fx.mjs';
import {micros,decimal} from './ledger.mjs';
import {money,bookFor,branchFor,resolveRules,computeLines,totals,rateScaled,documentMaterial,lineResource,lineRows,writeLines,allocateNumber,refreshSettlementState,settlementMaterial,settlementResource,applyAllocations,loadDocument,dueSchedule,documentResource,SUPPLIER_CREDIT} from './sales.mjs';

const PICO=10n**12n;
const roundDiv=(num,den,unit)=>((2n*num+den*unit)/(2n*den*unit))*unit;
const unitFor=scale=>10n**BigInt(6-scale);
// Withholding on a net amount at the rule's rate, rounded half up at the currency scale.
export const withholdingOf=(net,rate,scale=2)=>roundDiv(net*rateScaled(rate),PICO,unitFor(scale));
// Proportional share of a bill's withholding for a partial settlement.
export const shareOf=(total,part,whole,scale=2)=>whole<=0n?0n:roundDiv(total*part,whole,unitFor(scale));
export const normalizeReference=ref=>String(ref||'').toLowerCase().replace(/[^a-z0-9]/g,'');

// ---------------------------------------------------------------------------
// Capability, profile and shared lookups
// ---------------------------------------------------------------------------
async function requirePurchasing(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='purchasing' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The purchasing capability is not active for this entity.');
}
// The approved purchasing profile: control accounts, withholding timing,
// PO and receipt-of-service policy, duplicate window, expense policy version
// and the withholding rule code assigned to each supplier.
export async function purchasingProfile(tx,ctx,entityId){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='purchasing_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved purchasing profile (control accounts, withholding timing, PO policy) is required.');
 const p=row.payload;
 for(const k of ['apAccountId','inputTaxAccountId','cashAccountId'])if(!isUuid(p[k]))fail('RULE_PROFILE_NOT_APPROVED','The purchasing profile lacks '+k+'.');
 return {apAccountId:p.apAccountId,inputTaxAccountId:p.inputTaxAccountId,cashAccountId:p.cashAccountId,withholdingPayableAccountId:isUuid(p.withholdingPayableAccountId)?p.withholdingPayableAccountId:null,advanceAccountId:isUuid(p.advanceAccountId)?p.advanceAccountId:null,withholdingRecognition:p.withholdingRecognition==='payment'?'payment':'accrual',scale:Number.isInteger(p.scale)?p.scale:2,dueDays:Number.isInteger(p.dueDays)?p.dueDays:30,requirePurchaseOrder:p.requirePurchaseOrder===true,requireReceiptOfService:p.requireReceiptOfService===true,nonPoAccountIds:Array.isArray(p.nonPoAccountIds)?p.nonPoAccountIds:[],duplicateWindowDays:Number.isInteger(p.duplicateWindowDays)?p.duplicateWindowDays:7,expensePolicyVersion:typeof p.expensePolicyVersion==='string'&&p.expensePolicyVersion?p.expensePolicyVersion:'expense-policy-1',supplierWithholding:p.supplierWithholding&&typeof p.supplierWithholding==='object'?p.supplierWithholding:{}};
}
async function partyWithRole(tx,ctx,entityId,partyId,role){
 if(!isUuid(partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});
 const party=(await tx.query('select * from lara.party where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,partyId])).rows[0];
 if(!party)fail('NOT_FOUND','Party not found.');
 if(party.status!=='active')fail('STATE_CONFLICT','The party is '+party.status+'.');
 const roles=(await tx.query('select role from lara.party_roles where tenant_id=$1 and entity_id=$2 and party_id=$3',[ctx.tenantId,entityId,partyId])).rows.map(r=>r.role);
 if(!roles.includes(role))fail('VALIDATION_FAILED','The party is not onboarded as '+(role==='employee'?'an employee':'a supplier')+'.',{fieldErrors:[{path:'partyId',message:role+' role required'}]});
 return {...party,roles};
}
// The active withholding rule version assigned to the supplier on the tax date, if any.
async function withholdingRule(tx,ctx,entityId,partyId,taxDate,profile){
 const code=profile.supplierWithholding[partyId];
 if(!code)return null;
 const rule=(await tx.query("select * from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and code=$3 and tax_type='withholding' and status='active' and valid_from<=$4::date and (valid_to is null or valid_to>=$4::date)",[ctx.tenantId,entityId,String(code).toUpperCase(),taxDate])).rows[0];
 if(!rule)fail('RULE_PROFILE_NOT_APPROVED','No active withholding rule version '+code+' applies on '+taxDate+' for this supplier.');
 return rule;
}

// ---------------------------------------------------------------------------
// Documents: purchase orders, bills, supplier credits and expense claims
// ---------------------------------------------------------------------------
const PERMISSIONS={bill:{create:'bill.prepare',edit:'bill.edit',read:'bill.read',submit:'bill.submit',approve:'bill.approve',post:'bill.post',correct:'bill.correct'},purchase_order:{create:'purchase_order.create',edit:'purchase_order.edit',read:'purchase_order.read',submit:'purchase_order.submit',approve:'purchase_order.approve',cancel:'purchase_order.cancel'},expense_claim:{create:'expense_claim.prepare',edit:'expense_claim.edit',read:'expense_claim.read',submit:'expense_claim.submit',approve:'expense_claim.approve',post:'expense_claim.post'}};
const familyOf=kind=>kind==='credit_note'?'bill':kind;
const permissionFor=(kind,action)=>{const p=PERMISSIONS[familyOf(kind)]?.[action];if(!p)fail('FEATURE_NOT_ENABLED','Documents of kind '+kind+' are not purchasing documents.');return p;};
const PURCHASING_DOC="(d.kind in ('bill','purchase_order','expense_claim') or "+SUPPLIER_CREDIT+")";
async function loadPurchasingDocument(tx,ctx,entityId,id,{lock=true}={}){
 if(!isUuid(id))fail('NOT_FOUND','Document not found.');
 const row=(await tx.query('select d.* from lara.documents d where d.tenant_id=$1 and d.entity_id=$2 and d.id=$3 and '+PURCHASING_DOC+(lock?' for update of d':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Document not found.');return row;
}
const result=(row,extra={})=>({resourceType:'document',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
// Validates references and computes totals and withholding for a purchasing document.
async function prepare(tx,ctx,entityId,input,profile,{kind=input.kind,source=null,excludeId=null}={}){
 const book=await bookFor(tx,ctx,entityId,input.bookId);
 if(input.currency!==book.functional_currency&&!(await fx.isFxActive(tx,ctx,entityId)))fail('FEATURE_NOT_ENABLED','Foreign-currency documents need the multi-currency capability (P09).');
 await fx.requireBookAccess(tx,ctx,book,'post');
 await branchFor(tx,ctx,entityId,input.branchId);
 const family=familyOf(kind);
 await partyWithRole(tx,ctx,entityId,input.partyId,family==='expense_claim'?'employee':'supplier');
 if(input.accountingDate<input.documentDate)fail('VALIDATION_FAILED','The accounting date cannot precede the document date.',{fieldErrors:[{path:'accountingDate',message:'Before document date'}]});
 if(family==='bill'&&kind==='bill'&&!input.externalReference?.trim())fail('VALIDATION_FAILED','A bill records the supplier invoice reference.',{fieldErrors:[{path:'externalReference',message:'Required for bills'}]});
 for(const [i,l] of input.lines.entries()){
  const acct=(await tx.query('select * from lara.accounts where tenant_id=$1 and entity_id=$2 and book_id=$3 and id=$4',[ctx.tenantId,entityId,input.bookId,l.accountId])).rows[0];
  if(!acct)fail('NOT_FOUND','Line '+(i+1)+' account not found in this book.');
  if(acct.status!=='active')fail('STATE_CONFLICT','Line '+(i+1)+' account is '+acct.status+'.');
  if(acct.control_type!=='none'||!['expense','asset'].includes(acct.category))fail('VALIDATION_FAILED','Line '+(i+1)+' must post to an expense or asset account, not a control or revenue account.',{fieldErrors:[{path:'lines.'+i+'.accountId',message:'Expense or asset account'}]});
  if(l.itemId)fail('FEATURE_NOT_ENABLED','Items and three-way matching arrive with inventory (P10).');
 }
 const rules=await resolveRules(tx,ctx,entityId,input.lines,input.documentDate);
 const computed=computeLines(input.lines,rules,{scale:profile.scale});
 const total=totals(computed);
 // Withholding applies to bills and, under accrual recognition, to supplier credits; never to orders or claims.
 let withholding={ruleVersionId:null,amount:0n};
 if(family==='bill'&&(kind==='bill'||profile.withholdingRecognition==='accrual')){
  const rule=await withholdingRule(tx,ctx,entityId,input.partyId,input.documentDate,profile);
  if(rule){const amount=withholdingOf(total.net,String(rule.rate),profile.scale);if(amount>0n&&!profile.withholdingPayableAccountId)fail('RULE_PROFILE_NOT_APPROVED','The purchasing profile has no withholding payable account.');withholding={ruleVersionId:rule.id,amount};}
 }
 if(source)await matchOrder(tx,ctx,entityId,source,input,total,profile,{excludeId});
 return {computed,total,withholding};
}
// Two-way match: the net billed against an approved order, across all
// non-cancelled linked bills, may not exceed the ordered net; with the
// receipt-of-service policy it may not exceed what was accepted either.
async function matchOrder(tx,ctx,entityId,order,input,total,profile,{excludeId=null}={}){
 if(order.kind!=='purchase_order')fail('VALIDATION_FAILED','Bills link to purchase orders.',{fieldErrors:[{path:'sourceDocumentId',message:'Not a purchase order'}]});
 if(order.state!=='approved')fail('STATE_CONFLICT','The purchase order is '+order.state+'; only approved orders are billed.');
 if(order.party_id!==input.partyId)fail('VALIDATION_FAILED','The order belongs to another supplier.',{fieldErrors:[{path:'partyId',message:'Differs from order'}]});
 const status=await orderStatus(tx,ctx,order.id,{excludeId});
 const ordered=micros(String(order.net)),invoiced=status.invoiced+total.net;
 if(invoiced>ordered)fail('STATE_CONFLICT','Two-way match: ordered '+decimal(ordered)+', already billed '+decimal(status.invoiced)+', this bill '+decimal(total.net)+' exceeds the order by '+decimal(invoiced-ordered)+'.');
 if(profile.requireReceiptOfService&&invoiced>status.received)fail('STATE_CONFLICT','Receipt of service: accepted '+decimal(status.received)+' against the order, billed would be '+decimal(invoiced)+'; record the receipt with evidence first.');
}
async function orderStatus(tx,ctx,orderId,{excludeId=null}={}){
 const billed=(await tx.query("select coalesce(sum(d.net),0)::text as net from lara.document_relations r join lara.documents d on d.tenant_id=r.tenant_id and d.id=r.source_id where r.tenant_id=$1 and r.target_id=$2 and r.relation='order' and d.state<>'cancelled' and ($3::uuid is null or d.id<>$3)",[ctx.tenantId,orderId,excludeId])).rows[0];
 const received=(await tx.query('select coalesce(sum(total),0)::text as total from lara.receipts_of_service where tenant_id=$1 and order_id=$2',[ctx.tenantId,orderId])).rows[0];
 return {invoiced:micros(billed.net),received:micros(received.total)};
}
// Ordered, received and invoiced amounts of a purchase order.
export async function purchaseOrderStatus(tx,ctx,entityId,id){
 requireEntity(ctx,entityId);requirePermission(ctx,'purchase_order.read');
 const row=await loadPurchasingDocument(tx,ctx,entityId,id,{lock:false});
 if(row.kind!=='purchase_order')fail('NOT_FOUND','Purchase order not found.');
 const s=await orderStatus(tx,ctx,id);
 return {orderId:id,ordered:money(row.net),received:decimal(s.received),invoiced:decimal(s.invoiced),remaining:decimal(micros(String(row.net))-s.invoiced)};
}
// Duplicate supplier references: the normalized reference is unique per
// supplier while the bill is not cancelled (also enforced by the database);
// a bill with the same gross and a nearby date under a different reference
// is a possible duplicate that the approver must dispose of.
async function duplicateCheck(tx,ctx,entityId,input,total,profile,{excludeId=null}={}){
 const normalized=normalizeReference(input.externalReference);
 const exact=(await tx.query("select id,external_reference from lara.documents where tenant_id=$1 and entity_id=$2 and kind='bill' and party_id=$3 and supplier_reference_normalized=$4 and state<>'cancelled' and ($5::uuid is null or id<>$5)",[ctx.tenantId,entityId,input.partyId,normalized,excludeId])).rows[0];
 if(exact)fail('DUPLICATE_SOURCE','Supplier reference "'+exact.external_reference+'" is already recorded for this supplier ('+exact.id+'); the original reference is retained.');
 const similar=(await tx.query("select id,external_reference,document_date from lara.documents where tenant_id=$1 and entity_id=$2 and kind='bill' and party_id=$3 and gross=$4 and state<>'cancelled' and abs(document_date-$5::date)<=$6 and ($7::uuid is null or id<>$7)",[ctx.tenantId,entityId,input.partyId,decimal(total.gross,6),input.documentDate,profile.duplicateWindowDays,excludeId])).rows;
 return {normalized,similar:similar.map(s=>({id:s.id,externalReference:s.external_reference,documentDate:iso(s.document_date)}))};
}
export async function createDocument(tx,ctx,entityId,input){
 requireEntity(ctx,entityId);assertInput('DocumentCreate',input);requirePermission(ctx,permissionFor(input.kind,'create'));
 if(!PERMISSIONS[input.kind])fail('VALIDATION_FAILED','Supplier credits are raised by correcting a posted bill.',{fieldErrors:[{path:'kind',message:'bill, purchase_order or expense_claim'}]});
 return insertDocument(tx,ctx,entityId,input);
}
async function insertDocument(tx,ctx,entityId,input,{sourceRelation=null}={}){
 assertInput('DocumentCreate',input);await requirePurchasing(tx,ctx,entityId);
 const profile=await purchasingProfile(tx,ctx,entityId);
 let source=null;
 if(input.sourceDocumentId){
  source=(await tx.query('select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.sourceDocumentId])).rows[0];
  if(!source)fail('NOT_FOUND','Source document not found.');
  if(input.kind==='bill'&&source.kind!=='purchase_order')fail('VALIDATION_FAILED','Bills link to purchase orders.',{fieldErrors:[{path:'sourceDocumentId',message:'Not a purchase order'}]});
  if(input.kind!=='bill'&&!sourceRelation)fail('VALIDATION_FAILED','Only bills link to a source document.',{fieldErrors:[{path:'sourceDocumentId',message:'Not allowed'}]});
 }
 const {computed,total,withholding}=await prepare(tx,ctx,entityId,input,profile,{source:input.kind==='bill'?source:null});
 const dup=input.kind==='bill'?await duplicateCheck(tx,ctx,entityId,input,total,profile):null;
 const m=documentMaterial(input),hash=contentHash(m);
 const row=(await tx.query('insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,net,tax,gross,withholding,withholding_rule_version_id,supplier_reference_normalized,rule_profile_version,external_reference,source_document_id,due_schedule,evidence_ids,payload_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) returning *',[ctx.tenantId,entityId,input.bookId,input.kind,input.branchId,input.partyId,input.documentDate,input.accountingDate,input.currency,decimal(total.net,6),decimal(total.tax,6),decimal(total.gross,6),decimal(withholding.amount,6),withholding.ruleVersionId,dup?.normalized||null,m.ruleProfileVersion,m.externalReference,m.sourceDocumentId,JSON.stringify(dueSchedule(input,total,profile)),JSON.stringify(m.evidenceIds),hash,ctx.principalId])).rows[0];
 await writeLines(tx,ctx,entityId,row.id,input,computed);
 if(input.sourceDocumentId)await tx.query('insert into lara.document_relations(tenant_id,entity_id,source_id,target_id,relation,amount,created_by) values($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,entityId,row.id,input.sourceDocumentId,sourceRelation||'order',decimal(total.gross,6),ctx.principalId]);
 if(input.kind==='expense_claim'){
  const advance=(await tx.query("select id from lara.advances where tenant_id=$1 and entity_id=$2 and party_id=$3 and status<>'closed' order by created_at,id limit 1",[ctx.tenantId,entityId,input.partyId])).rows[0];
  await tx.query('insert into lara.expense_claims(document_id,tenant_id,entity_id,employee_party_id,advance_id,policy_version) values($1,$2,$3,$4,$5,$6)',[row.id,ctx.tenantId,entityId,input.partyId,advance?.id||null,profile.expensePolicyVersion]);
 }
 await audit(tx,ctx,{entityId,action:familyOf(input.kind)+'.create',resourceType:'document',resourceId:row.id,resourceVersion:1,afterRef:hash,reason:dup?.similar.length?'Possible duplicate of '+dup.similar.map(s=>s.externalReference).join(', '):null});
 return documentResource(tx,ctx,row);
}
export async function updateDocument(tx,ctx,entityId,id,expectedVersion,input){
 requireEntity(ctx,entityId);assertInput('DocumentCreate',input);
 const row=await loadPurchasingDocument(tx,ctx,entityId,id);requirePermission(ctx,permissionFor(row.kind,'edit'));expectVersion(row,expectedVersion);
 if(['posted','cancelled'].includes(row.state))fail('STATE_CONFLICT','Posted or cancelled documents cannot change; corrections are new linked documents.');
 if(row.kind!==input.kind||row.book_id!==input.bookId||row.party_id!==input.partyId||(row.source_document_id||null)!==(input.sourceDocumentId||null))fail('VALIDATION_FAILED','Kind, book, party and source are fixed for a document.',{fieldErrors:[{path:'kind',message:'Immutable'}]});
 const profile=await purchasingProfile(tx,ctx,entityId);
 const source=row.source_document_id?(await tx.query('select * from lara.documents where tenant_id=$1 and id=$2',[ctx.tenantId,row.source_document_id])).rows[0]:null;
 const {computed,total,withholding}=await prepare(tx,ctx,entityId,input,profile,{kind:row.kind,source:row.kind==='bill'?source:null,excludeId:id});
 const dup=row.kind==='bill'?await duplicateCheck(tx,ctx,entityId,input,total,profile,{excludeId:id}):null;
 const m=documentMaterial(input),hash=contentHash(m),material=hash!==row.payload_hash;
 if(material&&row.state!=='draft')await tx.query("update lara.documents set state='draft',approved_by=null,submitted_by=null,approved_version=null where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 await writeLines(tx,ctx,entityId,id,input,computed);
 const updated=(await tx.query('update lara.documents set branch_id=$3,document_date=$4,accounting_date=$5,net=$6,tax=$7,gross=$8,withholding=$9,withholding_rule_version_id=$10,supplier_reference_normalized=$11,rule_profile_version=$12,external_reference=$13,due_schedule=$14,evidence_ids=$15,payload_hash=$16,content_version=content_version+$17 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.branchId,input.documentDate,input.accountingDate,decimal(total.net,6),decimal(total.tax,6),decimal(total.gross,6),decimal(withholding.amount,6),withholding.ruleVersionId,dup?.normalized||null,m.ruleProfileVersion,m.externalReference,JSON.stringify(dueSchedule(input,total,profile)),JSON.stringify(m.evidenceIds),hash,material?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:familyOf(row.kind)+'.edit',resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return documentResource(tx,ctx,updated);
}
// Submission applies the policy checks a draft may defer: evidence for bills
// and claims, the PO requirement outside the non-PO accounts, and a review
// task for a possible duplicate so the approver records a disposition.
export async function submitDocument(tx,ctx,entityId,id,input,expectedVersion){
 requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadPurchasingDocument(tx,ctx,entityId,id);requirePermission(ctx,permissionFor(row.kind,'submit'));if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','changes_requested'].includes(row.state))fail('STATE_CONFLICT','Document is '+row.state+'.');
 const taskIds=[];
 if(row.kind!=='purchase_order'){
  if(!row.evidence_ids.length)fail('EVIDENCE_NOT_READY','Bills, supplier credits and expense claims need at least one evidence file before review.');
  await linkEvidence(tx,ctx,entityId,row.evidence_ids,'document',id,Number(row.version)+1);
 }
 if(row.kind==='bill'){
  const profile=await purchasingProfile(tx,ctx,entityId);
  if(profile.requirePurchaseOrder&&!row.source_document_id){
   const accounts=(await lineRows(tx,ctx,id)).map(l=>l.account_id);
   const outside=accounts.filter(a=>!profile.nonPoAccountIds.includes(a));
   if(outside.length)fail('STATE_CONFLICT','This entity requires a purchase order for these expense accounts; utility and other non-PO accounts are named in the purchasing profile.');
  }
  const similar=(await tx.query("select id,external_reference,document_date from lara.documents where tenant_id=$1 and entity_id=$2 and kind='bill' and party_id=$3 and gross=$4 and state<>'cancelled' and abs(document_date-$5::date)<=$6 and id<>$7",[ctx.tenantId,entityId,row.party_id,row.gross,iso(row.document_date),profile.duplicateWindowDays,id])).rows;
  if(similar.length){
   const reason=('Possible duplicate: same supplier and gross '+money(row.gross)+' as '+similar.map(s=>s.external_reference+' ('+iso(s.document_date)+')').join(', ')+'. Approve only after checking the supplier documents.').slice(0,2000);
   const task=(await tx.query("insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,status,severity,cause_key,reason,created_by) values($1,$2,'duplicate_review','document',$3,'open','high','duplicate',$4,$5) on conflict do nothing returning id",[ctx.tenantId,entityId,id,reason,ctx.principalId])).rows[0];
   if(task)taskIds.push(task.id);
  }
 }
 if(row.state==='changes_requested')await tx.query("update lara.documents set state='draft' where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 const updated=(await tx.query("update lara.documents set state='submitted',submitted_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:familyOf(row.kind)+'.submit',resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),afterRef:taskIds.join(',')||null});
 return result(updated,{taskIds});
}
export async function approveDocument(tx,ctx,entityId,id,input,expectedVersion){
 requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadPurchasingDocument(tx,ctx,entityId,id);requirePermission(ctx,permissionFor(row.kind,'approve'));if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='submitted')fail('STATE_CONFLICT','Only submitted documents are decided.');
 if(row.created_by===ctx.principalId||row.submitted_by===ctx.principalId)fail('SELF_APPROVAL','The preparer or submitter cannot approve this document.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The document changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 if(input.decision==='approve'&&row.kind==='bill'){
  // A possible-duplicate task is the reviewer's disposition; approving resolves it with the stated reason.
  const open=(await tx.query("select id from lara.tasks where tenant_id=$1 and entity_id=$2 and source_type='document' and source_id=$3 and kind='duplicate_review' and status not in ('resolved','cancelled')",[ctx.tenantId,entityId,id])).rows;
  if(open.length&&!input.reason)fail('VALIDATION_FAILED','This bill is flagged as a possible duplicate; approval needs a reason recording the disposition.',{fieldErrors:[{path:'reason',message:'Disposition required'}]});
  for(const t of open)await tx.query("update lara.tasks set status='resolved',resolution=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,t.id,input.reason]);
 }
 const state=input.decision==='approve'?'approved':'changes_requested';
 const updated=(await tx.query('update lara.documents set state=$3,approved_by=$4,approved_version=$5 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,state,input.decision==='approve'?ctx.principalId:null,input.decision==='approve'?row.content_version:null])).rows[0];
 await audit(tx,ctx,{entityId,action:familyOf(row.kind)+'.'+input.decision,resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.payload_hash});
 return result(updated);
}
async function optionalNumber(tx,ctx,entityId,row){
 const series=(await tx.query("select 1 from lara.document_series where tenant_id=$1 and entity_id=$2 and branch_id=$3 and kind=$4 and status='active'",[ctx.tenantId,entityId,row.branch_id,row.kind==='credit_note'?'bill':row.kind])).rowCount;
 return series?allocateNumber(tx,ctx,entityId,{...row,kind:row.kind==='credit_note'?'bill':row.kind}):{seriesId:null,officialNumber:null};
}
// AC-03/04: expense and input tax against the payable, withholding payable
// recognized at accrual when the profile says so. A supplier credit mirrors.
function billJournalLines(row,lines,profile,{accrual}){
 const credit=row.kind==='credit_note';
 const side=(amount,debit)=>debit!==credit?{debit:decimal(amount,6),credit:'0'}:{debit:'0',credit:decimal(amount,6)};
 const out=[];
 const expense=new Map();
 for(const l of lines){const k=l.account_id+'|'+JSON.stringify(l.dimensions_json||{});const cur=expense.get(k)||{accountId:l.account_id,dimensions:l.dimensions_json||{},amount:0n};cur.amount+=micros(String(l.net));expense.set(k,cur);}
 for(const e of expense.values())if(e.amount>0n)out.push({accountId:e.accountId,branchId:row.branch_id,dimensions:e.dimensions,...side(e.amount,true)});
 const tax=lines.reduce((t,l)=>t+micros(String(l.tax)),0n);
 if(tax>0n)out.push({accountId:profile.inputTaxAccountId,branchId:row.branch_id,dimensions:{},...side(tax,true)});
 const wht=accrual?micros(String(row.withholding)):0n;
 out.push({accountId:profile.apAccountId,branchId:row.branch_id,dimensions:{},...side(micros(String(row.gross))-wht,false)});
 if(wht>0n)out.push({accountId:profile.withholdingPayableAccountId,branchId:row.branch_id,dimensions:{},...side(wht,false)});
 return out;
}
async function inputTaxEvents(tx,ctx,entityId,row,lines,entryId){
 for(const l of lines)if(l.tax_rule_version_id&&micros(String(l.tax))>0n){
  const rule=(await tx.query('select recognition from lara.tax_rule_versions where tenant_id=$1 and id=$2',[ctx.tenantId,l.tax_rule_version_id])).rows[0];
  if(['issue','accrual'].includes(rule.recognition))await tx.query('insert into lara.tax_events(tenant_id,entity_id,document_id,line_id,tax_rule_version_id,tax_point,recognition,basis,amount,recognition_entry_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[ctx.tenantId,entityId,row.id,l.id,l.tax_rule_version_id,rule.recognition==='issue'?iso(row.document_date):iso(row.accounting_date),rule.recognition,l.net,l.tax,entryId]);
 }
}
async function snapshotParty(tx,ctx,entityId,row,officialNumber){
 const party=(await tx.query('select * from lara.party where tenant_id=$1 and id=$2',[ctx.tenantId,row.party_id])).rows[0];
 const snapshot={legalName:party.legal_name,identityStatus:party.identity_status,address:party.address_json,officialNumber,supplierReference:row.external_reference,documentDate:iso(row.document_date)};
 await tx.query('insert into lara.party_snapshots(document_id,tenant_id,entity_id,immutable_json,snapshot_hash) values($1,$2,$3,$4,$5)',[row.id,ctx.tenantId,entityId,JSON.stringify(snapshot),contentHash(snapshot)]);
 return party;
}
// Posting a bill or supplier credit is the single financial effect: journal
// entry through the posting function, tax events, the payable open item (or
// the credit applied to the bill's payable), party snapshot and event.
export async function postDocument(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadPurchasingDocument(tx,ctx,entityId,id);
 if(row.kind==='purchase_order')fail('STATE_CONFLICT','Purchase orders are approved, not posted; the bill posts.');
 requirePermission(ctx,permissionFor(row.kind,'post'));if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return result(row,{journalEntryIds:[row.posted_entry_id]});
 if(row.state!=='approved')fail('STATE_CONFLICT','Approval is required before posting.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot both approve and post.');
 if(row.kind==='expense_claim')return postClaim(tx,ctx,entityId,row,{commandId});
 const profile=await purchasingProfile(tx,ctx,entityId);
 const lines=await lineRows(tx,ctx,id);
 if(row.kind==='bill'&&row.source_document_id){const order=(await tx.query('select * from lara.documents where tenant_id=$1 and id=$2 for update',[ctx.tenantId,row.source_document_id])).rows[0];await matchOrder(tx,ctx,entityId,order,{partyId:row.party_id},{net:micros(String(row.net))},profile,{excludeId:id});}
 const accrual=micros(String(row.withholding))>0n&&(row.kind==='credit_note'||profile.withholdingRecognition==='accrual');
 const recognition=micros(String(row.withholding))>0n?(accrual?'accrual':'payment'):null;
 const {seriesId,officialNumber}=await optionalNumber(tx,ctx,entityId,row);
 const party=await snapshotParty(tx,ctx,entityId,row,officialNumber);
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,row.book_id])).rows[0];
 const fxRate=row.currency!==book.functional_currency?await fx.rateFor(tx,ctx,entityId,{base:row.currency,quote:book.functional_currency,onDate:iso(row.document_date)}):null;
 if(fxRate&&micros(String(row.withholding))>0n)fail('FEATURE_NOT_ENABLED','Withholding on foreign-currency bills is not supported.');
 let journalLines=billJournalLines(row,lines,profile,{accrual});
 if(fxRate)journalLines=fx.translateLines(journalLines,fxRate.rate,{controlAccountId:profile.apAccountId});
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'document',sourceId:id,sourceVersion:Number(row.approved_version),purpose:'posting',accountingDate:iso(row.accounting_date),documentDate:iso(row.document_date),description:(row.kind==='credit_note'?'Supplier credit ':'Bill ')+(row.external_reference||officialNumber||'')+' '+party.legal_name,currency:row.currency,manual:false,postingActor:ctx.principalId,commandId,...(fxRate?fx.postingFx(fxRate):{}),lines:journalLines})])).rows[0].id;
 await inputTaxEvents(tx,ctx,entityId,row,lines,entryId);
 if(accrual)await tx.query("insert into lara.tax_events(tenant_id,entity_id,document_id,line_id,tax_rule_version_id,tax_point,recognition,basis,amount,recognition_entry_id) values($1,$2,$3,null,$4,$5,'accrual',$6,$7,$8)",[ctx.tenantId,entityId,id,row.withholding_rule_version_id,iso(row.accounting_date),row.net,row.withholding,entryId]);
 const updated=(await tx.query("update lara.documents set state='posted',posted_entry_id=$3,posted_by=$4,posted_at=now(),series_id=$5,official_number=$6,tax_date=document_date,withholding_recognition=$7 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId,ctx.principalId,seriesId,officialNumber,recognition])).rows[0];
 const payable=micros(String(row.gross))-(accrual?micros(String(row.withholding)):0n);
 if(row.kind==='bill'){
  if(payable>0n){const item=(await tx.query("insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AP',$4,$5,$6,$7) returning id",[ctx.tenantId,entityId,id,row.party_id,decimal(payable,6),row.currency,row.due_schedule[0]?.dueDate||iso(row.document_date)])).rows[0];if(fxRate)await fx.openLayer(tx,ctx,entityId,{openItemId:item.id,txn:payable,func:fx.controlFunc(journalLines,profile.apAccountId),rate:fxRate});}
  else await tx.query("update lara.documents set settlement_state='paid' where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 }else{
  const relation=(await tx.query("select target_id from lara.document_relations where tenant_id=$1 and source_id=$2 and relation in ('credit','reversal') limit 1",[ctx.tenantId,id])).rows[0];
  const item=relation?(await tx.query('select id,(original_amount-lara.open_item_allocated(tenant_id,id))::text as outstanding from lara.open_items where tenant_id=$1 and document_id=$2',[ctx.tenantId,relation.target_id])).rows[0]:null;
  let apply=0n;
  if(item){const outstanding=micros(item.outstanding.replace(/^-/,''));apply=outstanding<payable?outstanding:payable;
   if(apply>0n){await tx.query("insert into lara.allocation_events(tenant_id,entity_id,credit_document_id,open_item_id,amount,action,command_id,created_by) values($1,$2,$3,$4,$5,'apply',$6,$7)",[ctx.tenantId,entityId,id,item.id,decimal(apply,6),commandId,ctx.principalId]);await refreshSettlementState(tx,ctx,relation.target_id);}}
  await tx.query('update lara.documents set settlement_state=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,id,apply<payable?'credit_balance':'paid']);
 }
 await audit(tx,ctx,{entityId,action:familyOf(row.kind)+'.post',resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'document',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'document.posted.v1',payload:{documentId:id,journalEntryId:entryId,ruleProfileVersion:row.rule_profile_version,payloadHash:row.payload_hash}});
 return result(updated,{journalEntryIds:[entryId]});
}
// Expense claim posting liquidates the linked advance up to its remaining
// balance and opens a payable to the employee for the difference.
async function postClaim(tx,ctx,entityId,row,{commandId}){
 const profile=await purchasingProfile(tx,ctx,entityId);
 const lines=await lineRows(tx,ctx,row.id);
 const claim=(await tx.query('select * from lara.expense_claims where tenant_id=$1 and document_id=$2',[ctx.tenantId,row.id])).rows[0];
 const gross=micros(String(row.gross));
 let liquidate=0n,advance=null;
 if(claim?.advance_id){
  advance=(await tx.query('select *,(amount-lara.advance_used(tenant_id,id))::text as remaining from lara.advances where tenant_id=$1 and id=$2 for update',[ctx.tenantId,claim.advance_id])).rows[0];
  const remaining=micros(advance.remaining);liquidate=remaining<gross?remaining:gross;
  if(liquidate>0n&&!profile.advanceAccountId)fail('RULE_PROFILE_NOT_APPROVED','The purchasing profile has no employee advance account.');
 }
 const out=[];
 const expense=new Map();
 for(const l of lines){const k=l.account_id+'|'+JSON.stringify(l.dimensions_json||{});const cur=expense.get(k)||{accountId:l.account_id,dimensions:l.dimensions_json||{},amount:0n};cur.amount+=micros(String(l.net));expense.set(k,cur);}
 for(const e of expense.values())if(e.amount>0n)out.push({accountId:e.accountId,branchId:row.branch_id,dimensions:e.dimensions,debit:decimal(e.amount,6),credit:'0'});
 const tax=lines.reduce((t,l)=>t+micros(String(l.tax)),0n);
 if(tax>0n)out.push({accountId:profile.inputTaxAccountId,branchId:row.branch_id,dimensions:{},debit:decimal(tax,6),credit:'0'});
 if(liquidate>0n)out.push({accountId:profile.advanceAccountId,branchId:row.branch_id,dimensions:{},debit:'0',credit:decimal(liquidate,6)});
 if(gross-liquidate>0n)out.push({accountId:profile.apAccountId,branchId:row.branch_id,dimensions:{},debit:'0',credit:decimal(gross-liquidate,6)});
 const {seriesId,officialNumber}=await optionalNumber(tx,ctx,entityId,row);
 const party=await snapshotParty(tx,ctx,entityId,row,officialNumber);
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'document',sourceId:row.id,sourceVersion:Number(row.approved_version),purpose:'posting',accountingDate:iso(row.accounting_date),documentDate:iso(row.document_date),description:'Expense claim '+(officialNumber||row.id.slice(0,8))+' '+party.legal_name+(liquidate>0n?' (advance liquidation)':''),currency:row.currency,manual:false,postingActor:ctx.principalId,commandId,lines:out})])).rows[0].id;
 await inputTaxEvents(tx,ctx,entityId,row,lines,entryId);
 if(liquidate>0n)await tx.query("insert into lara.advance_events(tenant_id,entity_id,advance_id,kind,amount,document_id,entry_id,command_id,created_by) values($1,$2,$3,'liquidation',$4,$5,$6,$7,$8)",[ctx.tenantId,entityId,advance.id,decimal(liquidate,6),row.id,entryId,commandId,ctx.principalId]);
 const updated=(await tx.query("update lara.documents set state='posted',posted_entry_id=$3,posted_by=$4,posted_at=now(),series_id=$5,official_number=$6,tax_date=document_date,settlement_state=$7 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,row.id,entryId,ctx.principalId,seriesId,officialNumber,gross-liquidate>0n?'unpaid':'paid'])).rows[0];
 if(gross-liquidate>0n)await tx.query("insert into lara.open_items(tenant_id,entity_id,document_id,side,party_id,original_amount,currency,due_date) values($1,$2,$3,'AP',$4,$5,$6,$7)",[ctx.tenantId,entityId,row.id,row.party_id,decimal(gross-liquidate,6),row.currency,row.due_schedule[0]?.dueDate||iso(row.document_date)]);
 await audit(tx,ctx,{entityId,action:'expense_claim.post',resourceType:'document',resourceId:row.id,resourceVersion:Number(updated.version),afterRef:entryId,reason:liquidate>0n?'Liquidated '+decimal(liquidate)+' of advance '+advance.id:null});
 await emit(tx,ctx,{entityId,aggregateType:'document',aggregateId:row.id,aggregateVersion:Number(updated.version),eventType:'document.posted.v1',payload:{documentId:row.id,journalEntryId:entryId,ruleProfileVersion:row.rule_profile_version,payloadHash:row.payload_hash}});
 return result(updated,{journalEntryIds:[entryId]});
}
// Corrections of a posted bill: a supplier credit (within the remaining
// creditable net per expense account), an additional bill, or a full
// reversal credit, each a new linked draft that travels through review.
export async function correctDocument(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'bill.correct');requireEntity(ctx,entityId);assertInput('DocumentCorrection',input);
 const row=await loadPurchasingDocument(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='posted'||row.kind!=='bill')fail('STATE_CONFLICT','Only posted bills are corrected.');
 const original=await lineRows(tx,ctx,id);
 const base={branchId:row.branch_id,bookId:row.book_id,partyId:row.party_id,documentDate:input.accountingDate,accountingDate:input.accountingDate,currency:row.currency,ruleProfileVersion:row.rule_profile_version,sourceDocumentId:id,evidenceIds:input.evidenceIds||[]};
 let created;
 if(input.kind==='additional_invoice')created=await insertDocument(tx,ctx,entityId,{...base,kind:'bill',externalReference:(row.external_reference||'')+'/ADD-'+String(Number(row.content_version)),lines:input.lines},{sourceRelation:'correction'});
 else{
  const lines=input.kind==='reversal'?original.map(lineResource):input.lines;
  const credited=(await tx.query("select l.account_id,coalesce(sum(l.net),0)::text as net from lara.document_relations r join lara.documents d on d.tenant_id=r.tenant_id and d.id=r.source_id join lara.document_lines l on l.tenant_id=d.tenant_id and l.document_id=d.id where r.tenant_id=$1 and r.target_id=$2 and r.relation in ('credit','reversal') and d.state<>'cancelled' group by l.account_id",[ctx.tenantId,id])).rows;
  const remaining=new Map();for(const l of original)remaining.set(l.account_id,(remaining.get(l.account_id)||0n)+micros(String(l.net)));
  for(const c of credited)remaining.set(c.account_id,(remaining.get(c.account_id)||0n)-micros(c.net));
  const profile=await purchasingProfile(tx,ctx,entityId);
  const rules=await resolveRules(tx,ctx,entityId,lines,input.accountingDate);
  const computed=computeLines(lines,rules,{scale:profile.scale});
  const requested=new Map();lines.forEach((l,i)=>requested.set(l.accountId,(requested.get(l.accountId)||0n)+computed[i].net));
  for(const [accountId,net] of requested){const left=remaining.get(accountId)??0n;if(net>left)fail('STATE_CONFLICT','Credit '+decimal(net)+' exceeds the remaining creditable '+decimal(left<0n?0n:left)+' for account '+accountId+'.');}
  created=await insertDocument(tx,ctx,entityId,{...base,kind:'credit_note',externalReference:(input.kind==='reversal'?'Reversal of ':'Credit against ')+(row.external_reference||id.slice(0,8))+': '+input.reason,lines},{sourceRelation:input.kind==='reversal'?'reversal':'credit'});
 }
 await audit(tx,ctx,{entityId,action:'bill.correct',resourceType:'document',resourceId:id,resourceVersion:Number(row.version),reason:input.reason,afterRef:created.id});
 return {resourceType:'document',resourceId:created.id,version:1,state:'draft'};
}
// Orders cancel from draft, submitted or approved while nothing is billed against them.
export async function cancelDocument(tx,ctx,entityId,id,input,expectedVersion){
 requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadPurchasingDocument(tx,ctx,entityId,id);requirePermission(ctx,permissionFor(row.kind,row.kind==='purchase_order'?'cancel':'edit'));if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.kind==='purchase_order'){
  if(!['draft','submitted','approved'].includes(row.state))fail('STATE_CONFLICT','Order is '+row.state+'.');
  if((await orderStatus(tx,ctx,id)).invoiced>0n)fail('STATE_CONFLICT','Bills are recorded against this order; it cannot be cancelled.');
 }else if(!['draft','submitted'].includes(row.state))fail('STATE_CONFLICT','Only drafts and submitted documents cancel; posted ones are corrected.');
 const updated=(await tx.query("update lara.documents set state='cancelled' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:familyOf(row.kind)+'.cancel',resourceType:'document',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return result(updated);
}
export async function getDocument(tx,ctx,entityId,id,{kinds}){
 requireEntity(ctx,entityId);requirePermission(ctx,permissionFor(kinds[0],'read'));
 const row=isUuid(id)?(await tx.query('select d.* from lara.documents d where d.tenant_id=$1 and d.entity_id=$2 and d.id=$3 and '+PURCHASING_DOC,[ctx.tenantId,entityId,id])).rows[0]:null;
 if(!row||!kinds.includes(row.kind))fail('NOT_FOUND','Document not found.');
 return documentResource(tx,ctx,row);
}
export async function listDocuments(tx,ctx,entityId,query,{kinds}){
 requireEntity(ctx,entityId);requirePermission(ctx,permissionFor(kinds[0],'read'));
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,kinds,limit+1];
 let where='';
 if(query?.state)where+=' and d.state=$'+params.push(String(query.state));
 if(query?.partyId){if(!isUuid(query.partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});where+=' and d.party_id=$'+params.push(query.partyId);}
 if(query?.sourceDocumentId){if(!isUuid(query.sourceDocumentId))fail('VALIDATION_FAILED','sourceDocumentId must be a UUID.',{fieldErrors:[{path:'sourceDocumentId',message:'UUID'}]});where+=' and d.source_document_id=$'+params.push(query.sourceDocumentId);}
 const rows=(await tx.query('select d.* from lara.documents d where d.tenant_id=$1 and d.entity_id=$2 and d.kind=any($3::text[]) and '+PURCHASING_DOC+where+cursorClause(after,params)+' order by created_at,id limit $4',params)).rows;
 const items=[];for(const r of rows.slice(0,limit))items.push(await documentResource(tx,ctx,r));
 return {items,nextCursor:page(rows,limit,r=>r,scope).nextCursor};
}
// Receipt of service: a named principal accepts, with evidence, that ordered
// services were received; the append-only record feeds the two-way match.
export async function recordReceipt(tx,ctx,entityId,orderId,{evidenceId,lines}){
 requirePermission(ctx,'purchase_order.edit');requireEntity(ctx,entityId);await requirePurchasing(tx,ctx,entityId);
 const order=await loadPurchasingDocument(tx,ctx,entityId,orderId);
 if(order.kind!=='purchase_order'||order.state!=='approved')fail('STATE_CONFLICT','Receipts are recorded against approved purchase orders.');
 if(!Array.isArray(lines)||!lines.length)fail('VALIDATION_FAILED','A receipt names at least one order line.',{fieldErrors:[{path:'lines',message:'Required'}]});
 if(!isUuid(evidenceId))fail('VALIDATION_FAILED','evidenceId must be a UUID.',{fieldErrors:[{path:'evidenceId',message:'UUID'}]});
 const orderLines=await lineRows(tx,ctx,orderId);
 let total=0n;
 const material=lines.map((l,i)=>{const ol=orderLines.find(o=>o.line_no===Number(l.lineNo));if(!ol)fail('VALIDATION_FAILED','Line '+l.lineNo+' is not on the order.',{fieldErrors:[{path:'lines.'+i+'.lineNo',message:'Unknown line'}]});const amount=micros(String(l.amount));if(amount<=0n)fail('VALIDATION_FAILED','Receipt amounts are positive.',{fieldErrors:[{path:'lines.'+i+'.amount',message:'Positive'}]});total+=amount;return {lineNo:ol.line_no,amount:decimal(amount,6),...(l.quantity!==undefined?{quantity:decimal(micros(String(l.quantity)),6)}:{})};});
 const received=(await orderStatus(tx,ctx,orderId)).received;
 if(received+total>micros(String(order.net)))fail('STATE_CONFLICT','Receipts '+decimal(received+total)+' would exceed the ordered '+money(order.net)+'.');
 await linkEvidence(tx,ctx,entityId,[evidenceId],'receipt_of_service',orderId,Number(order.version));
 const row=(await tx.query('insert into lara.receipts_of_service(tenant_id,entity_id,order_id,evidence_id,accepted_by,lines_json,total,created_by) values($1,$2,$3,$4,$5,$6,$7,$5) returning *',[ctx.tenantId,entityId,orderId,evidenceId,ctx.principalId,JSON.stringify(material),decimal(total,6)])).rows[0];
 await audit(tx,ctx,{entityId,action:'purchase_order.receive',resourceType:'receipt_of_service',resourceId:row.id,resourceVersion:1,afterRef:evidenceId});
 return {id:row.id,orderId,evidenceId,acceptedBy:ctx.principalId,acceptedAt:iso(row.accepted_at),lines:material,total:money(row.total)};
}
export async function listReceipts(tx,ctx,entityId,orderId){
 requirePermission(ctx,'purchase_order.read');requireEntity(ctx,entityId);
 const rows=(await tx.query('select * from lara.receipts_of_service where tenant_id=$1 and entity_id=$2 and order_id=$3 order by accepted_at,id',[ctx.tenantId,entityId,orderId])).rows;
 return rows.map(r=>({id:r.id,orderId:r.order_id,evidenceId:r.evidence_id,acceptedBy:r.accepted_by,acceptedAt:iso(r.accepted_at),lines:r.lines_json,total:money(r.total)}));
}

// ---------------------------------------------------------------------------
// Payment settlements: proposals against payables, never a cash posting
// ---------------------------------------------------------------------------
async function loadSettlement(tx,ctx,entityId,id,{lock=true}={}){
 if(!isUuid(id))fail('NOT_FOUND','Settlement not found.');
 const row=(await tx.query("select * from lara.settlements where tenant_id=$1 and entity_id=$2 and id=$3 and direction='payment'"+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Settlement not found.');return row;
}
// Withholding a payment must carry: for each allocated bill whose withholding
// is recognized at payment, the proportional share of the bill's withholding.
async function expectedWithholding(tx,ctx,entityId,allocations,profile){
 let total=0n;const shares=[];
 for(const a of allocations){
  const item=(await tx.query('select i.*,d.withholding::text as withholding,d.withholding_rule_version_id,d.withholding_recognition,d.net::text as net,d.kind from lara.open_items i join lara.documents d on d.tenant_id=i.tenant_id and d.id=i.document_id where i.tenant_id=$1 and i.entity_id=$2 and i.id=$3',[ctx.tenantId,entityId,a.openItemId])).rows[0];
  if(!item)continue;
  if(item.withholding_recognition==='payment'&&micros(item.withholding)>0n){
   const share=shareOf(micros(item.withholding),micros(a.amount),micros(String(item.original_amount)),profile.scale);
   const basis=shareOf(micros(item.net),micros(a.amount),micros(String(item.original_amount)),profile.scale);
   total+=share;shares.push({documentId:item.document_id,ruleVersionId:item.withholding_rule_version_id,amount:share,basis});
  }
 }
 return {total,shares};
}
async function validatePayment(tx,ctx,entityId,input,profile){
 if(input.direction!=='payment')fail('VALIDATION_FAILED','This operation proposes supplier and employee payments; receipts are collections.',{fieldErrors:[{path:'direction',message:'payment'}]});
 if(!isUuid(input.partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});
 const party=(await tx.query('select * from lara.party where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.partyId])).rows[0];
 if(!party)fail('NOT_FOUND','Party not found.');
 if(party.status!=='active')fail('STATE_CONFLICT','The party is '+party.status+'.');
 const roles=(await tx.query('select role from lara.party_roles where tenant_id=$1 and entity_id=$2 and party_id=$3',[ctx.tenantId,entityId,input.partyId])).rows.map(r=>r.role);
 if(!roles.includes('supplier')&&!roles.includes('employee'))fail('VALIDATION_FAILED','Payments go to suppliers and employees.',{fieldErrors:[{path:'partyId',message:'Supplier or employee role required'}]});
 const gross=micros(input.grossAmount),cash=micros(input.cashAmount),wht=micros(input.withholdingAmount);
 if(gross<=0n)fail('VALIDATION_FAILED','Payments are positive.',{fieldErrors:[{path:'grossAmount',message:'Positive'}]});
 if(gross!==cash+wht)fail('VALIDATION_FAILED','Gross must equal cash plus withholding.',{fieldErrors:[{path:'grossAmount',message:'cash + withholding'}]});
 let sum=0n;
 for(const [i,a] of input.allocations.entries()){
  const item=(await tx.query('select * from lara.open_items where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,a.openItemId])).rows[0];
  if(!item)fail('NOT_FOUND','Open item '+a.openItemId+' not found.');
  if(item.party_id!==input.partyId||item.currency!==input.currency||item.side!=='AP')fail('VALIDATION_FAILED','Allocation '+(i+1)+' targets another party, currency or side.',{fieldErrors:[{path:'allocations.'+i,message:'Mismatch'}]});
  const amount=micros(a.amount);if(amount<=0n)fail('VALIDATION_FAILED','Allocations are positive.',{fieldErrors:[{path:'allocations.'+i+'.amount',message:'Positive'}]});
  const outstanding=micros(String(item.original_amount))-micros((await tx.query('select lara.open_item_allocated($1,$2)::text as used',[ctx.tenantId,item.id])).rows[0].used.replace(/^-/,''));
  if(amount>outstanding)fail('ALLOCATION_EXCEEDS_BALANCE','Allocation '+(i+1)+' exceeds the outstanding '+decimal(outstanding)+'.');
  sum+=amount;
 }
 const advance=!input.allocations.length;
 if(advance&&!roles.includes('employee'))fail('VALIDATION_FAILED','A supplier payment settles open bills; allocate the full amount.',{fieldErrors:[{path:'allocations',message:'Required for suppliers'}]});
 if(!advance&&sum!==gross)fail('ALLOCATION_EXCEEDS_BALANCE','Allocations '+decimal(sum)+' must equal the payment '+decimal(gross)+'.');
 if(advance&&!profile.advanceAccountId)fail('RULE_PROFILE_NOT_APPROVED','The purchasing profile has no employee advance account.');
 const expected=advance?{total:0n,shares:[]}:await expectedWithholding(tx,ctx,entityId,input.allocations,profile);
 if(wht!==expected.total)fail('VALIDATION_FAILED','Withholding must be '+decimal(expected.total)+' for these allocations (bills recognized at payment).',{fieldErrors:[{path:'withholdingAmount',message:'Expected '+decimal(expected.total)}]});
 if(wht>0n&&!profile.withholdingPayableAccountId)fail('RULE_PROFILE_NOT_APPROVED','The purchasing profile has no withholding payable account.');
 return {advance,expected};
}
export async function createSettlement(tx,ctx,entityId,input){
 requirePermission(ctx,'settlements.create');requireEntity(ctx,entityId);assertInput('SettlementCreate',input);await requirePurchasing(tx,ctx,entityId);
 const profile=await purchasingProfile(tx,ctx,entityId);await validatePayment(tx,ctx,entityId,input,profile);
 const book=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary' and status='active'",[ctx.tenantId,entityId])).rows[0];
 if(!book)fail('FEATURE_NOT_ENABLED','No primary book.');
 const m=settlementMaterial(input),hash=contentHash(m);
 const row=(await tx.query("insert into lara.settlements(tenant_id,entity_id,book_id,direction,party_id,bank_account_id,payment_method,currency,gross_amount,cash_amount,withholding_amount,value_date,evidence_ids,payload_hash,allocation_intents,created_by) values($1,$2,$3,'payment',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *",[ctx.tenantId,entityId,book.id,input.partyId,input.bankAccountId||null,input.method,input.currency,m.grossAmount,m.cashAmount,m.withholdingAmount,input.valueDate,JSON.stringify(m.evidenceIds),hash,JSON.stringify(m.allocations),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'settlements.create',resourceType:'settlement',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return settlementResource(tx,ctx,row);
}
// Editing a proposal withdraws any payment authority that bound its content.
async function withdrawAuthority(tx,ctx,entityId,{settlementId=null,beneficiaryVersionId=null},reason){
 const orders=(await tx.query("select * from lara.payment_orders where tenant_id=$1 and entity_id=$2 and state in ('submitted','authorized') and (($3::uuid is not null and settlement_id=$3) or ($4::uuid is not null and beneficiary_version_id=$4)) for update",[ctx.tenantId,entityId,settlementId,beneficiaryVersionId])).rows;
 for(const o of orders){
  const updated=(await tx.query("update lara.payment_orders set state='draft',authorized_by=null,authorized_settlement_version=null,submitted_by=null where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,o.id])).rows[0];
  await tx.query("update lara.settlements set state='draft',approved_by=null,submitted_by=null where tenant_id=$1 and id=$2 and state='approved'",[ctx.tenantId,o.settlement_id]);
  await audit(tx,ctx,{entityId,action:'payment.authority_withdrawn',resourceType:'payment',resourceId:o.id,resourceVersion:Number(updated.version),reason});
 }
 return orders.map(o=>o.id);
}
export async function updateSettlement(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'settlements.edit');requireEntity(ctx,entityId);assertInput('SettlementCreate',input);
 const row=await loadSettlement(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(['posted','reversed','cancelled'].includes(row.state))fail('STATE_CONFLICT','Posted settlements cannot change; return the payment.');
 const profile=await purchasingProfile(tx,ctx,entityId);await validatePayment(tx,ctx,entityId,input,profile);
 const m=settlementMaterial(input),hash=contentHash(m),material=hash!==row.payload_hash;
 if(material&&row.state!=='draft'){await withdrawAuthority(tx,ctx,entityId,{settlementId:id},'Settlement content changed');await tx.query("update lara.settlements set state='draft',approved_by=null,submitted_by=null where tenant_id=$1 and id=$2",[ctx.tenantId,id]);}
 const updated=(await tx.query('update lara.settlements set party_id=$3,bank_account_id=$4,payment_method=$5,currency=$6,gross_amount=$7,cash_amount=$8,withholding_amount=$9,value_date=$10,evidence_ids=$11,payload_hash=$12,allocation_intents=$13,content_version=content_version+$14 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.partyId,input.bankAccountId||null,input.method,input.currency,m.grossAmount,m.cashAmount,m.withholdingAmount,input.valueDate,JSON.stringify(m.evidenceIds),hash,JSON.stringify(m.allocations),material?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:'settlements.edit',resourceType:'settlement',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return settlementResource(tx,ctx,updated);
}
const sresult=(row,extra={})=>({resourceType:'settlement',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
export async function submitSettlement(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'settlements.submit');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadSettlement(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Settlement is '+row.state+'.');
 if(row.evidence_ids.length)await linkEvidence(tx,ctx,entityId,row.evidence_ids,'settlement',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.settlements set state='submitted',submitted_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'settlements.submit',resourceType:'settlement',resourceId:id,resourceVersion:Number(updated.version)});
 return sresult(updated);
}
export async function getSettlement(tx,ctx,entityId,id){requirePermission(ctx,'settlements.read');requireEntity(ctx,entityId);return settlementResource(tx,ctx,await loadSettlement(tx,ctx,entityId,id,{lock:false}));}
export async function listSettlements(tx,ctx,entityId,query){
 requirePermission(ctx,'settlements.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';
 if(query?.partyId){if(!isUuid(query.partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});where+=' and party_id=$'+params.push(query.partyId);}
 if(query?.state)where+=' and state=$'+params.push(String(query.state));
 const rows=(await tx.query("select * from lara.settlements where tenant_id=$1 and entity_id=$2 and direction='payment'"+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const items=[];for(const r of rows.slice(0,limit))items.push(await settlementResource(tx,ctx,r));
 return {items,nextCursor:page(rows,limit,r=>r,scope).nextCursor};
}

// ---------------------------------------------------------------------------
// Beneficiary versions: reviewed payee bank details, one approved per party
// ---------------------------------------------------------------------------
const beneficiaryResource=b=>({id:b.id,version:Number(b.version),state:b.status,partyId:b.party_id,versionNumber:b.version_number,bankName:b.bank_name,accountName:b.account_name,accountNumberLast4:b.account_number_last4,reviewedBy:b.reviewed_by,createdAt:iso(b.created_at),updatedAt:iso(b.updated_at),simulation:false});
export async function createBeneficiary(tx,ctx,entityId,{partyId,bankName,accountName,accountNumber},env){
 requirePermission(ctx,'payment.edit');requireEntity(ctx,entityId);await requirePurchasing(tx,ctx,entityId);
 const party=await partyWithRole(tx,ctx,entityId,partyId,'supplier').catch(e=>{if(e.code==='VALIDATION_FAILED')return partyWithRole(tx,ctx,entityId,partyId,'employee');throw e;});
 const account=String(accountNumber||'').replace(/\s+/g,'');
 if(!/^[A-Za-z0-9]{4,34}$/.test(account))fail('VALIDATION_FAILED','Account numbers are 4 to 34 letters or digits.',{fieldErrors:[{path:'accountNumber',message:'Invalid'}]});
 for(const [k,v] of [['bankName',bankName],['accountName',accountName]])if(typeof v!=='string'||!v.trim()||v.length>200)fail('VALIDATION_FAILED',k+' is required (up to 200 characters).',{fieldErrors:[{path:k,message:'Required'}]});
 const hash=contentHash({partyId,bankName:bankName.trim(),accountName:accountName.trim(),accountNumber:account});
 const next=((await tx.query('select coalesce(max(version_number),0)::int v from lara.beneficiary_versions where tenant_id=$1 and entity_id=$2 and party_id=$3',[ctx.tenantId,entityId,partyId])).rows[0].v)+1;
 const row=(await tx.query('insert into lara.beneficiary_versions(tenant_id,entity_id,party_id,version_number,bank_name,account_name,account_number_encrypted,account_number_last4,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,partyId,next,bankName.trim(),accountName.trim(),encryptField(account,env),account.slice(-4),hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'beneficiary.create',resourceType:'beneficiary',resourceId:row.id,resourceVersion:1,afterRef:hash,reason:party.legal_name});
 return beneficiaryResource(row);
}
// Approval supersedes the previously approved version and withdraws every
// payment authority that bound the old one: the beneficiary changed.
export async function approveBeneficiary(tx,ctx,entityId,id,{decision='approve',reason=null}={}){
 requirePermission(ctx,'payment.authorize');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.beneficiary_versions where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Beneficiary version not found.');
 if(row.status!=='draft')fail('STATE_CONFLICT','Beneficiary version is '+row.status+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who entered the bank details cannot approve them.');
 if(decision==='reject'){if(!reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});const rejected=(await tx.query("update lara.beneficiary_versions set status='rejected',reviewed_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];await audit(tx,ctx,{entityId,action:'beneficiary.reject',resourceType:'beneficiary',resourceId:id,resourceVersion:Number(rejected.version),reason});return beneficiaryResource(rejected);}
 const prior=(await tx.query("select id from lara.beneficiary_versions where tenant_id=$1 and entity_id=$2 and party_id=$3 and status='approved' for update",[ctx.tenantId,entityId,row.party_id])).rows;
 for(const p of prior){await tx.query("update lara.beneficiary_versions set status='superseded' where tenant_id=$1 and id=$2",[ctx.tenantId,p.id]);await withdrawAuthority(tx,ctx,entityId,{beneficiaryVersionId:p.id},'Beneficiary details changed to version '+row.version_number);}
 const updated=(await tx.query("update lara.beneficiary_versions set status='approved',reviewed_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'beneficiary.approve',resourceType:'beneficiary',resourceId:id,resourceVersion:Number(updated.version),afterRef:row.content_hash,reason});
 return beneficiaryResource(updated);
}
export async function listBeneficiaries(tx,ctx,entityId,{partyId=null}={}){
 requirePermission(ctx,'payment.read');requireEntity(ctx,entityId);
 const params=[ctx.tenantId,entityId];const where=partyId?' and party_id=$'+params.push(partyId):'';
 return (await tx.query('select * from lara.beneficiary_versions where tenant_id=$1 and entity_id=$2'+where+' order by party_id,version_number',params)).rows.map(beneficiaryResource);
}

// ---------------------------------------------------------------------------
// Payment orders: authority, release and settlement recorded with evidence
// ---------------------------------------------------------------------------
const paymentResource=p=>resource({...p,status:p.state},{settlementId:p.settlement_id,beneficiaryVersionId:p.beneficiary_version_id,scheduledDate:iso(p.scheduled_date),...(p.reason?{reason:p.reason}:{})});
const presult=(row,extra={})=>({resourceType:'payment',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
async function loadPayment(tx,ctx,entityId,id,{lock=true}={}){
 if(!isUuid(id))fail('NOT_FOUND','Payment not found.');
 const row=(await tx.query('select * from lara.payment_orders where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Payment not found.');return row;
}
async function paymentRefs(tx,ctx,entityId,input){
 const settlement=await loadSettlement(tx,ctx,entityId,input.settlementId,{lock:false}).catch(()=>fail('NOT_FOUND','Settlement not found.'));
 if(!isUuid(input.beneficiaryVersionId))fail('VALIDATION_FAILED','beneficiaryVersionId must be a UUID.',{fieldErrors:[{path:'beneficiaryVersionId',message:'UUID'}]});
 const beneficiary=(await tx.query('select * from lara.beneficiary_versions where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.beneficiaryVersionId])).rows[0];
 if(!beneficiary)fail('NOT_FOUND','Beneficiary version not found.');
 if(beneficiary.party_id!==settlement.party_id)fail('VALIDATION_FAILED','The beneficiary belongs to another party than the settlement.',{fieldErrors:[{path:'beneficiaryVersionId',message:'Party mismatch'}]});
 if(beneficiary.status!=='approved')fail('STATE_CONFLICT','Only approved beneficiary versions receive payments.');
 return {settlement,beneficiary};
}
export async function createPayment(tx,ctx,entityId,input){
 requirePermission(ctx,'payment.create');requireEntity(ctx,entityId);assertInput('PaymentCreate',input);await requirePurchasing(tx,ctx,entityId);
 const {settlement}=await paymentRefs(tx,ctx,entityId,input);
 if(!['draft','submitted'].includes(settlement.state))fail('STATE_CONFLICT','The settlement is '+settlement.state+'.');
 const live=(await tx.query("select id from lara.payment_orders where tenant_id=$1 and settlement_id=$2 and state not in ('cancelled','failed')",[ctx.tenantId,settlement.id])).rows[0];
 if(live)fail('STATE_CONFLICT','Payment '+live.id+' already covers this settlement.');
 const row=(await tx.query('insert into lara.payment_orders(tenant_id,entity_id,settlement_id,beneficiary_version_id,scheduled_date,reason,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[ctx.tenantId,entityId,input.settlementId,input.beneficiaryVersionId,input.scheduledDate,input.reason?.trim()||null,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment.create',resourceType:'payment',resourceId:row.id,resourceVersion:1,afterRef:contentHash({settlementId:input.settlementId,beneficiaryVersionId:input.beneficiaryVersionId,scheduledDate:input.scheduledDate})});
 return paymentResource(row);
}
export async function updatePayment(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'payment.edit');requireEntity(ctx,entityId);assertInput('PaymentCreate',input);
 const row=await loadPayment(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(!['draft','submitted'].includes(row.state))fail('STATE_CONFLICT','Payment is '+row.state+'; only drafts and submitted payments change.');
 await paymentRefs(tx,ctx,entityId,input);
 const material=row.settlement_id!==input.settlementId||row.beneficiary_version_id!==input.beneficiaryVersionId||iso(row.scheduled_date)!==input.scheduledDate;
 if(material&&row.state!=='draft')await tx.query("update lara.payment_orders set state='draft',submitted_by=null where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 const updated=(await tx.query('update lara.payment_orders set settlement_id=$3,beneficiary_version_id=$4,scheduled_date=$5,reason=$6,content_version=content_version+$7 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.settlementId,input.beneficiaryVersionId,input.scheduledDate,input.reason?.trim()||null,material?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment.edit',resourceType:'payment',resourceId:id,resourceVersion:Number(updated.version)});
 return paymentResource(updated);
}
export async function submitPayment(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'payment.submit');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadPayment(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Payment is '+row.state+'.');
 const settlement=await loadSettlement(tx,ctx,entityId,row.settlement_id,{lock:false});
 if(settlement.state!=='submitted')fail('STATE_CONFLICT','The settlement proposal must be submitted before the payment asks for authority.');
 const updated=(await tx.query("update lara.payment_orders set state='submitted',submitted_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment.submit',resourceType:'payment',resourceId:id,resourceVersion:Number(updated.version)});
 return presult(updated);
}
// Authority is independent of everyone who prepared or submitted the
// proposal and the payment, binds the proposal's content version and the
// beneficiary version, and approves the settlement in the same transaction.
export async function authorizePayment(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'payment.authorize');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadPayment(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='submitted')fail('STATE_CONFLICT','Only submitted payments are authorized.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The payment changed since review.',{resourceVersion:Number(row.version)});
 const settlement=await loadSettlement(tx,ctx,entityId,row.settlement_id);
 if([row.created_by,row.submitted_by,settlement.created_by,settlement.submitted_by].includes(ctx.principalId))fail('SELF_APPROVAL','Payment authority is independent of whoever prepared or submitted the proposal and the payment.');
 if(input.decision==='reject'){
  if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
  const back=(await tx.query("update lara.payment_orders set state='draft',submitted_by=null where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];
  await audit(tx,ctx,{entityId,action:'payment.reject',resourceType:'payment',resourceId:id,resourceVersion:Number(back.version),reason:input.reason});
  return presult(back);
 }
 if(settlement.state!=='submitted')fail('STATE_CONFLICT','The settlement proposal is '+settlement.state+'; it must be submitted.');
 const beneficiary=(await tx.query('select status from lara.beneficiary_versions where tenant_id=$1 and id=$2',[ctx.tenantId,row.beneficiary_version_id])).rows[0];
 if(beneficiary.status!=='approved')fail('STATE_CONFLICT','The beneficiary version is '+beneficiary.status+'.');
 await tx.query("update lara.settlements set state='approved',approved_by=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,settlement.id,ctx.principalId]);
 const updated=(await tx.query("update lara.payment_orders set state='authorized',authorized_by=$3,authorized_settlement_version=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId,settlement.content_version])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment.authorize',resourceType:'payment',resourceId:id,resourceVersion:Number(updated.version),afterRef:settlement.payload_hash,reason:input.reason||null});
 return presult(updated);
}
// Release records that money was sent outside the system: the authority must
// still hold (same proposal content, same approved beneficiary), the channel
// is manual in this release, and evidence is mandatory. Nothing posts yet.
export async function releasePayment(tx,ctx,entityId,id,input,expectedVersion,{bankFile=null,store=null}={}){
 requirePermission(ctx,'payment.release');requireEntity(ctx,entityId);assertInput('PaymentRelease',input);
 const row=await loadPayment(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='authorized')fail('STATE_CONFLICT','Payment is '+row.state+'; only authorized payments are released.');
 if(input.channel==='qualified_api')fail('FEATURE_NOT_ENABLED','Direct bank API release is disabled unless separately contracted and tested; record a manual or bank-file release.');
 if(input.channel==='bank_file'&&(!bankFile||!store))fail('FEATURE_NOT_ENABLED','Bank-file releases arrive with treasury (P06); record the manual release.');
 const settlement=await loadSettlement(tx,ctx,entityId,row.settlement_id);
 const beneficiary=(await tx.query('select * from lara.beneficiary_versions where tenant_id=$1 and id=$2',[ctx.tenantId,row.beneficiary_version_id])).rows[0];
 // Changes to the proposal or the beneficiary already withdrew the authority; this recheck refuses a release that raced them.
 if(Number(settlement.content_version)!==Number(row.authorized_settlement_version)||settlement.state!=='approved'||beneficiary.status!=='approved')fail('STATE_CONFLICT','The authority no longer holds: the proposal or the beneficiary changed after authorization; submit and authorize the payment again.');
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'payment',id,Number(row.version)+1);
 // A bank-file release generates one locked, hashed file for this payment and stores it as restricted evidence; the file is the release reference.
 const file=input.channel==='bank_file'?await bankFile(tx,ctx,entityId,{order:row,settlement,beneficiary,store}):null;
 const reference=file?file.reference:input.externalReference.trim();
 const evidenceIds=[...new Set([...input.evidenceIds,...(file?[file.evidenceId]:[])])].sort();
 const updated=(await tx.query("update lara.payment_orders set state='released',release_channel=$3,release_reference=$4,release_evidence_ids=$5,released_by=$6,released_at=now() where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.channel,reference,JSON.stringify(evidenceIds),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment.release',resourceType:'payment',resourceId:id,resourceVersion:Number(updated.version),afterRef:reference,reason:file?'bank file run '+file.runId:null});
 return presult(updated,{...(file?{bankFileRunId:file.runId}:{})});
}
// Settlement is the financial effect: Dr payable (or employee advance),
// Cr cash and withholding payable, allocations applied, payment-time
// withholding recognized once per bill share, advance issued for employees.
export async function settlePayment(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'payment.settle');requireEntity(ctx,entityId);assertInput('SettlementEvidence',input);
 const row=await loadPayment(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 const settlementRow=await loadSettlement(tx,ctx,entityId,row.settlement_id);
 if(row.state==='settled')return presult(row,{journalEntryIds:[settlementRow.posted_entry_id]});
 if(row.state!=='released')fail('STATE_CONFLICT','Payment is '+row.state+'; only released payments settle.');
 if(settlementRow.state!=='approved')fail('STATE_CONFLICT','The settlement proposal is '+settlementRow.state+'.');
 const profile=await purchasingProfile(tx,ctx,entityId);
 const allocations=settlementRow.allocation_intents||[];
 const {advance,expected}=await validatePayment(tx,ctx,entityId,{direction:'payment',partyId:settlementRow.party_id,currency:settlementRow.currency,grossAmount:String(settlementRow.gross_amount),cashAmount:String(settlementRow.cash_amount),withholdingAmount:String(settlementRow.withholding_amount),allocations:allocations.map(a=>({openItemId:a.openItemId,amount:a.amount}))},profile);
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'payment',id,Number(row.version)+1);
 const branch=(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and status='active' order by created_at limit 1",[ctx.tenantId,entityId])).rows[0];
 const party=(await tx.query('select legal_name from lara.party where tenant_id=$1 and id=$2',[ctx.tenantId,settlementRow.party_id])).rows[0];
 const gross=micros(String(settlementRow.gross_amount)),cash=micros(String(settlementRow.cash_amount)),wht=micros(String(settlementRow.withholding_amount));
 let lines=[{accountId:advance?profile.advanceAccountId:profile.apAccountId,branchId:branch.id,dimensions:{},debit:decimal(gross,6),credit:'0'},{accountId:profile.cashAccountId,branchId:branch.id,dimensions:{},debit:'0',credit:decimal(cash,6)}];
 if(wht>0n)lines.push({accountId:profile.withholdingPayableAccountId,branchId:branch.id,dimensions:{},debit:'0',credit:decimal(wht,6)});
 // A foreign-currency payment settles at the approved rate of its value date; the layers give the consumed carrying value and the realized FX (P09).
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,settlementRow.book_id])).rows[0];
 const fxRate=settlementRow.currency!==book.functional_currency?await fx.rateFor(tx,ctx,entityId,{base:settlementRow.currency,quote:book.functional_currency,onDate:input.valueDate}):null;
 if(fxRate){if(advance)fail('FEATURE_NOT_ENABLED','Foreign-currency employee advances are not supported.');if(wht>0n)fail('FEATURE_NOT_ENABLED','Withholding on foreign-currency payments is not supported.');const allocated=allocations.reduce((t,a)=>t+micros(String(a.amount)),0n);if(allocated!==gross)fail('STATE_CONFLICT','A foreign-currency payment allocates its full amount so the realized FX is known.');lines=fx.translateLines(lines,fxRate.rate,{controlAccountId:profile.apAccountId});}
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:settlementRow.book_id,sourceType:'settlement',sourceId:settlementRow.id,sourceVersion:Number(settlementRow.content_version),purpose:'posting',accountingDate:input.valueDate,documentDate:input.valueDate,description:(advance?'Advance to ':'Payment to ')+party.legal_name+' '+input.externalReference.trim(),currency:settlementRow.currency,manual:false,postingActor:ctx.principalId,commandId,...(fxRate?fx.postingFx(fxRate):{}),lines})])).rows[0].id;
 const posted=(await tx.query("update lara.settlements set state='posted',posted_entry_id=$3,value_date=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,settlementRow.id,entryId,input.valueDate])).rows[0];
 await applyAllocations(tx,ctx,entityId,settlementRow.id,allocations,{commandId});
 const fxEntries=[];
 if(fxRate){const s=await fx.settleLayers(tx,ctx,entityId,{settlementId:settlementRow.id,allocations,rate:fxRate,side:'AP'});const fxEntry=await fx.postRealized(tx,ctx,entityId,{bookId:settlementRow.book_id,sourceType:'settlement_fx',sourceId:settlementRow.id,sourceVersion:Number(settlementRow.content_version),accountingDate:input.valueDate,description:'Payment to '+party.legal_name,controlAccountId:profile.apAccountId,branchId:branch.id,side:'AP',cashFunc:fx.controlFunc(lines,profile.apAccountId),consumed:s.consumed,commandId});if(fxEntry)fxEntries.push(fxEntry);}
 for(const s of expected.shares)if(s.amount>0n)await tx.query("insert into lara.tax_events(tenant_id,entity_id,document_id,line_id,tax_rule_version_id,tax_point,recognition,basis,amount,recognition_entry_id) values($1,$2,$3,null,$4,$5,'payment',$6,$7,$8)",[ctx.tenantId,entityId,s.documentId,s.ruleVersionId,input.valueDate,decimal(s.basis,6),decimal(s.amount,6),entryId]);
 if(advance)await tx.query('insert into lara.advances(tenant_id,entity_id,party_id,settlement_id,amount,currency,created_by) values($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,entityId,settlementRow.party_id,settlementRow.id,decimal(gross,6),settlementRow.currency,ctx.principalId]);
 const updated=(await tx.query("update lara.payment_orders set state='settled',settle_reference=$3,settled_at=$4,settle_value_date=$5,settle_evidence_ids=$6,settled_by=$7 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.externalReference.trim(),input.settledAt,input.valueDate,JSON.stringify([...input.evidenceIds].sort()),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment.settle',resourceType:'payment',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'settlement',aggregateId:settlementRow.id,aggregateVersion:Number(posted.version),eventType:'settlement.posted.v1',payload:{settlementId:settlementRow.id,paymentId:id,journalEntryId:entryId,payloadHash:settlementRow.payload_hash}});
 return presult(updated,{journalEntryIds:[entryId,...fxEntries]});
}
// A returned payment mirrors the settlement entry, unwinds allocations and
// reverses the withholding recognized at settlement; the payment and the
// settlement stay as immutable facts in their terminal states.
export async function returnPayment(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'payment.return');requireEntity(ctx,entityId);assertInput('Reversal',input);
 const row=await loadPayment(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='settled')fail('STATE_CONFLICT','Payment is '+row.state+'; only settled payments are returned.');
 const settlement=await loadSettlement(tx,ctx,entityId,row.settlement_id);
 if((await tx.query('select 1 from lara.advances where tenant_id=$1 and settlement_id=$2',[ctx.tenantId,settlement.id])).rowCount)fail('STATE_CONFLICT','An issued employee advance is returned as a receipt from the employee, not by returning the payment.');
 if(input.evidenceIds?.length)await linkEvidence(tx,ctx,entityId,input.evidenceIds,'payment',id,Number(row.version)+1);
 const entry=(await tx.query('select * from lara.journal_entries where tenant_id=$1 and id=$2',[ctx.tenantId,settlement.posted_entry_id])).rows[0];
 const lines=(await tx.query('select * from lara.journal_lines where tenant_id=$1 and entry_id=$2 order by line_no',[ctx.tenantId,settlement.posted_entry_id])).rows;
 const fxEntry=entry.transaction_currency!==entry.functional_currency;
 const reversalId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:settlement.book_id,sourceType:'settlement',sourceId:settlement.id,sourceVersion:Number(settlement.content_version),purpose:'reversal',accountingDate:input.accountingDate,documentDate:input.accountingDate,description:'Returned: '+entry.description+' — '+input.reason,currency:settlement.currency,manual:false,postingActor:ctx.principalId,commandId,reversalOf:settlement.posted_entry_id,...(fxEntry?{rate:String(entry.fx_rate),rateId:entry.fx_rate_id}:{}),lines:lines.map(l=>({accountId:l.account_id,branchId:l.branch_id,dimensions:l.dimensions_json||{},debit:String(l.txn_credit),credit:String(l.txn_debit),...(fxEntry?{funcDebit:String(l.func_credit),funcCredit:String(l.func_debit)}:{})}))})])).rows[0].id;
 const fxAdjust=fxEntry?(await tx.query("select * from lara.journal_entries where tenant_id=$1 and source_type='settlement_fx' and source_id=$2 and purpose='adjustment' and reversal_of is null",[ctx.tenantId,settlement.id])).rows[0]:null;
 if(fxAdjust){const al=(await tx.query('select * from lara.journal_lines where tenant_id=$1 and entry_id=$2 order by line_no',[ctx.tenantId,fxAdjust.id])).rows;await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:settlement.book_id,sourceType:'settlement_fx',sourceId:settlement.id,sourceVersion:Number(settlement.content_version),purpose:'reversal',reversalOf:fxAdjust.id,accountingDate:input.accountingDate,documentDate:input.accountingDate,description:'Reversal: '+fxAdjust.description,currency:entry.functional_currency,manual:false,postingActor:ctx.principalId,commandId,lines:al.map(l=>({accountId:l.account_id,branchId:l.branch_id,dimensions:l.dimensions_json||{},debit:String(l.func_credit),credit:String(l.func_debit)}))})]);}
 if(fxEntry)await fx.reverseLayers(tx,ctx,entityId,{settlementId:settlement.id});
 const applies=(await tx.query("select a.* from lara.allocation_events a where a.tenant_id=$1 and a.settlement_id=$2 and a.action='apply' and not exists (select 1 from lara.allocation_events r where r.tenant_id=a.tenant_id and r.reverses_id=a.id)",[ctx.tenantId,settlement.id])).rows;
 for(const a of applies){await tx.query("insert into lara.allocation_events(tenant_id,entity_id,settlement_id,open_item_id,amount,action,reverses_id,reason,created_by) values($1,$2,$3,$4,$5,'reverse',$6,$7,$8)",[ctx.tenantId,entityId,settlement.id,a.open_item_id,a.amount,a.id,'Payment returned: '+input.reason,ctx.principalId]);const item=(await tx.query('select document_id from lara.open_items where tenant_id=$1 and id=$2',[ctx.tenantId,a.open_item_id])).rows[0];await refreshSettlementState(tx,ctx,item.document_id);}
 const events=(await tx.query('select * from lara.tax_events where tenant_id=$1 and recognition_entry_id=$2 and reversed_by is null',[ctx.tenantId,settlement.posted_entry_id])).rows;
 for(const e of events){const mirror=(await tx.query("insert into lara.tax_events(tenant_id,entity_id,document_id,line_id,tax_rule_version_id,tax_point,recognition,basis,amount,recognition_entry_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id",[ctx.tenantId,entityId,e.document_id,e.line_id,e.tax_rule_version_id,input.accountingDate,e.recognition,e.basis,e.amount,reversalId])).rows[0].id;await tx.query('update lara.tax_events set reversed_by=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,e.id,mirror]);}
 await tx.query("update lara.settlements set state='reversed',reversal_entry_id=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,settlement.id,reversalId]);
 const updated=(await tx.query("update lara.payment_orders set state='returned' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:'payment.return',resourceType:'payment',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason,afterRef:reversalId});
 return presult(updated,{journalEntryIds:[reversalId]});
}
export async function getPayment(tx,ctx,entityId,id){requirePermission(ctx,'payment.read');requireEntity(ctx,entityId);return paymentResource(await loadPayment(tx,ctx,entityId,id,{lock:false}));}
export async function listPayments(tx,ctx,entityId,query){
 requirePermission(ctx,'payment.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';
 if(query?.state)where+=' and state=$'+params.push(String(query.state));
 if(query?.settlementId){if(!isUuid(query.settlementId))fail('VALIDATION_FAILED','settlementId must be a UUID.',{fieldErrors:[{path:'settlementId',message:'UUID'}]});where+=' and settlement_id=$'+params.push(query.settlementId);}
 const rows=(await tx.query('select * from lara.payment_orders where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,paymentResource,scope);
}
// Employee advances with their liquidations and returns.
export async function listAdvances(tx,ctx,entityId,{partyId=null}={}){
 requirePermission(ctx,'expense_claim.read');requireEntity(ctx,entityId);
 const params=[ctx.tenantId,entityId];const where=partyId?' and a.party_id=$'+params.push(partyId):'';
 const rows=(await tx.query('select a.*,lara.advance_used(a.tenant_id,a.id)::text as used from lara.advances a where a.tenant_id=$1 and a.entity_id=$2'+where+' order by a.created_at,a.id',params)).rows;
 return rows.map(a=>({id:a.id,partyId:a.party_id,settlementId:a.settlement_id,amount:money(a.amount),used:money(a.used),remaining:decimal(micros(String(a.amount))-micros(a.used)),currency:a.currency,state:a.status,createdAt:iso(a.created_at),version:Number(a.version)}));
}

// ---------------------------------------------------------------------------
// Withholding certificates: derived from tax events, reviewed, then issued
// ---------------------------------------------------------------------------
const OUTPUT_VERSION='wht-certificate-1';
const certificateResource=c=>({id:c.id,version:Number(c.version),state:c.status,partyId:c.party_id,periodKey:c.period_key,versionNumber:c.version_number,taxRuleVersionId:c.tax_rule_version_id,basisTotal:money(c.basis_total),taxTotal:money(c.tax_total),taxEventIds:c.tax_event_ids,outputVersion:c.output_version,checksum:c.checksum,reviewedBy:c.reviewed_by,evidenceId:c.evidence_id,createdAt:iso(c.created_at),updatedAt:iso(c.updated_at),simulation:false});
const periodRange=key=>{const m=/^(\d{4})(?:-(\d{2})|-Q([1-4]))?$/.exec(key||'');if(!m)fail('VALIDATION_FAILED','periodKey is YYYY, YYYY-MM or YYYY-Qn.',{fieldErrors:[{path:'periodKey',message:'Invalid'}]});const y=Number(m[1]);if(m[2]){const mo=Number(m[2]);if(mo<1||mo>12)fail('VALIDATION_FAILED','periodKey month is 01 to 12.',{fieldErrors:[{path:'periodKey',message:'Invalid month'}]});const end=new Date(Date.UTC(y,mo,0));return [key+'-01',end.toISOString().slice(0,10)];}if(m[3]){const q=Number(m[3]);const start=new Date(Date.UTC(y,(q-1)*3,1)),end=new Date(Date.UTC(y,q*3,0));return [start.toISOString().slice(0,10),end.toISOString().slice(0,10)];}return [y+'-01-01',y+'-12-31'];};
// Events counted on a certificate: withholding events of the rule for the
// supplier's bills with a tax point in the period, not reversed and not
// themselves reversals.
async function certificateEvents(tx,ctx,entityId,partyId,ruleVersionId,[from,to]){
 // Supplier credits carry their withholding as positive events on the credit note; they reduce the certificate.
 const rows=(await tx.query("select e.id,d.kind,e.basis::text as basis,e.amount::text as amount from lara.tax_events e join lara.documents d on d.tenant_id=e.tenant_id and d.id=e.document_id where e.tenant_id=$1 and e.entity_id=$2 and d.party_id=$3 and e.tax_rule_version_id=$4 and e.line_id is null and e.tax_point between $5::date and $6::date and e.reversed_by is null and not exists (select 1 from lara.tax_events o where o.tenant_id=e.tenant_id and o.reversed_by=e.id) order by e.tax_point,e.created_at,e.id",[ctx.tenantId,entityId,partyId,ruleVersionId,from,to])).rows;
 return rows.map(r=>({id:r.id,sign:r.kind==='credit_note'?-1n:1n,basis:micros(r.basis),amount:micros(r.amount)}));
}
export async function prepareCertificate(tx,ctx,entityId,{partyId,periodKey,taxRuleVersionId}){
 requirePermission(ctx,'bill.correct');requireEntity(ctx,entityId);await requirePurchasing(tx,ctx,entityId);
 await partyWithRole(tx,ctx,entityId,partyId,'supplier');
 if(!isUuid(taxRuleVersionId))fail('VALIDATION_FAILED','taxRuleVersionId must be a UUID.',{fieldErrors:[{path:'taxRuleVersionId',message:'UUID'}]});
 const rule=(await tx.query("select * from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and id=$3 and tax_type='withholding'",[ctx.tenantId,entityId,taxRuleVersionId])).rows[0];
 if(!rule)fail('NOT_FOUND','Withholding rule version not found.');
 const range=periodRange(periodKey);
 const events=await certificateEvents(tx,ctx,entityId,partyId,taxRuleVersionId,range);
 if(!events.length)fail('STATE_CONFLICT','No withholding was recognized for this supplier, rule and period.');
 const basis=events.reduce((t,e)=>t+e.sign*e.basis,0n),tax=events.reduce((t,e)=>t+e.sign*e.amount,0n);
 if(basis<0n||tax<0n)fail('STATE_CONFLICT','Credits exceed the withholding recognized in this period; the certificate cannot be negative.');
 const ids=events.map(e=>e.id).sort();
 const checksum=contentHash({partyId,periodKey,taxRuleVersionId,ruleCode:rule.code,rate:String(rule.rate),events:ids,basis:decimal(basis),tax:decimal(tax),outputVersion:OUTPUT_VERSION});
 const next=((await tx.query('select coalesce(max(version_number),0)::int v from lara.withholding_certificates where tenant_id=$1 and entity_id=$2 and party_id=$3 and period_key=$4 and tax_rule_version_id=$5',[ctx.tenantId,entityId,partyId,periodKey,taxRuleVersionId])).rows[0].v)+1;
 const same=(await tx.query("select id from lara.withholding_certificates where tenant_id=$1 and entity_id=$2 and party_id=$3 and period_key=$4 and tax_rule_version_id=$5 and checksum=$6 and status<>'superseded'",[ctx.tenantId,entityId,partyId,periodKey,taxRuleVersionId,checksum])).rows[0];
 if(same)fail('STATE_CONFLICT','Certificate '+same.id+' already covers exactly these events.');
 const row=(await tx.query('insert into lara.withholding_certificates(tenant_id,entity_id,party_id,period_key,version_number,tax_rule_version_id,basis_total,tax_total,tax_event_ids,output_version,checksum,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[ctx.tenantId,entityId,partyId,periodKey,next,taxRuleVersionId,decimal(basis,6),decimal(tax,6),JSON.stringify(ids),OUTPUT_VERSION,checksum,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'withholding_certificate.prepare',resourceType:'withholding_certificate',resourceId:row.id,resourceVersion:1,afterRef:checksum});
 return certificateResource(row);
}
async function loadCertificate(tx,ctx,entityId,id){const row=(await tx.query('select * from lara.withholding_certificates where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Certificate not found.');return row;}
export async function reviewCertificate(tx,ctx,entityId,id,{decision='approve',reason=null}={}){
 requirePermission(ctx,'bill.approve');requireEntity(ctx,entityId);
 const row=await loadCertificate(tx,ctx,entityId,id);
 if(row.status!=='draft'&&!(row.status==='reviewed'&&decision==='reject'))fail('STATE_CONFLICT','Certificate is '+row.status+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot review the certificate.');
 if(decision==='reject'){if(!reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});}
 const status=decision==='reject'?'draft':'reviewed';
 const updated=(await tx.query('update lara.withholding_certificates set status=$3,reviewed_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,status,decision==='reject'?null:ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'withholding_certificate.'+(decision==='reject'?'reject':'review'),resourceType:'withholding_certificate',resourceId:id,resourceVersion:Number(updated.version),reason,afterRef:row.checksum});
 return certificateResource(updated);
}
export async function issueCertificate(tx,ctx,entityId,id,{evidenceId=null}={}){
 requirePermission(ctx,'bill.approve');requireEntity(ctx,entityId);
 const row=await loadCertificate(tx,ctx,entityId,id);
 if(row.status!=='reviewed')fail('STATE_CONFLICT','Only reviewed certificates are issued.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot issue the certificate.');
 if(evidenceId)await linkEvidence(tx,ctx,entityId,[evidenceId],'withholding_certificate',id,Number(row.version)+1);
 await tx.query("update lara.withholding_certificates set status='superseded' where tenant_id=$1 and entity_id=$2 and party_id=$3 and period_key=$4 and tax_rule_version_id=$5 and status='issued' and id<>$6",[ctx.tenantId,entityId,row.party_id,row.period_key,row.tax_rule_version_id,id]);
 const updated=(await tx.query("update lara.withholding_certificates set status='issued',evidence_id=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,evidenceId])).rows[0];
 await audit(tx,ctx,{entityId,action:'withholding_certificate.issue',resourceType:'withholding_certificate',resourceId:id,resourceVersion:Number(updated.version),afterRef:row.checksum});
 return certificateResource(updated);
}
export async function listCertificates(tx,ctx,entityId,{partyId=null}={}){
 requirePermission(ctx,'bill.read');requireEntity(ctx,entityId);
 const params=[ctx.tenantId,entityId];const where=partyId?' and party_id=$'+params.push(partyId):'';
 return (await tx.query('select * from lara.withholding_certificates where tenant_id=$1 and entity_id=$2'+where+' order by party_id,period_key,version_number',params)).rows.map(certificateResource);
}
