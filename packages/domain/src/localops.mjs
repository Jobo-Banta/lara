// Local operations feature releases (P17), each behind its own capability
// and profile. P17A leases: lessor billing at the escalated rent from the
// contract's steps, deposits and advances held as liabilities until another
// principal approves their application (a non-cash settlement of the rent
// invoice, never revenue again) or refund. P17B statutory discounts:
// eligibility per party and category on identity evidence with expiry,
// approved by another principal; the approved profile's golden cases decide
// the discount and exemption per eligible line of a draft invoice, other
// lines untouched. P17C marketplace and POS: payout batches whose gross
// less fees, withholding and other deductions must equal the net, reconciled
// to the sales already imported before they post once; POS closings per
// machine and shift matched to a posted deposit. P17D payroll data: imported
// batches whose records tie to the totals, restricted individual records
// with masked identifiers, a journal per the approved payroll profile once
// per source and period, remittances per agency on evidence. P17E local
// obligations from the reviewed authority profile, complete only on payment
// evidence and, where required, filing evidence. Nothing here calculates
// payroll or files with a government office.
import {createHash} from 'node:crypto';
import {assertInput,audit,canonical,contentHash,cursorClause,cursorScope,emit,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {micros,signedMicros,decimal} from './ledger.mjs';
import {rateScaled,convert} from './fx.mjs';
import * as sales from './sales.mjs';
import {linkEvidence} from './evidence.mjs';
import {encryptField} from './parties.mjs';

const sha=v=>createHash('sha256').update(String(v)).digest('hex');
const money=v=>decimal(micros(String(v)),2);
const CAP={leases:'leases',discounts:'statutory_discounts',channels:'marketplace_pos',payroll:'payroll_data',local:'local_obligations'};
async function requireCapability(tx,ctx,entityId,code,label){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability=$3 and status='active'",[ctx.tenantId,entityId,code])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The '+label+' feature is not active for this entity.');
}
async function approvedProfile(tx,ctx,entityId,kind,label){
 const row=(await tx.query("select payload,version_number from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind=$3 and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId,kind])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved '+label+' profile is required.');
 return row.payload;
}
async function primaryBook(tx,ctx,entityId){return (await tx.query("select * from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary' and status<>'archived'",[ctx.tenantId,entityId])).rows[0];}
async function firstBranch(tx,ctx,entityId){return (await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and status<>'archived' order by created_at limit 1",[ctx.tenantId,entityId])).rows[0];}
const postEntry=async(tx,ctx,entityId,{bookId,sourceType,sourceId,sourceVersion=1,date,description,currency,lines,commandId=null})=>(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId,sourceType,sourceId,sourceVersion,purpose:'posting',accountingDate:date,documentDate:date,description,currency,manual:false,postingActor:ctx.principalId,commandId,lines})])).rows[0].id;
const jl=(accountId,branchId,debit,credit)=>({accountId,branchId,dimensions:{},debit:decimal(debit,6),credit:decimal(credit,6)});
function decide(row,ctx,input,label){
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who recorded the '+label+' cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The '+label+' changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 return input.decision==='approve';
}

// ---------------------------------------------------------------------------
// P17A leases
// ---------------------------------------------------------------------------
const leaseResource=r=>resource({...r,status:r.state},{partyId:r.party_id,startDate:iso(r.start_date),endDate:iso(r.end_date),currency:r.currency,deposit:money(r.deposit),advance:money(r.advance),billingScheduleId:r.billing_schedule_id,withholdingProfileVersion:r.withholding_profile_version,evidenceIds:r.evidence_ids,escalation:r.escalation_json,baseRent:money(r.base_rent)});
const leaseMaterial=i=>({partyId:i.partyId,startDate:i.startDate,endDate:i.endDate,currency:i.currency,deposit:money(i.deposit),advance:money(i.advance),billingScheduleId:i.billingScheduleId,withholdingProfileVersion:i.withholdingProfileVersion,escalation:(i.escalation||[]).map(e=>({effectiveFrom:e.effectiveFrom,rate:e.rate})),evidenceIds:[...i.evidenceIds].sort()});
// The rent for each month of the term: the base rent compounded by every
// escalation step effective on or before the month start.
export function leaseSchedule({baseRent,startDate,endDate,escalation=[]}){
 const steps=[...escalation].sort((a,b)=>a.effectiveFrom<b.effectiveFrom?-1:1);
 const out=[];let base=micros(String(baseRent));
 const first=new Date(startDate+'T00:00:00Z');const last=new Date(endDate+'T00:00:00Z');
 for(let d=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),1));d<=last;d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1))){
  const ps=d.toISOString().slice(0,10),pe=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).toISOString().slice(0,10);
  let rent=base,rate='0';
  for(const s of steps)if(s.effectiveFrom<=ps){rent=convert(rent,rateScaled('1')+rateScaled(s.rate),2);rate=s.rate;}
  out.push({periodStart:ps,periodEnd:pe,rent:decimal(rent,2),rate});
 }
 return {lines:out,total:decimal(out.reduce((s,l)=>s+micros(l.rent),0n),2)};
}
async function validateLease(tx,ctx,entityId,input){
 if(input.endDate<=input.startDate)fail('VALIDATION_FAILED','endDate is after startDate.',{fieldErrors:[{path:'endDate',message:'After start'}]});
 if(!(await tx.query("select 1 from lara.party_roles where tenant_id=$1 and entity_id=$2 and party_id=$3 and role='customer'",[ctx.tenantId,entityId,input.partyId])).rowCount)fail('NOT_FOUND','Lessee not found as a customer.');
 const schedule=(await tx.query("select * from lara.recognition_schedules where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,input.billingScheduleId])).rows[0];
 if(!schedule||schedule.kind!=='recurring_invoice')fail('NOT_FOUND','Billing schedule not found; a lease bills on a recurring invoice schedule.');
 if(schedule.currency!==input.currency)fail('VALIDATION_FAILED','The schedule is in '+schedule.currency+'.',{fieldErrors:[{path:'currency',message:schedule.currency}]});
 for(const [i,e] of (input.escalation||[]).entries()){if(rateScaled(e.rate)<0n)fail('VALIDATION_FAILED','Escalation rates are non-negative.',{fieldErrors:[{path:'escalation['+i+'].rate',message:'Non-negative'}]});if(e.effectiveFrom<=input.startDate||e.effectiveFrom>input.endDate)fail('VALIDATION_FAILED','Escalation steps fall inside the term after its start.',{fieldErrors:[{path:'escalation['+i+'].effectiveFrom',message:'Inside the term'}]});}
 const wht=(await tx.query("select 1 from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='lease_withholding_profile' and status='approved' and payload->>'profileVersion'=$3",[ctx.tenantId,entityId,input.withholdingProfileVersion])).rowCount;
 if(!wht)fail('RULE_PROFILE_NOT_APPROVED','Withholding profile version '+input.withholdingProfileVersion+' is not approved for leases.');
 return schedule;
}
export async function createLease(tx,ctx,entityId,input){
 requirePermission(ctx,'lease.create');requireEntity(ctx,entityId);assertInput('LeaseCreate',input);await requireCapability(tx,ctx,entityId,CAP.leases,'lease billing');
 const schedule=await validateLease(tx,ctx,entityId,input);
 const hash=contentHash(leaseMaterial(input));
 const row=(await tx.query('insert into lara.lease_contracts(tenant_id,entity_id,party_id,start_date,end_date,currency,deposit,advance,billing_schedule_id,withholding_profile_version,escalation_json,base_rent,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *',[ctx.tenantId,entityId,input.partyId,input.startDate,input.endDate,input.currency,money(input.deposit),money(input.advance),input.billingScheduleId,input.withholdingProfileVersion,JSON.stringify(input.escalation||[]),String(schedule.basis_amount),JSON.stringify(input.evidenceIds),hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'lease_contract',row.id,1);
 await audit(tx,ctx,{entityId,action:'lease.create',resourceType:'lease_contract',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return leaseResource(row);
}
async function loadLease(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Lease not found.');
 const row=(await tx.query('select * from lara.lease_contracts where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Lease not found.');return row;
}
export async function updateLease(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'lease.edit');requireEntity(ctx,entityId);assertInput('LeaseCreate',input);
 const row=await loadLease(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','An approved lease keeps its terms; an amendment is a new lease.');
 const schedule=await validateLease(tx,ctx,entityId,input);
 const hash=contentHash(leaseMaterial(input));
 const updated=(await tx.query('update lara.lease_contracts set party_id=$4,start_date=$5,end_date=$6,currency=$7,deposit=$8,advance=$9,billing_schedule_id=$10,withholding_profile_version=$11,escalation_json=$12,base_rent=$13,evidence_ids=$14,content_hash=$15,content_version=content_version+1 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,input.partyId,input.startDate,input.endDate,input.currency,money(input.deposit),money(input.advance),input.billingScheduleId,input.withholdingProfileVersion,JSON.stringify(input.escalation||[]),String(schedule.basis_amount),JSON.stringify(input.evidenceIds),hash])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'lease_contract',id,Number(updated.version));
 await audit(tx,ctx,{entityId,action:'lease.edit',resourceType:'lease_contract',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return leaseResource(updated);
}
export async function getLease(tx,ctx,entityId,id){requirePermission(ctx,'lease.read');requireEntity(ctx,entityId);return leaseResource(await loadLease(tx,ctx,entityId,id));}
export async function listLeases(tx,ctx,entityId,query){
 requirePermission(ctx,'lease.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.lease_contracts where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,leaseResource,scope);
}
export async function approveLease(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'lease.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadLease(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Lease is '+row.state+'.');
 const ok=decide(row,ctx,input,'lease');
 const updated=(await tx.query('update lara.lease_contracts set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,ok?'approved':'rejected',ok?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'lease.'+(ok?'approve':'reject'),resourceType:'lease_contract',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'lease_contract',resourceId:id,version:Number(updated.version),state:updated.state};
}
async function leaseHeld(tx,ctx,leaseId){
 const r=(await tx.query("select kind,coalesce(sum(amount),0)::text as a from lara.lease_events where tenant_id=$1 and lease_id=$2 group by kind",[ctx.tenantId,leaseId])).rows;
 const of=k=>micros(r.find(x=>x.kind===k)?.a||'0');
 return {deposit:of('deposit_received')-of('deposit_applied')-of('deposit_refunded'),advance:of('advance_received')-of('advance_applied')};
}
export async function leaseScheduleFor(tx,ctx,entityId,id){
 requirePermission(ctx,'lease.read');requireEntity(ctx,entityId);
 const row=await loadLease(tx,ctx,entityId,id);
 const s=leaseSchedule({baseRent:String(row.base_rent),startDate:iso(row.start_date),endDate:iso(row.end_date),escalation:row.escalation_json});
 const billed=(await tx.query("select reason from lara.lease_events where tenant_id=$1 and lease_id=$2 and kind='rent_billed'",[ctx.tenantId,id])).rows.map(r=>r.reason);
 const held=await leaseHeld(tx,ctx,id);
 return {leaseId:id,currency:row.currency,lines:s.lines.map(l=>({...l,billed:billed.includes(l.periodStart)})),total:s.total,deposit:money(row.deposit),depositHeld:decimal(held.deposit,2),advance:money(row.advance),advanceHeld:decimal(held.advance,2)};
}
const leaseProfile=(tx,ctx,entityId)=>approvedProfile(tx,ctx,entityId,'lease_profile','lease (deposit liability, advance liability and cash accounts)');
// Rent billing for one schedule month at the escalated rent, from the
// schedule's template invoice; billed once per period.
export async function billLease(tx,ctx,entityId,id,input,{commandId=null}={}){
 requirePermission(ctx,'lease.edit');requireEntity(ctx,entityId);assertInput('LeaseBilling',input);
 const row=await loadLease(tx,ctx,entityId,id,{lock:true});
 if(row.state!=='approved')fail('STATE_CONFLICT','Only approved leases bill.');
 const s=leaseSchedule({baseRent:String(row.base_rent),startDate:iso(row.start_date),endDate:iso(row.end_date),escalation:row.escalation_json});
 const line=s.lines.find(l=>l.periodStart===input.periodStart&&l.periodEnd===input.periodEnd);
 if(!line)fail('VALIDATION_FAILED','The period is not a schedule month of the lease.',{fieldErrors:[{path:'periodStart',message:'Not on the schedule'}]});
 if((await tx.query("select 1 from lara.lease_events where tenant_id=$1 and lease_id=$2 and kind='rent_billed' and reason=$3",[ctx.tenantId,id,input.periodStart])).rowCount)fail('STATE_CONFLICT','This period is already billed.');
 const schedule=(await tx.query('select * from lara.recognition_schedules where tenant_id=$1 and id=$2',[ctx.tenantId,row.billing_schedule_id])).rows[0];
 const template=(await tx.query('select * from lara.documents where tenant_id=$1 and id=$2',[ctx.tenantId,schedule.source_id])).rows[0];
 const tl=(await tx.query('select * from lara.document_lines where tenant_id=$1 and document_id=$2 order by line_no limit 1',[ctx.tenantId,template.id])).rows[0];
 const actor={...ctx,permissions:new Set([...ctx.permissions,'invoice.prepare'])};
 const invoice=await sales.createDocument(tx,actor,entityId,{kind:'invoice',branchId:template.branch_id,bookId:template.book_id,partyId:row.party_id,documentDate:input.accountingDate,accountingDate:input.accountingDate,currency:row.currency,ruleProfileVersion:template.rule_profile_version,externalReference:'Lease '+id.slice(0,8)+' '+input.periodStart.slice(0,7),lines:[{description:'Rent '+input.periodStart+' to '+input.periodEnd+(line.rate!=='0'?' (escalated '+line.rate+')':''),quantity:'1',unitPrice:line.rent,discount:'0',priceBasis:'exclusive',accountId:tl.account_id,...(tl.tax_code_id?{taxCodeId:tl.tax_code_id}:{}),dimensions:{}}],evidenceIds:input.evidenceIds||[]});
 await tx.query("insert into lara.lease_events(tenant_id,entity_id,lease_id,kind,amount,event_date,document_id,reason,created_by) values($1,$2,$3,'rent_billed',$4,$5,$6,$7,$8)",[ctx.tenantId,entityId,id,line.rent,input.accountingDate,invoice.id,input.periodStart,ctx.principalId]);
 await audit(tx,ctx,{entityId,action:'lease.bill',resourceType:'lease_contract',resourceId:id,resourceVersion:Number(row.version),afterRef:invoice.id,reason:input.periodStart});
 return {resourceType:'document',resourceId:invoice.id,version:invoice.version,state:invoice.state};
}
// Deposits and advances: received into a liability, applied against a
// posted rent invoice as a non-cash settlement (approved by another
// principal), or refunded. Revenue is recognized by the invoice alone.
export async function leaseEvent(tx,ctx,entityId,id,input,{commandId=null}={}){
 requirePermission(ctx,'lease.edit');requireEntity(ctx,entityId);assertInput('LeaseEventCreate',input);
 const row=await loadLease(tx,ctx,entityId,id,{lock:true});
 if(row.state!=='approved')fail('STATE_CONFLICT','Only approved leases take deposits and advances.');
 const profile=await leaseProfile(tx,ctx,entityId);
 for(const k of ['depositLiabilityAccountId','advanceLiabilityAccountId','cashAccountId'])if(!isUuid(profile[k]))fail('RULE_PROFILE_NOT_APPROVED','The lease profile lacks '+k+'.');
 const amount=micros(input.amount);if(amount<=0n)fail('VALIDATION_FAILED','Amounts are positive.',{fieldErrors:[{path:'amount',message:'Positive'}]});
 const held=await leaseHeld(tx,ctx,id);
 const book=await primaryBook(tx,ctx,entityId),branch=await firstBranch(tx,ctx,entityId);
 const isDeposit=input.kind.startsWith('deposit');const liability=isDeposit?profile.depositLiabilityAccountId:profile.advanceLiabilityAccountId;
 let entryId=null,settlementId=null,approvedBy=null;
 if(input.kind==='deposit_received'||input.kind==='advance_received'){
  const cap=micros(String(isDeposit?row.deposit:row.advance));const have=isDeposit?held.deposit:held.advance;
  if(have+amount>cap)fail('VALIDATION_FAILED','The lease provides for '+decimal(cap)+'; '+decimal(have)+' is already held.',{fieldErrors:[{path:'amount',message:'Beyond the contract'}]});
  if(!input.evidenceIds.length)fail('EVIDENCE_NOT_READY','A receipt needs its bank or cash evidence.');
  entryId=await postEntry(tx,ctx,entityId,{bookId:book.id,sourceType:'lease_event',sourceId:sha(id+input.kind+input.eventDate+input.amount+Date.now()).slice(0,32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5'),date:input.eventDate,description:(isDeposit?'Lease deposit':'Lease advance')+' received '+id.slice(0,8),currency:row.currency,lines:[jl(profile.cashAccountId,branch.id,amount,0n),jl(liability,branch.id,0n,amount)],commandId});
 }else{
  // Application and refund need another principal than the one who recorded the receipt.
  const receipt=(await tx.query("select created_by from lara.lease_events where tenant_id=$1 and lease_id=$2 and kind=$3 order by created_at desc limit 1",[ctx.tenantId,id,isDeposit?'deposit_received':'advance_received'])).rows[0];
  if(!receipt)fail('STATE_CONFLICT','Nothing is held to apply or refund.');
  if(receipt.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who recorded the receipt cannot apply or refund it.');
  const have=isDeposit?held.deposit:held.advance;
  if(amount>have)fail('ALLOCATION_EXCEEDS_BALANCE','Only '+decimal(have)+' is held.');
  approvedBy=ctx.principalId;
  if(input.kind==='deposit_refunded'){
   if(!input.evidenceIds.length)fail('EVIDENCE_NOT_READY','A refund needs its payment evidence.');
   entryId=await postEntry(tx,ctx,entityId,{bookId:book.id,sourceType:'lease_event',sourceId:sha(id+input.kind+input.eventDate+input.amount+Date.now()).slice(0,32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5'),date:input.eventDate,description:'Lease deposit refunded '+id.slice(0,8),currency:row.currency,lines:[jl(liability,branch.id,amount,0n),jl(profile.cashAccountId,branch.id,0n,amount)],commandId});
  }else{
   if(!isUuid(input.documentId))fail('VALIDATION_FAILED','Application names the posted rent invoice.',{fieldErrors:[{path:'documentId',message:'Required'}]});
   const doc=(await tx.query("select d.*,i.id as open_item_id,(i.original_amount-lara.open_item_allocated(i.tenant_id,i.id))::text as outstanding from lara.documents d join lara.open_items i on i.tenant_id=d.tenant_id and i.document_id=d.id and i.side='AR' where d.tenant_id=$1 and d.entity_id=$2 and d.id=$3 and d.party_id=$4 and d.state='posted'",[ctx.tenantId,entityId,input.documentId,row.party_id])).rows[0];
   if(!doc)fail('NOT_FOUND','Posted rent invoice of the lessee not found.');
   if(amount>micros(doc.outstanding))fail('ALLOCATION_EXCEEDS_BALANCE','The invoice has '+money(doc.outstanding)+' outstanding.');
   const salesProfile=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='sales_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0].payload;
   const settlement=(await tx.query("insert into lara.settlements(tenant_id,entity_id,book_id,direction,party_id,payment_method,currency,gross_amount,cash_amount,withholding_amount,value_date,evidence_ids,payload_hash,state,approved_by,submitted_by,created_by) values($1,$2,$3,'receipt',$4,'cash',$5,$6,$6,0,$7,$8,$9,'approved',$10,$11,$11) returning id",[ctx.tenantId,entityId,book.id,row.party_id,row.currency,decimal(amount,6),input.eventDate,JSON.stringify(input.evidenceIds),sha('lease-apply'+id+doc.id+amount),ctx.principalId,receipt.created_by])).rows[0];
   settlementId=settlement.id;
   entryId=await postEntry(tx,ctx,entityId,{bookId:book.id,sourceType:'settlement',sourceId:settlement.id,date:input.eventDate,description:(isDeposit?'Lease deposit':'Lease advance')+' applied to '+(doc.official_number||doc.id),currency:row.currency,lines:[jl(liability,branch.id,amount,0n),jl(salesProfile.arAccountId,branch.id,0n,amount)],commandId});
   await tx.query("update lara.settlements set state='posted',posted_entry_id=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,settlement.id,entryId]);
   await sales.applyAllocations(tx,ctx,entityId,settlement.id,[{openItemId:doc.open_item_id,amount:decimal(amount,2)}],{commandId,reason:'Lease '+input.kind});
  }
 }
 const ev=(await tx.query('insert into lara.lease_events(tenant_id,entity_id,lease_id,kind,amount,event_date,entry_id,document_id,settlement_id,evidence_ids,reason,approved_by,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id',[ctx.tenantId,entityId,id,input.kind,decimal(amount,6),input.eventDate,entryId,input.documentId||null,settlementId,JSON.stringify(input.evidenceIds),input.reason||null,approvedBy,ctx.principalId])).rows[0];
 if(input.evidenceIds.length)await linkEvidence(tx,ctx,entityId,input.evidenceIds,'lease_event',ev.id,1);
 await audit(tx,ctx,{entityId,action:'lease.'+input.kind,resourceType:'lease_event',resourceId:ev.id,resourceVersion:1,afterRef:entryId,reason:input.reason||null});
 return {resourceType:'lease_event',resourceId:ev.id,version:1,state:input.kind,journalEntryIds:entryId?[entryId]:[]};
}
export async function listLeaseEvents(tx,ctx,entityId,id){
 requirePermission(ctx,'lease.read');requireEntity(ctx,entityId);await loadLease(tx,ctx,entityId,id);
 return {items:(await tx.query('select * from lara.lease_events where tenant_id=$1 and lease_id=$2 order by created_at,id',[ctx.tenantId,id])).rows.map(e=>({id:e.id,leaseId:e.lease_id,kind:e.kind,amount:money(e.amount),eventDate:iso(e.event_date),entryId:e.entry_id,documentId:e.document_id,settlementId:e.settlement_id,reason:e.reason,approvedBy:e.approved_by,createdAt:iso(e.created_at)})),nextCursor:null};
}

// ---------------------------------------------------------------------------
// P17B statutory discounts
// ---------------------------------------------------------------------------
const maskRef=v=>{const s=String(v||'').replace(/\s+/g,'');return s.length<=4?'****':'*'.repeat(Math.max(0,s.length-4))+s.slice(-4);};
const eligResource=r=>resource({...r,status:r.state},{partyId:r.party_id,category:r.category,profileVersion:r.profile_version,validUntil:iso(r.valid_until),evidenceIds:r.evidence_ids,idReferenceMasked:r.id_reference_masked});
const eligMaterial=i=>({partyId:i.partyId,category:i.category,profileVersion:i.profileVersion,validUntil:i.validUntil,evidenceIds:[...i.evidenceIds].sort(),idReference:i.idReference||null});
// The approved profile for a category: rate, basis, exemption, eligible
// accounts and golden cases; rates are never hard-coded.
async function discountProfile(tx,ctx,entityId,category,version){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind=$3 and status='approved' and payload->>'profileVersion'=$4 order by version_number desc limit 1",[ctx.tenantId,entityId,'discount_profile_'+category,version])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','No approved discount profile '+version+' for category '+category+'.');
 const p=row.payload;
 rateScaled(String(p.rate));
 if(!Array.isArray(p.eligibleAccountIds))fail('RULE_PROFILE_NOT_APPROVED','The discount profile names its eligible accounts.');
 return {rate:String(p.rate),basis:p.basis==='gross'?'gross':'net',eligibleAccountIds:p.eligibleAccountIds,exemptTaxCodeId:isUuid(p.exemptTaxCodeId)?p.exemptTaxCodeId:null,exemptionProfile:p.exemptionProfile||null,requiredEvidence:Array.isArray(p.requiredEvidence)?p.requiredEvidence:[],goldenCases:Array.isArray(p.goldenCases)?p.goldenCases:[]};
}
export async function createEligibility(tx,ctx,entityId,input,env){
 requirePermission(ctx,'discount_eligibility.create');requireEntity(ctx,entityId);assertInput('DiscountEligibility',input);await requireCapability(tx,ctx,entityId,CAP.discounts,'statutory discounts');
 if(!(await tx.query("select 1 from lara.party_roles where tenant_id=$1 and entity_id=$2 and party_id=$3 and role='customer'",[ctx.tenantId,entityId,input.partyId])).rowCount)fail('NOT_FOUND','Customer not found.');
 const profile=await discountProfile(tx,ctx,entityId,input.category,input.profileVersion);
 if(input.validUntil<new Date().toISOString().slice(0,10))fail('VALIDATION_FAILED','The eligibility is already expired.',{fieldErrors:[{path:'validUntil',message:'Past'}]});
 if(profile.requiredEvidence.length&&input.evidenceIds.length<profile.requiredEvidence.length)fail('EVIDENCE_NOT_READY','The profile requires '+profile.requiredEvidence.join(', ')+' as identity evidence.');
 if((await tx.query("select 1 from lara.discount_eligibility where tenant_id=$1 and entity_id=$2 and party_id=$3 and category=$4 and state in ('draft','approved')",[ctx.tenantId,entityId,input.partyId,input.category])).rowCount)fail('STATE_CONFLICT','A live eligibility exists for this customer and category; revoke it first.');
 const hash=contentHash(eligMaterial(input));
 const row=(await tx.query('insert into lara.discount_eligibility(tenant_id,entity_id,party_id,category,profile_version,valid_until,evidence_ids,id_reference_masked,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,input.partyId,input.category,input.profileVersion,input.validUntil,JSON.stringify(input.evidenceIds),input.idReference?maskRef(input.idReference):null,hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'discount_eligibility',row.id,1);
 await audit(tx,ctx,{entityId,action:'discount_eligibility.create',resourceType:'discount_eligibility',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return eligResource(row);
}
async function loadElig(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Eligibility not found.');
 const row=(await tx.query('select * from lara.discount_eligibility where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Eligibility not found.');return row;
}
export async function updateEligibility(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'discount_eligibility.edit');requireEntity(ctx,entityId);assertInput('DiscountEligibility',input);
 const row=await loadElig(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','An approved eligibility is immutable; revoke it and record another.');
 if(input.partyId!==row.party_id)fail('VALIDATION_FAILED','An eligibility keeps its customer.',{fieldErrors:[{path:'partyId',message:'Immutable'}]});
 await discountProfile(tx,ctx,entityId,input.category,input.profileVersion);
 const hash=contentHash(eligMaterial(input));
 const updated=(await tx.query('update lara.discount_eligibility set category=$4,profile_version=$5,valid_until=$6,evidence_ids=$7,id_reference_masked=coalesce($8,id_reference_masked),content_hash=$9,content_version=content_version+1 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,input.category,input.profileVersion,input.validUntil,JSON.stringify(input.evidenceIds),input.idReference?maskRef(input.idReference):null,hash])).rows[0];
 await audit(tx,ctx,{entityId,action:'discount_eligibility.edit',resourceType:'discount_eligibility',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return eligResource(updated);
}
export async function getEligibility(tx,ctx,entityId,id){requirePermission(ctx,'discount_eligibility.read');requireEntity(ctx,entityId);return eligResource(await loadElig(tx,ctx,entityId,id));}
export async function listEligibility(tx,ctx,entityId,query){
 requirePermission(ctx,'discount_eligibility.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.partyId){if(!isUuid(query.partyId))fail('VALIDATION_FAILED','partyId must be a UUID.');params.push(query.partyId);where+=' and party_id=$'+params.length;}
 return page((await tx.query('select * from lara.discount_eligibility where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,eligResource,scope);
}
export async function approveEligibility(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'discount_eligibility.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadElig(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Eligibility is '+row.state+'.');
 const ok=decide(row,ctx,input,'eligibility');
 const updated=(await tx.query('update lara.discount_eligibility set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,ok?'approved':'rejected',ok?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'discount_eligibility.'+(ok?'approve':'reject'),resourceType:'discount_eligibility',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'discount_eligibility',resourceId:id,version:Number(updated.version),state:updated.state};
}
// Apply the customer's approved, unexpired eligibilities to a draft invoice:
// each eligible line (by account) gets the profile's discount on its basis
// and the exemption tax code; other lines stay as they are. The golden case
// that matches the line's shape is recorded.
export async function applyDiscount(tx,ctx,entityId,documentId,input,{commandId=null}={}){
 requirePermission(ctx,'discount_eligibility.approve');requireEntity(ctx,entityId);assertInput('Action',input||{});await requireCapability(tx,ctx,entityId,CAP.discounts,'statutory discounts');
 if(!isUuid(documentId))fail('NOT_FOUND','Invoice not found.');
 const doc=(await tx.query("select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3 and kind='invoice' for update",[ctx.tenantId,entityId,documentId])).rows[0];
 if(!doc)fail('NOT_FOUND','Invoice not found.');
 if(!['draft','changes_requested'].includes(doc.state))fail('STATE_CONFLICT','Discounts apply to a draft invoice; a posted one is corrected by a credit note.');
 const eligs=(await tx.query("select * from lara.discount_eligibility where tenant_id=$1 and entity_id=$2 and party_id=$3 and state='approved' order by created_at",[ctx.tenantId,entityId,doc.party_id])).rows;
 const today=iso(doc.document_date);
 const live=eligs.filter(e=>iso(e.valid_until)>=today);
 if(!live.length)fail('STATE_CONFLICT',eligs.length?'The customer\'s eligibility expired on '+iso(eligs[0].valid_until)+'; the document date is '+today+'.':'The customer holds no approved eligibility.');
 const lines=(await tx.query('select * from lara.document_lines where tenant_id=$1 and document_id=$2 order by line_no',[ctx.tenantId,documentId])).rows;
 await tx.query('delete from lara.discount_lines where tenant_id=$1 and document_id=$2',[ctx.tenantId,documentId]);
 const newLines=[];const recorded=[];
 for(const l of lines){
  let applied=null;
  for(const e of live){
   const profile=await discountProfile(tx,ctx,entityId,e.category,e.profile_version);
   if(!profile.eligibleAccountIds.includes(l.account_id))continue;
   const basis=micros(String(profile.basis==='gross'?l.gross:l.net))+micros(String(l.discount||'0'));
   const amount=convert(basis,profile.rate,2);
   const golden=profile.goldenCases.find(g=>g.accountId===l.account_id||g.match==='any')||null;
   applied={eligibility:e,profile,basis,amount,golden};break;
  }
  if(applied){
   newLines.push({description:l.description,...(l.item_id?{itemId:l.item_id}:{}),quantity:money(String(l.quantity)),unitPrice:money(String(l.unit_price)),discount:decimal(applied.amount,2),priceBasis:l.price_basis,accountId:l.account_id,...(applied.profile.exemptTaxCodeId?{taxCodeId:applied.profile.exemptTaxCodeId}:{}),dimensions:l.dimensions_json||{}});
   recorded.push({lineNo:l.line_no,eligibilityId:applied.eligibility.id,category:applied.eligibility.category,profileVersion:applied.eligibility.profile_version,basis:decimal(applied.basis,6),rate:applied.profile.rate,amount:decimal(applied.amount,6),exemptionProfile:applied.profile.exemptionProfile,goldenCaseId:applied.golden?.id||null});
  }else newLines.push({description:l.description,...(l.item_id?{itemId:l.item_id}:{}),quantity:money(String(l.quantity)),unitPrice:money(String(l.unit_price)),discount:money(String(l.discount||'0')),priceBasis:l.price_basis,accountId:l.account_id,...(l.tax_code_id?{taxCodeId:l.tax_code_id}:{}),dimensions:l.dimensions_json||{}});
 }
 if(!recorded.length)fail('STATE_CONFLICT','No line of this invoice is eligible under the approved profiles.');
 const actor={...ctx,permissions:new Set([...ctx.permissions,'invoice.edit'])};
 const updated=await sales.updateDocument(tx,actor,entityId,documentId,Number(doc.version),{kind:'invoice',branchId:doc.branch_id,bookId:doc.book_id,partyId:doc.party_id,documentDate:iso(doc.document_date),accountingDate:iso(doc.accounting_date),currency:doc.currency,ruleProfileVersion:doc.rule_profile_version,...(doc.external_reference?{externalReference:doc.external_reference}:{}),lines:newLines,evidenceIds:doc.evidence_ids});
 for(const r of recorded)await tx.query('insert into lara.discount_lines(tenant_id,entity_id,document_id,line_no,eligibility_id,category,profile_version,basis,rate,amount,exemption_profile,golden_case_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[ctx.tenantId,entityId,documentId,r.lineNo,r.eligibilityId,r.category,r.profileVersion,r.basis,r.rate,r.amount,r.exemptionProfile,r.goldenCaseId,ctx.principalId]);
 await audit(tx,ctx,{entityId,action:'discount.apply',resourceType:'document',resourceId:documentId,resourceVersion:updated.version,reason:recorded.length+' line(s) discounted'});
 return {resourceType:'document',resourceId:documentId,version:updated.version,state:updated.state};
}
export async function discountLines(tx,ctx,entityId,documentId){
 requirePermission(ctx,'discount_eligibility.read');requireEntity(ctx,entityId);
 if(!isUuid(documentId))fail('NOT_FOUND','Invoice not found.');
 if(!(await tx.query('select 1 from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,documentId])).rowCount)fail('NOT_FOUND','Invoice not found.');
 return {documentId,items:(await tx.query('select * from lara.discount_lines where tenant_id=$1 and document_id=$2 order by line_no',[ctx.tenantId,documentId])).rows.map(r=>({lineNo:r.line_no,eligibilityId:r.eligibility_id,category:r.category,profileVersion:r.profile_version,basis:money(r.basis),rate:String(r.rate).replace(/\.?0+$/,''),amount:money(r.amount),exemptionProfile:r.exemption_profile,goldenCaseId:r.golden_case_id})),nextCursor:null};
}

// ---------------------------------------------------------------------------
// P17C marketplace and POS
// ---------------------------------------------------------------------------
const channelResource=c=>resource(c,{code:c.code,name:c.name,kind:c.kind,provider:c.provider,mappingVersion:c.mapping_version,receivableAccountId:c.receivable_account_id,feeAccountId:c.fee_account_id,withholdingAccountId:c.withholding_account_id,clearingAccountId:c.clearing_account_id});
export async function createChannel(tx,ctx,entityId,input){
 requirePermission(ctx,'channel.create');requireEntity(ctx,entityId);assertInput('ChannelCreate',input);await requireCapability(tx,ctx,entityId,CAP.channels,'marketplace and POS');
 for(const k of ['receivableAccountId','feeAccountId','withholdingAccountId','clearingAccountId']){if(!(await tx.query("select 1 from lara.accounts where tenant_id=$1 and entity_id=$2 and id=$3 and status<>'archived'",[ctx.tenantId,entityId,input[k]])).rowCount)fail('NOT_FOUND','Account for '+k+' not found.');}
 if((await tx.query('select 1 from lara.channels where tenant_id=$1 and entity_id=$2 and code=$3',[ctx.tenantId,entityId,input.code])).rowCount)fail('STATE_CONFLICT','Channel code '+input.code+' exists.');
 const hash=contentHash(input);
 const row=(await tx.query('insert into lara.channels(tenant_id,entity_id,code,name,kind,provider,mapping_version,receivable_account_id,fee_account_id,withholding_account_id,clearing_account_id,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',[ctx.tenantId,entityId,input.code,input.name,input.kind,input.provider,input.mappingVersion,input.receivableAccountId,input.feeAccountId,input.withholdingAccountId,input.clearingAccountId,hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'channel.create',resourceType:'channel',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return channelResource(row);
}
export async function listChannels(tx,ctx,entityId,query){
 requirePermission(ctx,'channel.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.channels where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,channelResource,scope);
}
const payoutResource=p=>resource({...p,status:p.state},{channelId:p.channel_id,sourceId:p.source_id,periodStart:iso(p.period_start),periodEnd:iso(p.period_end),gross:money(p.gross),fees:money(p.fees),withholding:money(p.withholding),otherDeductions:p.deductions_json,net:money(p.net),evidenceIds:p.evidence_ids,salesReferenceIds:p.sales_reference_ids,salesTotal:p.sales_total==null?null:money(p.sales_total),difference:p.difference==null?null:decimal(signedMicros(String(p.difference)),2),exceptionReason:p.exception_reason,entryId:p.entry_id});
export async function createPayout(tx,ctx,entityId,input){
 requirePermission(ctx,'payout.create');requireEntity(ctx,entityId);assertInput('PayoutCreate',input);await requireCapability(tx,ctx,entityId,CAP.channels,'marketplace and POS');
 const channel=(await tx.query("select * from lara.channels where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,input.channelId])).rows[0];
 if(!channel)fail('NOT_FOUND','Channel not found.');
 if(input.periodEnd<input.periodStart)fail('VALIDATION_FAILED','periodEnd is on or after periodStart.',{fieldErrors:[{path:'periodEnd',message:'Before start'}]});
 const other=input.otherDeductions.reduce((s,d)=>s+micros(d.amount),0n);
 const expected=micros(input.gross)-micros(input.fees)-micros(input.withholding)-other;
 if(expected!==micros(input.net))fail('VALIDATION_FAILED','Gross less fees, withholding and other deductions is '+decimal(expected)+', not the stated net; every deduction must be explicit.',{fieldErrors:[{path:'net',message:'Expected '+decimal(expected)}]});
 if((await tx.query('select 1 from lara.payout_batches where tenant_id=$1 and channel_id=$2 and source_id=$3',[ctx.tenantId,channel.id,input.sourceId])).rowCount)fail('STATE_CONFLICT','Payout '+input.sourceId+' of this channel is already recorded; a replay never duplicates it.');
 const hash=contentHash({...input,otherDeductions:[...input.otherDeductions]});
 const row=(await tx.query('insert into lara.payout_batches(tenant_id,entity_id,channel_id,source_id,period_start,period_end,gross,fees,withholding,other_deductions,net,deductions_json,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *',[ctx.tenantId,entityId,channel.id,input.sourceId,input.periodStart,input.periodEnd,money(input.gross),money(input.fees),money(input.withholding),decimal(other,6),money(input.net),JSON.stringify(input.otherDeductions),JSON.stringify(input.evidenceIds),hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'payout_batch',row.id,1);
 await audit(tx,ctx,{entityId,action:'payout.create',resourceType:'payout_batch',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return payoutResource(row);
}
async function loadPayout(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Payout not found.');
 const row=(await tx.query('select * from lara.payout_batches where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Payout not found.');return row;
}
export async function getPayout(tx,ctx,entityId,id){requirePermission(ctx,'payout.read');requireEntity(ctx,entityId);return payoutResource(await loadPayout(tx,ctx,entityId,id));}
export async function listPayouts(tx,ctx,entityId,query){
 requirePermission(ctx,'payout.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.status){params.push(String(query.status).split(','));where+=' and state=any($'+params.length+'::text[])';}
 return page((await tx.query('select * from lara.payout_batches where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,payoutResource,scope);
}
// Reconcile to the sales already imported: the named posted documents or
// journal entries of the channel's period whose revenue totals the gross.
export async function reconcilePayout(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'payout.reconcile');requireEntity(ctx,entityId);assertInput('PayoutReconcile',input);
 const row=await loadPayout(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['imported','exception','reconciled'].includes(row.state))fail('STATE_CONFLICT','Payout is '+row.state+'.');
 const ids=[...new Set(input.salesReferenceIds)];
 const docs=(await tx.query("select id,gross,state,accounting_date from lara.documents where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[]) and kind='invoice'",[ctx.tenantId,entityId,ids])).rows;
 const entries=(await tx.query("select e.id,e.accounting_date,coalesce((select sum(l.func_credit-l.func_debit) from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=e.tenant_id and l.entry_id=e.id and a.category='income'),0)::text as revenue from lara.journal_entries e where e.tenant_id=$1 and e.entity_id=$2 and e.id=any($3::uuid[])",[ctx.tenantId,entityId,ids])).rows;
 if(docs.length+entries.length!==ids.length)fail('NOT_FOUND','A sales reference was not found as a posted invoice or journal entry.');
 for(const d of docs)if(d.state!=='posted')fail('STATE_CONFLICT','Invoice '+d.id+' is not posted; import the sales before the payout.');
 const already=(await tx.query("select id from lara.payout_batches where tenant_id=$1 and entity_id=$2 and id<>$3 and state<>'cancelled' and sales_reference_ids ?| $4::text[]",[ctx.tenantId,entityId,id,ids])).rows;
 if(already.length)fail('STATE_CONFLICT','A sales reference is already reconciled to payout '+already[0].id+'; revenue is never reposted.');
 const total=docs.reduce((s,d)=>s+micros(String(d.gross)),0n)+entries.reduce((s,e)=>s+signedMicros(e.revenue),0n);
 const difference=micros(String(row.gross))-total;
 const state=difference===0n?'reconciled':'exception';
 const updated=(await tx.query("update lara.payout_batches set sales_reference_ids=$4,sales_total=$5,difference=$6,state=$7,exception_reason=$8 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,JSON.stringify(ids),decimal(total,6),decimal(difference,6),state,difference===0n?null:'Payout gross '+money(row.gross)+' differs from the imported sales '+decimal(total)+' by '+decimal(difference)+'.'])).rows[0];
 await audit(tx,ctx,{entityId,action:'payout.reconcile',resourceType:'payout_batch',resourceId:id,resourceVersion:Number(updated.version),reason:updated.exception_reason||input.reason||null});
 return {resourceType:'payout_batch',resourceId:id,version:Number(updated.version),state};
}
// Posting: net to clearing, fees and withholding recognized, the channel
// receivable (already carrying the imported sales) settled for the gross.
export async function postPayout(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'payout.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadPayout(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return {resourceType:'payout_batch',resourceId:id,version:Number(row.version),state:'posted',journalEntryIds:[row.entry_id]};
 if(row.state!=='reconciled')fail('STATE_CONFLICT','Reconcile the payout to the imported sales before posting.');
 if(row.created_by===ctx.principalId&&!ctx.permissions.has('payout.reconcile'))fail('SELF_APPROVAL','The recorder cannot post without the reconciliation authority.');
 const channel=(await tx.query('select * from lara.channels where tenant_id=$1 and id=$2',[ctx.tenantId,row.channel_id])).rows[0];
 const book=await primaryBook(tx,ctx,entityId),branch=await firstBranch(tx,ctx,entityId);
 const lines=[jl(channel.clearing_account_id,branch.id,micros(String(row.net)),0n)];
 if(micros(String(row.fees))>0n)lines.push(jl(channel.fee_account_id,branch.id,micros(String(row.fees)),0n));
 if(micros(String(row.withholding))>0n)lines.push(jl(channel.withholding_account_id,branch.id,micros(String(row.withholding)),0n));
 if(micros(String(row.other_deductions))>0n)lines.push(jl(channel.fee_account_id,branch.id,micros(String(row.other_deductions)),0n));
 lines.push(jl(channel.receivable_account_id,branch.id,0n,micros(String(row.gross))));
 const entryId=await postEntry(tx,ctx,entityId,{bookId:book.id,sourceType:'payout_batch',sourceId:id,sourceVersion:Number(row.content_version),date:iso(row.period_end),description:'Payout '+channel.code+' '+row.source_id,currency:book.functional_currency,lines,commandId});
 const updated=(await tx.query("update lara.payout_batches set state='posted',entry_id=$4,posted_by=$5,posted_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,entryId,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'payout.post',resourceType:'payout_batch',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'payout_batch',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'channel.payout_posted.v1',payload:{payoutId:id,entryId,net:money(row.net)}});
 return {resourceType:'payout_batch',resourceId:id,version:Number(updated.version),state:'posted',journalEntryIds:[entryId]};
}
const machineResource=m=>({id:m.id,version:Number(m.version),branchId:m.branch_id,brand:m.brand,model:m.model,serialNumber:m.serial_number,machineIdentificationNumber:m.machine_identification_number,permitNumber:m.permit_number,state:m.status,createdAt:iso(m.created_at),updatedAt:iso(m.updated_at)});
export async function createMachine(tx,ctx,entityId,input){
 requirePermission(ctx,'channel.create');requireEntity(ctx,entityId);assertInput('PosMachineCreate',input);await requireCapability(tx,ctx,entityId,CAP.channels,'marketplace and POS');
 if(!(await tx.query("select 1 from lara.branches where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,input.branchId])).rowCount)fail('NOT_FOUND','Branch not found.');
 if((await tx.query('select 1 from lara.pos_machines where tenant_id=$1 and entity_id=$2 and (serial_number=$3 or machine_identification_number=$4)',[ctx.tenantId,entityId,input.serialNumber,input.machineIdentificationNumber])).rowCount)fail('STATE_CONFLICT','A machine with that serial or MIN is registered.');
 const row=(await tx.query('insert into lara.pos_machines(tenant_id,entity_id,branch_id,brand,model,serial_number,machine_identification_number,permit_number,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,input.branchId,input.brand,input.model,input.serialNumber,input.machineIdentificationNumber,input.permitNumber,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'pos_machine.create',resourceType:'pos_machine',resourceId:row.id,resourceVersion:1});
 return machineResource(row);
}
export async function listMachines(tx,ctx,entityId,query){
 requirePermission(ctx,'channel.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.pos_machines where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,machineResource,scope);
}
const closingResource=c=>resource({...c,status:c.state},{machineId:c.machine_id,shiftDate:iso(c.shift_date),shiftNo:c.shift_no,readingKind:c.reading_kind,beginningReading:money(c.beginning_reading),endingReading:money(c.ending_reading),grossSales:money(c.gross_sales),cashCounted:money(c.cash_counted),nonCash:money(c.non_cash),evidenceIds:c.evidence_ids,settlementId:c.settlement_id,depositDifference:c.deposit_difference==null?null:decimal(signedMicros(String(c.deposit_difference)),2),exceptionReason:c.exception_reason});
export async function createClosing(tx,ctx,entityId,input){
 requirePermission(ctx,'pos_closing.create');requireEntity(ctx,entityId);assertInput('PosClosingCreate',input);await requireCapability(tx,ctx,entityId,CAP.channels,'marketplace and POS');
 if(!(await tx.query("select 1 from lara.pos_machines where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,input.machineId])).rowCount)fail('NOT_FOUND','Machine not found.');
 const b=micros(input.beginningReading),e=micros(input.endingReading);
 if(e<b)fail('VALIDATION_FAILED','The ending reading is at least the beginning reading.',{fieldErrors:[{path:'endingReading',message:'Below beginning'}]});
 if((await tx.query('select 1 from lara.pos_closings where tenant_id=$1 and machine_id=$2 and shift_date=$3 and shift_no=$4 and reading_kind=$5',[ctx.tenantId,input.machineId,input.shiftDate,input.shiftNo,input.readingKind])).rowCount)fail('STATE_CONFLICT','This machine, shift and reading are already recorded.');
 const hash=contentHash(input);
 const row=(await tx.query('insert into lara.pos_closings(tenant_id,entity_id,machine_id,shift_date,shift_no,reading_kind,beginning_reading,ending_reading,gross_sales,cash_counted,non_cash,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *',[ctx.tenantId,entityId,input.machineId,input.shiftDate,input.shiftNo,input.readingKind,money(input.beginningReading),money(input.endingReading),decimal(e-b,6),money(input.cashCounted),money(input.nonCash),JSON.stringify(input.evidenceIds),hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'pos_closing',row.id,1);
 await audit(tx,ctx,{entityId,action:'pos_closing.create',resourceType:'pos_closing',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return closingResource(row);
}
async function loadClosing(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Closing not found.');
 const row=(await tx.query('select * from lara.pos_closings where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Closing not found.');return row;
}
export async function listClosings(tx,ctx,entityId,query){
 requirePermission(ctx,'pos_closing.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.status){params.push(String(query.status).split(','));where+=' and state=any($'+params.length+'::text[])';}
 return page((await tx.query('select * from lara.pos_closings where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,closingResource,scope);
}
export async function approveClosing(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'pos_closing.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadClosing(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Closing is '+row.state+'.');
 const ok=decide(row,ctx,input,'closing');
 const updated=(await tx.query('update lara.pos_closings set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,ok?'approved':'rejected',ok?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'pos_closing.'+(ok?'approve':'reject'),resourceType:'pos_closing',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'pos_closing',resourceId:id,version:Number(updated.version),state:updated.state};
}
export async function matchClosing(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'pos_closing.approve');requireEntity(ctx,entityId);assertInput('PosMatch',input);
 const row=await loadClosing(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['approved','exception'].includes(row.state))fail('STATE_CONFLICT','Approve the closing before matching its deposit.');
 const s=(await tx.query("select * from lara.settlements where tenant_id=$1 and entity_id=$2 and id=$3 and direction='receipt' and state='posted'",[ctx.tenantId,entityId,input.settlementId])).rows[0];
 if(!s)fail('NOT_FOUND','Posted deposit not found.');
 if((await tx.query("select 1 from lara.pos_closings where tenant_id=$1 and settlement_id=$2 and id<>$3 and state='matched'",[ctx.tenantId,s.id,id])).rowCount)fail('STATE_CONFLICT','That deposit already matches another closing.');
 const difference=micros(String(row.cash_counted))-micros(String(s.cash_amount));
 const state=difference===0n?'matched':'exception';
 const updated=(await tx.query("update lara.pos_closings set settlement_id=$4,deposit_difference=$5,state=$6,exception_reason=$7 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,s.id,decimal(difference,6),state,difference===0n?null:'Cash counted '+money(row.cash_counted)+' differs from the deposit '+money(s.cash_amount)+' by '+decimal(difference)+'.'])).rows[0];
 await audit(tx,ctx,{entityId,action:'pos_closing.match',resourceType:'pos_closing',resourceId:id,resourceVersion:Number(updated.version),afterRef:s.id,reason:updated.exception_reason||input.reason||null});
 return {resourceType:'pos_closing',resourceId:id,version:Number(updated.version),state};
}

// ---------------------------------------------------------------------------
// P17D payroll data and remittances
// ---------------------------------------------------------------------------
const batchResource=b=>resource({...b,status:b.state},{sourceSystem:b.source_system,periodKey:b.period_key,mappingVersion:b.mapping_version,employeeCount:b.employee_count,grossTotal:money(b.gross_total),withholdingTotal:money(b.withholding_total),sssTotal:money(b.sss_total),philhealthTotal:money(b.philhealth_total),pagibigTotal:money(b.pagibig_total),netTotal:money(b.net_total),sourceHash:b.source_hash,evidenceIds:b.evidence_ids,exceptionReason:b.exception_reason,entryId:b.entry_id});
const payrollProfile=(tx,ctx,entityId)=>approvedProfile(tx,ctx,entityId,'payroll_profile','payroll (salary expense, withholding, SSS, PhilHealth, Pag-IBIG and net pay accounts)');
export async function importPayroll(tx,ctx,entityId,input,env){
 requirePermission(ctx,'payroll_batch.create');requireEntity(ctx,entityId);assertInput('PayrollBatchCreate',input);await requireCapability(tx,ctx,entityId,CAP.payroll,'payroll data');
 await payrollProfile(tx,ctx,entityId);
 const sum=k=>input.records.reduce((s,r)=>s+micros(r[k]),0n);
 const ties=[['grossTotal','gross'],['withholdingTotal','withholding'],['sssTotal','sss'],['philhealthTotal','philhealth'],['pagibigTotal','pagibig'],['netTotal','net']];
 const off=ties.filter(([t,k])=>sum(k)!==micros(input[t])).map(([t,k])=>t+' '+money(input[t])+' vs records '+decimal(sum(k)));
 for(const [i,r] of input.records.entries()){const expected=micros(r.gross)-micros(r.withholding)-micros(r.sss)-micros(r.philhealth)-micros(r.pagibig);if(expected!==micros(r.net))fail('VALIDATION_FAILED','Record '+(i+1)+': gross less deductions is '+decimal(expected)+', not the stated net.',{fieldErrors:[{path:'records['+i+'].net',message:'Expected '+decimal(expected)}]});}
 // The file identity is its full content: a corrected file with the same records but different totals is a new import, an identical one a replay.
 const sourceHash=sha(canonical({sourceSystem:input.sourceSystem,periodKey:input.periodKey,totals:{grossTotal:input.grossTotal,withholdingTotal:input.withholdingTotal,sssTotal:input.sssTotal,philhealthTotal:input.philhealthTotal,pagibigTotal:input.pagibigTotal,netTotal:input.netTotal},records:input.records}));
 if((await tx.query('select 1 from lara.payroll_batches where tenant_id=$1 and entity_id=$2 and source_system=$3 and period_key=$4 and source_hash=$5',[ctx.tenantId,entityId,input.sourceSystem,input.periodKey,sourceHash])).rowCount)fail('STATE_CONFLICT','This payroll file is already imported; a replay never duplicates it.');
 const state=off.length?'exception':'reconciled';
 const row=(await tx.query('insert into lara.payroll_batches(tenant_id,entity_id,source_system,period_key,mapping_version,employee_count,gross_total,withholding_total,sss_total,philhealth_total,pagibig_total,net_total,source_hash,evidence_ids,state,exception_reason,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *',[ctx.tenantId,entityId,input.sourceSystem,input.periodKey,input.mappingVersion,input.records.length,money(input.grossTotal),money(input.withholdingTotal),money(input.sssTotal),money(input.philhealthTotal),money(input.pagibigTotal),money(input.netTotal),sourceHash,JSON.stringify(input.evidenceIds),state,off.length?'Totals do not tie: '+off.join('; '):null,ctx.principalId])).rows[0];
 for(const [i,r] of input.records.entries())await tx.query('insert into lara.employee_tax_records(tenant_id,entity_id,batch_id,line_no,employee_reference_encrypted,employee_reference_masked,gross,withholding,sss,philhealth,pagibig,net) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[ctx.tenantId,entityId,row.id,i+1,encryptField(r.employeeReference,env),maskRef(r.employeeReference),money(r.gross),money(r.withholding),money(r.sss),money(r.philhealth),money(r.pagibig),money(r.net)]);
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'payroll_batch',row.id,1);
 await audit(tx,ctx,{entityId,action:'payroll_batch.import',resourceType:'payroll_batch',resourceId:row.id,resourceVersion:1,afterRef:sourceHash,reason:row.exception_reason});
 return batchResource(row);
}
async function loadBatch(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Payroll batch not found.');
 const row=(await tx.query('select * from lara.payroll_batches where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Payroll batch not found.');return row;
}
export async function getBatch(tx,ctx,entityId,id){requirePermission(ctx,'payroll_batch.read');requireEntity(ctx,entityId);return batchResource(await loadBatch(tx,ctx,entityId,id));}
export async function listBatches(tx,ctx,entityId,query){
 requirePermission(ctx,'payroll_batch.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.payroll_batches where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,batchResource,scope);
}
export async function batchRecords(tx,ctx,entityId,id){
 requirePermission(ctx,'payroll_record.read');requireEntity(ctx,entityId);await loadBatch(tx,ctx,entityId,id);
 await audit(tx,ctx,{entityId,action:'payroll_record.read',resourceType:'payroll_batch',resourceId:id,resourceVersion:null});
 return {items:(await tx.query('select * from lara.employee_tax_records where tenant_id=$1 and batch_id=$2 order by line_no',[ctx.tenantId,id])).rows.map(r=>({lineNo:r.line_no,employeeReferenceMasked:r.employee_reference_masked,gross:money(r.gross),withholding:money(r.withholding),sss:money(r.sss),philhealth:money(r.philhealth),pagibig:money(r.pagibig),net:money(r.net)})),nextCursor:null};
}
export async function approveBatch(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'payroll_batch.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadBatch(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='reconciled')fail('STATE_CONFLICT',row.state==='exception'?'The totals do not tie; import a corrected file.':'Batch is '+row.state+'.');
 const ok=decide(row,ctx,input,'payroll batch');
 const updated=(await tx.query('update lara.payroll_batches set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,ok?'approved':'rejected',ok?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'payroll_batch.'+(ok?'approve':'reject'),resourceType:'payroll_batch',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'payroll_batch',resourceId:id,version:Number(updated.version),state:updated.state};
}
// The payroll journal from the totals per the approved profile: salary
// expense against withholding, agency and net pay liabilities.
export async function postBatch(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'payroll_batch.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadBatch(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return {resourceType:'payroll_batch',resourceId:id,version:Number(row.version),state:'posted',journalEntryIds:[row.entry_id]};
 if(row.state!=='approved')fail('STATE_CONFLICT','Approval is required before posting.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The importer cannot both approve and post.');
 if((await tx.query("select 1 from lara.payroll_batches where tenant_id=$1 and entity_id=$2 and source_system=$3 and period_key=$4 and state='posted'",[ctx.tenantId,entityId,row.source_system,row.period_key])).rowCount)fail('STATE_CONFLICT','A batch for this source and period is already posted.');
 const p=await payrollProfile(tx,ctx,entityId);
 for(const k of ['salaryExpenseAccountId','withholdingPayableAccountId','sssPayableAccountId','philhealthPayableAccountId','pagibigPayableAccountId','netPayableAccountId'])if(!isUuid(p[k]))fail('RULE_PROFILE_NOT_APPROVED','The payroll profile lacks '+k+'.');
 const book=await primaryBook(tx,ctx,entityId),branch=await firstBranch(tx,ctx,entityId);
 const lines=[jl(p.salaryExpenseAccountId,branch.id,micros(String(row.gross_total)),0n)];
 for(const [acc,col] of [[p.withholdingPayableAccountId,'withholding_total'],[p.sssPayableAccountId,'sss_total'],[p.philhealthPayableAccountId,'philhealth_total'],[p.pagibigPayableAccountId,'pagibig_total'],[p.netPayableAccountId,'net_total']]){const v=micros(String(row[col]));if(v>0n)lines.push(jl(acc,branch.id,0n,v));}
 const date=row.period_key+'-01';const end=new Date(Date.UTC(Number(row.period_key.slice(0,4)),Number(row.period_key.slice(5,7)),0)).toISOString().slice(0,10);
 const entryId=await postEntry(tx,ctx,entityId,{bookId:book.id,sourceType:'payroll_batch',sourceId:id,sourceVersion:Number(row.content_version),date:end,description:'Payroll '+row.source_system+' '+row.period_key,currency:book.functional_currency,lines,commandId});
 const updated=(await tx.query("update lara.payroll_batches set state='posted',entry_id=$4 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,entryId])).rows[0];
 await audit(tx,ctx,{entityId,action:'payroll_batch.post',resourceType:'payroll_batch',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 return {resourceType:'payroll_batch',resourceId:id,version:Number(updated.version),state:'posted',journalEntryIds:[entryId]};
}
const remitResource=r=>resource({...r,status:r.state},{batchId:r.batch_id,agency:r.agency,periodKey:r.period_key,amount:money(r.amount),reference:r.reference,dueDate:iso(r.due_date),evidenceIds:r.evidence_ids,settlementId:r.settlement_id});
export async function createRemittance(tx,ctx,entityId,input){
 requirePermission(ctx,'remittance.create');requireEntity(ctx,entityId);assertInput('RemittanceCreate',input);await requireCapability(tx,ctx,entityId,CAP.payroll,'payroll data');
 if(input.batchId){const b=await loadBatch(tx,ctx,entityId,input.batchId);const expected={BIR:'withholding_total',SSS:'sss_total',PhilHealth:'philhealth_total','Pag-IBIG':'pagibig_total'}[input.agency];if(money(b[expected])!==money(input.amount))fail('VALIDATION_FAILED','The batch carries '+money(b[expected])+' for '+input.agency+'.',{fieldErrors:[{path:'amount',message:'Expected '+money(b[expected])}]});}
 if((await tx.query('select 1 from lara.remittance_records where tenant_id=$1 and entity_id=$2 and agency=$3 and period_key=$4 and batch_id is not distinct from $5',[ctx.tenantId,entityId,input.agency,input.periodKey,input.batchId||null])).rowCount)fail('STATE_CONFLICT','A remittance for this agency and period exists.');
 const row=(await tx.query('insert into lara.remittance_records(tenant_id,entity_id,batch_id,agency,period_key,amount,due_date,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[ctx.tenantId,entityId,input.batchId||null,input.agency,input.periodKey,money(input.amount),input.dueDate,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'remittance.create',resourceType:'remittance_record',resourceId:row.id,resourceVersion:1});
 return remitResource(row);
}
async function loadRemit(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Remittance not found.');
 const row=(await tx.query('select * from lara.remittance_records where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Remittance not found.');return row;
}
export async function listRemittances(tx,ctx,entityId,query){
 requirePermission(ctx,'remittance.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.status){params.push(String(query.status).split(','));where+=' and state=any($'+params.length+'::text[])';}
 return page((await tx.query('select * from lara.remittance_records where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by due_date,created_at,id limit $3',params)).rows,limit,remitResource,scope);
}
export async function approveRemittance(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'remittance.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadRemit(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='due')fail('STATE_CONFLICT','Remittance is '+row.state+'.');
 const ok=decide(row,ctx,input,'remittance');
 const updated=(await tx.query('update lara.remittance_records set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,ok?'approved':'rejected',ok?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'remittance.'+(ok?'approve':'reject'),resourceType:'remittance_record',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'remittance_record',resourceId:id,version:Number(updated.version),state:updated.state};
}
export async function remit(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'remittance.approve');requireEntity(ctx,entityId);assertInput('RemittanceRemit',input);
 const row=await loadRemit(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='approved')fail('STATE_CONFLICT','Approve the remittance before recording it.');
 if(input.settlementId&&!(await tx.query("select 1 from lara.settlements where tenant_id=$1 and entity_id=$2 and id=$3 and direction='payment' and state='posted'",[ctx.tenantId,entityId,input.settlementId])).rowCount)fail('NOT_FOUND','Posted payment not found.');
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'remittance_record',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.remittance_records set state='remitted',reference=$4,evidence_ids=$5,settlement_id=$6 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,input.reference,JSON.stringify(input.evidenceIds),input.settlementId||null])).rows[0];
 await audit(tx,ctx,{entityId,action:'remittance.remit',resourceType:'remittance_record',resourceId:id,resourceVersion:Number(updated.version),afterRef:input.reference});
 return {resourceType:'remittance_record',resourceId:id,version:Number(updated.version),state:'remitted'};
}

// ---------------------------------------------------------------------------
// P17E local obligations
// ---------------------------------------------------------------------------
const obligationResource=o=>resource({...o,status:o.state},{authority:o.authority,authorityProfileVersion:o.authority_profile_version,kind:o.kind,propertyRef:o.property_ref,periodKey:o.period_key,dueDate:iso(o.due_date),amount:money(o.amount),requiresFiling:o.requires_filing,evidenceIds:o.evidence_ids,paymentEvidenceIds:o.payment_evidence_ids,filingEvidenceIds:o.filing_evidence_ids,billId:o.bill_id,settlementId:o.settlement_id,reason:o.reason});
async function authorityProfile(tx,ctx,entityId,authority,version){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='local_authority_profile' and status='approved' and payload->>'authority'=$3 and payload->>'profileVersion'=$4 order by version_number desc limit 1",[ctx.tenantId,entityId,authority,version])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','No approved profile '+version+' for authority '+authority+'.');
 return {kinds:Array.isArray(row.payload.kinds)?row.payload.kinds:[],filingRequired:Array.isArray(row.payload.filingRequired)?row.payload.filingRequired:[]};
}
const obligationMaterial=i=>({authority:i.authority,authorityProfileVersion:i.authorityProfileVersion,kind:i.kind,propertyRef:i.propertyRef||null,periodKey:i.periodKey,dueDate:i.dueDate,amount:money(i.amount),requiresFiling:i.requiresFiling,evidenceIds:[...i.evidenceIds].sort()});
async function validateObligation(tx,ctx,entityId,input){
 const profile=await authorityProfile(tx,ctx,entityId,input.authority,input.authorityProfileVersion);
 if(profile.kinds.length&&!profile.kinds.includes(input.kind))fail('VALIDATION_FAILED','The authority profile does not cover '+input.kind+'.',{fieldErrors:[{path:'kind',message:'Not in profile'}]});
 if(profile.filingRequired.includes(input.kind)&&!input.requiresFiling)fail('VALIDATION_FAILED','The authority requires filing evidence for '+input.kind+'.',{fieldErrors:[{path:'requiresFiling',message:'Required by the authority'}]});
 if(input.kind==='real_property_tax'&&!input.propertyRef)fail('VALIDATION_FAILED','Real property tax names the property.',{fieldErrors:[{path:'propertyRef',message:'Required'}]});
}
export async function createObligation(tx,ctx,entityId,input){
 requirePermission(ctx,'local_obligation.create');requireEntity(ctx,entityId);assertInput('LocalObligationCreate',input);await requireCapability(tx,ctx,entityId,CAP.local,'local obligations');
 await validateObligation(tx,ctx,entityId,input);
 if((await tx.query("select 1 from lara.local_obligations where tenant_id=$1 and entity_id=$2 and authority=$3 and kind=$4 and period_key=$5 and coalesce(property_ref,'')=coalesce($6,'')",[ctx.tenantId,entityId,input.authority,input.kind,input.periodKey,input.propertyRef||null])).rowCount)fail('STATE_CONFLICT','This obligation is already recorded for the period.');
 const hash=contentHash(obligationMaterial(input));
 const row=(await tx.query('insert into lara.local_obligations(tenant_id,entity_id,authority,authority_profile_version,kind,property_ref,period_key,due_date,amount,requires_filing,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',[ctx.tenantId,entityId,input.authority,input.authorityProfileVersion,input.kind,input.propertyRef||null,input.periodKey,input.dueDate,money(input.amount),input.requiresFiling,JSON.stringify(input.evidenceIds),hash,ctx.principalId])).rows[0];
 if(input.evidenceIds.length)await linkEvidence(tx,ctx,entityId,input.evidenceIds,'local_obligation',row.id,1);
 await audit(tx,ctx,{entityId,action:'local_obligation.create',resourceType:'local_obligation',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return obligationResource(row);
}
async function loadObligation(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Obligation not found.');
 const row=(await tx.query('select * from lara.local_obligations where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Obligation not found.');return row;
}
export async function updateObligation(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'local_obligation.edit');requireEntity(ctx,entityId);assertInput('LocalObligationCreate',input);
 const row=await loadObligation(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='open')fail('STATE_CONFLICT','Only open obligations change.');
 await validateObligation(tx,ctx,entityId,input);
 const hash=contentHash(obligationMaterial(input));
 const updated=(await tx.query('update lara.local_obligations set authority=$4,authority_profile_version=$5,kind=$6,property_ref=$7,period_key=$8,due_date=$9,amount=$10,requires_filing=$11,evidence_ids=$12,content_hash=$13,content_version=content_version+1 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,input.authority,input.authorityProfileVersion,input.kind,input.propertyRef||null,input.periodKey,input.dueDate,money(input.amount),input.requiresFiling,JSON.stringify(input.evidenceIds),hash])).rows[0];
 await audit(tx,ctx,{entityId,action:'local_obligation.edit',resourceType:'local_obligation',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return obligationResource(updated);
}
export async function getObligation(tx,ctx,entityId,id){requirePermission(ctx,'local_obligation.read');requireEntity(ctx,entityId);return obligationResource(await loadObligation(tx,ctx,entityId,id));}
export async function listObligations(tx,ctx,entityId,query){
 requirePermission(ctx,'local_obligation.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.status){params.push(String(query.status).split(','));where+=' and state=any($'+params.length+'::text[])';}
 return page((await tx.query('select * from lara.local_obligations where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by due_date,created_at,id limit $3',params)).rows,limit,obligationResource,scope);
}
// Completion needs payment evidence (a posted settlement or bill may be
// named) and, where the authority requires it, filing evidence.
export async function completeObligation(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'local_obligation.complete');requireEntity(ctx,entityId);assertInput('LocalObligationComplete',input);
 const row=await loadObligation(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['open','paid'].includes(row.state))fail('STATE_CONFLICT','Obligation is '+row.state+'.');
 if(row.requires_filing&&!input.filingEvidenceIds.length)fail('EVIDENCE_NOT_READY','This authority requires filing evidence for '+row.kind+' before the obligation is complete.');
 if(input.settlementId&&!(await tx.query("select 1 from lara.settlements where tenant_id=$1 and entity_id=$2 and id=$3 and direction='payment' and state='posted'",[ctx.tenantId,entityId,input.settlementId])).rowCount)fail('NOT_FOUND','Posted payment not found.');
 if(input.billId&&!(await tx.query("select 1 from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3 and kind='bill'",[ctx.tenantId,entityId,input.billId])).rowCount)fail('NOT_FOUND','Bill not found.');
 await linkEvidence(tx,ctx,entityId,[...input.paymentEvidenceIds,...input.filingEvidenceIds],'local_obligation',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.local_obligations set state='complete',payment_evidence_ids=$4,filing_evidence_ids=$5,settlement_id=$6,bill_id=$7,completed_by=$8,completed_at=now(),reason=$9 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,JSON.stringify(input.paymentEvidenceIds),JSON.stringify(input.filingEvidenceIds),input.settlementId||null,input.billId||null,ctx.principalId,input.reason||null])).rows[0];
 await audit(tx,ctx,{entityId,action:'local_obligation.complete',resourceType:'local_obligation',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'local_obligation',resourceId:id,version:Number(updated.version),state:'complete'};
}
export async function waiveObligation(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'local_obligation.complete');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadObligation(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['open','paid'].includes(row.state))fail('STATE_CONFLICT','Obligation is '+row.state+'.');
 const updated=(await tx.query("update lara.local_obligations set state='waived',reason=$4,completed_by=$5,completed_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,input.reason,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'local_obligation.waive',resourceType:'local_obligation',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'local_obligation',resourceId:id,version:Number(updated.version),state:'waived'};
}
