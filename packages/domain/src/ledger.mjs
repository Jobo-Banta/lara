// Ledger module (P03): chart of accounts, periods, journal drafts with
// independent approval, posting through lara.post_journal_entry, reversals,
// opening imports, reports with immutable snapshots and the fiscal-year close.
// Amounts travel as decimal strings; arithmetic happens in integer micros.
import {createHash} from 'node:crypto';
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,expectVersion,fail,isUuid,page,pageArgs,requireAnyPermission,requireEntity,requirePermission,resource} from './core.mjs';
import {linkEvidence} from './evidence.mjs';

const MICRO=1_000_000n;
export function micros(value){
 if(typeof value!=='string'||!/^\d{1,18}(\.\d{1,6})?$/.test(value))fail('VALIDATION_FAILED','Amounts are decimal strings with up to six decimals.',{fieldErrors:[{path:'amount',message:'Invalid amount'}]});
 const [whole,fraction='']=value.split('.');return BigInt(whole)*MICRO+BigInt(fraction.padEnd(6,'0'));
}
// Balances computed by the database may be negative; inputs never are.
export const signedMicros=v=>String(v).startsWith('-')?-micros(String(v).slice(1)):micros(String(v));
export const decimal=(m,scale=2)=>{const negative=m<0n;const abs=negative?-m:m;const whole=abs/MICRO,frac=(abs%MICRO).toString().padStart(6,'0');return (negative?'-':'')+whole.toString()+'.'+frac.slice(0,scale);};
const money=v=>decimal(micros(String(v)),2);
const sha=v=>createHash('sha256').update(v).digest('hex');

async function bookFor(tx,ctx,entityId,bookId){
 if(!isUuid(bookId))fail('VALIDATION_FAILED','bookId must be a UUID.',{fieldErrors:[{path:'bookId',message:'UUID'}]});
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,bookId])).rows[0];
 if(!book)fail('NOT_FOUND','Book not found.');
 return book;
}
// The ledger capability must be active on the entity before any book work.
async function requireLedger(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='general_ledger' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The general ledger capability is not active for this entity.');
}

