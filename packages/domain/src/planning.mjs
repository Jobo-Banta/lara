// Budgets, cost allocation and project accounting (P16). Budget versions
// per book and period with a bucket per account and dimension set, approved
// and activated by other principals; availability = approved budget −
// actual spend − open commitments, evaluated inside a lock on the bucket
// when a purchase order is approved (warn or block, with the authorized
// approver's recorded override); a bill posting against the order consumes
// the commitment so the spend is never counted twice; cancellation releases
// it. Allocation rule versions with drivers whose total must be positive;
// runs preview the pool as of a source cutoff, round the allocated amounts
// so they sum exactly to the pool with the residual on the first target,
// and post once per rule version and period. Projects with approved
// contract versions (change orders never touch past billing), milestones
// certified on evidence, progress billing that invoices the due-now amount,
// holds retention in its own receivable when the invoice posts and recoups
// documented advances by allocation, and retention released on evidence as
// a due-now invoice against the retention receivable.
import {createHash} from 'node:crypto';
import {assertInput,audit,canonical,contentHash,cursorClause,cursorScope,emit,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {micros,signedMicros,decimal} from './ledger.mjs';
import {rateScaled} from './fx.mjs';
import * as sales from './sales.mjs';
import {linkEvidence} from './evidence.mjs';

const sha=v=>createHash('sha256').update(String(v)).digest('hex');
const money=v=>decimal(micros(String(v)),2);
const signed=v=>decimal(signedMicros(String(v)),2);
const dimKey=d=>canonical(Object.fromEntries(Object.entries(d||{}).sort()));
const dimsWithin=(bucket,line)=>Object.entries(bucket||{}).every(([k,v])=>line?.[k]===v);

// ---------------------------------------------------------------------------
// Capability and profile
// ---------------------------------------------------------------------------
export async function isPlanningActive(tx,ctx,entityId){return (await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='planning' and status='active'",[ctx.tenantId,entityId])).rowCount>0;}
export async function requirePlanning(tx,ctx,entityId){if(!await isPlanningActive(tx,ctx,entityId))fail('FEATURE_NOT_ENABLED','The planning capability (budgets, allocations and projects) is not active for this entity.');}
// The project profile: the retention receivable (an asset outside the AR
// control) and the default revenue account for progress billing.
export async function projectProfile(tx,ctx,entityId){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='project_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved project profile (retention receivable and progress revenue accounts) is required.');
 const p=row.payload;
 for(const k of ['retentionReceivableAccountId','revenueAccountId'])if(!isUuid(p[k]))fail('RULE_PROFILE_NOT_APPROVED','The project profile lacks '+k+'.');
 return {retentionReceivableAccountId:p.retentionReceivableAccountId,revenueAccountId:p.revenueAccountId,retentionDueCondition:typeof p.retentionDueCondition==='string'&&p.retentionDueCondition?p.retentionDueCondition:'Release on final acceptance',profileVersion:typeof p.profileVersion==='string'?p.profileVersion:'project-1'};
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
const budgetLine=l=>({accountId:l.account_id,dimensions:l.dimensions_json,amount:money(l.amount)});
const budgetResource=(b,lines)=>resource({...b,status:b.state},{periodStart:iso(b.period_start),periodEnd:iso(b.period_end),currency:b.currency,policy:b.policy,lines:lines.map(budgetLine)});
async function budgetLines(tx,ctx,budgetId){return (await tx.query('select l.* from lara.budget_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.budget_id=$2 order by a.code,l.dimensions_key',[ctx.tenantId,budgetId])).rows;}
const budgetMaterial=i=>({periodStart:i.periodStart,periodEnd:i.periodEnd,currency:i.currency,lines:[...i.lines].map(l=>({accountId:l.accountId,dimensions:l.dimensions,amount:money(l.amount)})).sort((a,b)=>(a.accountId+dimKey(a.dimensions))<(b.accountId+dimKey(b.dimensions))?-1:1)});
async function validateBudget(tx,ctx,entityId,input){
 if(input.periodEnd<input.periodStart)fail('VALIDATION_FAILED','periodEnd is on or after periodStart.',{fieldErrors:[{path:'periodEnd',message:'Before start'}]});
 const seen=new Set();let bookId=null;
 for(const [i,l] of input.lines.entries()){
  const acct=(await tx.query("select book_id,category,status from lara.accounts where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,l.accountId])).rows[0];
  if(!acct||acct.status==='archived')fail('NOT_FOUND','Account '+l.accountId+' not found.');
  if(bookId&&acct.book_id!==bookId)fail('VALIDATION_FAILED','A budget covers one book.',{fieldErrors:[{path:'lines['+i+'].accountId',message:'Other book'}]});bookId=acct.book_id;
  const key=l.accountId+'/'+dimKey(l.dimensions);if(seen.has(key))fail('VALIDATION_FAILED','One bucket per account and dimension set.',{fieldErrors:[{path:'lines['+i+']',message:'Duplicate bucket'}]});seen.add(key);
  micros(l.amount);
 }
 const book=(await tx.query('select functional_currency from lara.books where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,bookId])).rows[0];
 if(book.functional_currency!==input.currency)fail('VALIDATION_FAILED','Budgets are kept in the book\'s functional currency ('+book.functional_currency+').',{fieldErrors:[{path:'currency',message:book.functional_currency}]});
 return bookId;
}
async function writeBudgetLines(tx,ctx,budgetId,lines){
 await tx.query('delete from lara.budget_lines where tenant_id=$1 and budget_id=$2',[ctx.tenantId,budgetId]);
 for(const l of lines)await tx.query('insert into lara.budget_lines(tenant_id,budget_id,account_id,dimensions_json,dimensions_key,amount) values($1,$2,$3,$4,$5,$6)',[ctx.tenantId,budgetId,l.accountId,JSON.stringify(l.dimensions||{}),dimKey(l.dimensions),money(l.amount)]);
}
export async function createBudget(tx,ctx,entityId,input){
 requirePermission(ctx,'budget.create');requireEntity(ctx,entityId);assertInput('BudgetCreate',input);await requirePlanning(tx,ctx,entityId);
 const bookId=await validateBudget(tx,ctx,entityId,input);
 const version=((await tx.query('select coalesce(max(version_number),0)::int v from lara.budgets where tenant_id=$1 and entity_id=$2 and book_id=$3 and period_start=$4 and period_end=$5',[ctx.tenantId,entityId,bookId,input.periodStart,input.periodEnd])).rows[0].v)+1;
 const hash=contentHash(budgetMaterial(input));
 const row=(await tx.query('insert into lara.budgets(tenant_id,entity_id,book_id,period_start,period_end,version_number,currency,policy,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,bookId,input.periodStart,input.periodEnd,version,input.currency,input.policy,hash,ctx.principalId])).rows[0];
 await writeBudgetLines(tx,ctx,row.id,input.lines);
 await audit(tx,ctx,{entityId,action:'budget.create',resourceType:'budget',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return budgetResource(row,await budgetLines(tx,ctx,row.id));
}
async function loadBudget(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Budget not found.');
 const row=(await tx.query('select * from lara.budgets where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Budget not found.');return row;
}
export async function updateBudget(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'budget.edit');requireEntity(ctx,entityId);assertInput('BudgetCreate',input);
 const row=await loadBudget(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','An approved budget is immutable; draft the next version.');
 const bookId=await validateBudget(tx,ctx,entityId,input);
 if(bookId!==row.book_id||input.periodStart!==iso(row.period_start)||input.periodEnd!==iso(row.period_end))fail('VALIDATION_FAILED','A budget keeps its book and period; create another for a different range.',{fieldErrors:[{path:'periodStart',message:'Immutable'}]});
 const hash=contentHash(budgetMaterial(input));
 const updated=(await tx.query('update lara.budgets set currency=$4,policy=$5,content_hash=$6,content_version=content_version+1 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,input.currency,input.policy,hash])).rows[0];
 await writeBudgetLines(tx,ctx,id,input.lines);
 await audit(tx,ctx,{entityId,action:'budget.edit',resourceType:'budget',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return budgetResource(updated,await budgetLines(tx,ctx,id));
}
export async function getBudget(tx,ctx,entityId,id){requirePermission(ctx,'budget.read');requireEntity(ctx,entityId);const row=await loadBudget(tx,ctx,entityId,id);return budgetResource(row,await budgetLines(tx,ctx,id));}
export async function listBudgets(tx,ctx,entityId,query){
 requirePermission(ctx,'budget.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.status){params.push(String(query.status).split(','));where+=' and state=any($'+params.length+'::text[])';}
 const rows=(await tx.query('select * from lara.budgets where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const lines=[];for(const r of rows)lines.push(await budgetLines(tx,ctx,r.id));
 return page(rows,limit,r=>budgetResource(r,lines[rows.indexOf(r)]),scope);
}
export async function approveBudget(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'budget.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadBudget(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Budget is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who drafted the budget cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The budget changed since review.',{resourceVersion:Number(row.version)});
 const state=input.decision==='approve'?'approved':'rejected';
 if(state==='rejected'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const updated=(await tx.query('update lara.budgets set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,state,state==='approved'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'budget.'+state,resourceType:'budget',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'budget',resourceId:id,version:Number(updated.version),state};
}
// Activation supersedes the active version for the same book and period;
// open commitments keep their reference to the version they were reserved
// against and count against the new one through the bucket they name.
export async function activateBudget(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'budget.activate');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadBudget(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='approved')fail('STATE_CONFLICT','Only approved budgets activate.');
 const prior=(await tx.query("update lara.budgets set state='superseded' where tenant_id=$1 and entity_id=$2 and book_id=$3 and period_start=$4 and period_end=$5 and state='active' returning id",[ctx.tenantId,entityId,row.book_id,row.period_start,row.period_end])).rows;
 const updated=(await tx.query("update lara.budgets set state='active',activated_by=$4,activated_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'budget.activate',resourceType:'budget',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason,beforeRef:prior[0]?.id||null});
 await emit(tx,ctx,{entityId,aggregateType:'budget',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'planning.budget_activated.v1',payload:{budgetId:id,superseded:prior.map(p=>p.id)}});
 return {resourceType:'budget',resourceId:id,version:Number(updated.version),state:'active'};
}
// Actual eligible spend on a bucket: posted journal lines on the account
// in the budget period whose dimensions contain the bucket's, with the
// reversals of such postings netting them out; opening, closing and
// adjustment entries are not spend.
async function bucketActual(tx,ctx,entityId,budget,line){
 const rows=(await tx.query("select l.func_debit,l.func_credit,l.dimensions_json from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.entity_id=$2 and l.book_id=$3 and l.account_id=$4 and e.accounting_date between $5 and $6 and (e.purpose='posting' or (e.purpose='reversal' and exists (select 1 from lara.journal_entries o where o.tenant_id=e.tenant_id and o.id=e.reversal_of and o.purpose='posting')))",[ctx.tenantId,entityId,budget.book_id,line.account_id,budget.period_start,budget.period_end])).rows;
 return rows.filter(r=>dimsWithin(line.dimensions_json,r.dimensions_json)).reduce((s,r)=>s+micros(String(r.func_debit))-micros(String(r.func_credit)),0n);
}
async function bucketCommitted(tx,ctx,entityId,line){
 const r=(await tx.query("select coalesce(sum(amount-consumed),0)::text as open from lara.commitments where tenant_id=$1 and budget_line_id=$2 and state='open'",[ctx.tenantId,line.id])).rows[0];
 return micros(r.open);
}
export async function availability(tx,ctx,entityId,id){
 requirePermission(ctx,'budget.read');requireEntity(ctx,entityId);
 const budget=await loadBudget(tx,ctx,entityId,id);
 const lines=await budgetLines(tx,ctx,id);
 const out=[];
 for(const l of lines){
  const acct=(await tx.query('select code,name from lara.accounts where tenant_id=$1 and id=$2',[ctx.tenantId,l.account_id])).rows[0];
  const actual=await bucketActual(tx,ctx,entityId,budget,l),committed=await bucketCommitted(tx,ctx,entityId,l);
  const flags=(await tx.query("select count(*) filter (where warning is not null)::int as warnings,count(*) filter (where override_reason is not null)::int as overrides from lara.commitments where tenant_id=$1 and budget_line_id=$2",[ctx.tenantId,l.id])).rows[0];
  out.push({lineId:l.id,accountId:l.account_id,code:acct.code,name:acct.name,dimensions:l.dimensions_json,budget:money(l.amount),actual:decimal(actual,2),committed:decimal(committed,2),available:decimal(micros(String(l.amount))-actual-committed,2),warnings:flags.warnings,overrides:flags.overrides});
 }
 return {budgetId:id,periodStart:iso(budget.period_start),periodEnd:iso(budget.period_end),currency:budget.currency,policy:budget.policy,lines:out};
}
// The bucket an order line reserves against: the most specific line of the
// active budget covering the order's accounting date whose dimensions the
// order line carries. Locked for the reservation.
async function bucketFor(tx,ctx,entityId,{bookId,accountId,dimensions,date}){
 // The active budget row is the lock: concurrent reservations against its buckets serialize here (budget lines are immutable and carry no update grant).
 const budget=(await tx.query("select * from lara.budgets where tenant_id=$1 and entity_id=$2 and book_id=$3 and state='active' and $4 between period_start and period_end for update",[ctx.tenantId,entityId,bookId,date])).rows[0];
 if(!budget)return null;
 const lines=(await tx.query('select * from lara.budget_lines where tenant_id=$1 and budget_id=$2 and account_id=$3 order by dimensions_key',[ctx.tenantId,budget.id,accountId])).rows.filter(l=>dimsWithin(l.dimensions_json,dimensions));
 if(!lines.length)return {budget,line:null};
 lines.sort((a,b)=>Object.keys(b.dimensions_json).length-Object.keys(a.dimensions_json).length);
 return {budget,line:lines[0]};
}
// Purchasing hook: approving a purchase order reserves one commitment per
// line inside the bucket lock. Beyond the available balance a warning
// policy records the warning; a blocking policy refuses unless the approver
// holds budget.activate and records an override reason.
export async function reserveCommitments(tx,ctx,entityId,order,lines,{reason=null}={}){
 if(!await isPlanningActive(tx,ctx,entityId))return [];
 const out=[];
 for(const l of lines){
  const net=micros(String(l.net));if(net<=0n)continue;
  const found=await bucketFor(tx,ctx,entityId,{bookId:order.book_id,accountId:l.account_id,dimensions:l.dimensions_json,date:iso(order.accounting_date)});
  let warning=null,overrideReason=null,overrideBy=null;
  if(found?.line){
   const actual=await bucketActual(tx,ctx,entityId,found.budget,found.line),committed=await bucketCommitted(tx,ctx,entityId,found.line);
   const available=micros(String(found.line.amount))-actual-committed;
   if(net>available){
    const text='Order line '+l.line_no+' of '+decimal(net)+' exceeds the available budget of '+decimal(available)+' on '+found.line.dimensions_key+'.';
    if(found.budget.policy==='block'){
     if(!ctx.permissions.has('budget.activate')||!reason)fail('STATE_CONFLICT','Budget exceeded: '+text+' A blocking budget needs an authorized override (budget.activate) with a recorded reason.');
     overrideReason=reason;overrideBy=ctx.principalId;
    }else warning=text;
   }
  }
  const row=(await tx.query("insert into lara.commitments(tenant_id,entity_id,book_id,budget_id,budget_line_id,source_type,source_id,line_no,account_id,dimensions_json,amount,warning,override_reason,override_by,created_by) values($1,$2,$3,$4,$5,'purchase_order',$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *",[ctx.tenantId,entityId,order.book_id,found?.budget?.id||null,found?.line?.id||null,order.id,l.line_no,l.account_id,JSON.stringify(l.dimensions_json||{}),decimal(net,6),warning,overrideReason,overrideBy,ctx.principalId])).rows[0];
  await audit(tx,ctx,{entityId,action:'commitment.reserve',resourceType:'commitment',resourceId:row.id,resourceVersion:1,reason:overrideReason||warning});
  out.push(row);
 }
 return out;
}
export async function releaseCommitments(tx,ctx,entityId,orderId,reason){
 if(!await isPlanningActive(tx,ctx,entityId))return 0;
 const rows=(await tx.query("update lara.commitments set state='released' where tenant_id=$1 and entity_id=$2 and source_type='purchase_order' and source_id=$3 and state='open' returning id",[ctx.tenantId,entityId,orderId])).rows;
 for(const r of rows)await audit(tx,ctx,{entityId,action:'commitment.release',resourceType:'commitment',resourceId:r.id,resourceVersion:null,reason});
 return rows.length;
}
// A bill posting against the order consumes its commitments line by line
// (same account first, then any open line), never beyond the reserved
// amount: the actual takes over from the commitment without double counting.
export async function consumeCommitments(tx,ctx,entityId,orderId,billLines){
 if(!await isPlanningActive(tx,ctx,entityId))return;
 const open=(await tx.query("select * from lara.commitments where tenant_id=$1 and entity_id=$2 and source_type='purchase_order' and source_id=$3 and state='open' order by line_no for update",[ctx.tenantId,entityId,orderId])).rows;
 for(const bl of billLines){
  let left=micros(String(bl.net));
  for(const c of [...open.filter(c=>c.account_id===bl.account_id),...open.filter(c=>c.account_id!==bl.account_id)]){
   if(left<=0n)break;
   const remaining=micros(String(c.amount))-micros(String(c.consumed));if(remaining<=0n)continue;
   const take=remaining<left?remaining:left;
   c.consumed=decimal(micros(String(c.consumed))+take,6);left-=take;
   await tx.query("update lara.commitments set consumed=$3,state=case when $3::numeric>=amount then 'consumed' else 'open' end where tenant_id=$1 and id=$2",[ctx.tenantId,c.id,c.consumed]);
  }
 }
}
export async function listCommitments(tx,ctx,entityId,query){
 requirePermission(ctx,'budget.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.status){params.push(String(query.status).split(','));where+=' and state=any($'+params.length+'::text[])';}
 return page((await tx.query('select * from lara.commitments where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,c=>({id:c.id,sourceType:c.source_type,sourceId:c.source_id,lineNo:c.line_no,accountId:c.account_id,dimensions:c.dimensions_json,amount:money(c.amount),consumed:money(c.consumed),state:c.state,warning:c.warning,overrideReason:c.override_reason,budgetId:c.budget_id,createdAt:iso(c.created_at)}),scope);
}

// ---------------------------------------------------------------------------
// Allocation rules and runs
// ---------------------------------------------------------------------------
const ruleResource=r=>({id:r.id,version:Number(r.version),contentVersion:1,state:r.state,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),simulation:false,code:r.code,versionNumber:r.version_number,name:r.name,bookId:r.book_id,sourceAccountIds:r.source_account_ids,sourceDimensions:r.source_dimensions,targetAccountId:r.target_account_id,drivers:r.drivers,effectiveFrom:iso(r.effective_from),effectiveTo:iso(r.effective_to),approvedBy:r.approved_by});
export async function createRule(tx,ctx,entityId,input){
 requirePermission(ctx,'allocation_run.edit');requireEntity(ctx,entityId);assertInput('AllocationRuleCreate',input);await requirePlanning(tx,ctx,entityId);
 const book=(await tx.query('select id from lara.books where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.bookId])).rows[0];if(!book)fail('NOT_FOUND','Book not found.');
 for(const id of [...input.sourceAccountIds,input.targetAccountId]){const a=(await tx.query("select control_type from lara.accounts where tenant_id=$1 and entity_id=$2 and book_id=$3 and id=$4 and status<>'archived'",[ctx.tenantId,entityId,input.bookId,id])).rows[0];if(!a)fail('NOT_FOUND','Account '+id+' not found in the book.');if(a.control_type!=='none')fail('VALIDATION_FAILED','Allocations never touch control accounts.',{fieldErrors:[{path:'sourceAccountIds',message:'Control account '+id}]});}
 if(input.sourceAccountIds.includes(input.targetAccountId))fail('VALIDATION_FAILED','The target is not a source account.',{fieldErrors:[{path:'targetAccountId',message:'Also a source'}]});
 let total=0n;const keys=new Set();
 for(const [i,d] of input.drivers.entries()){const w=rateScaled(d.weight);if(w<=0n)fail('VALIDATION_FAILED','Driver weights are positive.',{fieldErrors:[{path:'drivers['+i+'].weight',message:'Positive'}]});total+=w;const k=dimKey(d.dimensions);if(keys.has(k))fail('VALIDATION_FAILED','One driver per target dimension set.',{fieldErrors:[{path:'drivers['+i+'].dimensions',message:'Duplicate'}]});keys.add(k);}
 if(total<=0n)fail('VALIDATION_FAILED','The driver total must be positive.',{fieldErrors:[{path:'drivers',message:'Total not positive'}]});
 if(input.effectiveTo&&input.effectiveTo<input.effectiveFrom)fail('VALIDATION_FAILED','effectiveTo is on or after effectiveFrom.',{fieldErrors:[{path:'effectiveTo',message:'Before start'}]});
 const version=((await tx.query('select coalesce(max(version_number),0)::int v from lara.allocation_rules where tenant_id=$1 and entity_id=$2 and code=$3',[ctx.tenantId,entityId,input.code])).rows[0].v)+1;
 const material={code:input.code,name:input.name,bookId:input.bookId,sourceAccountIds:[...input.sourceAccountIds].sort(),sourceDimensions:input.sourceDimensions||{},targetAccountId:input.targetAccountId,drivers:input.drivers,effectiveFrom:input.effectiveFrom,effectiveTo:input.effectiveTo||null};
 const hash=contentHash(material);
 const row=(await tx.query('insert into lara.allocation_rules(tenant_id,entity_id,book_id,code,version_number,name,source_account_ids,source_dimensions,target_account_id,drivers,effective_from,effective_to,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *',[ctx.tenantId,entityId,input.bookId,input.code,version,input.name,material.sourceAccountIds,JSON.stringify(material.sourceDimensions),input.targetAccountId,JSON.stringify(input.drivers),input.effectiveFrom,input.effectiveTo||null,hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'allocation_rule.create',resourceType:'allocation_rule',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return ruleResource(row);
}
export async function listRules(tx,ctx,entityId,query){
 requirePermission(ctx,'allocation_run.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.allocation_rules where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,ruleResource,scope);
}
export async function approveRule(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'allocation_run.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 if(!isUuid(id))fail('NOT_FOUND','Rule version not found.');
 const row=(await tx.query('select * from lara.allocation_rules where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Rule version not found.');if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Rule version is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who drafted the rule cannot approve it.');
 if(input.contentVersion!==1)fail('VERSION_CONFLICT','The rule changed since review.',{resourceVersion:Number(row.version)});
 const state=input.decision==='approve'?'approved':'rejected';
 if(state==='rejected'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 if(state==='approved')await tx.query("update lara.allocation_rules set state='superseded' where tenant_id=$1 and entity_id=$2 and code=$3 and state='approved' and id<>$4",[ctx.tenantId,entityId,row.code,id]);
 const updated=(await tx.query('update lara.allocation_rules set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,state,state==='approved'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'allocation_rule.'+state,resourceType:'allocation_rule',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'allocation_rule',resourceId:id,version:Number(updated.version),state};
}
const runResource=r=>resource({...r,status:r.state},{ruleVersionId:r.rule_version_id,periodId:r.period_id,sourceCutoff:iso(r.source_cutoff),driverEvidenceId:r.driver_evidence_id});
export const runDetail=r=>({...runResource(r),pool:r.pool==null?null:signed(r.pool),linesHash:r.lines_hash,entryId:r.entry_id});
const runMaterial=i=>({ruleVersionId:i.ruleVersionId,periodId:i.periodId,sourceCutoff:i.sourceCutoff,driverEvidenceId:i.driverEvidenceId});
async function validateRun(tx,ctx,entityId,input){
 const rule=(await tx.query('select * from lara.allocation_rules where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,input.ruleVersionId])).rows[0];
 if(!rule)fail('NOT_FOUND','Rule version not found.');
 if(rule.state!=='approved')fail('RULE_PROFILE_NOT_APPROVED','The allocation rule version is not approved.');
 const period=(await tx.query('select * from lara.periods where tenant_id=$1 and entity_id=$2 and book_id=$3 and id=$4',[ctx.tenantId,entityId,rule.book_id,input.periodId])).rows[0];
 if(!period)fail('NOT_FOUND','Period not found in the rule\'s book.');
 if(iso(period.ends_on)<iso(rule.effective_from)||(rule.effective_to&&iso(period.starts_on)>iso(rule.effective_to)))fail('VALIDATION_FAILED','The rule is not effective in that period.',{fieldErrors:[{path:'periodId',message:'Outside effective dates'}]});
 if((await tx.query("select 1 from lara.allocation_runs where tenant_id=$1 and rule_version_id=$2 and period_id=$3 and state='posted'",[ctx.tenantId,rule.id,period.id])).rowCount)fail('STATE_CONFLICT','This rule version is already posted for the period; an allocation runs once.');
 return {rule,period};
}
export async function createRun(tx,ctx,entityId,input){
 requirePermission(ctx,'allocation_run.create');requireEntity(ctx,entityId);assertInput('AllocationRunCreate',input);await requirePlanning(tx,ctx,entityId);
 await validateRun(tx,ctx,entityId,input);
 const hash=contentHash(runMaterial(input));
 const row=(await tx.query('insert into lara.allocation_runs(tenant_id,entity_id,rule_version_id,period_id,source_cutoff,driver_evidence_id,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[ctx.tenantId,entityId,input.ruleVersionId,input.periodId,input.sourceCutoff,input.driverEvidenceId,hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,[input.driverEvidenceId],'allocation_run',row.id,1);
 await audit(tx,ctx,{entityId,action:'allocation_run.create',resourceType:'allocation_run',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return runResource(row);
}
async function loadRun(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Allocation run not found.');
 const row=(await tx.query('select * from lara.allocation_runs where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Allocation run not found.');return row;
}
export async function updateRun(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'allocation_run.edit');requireEntity(ctx,entityId);assertInput('AllocationRunCreate',input);
 const row=await loadRun(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','previewed'].includes(row.state))fail('STATE_CONFLICT','An approved run keeps its inputs; start a new run.');
 await validateRun(tx,ctx,entityId,input);
 const hash=contentHash(runMaterial(input));
 const updated=(await tx.query("update lara.allocation_runs set rule_version_id=$4,period_id=$5,source_cutoff=$6,driver_evidence_id=$7,content_hash=$8,content_version=content_version+1,state='draft',pool=null,lines=null,lines_hash=null where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,input.ruleVersionId,input.periodId,input.sourceCutoff,input.driverEvidenceId,hash])).rows[0];
 await audit(tx,ctx,{entityId,action:'allocation_run.edit',resourceType:'allocation_run',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return runResource(updated);
}
export async function getRun(tx,ctx,entityId,id){requirePermission(ctx,'allocation_run.read');requireEntity(ctx,entityId);return runResource(await loadRun(tx,ctx,entityId,id));}
export async function listRuns(tx,ctx,entityId,query){
 requirePermission(ctx,'allocation_run.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 return page((await tx.query('select * from lara.allocation_runs where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows,limit,query?.detail==='1'?runDetail:runResource,scope);
}
// The pool and the allocated lines from the rule and the ledger as of the
// source cutoff: rounded amounts sum exactly to the pool, the residual on
// the first driver in stable order.
export async function computeLines(tx,ctx,entityId,run){
 const rule=(await tx.query('select * from lara.allocation_rules where tenant_id=$1 and id=$2',[ctx.tenantId,run.rule_version_id])).rows[0];
 const period=(await tx.query('select * from lara.periods where tenant_id=$1 and id=$2',[ctx.tenantId,run.period_id])).rows[0];
 const rows=(await tx.query("select l.account_id,a.code,l.func_debit,l.func_credit,l.dimensions_json from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entity_id=$2 and l.book_id=$3 and l.account_id=any($4::uuid[]) and e.accounting_date between $5 and $6 and e.posted_at<=$7 order by a.code",[ctx.tenantId,entityId,rule.book_id,rule.source_account_ids,period.starts_on,period.ends_on,run.source_cutoff])).rows;
 const sources=new Map();
 for(const r of rows){if(!dimsWithin(rule.source_dimensions,r.dimensions_json))continue;const cur=sources.get(r.account_id)||{accountId:r.account_id,code:r.code,amount:0n};cur.amount+=micros(String(r.func_debit))-micros(String(r.func_credit));sources.set(r.account_id,cur);}
 const pool=[...sources.values()].reduce((s,x)=>s+x.amount,0n);
 const weights=rule.drivers.map(d=>rateScaled(d.weight));const total=weights.reduce((s,w)=>s+w,0n);
 const unit=10000n;// two decimals in micros
 const lines=rule.drivers.map((d,i)=>{const raw=pool*weights[i]/total;const rounded=(raw>=0n?(raw+unit/2n)/unit:-((-raw+unit/2n)/unit))*unit;return {dimensions:d.dimensions,weight:d.weight,amount:rounded,residual:false};});
 const allocated=lines.reduce((s,l)=>s+l.amount,0n);
 if(lines.length&&allocated!==pool){lines[0].amount+=pool-allocated;lines[0].residual=true;}
 const out={runId:run.id,state:run.state,pool:decimal(pool,2),sources:[...sources.values()].map(s=>({accountId:s.accountId,code:s.code,amount:decimal(s.amount,2)})),lines:lines.map(l=>({dimensions:l.dimensions,weight:l.weight,amount:decimal(l.amount,2),residual:l.residual})),linesHash:null,entryId:run.entry_id};
 out.linesHash=sha(canonical({pool:out.pool,sources:out.sources,lines:out.lines,rule:rule.content_hash}));
 return {out,rule,period,pool,sources:[...sources.values()],lines};
}
export async function previewRun(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'allocation_run.preview');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadRun(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','previewed'].includes(row.state))fail('STATE_CONFLICT','Run is '+row.state+'.');
 const {out}=await computeLines(tx,ctx,entityId,row);
 const updated=(await tx.query("update lara.allocation_runs set state='previewed',pool=$4,lines=$5,lines_hash=$6 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,out.pool,JSON.stringify({sources:out.sources,lines:out.lines}),out.linesHash])).rows[0];
 await audit(tx,ctx,{entityId,action:'allocation_run.preview',resourceType:'allocation_run',resourceId:id,resourceVersion:Number(updated.version),afterRef:out.linesHash,reason:'pool '+out.pool});
 return {resourceType:'allocation_run',resourceId:id,version:Number(updated.version),state:'previewed'};
}
export async function runLines(tx,ctx,entityId,id){
 requirePermission(ctx,'allocation_run.read');requireEntity(ctx,entityId);
 const row=await loadRun(tx,ctx,entityId,id);
 if(row.lines)return {runId:id,state:row.state,pool:signed(row.pool),sources:row.lines.sources,lines:row.lines.lines,linesHash:row.lines_hash,entryId:row.entry_id};
 return (await computeLines(tx,ctx,entityId,row)).out;
}
export async function approveRun(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'allocation_run.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadRun(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='previewed')fail('STATE_CONFLICT','Preview the run before deciding it.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who prepared the run cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The run changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'){if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});const rej=(await tx.query("update lara.allocation_runs set state='rejected' where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id])).rows[0];await audit(tx,ctx,{entityId,action:'allocation_run.reject',resourceType:'allocation_run',resourceId:id,resourceVersion:Number(rej.version),reason:input.reason});return {resourceType:'allocation_run',resourceId:id,version:Number(rej.version),state:'rejected'};}
 // The preview must still match the ledger: a source posting after the preview changes the pool.
 const {out}=await computeLines(tx,ctx,entityId,row);
 if(out.linesHash!==row.lines_hash)fail('STATE_CONFLICT','The pool changed since the preview ('+out.pool+' now); preview again.');
 const updated=(await tx.query("update lara.allocation_runs set state='approved',approved_by=$4,approved_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'allocation_run.approve',resourceType:'allocation_run',resourceId:id,resourceVersion:Number(updated.version),afterRef:row.lines_hash,reason:input.reason||null});
 return {resourceType:'allocation_run',resourceId:id,version:Number(updated.version),state:'approved'};
}
// Posting moves the pool from the source accounts (pro rata to their
// balances) to the target account per driver dimension set, once.
export async function postRun(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'allocation_run.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadRun(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return {resourceType:'allocation_run',resourceId:id,version:Number(row.version),state:'posted',journalEntryIds:[row.entry_id]};
 if(row.state!=='approved')fail('STATE_CONFLICT','Approval is required before posting.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot both approve and post.');
 const {out,rule,period,pool,sources,lines}=await computeLines(tx,ctx,entityId,row);
 if(out.linesHash!==row.lines_hash)fail('STATE_CONFLICT','The pool changed since approval; start a new run.');
 if(pool===0n)fail('STATE_CONFLICT','The pool is zero; nothing to allocate.');
 if((await tx.query("select 1 from lara.allocation_runs where tenant_id=$1 and rule_version_id=$2 and period_id=$3 and state='posted'",[ctx.tenantId,rule.id,period.id])).rowCount)fail('STATE_CONFLICT','This rule version is already posted for the period; an allocation runs once.');
 const branch=(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and status<>'archived' order by created_at limit 1",[ctx.tenantId,entityId])).rows[0];
 const line=(accountId,amount,dimensions)=>amount>=0n?{accountId,branchId:branch.id,dimensions,debit:decimal(amount,6),credit:'0.000000'}:{accountId,branchId:branch.id,dimensions,debit:'0.000000',credit:decimal(-amount,6)};
 const journal=[];
 for(const l of lines)if(l.amount!==0n)journal.push(line(rule.target_account_id,l.amount,l.dimensions));
 for(const s of sources)if(s.amount!==0n)journal.push(line(s.accountId,-s.amount,rule.source_dimensions));
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:rule.book_id,sourceType:'allocation_run',sourceId:id,sourceVersion:Number(row.content_version),purpose:'posting',accountingDate:iso(period.ends_on),documentDate:iso(period.ends_on),description:'Allocation '+rule.code+' v'+rule.version_number+' for '+iso(period.starts_on)+'..'+iso(period.ends_on),currency:(await tx.query('select functional_currency from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,rule.book_id])).rows[0].functional_currency,manual:false,postingActor:ctx.principalId,commandId,lines:journal})])).rows[0].id;
 const updated=(await tx.query("update lara.allocation_runs set state='posted',entry_id=$4,posted_by=$5,posted_at=now() where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,entryId,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'allocation_run.post',resourceType:'allocation_run',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'allocation_run',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'planning.allocation_posted.v1',payload:{runId:id,entryId,pool:out.pool}});
 return {resourceType:'allocation_run',resourceId:id,version:Number(updated.version),state:'posted',journalEntryIds:[entryId]};
}

// ---------------------------------------------------------------------------
// Projects, contract versions, milestones, advances, progress billing, retention
// ---------------------------------------------------------------------------
const projectResource=(p,current)=>resource({...p,status:p.state},{code:p.code,customerId:p.customer_id,contractAmount:money(current?current.contract_amount:'0'),currency:p.currency,evidenceIds:p.evidence_ids});
async function currentContract(tx,ctx,projectId){return (await tx.query("select * from lara.project_contract_versions where tenant_id=$1 and project_id=$2 and state='approved' order by version_number desc limit 1",[ctx.tenantId,projectId])).rows[0]||null;}
const projectMaterial=i=>({code:i.code,customerId:i.customerId,contractAmount:money(i.contractAmount),currency:i.currency,evidenceIds:[...i.evidenceIds].sort()});
export async function createProject(tx,ctx,entityId,input){
 requirePermission(ctx,'project.create');requireEntity(ctx,entityId);assertInput('ProjectCreate',input);await requirePlanning(tx,ctx,entityId);
 const party=(await tx.query("select p.status,(select count(*) from lara.party_roles r where r.tenant_id=p.tenant_id and r.entity_id=p.entity_id and r.party_id=p.id and r.role='customer')::int as customer from lara.party p where p.tenant_id=$1 and p.entity_id=$2 and p.id=$3",[ctx.tenantId,entityId,input.customerId])).rows[0];
 if(!party||party.status==='archived'||!party.customer)fail('NOT_FOUND','Customer not found.');
 if(!(await tx.query('select 1 from lara.currency_metadata where code=$1',[input.currency])).rowCount)fail('VALIDATION_FAILED','Unknown currency.',{fieldErrors:[{path:'currency',message:'Unknown'}]});
 if((await tx.query('select 1 from lara.projects where tenant_id=$1 and entity_id=$2 and code=$3',[ctx.tenantId,entityId,input.code])).rowCount)fail('STATE_CONFLICT','Project code '+input.code+' exists.');
 const hash=contentHash(projectMaterial(input));
 const row=(await tx.query('insert into lara.projects(tenant_id,entity_id,code,customer_id,currency,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[ctx.tenantId,entityId,input.code,input.customerId,input.currency,JSON.stringify(input.evidenceIds),hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'project',row.id,1);
 // The first contract version is the contract itself; it needs its own approval before billing.
 const cv=(await tx.query("insert into lara.project_contract_versions(tenant_id,entity_id,project_id,version_number,contract_amount,reason,evidence_ids,content_hash,created_by) values($1,$2,$3,1,$4,'Original contract',$5,$6,$7) returning *",[ctx.tenantId,entityId,row.id,money(input.contractAmount),JSON.stringify(input.evidenceIds),contentHash({contractAmount:money(input.contractAmount),reason:'Original contract'}),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'project.create',resourceType:'project',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return {...projectResource(row,null),contractAmount:money(input.contractAmount),contractVersionId:cv.id};
}
async function loadProject(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Project not found.');
 const row=(await tx.query('select * from lara.projects where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Project not found.');return row;
}
async function projectOut(tx,ctx,row){const cur=await currentContract(tx,ctx,row.id);const draft=cur?null:(await tx.query("select contract_amount from lara.project_contract_versions where tenant_id=$1 and project_id=$2 order by version_number desc limit 1",[ctx.tenantId,row.id])).rows[0];return {...projectResource(row,cur),...(cur?{}:{contractAmount:money(draft?.contract_amount||'0')})};}
export async function updateProject(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'project.edit');requireEntity(ctx,entityId);assertInput('ProjectCreate',input);
 const row=await loadProject(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='active')fail('STATE_CONFLICT','Project is '+row.state+'.');
 if(input.code!==row.code||input.customerId!==row.customer_id||input.currency!==row.currency)fail('VALIDATION_FAILED','A project keeps its code, customer and currency.',{fieldErrors:[{path:'code',message:'Immutable'}]});
 const cur=await currentContract(tx,ctx,id);
 if(cur&&money(input.contractAmount)!==money(cur.contract_amount))fail('STATE_CONFLICT','The contract amount changes through a change order, never in place.');
 if(!cur){const draft=(await tx.query("select id from lara.project_contract_versions where tenant_id=$1 and project_id=$2 and version_number=1 and state='draft'",[ctx.tenantId,id])).rows[0];if(draft)await tx.query('update lara.project_contract_versions set contract_amount=$3,content_hash=$4 where tenant_id=$1 and id=$2',[ctx.tenantId,draft.id,money(input.contractAmount),contentHash({contractAmount:money(input.contractAmount),reason:'Original contract'})]);}
 const hash=contentHash(projectMaterial(input));
 const updated=(await tx.query('update lara.projects set evidence_ids=$4,content_hash=$5,content_version=content_version+1 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,JSON.stringify(input.evidenceIds),hash])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'project',id,Number(updated.version));
 await audit(tx,ctx,{entityId,action:'project.edit',resourceType:'project',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return projectOut(tx,ctx,updated);
}
export async function getProject(tx,ctx,entityId,id){requirePermission(ctx,'project.read');requireEntity(ctx,entityId);return projectOut(tx,ctx,await loadProject(tx,ctx,entityId,id));}
export async function listProjects(tx,ctx,entityId,query){
 requirePermission(ctx,'project.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.projects where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const outs=[];for(const r of rows)outs.push(await projectOut(tx,ctx,r));
 return page(rows,limit,r=>outs[rows.indexOf(r)],scope);
}
const cvResource=v=>({id:v.id,version:Number(v.version),projectId:v.project_id,versionNumber:v.version_number,contractAmount:money(v.contract_amount),reason:v.reason,evidenceIds:v.evidence_ids,state:v.state,approvedBy:v.approved_by,createdAt:iso(v.created_at),updatedAt:iso(v.updated_at)});
export async function createChangeOrder(tx,ctx,entityId,projectId,input){
 requirePermission(ctx,'project.edit');requireEntity(ctx,entityId);assertInput('ChangeOrderCreate',input);
 const project=await loadProject(tx,ctx,entityId,projectId,{lock:true});
 if(project.state!=='active')fail('STATE_CONFLICT','Project is '+project.state+'.');
 if((await tx.query("select 1 from lara.project_contract_versions where tenant_id=$1 and project_id=$2 and state='draft'",[ctx.tenantId,projectId])).rowCount)fail('STATE_CONFLICT','A contract version awaits decision; decide it before the next change order.');
 const billed=(await tx.query('select coalesce(sum(billed_value),0)::text as b from lara.milestones where tenant_id=$1 and project_id=$2',[ctx.tenantId,projectId])).rows[0].b;
 if(micros(input.contractAmount)<micros(billed))fail('VALIDATION_FAILED','The contract cannot fall below what is already billed ('+money(billed)+').',{fieldErrors:[{path:'contractAmount',message:'Below billed'}]});
 const version=((await tx.query('select coalesce(max(version_number),0)::int v from lara.project_contract_versions where tenant_id=$1 and project_id=$2',[ctx.tenantId,projectId])).rows[0].v)+1;
 const hash=contentHash({contractAmount:money(input.contractAmount),reason:input.reason,evidenceIds:[...input.evidenceIds].sort()});
 const row=(await tx.query('insert into lara.project_contract_versions(tenant_id,entity_id,project_id,version_number,contract_amount,reason,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,projectId,version,money(input.contractAmount),input.reason,JSON.stringify(input.evidenceIds),hash,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'project_contract_version',row.id,1);
 await audit(tx,ctx,{entityId,action:'project.change_order',resourceType:'project_contract_version',resourceId:row.id,resourceVersion:1,afterRef:hash,reason:input.reason});
 return cvResource(row);
}
export async function listChangeOrders(tx,ctx,entityId,projectId){
 requirePermission(ctx,'project.read');requireEntity(ctx,entityId);await loadProject(tx,ctx,entityId,projectId);
 return {items:(await tx.query('select * from lara.project_contract_versions where tenant_id=$1 and project_id=$2 order by version_number',[ctx.tenantId,projectId])).rows.map(cvResource),nextCursor:null};
}
export async function approveChangeOrder(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'project.progress_billing');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 if(!isUuid(id))fail('NOT_FOUND','Contract version not found.');
 const row=(await tx.query('select * from lara.project_contract_versions where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Contract version not found.');if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Contract version is '+row.state+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who drafted the contract version cannot approve it.');
 if(input.contentVersion!==1)fail('VERSION_CONFLICT','The contract version changed since review.',{resourceVersion:Number(row.version)});
 const state=input.decision==='approve'?'approved':'rejected';
 if(state==='rejected'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const updated=(await tx.query('update lara.project_contract_versions set state=$4,approved_by=$5::uuid,approved_at=case when $5::uuid is null then null else now() end where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,state,state==='approved'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'project.contract_'+state,resourceType:'project_contract_version',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'project_contract_version',resourceId:id,version:Number(updated.version),state};
}
const milestoneResource=m=>({id:m.id,version:Number(m.version),projectId:m.project_id,sequence:m.sequence,name:m.name,amount:money(m.amount),certifiedValue:money(m.certified_value),billedValue:money(m.billed_value),certifiedEvidenceIds:m.certified_evidence_ids,state:m.state,createdAt:iso(m.created_at),updatedAt:iso(m.updated_at)});
export async function createMilestone(tx,ctx,entityId,projectId,input){
 requirePermission(ctx,'project.edit');requireEntity(ctx,entityId);assertInput('MilestoneCreate',input);
 const project=await loadProject(tx,ctx,entityId,projectId,{lock:true});
 if(project.state!=='active')fail('STATE_CONFLICT','Project is '+project.state+'.');
 if(micros(input.amount)<=0n)fail('VALIDATION_FAILED','Milestone amounts are positive.',{fieldErrors:[{path:'amount',message:'Positive'}]});
 const seq=((await tx.query('select coalesce(max(sequence),0)::int s from lara.milestones where tenant_id=$1 and project_id=$2',[ctx.tenantId,projectId])).rows[0].s)+1;
 const row=(await tx.query('insert into lara.milestones(tenant_id,entity_id,project_id,sequence,name,amount,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[ctx.tenantId,entityId,projectId,seq,input.name,money(input.amount),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'project.milestone',resourceType:'milestone',resourceId:row.id,resourceVersion:1});
 return milestoneResource(row);
}
export async function listMilestones(tx,ctx,entityId,projectId){
 requirePermission(ctx,'project.read');requireEntity(ctx,entityId);await loadProject(tx,ctx,entityId,projectId);
 return {items:(await tx.query('select * from lara.milestones where tenant_id=$1 and project_id=$2 order by sequence',[ctx.tenantId,projectId])).rows.map(milestoneResource),nextCursor:null};
}
async function loadMilestone(tx,ctx,entityId,id,{lock=false}={}){
 if(!isUuid(id))fail('NOT_FOUND','Milestone not found.');
 const row=(await tx.query('select * from lara.milestones where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Milestone not found.');return row;
}
// Certification by a principal other than the project owner, on evidence,
// never beyond the milestone amount nor below what is billed.
export async function certifyMilestone(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'project.progress_billing');requireEntity(ctx,entityId);assertInput('MilestoneCertify',input);
 const row=await loadMilestone(tx,ctx,entityId,id,{lock:true});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 const project=await loadProject(tx,ctx,entityId,row.project_id);
 if(project.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who opened the project cannot certify its milestones.');
 const value=micros(input.certifiedValue);
 if(value>micros(String(row.amount)))fail('VALIDATION_FAILED','Certified value cannot exceed the milestone amount ('+money(row.amount)+').',{fieldErrors:[{path:'certifiedValue',message:'Above milestone'}]});
 if(value<micros(String(row.billed_value)))fail('STATE_CONFLICT','Certified value cannot fall below what is billed ('+money(row.billed_value)+').');
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'milestone',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.milestones set certified_value=$3,certified_evidence_ids=$4,certified_by=$5,certified_at=now(),state=case when billed_value>0 then 'billed' else 'certified' end where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,decimal(value,6),JSON.stringify(input.evidenceIds),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'project.certify',resourceType:'milestone',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:decimal(value,2)});
 return {resourceType:'milestone',resourceId:id,version:Number(updated.version),state:updated.state};
}
const advanceResource=a=>({id:a.id,version:Number(a.version),projectId:a.project_id,collectionId:a.collection_id,amount:money(a.amount),recouped:money(a.recouped),remaining:decimal(micros(String(a.amount))-micros(String(a.recouped)),2),createdAt:iso(a.created_at),updatedAt:iso(a.updated_at)});
// A documented advance: a posted collection from the project's customer
// whose unapplied remainder covers the amount.
export async function createAdvance(tx,ctx,entityId,projectId,input){
 requirePermission(ctx,'project.edit');requireEntity(ctx,entityId);assertInput('ProjectAdvanceCreate',input);
 const project=await loadProject(tx,ctx,entityId,projectId);
 const s=(await tx.query("select s.*,(s.gross_amount-lara.settlement_allocated(s.tenant_id,s.id))::text as unapplied from lara.settlements s where s.tenant_id=$1 and s.entity_id=$2 and s.id=$3",[ctx.tenantId,entityId,input.collectionId])).rows[0];
 if(!s||s.direction!=='receipt')fail('NOT_FOUND','Collection not found.');
 if(s.state!=='posted')fail('STATE_CONFLICT','Only posted collections document an advance.');
 if(s.party_id!==project.customer_id)fail('VALIDATION_FAILED','The collection is from another customer.',{fieldErrors:[{path:'collectionId',message:'Other customer'}]});
 const assigned=(await tx.query('select coalesce(sum(amount-recouped),0)::text as a from lara.project_advances where tenant_id=$1 and collection_id=$2',[ctx.tenantId,input.collectionId])).rows[0].a;
 if(micros(input.amount)>micros(s.unapplied)-micros(assigned))fail('ALLOCATION_EXCEEDS_BALANCE','The collection has '+decimal(micros(s.unapplied)-micros(assigned))+' unapplied; the advance exceeds it.');
 const row=(await tx.query('insert into lara.project_advances(tenant_id,entity_id,project_id,collection_id,amount,created_by) values($1,$2,$3,$4,$5,$6) returning *',[ctx.tenantId,entityId,projectId,input.collectionId,money(input.amount),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'project.advance',resourceType:'project_advance',resourceId:row.id,resourceVersion:1,afterRef:input.collectionId});
 return advanceResource(row);
}
export async function listAdvances(tx,ctx,entityId,projectId){
 requirePermission(ctx,'project.read');requireEntity(ctx,entityId);await loadProject(tx,ctx,entityId,projectId);
 return {items:(await tx.query('select * from lara.project_advances where tenant_id=$1 and project_id=$2 order by created_at',[ctx.tenantId,projectId])).rows.map(advanceResource),nextCursor:null};
}
// Progress billing drafts the due-now invoice (certified less retention) on
// the customer for the milestone; retention and the advance recoupment are
// recorded on the billing and take effect when the invoice posts.
export async function progressBilling(tx,ctx,entityId,projectId,input){
 requirePermission(ctx,'project.progress_billing');requireEntity(ctx,entityId);assertInput('ProgressBilling',input);
 const project=await loadProject(tx,ctx,entityId,projectId,{lock:true});
 if(project.state!=='active')fail('STATE_CONFLICT','Project is '+project.state+'.');
 const contract=await currentContract(tx,ctx,projectId);
 if(!contract)fail('RULE_PROFILE_NOT_APPROVED','The contract version must be approved before billing.');
 const profile=await projectProfile(tx,ctx,entityId);
 const m=await loadMilestone(tx,ctx,entityId,input.milestoneId,{lock:true});
 if(m.project_id!==projectId)fail('NOT_FOUND','Milestone not found on this project.');
 const certified=micros(input.certifiedAmount),retention=micros(input.retentionAmount),recoup=micros(input.advanceRecoupment);
 if(certified<=0n)fail('VALIDATION_FAILED','The certified amount billed is positive.',{fieldErrors:[{path:'certifiedAmount',message:'Positive'}]});
 if(retention+recoup>=certified)fail('VALIDATION_FAILED','Retention and recoupment leave a due-now amount.',{fieldErrors:[{path:'retentionAmount',message:'Too much held'}]});
 const remaining=micros(String(m.certified_value))-micros(String(m.billed_value));
 if(certified>remaining)fail('STATE_CONFLICT','Billing cannot exceed the certified, unbilled value of the milestone ('+decimal(remaining)+'); a reviewed change order or a new certification comes first.');
 const billedTotal=micros((await tx.query('select coalesce(sum(billed_value),0)::text as b from lara.milestones where tenant_id=$1 and project_id=$2',[ctx.tenantId,projectId])).rows[0].b);
 if(billedTotal+certified>micros(String(contract.contract_amount)))fail('STATE_CONFLICT','Billing cannot exceed the approved contract ('+money(contract.contract_amount)+'); a reviewed change order comes first.');
 if(recoup>0n){const open=micros((await tx.query('select coalesce(sum(amount-recouped),0)::text as r from lara.project_advances where tenant_id=$1 and project_id=$2',[ctx.tenantId,projectId])).rows[0].r);if(recoup>open)fail('ALLOCATION_EXCEEDS_BALANCE','Documented advances of '+decimal(open)+' do not cover the recoupment.');}
 const branch=(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and status<>'archived' order by created_at limit 1",[ctx.tenantId,entityId])).rows[0];
 const book=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary' and status<>'archived'",[ctx.tenantId,entityId])).rows[0];
 const dueNow=certified-retention;
 const invoice=await sales.createDocument(tx,{...ctx,permissions:new Set([...ctx.permissions,'invoice.prepare'])},entityId,{kind:'invoice',branchId:branch.id,bookId:book.id,partyId:project.customer_id,documentDate:input.accountingDate,accountingDate:input.accountingDate,currency:project.currency,ruleProfileVersion:'ph-2026',externalReference:project.code+'/'+m.sequence,lines:[{description:'Progress billing '+project.code+' milestone '+m.sequence+' '+m.name+': certified '+decimal(certified)+(retention>0n?' less retention '+decimal(retention):''),quantity:'1',unitPrice:decimal(dueNow,2),discount:'0',priceBasis:'exclusive',accountId:profile.revenueAccountId,dimensions:{}}],evidenceIds:input.evidenceIds});
 const billing=(await tx.query('insert into lara.project_billings(tenant_id,entity_id,project_id,milestone_id,invoice_id,contract_version_id,certified_amount,retention_amount,advance_recoupment,evidence_ids,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[ctx.tenantId,entityId,projectId,m.id,invoice.id,contract.id,decimal(certified,6),decimal(retention,6),decimal(recoup,6),JSON.stringify(input.evidenceIds),ctx.principalId])).rows[0];
 await tx.query("update lara.milestones set billed_value=billed_value+$3,state='billed' where tenant_id=$1 and id=$2",[ctx.tenantId,m.id,decimal(certified,6)]);
 await audit(tx,ctx,{entityId,action:'project.progress_billing',resourceType:'project_billing',resourceId:billing.id,resourceVersion:1,afterRef:invoice.id,reason:'certified '+decimal(certified)+', retention '+decimal(retention)+', recoupment '+decimal(recoup)});
 return {resourceType:'document',resourceId:invoice.id,version:invoice.version,state:invoice.state,billingId:billing.id};
}
// Sales hook: when the progress invoice posts, the retention moves to its
// own receivable with the revenue it carries and the advance is recouped by
// allocating the documented collection to the new open item; a release
// invoice posting closes the retention item.
export async function invoicePosted(tx,ctx,entityId,doc,{commandId=null}={}){
 const billing=(await tx.query("select * from lara.project_billings where tenant_id=$1 and invoice_id=$2 and state='draft' for update",[ctx.tenantId,doc.id])).rows[0];
 if(billing){
  const profile=await projectProfile(tx,ctx,entityId);
  const m=await loadMilestone(tx,ctx,entityId,billing.milestone_id);
  const retention=micros(String(billing.retention_amount)),recoup=micros(String(billing.advance_recoupment));
  let entryId=null;const events=[];
  if(retention>0n){
   entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:doc.book_id,sourceType:'project_billing',sourceId:billing.id,sourceVersion:1,purpose:'posting',accountingDate:iso(doc.accounting_date),documentDate:iso(doc.document_date),description:'Retention held on '+(doc.official_number||doc.id),currency:doc.currency,manual:false,postingActor:ctx.principalId,commandId,lines:[{accountId:profile.retentionReceivableAccountId,branchId:doc.branch_id,dimensions:{},debit:decimal(retention,6),credit:'0.000000'},{accountId:profile.revenueAccountId,branchId:doc.branch_id,dimensions:{},debit:'0.000000',credit:decimal(retention,6)}]})])).rows[0].id;
   const ri=(await tx.query('insert into lara.retention_items(tenant_id,entity_id,project_id,milestone_id,billing_id,invoice_id,held,due_condition,recognition_entry_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id',[ctx.tenantId,entityId,billing.project_id,m.id,billing.id,doc.id,decimal(retention,6),profile.retentionDueCondition,entryId,ctx.principalId])).rows[0];
   await audit(tx,ctx,{entityId,action:'project.retention_held',resourceType:'retention_item',resourceId:ri.id,resourceVersion:1,afterRef:entryId});
  }
  if(recoup>0n){
   const item=(await tx.query("select id from lara.open_items where tenant_id=$1 and entity_id=$2 and document_id=$3 and side='AR'",[ctx.tenantId,entityId,doc.id])).rows[0];
   let left=recoup;
   for(const a of (await tx.query('select * from lara.project_advances where tenant_id=$1 and project_id=$2 and amount>recouped order by created_at for update',[ctx.tenantId,billing.project_id])).rows){
    if(left<=0n)break;
    const avail=micros(String(a.amount))-micros(String(a.recouped));const take=avail<left?avail:left;
    events.push(...await sales.applyAllocations(tx,ctx,entityId,a.collection_id,[{openItemId:item.id,amount:decimal(take,2)}],{commandId,reason:'Advance recoupment '+billing.id}));
    await tx.query('update lara.project_advances set recouped=recouped+$3 where tenant_id=$1 and id=$2',[ctx.tenantId,a.id,decimal(take,6)]);
    left-=take;
   }
   if(left>0n)fail('ALLOCATION_EXCEEDS_BALANCE','Documented advances no longer cover the recoupment of '+decimal(recoup)+'.');
  }
  await tx.query("update lara.project_billings set state='posted',recognition_entry_id=$3,allocation_event_ids=$4 where tenant_id=$1 and id=$2",[ctx.tenantId,billing.id,entryId,JSON.stringify(events)]);
  return;
 }
 const release=(await tx.query("select * from lara.retention_items where tenant_id=$1 and release_invoice_id=$2 and state='held' for update",[ctx.tenantId,doc.id])).rows[0];
 if(release){
  await tx.query("update lara.retention_items set state='released',released=held,released_at=now() where tenant_id=$1 and id=$2",[ctx.tenantId,release.id]);
  await audit(tx,ctx,{entityId,action:'project.retention_released',resourceType:'retention_item',resourceId:release.id,resourceVersion:Number(release.version)+1,afterRef:doc.id});
 }
}
const retentionResource=r=>({id:r.id,version:Number(r.version),projectId:r.project_id,milestoneId:r.milestone_id,invoiceId:r.invoice_id,held:money(r.held),released:money(r.released),dueCondition:r.due_condition,state:r.state,releaseInvoiceId:r.release_invoice_id,releasedAt:iso(r.released_at),createdAt:iso(r.created_at)});
export async function listRetention(tx,ctx,entityId,projectId){
 requirePermission(ctx,'project.read');requireEntity(ctx,entityId);await loadProject(tx,ctx,entityId,projectId);
 return {items:(await tx.query('select * from lara.retention_items where tenant_id=$1 and project_id=$2 order by created_at',[ctx.tenantId,projectId])).rows.map(retentionResource),nextCursor:null};
}
// Release on evidence: a due-now invoice whose line settles the retention
// receivable, so the AR control carries the amount from posting on.
export async function releaseRetention(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'project.progress_billing');requireEntity(ctx,entityId);assertInput('RetentionRelease',input);
 if(!isUuid(id))fail('NOT_FOUND','Retention item not found.');
 const row=(await tx.query('select * from lara.retention_items where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Retention item not found.');if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='held'||row.release_invoice_id)fail('STATE_CONFLICT','Retention is '+(row.release_invoice_id?'awaiting its release invoice':row.state)+'.');
 const project=await loadProject(tx,ctx,entityId,row.project_id);
 const profile=await projectProfile(tx,ctx,entityId);
 const original=(await tx.query('select * from lara.documents where tenant_id=$1 and id=$2',[ctx.tenantId,row.invoice_id])).rows[0];
 const invoice=await sales.createDocument(tx,{...ctx,permissions:new Set([...ctx.permissions,'invoice.prepare'])},entityId,{kind:'invoice',branchId:original.branch_id,bookId:original.book_id,partyId:project.customer_id,documentDate:input.accountingDate,accountingDate:input.accountingDate,currency:project.currency,ruleProfileVersion:original.rule_profile_version,externalReference:project.code+'/retention',lines:[{description:'Retention release '+project.code+' on '+(original.official_number||original.id)+(input.reason?': '+input.reason:''),quantity:'1',unitPrice:money(row.held),discount:'0',priceBasis:'exclusive',accountId:profile.retentionReceivableAccountId,dimensions:{}}],evidenceIds:input.evidenceIds});
 const updated=(await tx.query('update lara.retention_items set release_invoice_id=$3,release_evidence_ids=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,invoice.id,JSON.stringify(input.evidenceIds)])).rows[0];
 await linkEvidence(tx,ctx,entityId,input.evidenceIds,'retention_item',id,Number(updated.version));
 await audit(tx,ctx,{entityId,action:'project.retention_release',resourceType:'retention_item',resourceId:id,resourceVersion:Number(updated.version),afterRef:invoice.id,reason:input.reason||null});
 return {resourceType:'document',resourceId:invoice.id,version:invoice.version,state:invoice.state};
}
// Profitability from posted facts: revenue and cost posted on documents
// that reference the project code, retention and advances from the records;
// work in progress (uncertified milestones, unposted drafts) is excluded.
export async function profitability(tx,ctx,entityId,id){
 requirePermission(ctx,'project.read');requireEntity(ctx,entityId);
 const project=await loadProject(tx,ctx,entityId,id);
 const contract=await currentContract(tx,ctx,id);
 const ms=(await tx.query('select coalesce(sum(certified_value),0)::text as c,coalesce(sum(billed_value),0)::text as b from lara.milestones where tenant_id=$1 and project_id=$2',[ctx.tenantId,id])).rows[0];
 const ret=(await tx.query('select coalesce(sum(held),0)::text as h,coalesce(sum(released),0)::text as r from lara.retention_items where tenant_id=$1 and project_id=$2',[ctx.tenantId,id])).rows[0];
 const adv=(await tx.query('select coalesce(sum(amount),0)::text as a,coalesce(sum(recouped),0)::text as r from lara.project_advances where tenant_id=$1 and project_id=$2',[ctx.tenantId,id])).rows[0];
 // Posted lines tagged to the project: the project dimension on the line, or a document whose reference carries the project code.
 const posted=(await tx.query("select a.category,coalesce(sum(l.func_credit-l.func_debit),0)::text as credit from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id left join lara.documents d on d.tenant_id=e.tenant_id and e.source_type='document' and d.id=e.source_id where l.tenant_id=$1 and l.entity_id=$2 and a.category in ('income','expense') and (l.dimensions_json->>'project'=$4 or d.external_reference like $3) group by a.category",[ctx.tenantId,entityId,project.code+'/%',id])).rows;
 const retentionRevenue=(await tx.query("select coalesce(sum(l.func_credit-l.func_debit),0)::text as credit from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id join lara.project_billings b on b.tenant_id=e.tenant_id and b.id=e.source_id join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entity_id=$2 and e.source_type='project_billing' and b.project_id=$3 and a.category='income'",[ctx.tenantId,entityId,id])).rows[0].credit;
 const revenue=signedMicros(posted.find(p=>p.category==='income')?.credit||'0')+signedMicros(retentionRevenue);
 const cost=-signedMicros(posted.find(p=>p.category==='expense')?.credit||'0');
 return {projectId:id,currency:project.currency,contractAmount:money(contract?.contract_amount||'0'),contractVersion:contract?.version_number||1,certified:money(ms.c),billed:money(ms.b),retentionHeld:decimal(micros(ret.h)-micros(ret.r),2),retentionReleased:money(ret.r),advances:money(adv.a),advancesRecouped:money(adv.r),revenuePosted:decimal(revenue,2),costPosted:decimal(cost,2),margin:decimal(revenue-cost,2),workInProgressExcluded:'Uncertified milestone value, unposted drafts and unreleased retention conditions are excluded; only posted documents referencing '+project.code+' count.',asOf:new Date().toISOString()};
}
