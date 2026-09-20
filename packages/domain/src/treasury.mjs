// Treasury module (P06): reviewed bank accounts, bank statements imported
// through the P03 import pipeline (opening + signed lines = closing, one use
// per source line key), reconciliation matches proposed deterministically and
// confirmed by a reviewer with amounts that conserve and never overlap, check
// instruments in custody until they clear, transfers posted as one entry,
// cash sessions with denomination counts, explained variance and an
// independent handover, and bank file runs generated once per release.
// Nothing here executes at a bank: files are generated and stored; releases
// and settlements record evidence.
import {createHash} from 'node:crypto';
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,enqueueJob,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {linkEvidence} from './evidence.mjs';
import {encryptField} from './parties.mjs';
import {micros,decimal} from './ledger.mjs';
const money=v=>decimal(micros(String(v)),2);

const sha=b=>createHash('sha256').update(b).digest('hex');
const abs=v=>v<0n?-v:v;

// ---------------------------------------------------------------------------
// Capability, profile and shared lookups
// ---------------------------------------------------------------------------
export async function requireTreasury(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='treasury' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The treasury capability is not active for this entity.');
}
// The approved treasury profile: petty cash and cash variance accounts, the
// bank file format and the date window for match suggestions.
export async function treasuryProfile(tx,ctx,entityId,{required=true}={}){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='treasury_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row){if(required)fail('RULE_PROFILE_NOT_APPROVED','An approved treasury profile (cash account, variance account, file format) is required.');return {cashAccountId:null,cashVarianceAccountId:null,fileFormatVersion:'lara-csv-1',matchWindowDays:3};}
 const p=row.payload;
 return {cashAccountId:isUuid(p.cashAccountId)?p.cashAccountId:null,cashVarianceAccountId:isUuid(p.cashVarianceAccountId)?p.cashVarianceAccountId:null,fileFormatVersion:typeof p.fileFormatVersion==='string'&&p.fileFormatVersion?p.fileFormatVersion:'lara-csv-1',matchWindowDays:Number.isInteger(p.matchWindowDays)?p.matchWindowDays:3};
}
export async function bankAccountFor(tx,ctx,entityId,id,{lock=false,approved=true}={}){
 if(!isUuid(id))fail('VALIDATION_FAILED','bankAccountId must be a UUID.',{fieldErrors:[{path:'bankAccountId',message:'UUID'}]});
 const row=(await tx.query('select * from lara.bank_accounts where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];
 if(!row)fail('NOT_FOUND','Bank account not found.');
 if(approved&&row.status!=='approved')fail('STATE_CONFLICT','The bank account is '+row.status+'; only approved accounts carry statements, checks, transfers and files.');
 return row;
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------
const bankAccountResource=b=>resource(b,{bookId:b.book_id,ledgerAccountId:b.ledger_account_id,bankCode:b.bank_code,currency:b.currency,evidenceIds:b.evidence_ids,accountNumberMasked:'••••'+b.number_last4});
const accountMaterial=(i,numberHash)=>({bookId:i.bookId,ledgerAccountId:i.ledgerAccountId,bankCode:i.bankCode.trim().toUpperCase(),numberHash,currency:i.currency,evidenceIds:[...i.evidenceIds].sort()});
async function validateBankAccount(tx,ctx,entityId,m,number){
 if(!/^[A-Z0-9]{3,20}$/.test(m.bankCode))fail('VALIDATION_FAILED','Bank codes are 3 to 20 letters or digits.',{fieldErrors:[{path:'bankCode',message:'Invalid'}]});
 if(number!==null&&!/^[A-Za-z0-9]{4,34}$/.test(number))fail('VALIDATION_FAILED','Account numbers are 4 to 34 letters or digits.',{fieldErrors:[{path:'accountNumber',message:'Invalid'}]});
 const book=(await tx.query("select * from lara.books where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,m.bookId])).rows[0];
 if(!book)fail('NOT_FOUND','Book not found.');
 if(m.currency!==book.functional_currency)fail('FEATURE_NOT_ENABLED','Foreign-currency bank accounts arrive with P09.');
 const acct=(await tx.query('select * from lara.accounts where tenant_id=$1 and entity_id=$2 and book_id=$3 and id=$4',[ctx.tenantId,entityId,m.bookId,m.ledgerAccountId])).rows[0];
 if(!acct)fail('NOT_FOUND','Ledger account not found in this book.');
 if(acct.status!=='active'||acct.category!=='asset'||acct.control_type!=='none')fail('VALIDATION_FAILED','A bank account posts to an active asset account that is not a control account.',{fieldErrors:[{path:'ledgerAccountId',message:'Active asset account required'}]});
 await linkEvidence(tx,ctx,entityId,m.evidenceIds,'bank_account',m.ledgerAccountId,1);
}
export async function createBankAccount(tx,ctx,entityId,input,env){
 requirePermission(ctx,'bank_account.create');requireEntity(ctx,entityId);assertInput('BankAccountCreate',input);await requireTreasury(tx,ctx,entityId);
 const number=String(input.accountNumber||'').replace(/\s+/g,'');
 const bankCode=input.bankCode.trim().toUpperCase(),numberHash=sha(bankCode+':'+number);
 const m=accountMaterial(input,numberHash);await validateBankAccount(tx,ctx,entityId,m,number);
 const hash=contentHash(m);
 const row=(await tx.query('insert into lara.bank_accounts(tenant_id,entity_id,book_id,ledger_account_id,bank_code,encrypted_number,number_hash,number_last4,currency,evidence_ids,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[ctx.tenantId,entityId,m.bookId,m.ledgerAccountId,m.bankCode,encryptField(number,env),numberHash,number.slice(-4),m.currency,JSON.stringify(m.evidenceIds),hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'bank_account.create',resourceType:'bank_account',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return bankAccountResource(row);
}
export async function updateBankAccount(tx,ctx,entityId,id,expectedVersion,input,env){
 requirePermission(ctx,'bank_account.edit');requireEntity(ctx,entityId);assertInput('BankAccountEdit',input);
 const row=await bankAccountFor(tx,ctx,entityId,id,{lock:true,approved:false});expectVersion(row,expectedVersion);
 if(row.status==='archived')fail('STATE_CONFLICT','Archived bank accounts do not change.');
 const number=input.accountNumber?String(input.accountNumber).replace(/\s+/g,''):null;
 const numberHash=number?sha(input.bankCode.trim().toUpperCase()+':'+number):row.number_hash;
 const m=accountMaterial(input,numberHash);await validateBankAccount(tx,ctx,entityId,m,number);
 const hash=contentHash(m),material=hash!==row.content_hash;
 const updated=(await tx.query("update lara.bank_accounts set status=case when $12 then 'draft' else status end,approved_by=case when $12 then null else approved_by end,book_id=$3,ledger_account_id=$4,bank_code=$5,encrypted_number=$6,number_hash=$7,number_last4=$8,currency=$9,evidence_ids=$10,content_hash=$11,content_version=content_version+$13 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,m.bookId,m.ledgerAccountId,m.bankCode,number?encryptField(number,env):row.encrypted_number,numberHash,number?number.slice(-4):row.number_last4,m.currency,JSON.stringify(m.evidenceIds),hash,material,material?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:'bank_account.edit',resourceType:'bank_account',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return bankAccountResource(updated);
}
export async function approveBankAccount(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'bank_account.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await bankAccountFor(tx,ctx,entityId,id,{lock:true,approved:false});if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='draft')fail('STATE_CONFLICT','Bank account is '+row.status+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The principal who entered the bank account cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The bank account changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const status=input.decision==='approve'?'approved':'rejected';
 const updated=(await tx.query('update lara.bank_accounts set status=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,status,input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'bank_account.'+input.decision,resourceType:'bank_account',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.content_hash});
 return {resourceType:'bank_account',resourceId:id,version:Number(updated.version),state:status};
}
export async function getBankAccount(tx,ctx,entityId,id){requirePermission(ctx,'bank_account.read');requireEntity(ctx,entityId);return bankAccountResource(await bankAccountFor(tx,ctx,entityId,id,{approved:false}));}
export async function listBankAccounts(tx,ctx,entityId,query){
 requirePermission(ctx,'bank_account.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';if(query?.status)where+=' and status=$'+params.push(String(query.status));
 const rows=(await tx.query('select * from lara.bank_accounts where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,bankAccountResource,scope);
}

// ---------------------------------------------------------------------------
// Bank statements: CSV contract, validation and commit through the import pipeline
// ---------------------------------------------------------------------------
// CSV contract (P06): source_line_key, booked_date YYYY-MM-DD, value_date
// (optional), signed_amount (credit to bank positive), currency, reference,
// description. Two rows with source_line_key opening_balance and
// closing_balance carry the batch balances in signed_amount.
export function parseStatementCsv(text){
 const lines=text.replace(/\r\n/g,'\n').split('\n').filter(l=>l.trim());
 if(lines.length<3)fail('VALIDATION_FAILED','The statement CSV needs a header, the balance rows and at least one line.');
 const cells=l=>{const out=[];let cur='',q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'&&l[i+1]==='"'){cur+='"';i++;}else if(ch==='"')q=false;else cur+=ch;}else if(ch==='"')q=true;else if(ch===','){out.push(cur);cur='';}else cur+=ch;}out.push(cur);return out.map(c=>c.trim());};
 const header=cells(lines[0]).map(h=>h.toLowerCase());
 for(const r of ['source_line_key','booked_date','signed_amount','currency'])if(!header.includes(r))fail('VALIDATION_FAILED','Statement CSV header lacks '+r+'.',{fieldErrors:[{path:'header',message:'Missing '+r}]});
 const rows=lines.slice(1).map((l,i)=>{const c=cells(l);const row={};header.forEach((h,j)=>{row[h]=c[j]??'';});row.rowNo=i+1;return row;});
 const balance=key=>{const r=rows.find(x=>x.source_line_key===key);if(!r)fail('VALIDATION_FAILED','The statement lacks its '+key+' row.',{fieldErrors:[{path:key,message:'Required'}]});return r;};
 const opening=balance('opening_balance'),closing=balance('closing_balance');
 return {opening,closing,rows:rows.filter(r=>!['opening_balance','closing_balance'].includes(r.source_line_key))};
}
const signed=v=>{const s=String(v||'').trim();if(!/^-?\d{1,18}(\.\d{1,6})?$/.test(s))throw new Error('amount');const neg=s.startsWith('-');const m=micros(neg?s.slice(1):s);return neg?-m:m;};
// Validates the statement content against the account: currency, dates
// within the batch, balances, in-file duplicates and keys already imported.
export async function validateStatement(tx,ctx,entityId,batch,text){
 const account=await bankAccountFor(tx,ctx,entityId,batch.source_id);
 const {opening,closing,rows}=parseStatementCsv(text);
 let openingAmount,closingAmount;
 try{openingAmount=signed(opening.signed_amount);closingAmount=signed(closing.signed_amount);}catch{fail('VALIDATION_FAILED','Balance rows carry decimal amounts.',{fieldErrors:[{path:'opening_balance',message:'Invalid amount'}]});}
 const seen=new Set();let sum=0n,errors=0,duplicates=0;const lines=[];
 const existing=new Set((await tx.query('select source_line_key from lara.bank_statement_lines where tenant_id=$1 and bank_account_id=$2 and source_line_key=any($3::text[])',[ctx.tenantId,account.id,rows.map(r=>r.source_line_key)])).rows.map(r=>r.source_line_key));
 for(const r of rows){
  let error=null,amount=0n;
  if(!r.source_line_key)error='source line key required';
  else if(seen.has(r.source_line_key))error='duplicate source line key in the file';
  seen.add(r.source_line_key);
  if(!error){try{amount=signed(r.signed_amount);if(amount===0n)error='zero amount';}catch{error='invalid amount';}}
  if(!error&&!/^\d{4}-\d{2}-\d{2}$/.test(r.booked_date))error='invalid booked date';
  if(!error&&r.value_date&&!/^\d{4}-\d{2}-\d{2}$/.test(r.value_date))error='invalid value date';
  if(!error&&r.currency.toUpperCase()!==account.currency)error='currency '+r.currency+' differs from the account';
  if(!error&&r.booked_date>iso(batch.cutoff))error='booked after the statement cutoff';
  const duplicate=!error&&existing.has(r.source_line_key);
  // The bank's own totals include every line; keys already imported still count toward the balance but are not written again.
  if(error)errors++;else{sum+=amount;if(duplicate)duplicates++;}
  lines.push({...r,amount,error,duplicate});
 }
 if(openingAmount+sum!==closingAmount){errors++;lines.balanceError='Opening '+decimal(openingAmount)+' plus lines '+decimal(sum)+' is '+decimal(openingAmount+sum)+', not the closing '+decimal(closingAmount)+'.';}
 const dates=lines.filter(l=>!l.error).map(l=>l.booked_date).sort();
 return {account,openingAmount,closingAmount,sum,errors,duplicates,lines,fromDate:dates[0]||iso(batch.cutoff),toDate:dates.at(-1)||iso(batch.cutoff)};
}
// Commit writes the batch and its lines (skipping keys already imported) and
// queues match proposals; nothing posts to the ledger.
export async function commitStatement(tx,ctx,entityId,batch,text){
 const v=await validateStatement(tx,ctx,entityId,batch,text);
 if(v.errors)fail('VALIDATION_FAILED','The statement has '+v.errors+' error(s); validate it again.'+(v.lines.balanceError?' '+v.lines.balanceError:''));
 const row=(await tx.query('insert into lara.bank_statement_batches(tenant_id,entity_id,bank_account_id,import_id,from_date,to_date,source_hash,opening_balance,closing_balance,line_count,duplicate_count,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[ctx.tenantId,entityId,v.account.id,batch.id,v.fromDate,v.toDate,batch.checksum,decimal(v.openingAmount,6),decimal(v.closingAmount,6),v.lines.length-v.duplicates,v.duplicates,ctx.principalId])).rows[0];
 for(const l of v.lines)if(!l.duplicate)await tx.query('insert into lara.bank_statement_lines(tenant_id,entity_id,bank_account_id,batch_id,source_line_key,booked_date,value_date,signed_amount,currency,reference,description,source_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[ctx.tenantId,entityId,v.account.id,row.id,l.source_line_key,l.booked_date,l.value_date||null,decimal(l.amount,6),v.account.currency,l.reference||null,l.description||null,JSON.stringify({source_line_key:l.source_line_key,booked_date:l.booked_date,value_date:l.value_date||'',signed_amount:l.signed_amount,currency:l.currency,reference:l.reference||'',description:l.description||''})]);
 const jobId=await enqueueJob(tx,ctx,{entityId,kind:'bank.propose_matches',payload:{bankAccountId:v.account.id,batchId:row.id}});
 await audit(tx,ctx,{entityId,action:'bank_statement.commit',resourceType:'bank_statement_batch',resourceId:row.id,resourceVersion:1,afterRef:batch.checksum,reason:v.duplicates?v.duplicates+' line(s) already imported were skipped':null});
 return {batchId:row.id,jobId,lines:v.lines.length-v.duplicates,duplicates:v.duplicates};
}
const lineView=l=>({id:l.id,bankAccountId:l.bank_account_id,batchId:l.batch_id,sourceLineKey:l.source_line_key,bookedDate:iso(l.booked_date),valueDate:iso(l.value_date),signedAmount:decimal(micros(String(l.signed_amount).replace(/^-/,''))*(String(l.signed_amount).startsWith('-')?-1n:1n)),currency:l.currency,reference:l.reference,description:l.description,matchState:l.match_state,matchedAmount:money(l.matched)});
export async function listStatementLines(tx,ctx,entityId,{bankAccountId,matchState=null,batchId=null}={}){
 requirePermission(ctx,'bank_match.read');requireEntity(ctx,entityId);await bankAccountFor(tx,ctx,entityId,bankAccountId,{approved:false});
 const params=[ctx.tenantId,entityId,bankAccountId];let where='';
 if(matchState)where+=' and match_state=$'+params.push(matchState);
 if(batchId)where+=' and batch_id=$'+params.push(batchId);
 return (await tx.query('select *,lara.line_matched(tenant_id,id)::text as matched from lara.bank_statement_lines where tenant_id=$1 and entity_id=$2 and bank_account_id=$3'+where+' order by booked_date,source_line_key,id',params)).rows.map(lineView);
}
export async function listStatementBatches(tx,ctx,entityId,bankAccountId){
 requirePermission(ctx,'bank_match.read');requireEntity(ctx,entityId);
 return (await tx.query('select * from lara.bank_statement_batches where tenant_id=$1 and entity_id=$2 and bank_account_id=$3 order by from_date,created_at',[ctx.tenantId,entityId,bankAccountId])).rows.map(b=>({id:b.id,importId:b.import_id,fromDate:iso(b.from_date),toDate:iso(b.to_date),openingBalance:decimal(signedMicros(b.opening_balance)),closingBalance:decimal(signedMicros(b.closing_balance)),lineCount:b.line_count,duplicateCount:b.duplicate_count,state:b.state,createdAt:iso(b.created_at)}));
}
const signedMicros=v=>{const s=String(v);return s.startsWith('-')?-micros(s.slice(1)):micros(s);};

// ---------------------------------------------------------------------------
// Reconciliation matches
// ---------------------------------------------------------------------------
const matchResource=m=>resource({...m,status:m.state},{statementLineIds:m.statement_line_ids,allocations:m.allocations,...(m.reason?{reason:m.reason}:{})});
const matchMaterial=i=>({statementLineIds:[...i.statementLineIds].sort(),allocations:i.allocations.map(a=>({resourceType:a.resourceType,resourceId:a.resourceId,amount:money(a.amount)})),reason:i.reason?.trim()||null});
// Lines belong to one approved account; allocations name posted settlements
// of the right direction or journal entries touching the bank's ledger
// account; totals conserve: allocations equal the lines' signed total.
async function validateMatch(tx,ctx,entityId,m){
 const lines=[];
 for(const id of m.statementLineIds){
  if(!isUuid(id))fail('VALIDATION_FAILED','statementLineIds must be UUIDs.',{fieldErrors:[{path:'statementLineIds',message:'UUID'}]});
  const l=(await tx.query('select *,lara.line_matched(tenant_id,id)::text as matched from lara.bank_statement_lines where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,id])).rows[0];
  if(!l)fail('NOT_FOUND','Statement line '+id+' not found.');
  lines.push(l);
 }
 const bankAccountId=lines[0].bank_account_id;
 if(lines.some(l=>l.bank_account_id!==bankAccountId))fail('VALIDATION_FAILED','All lines of a match belong to one bank account.',{fieldErrors:[{path:'statementLineIds',message:'Mixed accounts'}]});
 const sign=signedMicros(lines[0].signed_amount)<0n?-1n:1n;
 if(lines.some(l=>(signedMicros(l.signed_amount)<0n?-1n:1n)!==sign))fail('VALIDATION_FAILED','Grouped lines share a direction.',{fieldErrors:[{path:'statementLineIds',message:'Mixed directions'}]});
 const account=await bankAccountFor(tx,ctx,entityId,bankAccountId);
 let lineTotal=0n;for(const l of lines)lineTotal+=abs(signedMicros(l.signed_amount))-micros(l.matched);
 let allocTotal=0n;
 for(const [i,a] of m.allocations.entries()){
  if(!isUuid(a.resourceId))fail('VALIDATION_FAILED','resourceId must be a UUID.',{fieldErrors:[{path:'allocations.'+i+'.resourceId',message:'UUID'}]});
  const amount=micros(a.amount);if(amount<=0n)fail('VALIDATION_FAILED','Allocations are positive.',{fieldErrors:[{path:'allocations.'+i+'.amount',message:'Positive'}]});
  if(a.resourceType==='settlement'){
   const s=(await tx.query('select * from lara.settlements where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,a.resourceId])).rows[0];
   if(!s)fail('NOT_FOUND','Settlement '+a.resourceId+' not found.');
   if(s.state!=='posted')fail('STATE_CONFLICT','Only posted settlements reconcile; settlement '+a.resourceId+' is '+s.state+'.');
   if((s.direction==='receipt')!==(sign>0n))fail('VALIDATION_FAILED','Allocation '+(i+1)+': receipts match bank credits and payments match bank debits.',{fieldErrors:[{path:'allocations.'+i,message:'Direction'}]});
   if(s.bank_account_id&&s.bank_account_id!==bankAccountId)fail('VALIDATION_FAILED','Allocation '+(i+1)+' settled through another bank account.',{fieldErrors:[{path:'allocations.'+i,message:'Other account'}]});
   const used=micros((await tx.query("select lara.resource_matched($1,'settlement',$2)::text as used",[ctx.tenantId,s.id])).rows[0].used);
   if(used+amount>micros(String(s.cash_amount)))fail('ALLOCATION_EXCEEDS_BALANCE','Allocation '+(i+1)+' exceeds the settlement cash '+money(s.cash_amount)+' less '+decimal(used)+' already matched.');
  }else{
   const cap=(await tx.query('select coalesce(sum(abs(l.txn_debit-l.txn_credit)),0)::text as capacity,coalesce(sum(l.txn_debit-l.txn_credit),0)::text as movement from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.entity_id=$2 and l.entry_id=$3 and l.account_id=$4',[ctx.tenantId,entityId,a.resourceId,account.ledger_account_id])).rows[0];
   if(!cap||micros(cap.capacity)===0n)fail('VALIDATION_FAILED','Allocation '+(i+1)+': the journal entry has no posted line on this bank account.',{fieldErrors:[{path:'allocations.'+i,message:'No bank line'}]});
   if((signedMicros(cap.movement)>0n)!==(sign>0n))fail('VALIDATION_FAILED','Allocation '+(i+1)+': the journal moves the bank the other way.',{fieldErrors:[{path:'allocations.'+i,message:'Direction'}]});
   const used=micros((await tx.query("select lara.resource_matched($1,'journal',$2)::text as used",[ctx.tenantId,a.resourceId])).rows[0].used);
   if(used+amount>micros(cap.capacity))fail('ALLOCATION_EXCEEDS_BALANCE','Allocation '+(i+1)+' exceeds the entry movement '+cap.capacity+' less '+decimal(used)+' already matched.');
  }
  allocTotal+=amount;
 }
 if(lineTotal<=0n)fail('ALLOCATION_EXCEEDS_BALANCE','The statement line(s) are already fully matched.');
 if(allocTotal!==lineTotal)fail('VALIDATION_FAILED','Matches conserve amounts: allocations '+decimal(allocTotal)+' must equal the unmatched statement total '+decimal(lineTotal)+'. Fees and differences need their own approved journal.',{fieldErrors:[{path:'allocations',message:'Difference '+decimal(allocTotal-lineTotal)}]});
 return {lines,bankAccountId};
}
export async function createMatch(tx,ctx,entityId,input,{origin='manual'}={}){
 if(origin==='manual')requirePermission(ctx,'bank_match.create');requireEntity(ctx,entityId);assertInput('BankMatch',input);await requireTreasury(tx,ctx,entityId);
 const m=matchMaterial(input);const {bankAccountId}=await validateMatch(tx,ctx,entityId,m);
 const hash=contentHash(m);
 const row=(await tx.query('insert into lara.reconciliation_matches(tenant_id,entity_id,bank_account_id,statement_line_ids,allocations,reason,origin,state,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[ctx.tenantId,entityId,bankAccountId,JSON.stringify(m.statementLineIds),JSON.stringify(m.allocations),m.reason,origin,origin==='proposed'?'proposed':'draft',hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'bank_match.'+(origin==='proposed'?'propose':'create'),resourceType:'bank_match',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return matchResource(row);
}
async function loadMatch(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Match not found.');const row=(await tx.query('select * from lara.reconciliation_matches where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Match not found.');return row;}
export async function updateMatch(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'bank_match.edit');requireEntity(ctx,entityId);assertInput('BankMatch',input);
 const row=await loadMatch(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(!['draft','proposed'].includes(row.state))fail('STATE_CONFLICT','Confirmed matches are immutable; reverse them.');
 const m=matchMaterial(input);const {bankAccountId}=await validateMatch(tx,ctx,entityId,m);
 if(bankAccountId!==row.bank_account_id)fail('VALIDATION_FAILED','A match keeps its bank account.',{fieldErrors:[{path:'statementLineIds',message:'Other account'}]});
 const hash=contentHash(m),material=hash!==row.content_hash;
 const updated=(await tx.query("update lara.reconciliation_matches set state='draft',origin='manual',statement_line_ids=$3,allocations=$4,reason=$5,content_hash=$6,content_version=content_version+$7,created_by=case when $8 then $9 else created_by end where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,JSON.stringify(m.statementLineIds),JSON.stringify(m.allocations),m.reason,hash,material?1:0,material,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'bank_match.edit',resourceType:'bank_match',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return matchResource(updated);
}
const mresult=(row,extra={})=>({resourceType:'bank_match',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
// Confirmation writes the guarded allocation rows: allocations are spread
// across the lines in order so each row names one line and one counterpart.
export async function confirmMatch(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'bank_match.confirm');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadMatch(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','proposed'].includes(row.state))fail('STATE_CONFLICT','Match is '+row.state+'.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The match changed since review.',{resourceVersion:Number(row.version)});
 if(row.origin==='manual'&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer of a match cannot confirm it.');
 if(input.decision==='reject'){
  if(!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
  const rejected=(await tx.query("update lara.reconciliation_matches set state='rejected' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0];
  await audit(tx,ctx,{entityId,action:'bank_match.reject',resourceType:'bank_match',resourceId:id,resourceVersion:Number(rejected.version),reason:input.reason});
  return mresult(rejected);
 }
 const m={statementLineIds:row.statement_line_ids,allocations:row.allocations,reason:row.reason};
 const {lines}=await validateMatch(tx,ctx,entityId,m);
 const remaining=lines.map(l=>({id:l.id,left:abs(signedMicros(l.signed_amount))-micros(l.matched)}));
 const ids=[];
 for(const a of m.allocations){
  let left=micros(a.amount);
  for(const r of remaining){if(left<=0n)break;if(r.left<=0n)continue;const take=r.left<left?r.left:left;ids.push((await tx.query("insert into lara.reconciliation_allocations(tenant_id,entity_id,match_id,line_id,resource_type,resource_id,amount,action,created_by) values($1,$2,$3,$4,$5,$6,$7,'apply',$8) returning id",[ctx.tenantId,entityId,id,r.id,a.resourceType,a.resourceId,decimal(take,6),ctx.principalId])).rows[0].id);r.left-=take;left-=take;}
 }
 const updated=(await tx.query("update lara.reconciliation_matches set state='confirmed',confirmed_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'bank_match.confirm',resourceType:'bank_match',resourceId:id,resourceVersion:Number(updated.version),afterRef:row.content_hash,reason:input.reason||null});
 return mresult(updated,{allocationIds:ids});
}
export async function reverseMatch(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'bank_match.reverse');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadMatch(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='confirmed')fail('STATE_CONFLICT','Only confirmed matches are reversed.');
 const applies=(await tx.query("select a.* from lara.reconciliation_allocations a where a.tenant_id=$1 and a.match_id=$2 and a.action='apply' and not exists (select 1 from lara.reconciliation_allocations r where r.tenant_id=a.tenant_id and r.reverses_id=a.id)",[ctx.tenantId,id])).rows;
 for(const a of applies)await tx.query("insert into lara.reconciliation_allocations(tenant_id,entity_id,match_id,line_id,resource_type,resource_id,amount,action,reverses_id,created_by) values($1,$2,$3,$4,$5,$6,$7,'reverse',$8,$9)",[ctx.tenantId,entityId,id,a.line_id,a.resource_type,a.resource_id,a.amount,a.id,ctx.principalId]);
 const updated=(await tx.query("update lara.reconciliation_matches set state='reversed',reversal_reason=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.reason])).rows[0];
 await audit(tx,ctx,{entityId,action:'bank_match.reverse',resourceType:'bank_match',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return mresult(updated);
}
export async function getMatch(tx,ctx,entityId,id){requirePermission(ctx,'bank_match.read');requireEntity(ctx,entityId);return matchResource(await loadMatch(tx,ctx,entityId,id,{lock:false}));}
export async function listMatches(tx,ctx,entityId,query){
 requirePermission(ctx,'bank_match.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';
 if(query?.bankAccountId){if(!isUuid(query.bankAccountId))fail('VALIDATION_FAILED','bankAccountId must be a UUID.',{fieldErrors:[{path:'bankAccountId',message:'UUID'}]});where+=' and bank_account_id=$'+params.push(query.bankAccountId);}
 if(query?.state)where+=' and state=$'+params.push(String(query.state));
 const rows=(await tx.query('select * from lara.reconciliation_matches where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,matchResource,scope);
}
// Deterministic proposals for unmatched lines: a single posted settlement of
// the right direction with the same amount and the line's reference is
// proposed; failing that, a single settlement with the same amount whose
// value date is within the window. Several candidates leave the line alone.
export async function proposeMatches(tx,ctx,entityId,{bankAccountId,batchId=null}){
 requireEntity(ctx,entityId);await requireTreasury(tx,ctx,entityId);
 const profile=await treasuryProfile(tx,ctx,entityId,{required:false});
 const account=await bankAccountFor(tx,ctx,entityId,bankAccountId);
 const params=[ctx.tenantId,entityId,bankAccountId];
 const lines=(await tx.query("select *,lara.line_matched(tenant_id,id)::text as matched from lara.bank_statement_lines where tenant_id=$1 and entity_id=$2 and bank_account_id=$3 and match_state='unmatched'"+(batchId?' and batch_id=$'+params.push(batchId):'')+" and not exists (select 1 from lara.reconciliation_matches m where m.tenant_id=bank_statement_lines.tenant_id and m.state in ('draft','proposed') and m.statement_line_ids ? bank_statement_lines.id::text) order by booked_date,id",params)).rows;
 const proposed=[],ambiguous=[];
 for(const l of lines){
  const amount=signedMicros(l.signed_amount);const direction=amount>0n?'receipt':'payment';
  const candidates=(await tx.query("select s.* from lara.settlements s where s.tenant_id=$1 and s.entity_id=$2 and s.state='posted' and s.direction=$3 and s.currency=$4 and s.cash_amount=$5 and (s.bank_account_id is null or s.bank_account_id=$6) and lara.resource_matched(s.tenant_id,'settlement',s.id)=0 and not exists (select 1 from lara.reconciliation_matches m where m.tenant_id=s.tenant_id and m.state in ('draft','proposed') and m.allocations @> jsonb_build_array(jsonb_build_object('resourceType','settlement','resourceId',s.id::text))) order by s.value_date,s.id",[ctx.tenantId,entityId,direction,l.currency,decimal(abs(amount),6),account.id])).rows;
  const ref=(l.reference||'').trim().toLowerCase();
  let pick=null,reason=null;
  const byRef=ref?candidates.filter(s=>(s.bank_reference||'').trim().toLowerCase()===ref||ref.includes(s.id.slice(0,8))):[];
  if(byRef.length===1){pick=byRef[0];reason='Exact reference and amount';}
  else if(byRef.length>1){ambiguous.push(l.id);continue;}
  else{
   const near=candidates.filter(s=>Math.abs(Date.parse(iso(s.value_date))-Date.parse(iso(l.value_date||l.booked_date)))<=profile.matchWindowDays*86400000);
   if(near.length===1){pick=near[0];reason='Same amount within '+profile.matchWindowDays+' days';}
   else if(near.length>1){ambiguous.push(l.id);continue;}
  }
  if(!pick)continue;
  const m=await createMatch(tx,ctx,entityId,{statementLineIds:[l.id],allocations:[{resourceType:'settlement',resourceId:pick.id,amount:decimal(abs(amount))}],reason},{origin:'proposed'});
  proposed.push(m.id);
 }
 if(ambiguous.length)await audit(tx,ctx,{entityId,action:'bank_match.ambiguous',resourceType:'bank_account',resourceId:bankAccountId,resourceVersion:Number(account.version),reason:ambiguous.length+' line(s) have several candidates and stay unmatched: '+ambiguous.join(', ').slice(0,1500)});
 return {proposed,ambiguous};
}
// Reconciliation snapshot: statement closing balance against the ledger
// balance of the bank account at the cutoff, with the unmatched lines and the
// posted movements not yet matched explaining the difference.
export async function reconciliationReport(tx,ctx,entityId,{bankAccountId,asOf}){
 requirePermission(ctx,'bank_match.read');requireEntity(ctx,entityId);
 const account=await bankAccountFor(tx,ctx,entityId,bankAccountId,{approved:false});
 const batch=(await tx.query('select * from lara.bank_statement_batches where tenant_id=$1 and bank_account_id=$2 and to_date<=$3::date order by to_date desc,created_at desc limit 1',[ctx.tenantId,bankAccountId,asOf])).rows[0];
 const ledger=(await tx.query("select coalesce(sum(l.txn_debit-l.txn_credit),0)::text as balance from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.entity_id=$2 and l.account_id=$3 and e.accounting_date<=$4::date",[ctx.tenantId,entityId,account.ledger_account_id,asOf])).rows[0];
 const unmatchedLines=(await tx.query("select *,lara.line_matched(tenant_id,id)::text as matched from lara.bank_statement_lines where tenant_id=$1 and bank_account_id=$2 and booked_date<=$3::date and match_state<>'matched' order by booked_date,source_line_key,id",[ctx.tenantId,bankAccountId,asOf])).rows.map(lineView);
 const unmatchedSettlements=(await tx.query("select s.id,s.direction,s.value_date,s.cash_amount::text as cash,s.bank_reference,lara.resource_matched(s.tenant_id,'settlement',s.id)::text as matched from lara.settlements s where s.tenant_id=$1 and s.entity_id=$2 and s.state='posted' and s.value_date<=$3::date and (s.bank_account_id=$4 or (s.bank_account_id is null and s.payment_method='transfer')) and lara.resource_matched(s.tenant_id,'settlement',s.id)<s.cash_amount order by s.value_date,s.id",[ctx.tenantId,entityId,asOf,bankAccountId])).rows.map(s=>({settlementId:s.id,direction:s.direction,valueDate:iso(s.value_date),cashAmount:money(s.cash),matchedAmount:money(s.matched),bankReference:s.bank_reference}));
 const statementBalance=batch?decimal(signedMicros(batch.closing_balance)):null;
 const ledgerBalance=decimal(signedMicros(ledger.balance));
 return {bankAccountId,asOf,statementBatchId:batch?.id||null,statementBalance,ledgerBalance,difference:statementBalance===null?null:decimal(signedMicros(batch.closing_balance)-signedMicros(ledger.balance)),unmatchedLines,unmatchedSettlements};
}

// ---------------------------------------------------------------------------
// Transfers between bank accounts
// ---------------------------------------------------------------------------
const transferResource=t=>resource({...t,status:t.state},{fromAccountId:t.from_account_id,toAccountId:t.to_account_id,currency:t.currency,amount:money(t.amount),valueDate:iso(t.value_date),evidenceIds:t.evidence_ids});
const transferMaterial=i=>({fromAccountId:i.fromAccountId,toAccountId:i.toAccountId,currency:i.currency,amount:money(i.amount),valueDate:i.valueDate,evidenceIds:[...i.evidenceIds].sort()});
async function validateTransfer(tx,ctx,entityId,m){
 if(m.fromAccountId===m.toAccountId)fail('VALIDATION_FAILED','A transfer moves money between two different bank accounts.',{fieldErrors:[{path:'toAccountId',message:'Same as source'}]});
 const from=await bankAccountFor(tx,ctx,entityId,m.fromAccountId),to=await bankAccountFor(tx,ctx,entityId,m.toAccountId);
 if(from.book_id!==to.book_id)fail('FEATURE_NOT_ENABLED','Transfers across books arrive with P09.');
 if(from.currency!==m.currency||to.currency!==m.currency)fail('FEATURE_NOT_ENABLED','Cross-currency transfers arrive with P09.');
 if(micros(m.amount)<=0n)fail('VALIDATION_FAILED','Transfers are positive.',{fieldErrors:[{path:'amount',message:'Positive'}]});
 return {from,to};
}
export async function createTransfer(tx,ctx,entityId,input){
 requirePermission(ctx,'transfer.create');requireEntity(ctx,entityId);assertInput('TransferCreate',input);await requireTreasury(tx,ctx,entityId);
 const m=transferMaterial(input);const {from}=await validateTransfer(tx,ctx,entityId,m);
 const hash=contentHash(m);
 const row=(await tx.query('insert into lara.transfers(tenant_id,entity_id,book_id,from_account_id,to_account_id,currency,amount,value_date,evidence_ids,payload_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[ctx.tenantId,entityId,from.book_id,m.fromAccountId,m.toAccountId,m.currency,m.amount,m.valueDate,JSON.stringify(m.evidenceIds),hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'transfer.create',resourceType:'transfer',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return transferResource(row);
}
async function loadTransfer(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Transfer not found.');const row=(await tx.query('select * from lara.transfers where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Transfer not found.');return row;}
export async function updateTransfer(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'transfer.edit');requireEntity(ctx,entityId);assertInput('TransferCreate',input);
 const row=await loadTransfer(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(['posted','cancelled'].includes(row.state))fail('STATE_CONFLICT','Posted transfers are immutable.');
 const m=transferMaterial(input);await validateTransfer(tx,ctx,entityId,m);
 const hash=contentHash(m),material=hash!==row.payload_hash;
 if(material&&row.state!=='draft')await tx.query("update lara.transfers set state='draft',approved_by=null,submitted_by=null where tenant_id=$1 and id=$2",[ctx.tenantId,id]);
 const updated=(await tx.query('update lara.transfers set from_account_id=$3,to_account_id=$4,currency=$5,amount=$6,value_date=$7,evidence_ids=$8,payload_hash=$9,content_version=content_version+$10 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,m.fromAccountId,m.toAccountId,m.currency,m.amount,m.valueDate,JSON.stringify(m.evidenceIds),hash,material?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:'transfer.edit',resourceType:'transfer',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return transferResource(updated);
}
const tresult=(row,extra={})=>({resourceType:'transfer',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
export async function submitTransfer(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'transfer.submit');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadTransfer(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='draft')fail('STATE_CONFLICT','Transfer is '+row.state+'.');
 if(row.evidence_ids.length)await linkEvidence(tx,ctx,entityId,row.evidence_ids,'transfer',id,Number(row.version)+1);
 const updated=(await tx.query("update lara.transfers set state='submitted',submitted_by=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'transfer.submit',resourceType:'transfer',resourceId:id,resourceVersion:Number(updated.version)});
 return tresult(updated);
}
export async function approveTransfer(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'transfer.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadTransfer(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='submitted')fail('STATE_CONFLICT','Only submitted transfers are decided.');
 if(row.created_by===ctx.principalId||row.submitted_by===ctx.principalId)fail('SELF_APPROVAL','The preparer or submitter cannot approve this transfer.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The transfer changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const state=input.decision==='approve'?'approved':'draft';
 const updated=(await tx.query('update lara.transfers set state=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,state,input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'transfer.'+input.decision,resourceType:'transfer',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.payload_hash});
 return tresult(updated);
}
// Both sides post in one entry: Dr destination bank / Cr source bank.
export async function postTransfer(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'transfer.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadTransfer(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return tresult(row,{journalEntryIds:[row.posted_entry_id]});
 if(row.state!=='approved')fail('STATE_CONFLICT','Approval is required before posting.');
 const from=await bankAccountFor(tx,ctx,entityId,row.from_account_id),to=await bankAccountFor(tx,ctx,entityId,row.to_account_id);
 const branch=(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and status='active' order by created_at limit 1",[ctx.tenantId,entityId])).rows[0];
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'transfer',sourceId:id,sourceVersion:Number(row.content_version),purpose:'posting',accountingDate:iso(row.value_date),documentDate:iso(row.value_date),description:'Transfer '+from.bank_code+' ••••'+from.number_last4+' → '+to.bank_code+' ••••'+to.number_last4,currency:row.currency,manual:false,postingActor:ctx.principalId,commandId,lines:[{accountId:to.ledger_account_id,branchId:branch.id,dimensions:{},debit:money(row.amount),credit:'0'},{accountId:from.ledger_account_id,branchId:branch.id,dimensions:{},debit:'0',credit:money(row.amount)}]})])).rows[0].id;
 const updated=(await tx.query("update lara.transfers set state='posted',posted_entry_id=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId])).rows[0];
 await audit(tx,ctx,{entityId,action:'transfer.post',resourceType:'transfer',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'transfer',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'transfer.posted.v1',payload:{transferId:id,journalEntryId:entryId}});
 return tresult(updated,{journalEntryIds:[entryId]});
}
export async function getTransfer(tx,ctx,entityId,id){requirePermission(ctx,'transfer.read');requireEntity(ctx,entityId);return transferResource(await loadTransfer(tx,ctx,entityId,id,{lock:false}));}
export async function listTransfers(tx,ctx,entityId,query){
 requirePermission(ctx,'transfer.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';if(query?.state)where+=' and state=$'+params.push(String(query.state));
 const rows=(await tx.query('select * from lara.transfers where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,transferResource,scope);
}

// ---------------------------------------------------------------------------
// Check instruments
// ---------------------------------------------------------------------------
const checkResource=c=>resource({...c,status:c.state},{direction:c.direction,bankAccountId:c.bank_account_id,number:c.check_number,amount:money(c.amount),currency:c.currency,dueDate:iso(c.due_date),partyId:c.party_id,...(c.settlement_id?{settlementId:c.settlement_id}:{})});
const checkMaterial=i=>({direction:i.direction,bankAccountId:i.bankAccountId,number:i.number.trim(),amount:money(i.amount),currency:i.currency,dueDate:i.dueDate,partyId:i.partyId,settlementId:i.settlementId||null});
async function validateCheck(tx,ctx,entityId,m){
 const account=await bankAccountFor(tx,ctx,entityId,m.bankAccountId);
 if(account.currency!==m.currency)fail('FEATURE_NOT_ENABLED','Foreign-currency checks arrive with P09.');
 if(micros(m.amount)<=0n)fail('VALIDATION_FAILED','Check amounts are positive.',{fieldErrors:[{path:'amount',message:'Positive'}]});
 if(!isUuid(m.partyId))fail('VALIDATION_FAILED','partyId must be a UUID.',{fieldErrors:[{path:'partyId',message:'UUID'}]});
 const party=(await tx.query("select 1 from lara.party where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,m.partyId])).rowCount;
 if(!party)fail('NOT_FOUND','Party not found.');
 if(m.settlementId){
  if(!isUuid(m.settlementId))fail('VALIDATION_FAILED','settlementId must be a UUID.',{fieldErrors:[{path:'settlementId',message:'UUID'}]});
  const s=(await tx.query('select * from lara.settlements where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,m.settlementId])).rows[0];
  if(!s)fail('NOT_FOUND','Settlement not found.');
  if(s.party_id!==m.partyId)fail('VALIDATION_FAILED','The settlement belongs to another party.',{fieldErrors:[{path:'settlementId',message:'Party mismatch'}]});
  if((s.direction==='receipt')!==(m.direction==='received'))fail('VALIDATION_FAILED','Received checks settle receipts; issued checks settle payments.',{fieldErrors:[{path:'settlementId',message:'Direction'}]});
  if(s.payment_method!=='check')fail('VALIDATION_FAILED','The settlement method must be check.',{fieldErrors:[{path:'settlementId',message:'Method'}]});
  if(money(s.cash_amount)!==m.amount)fail('VALIDATION_FAILED','The check amount must equal the settlement cash '+money(s.cash_amount)+'.',{fieldErrors:[{path:'amount',message:'Differs from settlement'}]});
  if(['posted','reversed'].includes(s.state)&&m.direction==='received')fail('STATE_CONFLICT','The receipt is already posted; a check in custody links to a receipt not yet posted.');
 }
}
export async function createCheck(tx,ctx,entityId,input,{replacesId=null}={}){
 requirePermission(ctx,'check.create');requireEntity(ctx,entityId);assertInput('CheckCreate',input);await requireTreasury(tx,ctx,entityId);
 const m=checkMaterial(input);await validateCheck(tx,ctx,entityId,m);
 if(replacesId){const prior=(await tx.query("select * from lara.check_instruments where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,replacesId])).rows[0];if(!prior||prior.state!=='dishonored')fail('STATE_CONFLICT','A replacement links to a dishonored check.');}
 const hash=contentHash(m);
 const row=(await tx.query('insert into lara.check_instruments(tenant_id,entity_id,direction,bank_account_id,check_number,party_id,amount,currency,due_date,settlement_id,replaces_id,state,payload_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *',[ctx.tenantId,entityId,m.direction,m.bankAccountId,m.number,m.partyId,m.amount,m.currency,m.dueDate,m.settlementId,replacesId,m.direction==='received'?'custody':'drafted',hash,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'check.create',resourceType:'check',resourceId:row.id,resourceVersion:1,afterRef:hash});
 return checkResource(row);
}
async function loadCheck(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Check not found.');const row=(await tx.query('select * from lara.check_instruments where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Check not found.');return row;}
export async function updateCheck(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'check.edit');requireEntity(ctx,entityId);assertInput('CheckCreate',input);
 const row=await loadCheck(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(!['custody','drafted'].includes(row.state))fail('STATE_CONFLICT','A check in circulation keeps its number, party and amount.');
 const m=checkMaterial(input);if(m.direction!==row.direction)fail('VALIDATION_FAILED','A check keeps its direction.',{fieldErrors:[{path:'direction',message:'Immutable'}]});
 await validateCheck(tx,ctx,entityId,m);
 const hash=contentHash(m),material=hash!==row.payload_hash;
 const updated=(await tx.query('update lara.check_instruments set bank_account_id=$3,check_number=$4,party_id=$5,amount=$6,currency=$7,due_date=$8,settlement_id=$9,payload_hash=$10,content_version=content_version+$11 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,m.bankAccountId,m.number,m.partyId,m.amount,m.currency,m.dueDate,m.settlementId,hash,material?1:0])).rows[0];
 await audit(tx,ctx,{entityId,action:'check.edit',resourceType:'check',resourceId:id,resourceVersion:Number(updated.version),afterRef:hash});
 return checkResource(updated);
}
const cresult=(row,extra={})=>({resourceType:'check',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
async function moveCheck(tx,ctx,entityId,id,input,expectedVersion,{permission,from,to,action}){
 requirePermission(ctx,permission);requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadCheck(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!from.includes(row.state))fail('STATE_CONFLICT','Check is '+row.state+'; '+action+' applies to '+from.join(' or ')+' checks.');
 if(input.evidenceIds?.length)await linkEvidence(tx,ctx,entityId,input.evidenceIds,'check',id,Number(row.version)+1);
 const updated=(await tx.query('update lara.check_instruments set state=$3,state_reason=$4,cleared_at=case when $3=\'cleared\' then now() else cleared_at end where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,to,input.reason])).rows[0];
 await audit(tx,ctx,{entityId,action:'check.'+action,resourceType:'check',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason});
 return updated;
}
// Issued checks leave custody to the payee; received checks go to the bank.
export async function releaseCheck(tx,ctx,entityId,id,input,expectedVersion){const row=await loadCheck(tx,ctx,entityId,id,{lock:false});if(row.direction!=='issued')fail('STATE_CONFLICT','Received checks are deposited, not released.');return cresult(await moveCheck(tx,ctx,entityId,id,input,expectedVersion,{permission:'check.release',from:['drafted'],to:'released',action:'release'}));}
export async function depositCheck(tx,ctx,entityId,id,input,expectedVersion){const row=await loadCheck(tx,ctx,entityId,id,{lock:false});if(row.direction!=='received')fail('STATE_CONFLICT','Issued checks are released, not deposited.');return cresult(await moveCheck(tx,ctx,entityId,id,input,expectedVersion,{permission:'check.deposit',from:['custody'],to:'deposited',action:'deposit'}));}
// Clearing is the recognition event for a received check: the linked receipt
// may post only now. Nothing posts here; the receipt posts through sales.
export async function clearCheck(tx,ctx,entityId,id,input,expectedVersion){return cresult(await moveCheck(tx,ctx,entityId,id,input,expectedVersion,{permission:'check.clear',from:['deposited','released'],to:'cleared',action:'clear'}));}
// Dishonor after clearing reverses only the linked settlement's recorded
// effect (mirrored entry, its own allocations unwound); other settlements and
// allocations are untouched. A replacement check links back through replaces.
export async function dishonorCheck(tx,ctx,entityId,id,input,expectedVersion,{reverseSettlement,commandId=null}={}){
 requirePermission(ctx,'check.dishonor');requireEntity(ctx,entityId);assertInput('Reversal',input);
 const row=await loadCheck(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['deposited','released','cleared'].includes(row.state))fail('STATE_CONFLICT','Check is '+row.state+'; only deposited, released or cleared checks dishonor.');
 if(input.evidenceIds?.length)await linkEvidence(tx,ctx,entityId,input.evidenceIds,'check',id,Number(row.version)+1);
 let journalEntryIds=[];
 if(row.settlement_id){
  const s=(await tx.query('select * from lara.settlements where tenant_id=$1 and id=$2 for update',[ctx.tenantId,row.settlement_id])).rows[0];
  if(s.state==='posted'){if(!reverseSettlement)fail('STATE_CONFLICT','The linked settlement is posted; dishonor needs the settlement reversal path.');const r=await reverseSettlement(tx,ctx,entityId,s,{accountingDate:input.accountingDate,reason:'Check '+row.check_number+' dishonored: '+input.reason},{commandId});journalEntryIds=r.journalEntryIds;}
 }
 const updated=(await tx.query("update lara.check_instruments set state='dishonored',state_reason=$3,dishonor_entry_id=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.reason,journalEntryIds[0]||null])).rows[0];
 await audit(tx,ctx,{entityId,action:'check.dishonor',resourceType:'check',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason,afterRef:journalEntryIds[0]||null});
 return cresult(updated,{journalEntryIds});
}
export async function getCheck(tx,ctx,entityId,id){requirePermission(ctx,'check.read');requireEntity(ctx,entityId);return checkResource(await loadCheck(tx,ctx,entityId,id,{lock:false}));}
export async function listChecks(tx,ctx,entityId,query){
 requirePermission(ctx,'check.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';
 if(query?.state)where+=' and state=$'+params.push(String(query.state));
 if(query?.direction)where+=' and direction=$'+params.push(String(query.direction));
 if(query?.bankAccountId){if(!isUuid(query.bankAccountId))fail('VALIDATION_FAILED','bankAccountId must be a UUID.',{fieldErrors:[{path:'bankAccountId',message:'UUID'}]});where+=' and bank_account_id=$'+params.push(query.bankAccountId);}
 const rows=(await tx.query('select * from lara.check_instruments where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,checkResource,scope);
}
// A receipt linked to a received check posts only after the check cleared.
export async function checkGate(tx,ctx,settlementId){
 const c=(await tx.query("select check_number,state from lara.check_instruments where tenant_id=$1 and settlement_id=$2 and direction='received' order by created_at desc limit 1",[ctx.tenantId,settlementId])).rows[0];
 if(c&&c.state!=='cleared')fail('STATE_CONFLICT','Check '+c.check_number+' is '+c.state+'; the receipt posts when the check clears (no available-cash inflation).');
}

// ---------------------------------------------------------------------------
// Cash sessions
// ---------------------------------------------------------------------------
const sessionResource=s=>resource({...s,status:s.state},{branchId:s.branch_id,cashierId:s.cashier_id,businessDate:iso(s.business_date),openingAmount:money(s.opening_amount)});
export const sessionSummary=s=>({...sessionResource(s),expectedAmount:s.expected_amount==null?null:money(s.expected_amount),countedAmount:s.counted_amount==null?null:money(s.counted_amount),variance:s.variance==null?null:decimal(signedMicros(s.variance)),varianceReason:s.variance_reason,varianceEntryId:s.variance_entry_id,closedAt:iso(s.closed_at)});
export async function createCashSession(tx,ctx,entityId,input){
 requirePermission(ctx,'cash_session.create');requireEntity(ctx,entityId);assertInput('CashSessionCreate',input);await requireTreasury(tx,ctx,entityId);
 const branch=(await tx.query("select 1 from lara.branches where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,input.branchId])).rowCount;
 if(!branch)fail('NOT_FOUND','Branch not found.');
 const cashier=(await tx.query("select 1 from lara.principals where tenant_id=$1 and id=$2 and status='active'",[ctx.tenantId,input.cashierId])).rowCount;
 if(!cashier)fail('NOT_FOUND','Cashier principal not found.');
 const open=(await tx.query("select id from lara.cash_sessions where tenant_id=$1 and entity_id=$2 and branch_id=$3 and cashier_id=$4 and business_date=$5 and state<>'handed_over'",[ctx.tenantId,entityId,input.branchId,input.cashierId,input.businessDate])).rows[0];
 if(open)fail('STATE_CONFLICT','Session '+open.id+' is still open for this cashier and date.');
 const row=(await tx.query('insert into lara.cash_sessions(tenant_id,entity_id,branch_id,cashier_id,business_date,opening_amount,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',[ctx.tenantId,entityId,input.branchId,input.cashierId,input.businessDate,money(input.openingAmount),ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'cash_session.create',resourceType:'cash_session',resourceId:row.id,resourceVersion:1});
 return sessionResource(row);
}
async function loadSession(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Cash session not found.');const row=(await tx.query('select * from lara.cash_sessions where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Cash session not found.');return row;}
export async function updateCashSession(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'cash_session.edit');requireEntity(ctx,entityId);assertInput('CashSessionCreate',input);
 const row=await loadSession(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(row.state!=='open')fail('STATE_CONFLICT','Only open sessions change; counted values are never overwritten.');
 if(input.branchId!==row.branch_id||input.cashierId!==row.cashier_id||input.businessDate!==iso(row.business_date))fail('VALIDATION_FAILED','Branch, cashier and date are fixed for a session.',{fieldErrors:[{path:'cashierId',message:'Immutable'}]});
 const updated=(await tx.query('update lara.cash_sessions set opening_amount=$3,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,money(input.openingAmount)])).rows[0];
 await audit(tx,ctx,{entityId,action:'cash_session.edit',resourceType:'cash_session',resourceId:id,resourceVersion:Number(updated.version)});
 return sessionResource(updated);
}
const sresult=(row,extra={})=>({resourceType:'cash_session',resourceId:row.id,version:Number(row.version),state:row.state,...extra});
// Expected cash is the opening float plus posted cash receipts less posted
// cash payments of the business date; variance is counted minus expected and
// needs a reason. Counted values are recorded as they are, never adjusted.
export async function countCashSession(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'cash_session.count');requireEntity(ctx,entityId);assertInput('CashCount',input);
 const row=await loadSession(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['open','counted'].includes(row.state))fail('STATE_CONFLICT','Session is '+row.state+'; counted values are never overwritten.');
 let counted=0n;
 for(const [i,l] of input.lines.entries()){const d=micros(l.denomination);if(d<=0n)fail('VALIDATION_FAILED','Denominations are positive.',{fieldErrors:[{path:'lines.'+i+'.denomination',message:'Positive'}]});counted+=d*BigInt(l.quantity);}
 const moves=(await tx.query("select coalesce(sum(case when direction='receipt' then cash_amount else -cash_amount end),0)::text as net from lara.settlements where tenant_id=$1 and entity_id=$2 and state='posted' and payment_method='cash' and value_date=$3",[ctx.tenantId,entityId,iso(row.business_date)])).rows[0];
 const expected=micros(String(row.opening_amount))+signedMicros(moves.net);
 const variance=counted-expected;
 if(variance!==0n&&!input.reason?.trim())fail('VALIDATION_FAILED','A variance of '+decimal(variance)+' needs a reason.',{fieldErrors:[{path:'reason',message:'Required for variance'}]});
 if(input.evidenceIds.length)await linkEvidence(tx,ctx,entityId,input.evidenceIds,'cash_session',id,Number(row.version)+1);
 const countNo=((await tx.query('select coalesce(max(count_no),0)::int n from lara.cash_count_lines where tenant_id=$1 and session_id=$2',[ctx.tenantId,id])).rows[0].n)+1;
 const byDenomination=new Map();for(const l of input.lines)byDenomination.set(money(l.denomination),(byDenomination.get(money(l.denomination))||0)+l.quantity);
 for(const [denomination,quantity] of byDenomination)await tx.query('insert into lara.cash_count_lines(tenant_id,session_id,count_no,denomination,quantity) values($1,$2,$3,$4,$5)',[ctx.tenantId,id,countNo,denomination,quantity]);
 const updated=(await tx.query("update lara.cash_sessions set state='counted',expected_amount=$3,counted_amount=$4,variance=$5,variance_reason=$6 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,decimal(expected,6),decimal(counted,6),decimal(variance,6),variance===0n?null:input.reason.trim()])).rows[0];
 await audit(tx,ctx,{entityId,action:'cash_session.count',resourceType:'cash_session',resourceId:id,resourceVersion:Number(updated.version),reason:'count '+countNo+': counted '+decimal(counted)+', expected '+decimal(expected)+', variance '+decimal(variance)+(input.reason?' — '+input.reason:'')});
 return sresult(updated,{counted:decimal(counted),expected:decimal(expected),variance:decimal(variance)});
}
// Close posts the variance under the approved policy accounts (shortage:
// Dr cash variance / Cr cash; overage the other way); without a policy a
// non-zero variance cannot close.
export async function closeCashSession(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'cash_session.close');requireEntity(ctx,entityId);assertInput('ReasonAction',input);
 const row=await loadSession(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='counted')fail('STATE_CONFLICT','Count the cash before closing.');
 const variance=signedMicros(row.variance);let entryId=null;
 if(variance!==0n){
  const profile=await treasuryProfile(tx,ctx,entityId);
  if(!profile.cashAccountId||!profile.cashVarianceAccountId)fail('RULE_PROFILE_NOT_APPROVED','A cash variance posts only under the approved treasury profile (cash and variance accounts).');
  const book=(await tx.query("select id from lara.books where tenant_id=$1 and entity_id=$2 and kind='primary' and status='active'",[ctx.tenantId,entityId])).rows[0];
  const amount=decimal(abs(variance),6);
  const lines=variance<0n?[{accountId:profile.cashVarianceAccountId,branchId:row.branch_id,dimensions:{},debit:amount,credit:'0'},{accountId:profile.cashAccountId,branchId:row.branch_id,dimensions:{},debit:'0',credit:amount}]:[{accountId:profile.cashAccountId,branchId:row.branch_id,dimensions:{},debit:amount,credit:'0'},{accountId:profile.cashVarianceAccountId,branchId:row.branch_id,dimensions:{},debit:'0',credit:amount}];
  entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:book.id,sourceType:'cash_session',sourceId:id,sourceVersion:Number(row.content_version),purpose:'posting',accountingDate:iso(row.business_date),documentDate:iso(row.business_date),description:'Cash '+(variance<0n?'shortage':'overage')+' '+iso(row.business_date)+': '+(row.variance_reason||input.reason),currency:'PHP',manual:false,postingActor:ctx.principalId,commandId,lines})])).rows[0].id;
 }
 const updated=(await tx.query("update lara.cash_sessions set state='closed',closed_at=now(),variance_entry_id=$3 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId])).rows[0];
 await audit(tx,ctx,{entityId,action:'cash_session.close',resourceType:'cash_session',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason,afterRef:entryId});
 return sresult(updated,{journalEntryIds:entryId?[entryId]:[]});
}
// Handover: the incoming cashier, never the session's cashier, attests to the counted value and the variance.
export async function handoverCashSession(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'cash_session.handover');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadSession(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='closed')fail('STATE_CONFLICT','Close the session before the handover.');
 if(row.cashier_id===ctx.principalId)fail('SELF_APPROVAL','The cashier cannot certify their own handover; an independent incoming cashier attests.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The session changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 const attestations={outgoing:row.cashier_id,incoming:ctx.principalId,counted:money(row.counted_amount),expected:money(row.expected_amount),variance:decimal(signedMicros(row.variance)),varianceReason:row.variance_reason,at:new Date().toISOString()};
 await tx.query('insert into lara.cash_handovers(tenant_id,session_id,outgoing_id,incoming_id,decision,attestations,reason) values($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,id,row.cashier_id,ctx.principalId,input.decision,JSON.stringify(attestations),input.reason||null]);
 const updated=input.decision==='approve'?(await tx.query("update lara.cash_sessions set state='handed_over' where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id])).rows[0]:row;
 await audit(tx,ctx,{entityId,action:'cash_session.handover_'+input.decision,resourceType:'cash_session',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:contentHash(attestations)});
 return sresult(updated);
}
export async function getCashSession(tx,ctx,entityId,id){requirePermission(ctx,'cash_session.read');requireEntity(ctx,entityId);return sessionResource(await loadSession(tx,ctx,entityId,id,{lock:false}));}
export async function cashSessionDetail(tx,ctx,entityId,id){
 requirePermission(ctx,'cash_session.read');requireEntity(ctx,entityId);
 const row=await loadSession(tx,ctx,entityId,id,{lock:false});
 const counts=(await tx.query('select count_no,denomination::text as denomination,quantity from lara.cash_count_lines where tenant_id=$1 and session_id=$2 order by count_no,denomination desc',[ctx.tenantId,id])).rows.map(c=>({countNo:c.count_no,denomination:money(c.denomination),quantity:c.quantity}));
 const handovers=(await tx.query('select * from lara.cash_handovers where tenant_id=$1 and session_id=$2 order by created_at',[ctx.tenantId,id])).rows.map(h=>({id:h.id,outgoingId:h.outgoing_id,incomingId:h.incoming_id,decision:h.decision,attestations:h.attestations,reason:h.reason,createdAt:iso(h.created_at)}));
 return {...sessionSummary(row),counts,handovers};
}
export async function listCashSessions(tx,ctx,entityId,query){
 requirePermission(ctx,'cash_session.read');requireEntity(ctx,entityId);
 const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);const params=[ctx.tenantId,entityId,limit+1];
 let where='';if(query?.state)where+=' and state=$'+params.push(String(query.state));if(query?.branchId){if(!isUuid(query.branchId))fail('VALIDATION_FAILED','branchId must be a UUID.',{fieldErrors:[{path:'branchId',message:'UUID'}]});where+=' and branch_id=$'+params.push(query.branchId);}
 const rows=(await tx.query('select * from lara.cash_sessions where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,sessionResource,scope);
}

// ---------------------------------------------------------------------------
// Bank file runs: one locked file per release, stored as restricted evidence
// ---------------------------------------------------------------------------
export async function generateBankFile(tx,ctx,entityId,{order,settlement,beneficiary,store}){
 await requireTreasury(tx,ctx,entityId);
 if(!settlement.bank_account_id)fail('VALIDATION_FAILED','A bank-file release needs the proposal to name the paying bank account.',{fieldErrors:[{path:'channel',message:'No bank account on the settlement'}]});
 const account=await bankAccountFor(tx,ctx,entityId,settlement.bank_account_id);
 const profile=await treasuryProfile(tx,ctx,entityId,{required:false});
 const amount=money(settlement.cash_amount);
 const lines=['format,payment_id,bank_code,account_last4,account_name,amount,currency,value_date,reference',[profile.fileFormatVersion,order.id,beneficiary.bank_name.replace(/[,\n"]/g,' '),beneficiary.account_number_last4,'"'+beneficiary.account_name.replace(/"/g,'""')+'"',amount,settlement.currency,iso(order.scheduled_date),'PAY-'+order.id.slice(0,8)].join(',')];
 const content=Buffer.from(lines.join('\n')+'\n');
 const hash=sha(content);
 const key='tenants/'+ctx.tenantId+'/entities/'+entityId+'/bank-files/'+hash;
 await store.put(key,content);
 const evidence=(await tx.query("insert into lara.evidence(tenant_id,entity_id,object_key,filename,sha256,mime,byte_count,status,classification,created_by) values($1,$2,$3,$4,$5,'text/csv',$6,'available','restricted',$7) on conflict (object_key) do update set updated_at=now() returning id",[ctx.tenantId,entityId,key,'bank-file-'+order.id.slice(0,8)+'.csv',hash,content.length,ctx.principalId])).rows[0];
 const run=(await tx.query('insert into lara.bank_file_runs(tenant_id,entity_id,bank_account_id,format_version,file_hash,export_evidence_id,item_count,total_amount,created_by) values($1,$2,$3,$4,$5,$6,1,$7,$8) returning *',[ctx.tenantId,entityId,account.id,profile.fileFormatVersion,hash,evidence.id,amount,ctx.principalId])).rows[0];
 await tx.query('insert into lara.bank_file_items(tenant_id,run_id,payment_id,amount) values($1,$2,$3,$4)',[ctx.tenantId,run.id,order.id,amount]);
 await audit(tx,ctx,{entityId,action:'bank_file.generate',resourceType:'bank_file_run',resourceId:run.id,resourceVersion:1,afterRef:hash});
 return {runId:run.id,hash,evidenceId:evidence.id,reference:'file:'+hash.slice(0,16)};
}
export async function listBankFileRuns(tx,ctx,entityId,{bankAccountId=null}={}){
 requirePermission(ctx,'payment.read');requireEntity(ctx,entityId);
 const params=[ctx.tenantId,entityId];const where=bankAccountId?' and r.bank_account_id=$'+params.push(bankAccountId):'';
 const rows=(await tx.query('select r.*,(select json_agg(json_build_object(\'paymentId\',i.payment_id,\'amount\',i.amount::text,\'state\',p.state) order by i.payment_id) from lara.bank_file_items i join lara.payment_orders p on p.tenant_id=i.tenant_id and p.id=i.payment_id where i.tenant_id=r.tenant_id and i.run_id=r.id) as items from lara.bank_file_runs r where r.tenant_id=$1 and r.entity_id=$2'+where+' order by r.created_at,r.id',params)).rows;
 return rows.map(r=>({id:r.id,bankAccountId:r.bank_account_id,formatVersion:r.format_version,fileHash:r.file_hash,evidenceId:r.export_evidence_id,itemCount:r.item_count,totalAmount:money(r.total_amount),state:r.state,createdAt:iso(r.created_at),items:(r.items||[]).map(i=>({paymentId:i.paymentId,amount:money(i.amount),paymentState:i.state}))}));
}