// ---------------------------------------------------------------------------
// Books and chart of accounts
// ---------------------------------------------------------------------------
export const bookResource=b=>resource(b,{code:b.code,kind:b.kind,functionalCurrency:b.functional_currency,sourceOwner:b.source_owner});
export async function createBook(tx,ctx,entityId,input){
 requirePermission(ctx,'book.create');requireEntity(ctx,entityId);assertInput('BookCreate',input);
 if(input.functionalCurrency!=='PHP')fail('FEATURE_NOT_ENABLED','Books in other currencies arrive with P09.');
 const row=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,$3,$4,$5,$6,'active',$7) returning *",[ctx.tenantId,entityId,input.code.trim().toUpperCase(),input.kind,input.functionalCurrency,input.sourceOwner.trim(),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'book.create',resourceType:'book',resourceId:row.id,resourceVersion:1});
 return bookResource(row);
}
export async function listBooks(tx,ctx,entityId,query){requirePermission(ctx,'book.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];const rows=(await tx.query('select * from lara.books where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;return page(rows,limit,bookResource,scope);}

const accountFields=async(tx,ctx,a)=>({bookId:a.book_id,code:a.code,name:a.name,category:a.category,...(a.parent_id?{parentId:a.parent_id}:{}),controlType:a.control_type,requiredDimensions:(await tx.query('select dimension_type from lara.account_dimension_rules where tenant_id=$1 and account_id=$2 and required order by dimension_type',[ctx.tenantId,a.id])).rows.map(r=>r.dimension_type)});
export async function accountResource(tx,ctx,a){return resource(a,await accountFields(tx,ctx,a));}
const normalSide=c=>['asset','expense'].includes(c)?'debit':'credit';
export async function createAccount(tx,ctx,entityId,input){
 requirePermission(ctx,'account.create');requireEntity(ctx,entityId);assertInput('AccountCreate',input);await requireLedger(tx,ctx,entityId);
 await bookFor(tx,ctx,entityId,input.bookId);
 const code=input.code.trim().toUpperCase();
 if(!/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(code))fail('VALIDATION_FAILED','Account codes use letters, digits, dots and hyphens.',{fieldErrors:[{path:'code',message:'Invalid code'}]});
 const dims=[...new Set(input.requiredDimensions.map(d=>d.trim()))];
 for(const d of dims)if(!/^[a-z][a-z0-9_]{0,31}$/.test(d))fail('VALIDATION_FAILED','Dimension types are lower-case codes.',{fieldErrors:[{path:'requiredDimensions',message:'Invalid dimension type '+d}]});
 const hash=contentHash({bookId:input.bookId,code,name:input.name.trim(),category:input.category,parentId:input.parentId||null,controlType:input.controlType,dims});
 const row=(await tx.query('insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,parent_id,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[ctx.tenantId,entityId,input.bookId,code,input.name.trim(),input.category,normalSide(input.category),input.parentId||null,input.controlType,input.controlType==='none',hash,ctx.principalId])).rows[0];
 for(const d of dims)await tx.query('insert into lara.account_dimension_rules(tenant_id,entity_id,account_id,dimension_type,created_by) values($1,$2,$3,$4,$5)',[ctx.tenantId,entityId,row.id,d,ctx.principalId]);
 await audit(tx,ctx,{entityId,action:'account.create',resourceType:'account',resourceId:row.id,resourceVersion:1});
 return accountResource(tx,ctx,row);
}
export async function updateAccount(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'account.edit');requireEntity(ctx,entityId);assertInput('AccountCreate',input);
 const row=(await tx.query('select * from lara.accounts where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Account not found.');expectVersion(row,expectedVersion);
 if(row.book_id!==input.bookId)fail('VALIDATION_FAILED','An account cannot move between books.',{fieldErrors:[{path:'bookId',message:'Immutable'}]});
 const code=input.code.trim().toUpperCase(),dims=[...new Set(input.requiredDimensions.map(d=>d.trim()))];
 const hash=contentHash({bookId:input.bookId,code,name:input.name.trim(),category:input.category,parentId:input.parentId||null,controlType:input.controlType,dims});
 const updated=(await tx.query('update lara.accounts set code=$4,name=$5,category=$6,normal_side=$7,parent_id=$8,control_type=$9,allow_manual=$10,content_hash=$11,content_version=content_version+$12 where tenant_id=$1 and entity_id=$2 and id=$3 returning *',[ctx.tenantId,entityId,id,code,input.name.trim(),input.category,normalSide(input.category),input.parentId||null,input.controlType,input.controlType==='none',hash,hash!==row.content_hash?1:0])).rows[0];
 // Dimension rules are append-only records; a new rule set is expressed by adding missing ones (existing ones stay as history).
 const current=(await tx.query('select dimension_type from lara.account_dimension_rules where tenant_id=$1 and account_id=$2',[ctx.tenantId,id])).rows.map(r=>r.dimension_type);
 for(const d of dims)if(!current.includes(d))await tx.query('insert into lara.account_dimension_rules(tenant_id,entity_id,account_id,dimension_type,created_by) values($1,$2,$3,$4,$5)',[ctx.tenantId,entityId,id,d,ctx.principalId]);
 await audit(tx,ctx,{entityId,action:'account.edit',resourceType:'account',resourceId:id,resourceVersion:Number(updated.version)});
 return accountResource(tx,ctx,updated);
}
export async function freezeAccount(tx,ctx,entityId,id,status,reason){
 requirePermission(ctx,'account.edit');requireEntity(ctx,entityId);
 if(!['active','frozen','archived'].includes(status))fail('VALIDATION_FAILED','Unknown account status.');
 const row=(await tx.query('select * from lara.accounts where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Account not found.');
 if(status==='archived'&&(await tx.query('select 1 from lara.journal_lines where tenant_id=$1 and account_id=$2 limit 1',[ctx.tenantId,id])).rowCount)fail('STATE_CONFLICT','Accounts with postings are frozen, not archived.');
 const updated=(await tx.query('update lara.accounts set status=$3 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,status])).rows[0];
 await audit(tx,ctx,{entityId,action:'account.'+status,resourceType:'account',resourceId:id,resourceVersion:Number(updated.version),reason});
 return accountResource(tx,ctx,updated);
}
const ACCOUNT_READERS=['account.read','invoice.prepare','invoice.read','sales_order.create','collection.create'];
export async function getAccount(tx,ctx,entityId,id){requireAnyPermission(ctx,ACCOUNT_READERS);requireEntity(ctx,entityId);const row=(await tx.query('select * from lara.accounts where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Account not found.');return accountResource(tx,ctx,row);}
export async function listAccounts(tx,ctx,entityId,query){
 requireAnyPermission(ctx,ACCOUNT_READERS);requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.bookId){if(!isUuid(query.bookId))fail('VALIDATION_FAILED','bookId must be a UUID.');params.push(query.bookId);where+=' and book_id=$'+params.length;}
 if(query?.status){params.push(String(query.status));where+=' and status=$'+params.length;}
 const rows=(await tx.query('select * from lara.accounts where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 const items=[];for(const r of rows.slice(0,limit))items.push(await accountResource(tx,ctx,r));
 return {items,nextCursor:page(rows,limit,r=>r,scope).nextCursor};
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------
export const periodResource=p=>resource(p,{bookId:p.book_id,startsOn:iso(p.starts_on),endsOn:iso(p.ends_on)});
const iso=d=>d instanceof Date?d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'):String(d).slice(0,10);
export async function createPeriod(tx,ctx,entityId,input){
 requirePermission(ctx,'period.create');requireEntity(ctx,entityId);assertInput('PeriodCreate',input);await requireLedger(tx,ctx,entityId);await bookFor(tx,ctx,entityId,input.bookId);
 if(input.endsOn<input.startsOn)fail('VALIDATION_FAILED','endsOn precedes startsOn.',{fieldErrors:[{path:'endsOn',message:'Must not precede startsOn'}]});
 const row=(await tx.query('insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,$4,$5,$6) returning *',[ctx.tenantId,entityId,input.bookId,input.startsOn,input.endsOn,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'period.create',resourceType:'period',resourceId:row.id,resourceVersion:1});
 return periodResource(row);
}
export async function updatePeriod(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'period.edit');requireEntity(ctx,entityId);assertInput('PeriodCreate',input);
 const row=(await tx.query('select * from lara.periods where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Period not found.');expectVersion(row,expectedVersion);
 if(row.book_id!==input.bookId)fail('VALIDATION_FAILED','A period cannot move between books.',{fieldErrors:[{path:'bookId',message:'Immutable'}]});
 if(row.status!=='open')fail('STATE_CONFLICT','Only open periods change their dates.');
 const updated=(await tx.query('update lara.periods set starts_on=$3,ends_on=$4,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.startsOn,input.endsOn])).rows[0];
 await audit(tx,ctx,{entityId,action:'period.edit',resourceType:'period',resourceId:id,resourceVersion:Number(updated.version)});
 return periodResource(updated);
}
async function loadPeriod(tx,ctx,entityId,id){const row=(await tx.query('select * from lara.periods where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Period not found.');return row;}
export async function softClosePeriod(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'period.soft_close');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadPeriod(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='open')fail('STATE_CONFLICT','Period is '+row.status+'.');
 const updated=(await tx.query("update lara.periods set status='soft_closed' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];
 await audit(tx,ctx,{entityId,action:'period.soft_close',resourceType:'period',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return {resourceType:'period',resourceId:id,version:Number(updated.version),state:'soft_closed'};
}
// Lock requires every required close task of the current close version complete
// and every substantiation reviewed; the period then refuses postings. Locking
// principal must differ from whoever prepared open substantiations.
export async function lockPeriod(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'period.lock');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadPeriod(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='soft_closed')fail('STATE_CONFLICT','Soft close the period before locking it.');
 const openTasks=(await tx.query("select requirement from lara.close_tasks where tenant_id=$1 and period_id=$2 and close_version=$3 and required and status<>'complete'",[ctx.tenantId,id,row.close_version])).rows;
 if(openTasks.length)fail('STATE_CONFLICT','Required close tasks are open: '+openTasks.map(t=>t.requirement).join(', ')+'.',{fieldErrors:openTasks.map(t=>({path:t.requirement,message:'Complete with evidence before locking'}))});
 const unreviewed=(await tx.query("select count(*)::int n from lara.substantiations where tenant_id=$1 and period_id=$2 and state<>'reviewed'",[ctx.tenantId,id])).rows[0].n;
 if(unreviewed)fail('STATE_CONFLICT',unreviewed+' account substantiation(s) await review.');
 const updated=(await tx.query("update lara.periods set status='locked',locked_by=$3,locked_at=now() where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'period.lock',resourceType:'period',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 await emit(tx,ctx,{entityId,aggregateType:'period',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'period.locked.v1',payload:{periodId:id,bookId:row.book_id,closeVersion:row.close_version}});
 return {resourceType:'period',resourceId:id,version:Number(updated.version),state:'locked'};
}
// Reopening is a controller decision that starts a new close version; prior
// snapshots and tasks stay as history and the lock audit records the reason.
export async function reopenPeriod(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'period.reopen');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadPeriod(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status==='open')fail('STATE_CONFLICT','Period is already open.');
 const profile=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='ledger_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(profile?.payload?.reopenForbidden===true)fail('FORBIDDEN','The selected regulatory profile forbids reopening locked periods.');
 const updated=(await tx.query("update lara.periods set status='open',close_version=close_version+$3,locked_by=null,locked_at=null where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,row.status==='locked'?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:'period.reopen',resourceType:'period',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason,afterRef:'close_version='+updated.close_version});
 return {resourceType:'period',resourceId:id,version:Number(updated.version),state:'open'};
}
export async function getPeriod(tx,ctx,entityId,id){requirePermission(ctx,'period.read');requireEntity(ctx,entityId);const row=(await tx.query('select * from lara.periods where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Period not found.');return periodResource(row);}
export async function listPeriods(tx,ctx,entityId,query){requirePermission(ctx,'period.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];let where='';if(query?.bookId){if(!isUuid(query.bookId))fail('VALIDATION_FAILED','bookId must be a UUID.');params.push(query.bookId);where=' and book_id=$'+params.length;}const rows=(await tx.query('select * from lara.periods where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;return page(rows,limit,periodResource,scope);}
export const closeTaskResource=t=>resource(t,{requirement:t.requirement,required:t.required,...(t.owner_id?{ownerId:t.owner_id}:{}),periodId:t.period_id,closeVersion:t.close_version,...(t.evidence_id?{evidenceId:t.evidence_id}:{})});
export async function listCloseTasks(tx,ctx,entityId,periodId,query){requirePermission(ctx,'period.read');requireEntity(ctx,entityId);const period=(await tx.query('select close_version from lara.periods where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,periodId])).rows[0];if(!period)fail('NOT_FOUND','Period not found.');const scope=cursorScope(ctx,entityId,{...(query||{}),periodId});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,periodId,period.close_version,limit+1];const rows=(await tx.query('select * from lara.close_tasks where tenant_id=$1 and entity_id=$2 and period_id=$3 and close_version=$4'+cursorClause(after,params)+' order by created_at,id limit $5',params)).rows;return page(rows,limit,closeTaskResource,scope);}
export async function addCloseTask(tx,ctx,entityId,periodId,{requirement,required=true,ownerId=null}){
 requirePermission(ctx,'period.edit');requireEntity(ctx,entityId);
 const period=await loadPeriod(tx,ctx,entityId,periodId);
 if(!/^[a-z][a-z0-9_]{0,63}$/.test(requirement))fail('VALIDATION_FAILED','Requirement codes are lower-case identifiers.',{fieldErrors:[{path:'requirement',message:'Invalid code'}]});
 const row=(await tx.query('insert into lara.close_tasks(tenant_id,entity_id,period_id,close_version,requirement,required,owner_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tenant_id,entity_id,period_id,close_version,requirement) do update set required=excluded.required returning *',[ctx.tenantId,entityId,periodId,period.close_version,requirement,required,ownerId,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'close_task.add',resourceType:'close_task',resourceId:row.id,resourceVersion:Number(row.version)});
 return closeTaskResource(row);
}
export async function completeCloseTask(tx,ctx,entityId,taskId,{evidenceId,waiverReason},expectedVersion){
 requirePermission(ctx,'period.edit');requireEntity(ctx,entityId);
 const row=(await tx.query('select * from lara.close_tasks where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,taskId])).rows[0];
 if(!row)fail('NOT_FOUND','Close task not found.');if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='open')return {resourceType:'close_task',resourceId:taskId,version:Number(row.version),state:row.status};
 if(!evidenceId&&!waiverReason)fail('EVIDENCE_NOT_READY','Complete the task with available evidence, or waive a non-required task with a reason.');
 if(waiverReason){if(row.required)fail('STATE_CONFLICT','Required close tasks cannot be waived.');await tx.query("update lara.close_tasks set status='waived',waiver_reason=$3 where tenant_id=$1 and id=$2",[ctx.tenantId,taskId,waiverReason]);}
 else{await linkEvidence(tx,ctx,entityId,[evidenceId],'close_task',taskId,Number(row.version)+1);await tx.query("update lara.close_tasks set status='complete',evidence_id=$3,completed_by=$4,completed_at=now() where tenant_id=$1 and id=$2",[ctx.tenantId,taskId,evidenceId,ctx.principalId]);}
 await audit(tx,ctx,{entityId,action:waiverReason?'close_task.waive':'close_task.complete',resourceType:'close_task',resourceId:taskId,reason:waiverReason||null});
 return {resourceType:'close_task',resourceId:taskId,version:Number(row.version)+1,state:waiverReason?'waived':'complete'};
}

// ---------------------------------------------------------------------------
// Journals: drafts → submit → independent approve → post via the function
// ---------------------------------------------------------------------------
const lineMaterial=l=>({accountId:l.accountId,branchId:l.branchId,debit:money(l.debit),credit:money(l.credit),dimensions:Object.fromEntries(Object.entries(l.dimensions||{}).sort())});
const journalMaterial=i=>({bookId:i.bookId,accountingDate:i.accountingDate,documentDate:i.documentDate,currency:i.currency,description:i.description.trim(),lines:i.lines.map(lineMaterial),evidenceIds:[...(i.evidenceIds||[])].sort()});
export const journalResource=j=>resource(j,{bookId:j.book_id,accountingDate:iso(j.accounting_date),documentDate:iso(j.document_date),currency:j.currency,description:j.description,lines:j.lines,evidenceIds:j.evidence_ids,...(j.posted_entry_id?{}:{}),...(j.reversal_of?{}:{})});
function validateLines(lines){
 let debit=0n,credit=0n;
 lines.forEach((l,i)=>{const d=micros(l.debit),c=micros(l.credit);if((d>0n)===(c>0n))fail('VALIDATION_FAILED','Each line has exactly one positive side.',{fieldErrors:[{path:'lines.'+i,message:'One side only'}]});debit+=d;credit+=c;});
 if(debit!==credit)fail('UNBALANCED_ENTRY','Debits '+decimal(debit)+' differ from credits '+decimal(credit)+'.',{fieldErrors:[{path:'lines',message:'Difference '+decimal(debit-credit)}]});
 return {debit,credit};
}
export async function createJournal(tx,ctx,entityId,input,{reversalOf=null}={}){
 requirePermission(ctx,'journal.prepare');requireEntity(ctx,entityId);assertInput('JournalCreate',input);await requireLedger(tx,ctx,entityId);
 const book=await bookFor(tx,ctx,entityId,input.bookId);
 if(input.currency!==book.functional_currency)fail('FEATURE_NOT_ENABLED','Foreign-currency journals arrive with separate books (P09).');
 validateLines(input.lines);
 const m=journalMaterial(input),hash=contentHash(m);
 const row=(await tx.query('insert into lara.journal_drafts(tenant_id,entity_id,book_id,accounting_date,document_date,currency,description,lines,evidence_ids,content_hash,reversal_of,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[ctx.tenantId,entityId,input.bookId,input.accountingDate,input.documentDate,input.currency,m.description,JSON.stringify(m.lines),JSON.stringify(m.evidenceIds),hash,reversalOf,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'journal.prepare',resourceType:'journal',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return journalResource(row);
}
export async function updateJournal(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'journal.edit');requireEntity(ctx,entityId);assertInput('JournalCreate',input);
 const row=(await tx.query('select * from lara.journal_drafts where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Journal not found.');expectVersion(row,expectedVersion);
 if(['posted','cancelled'].includes(row.status))fail('STATE_CONFLICT','Posted or cancelled journals cannot change; prepare a reversal.');
 if(row.book_id!==input.bookId)fail('VALIDATION_FAILED','A journal cannot move between books.',{fieldErrors:[{path:'bookId',message:'Immutable'}]});
 validateLines(input.lines);
 const m=journalMaterial(input),hash=contentHash(m),material=hash!==row.content_hash;
 // Material edits invalidate approval and return the journal to draft in the same statement.
 const updated=(await tx.query("update lara.journal_drafts set status=case when $12 then 'draft' else status end,approved_by=case when $12 then null else approved_by end,submitted_by=case when $12 then null else submitted_by end,accounting_date=$4,document_date=$5,currency=$6,description=$7,lines=$8,evidence_ids=$9,content_hash=$10,content_version=content_version+$11 where tenant_id=$1 and entity_id=$2 and id=$3 returning *",[ctx.tenantId,entityId,id,input.accountingDate,input.documentDate,input.currency,m.description,JSON.stringify(m.lines),JSON.stringify(m.evidenceIds),hash,material?1:0,material])).rows[0];
 await audit(tx,ctx,{entityId,action:'journal.edit',resourceType:'journal',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return journalResource(updated);
}
async function loadJournal(tx,ctx,entityId,id){const row=(await tx.query('select * from lara.journal_drafts where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Journal not found.');return row;}
export async function submitJournal(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'journal.submit');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadJournal(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','changes_requested'].includes(row.status))fail('STATE_CONFLICT','Journal is '+row.status+'.');
 if(row.status==='changes_requested')await tx.query("update lara.journal_drafts set status='draft' where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 if(row.evidence_ids.length)await linkEvidence(tx,ctx,entityId,row.evidence_ids,'journal',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.journal_drafts set status='submitted',submitted_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'journal.submit',resourceType:'journal',resourceId:id,resourceVersion:Number(updated.version)});
 return {resourceType:'journal',resourceId:id,version:Number(updated.version),state:'submitted'};
}
export async function approveJournal(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'journal.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadJournal(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='submitted')fail('STATE_CONFLICT','Only submitted journals are decided.');
 if(row.created_by===ctx.principalId||row.submitted_by===ctx.principalId)fail('SELF_APPROVAL','The preparer or submitter cannot approve this journal.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The journal content changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const status=input.decision==='approve'?'approved':'changes_requested';
 const updated=(await tx.query('update lara.journal_drafts set status=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,status,input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'journal.'+input.decision,resourceType:'journal',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.content_hash});
 return {resourceType:'journal',resourceId:id,version:Number(updated.version),state:status};
}
// Posting recomputes nothing client-side: the draft's approved lines are handed
// to the database posting function, which validates and writes the entry. The
// approval binds the content version, so a changed draft cannot post.
export async function postJournal(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'journal.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadJournal(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='approved')fail('STATE_CONFLICT','Approval is required before posting.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot both approve and post.');
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'journal_draft',sourceId:row.id,sourceVersion:Number(row.content_version),purpose:row.reversal_of?'reversal':'posting',accountingDate:iso(row.accounting_date),documentDate:iso(row.document_date),description:row.description,currency:row.currency,manual:true,postingActor:ctx.principalId,commandId,reversalOf:row.reversal_of,lines:row.lines})])).rows[0].id;
 const updated=(await tx.query("update lara.journal_drafts set status='posted',posted_entry_id=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId])).rows[0];
 await audit(tx,ctx,{entityId,action:'journal.post',resourceType:'journal',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'journal',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'document.posted.v1',payload:{journalId:id,entryId,bookId:row.book_id,accountingDate:iso(row.accounting_date)}});
 return {resourceType:'journal',resourceId:id,version:Number(updated.version),state:'posted',journalEntryIds:[entryId]};
}
// A reversal is a new draft with swapped sides, linked to the posted entry, and
// travels through submit/approve/post like any journal.
export async function reverseJournal(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'journal.reverse');requireEntity(ctx,entityId);assertInput('Reversal',input);
 const row=await loadJournal(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='posted')fail('STATE_CONFLICT','Only posted journals are reversed.');
 const lines=row.lines.map(l=>({...l,debit:l.credit,credit:l.debit}));
 const draft=await createJournal(tx,ctx,entityId,{bookId:row.book_id,accountingDate:input.accountingDate,documentDate:input.accountingDate,currency:row.currency,description:'Reversal of '+row.description+': '+input.reason,lines,evidenceIds:input.evidenceIds||[]},{reversalOf:row.posted_entry_id});
 await audit(tx,ctx,{entityId,action:'journal.reverse',resourceType:'journal',resourceId:id,resourceVersion:Number(row.version),reason:input.reason,afterRef:draft.id});
 return {resourceType:'journal',resourceId:draft.id,version:1,state:'draft'};
}
export async function getJournal(tx,ctx,entityId,id){requirePermission(ctx,'journal.read');requireEntity(ctx,entityId);const row=(await tx.query('select * from lara.journal_drafts where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Journal not found.');return journalResource(row);}
export async function listJournals(tx,ctx,entityId,query){
 requirePermission(ctx,'journal.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.bookId){if(!isUuid(query.bookId))fail('VALIDATION_FAILED','bookId must be a UUID.');params.push(query.bookId);where+=' and book_id=$'+params.length;}
 if(query?.status){params.push(String(query.status).split(','));where+=' and status=any($'+params.length+'::text[])';}
 const rows=(await tx.query('select * from lara.journal_drafts where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,journalResource,scope);
}
export async function ledgerLines(tx,ctx,entityId,{bookId,accountId,from,to}){
 requirePermission(ctx,'journal.read');requireEntity(ctx,entityId);
 return (await tx.query('select e.id as entry_id,e.accounting_date,e.description,e.source_type,e.source_id,e.purpose,l.line_no,l.func_debit,l.func_credit,l.branch_id,l.dimensions_json from lara.journal_lines l join lara.journal_entries e on e.id=l.entry_id where l.tenant_id=$1 and l.entity_id=$2 and l.book_id=$3 and l.account_id=$4 and e.accounting_date between $5 and $6 order by e.accounting_date,e.posted_at,l.line_no',[ctx.tenantId,entityId,bookId,accountId,from,to])).rows.map(r=>({entryId:r.entry_id,accountingDate:iso(r.accounting_date),description:r.description,sourceType:r.source_type,sourceId:r.source_id,purpose:r.purpose,lineNo:r.line_no,debit:money(String(r.func_debit)),credit:money(String(r.func_credit)),branchId:r.branch_id,dimensions:r.dimensions_json}));
}

// ---------------------------------------------------------------------------
// Reports: trial balance and basic statements with immutable snapshots
// ---------------------------------------------------------------------------
export async function trialBalance(tx,ctx,entityId,{bookId,periodStart,periodEnd,asOf}){
 requirePermission(ctx,'report.generate');requireEntity(ctx,entityId);await bookFor(tx,ctx,entityId,bookId);
 const rows=(await tx.query('select * from lara.account_balances($1,$2,$3,$4,$5,$6)',[ctx.tenantId,entityId,bookId,periodStart,periodEnd,asOf])).rows;
 let debit=0n,credit=0n;
 const lines=rows.map(r=>{const d=micros(String(r.debit)),c=micros(String(r.credit));debit+=d;credit+=c;return {accountId:r.account_id,code:r.code,name:r.name,category:r.category,debit:decimal(d),credit:decimal(c),balance:decimal(signedMicros(r.balance))};});
 return {reportType:'trial_balance',bookId,periodStart,periodEnd,asOf,lines,totals:{debit:decimal(debit),credit:decimal(credit),balanced:debit===credit}};
}
export async function statements(tx,ctx,entityId,{bookId,periodStart,periodEnd,asOf}){
 const tb=await trialBalance(tx,ctx,entityId,{bookId,periodStart,periodEnd,asOf});
 const sum=cats=>decimal(tb.lines.filter(l=>cats.includes(l.category)).reduce((s,l)=>s+signedMicros(l.balance),0n));
 // Balance sheet uses cumulative balances from the beginning of the book; the
 // income statement uses the period. Labels are management statements.
 const cumulative=await trialBalance(tx,ctx,entityId,{bookId,periodStart:'1900-01-01',periodEnd,asOf});
 const csum=cats=>decimal(cumulative.lines.filter(l=>cats.includes(l.category)).reduce((s,l)=>s+signedMicros(l.balance),0n));
 const income=signedMicros(sum(['income'])),expense=signedMicros(sum(['expense']));
 const netIncome=decimal(income-expense);
 const cumIncome=signedMicros(csum(['income']))-signedMicros(csum(['expense']));
 return {reportType:'statements',label:'Management statements — not statutory presentation',bookId,periodStart,periodEnd,asOf,incomeStatement:{income:sum(['income']),expense:sum(['expense']),netIncome},balanceSheet:{assets:csum(['asset']),liabilities:csum(['liability']),equity:csum(['equity']),currentEarnings:decimal(cumIncome),balanced:signedMicros(csum(['asset']))===signedMicros(csum(['liability']))+signedMicros(csum(['equity']))+cumIncome},lines:cumulative.lines.filter(l=>['asset','liability','equity'].includes(l.category)).concat(tb.lines.filter(l=>['income','expense'].includes(l.category)))};
}
// Later modules register report builders (P04 aging) without a second snapshot model.
export async function snapshotReport(tx,ctx,entityId,input,{ruleVersion='p03.1',builders={}}={}){
 requirePermission(ctx,'report.generate');requireEntity(ctx,entityId);assertInput('ReportRequest',input);
 if(!['trial_balance','statements'].includes(input.reportType)&&!builders[input.reportType])fail('FEATURE_NOT_ENABLED','Report type '+input.reportType+' arrives with a later module.');
 if(input.currency&&input.currency!=='PHP')fail('FEATURE_NOT_ENABLED','Reporting currencies other than PHP arrive with P09.');
 const payload=builders[input.reportType]?await builders[input.reportType](tx,ctx,entityId,input):input.reportType==='trial_balance'?await trialBalance(tx,ctx,entityId,{bookId:input.bookId,periodStart:input.periodStart,periodEnd:input.periodEnd,asOf:input.asOf}):await statements(tx,ctx,entityId,{bookId:input.bookId,periodStart:input.periodStart,periodEnd:input.periodEnd,asOf:input.asOf});
 const checksum=sha(JSON.stringify(payload));
 const periodKey=input.periodStart.slice(0,7)===input.periodEnd.slice(0,7)?input.periodStart.slice(0,7):input.periodStart.slice(0,4);
 const version=((await tx.query('select coalesce(max(version_number),0)::int v from lara.report_snapshots where tenant_id=$1 and entity_id=$2 and book_id=$3 and report_type=$4 and period_key=$5',[ctx.tenantId,entityId,input.bookId,input.reportType,periodKey])).rows[0].v)+1;
 const row=(await tx.query('insert into lara.report_snapshots(tenant_id,entity_id,book_id,report_type,period_key,version_number,cutoff_posted_at,rule_version,parameters,payload,checksum,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id,created_at',[ctx.tenantId,entityId,input.bookId,input.reportType,periodKey,version,input.asOf,ruleVersion,JSON.stringify({periodStart:input.periodStart,periodEnd:input.periodEnd,format:input.format,dimensions:input.dimensions||{}}),JSON.stringify(payload),checksum,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'report.snapshot',resourceType:'report_snapshot',resourceId:row.id,resourceVersion:version,afterRef:checksum});
 return {id:row.id,reportType:input.reportType,periodKey,versionNumber:version,checksum,payload};
}

// ---------------------------------------------------------------------------
// Opening imports: staged rows validated against the chart, tied to control
// accounts, approved independently and committed through the posting function.
// ---------------------------------------------------------------------------
export const importResource=b=>resource({...b,status:b.state},{kind:b.kind,evidenceId:b.evidence_id,mappingVersion:b.mapping_version,sourceId:b.source_id,externalBatchId:b.external_batch_id,cutoffDate:iso(b.cutoff)});
export async function createImport(tx,ctx,entityId,input,{bookId}={}){
 requirePermission(ctx,'import.create');requireEntity(ctx,entityId);assertInput('ImportCreate',input);await requireLedger(tx,ctx,entityId);
 if(input.kind!=='openings')fail('FEATURE_NOT_ENABLED','Import kind '+input.kind+' arrives with its owning module.');
 if(!bookId){const primary=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary' and status='active'",[ctx.tenantId,entityId])).rows[0];if(!primary)fail('STATE_CONFLICT','No active primary book.');bookId=primary.id;}
 const evidence=(await tx.query("select id,sha256,status,mime from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,input.evidenceId])).rows[0];
 if(!evidence)fail('NOT_FOUND','Evidence not found.');
 if(evidence.status!=='available')fail('EVIDENCE_NOT_READY','Import evidence must be available.');
 if(evidence.mime!=='text/csv')fail('VALIDATION_FAILED','Opening imports read CSV evidence.',{fieldErrors:[{path:'evidenceId',message:'CSV required'}]});
 const row=(await tx.query('insert into lara.opening_batches(tenant_id,entity_id,book_id,kind,evidence_id,checksum,cutoff,source_id,external_batch_id,mapping_version,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[ctx.tenantId,entityId,bookId,input.kind,input.evidenceId,evidence.sha256,input.cutoffDate,input.sourceId.trim(),input.externalBatchId.trim(),input.mappingVersion.trim(),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'import.create',resourceType:'import',resourceId:row.id,resourceVersion:1,afterRef:evidence.sha256});
 return importResource(row);
}
export function parseOpeningCsv(text){
 const lines=text.replace(/\r\n/g,'\n').split('\n').filter(l=>l.trim());
 if(lines.length<2)fail('VALIDATION_FAILED','The CSV needs a header and at least one row.');
 const cells=l=>{const out=[];let cur='',q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'&&l[i+1]==='"'){cur+='"';i++;}else if(ch==='"')q=false;else cur+=ch;}else if(ch==='"')q=true;else if(ch===','){out.push(cur);cur='';}else cur+=ch;}out.push(cur);return out.map(c=>c.trim());};
 const header=cells(lines[0]).map(h=>h.toLowerCase());
 const required=['source_key','account_code','branch_code','accounting_date','debit','credit'];
 for(const r of required)if(!header.includes(r))fail('VALIDATION_FAILED','CSV header lacks '+r+'.',{fieldErrors:[{path:'header',message:'Missing '+r}]});
 return lines.slice(1).map((l,i)=>{const c=cells(l);const row={};header.forEach((h,j)=>{row[h]=c[j]??'';});row.rowNo=i+1;row.dimensions={};for(const h of header)if(h.startsWith('dim_')&&row[h])row.dimensions[h.slice(4)]=row[h];return row;});
}
export async function validateImport(tx,ctx,entityId,id,input,expectedVersion,{store}){
 requirePermission(ctx,'import.validate');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const batch=(await tx.query('select * from lara.opening_batches where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!batch)fail('NOT_FOUND','Import not found.');if(expectedVersion!==undefined)expectVersion(batch,expectedVersion);
 if(!['staged','validated'].includes(batch.state))fail('STATE_CONFLICT','Import is '+batch.state+'.');
 const evidence=(await tx.query('select object_key,sha256 from lara.evidence where tenant_id=$1 and id=$2',[ctx.tenantId,batch.evidence_id])).rows[0];
 const bytes=await store.get(evidence.object_key);
 if(sha(bytes)!==batch.checksum)fail('STATE_CONFLICT','Evidence content no longer matches the import checksum.');
 const rows=parseOpeningCsv(bytes.toString('utf8'));
 const accounts=new Map((await tx.query("select id,code,status,control_type,(select count(*) from lara.accounts c where c.tenant_id=a.tenant_id and c.parent_id=a.id and c.status<>'archived') as children from lara.accounts a where tenant_id=$1 and entity_id=$2 and book_id=$3",[ctx.tenantId,entityId,batch.book_id])).rows.map(a=>[a.code,a]));
 const branches=new Map((await tx.query("select id,code from lara.branches where tenant_id=$1 and entity_id=$2 and status='active'",[ctx.tenantId,entityId])).rows.map(b=>[b.code,b.id]));
 let debit=0n,credit=0n,errors=0;const control=new Map();const seen=new Set();
 // Re-validation replaces staged rows; committed imports never reach here.
 const existing=(await tx.query('select id,source_key from lara.opening_rows where tenant_id=$1 and batch_id=$2',[ctx.tenantId,id])).rows;
 for(const r of rows){
  let error=null,accountId=null,branchId=null,d=0n,c=0n;
  if(!r.source_key)error='source key required';
  else if(seen.has(r.source_key))error='duplicate source key';
  seen.add(r.source_key);
  const a=accounts.get(String(r.account_code).toUpperCase());
  if(!error&&!a)error='unknown account '+r.account_code;
  else if(!error&&a.status!=='active')error='account '+a.code+' is '+a.status;
  else if(!error&&Number(a.children)>0)error='account '+a.code+' is not a leaf';
  if(!error){accountId=a.id;branchId=branches.get(String(r.branch_code).toUpperCase())||null;if(!branchId)error='unknown branch '+r.branch_code;}
  if(!error){try{d=micros(r.debit||'0');c=micros(r.credit||'0');if((d>0n)===(c>0n))error='exactly one of debit or credit';}catch{error='invalid amount';}}
  if(!error&&!/^\d{4}-\d{2}-\d{2}$/.test(r.accounting_date))error='invalid date';
  if(!error&&r.accounting_date>iso(batch.cutoff))error='date after cutoff';
  if(!error){debit+=d;credit+=c;if(a.control_type!=='none')control.set(a.id,(control.get(a.id)||0n)+d-c);}
  else errors++;
  const status=error?'error':'valid';
  const prior=existing.find(e=>e.source_key===r.source_key);
  if(prior)await tx.query('update lara.opening_rows set row_no=$3,account_code=$4,account_id=$5,branch_code=$6,branch_id=$7,accounting_date=$8,debit=$9,credit=$10,dimensions_json=$11,status=$12,error=$13 where tenant_id=$1 and id=$2',[ctx.tenantId,prior.id,r.rowNo,r.account_code,accountId,r.branch_code,branchId,error&&!/^\d{4}-\d{2}-\d{2}$/.test(r.accounting_date)?iso(batch.cutoff):r.accounting_date,decimal(d),decimal(c),JSON.stringify(r.dimensions),status,error]);
  else await tx.query('insert into lara.opening_rows(tenant_id,entity_id,batch_id,row_no,source_key,account_code,account_id,branch_code,branch_id,accounting_date,debit,credit,dimensions_json,status,error) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',[ctx.tenantId,entityId,id,r.rowNo,r.source_key||('row-'+r.rowNo),r.account_code,accountId,r.branch_code,branchId,/^\d{4}-\d{2}-\d{2}$/.test(r.accounting_date)?r.accounting_date:iso(batch.cutoff),decimal(d>0n?d:c>0n?0n:1n),decimal(c>0n?c:d>0n?0n:0n),JSON.stringify(r.dimensions),status,error]);
 }
 // Control totals derive from the checksummed evidence, so a re-validation reproduces them; the first record stands.
 for(const [accountId,total] of control)await tx.query('insert into lara.source_control_balances(tenant_id,entity_id,batch_id,control_account_id,detail_total) values($1,$2,$3,$4,$5) on conflict do nothing',[ctx.tenantId,entityId,id,accountId,decimal(total)]);
 if(debit!==credit)errors++;
 const state=errors?'staged':'validated';
 const updated=(await tx.query('update lara.opening_batches set state=$3,row_count=$4,error_count=$5,debit_total=$6,credit_total=$7 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,state,rows.length,errors,decimal(debit),decimal(credit)])).rows[0];
 await audit(tx,ctx,{entityId,action:'import.validate',resourceType:'import',resourceId:id,resourceVersion:Number(updated.version),reason:errors?errors+' error(s)':'valid'});
 if(debit!==credit)fail('UNBALANCED_ENTRY','Opening debits '+decimal(debit)+' differ from credits '+decimal(credit)+'.',{fieldErrors:[{path:'rows',message:'Difference '+decimal(debit-credit)}]});
 return {resourceType:'import',resourceId:id,version:Number(updated.version),state,rows:rows.length,errors};
}
export async function approveImport(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'import.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const batch=(await tx.query('select * from lara.opening_batches where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!batch)fail('NOT_FOUND','Import not found.');if(expectedVersion!==undefined)expectVersion(batch,expectedVersion);
 if(batch.state!=='validated')fail('STATE_CONFLICT','Validate the import before approval.');
 if(batch.created_by===ctx.principalId)fail('SELF_APPROVAL','The import author cannot approve it.');
 if(Number(batch.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The import changed since review.',{resourceVersion:Number(batch.version)});
 const state=input.decision==='approve'?'approved':'rejected';
 const updated=(await tx.query('update lara.opening_batches set state=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,state,input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'import.'+input.decision,resourceType:'import',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'import',resourceId:id,version:Number(updated.version),state};
}
// Commit posts one opening entry for the batch through the posting function.
// The same batch committed twice returns the same entry; another committed
// openings batch with an overlapping cutoff for the book is refused.
export async function commitImport(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'import.commit');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const batch=(await tx.query('select * from lara.opening_batches where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!batch)fail('NOT_FOUND','Import not found.');if(expectedVersion!==undefined)expectVersion(batch,expectedVersion);
 if(batch.state==='committed')return {resourceType:'import',resourceId:id,version:Number(batch.version),state:'committed',journalEntryIds:[batch.committed_entry_id]};
 if(batch.state!=='approved')fail('STATE_CONFLICT','Approve the import before committing.');
 const overlapping=(await tx.query("select id from lara.opening_batches where tenant_id=$1 and book_id=$2 and kind='openings' and state='committed' and id<>$3 and cutoff=$4",[ctx.tenantId,batch.book_id,id,batch.cutoff])).rows[0];
 if(overlapping)fail('STATE_CONFLICT','Openings for this cutoff were already committed by import '+overlapping.id+'.');
 const rows=(await tx.query("select * from lara.opening_rows where tenant_id=$1 and batch_id=$2 and status='valid' order by row_no",[ctx.tenantId,id])).rows;
 if(!rows.length)fail('STATE_CONFLICT','No valid rows to commit.');
 const lines=rows.map(r=>({accountId:r.account_id,branchId:r.branch_id,debit:money(String(r.debit)),credit:money(String(r.credit)),dimensions:r.dimensions_json}));
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:batch.book_id,sourceType:'opening_batch',sourceId:id,sourceVersion:Number(batch.content_version),purpose:'opening',accountingDate:iso(batch.cutoff),documentDate:iso(batch.cutoff),description:'Opening balances '+batch.source_id+' '+batch.external_batch_id,currency:'PHP',manual:false,postingActor:ctx.principalId,commandId,lines})])).rows[0].id;
 const updated=(await tx.query("update lara.opening_batches set state='committed',committed_entry_id=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId])).rows[0];
 await audit(tx,ctx,{entityId,action:'import.commit',resourceType:'import',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'import',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'document.posted.v1',payload:{importId:id,entryId,bookId:batch.book_id}});
 return {resourceType:'import',resourceId:id,version:Number(updated.version),state:'committed',journalEntryIds:[entryId]};
}
// Only staged imports change; validated ones return to staged so the rows are checked again.
export async function updateImport(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'import.edit');requireEntity(ctx,entityId);assertInput('ImportCreate',input);
 const batch=(await tx.query('select * from lara.opening_batches where tenant_id=$1 and entity_id=$2 and id=$3 for update',[ctx.tenantId,entityId,id])).rows[0];
 if(!batch)fail('NOT_FOUND','Import not found.');expectVersion(batch,expectedVersion);
 if(!['staged','validated'].includes(batch.state))fail('STATE_CONFLICT','Import is '+batch.state+'.');
 if(input.kind!==batch.kind||input.evidenceId!==batch.evidence_id||input.sourceId.trim()!==batch.source_id)fail('VALIDATION_FAILED','Kind, evidence and source are fixed; create a new import for different content.',{fieldErrors:[{path:'evidenceId',message:'Immutable'}]});
 const updated=(await tx.query("update lara.opening_batches set state='staged',mapping_version=$3,external_batch_id=$4,cutoff=$5,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.mappingVersion.trim(),input.externalBatchId.trim(),input.cutoffDate])).rows[0];
 await audit(tx,ctx,{entityId,action:'import.edit',resourceType:'import',resourceId:id,resourceVersion:Number(updated.version)});
 return importResource(updated);
}
export async function getImport(tx,ctx,entityId,id){requirePermission(ctx,'import.read');requireEntity(ctx,entityId);const row=(await tx.query('select * from lara.opening_batches where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Import not found.');return importResource(row);}
export async function listImports(tx,ctx,entityId,query){requirePermission(ctx,'import.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];const rows=(await tx.query('select * from lara.opening_batches where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;return page(rows,limit,importResource,scope);}
export async function importRows(tx,ctx,entityId,id){requirePermission(ctx,'import.read');requireEntity(ctx,entityId);return (await tx.query('select row_no,source_key,account_code,branch_code,accounting_date,debit,credit,status,error from lara.opening_rows where tenant_id=$1 and entity_id=$2 and batch_id=$3 order by row_no',[ctx.tenantId,entityId,id])).rows.map(r=>({rowNo:r.row_no,sourceKey:r.source_key,accountCode:r.account_code,branchCode:r.branch_code,accountingDate:iso(r.accounting_date),debit:money(String(r.debit)),credit:money(String(r.credit)),status:r.status,error:r.error}));}

// ---------------------------------------------------------------------------
// Fiscal-year close: transfer income and expense balances to retained
// earnings exactly once per book and fiscal year.
// ---------------------------------------------------------------------------
const stableUuid=(...parts)=>{const h=sha(parts.join('|'));return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
export async function closeFiscalYear(tx,ctx,entityId,{bookId,fiscalYear,retainedEarningsAccountId,branchId,reason},{commandId=null}={}){
 requirePermission(ctx,'period.lock');requireEntity(ctx,entityId);
 const book=await bookFor(tx,ctx,entityId,bookId);
 const entity=(await tx.query('select fiscal_year_start_month from lara.entities where tenant_id=$1 and id=$2',[ctx.tenantId,entityId])).rows[0];
 const startMonth=entity.fiscal_year_start_month;
 const start=new Date(Date.UTC(fiscalYear,startMonth-1,1)),end=new Date(Date.UTC(fiscalYear+1,startMonth-1,0));
 const from=start.toISOString().slice(0,10),to=end.toISOString().slice(0,10);
 const re=(await tx.query("select id,category,status from lara.accounts where tenant_id=$1 and entity_id=$2 and book_id=$3 and id=$4",[ctx.tenantId,entityId,bookId,retainedEarningsAccountId])).rows[0];
 if(!re||re.category!=='equity'||re.status!=='active')fail('VALIDATION_FAILED','Retained earnings must be an active equity account.',{fieldErrors:[{path:'retainedEarningsAccountId',message:'Active equity account required'}]});
 const open=(await tx.query("select count(*)::int n from lara.periods where tenant_id=$1 and book_id=$2 and starts_on<=$4 and ends_on>=$3 and status<>'locked'",[ctx.tenantId,bookId,from,to])).rows[0].n;
 if(open)fail('STATE_CONFLICT',open+' period(s) of fiscal year '+fiscalYear+' are not locked.');
 const closingPeriod=(await tx.query("select id from lara.periods where tenant_id=$1 and book_id=$2 and $3 between starts_on and ends_on",[ctx.tenantId,bookId,to])).rows[0];
 if(!closingPeriod)fail('STATE_CONFLICT','No period covers the fiscal year end '+to+'.');
 // A repeated close returns the entry already posted for this book and year.
 const prior=(await tx.query("select id,total_debit from lara.journal_entries where tenant_id=$1 and book_id=$2 and source_type='fiscal_year_close' and source_id=$3 and purpose='closing'",[ctx.tenantId,bookId,stableUuid(bookId,fiscalYear)])).rows[0];
 if(prior){const re_line=(await tx.query('select func_debit,func_credit from lara.journal_lines where entry_id=$1 and account_id=$2',[prior.id,retainedEarningsAccountId])).rows[0];return {resourceType:'book',resourceId:bookId,version:Number(book.version),state:'closed_'+fiscalYear,journalEntryIds:[prior.id],netIncome:re_line?decimal(signedMicros(re_line.func_credit)-signedMicros(re_line.func_debit)):'0.00',replayed:true};}
 const balances=(await tx.query("select * from lara.account_balances($1,$2,$3,$4,$5,now()) where category in ('income','expense') and balance<>0",[ctx.tenantId,entityId,bookId,from,to])).rows;
 if(!balances.length)fail('STATE_CONFLICT','No income or expense balances to close for '+fiscalYear+'.');
 let net=0n;const lines=[];
 for(const b of balances){const bal=signedMicros(b.balance);if(b.category==='income'){lines.push({accountId:b.account_id,branchId,debit:decimal(bal),credit:'0.00',dimensions:{}});net+=bal;}else{lines.push({accountId:b.account_id,branchId,debit:'0.00',credit:decimal(bal),dimensions:{}});net-=bal;}}
 lines.push(net>=0n?{accountId:retainedEarningsAccountId,branchId,debit:'0.00',credit:decimal(net),dimensions:{}}:{accountId:retainedEarningsAccountId,branchId,debit:decimal(-net),credit:'0.00',dimensions:{}});
 // The closing entry is the one posting a locked year-end period accepts; the
 // stable source id makes a repeated close return the same entry.
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId,sourceType:'fiscal_year_close',sourceId:stableUuid(bookId,fiscalYear),sourceVersion:1,purpose:'closing',accountingDate:to,documentDate:to,description:'Fiscal year '+fiscalYear+' close to retained earnings',currency:book.functional_currency,manual:false,postingActor:ctx.principalId,commandId,lines})])).rows[0].id;
 await audit(tx,ctx,{entityId,action:'fiscal_year.close',resourceType:'book',resourceId:bookId,afterRef:entryId,reason:reason||null});
 return {resourceType:'book',resourceId:bookId,version:Number(book.version),state:'closed_'+fiscalYear,journalEntryIds:[entryId],netIncome:decimal(net)};
}
