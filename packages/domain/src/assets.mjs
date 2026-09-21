// Assets, recurring work and recognition schedules (P11): reviewed asset
// classes, an asset register capitalized from posted bills or construction in
// progress with independent approval, append-only lifecycle events (transfer,
// split, merge, disposal, impairment, revaluation, capitalization) posted once
// and linked, and one schedule engine for depreciation, prepayments, deferred
// revenue, recurring drafts and employee deductions: deterministic lines with
// the rounding residue in the final period, prospective versions that never
// rewrite a posted period, runs executed by the worker under the explicit
// revocable schedule.execute authority, a locked period raising a task instead
// of a bypass, and memo book/tax layers per asset and period.
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,enqueueJob,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {linkEvidence} from './evidence.mjs';
import {micros,decimal,signedMicros} from './ledger.mjs';

const MICRO=1000000n;
const money=v=>decimal(micros(String(v)),2);
const dec=v=>decimal(v,2);
// Half-up to cents for a non-negative micro amount.
const roundCents=v=>((v+5000n)/10000n)*10000n;
// Exact a*num/den rounded half-up to cents.
const ratio=(a,num,den)=>{const scaled=a*num;const cents=(scaled+den*5000n)/(den*10000n);return cents*10000n;};

// ---------------------------------------------------------------------------
// Calendar helpers (dates as 'YYYY-MM-DD' strings; months as 'YYYY-MM')
// ---------------------------------------------------------------------------
const ym=d=>d.slice(0,7);
const addMonths=(month,n)=>{const [y,m]=month.split('-').map(Number);const t=y*12+(m-1)+n;return String(Math.floor(t/12)).padStart(4,'0')+'-'+String((t%12)+1).padStart(2,'0');};
const monthStart=month=>month+'-01';
const monthEnd=month=>{const [y,m]=month.split('-').map(Number);return month+'-'+String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0');};
const dayNumber=d=>{const [y,m,dd]=d.split('-').map(Number);return Math.round(Date.UTC(y,m-1,dd)/86400000);};
const daysInclusive=(a,b)=>dayNumber(b)-dayNumber(a)+1;
const addDays=(d,n)=>new Date((dayNumber(d)+n)*86400000).toISOString().slice(0,10);
const plusMonths=(d,n)=>{const m=addMonths(ym(d),n);const dd=Math.min(Number(d.slice(8)),Number(monthEnd(m).slice(8)));return m+'-'+String(dd).padStart(2,'0');};
const monthsBetween=(a,b)=>{const [ya,ma]=a.split('-').map(Number),[yb,mb]=b.split('-').map(Number);return (yb*12+mb)-(ya*12+ma)+1;};
const isDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v));

// ---------------------------------------------------------------------------
// Deterministic line generation (pure; exported for the acceptance tests)
// ---------------------------------------------------------------------------
// Periods are calendar months. Monthly convention: every month from the
// start month counts in full. Daily (actual/actual) policy: each month's
// share is its day count over the total days of the service window, so a
// leap day counts. Amounts are micros (BigInt); the residue lands in the
// final period so the lines always sum to the basis exactly.
function segments(startDate,months,proration){
 const out=[];const first=ym(startDate);
 if(proration==='daily'){
  // The window is exactly `months` months long from the start date.
  const endDate=addDays(plusMonths(startDate,months),-1);
  const total=daysInclusive(startDate,endDate);
  let cursor=startDate;
  while(dayNumber(cursor)<=dayNumber(endDate)){const m=ym(cursor);const segEnd=dayNumber(monthEnd(m))<dayNumber(endDate)?monthEnd(m):endDate;out.push({periodStart:monthStart(m),periodEnd:monthEnd(m),from:cursor,to:segEnd,days:daysInclusive(cursor,segEnd),totalDays:total});cursor=addDays(segEnd,1);}
  return out;
 }
 for(let i=0;i<months;i++){const m=addMonths(first,i);out.push({periodStart:monthStart(m),periodEnd:monthEnd(m),days:1,totalDays:months});}
 return out;
}
function withResidue(segs,amounts,total){
 // Clamp the running sum to the total and put the residue on the last line.
 let remaining=total;const out=[];
 segs.forEach((s,i)=>{let a=amounts[i];if(a<0n)a=0n;if(i===segs.length-1)a=remaining;else if(a>remaining)a=remaining;remaining-=a;out.push({periodStart:s.periodStart,periodEnd:s.periodEnd,amount:a});});
 return out;
}
export function depreciationLines({cost,residual,months,startDate,method,proration='monthly',annualRate=null,openingAccumulated=0n}){
 const depreciable=cost-residual-openingAccumulated;
 if(months<1)fail('VALIDATION_FAILED','The remaining life must be at least one month.',{fieldErrors:[{path:'usefulLifeMonths',message:'At least one month remains'}]});
 if(depreciable<0n)fail('VALIDATION_FAILED','The accumulated depreciation already exceeds the depreciable amount.');
 if(proration==='daily'&&method!=='straight_line')fail('VALIDATION_FAILED','Daily actual/actual proration applies to straight-line depreciation.',{fieldErrors:[{path:'policyVersion',message:'Daily proration is straight-line only'}]});
 const segs=segments(startDate,months,proration);
 if(method==='straight_line'){
  return withResidue(segs,segs.map(s=>proration==='daily'?ratio(depreciable,BigInt(s.days),BigInt(s.totalDays)):ratio(depreciable,1n,BigInt(months))),depreciable);
 }
 if(method==='declining_balance'){
  // The approved annual rate (default double-declining, 24/months per year) applies to the opening carrying amount; floored at residual; the final month takes the remainder.
  const [rateNum,rateDen]=annualRate?[micros(String(annualRate)),12n*MICRO]:[2n,BigInt(months)];
  let carrying=cost-openingAccumulated;const amounts=[];
  segs.forEach((s,i)=>{let a=i===segs.length-1?carrying-residual:ratio(carrying,rateNum,rateDen);if(a>carrying-residual)a=carrying-residual;if(a<0n)a=0n;amounts.push(a);carrying-=a;});
  return withResidue(segs,amounts,depreciable);
 }
 if(method==='sum_of_years'){
  // Annual weights (n, n-1, ... over the digits, fractional final year) then a documented even monthly allocation inside each year with the year's residue in its last month.
  const M=BigInt(months);const years=Math.ceil(months/12);const amounts=[];let left=depreciable;
  for(let y=1;y<=years;y++){
   const weight=M-12n*BigInt(y-1);const annual=y===years?left:ratio(depreciable,weight*24n,M*(M+12n));const take=annual>left?left:annual;left-=take;
   const monthsInYear=Math.min(12,months-12*(y-1));const per=ratio(take,1n,BigInt(monthsInYear));let yl=take;
   for(let m=0;m<monthsInYear;m++){const a=m===monthsInYear-1?yl:(per>yl?yl:per);yl-=a;amounts.push(a);}
  }
  return withResidue(segs,amounts,depreciable);
 }
 fail('VALIDATION_FAILED','Unknown depreciation method.');
}
export function ratableLines({basis,startDate,endDate,proration='monthly',openingRecognized=0n}){
 const remaining=basis-openingRecognized;
 if(remaining<0n)fail('VALIDATION_FAILED','The recognized amount already exceeds the basis.');
 if(proration==='daily'){
  const total=daysInclusive(startDate,endDate);const segs=[];let cursor=startDate;
  while(dayNumber(cursor)<=dayNumber(endDate)){const m=ym(cursor);const segEnd=dayNumber(monthEnd(m))<dayNumber(endDate)?monthEnd(m):endDate;segs.push({periodStart:monthStart(m),periodEnd:monthEnd(m),days:daysInclusive(cursor,segEnd)});cursor=addDays(segEnd,1);}
  return withResidue(segs,segs.map(s=>ratio(remaining,BigInt(s.days),BigInt(total))),remaining);
 }
 const n=monthsBetween(startDate,endDate);const segs=[];for(let i=0;i<n;i++){const m=addMonths(ym(startDate),i);segs.push({periodStart:monthStart(m),periodEnd:monthEnd(m)});}
 return withResidue(segs,segs.map(()=>ratio(remaining,1n,BigInt(n))),remaining);
}
export function recurringLines({amount,startDate,endDate}){
 const n=monthsBetween(startDate,endDate);const out=[];for(let i=0;i<n;i++){const m=addMonths(ym(startDate),i);out.push({periodStart:monthStart(m),periodEnd:monthEnd(m),amount});}return out;
}

// ---------------------------------------------------------------------------
// Capability, profile and policies
// ---------------------------------------------------------------------------
export async function requireAssets(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='assets' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The assets capability is not active for this entity.');
}
export async function assetProfile(tx,ctx,entityId){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='asset_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved asset profile (asset clearing and disposal clearing accounts) is required.');
 const p=row.payload;
 for(const k of ['assetClearingAccountId','disposalClearingAccountId'])if(!isUuid(p[k]))fail('RULE_PROFILE_NOT_APPROVED','The asset profile lacks '+k+'.');
 return {assetClearingAccountId:p.assetClearingAccountId,disposalClearingAccountId:p.disposalClearingAccountId,profileVersion:typeof p.profileVersion==='string'?p.profileVersion:'assets-1'};
}
// A recognition policy is an approved settings version of kind
// recognition_policy_<code>: proration, the declining-balance rate, a method
// override, the account mapping for prepayments, deferred revenue and
// deductions. The schedule names the code as its policyVersion.
export async function recognitionPolicy(tx,ctx,entityId,code){
 if(!/^[a-z][a-z0-9_]{0,40}$/.test(String(code)))fail('VALIDATION_FAILED','policyVersion names a recognition policy code (lowercase letters, digits, underscores).',{fieldErrors:[{path:'policyVersion',message:'Policy code'}]});
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind=$3 and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId,'recognition_policy_'+code])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','No approved recognition policy '+code+' exists; the controller approves it under settings kind recognition_policy_'+code+'.',{fieldErrors:[{path:'policyVersion',message:'Approved policy required'}]});
 const p=row.payload;
 return {code,kind:typeof p.kind==='string'?p.kind:null,method:['straight_line','declining_balance','sum_of_years'].includes(p.method)?p.method:null,proration:p.proration==='daily'?'daily':'monthly',annualRate:typeof p.annualRate==='string'&&/^\d(\.\d{1,6})?$/.test(p.annualRate)?p.annualRate:null,debitAccountId:isUuid(p.debitAccountId)?p.debitAccountId:null,creditAccountId:isUuid(p.creditAccountId)?p.creditAccountId:null,branchId:isUuid(p.branchId)?p.branchId:null};
}

// ---------------------------------------------------------------------------
// Asset classes (the controller approves them: asset.approve)
// ---------------------------------------------------------------------------
const classResource=r=>({id:r.id,version:Number(r.version),code:r.code,name:r.name,bookId:r.book_id,assetAccountId:r.asset_account_id,accumulatedDepreciationAccountId:r.accumulated_depreciation_account_id,depreciationExpenseAccountId:r.depreciation_expense_account_id,disposalGainAccountId:r.disposal_gain_account_id,disposalLossAccountId:r.disposal_loss_account_id,cipAccountId:r.cip_account_id,revaluationSurplusAccountId:r.revaluation_surplus_account_id,defaultMethod:r.default_method,defaultUsefulLifeMonths:r.default_useful_life_months,taxMethod:r.tax_method,taxUsefulLifeMonths:r.tax_useful_life_months,state:r.status,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
export async function createAssetClass(tx,ctx,entityId,input){
 requirePermission(ctx,'asset.approve');requireEntity(ctx,entityId);await requireAssets(tx,ctx,entityId);
 const ids=['assetAccountId','accumulatedDepreciationAccountId','depreciationExpenseAccountId','disposalGainAccountId','disposalLossAccountId','cipAccountId','revaluationSurplusAccountId'].map(k=>input[k]).filter(Boolean);
 for(const id of ids)if(!isUuid(id))fail('VALIDATION_FAILED','Account ids must be UUIDs.');
 const accounts=(await tx.query("select id,category,status,book_id from lara.accounts where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[])",[ctx.tenantId,entityId,ids])).rows;
 const need=(id,cats,path)=>{const a=accounts.find(x=>x.id===id);if(!a||a.status!=='active'||!cats.includes(a.category))fail('VALIDATION_FAILED','Account for '+path+' must be an active '+cats.join(' or ')+' account.',{fieldErrors:[{path,message:cats.join('/')}]});return a;};
 const asset=need(input.assetAccountId,['asset'],'assetAccountId');need(input.accumulatedDepreciationAccountId,['asset'],'accumulatedDepreciationAccountId');need(input.depreciationExpenseAccountId,['expense'],'depreciationExpenseAccountId');need(input.disposalGainAccountId,['income'],'disposalGainAccountId');need(input.disposalLossAccountId,['expense'],'disposalLossAccountId');
 if(input.cipAccountId)need(input.cipAccountId,['asset'],'cipAccountId');if(input.revaluationSurplusAccountId)need(input.revaluationSurplusAccountId,['equity','income'],'revaluationSurplusAccountId');
 if(accounts.some(a=>a.book_id!==asset.book_id))fail('VALIDATION_FAILED','All class accounts belong to one book.');
 if(!['straight_line','declining_balance','sum_of_years'].includes(input.defaultMethod))fail('VALIDATION_FAILED','defaultMethod is straight_line, declining_balance or sum_of_years.',{fieldErrors:[{path:'defaultMethod',message:'Unknown method'}]});
 const life=Number(input.defaultUsefulLifeMonths);if(!Number.isInteger(life)||life<1)fail('VALIDATION_FAILED','defaultUsefulLifeMonths is a positive integer.',{fieldErrors:[{path:'defaultUsefulLifeMonths',message:'Positive integer'}]});
 const taxLife=input.taxUsefulLifeMonths==null?null:Number(input.taxUsefulLifeMonths);if(taxLife!==null&&(!Number.isInteger(taxLife)||taxLife<1))fail('VALIDATION_FAILED','taxUsefulLifeMonths is a positive integer.');
 if(input.taxMethod&&!['straight_line','declining_balance','sum_of_years'].includes(input.taxMethod))fail('VALIDATION_FAILED','Unknown taxMethod.');
 const row=(await tx.query('insert into lara.asset_classes(tenant_id,entity_id,book_id,code,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,disposal_gain_account_id,disposal_loss_account_id,cip_account_id,revaluation_surplus_account_id,default_method,default_useful_life_months,tax_method,tax_useful_life_months,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *',[ctx.tenantId,entityId,asset.book_id,String(input.code).toUpperCase(),String(input.name).trim(),input.assetAccountId,input.accumulatedDepreciationAccountId,input.depreciationExpenseAccountId,input.disposalGainAccountId,input.disposalLossAccountId,input.cipAccountId||null,input.revaluationSurplusAccountId||null,input.defaultMethod,life,input.taxMethod||null,taxLife,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'asset_class.create',resourceType:'asset_class',resourceId:row.id,resourceVersion:1});
 return classResource(row);
}
export async function listAssetClasses(tx,ctx,entityId,query){
 requirePermission(ctx,'asset.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.asset_classes where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,classResource,scope);
}
async function classFor(tx,ctx,entityId,id){if(!isUuid(id))fail('VALIDATION_FAILED','classId must be a UUID.',{fieldErrors:[{path:'classId',message:'UUID'}]});const c=(await tx.query("select * from lara.asset_classes where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,id])).rows[0];if(!c)fail('NOT_FOUND','Asset class not found.');return c;}

// ---------------------------------------------------------------------------
// Asset register
// ---------------------------------------------------------------------------
const assetMaterial=i=>({tag:i.tag,classId:i.classId,cost:money(i.cost),residual:money(i.residual),currency:i.currency,inServiceDate:i.inServiceDate,usefulLifeMonths:i.usefulLifeMonths,method:i.method,sourceDocumentId:i.sourceDocumentId,locationId:i.locationId||null,custodianId:i.custodianId||null});
const assetResource=r=>resource(r,{state:r.state,tag:r.tag,classId:r.class_id,cost:money(String(r.cost)),residual:money(String(r.residual)),currency:r.currency,inServiceDate:iso(r.in_service_date),usefulLifeMonths:r.useful_life_months,method:r.method,sourceDocumentId:r.source_document_id||r.parent_id,...(r.location_id?{locationId:r.location_id}:{}),...(r.custodian_id?{custodianId:r.custodian_id}:{})});
async function loadAsset(tx,ctx,entityId,id,{lock=false}={}){if(!isUuid(id))fail('NOT_FOUND','Asset not found.');const row=(await tx.query('select * from lara.assets where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Asset not found.');return row;}
// The capitalization source is a posted bill whose lines on the asset
// clearing account cover this asset's cost net of the assets already drawn.
async function checkAssetInput(tx,ctx,entityId,input,{excludeId=null}={}){
 const klass=await classFor(tx,ctx,entityId,input.classId);
 const profile=await assetProfile(tx,ctx,entityId);
 const cost=micros(input.cost),residual=micros(input.residual);
 if(cost<=0n)fail('VALIDATION_FAILED','Cost must be positive.',{fieldErrors:[{path:'cost',message:'Positive'}]});
 if(residual>cost)fail('VALIDATION_FAILED','Residual cannot exceed cost.',{fieldErrors:[{path:'residual',message:'At most the cost'}]});
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,klass.book_id])).rows[0];
 if(input.currency!==book.functional_currency)fail('VALIDATION_FAILED','Asset costs are functional-currency amounts ('+book.functional_currency+'); foreign-currency purchases are translated on the bill.',{fieldErrors:[{path:'currency',message:book.functional_currency}]});
 const doc=(await tx.query("select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3 and kind='bill'",[ctx.tenantId,entityId,input.sourceDocumentId])).rows[0];
 if(!doc)fail('NOT_FOUND','The source bill was not found.',{fieldErrors:[{path:'sourceDocumentId',message:'Posted bill'}]});
 if(doc.state!=='posted')fail('STATE_CONFLICT','Assets are capitalized from posted bills; post the bill first.');
 const cover=micros((await tx.query('select coalesce(sum(net),0)::text as v from lara.document_lines where tenant_id=$1 and document_id=$2 and account_id=$3',[ctx.tenantId,doc.id,profile.assetClearingAccountId])).rows[0].v);
 if(cover===0n)fail('VALIDATION_FAILED','The bill has no line on the asset clearing account; capitalization draws on that line.',{fieldErrors:[{path:'sourceDocumentId',message:'No asset clearing line'}]});
 const params=[ctx.tenantId,doc.id];let ex='';if(excludeId){params.push(excludeId);ex=' and id<>$3';}
 const drawn=micros((await tx.query("select coalesce(sum(cost),0)::text as v from lara.assets where tenant_id=$1 and source_document_id=$2 and state in ('draft','approved','disposed','merged')"+ex,params)).rows[0].v);
 if(drawn+cost>cover)fail('VALIDATION_FAILED','The assets drawn from this bill ('+dec(drawn+cost)+') exceed its asset clearing lines ('+dec(cover)+').',{fieldErrors:[{path:'cost',message:'Exceeds the bill'}]});
 if(input.locationId){if(!isUuid(input.locationId))fail('VALIDATION_FAILED','locationId must be a UUID.');const b=(await tx.query("select 1 from lara.branches where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,input.locationId])).rowCount;if(!b)fail('NOT_FOUND','Location (branch) not found.');}
 if(input.custodianId){if(!isUuid(input.custodianId))fail('VALIDATION_FAILED','custodianId must be a UUID.');const p=(await tx.query('select 1 from lara.party where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.custodianId])).rowCount;if(!p)fail('NOT_FOUND','Custodian party not found.');}
 return {klass,profile,book,doc,cost,residual};
}
export async function createAsset(tx,ctx,entityId,input){
 requirePermission(ctx,'asset.create');requireEntity(ctx,entityId);assertInput('AssetCreate',input);await requireAssets(tx,ctx,entityId);
 const {klass,cost,residual}=await checkAssetInput(tx,ctx,entityId,input);
 const stage=klass.cip_account_id?'cip':'in_service';
 const row=(await tx.query('insert into lara.assets(tenant_id,entity_id,book_id,class_id,tag,cost,residual,currency,in_service_date,useful_life_months,method,source_document_id,location_id,custodian_id,stage,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *',[ctx.tenantId,entityId,klass.book_id,klass.id,input.tag.trim(),decimal(cost,6),decimal(residual,6),input.currency,input.inServiceDate,input.usefulLifeMonths,input.method,input.sourceDocumentId,input.locationId||null,input.custodianId||null,stage,contentHash(assetMaterial(input)),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'asset.create',resourceType:'asset',resourceId:row.id,resourceVersion:1,afterRef:row.content_hash});
 return assetResource(row);
}
export async function updateAsset(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'asset.edit');requireEntity(ctx,entityId);assertInput('AssetCreate',input);
 const row=await loadAsset(tx,ctx,entityId,id,{lock:true});expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Only draft assets are edited; an approved asset changes through linked events and prospective schedule versions.');
 const {klass,cost,residual}=await checkAssetInput(tx,ctx,entityId,input,{excludeId:id});
 const updated=(await tx.query('update lara.assets set class_id=$3,book_id=$4,tag=$5,cost=$6,residual=$7,currency=$8,in_service_date=$9,useful_life_months=$10,method=$11,source_document_id=$12,location_id=$13,custodian_id=$14,stage=$15,content_hash=$16,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,klass.id,klass.book_id,input.tag.trim(),decimal(cost,6),decimal(residual,6),input.currency,input.inServiceDate,input.usefulLifeMonths,input.method,input.sourceDocumentId,input.locationId||null,input.custodianId||null,klass.cip_account_id?'cip':'in_service',contentHash(assetMaterial(input))])).rows[0];
 await audit(tx,ctx,{entityId,action:'asset.edit',resourceType:'asset',resourceId:id,resourceVersion:Number(updated.version),afterRef:updated.content_hash});
 return assetResource(updated);
}
export async function getAsset(tx,ctx,entityId,id){requirePermission(ctx,'asset.read');requireEntity(ctx,entityId);return assetResource(await loadAsset(tx,ctx,entityId,id));}
export async function listAssets(tx,ctx,entityId,query){
 requirePermission(ctx,'asset.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.state){params.push(String(query.state));where+=' and state=$'+params.length;}
 if(query?.classId){if(!isUuid(query.classId))fail('VALIDATION_FAILED','classId must be a UUID.');params.push(query.classId);where+=' and class_id=$'+params.length;}
 const rows=(await tx.query('select * from lara.assets where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,assetResource,scope);
}
const branchFor=async(tx,ctx,entityId,asset)=>asset.location_id||(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and status='active' order by created_at limit 1",[ctx.tenantId,entityId])).rows[0]?.id;
const postEntry=async(tx,ctx,entityId,{bookId,sourceType,sourceId,sourceVersion,purpose='posting',date,description,currency,lines,commandId=null})=>(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId,sourceType,sourceId,sourceVersion,purpose,accountingDate:date,documentDate:date,description,currency,manual:false,postingActor:ctx.principalId,commandId,lines})])).rows[0].id;
const line=(accountId,branchId,debit,credit)=>({accountId,branchId,dimensions:{},debit:decimal(debit,6),credit:decimal(credit,6)});
// Approval by another principal capitalizes the asset: Dr asset (or CIP) account, Cr asset clearing.
export async function approveAsset(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'asset.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadAsset(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Only draft assets are decided.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot approve the asset.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The asset changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'){if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});const rej=(await tx.query("update lara.assets set state='rejected' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];await audit(tx,ctx,{entityId,action:'asset.reject',resourceType:'asset',resourceId:id,resourceVersion:Number(rej.version),reason:input.reason});return {resourceType:'asset',resourceId:id,version:Number(rej.version),state:'rejected',journalEntryIds:[]};}
 const klass=await classFor(tx,ctx,entityId,row.class_id);const profile=await assetProfile(tx,ctx,entityId);
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,row.book_id])).rows[0];
 const branchId=await branchFor(tx,ctx,entityId,row);const cost=micros(String(row.cost));
 const target=row.stage==='cip'?klass.cip_account_id:klass.asset_account_id;
 const entryId=await postEntry(tx,ctx,entityId,{bookId:row.book_id,sourceType:'asset',sourceId:id,sourceVersion:Number(row.content_version),date:iso(row.in_service_date),description:'Capitalization of '+row.tag+(row.stage==='cip'?' (construction in progress)':''),currency:book.functional_currency,lines:[line(target,branchId,cost,0n),line(profile.assetClearingAccountId,branchId,0n,cost)],commandId});
 const updated=(await tx.query("update lara.assets set state='approved',approved_by=$3,capitalized_entry_id=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId,entryId])).rows[0];
 await audit(tx,ctx,{entityId,action:'asset.approve',resourceType:'asset',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'asset',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'asset.capitalized.v1',payload:{assetId:id,entryId,stage:row.stage}});
 return {resourceType:'asset',resourceId:id,version:Number(updated.version),state:'approved',journalEntryIds:[entryId]};
}

// ---------------------------------------------------------------------------
// Lifecycle events: each posts once and links to the asset; the register
// carries cost and accumulated depreciation forward; later schedule lines
// regenerate prospectively.
// ---------------------------------------------------------------------------
async function liveScheduleFor(tx,ctx,assetId){return (await tx.query("select * from lara.recognition_schedules where tenant_id=$1 and kind='depreciation' and source_id=$2 and state not in ('rejected','completed') for update",[ctx.tenantId,assetId])).rows[0];}
async function endSchedule(tx,ctx,schedule,fromPeriod){await cancelPlanned(tx,ctx,schedule.id,fromPeriod);await tx.query('update lara.recognition_schedules set state=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,schedule.id,schedule.state==='draft'?'rejected':'completed']);}
async function cancelPlanned(tx,ctx,scheduleId,fromPeriod){await tx.query("update lara.schedule_lines set state='cancelled' where tenant_id=$1 and schedule_id=$2 and state in ('planned','blocked') and period_start>=$3",[ctx.tenantId,scheduleId,fromPeriod]);}
export async function recordAssetEvent(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'asset.events');requireEntity(ctx,entityId);assertInput('AssetEvent',input);
 const row=await loadAsset(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='approved')fail('STATE_CONFLICT','Lifecycle events apply to approved assets.');
 const klass=await classFor(tx,ctx,entityId,row.class_id);const profile=await assetProfile(tx,ctx,entityId);
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,row.book_id])).rows[0];
 const branchId=await branchFor(tx,ctx,entityId,row);
 const seq=Number((await tx.query('select coalesce(max(sequence),0)+1 as n from lara.asset_events where tenant_id=$1 and asset_id=$2',[ctx.tenantId,id])).rows[0].n);
 const cost=micros(String(row.cost)),accumulated=micros(String(row.accumulated_depreciation)),residual=micros(String(row.residual));
 const last=(await tx.query('select max(effective_date)::text as d from lara.asset_events where tenant_id=$1 and asset_id=$2',[ctx.tenantId,id])).rows[0].d;
 if(last&&dayNumber(input.effectiveDate)<dayNumber(last))fail('VALIDATION_FAILED','Events are recorded in date order; the last event is dated '+last+'.',{fieldErrors:[{path:'effectiveDate',message:'On or after '+last}]});
 if(dayNumber(input.effectiveDate)<dayNumber(iso(row.in_service_date)))fail('VALIDATION_FAILED','The event cannot precede the in-service date.',{fieldErrors:[{path:'effectiveDate',message:'On or after in-service'}]});
 const schedule=await liveScheduleFor(tx,ctx,id);
 const postedThrough=schedule?(await tx.query("select max(period_start)::text as d from lara.schedule_lines where tenant_id=$1 and schedule_id=$2 and state='posted'",[ctx.tenantId,schedule.id])).rows[0].d:null;
 const eventMonth=monthStart(ym(input.effectiveDate));
 if(postedThrough&&dayNumber(eventMonth)<=dayNumber(postedThrough)&&input.kind!=='transfer')fail('STATE_CONFLICT','Depreciation is posted through '+postedThrough.slice(0,7)+'; posted periods are never rewritten. Date the event in the first open period.',{fieldErrors:[{path:'effectiveDate',message:'After '+postedThrough.slice(0,7)}]});
 let costAfter=cost,accAfter=accumulated,entryId=null,lines=[],description='',extra={};
 // Impairment, revaluation and split carry a positive amount; a disposal without proceeds is a scrapping (proceeds zero).
 const amount=input.amount!=null?micros(input.amount):null,proceeds=input.proceeds!=null?micros(input.proceeds):0n;
 if(['impairment','revaluation','split'].includes(input.kind)&&!(amount>0n))fail('VALIDATION_FAILED','A '+input.kind+' names a positive amount.',{fieldErrors:[{path:'amount',message:'Positive amount required'}]});
 if(proceeds<0n)fail('VALIDATION_FAILED','Proceeds are not negative.',{fieldErrors:[{path:'proceeds',message:'Not negative'}]});
 switch(input.kind){
  case 'transfer':{if(!input.targetLocationId)fail('VALIDATION_FAILED','A transfer names the target location.',{fieldErrors:[{path:'targetLocationId',message:'Required'}]});const b=(await tx.query("select 1 from lara.branches where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,input.targetLocationId])).rowCount;if(!b)fail('NOT_FOUND','Target location not found.');extra.location_id=input.targetLocationId;break;}
  case 'capitalize_cip':{if(row.stage!=='cip')fail('STATE_CONFLICT','Only construction in progress is capitalized into service.');description='Transfer of '+row.tag+' from construction in progress into service';lines=[line(klass.asset_account_id,branchId,cost,0n),line(klass.cip_account_id,branchId,0n,cost)];extra.stage='in_service';extra.in_service_date=input.effectiveDate;break;}
  case 'impairment':{if(row.stage==='cip')fail('STATE_CONFLICT','Construction in progress is impaired after it enters service.');if(amount>cost-accumulated-residual)fail('VALIDATION_FAILED','Impairment cannot take the carrying amount below the residual ('+dec(cost-accumulated-residual)+' available).',{fieldErrors:[{path:'amount',message:'At most the carrying amount above residual'}]});description='Impairment of '+row.tag;lines=[line(klass.disposal_loss_account_id,branchId,amount,0n),line(klass.accumulated_depreciation_account_id,branchId,0n,amount)];accAfter=accumulated+amount;break;}
  case 'revaluation':{if(!klass.revaluation_surplus_account_id)fail('RULE_PROFILE_NOT_APPROVED','The class names no revaluation surplus account.');description='Revaluation of '+row.tag;lines=[line(klass.asset_account_id,branchId,amount,0n),line(klass.revaluation_surplus_account_id,branchId,0n,amount)];costAfter=cost+amount;break;}
  case 'disposal':{
   // Remove cost and accumulated depreciation; proceeds through the disposal clearing account; the difference is the gain or loss.
   const carrying=cost-accumulated;const diff=proceeds-carrying;description='Disposal of '+row.tag+' for '+dec(proceeds);
   lines=[line(klass.accumulated_depreciation_account_id,branchId,accumulated,0n),line(klass.asset_account_id,branchId,0n,cost)];
   if(proceeds>0n)lines.unshift(line(profile.disposalClearingAccountId,branchId,proceeds,0n));
   if(diff>0n)lines.push(line(klass.disposal_gain_account_id,branchId,0n,diff));else if(diff<0n)lines.push(line(klass.disposal_loss_account_id,branchId,-diff,0n));
   lines=lines.filter(l=>l.debit!=='0.000000'||l.credit!=='0.000000');
   extra.state='disposed';break;}
  case 'split':{
   if(amount>=cost)fail('VALIDATION_FAILED','The split portion must be less than the cost.',{fieldErrors:[{path:'amount',message:'Less than cost'}]});
   // Proportional accumulated depreciation, rounded, conserved with the parent.
   const childAcc=ratio(accumulated,amount,cost);const childRes=ratio(residual,amount,cost);
   const tag=row.tag+'-S'+seq;
   const child=(await tx.query("insert into lara.assets(tenant_id,entity_id,book_id,class_id,tag,cost,residual,currency,in_service_date,useful_life_months,method,source_document_id,location_id,custodian_id,stage,accumulated_depreciation,state,approved_by,capitalized_entry_id,parent_id,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'approved',$17,$18,$19,$20,$21) returning *",[ctx.tenantId,entityId,row.book_id,row.class_id,tag,decimal(amount,6),decimal(childRes,6),row.currency,row.in_service_date,row.useful_life_months,row.method,null,row.location_id,row.custodian_id,row.stage,decimal(childAcc,6),row.approved_by===ctx.principalId?row.created_by:row.approved_by,row.capitalized_entry_id,id,row.content_hash,ctx.principalId])).rows[0];
   costAfter=cost-amount;accAfter=accumulated-childAcc;extra.residual=residual-childRes;extra.child=child;break;}
  case 'merge':{
   if(!input.relatedAssetIds?.length)fail('VALIDATION_FAILED','A merge names the assets absorbed.',{fieldErrors:[{path:'relatedAssetIds',message:'At least one'}]});
   const others=(await tx.query("select * from lara.assets where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[]) and id<>$4 for update",[ctx.tenantId,entityId,input.relatedAssetIds,id])).rows;
   if(others.length!==input.relatedAssetIds.length)fail('NOT_FOUND','An absorbed asset was not found.');
   for(const o of others){if(o.state!=='approved')fail('STATE_CONFLICT','Only approved assets merge.');if(o.class_id!==row.class_id)fail('VALIDATION_FAILED','Merged assets share one class (one set of accounts).',{fieldErrors:[{path:'relatedAssetIds',message:'Same class'}]});}
   extra.merged=others;for(const o of others){costAfter+=micros(String(o.cost));accAfter+=micros(String(o.accumulated_depreciation));extra.residual=(extra.residual??residual)+micros(String(o.residual));}
   break;}
  default:fail('VALIDATION_FAILED','Unknown event kind.');
 }
 if(lines.length>=2)entryId=await postEntry(tx,ctx,entityId,{bookId:row.book_id,sourceType:'asset_event',sourceId:id,sourceVersion:seq,purpose:'posting',date:input.effectiveDate,description,currency:book.functional_currency,lines,commandId});
 const ev=(await tx.query('insert into lara.asset_events(tenant_id,entity_id,asset_id,sequence,kind,effective_date,amount,proceeds,related_asset_ids,target_location_id,reason,evidence_ids,posted_entry_id,cost_before,accumulated_before,cost_after,accumulated_after,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *',[ctx.tenantId,entityId,id,seq,input.kind,input.effectiveDate,amount==null?null:decimal(amount,6),proceeds==null?null:decimal(proceeds,6),input.relatedAssetIds||[],input.targetLocationId||null,input.reason.trim(),JSON.stringify(input.evidenceIds),entryId,decimal(cost,6),decimal(accumulated,6),decimal(costAfter,6),decimal(accAfter,6),ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'asset_event',ev.id,1);
 const taskIds=[];
 if(extra.child){await tx.query('insert into lara.asset_components(tenant_id,entity_id,parent_id,asset_id,event_id,cost,accumulated_depreciation,useful_life_months,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.tenantId,entityId,id,extra.child.id,ev.id,extra.child.cost,extra.child.accumulated_depreciation,row.useful_life_months,ctx.principalId]);}
 if(extra.merged){for(const o of extra.merged){await tx.query('insert into lara.asset_components(tenant_id,entity_id,parent_id,asset_id,event_id,cost,accumulated_depreciation,useful_life_months,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.tenantId,entityId,id,o.id,ev.id,o.cost,o.accumulated_depreciation,o.useful_life_months,ctx.principalId]);await tx.query("update lara.assets set state='merged' where tenant_id=$1 and id=$2",[ctx.tenantId,o.id]);const os=await liveScheduleFor(tx,ctx,o.id);if(os)await endSchedule(tx,ctx,os,eventMonth);}}
 const updated=(await tx.query("update lara.assets set cost=$3,accumulated_depreciation=$4,residual=$5,location_id=$6,stage=$7,in_service_date=$8,state=$9,content_hash=$10,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,decimal(costAfter,6),decimal(accAfter,6),decimal(extra.residual??residual,6),extra.location_id||row.location_id,extra.stage||row.stage,extra.in_service_date||iso(row.in_service_date),extra.state||row.state,contentHash({after:row.content_hash,event:ev.id})])).rows[0];
 // The live depreciation schedule follows: a disposal or merge ends it; impairment, revaluation and split regenerate the open periods prospectively.
 if(schedule){
  if(input.kind==='disposal')await endSchedule(tx,ctx,schedule,eventMonth);
  else if(['impairment','revaluation','split','merge'].includes(input.kind)){await regenerateProspective(tx,ctx,entityId,schedule,{asset:updated,effectiveFrom:eventMonth,reason:input.kind+' event '+ev.id,approvedBy:schedule.approved_by});}
 }
 await audit(tx,ctx,{entityId,action:'asset.event',resourceType:'asset',resourceId:id,resourceVersion:Number(updated.version),reason:input.kind+': '+input.reason.trim(),afterRef:entryId||ev.id});
 await emit(tx,ctx,{entityId,aggregateType:'asset',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'asset.event.v1',payload:{assetId:id,eventId:ev.id,kind:input.kind,entryId,childAssetId:extra.child?.id||null}});
 return {resourceType:'asset',resourceId:id,version:Number(updated.version),state:updated.state,journalEntryIds:entryId?[entryId]:[],taskIds,eventId:ev.id,childAssetId:extra.child?.id||null};
}
export async function assetEvents(tx,ctx,entityId,id){
 requirePermission(ctx,'asset.read');requireEntity(ctx,entityId);const row=await loadAsset(tx,ctx,entityId,id);
 const events=(await tx.query('select * from lara.asset_events where tenant_id=$1 and asset_id=$2 order by sequence',[ctx.tenantId,id])).rows;
 const components=(await tx.query('select c.*,a.tag from lara.asset_components c join lara.assets a on a.tenant_id=c.tenant_id and a.id=c.asset_id where c.tenant_id=$1 and c.parent_id=$2 order by c.created_at',[ctx.tenantId,id])).rows;
 const cost=micros(String(row.cost)),acc=micros(String(row.accumulated_depreciation));
 return {id,tag:row.tag,state:row.state,stage:row.stage,cost:dec(cost),accumulatedDepreciation:dec(acc),carryingAmount:dec(cost-acc),capitalizedEntryId:row.capitalized_entry_id,
  events:events.map(e=>({id:e.id,sequence:e.sequence,kind:e.kind,effectiveDate:iso(e.effective_date),amount:e.amount==null?null:money(String(e.amount)),proceeds:e.proceeds==null?null:money(String(e.proceeds)),relatedAssetIds:e.related_asset_ids||[],targetLocationId:e.target_location_id,reason:e.reason,costBefore:money(String(e.cost_before)),accumulatedBefore:money(String(e.accumulated_before)),costAfter:money(String(e.cost_after)),accumulatedAfter:money(String(e.accumulated_after)),entryId:e.posted_entry_id,createdAt:iso(e.created_at)})),
  components:components.map(c=>({assetId:c.asset_id,tag:c.tag,cost:money(String(c.cost)),accumulatedDepreciation:money(String(c.accumulated_depreciation)),usefulLifeMonths:c.useful_life_months}))};
}
// Book versus tax: the memo layers written at each depreciation posting.
export async function bookTaxLayers(tx,ctx,entityId,id){
 requirePermission(ctx,'asset.read');requireEntity(ctx,entityId);const row=await loadAsset(tx,ctx,entityId,id);const klass=await classFor(tx,ctx,entityId,row.class_id);
 const rows=(await tx.query('select * from lara.book_tax_layers where tenant_id=$1 and asset_id=$2 order by period_start,rule_version',[ctx.tenantId,id])).rows;
 const layers=rows.map(l=>({periodStart:iso(l.period_start),bookDepreciation:money(String(l.book_depreciation)),taxDepreciation:money(String(l.tax_depreciation)),bookValue:money(String(l.book_value)),taxValue:money(String(l.tax_value)),difference:dec(micros(String(l.book_value))-micros(String(l.tax_value))),lineId:l.line_id}));
 return {id,tag:row.tag,ruleVersion:taxRuleVersion(klass),layers,checksum:contentHash(layers)};
}
const taxRuleVersion=klass=>klass.tax_method?'tax:'+klass.tax_method+':'+(klass.tax_useful_life_months||klass.default_useful_life_months):'tax=book';

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------
const scheduleMaterial=i=>({kind:i.kind,sourceId:i.sourceId,startDate:i.startDate,endDate:i.endDate,basisAmount:money(i.basisAmount),currency:i.currency,policyVersion:i.policyVersion});
const scheduleResource=r=>resource(r,{state:r.state,kind:r.kind,sourceId:r.source_id,startDate:iso(r.start_date),endDate:iso(r.end_date),basisAmount:money(String(r.basis_amount)),currency:r.currency,policyVersion:r.policy_version});
async function loadSchedule(tx,ctx,entityId,id,{lock=false}={}){if(!isUuid(id))fail('NOT_FOUND','Schedule not found.');const row=(await tx.query('select * from lara.recognition_schedules where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Schedule not found.');return row;}
const SOURCE_TYPES={depreciation:'asset',prepayment:'document',deferred_revenue:'document',recurring_invoice:'document',recurring_journal:'journal_draft',employee_deduction:'party'};
// Resolves the source, the method, the mapping and the parameters the
// generator needs, by kind: depreciation from the asset and its class;
// prepayments and deferred revenue from a posted document line on the
// policy's balance-sheet account; recurring drafts from a template document
// or journal; deductions from an employee party.
async function resolveSchedule(tx,ctx,entityId,input,policy){
 const kind=input.kind;const basis=micros(input.basisAmount);
 if(basis<=0n)fail('VALIDATION_FAILED','basisAmount must be positive.',{fieldErrors:[{path:'basisAmount',message:'Positive'}]});
 if(dayNumber(input.endDate)<dayNumber(input.startDate))fail('VALIDATION_FAILED','endDate precedes startDate.',{fieldErrors:[{path:'endDate',message:'On or after startDate'}]});
 if(policy.kind&&policy.kind!==kind)fail('VALIDATION_FAILED','Policy '+policy.code+' is for '+policy.kind+' schedules.',{fieldErrors:[{path:'policyVersion',message:'Policy kind differs'}]});
 if(kind==='depreciation'){
  const asset=(await tx.query('select * from lara.assets where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.sourceId])).rows[0];
  if(!asset)fail('NOT_FOUND','Asset not found.',{fieldErrors:[{path:'sourceId',message:'Approved asset'}]});
  if(asset.state!=='approved')fail('STATE_CONFLICT','Depreciation schedules belong to approved assets.');
  if(asset.stage==='cip')fail('STATE_CONFLICT','Construction in progress does not depreciate; capitalize it into service first.');
  const klass=await classFor(tx,ctx,entityId,asset.class_id);
  const cost=micros(String(asset.cost)),residual=micros(String(asset.residual));
  if(basis!==cost-residual)fail('VALIDATION_FAILED','basisAmount equals cost less residual ('+dec(cost-residual)+').',{fieldErrors:[{path:'basisAmount',message:dec(cost-residual)}]});
  if(input.currency!==asset.currency)fail('VALIDATION_FAILED','Currency differs from the asset.',{fieldErrors:[{path:'currency',message:asset.currency}]});
  const start=iso(asset.in_service_date);
  if(input.startDate!==start)fail('VALIDATION_FAILED','Depreciation starts on the in-service date '+start+'.',{fieldErrors:[{path:'startDate',message:start}]});
  const expectedEnd=addDays(monthStart(addMonths(ym(start),asset.useful_life_months)),-1);
  if(input.endDate!==expectedEnd)fail('VALIDATION_FAILED','endDate for '+asset.useful_life_months+' months from '+start+' is '+expectedEnd+'.',{fieldErrors:[{path:'endDate',message:expectedEnd}]});
  return {sourceType:'asset',bookId:asset.book_id,method:asset.method,basis,mapping:{debitAccountId:klass.depreciation_expense_account_id,creditAccountId:klass.accumulated_depreciation_account_id,branchId:await branchFor(tx,ctx,entityId,asset)},parameters:{cost:dec(cost),residual:dec(residual),months:asset.useful_life_months,proration:policy.proration,annualRate:policy.annualRate,taxRuleVersion:taxRuleVersion(klass)},asset,klass};
 }
 if(kind==='prepayment'||kind==='deferred_revenue'){
  if(!policy.debitAccountId||!policy.creditAccountId)fail('RULE_PROFILE_NOT_APPROVED','Policy '+policy.code+' names no debit and credit accounts.');
  const doc=(await tx.query('select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.sourceId])).rows[0];
  if(!doc)fail('NOT_FOUND','Source document not found.',{fieldErrors:[{path:'sourceId',message:'Posted document'}]});
  if(doc.state!=='posted')fail('STATE_CONFLICT','Recognition schedules start from posted documents.');
  const balanceAccount=kind==='prepayment'?policy.creditAccountId:policy.debitAccountId;
  const cover=micros((await tx.query('select coalesce(sum(net),0)::text as v from lara.document_lines where tenant_id=$1 and document_id=$2 and account_id=$3',[ctx.tenantId,doc.id,balanceAccount])).rows[0].v);
  if(basis>cover)fail('VALIDATION_FAILED','The document carries '+dec(cover)+' on the deferral account; the basis cannot exceed it.',{fieldErrors:[{path:'basisAmount',message:'At most '+dec(cover)}]});
  if(input.currency!==doc.currency)fail('VALIDATION_FAILED','Currency differs from the document.',{fieldErrors:[{path:'currency',message:doc.currency}]});
  return {sourceType:'document',bookId:doc.book_id,method:'ratable',basis,mapping:{debitAccountId:policy.debitAccountId,creditAccountId:policy.creditAccountId,branchId:policy.branchId||doc.branch_id},parameters:{proration:policy.proration}};
 }
 if(kind==='recurring_invoice'){
  const doc=(await tx.query("select * from lara.documents where tenant_id=$1 and entity_id=$2 and id=$3 and kind='invoice'",[ctx.tenantId,entityId,input.sourceId])).rows[0];
  if(!doc)fail('NOT_FOUND','Template invoice not found.',{fieldErrors:[{path:'sourceId',message:'Invoice'}]});
  if(doc.state==='cancelled')fail('STATE_CONFLICT','A cancelled invoice is no template.');
  if(input.currency!==doc.currency)fail('VALIDATION_FAILED','Currency differs from the template.',{fieldErrors:[{path:'currency',message:doc.currency}]});
  return {sourceType:'document',bookId:doc.book_id,method:'recurring',basis,mapping:{branchId:doc.branch_id,partyId:doc.party_id},parameters:{}};
 }
 if(kind==='recurring_journal'){
  const j=(await tx.query('select * from lara.journal_drafts where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.sourceId])).rows[0];
  if(!j)fail('NOT_FOUND','Template journal not found.',{fieldErrors:[{path:'sourceId',message:'Journal'}]});
  if(input.currency!==j.currency)fail('VALIDATION_FAILED','Currency differs from the template.',{fieldErrors:[{path:'currency',message:j.currency}]});
  return {sourceType:'journal_draft',bookId:j.book_id,method:'recurring',basis,mapping:{},parameters:{}};
 }
 if(kind==='employee_deduction'){
  if(!policy.debitAccountId||!policy.creditAccountId)fail('RULE_PROFILE_NOT_APPROVED','Policy '+policy.code+' names no debit and credit accounts.');
  const p=(await tx.query("select p.id,p.legal_name from lara.party p where p.tenant_id=$1 and p.entity_id=$2 and p.id=$3 and exists (select 1 from lara.party_roles r where r.tenant_id=p.tenant_id and r.party_id=p.id and r.role='employee')",[ctx.tenantId,entityId,input.sourceId])).rows[0];
  if(!p)fail('NOT_FOUND','Employee party not found.',{fieldErrors:[{path:'sourceId',message:'Employee'}]});
  const book=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary'",[ctx.tenantId,entityId])).rows[0];
  const branch=policy.branchId||(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and status='active' order by created_at limit 1",[ctx.tenantId,entityId])).rows[0]?.id;
  return {sourceType:'party',bookId:book.id,method:'ratable',basis,mapping:{debitAccountId:policy.debitAccountId,creditAccountId:policy.creditAccountId,branchId:branch,employeeName:p.legal_name},parameters:{proration:policy.proration}};
 }
 fail('VALIDATION_FAILED','Unknown schedule kind.');
}
function generate(version){
 const p=version.parameters||{};const basis=micros(String(version.basis_amount));const opening=micros(String(version.opening_recognized));
 if(version.method==='recurring')return recurringLines({amount:basis,startDate:iso(version.effective_from),endDate:iso(version.end_date)});
 if(version.method==='ratable')return ratableLines({basis,startDate:iso(version.effective_from),endDate:iso(version.end_date),proration:p.proration||'monthly',openingRecognized:opening});
 const months=monthsBetween(iso(version.effective_from),iso(version.end_date));
 return depreciationLines({cost:micros(String(p.cost)),residual:micros(String(p.residual)),months,startDate:iso(version.effective_from),method:version.method,proration:p.proration||'monthly',annualRate:p.annualRate||null,openingAccumulated:opening});
}
const linesChecksum=lines=>contentHash(lines.map(l=>[l.periodStart,dec(l.amount)]));
async function writeLines(tx,ctx,entityId,schedule,version,lines){
 // Planned and blocked lines from the effective period on are replaced; posted and drafted lines stay.
 await tx.query("delete from lara.schedule_lines where tenant_id=$1 and schedule_id=$2 and state in ('planned','blocked','cancelled') and period_start>=$3",[ctx.tenantId,schedule.id,iso(version.effective_from)]);
 const executed=(await tx.query("select period_start::text as d from lara.schedule_lines where tenant_id=$1 and schedule_id=$2 and state in ('posted','drafted')",[ctx.tenantId,schedule.id])).rows.map(r=>r.d);
 const offset=Number((await tx.query('select coalesce(max(sequence),0) as n from lara.schedule_lines where tenant_id=$1 and schedule_id=$2',[ctx.tenantId,schedule.id])).rows[0].n);
 for(const l of lines)if(executed.includes(l.periodStart))fail('STATE_CONFLICT','Period '+l.periodStart.slice(0,7)+' is already executed; the version starts after it.');
 if(lines.length)await tx.query('insert into lara.schedule_lines(tenant_id,entity_id,schedule_id,version_id,sequence,period_start,period_end,amount,account_mapping) select $1,$2,$3,$4,s,ps::date,pe::date,a::numeric,$9::jsonb from unnest($5::int[],$6::text[],$7::text[],$8::text[]) as t(s,ps,pe,a)',[ctx.tenantId,entityId,schedule.id,version.id,lines.map((_,i)=>offset+i+1),lines.map(l=>l.periodStart),lines.map(l=>l.periodEnd),lines.map(l=>decimal(l.amount,6)),JSON.stringify(version.mapping)]);
}
async function insertVersion(tx,ctx,entityId,schedule,{versionNo,effectiveFrom,startDate,endDate,method,basis,opening,policyVersion,mapping,parameters,reason,state='draft',approvedBy=null}){
 const draft={effective_from:effectiveFrom,end_date:endDate,method,basis_amount:decimal(basis,6),opening_recognized:decimal(opening,6),parameters,mapping};
 const lines=generate(draft);
 const checksum=linesChecksum(lines);
 const row=(await tx.query('insert into lara.schedule_versions(tenant_id,entity_id,schedule_id,version_no,effective_from,start_date,end_date,method,basis_amount,opening_recognized,policy_version,mapping,parameters,reason,state,approved_by,checksum,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *',[ctx.tenantId,entityId,schedule.id,versionNo,effectiveFrom,startDate,endDate,method,decimal(basis,6),decimal(opening,6),policyVersion,JSON.stringify(mapping),JSON.stringify(parameters),reason,state,approvedBy,checksum,ctx.principalId])).rows[0];
 await writeLines(tx,ctx,entityId,schedule,row,lines);
 return {row,lines};
}
export async function createSchedule(tx,ctx,entityId,input){
 requirePermission(ctx,'schedule.create');requireEntity(ctx,entityId);assertInput('ScheduleCreate',input);await requireAssets(tx,ctx,entityId);
 const policy=await recognitionPolicy(tx,ctx,entityId,input.policyVersion);
 const r=await resolveSchedule(tx,ctx,entityId,input,policy);
 const dup=(await tx.query("select 1 from lara.recognition_schedules where tenant_id=$1 and entity_id=$2 and kind=$3 and source_id=$4 and state not in ('rejected','completed')",[ctx.tenantId,entityId,input.kind,input.sourceId])).rowCount;
 if(dup)fail('STATE_CONFLICT','A live '+input.kind+' schedule already exists for this source; modify it (a prospective version) instead.');
 const row=(await tx.query('insert into lara.recognition_schedules(tenant_id,entity_id,book_id,kind,source_type,source_id,start_date,end_date,basis_amount,currency,method,policy_version,mapping,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *',[ctx.tenantId,entityId,r.bookId,input.kind,r.sourceType,input.sourceId,input.startDate,input.endDate,decimal(r.basis,6),input.currency,r.method,input.policyVersion,JSON.stringify(r.mapping),contentHash(scheduleMaterial(input)),ctx.principalId])).rows[0];
 await insertVersion(tx,ctx,entityId,row,{versionNo:1,effectiveFrom:input.startDate,startDate:input.startDate,endDate:input.endDate,method:r.method,basis:r.basis,opening:0n,policyVersion:input.policyVersion,mapping:r.mapping,parameters:r.parameters,reason:'Initial schedule'});
 await audit(tx,ctx,{entityId,action:'schedule.create',resourceType:'recognition_schedule',resourceId:row.id,resourceVersion:1,afterRef:row.content_hash});
 return scheduleResource(row);
}
// A draft schedule is replaced in place. An approved or paused schedule gets
// a prospective draft version from the first unexecuted period: the amounts
// already recognized are the opening, the new dates and basis apply from
// there, and posted periods never change.
export async function updateSchedule(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'schedule.edit');requireEntity(ctx,entityId);assertInput('ScheduleCreate',input);
 const row=await loadSchedule(tx,ctx,entityId,id,{lock:true});expectVersion(row,expectedVersion);
 if(input.kind!==row.kind||input.sourceId!==row.source_id||input.currency!==row.currency)fail('STATE_CONFLICT','The kind, source and currency of a schedule are fixed; create another schedule.');
 const policy=await recognitionPolicy(tx,ctx,entityId,input.policyVersion);
 if(row.state==='draft'){
  const r=await resolveSchedule(tx,ctx,entityId,input,policy);
  const draft=(await tx.query("select * from lara.schedule_versions where tenant_id=$1 and schedule_id=$2 and state='draft'",[ctx.tenantId,id])).rows[0];
  await tx.query('delete from lara.schedule_lines where tenant_id=$1 and schedule_id=$2',[ctx.tenantId,id]);
  await tx.query("update lara.schedule_versions set state='rejected' where tenant_id=$1 and id=$2",[ctx.tenantId,draft.id]);
  const updated=(await tx.query('update lara.recognition_schedules set start_date=$3,end_date=$4,basis_amount=$5,method=$6,policy_version=$7,mapping=$8,content_hash=$9,content_version=content_version+1,current_version_no=current_version_no+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.startDate,input.endDate,decimal(r.basis,6),r.method,input.policyVersion,JSON.stringify(r.mapping),contentHash(scheduleMaterial(input))])).rows[0];
  await insertVersion(tx,ctx,entityId,updated,{versionNo:updated.current_version_no,effectiveFrom:input.startDate,startDate:input.startDate,endDate:input.endDate,method:r.method,basis:r.basis,opening:0n,policyVersion:input.policyVersion,mapping:r.mapping,parameters:r.parameters,reason:'Draft revised'});
  await audit(tx,ctx,{entityId,action:'schedule.edit',resourceType:'recognition_schedule',resourceId:id,resourceVersion:Number(updated.version),afterRef:updated.content_hash});
  return scheduleResource(updated);
 }
 if(!['approved','paused'].includes(row.state))fail('STATE_CONFLICT','A '+row.state+' schedule is not modified.');
 if((await tx.query("select 1 from lara.schedule_versions where tenant_id=$1 and schedule_id=$2 and state='draft'",[ctx.tenantId,id])).rowCount)fail('STATE_CONFLICT','A prospective version awaits approval; decide it first.');
 const current=(await tx.query("select * from lara.schedule_versions where tenant_id=$1 and schedule_id=$2 and state='approved' order by version_no desc limit 1",[ctx.tenantId,id])).rows[0];
 const lastExecuted=(await tx.query("select max(period_start)::text as d, coalesce(sum(amount) filter (where state='posted'),0)::text as posted from lara.schedule_lines where tenant_id=$1 and schedule_id=$2 and state in ('posted','drafted')",[ctx.tenantId,id])).rows[0];
 const effectiveFrom=lastExecuted.d?monthStart(addMonths(ym(lastExecuted.d),1)):iso(row.start_date);
 if(dayNumber(effectiveFrom)>dayNumber(input.endDate))fail('VALIDATION_FAILED','The new end date precedes the first open period '+effectiveFrom+'.',{fieldErrors:[{path:'endDate',message:'On or after '+effectiveFrom}]});
 let r,opening=micros(lastExecuted.posted);
 if(row.kind==='depreciation'){
  const asset=(await tx.query('select * from lara.assets where tenant_id=$1 and id=$2 for update',[ctx.tenantId,row.source_id])).rows[0];const klass=await classFor(tx,ctx,entityId,asset.class_id);
  const cost=micros(String(asset.cost)),residual=micros(String(asset.residual));
  if(micros(input.basisAmount)!==cost-residual)fail('VALIDATION_FAILED','basisAmount equals cost less residual ('+dec(cost-residual)+').',{fieldErrors:[{path:'basisAmount',message:dec(cost-residual)}]});
  if(input.startDate!==iso(asset.in_service_date))fail('VALIDATION_FAILED','Depreciation starts on the in-service date.',{fieldErrors:[{path:'startDate',message:iso(asset.in_service_date)}]});
  // The new life is the number of months from the in-service month to the new end date; the method may change through the policy (method:<name>) and applies prospectively.
  const months=monthsBetween(input.startDate,input.endDate);const newMethod=['straight_line','declining_balance','sum_of_years'].includes(policy.method)?policy.method:asset.method;
  opening=micros(String(asset.accumulated_depreciation));
  r={method:newMethod,basis:cost-residual,mapping:{debitAccountId:klass.depreciation_expense_account_id,creditAccountId:klass.accumulated_depreciation_account_id,branchId:await branchFor(tx,ctx,entityId,asset)},parameters:{cost:dec(cost),residual:dec(residual),months,proration:policy.proration,annualRate:policy.annualRate,taxRuleVersion:taxRuleVersion(klass)}};
 }else r=await resolveSchedule(tx,ctx,entityId,input,policy);
 const versionNo=Number(current.version_no)+1;
 const {row:v}=await insertVersion(tx,ctx,entityId,row,{versionNo,effectiveFrom,startDate:input.startDate,endDate:input.endDate,method:r.method,basis:r.basis,opening,policyVersion:input.policyVersion,mapping:r.mapping,parameters:r.parameters,reason:'Prospective change from '+effectiveFrom.slice(0,7)});
 const updated=(await tx.query('update lara.recognition_schedules set content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:'schedule.edit',resourceType:'recognition_schedule',resourceId:id,resourceVersion:Number(updated.version),afterRef:v.checksum,reason:'prospective version '+versionNo+' from '+effectiveFrom});
 return scheduleResource(updated);
}
// Events regenerate the live depreciation schedule as an approved prospective version (the event's approval is the authority).
async function regenerateProspective(tx,ctx,entityId,schedule,{asset,effectiveFrom,reason,approvedBy}){
 const klass=await classFor(tx,ctx,entityId,asset.class_id);
 const current=(await tx.query("select * from lara.schedule_versions where tenant_id=$1 and schedule_id=$2 and state='approved' order by version_no desc limit 1",[ctx.tenantId,schedule.id])).rows[0];
 if(!current)return;
 if(dayNumber(effectiveFrom)>dayNumber(iso(schedule.end_date))){await cancelPlanned(tx,ctx,schedule.id,effectiveFrom);return;}
 // Lines still planned before the effective period post under the current version, so they count in the opening.
 const pending=micros((await tx.query("select coalesce(sum(amount),0)::text as v from lara.schedule_lines where tenant_id=$1 and schedule_id=$2 and state in ('planned','blocked') and period_start<$3",[ctx.tenantId,schedule.id,effectiveFrom])).rows[0].v);
 const cost=micros(String(asset.cost)),residual=micros(String(asset.residual)),opening=micros(String(asset.accumulated_depreciation))+pending;
 const params={...current.parameters,cost:dec(cost),residual:dec(residual)};
 const {row}=await insertVersion(tx,ctx,entityId,schedule,{versionNo:Number(current.version_no)+1,effectiveFrom,startDate:iso(schedule.start_date),endDate:iso(schedule.end_date),method:current.method,basis:cost-residual,opening,policyVersion:current.policy_version,mapping:current.mapping,parameters:params,reason,state:'approved',approvedBy:[approvedBy,asset.approved_by,asset.created_by,schedule.created_by].find(p=>p&&p!==ctx.principalId)});
 await tx.query("update lara.schedule_versions set state='superseded' where tenant_id=$1 and id=$2",[ctx.tenantId,current.id]);
 await tx.query('update lara.recognition_schedules set basis_amount=$3,current_version_no=$4,content_version=content_version+1 where tenant_id=$1 and id=$2',[ctx.tenantId,schedule.id,decimal(cost-residual,6),row.version_no]);
}
export async function approveSchedule(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'schedule.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadSchedule(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 const draft=(await tx.query("select * from lara.schedule_versions where tenant_id=$1 and schedule_id=$2 and state='draft'",[ctx.tenantId,id])).rows[0];
 if(!draft)fail('STATE_CONFLICT','No version awaits approval.');
 if(draft.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot approve the schedule.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The schedule changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'){
  if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
  await tx.query("delete from lara.schedule_lines where tenant_id=$1 and version_id=$2 and state in ('planned','blocked')",[ctx.tenantId,draft.id]);
  await tx.query("update lara.schedule_versions set state='rejected' where tenant_id=$1 and id=$2",[ctx.tenantId,draft.id]);
  const rej=(await tx.query(row.state==='draft'?"update lara.recognition_schedules set state='rejected' where tenant_id=$1 and id=$2 returning *":'update lara.recognition_schedules set content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id])).rows[0];
  await audit(tx,ctx,{entityId,action:'schedule.reject',resourceType:'recognition_schedule',resourceId:id,resourceVersion:Number(rej.version),reason:input.reason});
  return {resourceType:'recognition_schedule',resourceId:id,version:Number(rej.version),state:rej.state};
 }
 await tx.query("update lara.schedule_versions set state='superseded' where tenant_id=$1 and schedule_id=$2 and state='approved'",[ctx.tenantId,id]);
 await tx.query("update lara.schedule_versions set state='approved',approved_by=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,draft.id,ctx.principalId]);
 const updated=(await tx.query("update lara.recognition_schedules set state=case when state='draft' then 'approved' else state end,approved_by=coalesce(approved_by,$3),start_date=$4,end_date=$5,basis_amount=$6,method=$7,policy_version=$8,mapping=$9,current_version_no=$10 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId,draft.start_date,draft.end_date,draft.basis_amount,draft.method,draft.policy_version,JSON.stringify(draft.mapping),draft.version_no])).rows[0];
 await audit(tx,ctx,{entityId,action:'schedule.approve',resourceType:'recognition_schedule',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:draft.checksum});
 await emit(tx,ctx,{entityId,aggregateType:'recognition_schedule',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'schedule.approved.v1',payload:{scheduleId:id,versionNo:draft.version_no,checksum:draft.checksum}});
 return {resourceType:'recognition_schedule',resourceId:id,version:Number(updated.version),state:updated.state};
}
// Pause stops execution; pausing a paused schedule resumes it. Both need a reason.
export async function pauseSchedule(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'schedule.pause');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadSchedule(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['approved','paused'].includes(row.state))fail('STATE_CONFLICT','Only approved schedules pause or resume.');
 const next=row.state==='approved'?'paused':'approved';
 const updated=(await tx.query('update lara.recognition_schedules set state=$3 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,next])).rows[0];
 await audit(tx,ctx,{entityId,action:next==='paused'?'schedule.pause':'schedule.resume',resourceType:'recognition_schedule',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'recognition_schedule',resourceId:id,version:Number(updated.version),state:next};
}
export async function getSchedule(tx,ctx,entityId,id){requirePermission(ctx,'schedule.read');requireEntity(ctx,entityId);return scheduleResource(await loadSchedule(tx,ctx,entityId,id));}
export async function listSchedules(tx,ctx,entityId,query){
 requirePermission(ctx,'schedule.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.kind){params.push(String(query.kind));where+=' and kind=$'+params.length;}
 if(query?.state){params.push(String(query.state));where+=' and state=$'+params.length;}
 if(query?.sourceId){if(!isUuid(query.sourceId))fail('VALIDATION_FAILED','sourceId must be a UUID.');params.push(query.sourceId);where+=' and source_id=$'+params.length;}
 const rows=(await tx.query('select * from lara.recognition_schedules where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,scheduleResource,scope);
}
export async function scheduleLines(tx,ctx,entityId,id){
 requirePermission(ctx,'schedule.read');requireEntity(ctx,entityId);const row=await loadSchedule(tx,ctx,entityId,id);
 const versions=(await tx.query('select * from lara.schedule_versions where tenant_id=$1 and schedule_id=$2 order by version_no',[ctx.tenantId,id])).rows;
 const lines=(await tx.query('select l.*,v.version_no from lara.schedule_lines l join lara.schedule_versions v on v.tenant_id=l.tenant_id and v.id=l.version_id where l.tenant_id=$1 and l.schedule_id=$2 order by l.period_start,l.sequence',[ctx.tenantId,id])).rows;
 let planned=0n,executed=0n;const out=[];
 for(const l of lines){const a=micros(String(l.amount));if(l.state==='planned'||l.state==='blocked')planned+=a;if(l.state==='posted'||l.state==='drafted')executed+=a;out.push({id:l.id,sequence:l.sequence,periodStart:iso(l.period_start),periodEnd:iso(l.period_end),amount:dec(a),state:l.state,versionNo:l.version_no,entryId:l.posted_entry_id,draftedResourceType:l.drafted_resource_type,draftedResourceId:l.drafted_resource_id,taskId:l.task_id});}
 const cur=versions.find(v=>v.state==='draft')||versions.filter(v=>v.state==='approved').pop()||versions[versions.length-1];
 return {id,kind:row.kind,state:row.state,versionNo:cur?Number(cur.version_no):1,versions:versions.map(v=>({id:v.id,versionNo:v.version_no,effectiveFrom:iso(v.effective_from),method:v.method,basisAmount:money(String(v.basis_amount)),openingRecognized:money(String(v.opening_recognized)),policyVersion:v.policy_version,reason:v.reason,state:v.state,checksum:v.checksum})),lines:out,totalPlanned:dec(planned),totalExecuted:dec(executed),checksum:contentHash(out.map(l=>[l.periodStart,l.amount,l.state]))};
}

// ---------------------------------------------------------------------------
// Runs: requested under schedule.execute, executed by the worker under the
// same (rechecked) authority. Depreciation, prepayments and deferred revenue
// post; recurring kinds create drafts for review. A period with an executed
// line is skipped; a locked or soft-closed period raises a task.
// ---------------------------------------------------------------------------
const runResource=r=>({id:r.id,version:Number(r.version),periodId:r.period_id,scheduleIds:r.schedule_ids,state:r.state,jobId:r.job_id,results:r.results||[],requestedBy:r.requested_by,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false});
export async function requestScheduleRun(tx,ctx,entityId,input){
 requirePermission(ctx,'schedule.execute');requireEntity(ctx,entityId);assertInput('ScheduleRun',input);await requireAssets(tx,ctx,entityId);
 const period=(await tx.query('select * from lara.periods where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.periodId])).rows[0];
 if(!period)fail('NOT_FOUND','Period not found.',{fieldErrors:[{path:'periodId',message:'Period'}]});
 const ids=[...new Set(input.scheduleIds)];
 const schedules=(await tx.query('select id,state,book_id from lara.recognition_schedules where tenant_id=$1 and entity_id=$2 and id=any($3::uuid[])',[ctx.tenantId,entityId,ids])).rows;
 if(schedules.length!==ids.length)fail('NOT_FOUND','A schedule was not found.');
 for(const s of schedules){if(!['approved','paused'].includes(s.state))fail('STATE_CONFLICT','Schedule '+s.id+' is '+s.state+'; only approved schedules run.');if(s.book_id!==period.book_id)fail('VALIDATION_FAILED','Schedule '+s.id+' belongs to another book than the period.');}
 const run=(await tx.query('insert into lara.schedule_runs(tenant_id,entity_id,period_id,schedule_ids,requested_by,created_by) values($1,$2,$3,$4,$5,$5) returning *',[ctx.tenantId,entityId,input.periodId,ids,ctx.principalId])).rows[0];
 const job=await enqueueJob(tx,ctx,{entityId,kind:'schedule.run',payload:{runId:run.id,periodId:input.periodId,scheduleIds:ids}});
 await tx.query('update lara.schedule_runs set job_id=$3 where tenant_id=$1 and id=$2',[ctx.tenantId,run.id,job.id]);
 await audit(tx,ctx,{entityId,action:'schedule.execute',resourceType:'schedule_run',resourceId:run.id,resourceVersion:1,reason:ids.length+' schedule(s) for period '+input.periodId});
 return {...job,runId:run.id};
}
export async function listScheduleRuns(tx,ctx,entityId,query){
 requirePermission(ctx,'schedule.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.schedule_runs where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,runResource,scope);
}
// Tax depreciation for one period from the class rule, reproducible from the rule version and the asset facts.
function taxDepreciationFor(asset,klass,periodStart){
 if(!klass.tax_method)return null;
 const months=klass.tax_useful_life_months||klass.default_useful_life_months;
 const lines=depreciationLines({cost:micros(String(asset.cost)),residual:micros(String(asset.residual)),months,startDate:iso(asset.in_service_date),method:klass.tax_method,proration:'monthly'});
 let acc=0n,amount=0n;for(const l of lines){if(dayNumber(l.periodStart)<dayNumber(periodStart))acc+=l.amount;else if(l.periodStart===periodStart){amount=l.amount;acc+=l.amount;break;}}
 return {amount,accumulated:acc};
}
export async function executeScheduleRun(tx,ctx,entityId,runId,{sales=null,ledger=null}={}){
 requirePermission(ctx,'schedule.execute');requireEntity(ctx,entityId);
 const run=(await tx.query('select * from lara.schedule_runs where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,runId])).rows[0];
 if(!run)fail('NOT_FOUND','Schedule run not found.');
 if(['completed','completed_with_tasks'].includes(run.state))return runResource(run);
 const period=(await tx.query('select * from lara.periods where tenant_id=$1 and id=$2',[ctx.tenantId,run.period_id])).rows[0];
 const results=[];let tasks=0;
 for(const scheduleId of run.schedule_ids){
  const s=(await tx.query('select * from lara.recognition_schedules where tenant_id=$1 and id=$2 for update',[ctx.tenantId,scheduleId])).rows[0];
  if(!s){results.push({scheduleId,outcome:'not_found',lineId:null,entryId:null,resourceId:null,taskId:null,message:null});continue;}
  if(s.state==='paused'){results.push({scheduleId,outcome:'paused',lineId:null,entryId:null,resourceId:null,taskId:null,message:'Schedule is paused.'});continue;}
  if(s.state!=='approved'){results.push({scheduleId,outcome:'skipped',lineId:null,entryId:null,resourceId:null,taskId:null,message:'Schedule is '+s.state+'.'});continue;}
  const l=(await tx.query('select l.*,v.state as version_state from lara.schedule_lines l join lara.schedule_versions v on v.tenant_id=l.tenant_id and v.id=l.version_id where l.tenant_id=$1 and l.schedule_id=$2 and l.period_start>=$3 and l.period_start<=$4 order by l.period_start limit 1 for update of l',[ctx.tenantId,scheduleId,iso(period.starts_on),iso(period.ends_on)])).rows[0];
  if(!l){results.push({scheduleId,outcome:'no_line',lineId:null,entryId:null,resourceId:null,taskId:null,message:'No line falls in the period.'});continue;}
  if(l.version_state==='draft'){results.push({scheduleId,outcome:'pending_version',lineId:l.id,entryId:null,resourceId:null,taskId:null,message:'A prospective version awaits approval; decide it first.'});continue;}
  if(l.state==='posted'||l.state==='drafted'){results.push({scheduleId,outcome:'already_executed',lineId:l.id,entryId:l.posted_entry_id,resourceId:l.drafted_resource_id,taskId:null,message:'Executed once already; a rerun posts nothing.'});continue;}
  if(l.state==='cancelled'){results.push({scheduleId,outcome:'cancelled',lineId:l.id,entryId:null,resourceId:null,taskId:null,message:null});continue;}
  const posting=['depreciation','prepayment','deferred_revenue'].includes(s.kind);
  if(posting&&period.status!=='open'){
   // No bypass: the period owner reopens or the controller posts the adjustment; the task carries the line.
   const reason='Schedule line for '+iso(l.period_start).slice(0,7)+' ('+dec(micros(String(l.amount)))+') could not post: the period is '+period.status+'. Reopen the period or record the adjustment through the close workflow.';
   let task=(await tx.query("select * from lara.tasks where tenant_id=$1 and entity_id=$2 and source_type='recognition_schedule' and source_id=$3 and kind='schedule_blocked' and cause_key=$4 and status not in ('resolved','cancelled') for update",[ctx.tenantId,entityId,scheduleId,iso(l.period_start)])).rows[0];
   if(!task){task=(await tx.query("insert into lara.tasks(tenant_id,entity_id,kind,source_type,source_id,status,severity,cause_key,reason,created_by) values($1,$2,'schedule_blocked','recognition_schedule',$3,'open','high',$4,$5,$6) returning *",[ctx.tenantId,entityId,scheduleId,iso(l.period_start),reason,ctx.principalId])).rows[0];await audit(tx,ctx,{entityId,action:'task.open',resourceType:'task',resourceId:task.id,resourceVersion:1,reason});}
   await tx.query("update lara.schedule_lines set state='blocked',run_id=$3,task_id=$4 where tenant_id=$1 and id=$2",[ctx.tenantId,l.id,runId,task.id]);tasks++;
   results.push({scheduleId,outcome:'blocked',lineId:l.id,entryId:null,resourceId:null,taskId:task.id,message:'Period '+period.status+'.'});continue;
  }
  const amount=micros(String(l.amount));const m=l.account_mapping||s.mapping;
  const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,s.book_id])).rows[0];
  if(posting){
   let entryId=null;
   if(amount>0n){
    const description=(s.kind==='depreciation'?'Depreciation':s.kind==='prepayment'?'Prepayment recognition':'Deferred revenue recognition')+' '+iso(l.period_start).slice(0,7)+' (schedule '+s.id.slice(0,8)+')';
    entryId=await postEntry(tx,ctx,entityId,{bookId:s.book_id,sourceType:'schedule_line',sourceId:l.id,sourceVersion:1,date:iso(l.period_end),description,currency:book.functional_currency,lines:[line(m.debitAccountId,m.branchId,amount,0n),line(m.creditAccountId,m.branchId,0n,amount)]});
   }
   if(!entryId){await tx.query("update lara.schedule_lines set state='cancelled',run_id=$3,executed_at=now() where tenant_id=$1 and id=$2",[ctx.tenantId,l.id,runId]);results.push({scheduleId,outcome:'zero',lineId:l.id,entryId:null,resourceId:null,taskId:null,message:'Nothing to recognize this period.'});continue;}
   await tx.query("update lara.schedule_lines set state='posted',run_id=$3,posted_entry_id=$4,executed_at=now() where tenant_id=$1 and id=$2",[ctx.tenantId,l.id,runId,entryId]);
   if(s.kind==='depreciation'){
    const asset=(await tx.query('update lara.assets set accumulated_depreciation=accumulated_depreciation+$3 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,s.source_id,decimal(amount,6)])).rows[0];
    const klass=(await tx.query('select * from lara.asset_classes where tenant_id=$1 and id=$2',[ctx.tenantId,asset.class_id])).rows[0];
    const tax=taxDepreciationFor(asset,klass,iso(l.period_start));const cost=micros(String(asset.cost)),acc=micros(String(asset.accumulated_depreciation));
    await tx.query('insert into lara.book_tax_layers(tenant_id,entity_id,asset_id,period_start,book_depreciation,tax_depreciation,book_value,tax_value,rule_version,line_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing',[ctx.tenantId,entityId,asset.id,iso(l.period_start),decimal(amount,6),decimal(tax?tax.amount:amount,6),decimal(cost-acc,6),decimal(tax?cost-tax.accumulated:cost-acc,6),taxRuleVersion(klass),l.id]);
   }
   results.push({scheduleId,outcome:'posted',lineId:l.id,entryId,resourceId:null,taskId:null,message:null});
  }else{
   // Drafts under the approved schedule's authority; reviewers approve and post them through their own flows.
   const actor={...ctx,permissions:new Set([...ctx.permissions,'invoice.prepare','journal.prepare'])};
   let resourceType,resourceId;
   if(s.kind==='recurring_invoice'){
    const doc=(await tx.query('select * from lara.documents where tenant_id=$1 and id=$2',[ctx.tenantId,s.source_id])).rows[0];
    const lines=(await tx.query('select * from lara.document_lines where tenant_id=$1 and document_id=$2 order by line_no',[ctx.tenantId,doc.id])).rows;
    const created=await sales.createDocument(tx,actor,entityId,{kind:'invoice',branchId:doc.branch_id,bookId:doc.book_id,partyId:doc.party_id,documentDate:iso(l.period_start),accountingDate:iso(l.period_start),currency:doc.currency,ruleProfileVersion:doc.rule_profile_version,externalReference:'Recurring '+iso(l.period_start).slice(0,7),lines:lines.map(x=>({description:x.description,...(x.item_id?{itemId:x.item_id}:{}),quantity:money(String(x.quantity)),unitPrice:money(String(x.unit_price)),discount:money(String(x.discount)),priceBasis:x.price_basis,accountId:x.account_id,...(x.tax_code_id?{taxCodeId:x.tax_code_id}:{}),dimensions:x.dimensions_json||{}})),evidenceIds:[]});
    resourceType='document';resourceId=created.id;
   }else if(s.kind==='recurring_journal'){
    const j=(await tx.query('select * from lara.journal_drafts where tenant_id=$1 and id=$2',[ctx.tenantId,s.source_id])).rows[0];
    const created=await ledger.createJournal(tx,actor,entityId,{bookId:j.book_id,accountingDate:iso(l.period_end),documentDate:iso(l.period_end),currency:j.currency,description:j.description+' (recurring '+iso(l.period_start).slice(0,7)+')',lines:j.lines,evidenceIds:[]});
    resourceType='journal';resourceId=created.id;
   }else{
    const created=await ledger.createJournal(tx,actor,entityId,{bookId:s.book_id,accountingDate:iso(l.period_end),documentDate:iso(l.period_end),currency:book.functional_currency,description:'Employee deduction '+(m.employeeName||'')+' '+iso(l.period_start).slice(0,7),lines:[line(m.debitAccountId,m.branchId,amount,0n),line(m.creditAccountId,m.branchId,0n,amount)],evidenceIds:[]});
    resourceType='journal';resourceId=created.id;
   }
   await tx.query("update lara.schedule_lines set state='drafted',run_id=$3,drafted_resource_type=$4,drafted_resource_id=$5,executed_at=now() where tenant_id=$1 and id=$2",[ctx.tenantId,l.id,runId,resourceType,resourceId]);
   results.push({scheduleId,outcome:'drafted',lineId:l.id,entryId:null,resourceId,taskId:null,message:resourceType});
  }
  const open=(await tx.query("select 1 from lara.schedule_lines where tenant_id=$1 and schedule_id=$2 and state in ('planned','blocked')",[ctx.tenantId,scheduleId])).rowCount;
  if(!open)await tx.query("update lara.recognition_schedules set state='completed' where tenant_id=$1 and id=$2",[ctx.tenantId,scheduleId]);
 }
 const updated=(await tx.query('update lara.schedule_runs set state=$3,results=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,runId,tasks?'completed_with_tasks':'completed',JSON.stringify(results)])).rows[0];
 await audit(tx,ctx,{entityId,action:'schedule.run',resourceType:'schedule_run',resourceId:runId,resourceVersion:Number(updated.version),afterRef:contentHash(results),reason:results.map(r=>r.outcome).join(',')});
 return runResource(updated);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export const reportBuilders={
 asset_register:async(tx,ctx,entityId,input)=>{
  requirePermission(ctx,'asset.read');
  const rows=(await tx.query("select a.*,c.code as class_code from lara.assets a join lara.asset_classes c on c.tenant_id=a.tenant_id and c.id=a.class_id where a.tenant_id=$1 and a.entity_id=$2 and a.state in ('approved','disposed','merged') order by a.tag",[ctx.tenantId,entityId])).rows;
  const lines=rows.map(a=>{const cost=micros(String(a.cost)),acc=micros(String(a.accumulated_depreciation));return {tag:a.tag,classCode:a.class_code,state:a.state,stage:a.stage,inServiceDate:iso(a.in_service_date),method:a.method,usefulLifeMonths:a.useful_life_months,cost:dec(cost),accumulatedDepreciation:dec(acc),carryingAmount:dec(cost-acc)};});
  return {lines,totals:{cost:dec(rows.reduce((s,a)=>s+micros(String(a.cost)),0n)),accumulatedDepreciation:dec(rows.reduce((s,a)=>s+micros(String(a.accumulated_depreciation)),0n))}};
 }
};
