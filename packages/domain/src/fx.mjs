// Multiple currencies and separate books (P09): reviewed FX rates quoted as
// units of the quote currency per one unit of the base and approved by
// another principal from source evidence; a foreign-currency document posts
// both transaction and functional amounts at the approved rate of its date;
// each open item keeps an FX layer (remaining transaction amount, functional
// carrying value) that partial settlements consume proportionally with the
// final allocation absorbing rounding; realized FX is the functional cash
// equivalent minus the consumed carrying value, posted as a functional
// adjustment with explicit purpose; revaluations of classified monetary
// accounts post once per rate set and a later set adjusts through a link;
// book partitions carry their own access and combine into a management view
// without double counting. A missing rate blocks; it never defaults to 1.
import {assertInput,audit,contentHash,cursorClause,cursorScope,emit,expectVersion,fail,isUuid,iso,page,pageArgs,requirePermission,requireEntity,resource} from './core.mjs';
import {linkEvidence} from './evidence.mjs';
import {micros,decimal,signedMicros} from './ledger.mjs';

const MICRO=1000000n,PICO=1000000000000n;
const CENT=10000n;
// Half-up rounding of a signed micro amount to the currency's minor units (cents by default).
export const roundMinor=(m,units=2)=>{const unit=MICRO/(10n**BigInt(units));const neg=m<0n;const a=neg?-m:m;const r=((a+unit/2n)/unit)*unit;return neg?-r:r;};
export const rateScaled=r=>{const s=String(r);if(!/^\d{1,12}(\.\d{1,12})?$/.test(s))fail('VALIDATION_FAILED','Rates are decimal strings with up to twelve decimals.',{fieldErrors:[{path:'rate',message:'Invalid rate'}]});const [w,f='']=s.split('.');return BigInt(w)*PICO+BigInt(f.padEnd(12,'0'));};
// functional = transaction × rate, rounded half-up to the quote currency's minor units.
export const convert=(txnMicros,rate,units=2)=>{const r=typeof rate==='bigint'?rate:rateScaled(rate);const neg=txnMicros<0n;const a=neg?-txnMicros:txnMicros;const raw=(a*r+PICO/2n)/PICO;const rounded=roundMinor(raw,units);return neg?-rounded:rounded;};
const rateText=r=>{const s=r.toString().padStart(13,'0');return (s.slice(0,-12)+'.'+s.slice(-12)).replace(/\.?0+$/,'')||'0';};

// ---------------------------------------------------------------------------
// Capability, profile and currencies
// ---------------------------------------------------------------------------
export async function requireFx(tx,ctx,entityId){
 const active=(await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='multi_currency' and status='active'",[ctx.tenantId,entityId])).rowCount;
 if(!active)fail('FEATURE_NOT_ENABLED','The multi-currency capability is not active for this entity.');
}
export async function isFxActive(tx,ctx,entityId){return (await tx.query("select 1 from lara.capability_activations where tenant_id=$1 and entity_id=$2 and capability='multi_currency' and status='active'",[ctx.tenantId,entityId])).rowCount>0;}
// The approved FX profile: realized and unrealized gain and loss accounts and
// the controller's classification of monetary accounts eligible for revaluation.
export async function fxProfile(tx,ctx,entityId){
 const row=(await tx.query("select payload from lara.settings_versions where tenant_id=$1 and entity_id=$2 and kind='fx_profile' and status='approved' order by version_number desc limit 1",[ctx.tenantId,entityId])).rows[0];
 if(!row)fail('RULE_PROFILE_NOT_APPROVED','An approved FX profile (realized and unrealized FX accounts, monetary account classification) is required.');
 const p=row.payload;
 for(const k of ['realizedGainAccountId','realizedLossAccountId','unrealizedGainAccountId','unrealizedLossAccountId'])if(!isUuid(p[k]))fail('RULE_PROFILE_NOT_APPROVED','The FX profile lacks '+k+'.');
 return {realizedGainAccountId:p.realizedGainAccountId,realizedLossAccountId:p.realizedLossAccountId,unrealizedGainAccountId:p.unrealizedGainAccountId,unrealizedLossAccountId:p.unrealizedLossAccountId,monetaryAccountIds:Array.isArray(p.monetaryAccountIds)?p.monetaryAccountIds.filter(isUuid):[],profileVersion:typeof p.profileVersion==='string'?p.profileVersion:'fx-1'};
}
export async function minorUnits(tx,code){return (await tx.query('select minor_units from lara.currency_metadata where code=$1',[code])).rows[0]?.minor_units??2;}
export async function listCurrencies(tx){return (await tx.query('select code,name,minor_units from lara.currency_metadata order by code')).rows.map(r=>({code:r.code,name:r.name,minorUnits:r.minor_units}));}

// ---------------------------------------------------------------------------
// FX rates: reviewed operations
// ---------------------------------------------------------------------------
const rateResource=r=>resource(r,{baseCurrency:r.base_currency,quoteCurrency:r.quote_currency,rateDate:iso(r.rate_date),rate:rateText(rateScaled(String(r.rate))),sourceEvidenceId:r.source_evidence_id});
async function loadRate(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','FX rate not found.');const row=(await tx.query('select * from lara.fx_rates where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','FX rate not found.');return row;}
// Quote conventions: the quote currency is a functional currency of one of
// the entity's books and the base is not; a rate that is the inverse of a
// recent approved rate for the same pair (off by more than a factor of ten)
// is refused as an inverted-pair mistake.
async function checkRateInput(tx,ctx,entityId,input){
 if(input.baseCurrency===input.quoteCurrency)fail('VALIDATION_FAILED','Base and quote currencies differ.',{fieldErrors:[{path:'quoteCurrency',message:'Same as base'}]});
 const known=(await tx.query('select code from lara.currency_metadata where code=any($1::text[])',[[input.baseCurrency,input.quoteCurrency]])).rows.map(r=>r.code);
 for(const c of [input.baseCurrency,input.quoteCurrency])if(!known.includes(c))fail('VALIDATION_FAILED','Currency '+c+' is not in the currency metadata.',{fieldErrors:[{path:'baseCurrency',message:'Unknown currency'}]});
 const functional=(await tx.query("select distinct functional_currency from lara.books where tenant_id=$1 and entity_id=$2 and status<>'archived'",[ctx.tenantId,entityId])).rows.map(r=>r.functional_currency);
 if(!functional.includes(input.quoteCurrency))fail('VALIDATION_FAILED','Rates are quoted in a functional currency of this entity ('+functional.join(', ')+') per one unit of the foreign currency; '+input.baseCurrency+'/'+input.quoteCurrency+' looks inverted.',{fieldErrors:[{path:'quoteCurrency',message:'Quote in the functional currency'}]});
 const R=rateScaled(input.rate);
 const evidence=(await tx.query("select status from lara.evidence where tenant_id=$1 and entity_id=$2 and id=$3",[ctx.tenantId,entityId,input.sourceEvidenceId])).rows[0];
 if(!evidence)fail('NOT_FOUND','Rate source evidence not found.');
 if(evidence.status!=='available')fail('EVIDENCE_NOT_READY','Rate source evidence must be available.');
 const recent=(await tx.query("select rate from lara.fx_rates where tenant_id=$1 and entity_id=$2 and base_currency=$3 and quote_currency=$4 and status='approved' and rate_date between $5::date - interval '90 days' and $5::date + interval '90 days' order by abs(rate_date-$5::date) limit 1",[ctx.tenantId,entityId,input.baseCurrency,input.quoteCurrency,input.rateDate])).rows[0];
 if(recent){const prior=rateScaled(String(recent.rate));if(R*10n<prior||R>prior*10n)fail('VALIDATION_FAILED','Rate '+input.rate+' differs from the recent approved '+input.baseCurrency+'/'+input.quoteCurrency+' rate by more than a factor of ten; check for an inverted pair.',{fieldErrors:[{path:'rate',message:'Inverted pair?'}]});}
}
export async function createFxRate(tx,ctx,entityId,input){
 requirePermission(ctx,'fx_rate.create');requireEntity(ctx,entityId);assertInput('FxRateCreate',input);await requireFx(tx,ctx,entityId);
 await checkRateInput(tx,ctx,entityId,input);
 const row=(await tx.query('insert into lara.fx_rates(tenant_id,entity_id,base_currency,quote_currency,rate_date,rate,source_evidence_id,created_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[ctx.tenantId,entityId,input.baseCurrency,input.quoteCurrency,input.rateDate,input.rate,input.sourceEvidenceId,ctx.principalId])).rows[0];
 await linkEvidence(tx,ctx,entityId,[input.sourceEvidenceId],'fx_rate',row.id,1);
 await audit(tx,ctx,{entityId,action:'fx_rate.create',resourceType:'fx_rate',resourceId:row.id,resourceVersion:1});
 return rateResource(row);
}
export async function updateFxRate(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'fx_rate.edit');requireEntity(ctx,entityId);assertInput('FxRateCreate',input);
 const row=await loadRate(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(row.status!=='draft')fail('STATE_CONFLICT','Only draft rates change; an approved rate is corrected by a new rate.');
 await checkRateInput(tx,ctx,entityId,input);
 const updated=(await tx.query('update lara.fx_rates set base_currency=$3,quote_currency=$4,rate_date=$5,rate=$6,source_evidence_id=$7,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.baseCurrency,input.quoteCurrency,input.rateDate,input.rate,input.sourceEvidenceId])).rows[0];
 await audit(tx,ctx,{entityId,action:'fx_rate.edit',resourceType:'fx_rate',resourceId:id,resourceVersion:Number(updated.version)});
 return rateResource(updated);
}
export async function approveFxRate(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'fx_rate.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadRate(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.status!=='draft')fail('STATE_CONFLICT','FX rate is '+row.status+'.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The rate author cannot approve it.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The rate changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 if(input.decision==='approve'){const clash=(await tx.query("select id from lara.fx_rates where tenant_id=$1 and entity_id=$2 and base_currency=$3 and quote_currency=$4 and rate_date=$5 and status='approved'",[ctx.tenantId,entityId,row.base_currency,row.quote_currency,iso(row.rate_date)])).rows[0];if(clash)fail('STATE_CONFLICT','An approved '+row.base_currency+'/'+row.quote_currency+' rate for '+iso(row.rate_date)+' already exists ('+clash.id+').');}
 const updated=(await tx.query('update lara.fx_rates set status=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.decision==='approve'?'approved':'rejected',input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'fx_rate.'+input.decision,resourceType:'fx_rate',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null});
 return {resourceType:'fx_rate',resourceId:id,version:Number(updated.version),state:updated.status};
}
export async function getFxRate(tx,ctx,entityId,id){requirePermission(ctx,'fx_rate.read');requireEntity(ctx,entityId);return rateResource(await loadRate(tx,ctx,entityId,id,{lock:false}));}
export async function listFxRates(tx,ctx,entityId,query){
 requirePermission(ctx,'fx_rate.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];
 const rows=(await tx.query('select * from lara.fx_rates where tenant_id=$1 and entity_id=$2'+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,rateResource,scope);
}
// The approved rate for a pair on a date; the same currency is 1; anything else blocks.
export async function rateFor(tx,ctx,entityId,{base,quote,onDate}){
 if(base===quote)return {id:null,rate:PICO,text:'1'};
 const row=(await tx.query("select id,rate from lara.fx_rates where tenant_id=$1 and entity_id=$2 and base_currency=$3 and quote_currency=$4 and rate_date=$5 and status='approved'",[ctx.tenantId,entityId,base,quote,onDate])).rows[0];
 if(!row)fail('STATE_CONFLICT','No approved '+base+'/'+quote+' rate for '+onDate+'; rates never default to 1.',{fieldErrors:[{path:'rate',message:'Approve a rate for '+onDate}]});
 const scaled=rateScaled(String(row.rate));
 return {id:row.id,rate:scaled,text:rateText(scaled)};
}
// Translates journal lines: every line at the rate, the residual of the
// functional totals on the control line (index 0) so both sides balance.
export function translateLines(lines,rate,{units=2,controlAccountId=null}={}){
 const out=lines.map(l=>({...l,funcDebit:decimal(convert(micros(l.debit),rate,units),6),funcCredit:decimal(convert(micros(l.credit),rate,units),6)}));
 const fd=out.reduce((t,l)=>t+micros(l.funcDebit),0n),fc=out.reduce((t,l)=>t+micros(l.funcCredit),0n);
 const diff=fd-fc;
 if(diff!==0n){const c=out.find(l=>controlAccountId&&l.accountId===controlAccountId)||out[0];if(micros(c.funcDebit)>0n)c.funcDebit=decimal(micros(c.funcDebit)-diff,6);else c.funcCredit=decimal(micros(c.funcCredit)+diff,6);}
 return out;
}
// The functional amount a translated entry moves on the control account.
export const controlFunc=(lines,controlAccountId)=>{const l=lines.find(x=>x.accountId===controlAccountId)||lines[0];return micros(l.funcDebit)>0n?micros(l.funcDebit):micros(l.funcCredit);};
// The posting payload extras for a foreign-currency entry.
export const postingFx=r=>({rate:r.text,rateId:r.id});

// ---------------------------------------------------------------------------
// Open-item FX layers
// ---------------------------------------------------------------------------
export async function layerState(tx,ctx,openItemId){
 return (await tx.query('select * from lara.fx_open_item_layers where tenant_id=$1 and open_item_id=$2 order by seq desc limit 1',[ctx.tenantId,openItemId])).rows[0]||null;
}
async function addLayer(tx,ctx,entityId,openItemId,fields){
 const seq=((await tx.query('select coalesce(max(seq),0)::int s from lara.fx_open_item_layers where tenant_id=$1 and open_item_id=$2',[ctx.tenantId,openItemId])).rows[0].s)+1;
 return (await tx.query('insert into lara.fx_open_item_layers(tenant_id,entity_id,open_item_id,seq,event,settlement_id,revaluation_id,txn_consumed,func_consumed,realized_fx,txn_remaining,func_carrying,rate,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *',[ctx.tenantId,entityId,openItemId,seq,fields.event,fields.settlementId||null,fields.revaluationId||null,decimal(fields.txnConsumed||0n,6),decimal(fields.funcConsumed||0n,6),decimal(fields.realized||0n,6),decimal(fields.txnRemaining,6),decimal(fields.funcCarrying,6),fields.rateText,ctx.principalId])).rows[0];
}
export async function openLayer(tx,ctx,entityId,{openItemId,txn,func,rate}){
 return addLayer(tx,ctx,entityId,openItemId,{event:'open',txnRemaining:txn,funcCarrying:func,rateText:rate.text});
}
// Consumes layers proportionally for each allocation at the settlement rate;
// the allocation that clears the item absorbs rounding. Returns the
// functional cash equivalent, the consumed carrying value and the realized
// difference (positive is a gain for both sides).
export async function settleLayers(tx,ctx,entityId,{settlementId,allocations,rate,side,units=2}){
 let cashFunc=0n,consumed=0n,realized=0n;const items=[];
 for(const a of allocations){
  const state=await layerState(tx,ctx,a.openItemId);
  if(!state)fail('STATE_CONFLICT','Open item '+a.openItemId+' has no FX layer; it is not a foreign-currency item.');
  const txnAlloc=micros(String(a.amount));const remaining=micros(String(state.txn_remaining)),carrying=signedMicros(String(state.func_carrying));
  if(txnAlloc>remaining)fail('VALIDATION_FAILED','Allocation '+a.amount+' exceeds the remaining '+decimal(remaining)+' of the open item.',{fieldErrors:[{path:'allocations',message:'Exceeds remaining'}]});
  const funcConsumed=txnAlloc===remaining?carrying:roundMinor(carrying*txnAlloc/remaining,units);
  const funcCash=convert(txnAlloc,rate.rate,units);
  const gain=side==='AR'?funcCash-funcConsumed:funcConsumed-funcCash;
  await addLayer(tx,ctx,entityId,a.openItemId,{event:'settle',settlementId,txnConsumed:txnAlloc,funcConsumed,realized:gain,txnRemaining:remaining-txnAlloc,funcCarrying:carrying-funcConsumed,rateText:rate.text});
  cashFunc+=funcCash;consumed+=funcConsumed;realized+=gain;items.push({openItemId:a.openItemId,txn:txnAlloc,funcCash,funcConsumed,gain});
 }
 return {cashFunc,consumed,realized,items};
}
// A reversed settlement restores each layer it consumed, at the original amounts.
export async function reverseLayers(tx,ctx,entityId,{settlementId}){
 const events=(await tx.query("select * from lara.fx_open_item_layers where tenant_id=$1 and settlement_id=$2 and event='settle' order by seq",[ctx.tenantId,settlementId])).rows;
 let realized=0n;
 for(const e of events){
  const state=await layerState(tx,ctx,e.open_item_id);
  await addLayer(tx,ctx,entityId,e.open_item_id,{event:'reverse',settlementId,txnConsumed:-micros(String(e.txn_consumed)),funcConsumed:-signedMicros(String(e.func_consumed)),realized:-signedMicros(String(e.realized_fx)),txnRemaining:micros(String(state.txn_remaining))+micros(String(e.txn_consumed)),funcCarrying:signedMicros(String(state.func_carrying))+signedMicros(String(e.func_consumed)),rateText:String(e.rate)});
  realized+=signedMicros(String(e.realized_fx));
 }
 return {realized};
}
// Realized FX posts as a functional-currency adjustment with explicit
// purpose against the control account: a gain credits the gain account, a
// loss debits the loss account. The transaction entry already moved the
// control at the cash rate; this line brings it to the consumed carrying value.
export async function postRealized(tx,ctx,entityId,{bookId,sourceType,sourceId,sourceVersion,accountingDate,description,controlAccountId,branchId,side,cashFunc,consumed,commandId=null,reversalOf=null}){
 const diff=cashFunc-consumed;
 if(diff===0n)return null;
 const profile=await fxProfile(tx,ctx,entityId);
 const book=(await tx.query('select functional_currency from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,bookId])).rows[0];
 const gain=side==='AR'?diff>0n:diff<0n;const amount=diff<0n?-diff:diff;
 // AR: the control must end lower by consumed; the txn entry took cashFunc; a gain (cashFunc > consumed) debits the control back by diff.
 // AP: the control must end lower by consumed; the txn entry took cashFunc; a gain (cashFunc < consumed) debits the control by the difference.
 const controlDebit=side==='AR'?diff>0n:diff<0n;
 const lines=controlDebit?[{accountId:controlAccountId,branchId,dimensions:{},debit:decimal(amount,6),credit:'0'},{accountId:gain?profile.realizedGainAccountId:profile.realizedLossAccountId,branchId,dimensions:{},debit:'0',credit:decimal(amount,6)}]
  :[{accountId:gain?profile.realizedGainAccountId:profile.realizedLossAccountId,branchId,dimensions:{},debit:decimal(amount,6),credit:'0'},{accountId:controlAccountId,branchId,dimensions:{},debit:'0',credit:decimal(amount,6)}];
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId,sourceType,sourceId,sourceVersion,purpose:'adjustment',accountingDate,documentDate:accountingDate,description:description+' — realized FX '+(gain?'gain':'loss')+' '+decimal(amount),currency:book.functional_currency,manual:false,postingActor:ctx.principalId,commandId,...(reversalOf?{reversalOf}:{}),lines})])).rows[0].id;
 await audit(tx,ctx,{entityId,action:'fx.realized',resourceType:sourceType,resourceId:sourceId,resourceVersion:sourceVersion,afterRef:entryId,reason:(gain?'gain ':'loss ')+decimal(amount)});
 return entryId;
}
export async function listLayers(tx,ctx,entityId,{openItemId=null,partyId=null}={}){
 requirePermission(ctx,'open_item.read');requireEntity(ctx,entityId);
 const params=[ctx.tenantId,entityId];let where='';
 if(openItemId){if(!isUuid(openItemId))fail('VALIDATION_FAILED','openItemId must be a UUID.');params.push(openItemId);where+=' and l.open_item_id=$'+params.length;}
 if(partyId){if(!isUuid(partyId))fail('VALIDATION_FAILED','partyId must be a UUID.');params.push(partyId);where+=' and o.party_id=$'+params.length;}
 const rows=(await tx.query('select l.*,o.currency,o.side,o.document_id,o.party_id,d.official_number from lara.fx_open_item_layers l join lara.open_items o on o.tenant_id=l.tenant_id and o.id=l.open_item_id join lara.documents d on d.tenant_id=o.tenant_id and d.id=o.document_id where l.tenant_id=$1 and l.entity_id=$2'+where+' order by o.created_at,l.open_item_id,l.seq',params)).rows;
 return {items:rows.map(r=>({id:r.id,openItemId:r.open_item_id,documentId:r.document_id,officialNumber:r.official_number,partyId:r.party_id,side:r.side,currency:r.currency,seq:r.seq,event:r.event,settlementId:r.settlement_id,revaluationId:r.revaluation_id,txnConsumed:decimal(signedMicros(String(r.txn_consumed))),funcConsumed:decimal(signedMicros(String(r.func_consumed))),realizedFx:decimal(signedMicros(String(r.realized_fx))),txnRemaining:decimal(micros(String(r.txn_remaining))),funcCarrying:decimal(signedMicros(String(r.func_carrying))),rate:rateText(rateScaled(String(r.rate))),createdAt:iso(r.created_at)})),nextCursor:null};
}

// ---------------------------------------------------------------------------
// Revaluation runs
// ---------------------------------------------------------------------------
const runResource=r=>resource({...r,status:r.state},{bookId:r.book_id,periodId:r.period_id,rateSetId:r.rate_set_id,accountIds:r.account_ids,reverseNextPeriod:r.reverse_next_period});
async function loadRun(tx,ctx,entityId,id,{lock=true}={}){if(!isUuid(id))fail('NOT_FOUND','Revaluation not found.');const row=(await tx.query('select * from lara.revaluation_runs where tenant_id=$1 and entity_id=$2 and id=$3'+(lock?' for update':''),[ctx.tenantId,entityId,id])).rows[0];if(!row)fail('NOT_FOUND','Revaluation not found.');return row;}
async function checkRunInput(tx,ctx,entityId,input){
 const book=(await tx.query("select * from lara.books where tenant_id=$1 and entity_id=$2 and id=$3 and status='active'",[ctx.tenantId,entityId,input.bookId])).rows[0];
 if(!book)fail('NOT_FOUND','Book not found.');
 await requireBookAccess(tx,ctx,book,'post');
 const period=(await tx.query('select * from lara.periods where tenant_id=$1 and entity_id=$2 and book_id=$3 and id=$4',[ctx.tenantId,entityId,input.bookId,input.periodId])).rows[0];
 if(!period)fail('NOT_FOUND','Period not found in this book.');
 const rate=(await tx.query("select * from lara.fx_rates where tenant_id=$1 and entity_id=$2 and id=$3 and status='approved'",[ctx.tenantId,entityId,input.rateSetId])).rows[0];
 if(!rate)fail('STATE_CONFLICT','rateSetId names an approved FX rate (the closing rate set).');
 if(rate.quote_currency!==book.functional_currency)fail('VALIDATION_FAILED','The closing rate must be quoted in the book\'s functional currency '+book.functional_currency+'.',{fieldErrors:[{path:'rateSetId',message:'Wrong quote currency'}]});
 if(iso(rate.rate_date)!==iso(period.ends_on))fail('VALIDATION_FAILED','The closing rate is dated on the period end '+iso(period.ends_on)+'.',{fieldErrors:[{path:'rateSetId',message:'Not the period-end rate'}]});
 const profile=await fxProfile(tx,ctx,entityId);
 const accounts=(await tx.query("select id,code,status from lara.accounts where tenant_id=$1 and entity_id=$2 and book_id=$3 and id=any($4::uuid[])",[ctx.tenantId,entityId,input.bookId,input.accountIds])).rows;
 if(accounts.length!==input.accountIds.length)fail('NOT_FOUND','Every revalued account must exist in the book.');
 const blind=accounts.filter(a=>!profile.monetaryAccountIds.includes(a.id));
 if(blind.length)fail('VALIDATION_FAILED','Only accounts the controller classified as monetary are revalued; not: '+blind.map(a=>a.code).join(', ')+'.',{fieldErrors:blind.map(a=>({path:'accountIds',message:a.code+' is not classified monetary'}))});
 return {book,period,rate,profile};
}
export async function createRevaluation(tx,ctx,entityId,input){
 requirePermission(ctx,'revaluation.create');requireEntity(ctx,entityId);assertInput('RevaluationCreate',input);await requireFx(tx,ctx,entityId);
 const {rate}=await checkRunInput(tx,ctx,entityId,input);
 const row=(await tx.query('insert into lara.revaluation_runs(tenant_id,entity_id,book_id,period_id,rate_set_id,currency,account_ids,reverse_next_period,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[ctx.tenantId,entityId,input.bookId,input.periodId,input.rateSetId,rate.base_currency,JSON.stringify([...input.accountIds].sort()),input.reverseNextPeriod,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'revaluation.create',resourceType:'revaluation',resourceId:row.id,resourceVersion:1});
 return runResource(row);
}
export async function updateRevaluation(tx,ctx,entityId,id,expectedVersion,input){
 requirePermission(ctx,'revaluation.edit');requireEntity(ctx,entityId);assertInput('RevaluationCreate',input);
 const row=await loadRun(tx,ctx,entityId,id);expectVersion(row,expectedVersion);
 if(!['draft','previewed'].includes(row.state))fail('STATE_CONFLICT','Revaluation is '+row.state+'.');
 const {rate}=await checkRunInput(tx,ctx,entityId,input);
 const updated=(await tx.query("update lara.revaluation_runs set state='draft',book_id=$3,period_id=$4,rate_set_id=$5,currency=$6,account_ids=$7,reverse_next_period=$8,preview_json=null,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,input.bookId,input.periodId,input.rateSetId,rate.base_currency,JSON.stringify([...input.accountIds].sort()),input.reverseNextPeriod])).rows[0];
 await audit(tx,ctx,{entityId,action:'revaluation.edit',resourceType:'revaluation',resourceId:id,resourceVersion:Number(updated.version)});
 return runResource(updated);
}
// The preview: per account, the transaction-currency balance (lines of
// entries in that currency up to the period end), the functional carrying
// value (those lines plus earlier revaluation and realized adjustments for
// the currency), the revalued amount at the closing rate and the difference.
async function computePreview(tx,ctx,entityId,row){
 const rate=(await tx.query('select * from lara.fx_rates where tenant_id=$1 and id=$2',[ctx.tenantId,row.rate_set_id])).rows[0];
 const period=(await tx.query('select * from lara.periods where tenant_id=$1 and id=$2',[ctx.tenantId,row.period_id])).rows[0];
 const R=rateScaled(String(rate.rate));const units=await minorUnits(tx,rate.quote_currency);
 const lines=[];let total=0n;
 for(const accountId of row.account_ids){
  const acct=(await tx.query('select code,name from lara.accounts where tenant_id=$1 and id=$2',[ctx.tenantId,accountId])).rows[0];
  const txn=signedMicros((await tx.query('select coalesce(sum(l.txn_debit-l.txn_credit),0)::text as b from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.book_id=$2 and l.account_id=$3 and e.transaction_currency=$4 and e.accounting_date<=$5::date',[ctx.tenantId,row.book_id,accountId,row.currency,iso(period.ends_on)])).rows[0].b);
  const func=signedMicros((await tx.query("select coalesce(sum(l.func_debit-l.func_credit),0)::text as b from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.book_id=$2 and l.account_id=$3 and e.accounting_date<=$5::date and (e.transaction_currency=$4 or (e.purpose in ('adjustment','reversal') and e.source_type='revaluation' and exists (select 1 from lara.revaluation_runs r where r.tenant_id=e.tenant_id and r.id=e.source_id and r.currency=$4)) or (e.purpose in ('adjustment','reversal') and e.source_type in ('settlement_fx','document_fx') and exists (select 1 from lara.journal_entries t where t.tenant_id=e.tenant_id and t.source_id=e.source_id and t.source_type in ('settlement','document') and t.transaction_currency=$4)))",[ctx.tenantId,row.book_id,accountId,row.currency,iso(period.ends_on)])).rows[0].b);
  const revalued=convert(txn,R,units);const diff=revalued-func;total+=diff;
  lines.push({accountId,accountCode:acct.code,accountName:acct.name,txnBalance:decimal(txn),carrying:decimal(func),revalued:decimal(revalued),difference:decimal(diff)});
 }
 const prior=(await tx.query("select id from lara.revaluation_runs where tenant_id=$1 and book_id=$2 and period_id=$3 and currency=$4 and state='posted' and id<>$5 order by created_at desc limit 1",[ctx.tenantId,row.book_id,row.period_id,row.currency,row.id])).rows[0];
 return {currency:row.currency,rate:rateText(R),rateDate:iso(rate.rate_date),periodEnd:iso(period.ends_on),lines,totalDifference:decimal(total),adjustsRunId:prior?.id||null,checksum:contentHash({currency:row.currency,rate:rateText(R),lines})};
}
export async function previewRevaluation(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'revaluation.preview');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadRun(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(!['draft','previewed'].includes(row.state))fail('STATE_CONFLICT','Revaluation is '+row.state+'.');
 const preview=await computePreview(tx,ctx,entityId,row);
 const updated=(await tx.query("update lara.revaluation_runs set state='previewed',preview_json=$3,adjusts_run_id=$4,content_version=content_version+1 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,JSON.stringify(preview),preview.adjustsRunId])).rows[0];
 await audit(tx,ctx,{entityId,action:'revaluation.preview',resourceType:'revaluation',resourceId:id,resourceVersion:Number(updated.version),afterRef:preview.checksum,reason:'difference '+preview.totalDifference});
 return {resourceType:'revaluation',resourceId:id,version:Number(updated.version),state:'previewed',preview};
}
export async function approveRevaluation(tx,ctx,entityId,id,input,expectedVersion){
 requirePermission(ctx,'revaluation.approve');requireEntity(ctx,entityId);assertInput('ApprovalDecision',input);
 const row=await loadRun(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state!=='previewed')fail('STATE_CONFLICT','Preview the revaluation before approval.');
 if(row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot approve the revaluation.');
 if(Number(row.content_version)!==input.contentVersion)fail('VERSION_CONFLICT','The revaluation changed since review.',{resourceVersion:Number(row.version)});
 if(input.decision==='reject'&&!input.reason)fail('VALIDATION_FAILED','Rejection requires a reason.',{fieldErrors:[{path:'reason',message:'Required'}]});
 // The preview must still hold: a posting since the preview changes the carrying value.
 if(input.decision==='approve'){const fresh=await computePreview(tx,ctx,entityId,row);if(fresh.checksum!==row.preview_json.checksum)fail('STATE_CONFLICT','Balances changed since the preview; preview again.');}
 const updated=(await tx.query('update lara.revaluation_runs set state=$3,approved_by=$4 where tenant_id=$1 and id=$2 returning *',[ctx.tenantId,id,input.decision==='approve'?'approved':'rejected',input.decision==='approve'?ctx.principalId:null])).rows[0];
 await audit(tx,ctx,{entityId,action:'revaluation.'+input.decision,resourceType:'revaluation',resourceId:id,resourceVersion:Number(updated.version),reason:input.reason||null,afterRef:row.preview_json.checksum});
 return {resourceType:'revaluation',resourceId:id,version:Number(updated.version),state:updated.state};
}
// Posting: one functional adjustment entry for the run (a retry returns the
// same entry); the optional reversal posts on the first day of the next open period.
export async function postRevaluation(tx,ctx,entityId,id,input,expectedVersion,{commandId=null}={}){
 requirePermission(ctx,'revaluation.post');requireEntity(ctx,entityId);assertInput('Action',input||{});
 const row=await loadRun(tx,ctx,entityId,id);if(expectedVersion!==undefined)expectVersion(row,expectedVersion);
 if(row.state==='posted')return {resourceType:'revaluation',resourceId:id,version:Number(row.version),state:'posted',journalEntryIds:[row.entry_id,...(row.reversal_entry_id?[row.reversal_entry_id]:[])]};
 if(row.state!=='approved')fail('STATE_CONFLICT','Approve the revaluation before posting.');
 if(row.approved_by===ctx.principalId&&row.created_by===ctx.principalId)fail('SELF_APPROVAL','The preparer cannot both approve and post.');
 const preview=row.preview_json;const profile=await fxProfile(tx,ctx,entityId);
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and id=$2',[ctx.tenantId,row.book_id])).rows[0];
 await requireBookAccess(tx,ctx,book,'post');
 const branch=(await tx.query("select id from lara.branches where tenant_id=$1 and entity_id=$2 and status='active' order by created_at limit 1",[ctx.tenantId,entityId])).rows[0];
 const lines=[];let gain=0n,loss=0n;
 for(const l of preview.lines){const d=signedMicros(l.difference);if(d===0n)continue;if(d>0n){lines.push({accountId:l.accountId,branchId:branch.id,dimensions:{},debit:decimal(d,6),credit:'0'});gain+=d;}else{lines.push({accountId:l.accountId,branchId:branch.id,dimensions:{},debit:'0',credit:decimal(-d,6)});loss+=-d;}}
 if(gain>0n)lines.push({accountId:profile.unrealizedGainAccountId,branchId:branch.id,dimensions:{},debit:'0',credit:decimal(gain,6)});
 if(loss>0n)lines.push({accountId:profile.unrealizedLossAccountId,branchId:branch.id,dimensions:{},debit:decimal(loss,6),credit:'0'});
 if(!lines.length)fail('STATE_CONFLICT','The revaluation has no difference to post.');
 const entryId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'revaluation',sourceId:id,sourceVersion:Number(row.content_version),purpose:'adjustment',accountingDate:preview.periodEnd,documentDate:preview.periodEnd,description:'Revaluation of '+row.currency+' at '+preview.rate+' ('+preview.rateDate+')'+(row.adjusts_run_id?' adjusting '+row.adjusts_run_id.slice(0,8):''),currency:book.functional_currency,manual:false,postingActor:ctx.principalId,commandId,allowSoftClosed:true,lines})])).rows[0].id;
 let reversalId=null;
 if(row.reverse_next_period){
  const next=(await tx.query("select * from lara.periods where tenant_id=$1 and book_id=$2 and starts_on>$3::date order by starts_on limit 1",[ctx.tenantId,row.book_id,preview.periodEnd])).rows[0];
  if(!next||next.status==='locked')fail('STATE_CONFLICT','The next period must exist and be open for the reversal.');
  reversalId=(await tx.query('select lara.post_journal_entry($1::jsonb) as id',[JSON.stringify({tenantId:ctx.tenantId,entityId,bookId:row.book_id,sourceType:'revaluation',sourceId:id,sourceVersion:Number(row.content_version),purpose:'reversal',reversalOf:entryId,accountingDate:iso(next.starts_on),documentDate:iso(next.starts_on),description:'Reversal of revaluation of '+row.currency+' at '+preview.rate,currency:book.functional_currency,manual:false,postingActor:ctx.principalId,commandId,allowSoftClosed:true,lines:lines.map(l=>({...l,debit:l.credit,credit:l.debit}))})])).rows[0].id;
 }
 const updated=(await tx.query("update lara.revaluation_runs set state='posted',entry_id=$3,reversal_entry_id=$4 where tenant_id=$1 and id=$2 returning *",[ctx.tenantId,id,entryId,reversalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'revaluation.post',resourceType:'revaluation',resourceId:id,resourceVersion:Number(updated.version),afterRef:entryId});
 await emit(tx,ctx,{entityId,aggregateType:'revaluation',aggregateId:id,aggregateVersion:Number(updated.version),eventType:'document.posted.v1',payload:{revaluationId:id,entryId,reversalEntryId:reversalId,bookId:row.book_id}});
 return {resourceType:'revaluation',resourceId:id,version:Number(updated.version),state:'posted',journalEntryIds:[entryId,...(reversalId?[reversalId]:[])]};
}
export async function getRevaluation(tx,ctx,entityId,id){requirePermission(ctx,'revaluation.read');requireEntity(ctx,entityId);return runResource(await loadRun(tx,ctx,entityId,id,{lock:false}));}
export async function revaluationPreview(tx,ctx,entityId,id){
 requirePermission(ctx,'revaluation.read');requireEntity(ctx,entityId);const row=await loadRun(tx,ctx,entityId,id,{lock:false});
 const p=row.preview_json||{currency:row.currency,rate:null,rateDate:null,periodEnd:null,lines:[],totalDifference:'0.00',adjustsRunId:null,checksum:null};
 return {id:row.id,state:row.state,currency:p.currency,rate:p.rate,rateDate:p.rateDate,periodEnd:p.periodEnd,lines:p.lines,totalDifference:p.totalDifference,adjustsRunId:p.adjustsRunId,entryId:row.entry_id,reversalEntryId:row.reversal_entry_id,checksum:p.checksum};
}
export async function listRevaluations(tx,ctx,entityId,query){
 requirePermission(ctx,'revaluation.read');requireEntity(ctx,entityId);const scope=cursorScope(ctx,entityId,query||{});const {limit,after}=pageArgs(query,scope);
 const params=[ctx.tenantId,entityId,limit+1];let where='';
 if(query?.bookId){if(!isUuid(query.bookId))fail('VALIDATION_FAILED','bookId must be a UUID.');params.push(query.bookId);where+=' and book_id=$'+params.length;}
 const rows=(await tx.query('select * from lara.revaluation_runs where tenant_id=$1 and entity_id=$2'+where+cursorClause(after,params)+' order by created_at,id limit $3',params)).rows;
 return page(rows,limit,runResource,scope);
}

// ---------------------------------------------------------------------------
// Book partitions, access and the combined management view
// ---------------------------------------------------------------------------
// A partition with any grant admits only granted principals; primary and
// management books stay open to the entity.
export async function requireBookAccess(tx,ctx,book,access){
 if(!['rbu','fcdu','trust'].includes(book.kind))return;
 const grants=(await tx.query('select principal_id,access from lara.book_access where tenant_id=$1 and book_id=$2',[ctx.tenantId,book.id])).rows;
 if(!grants.length)return;
 const mine=grants.filter(g=>g.principal_id===ctx.principalId).map(g=>g.access);
 if(!(mine.includes(access)||(access==='read'&&mine.includes('post'))))fail('FORBIDDEN','No '+access+' access to book '+book.code+'.');
}
export async function grantBookAccess(tx,ctx,entityId,{bookId,principalId,access}){
 requirePermission(ctx,'book.edit');requireEntity(ctx,entityId);
 if(!['read','post'].includes(access))fail('VALIDATION_FAILED','access is read or post.',{fieldErrors:[{path:'access',message:'Invalid'}]});
 const book=(await tx.query('select * from lara.books where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,bookId])).rows[0];
 if(!book)fail('NOT_FOUND','Book not found.');
 if(!['rbu','fcdu','trust'].includes(book.kind))fail('STATE_CONFLICT','Only partitions (rbu, fcdu, trust) carry access grants.');
 if(principalId===ctx.principalId)fail('SELF_APPROVAL','Access is granted by someone other than its holder.');
 const row=(await tx.query('insert into lara.book_access(tenant_id,entity_id,book_id,principal_id,access,granted_by) values($1,$2,$3,$4,$5,$6) on conflict (tenant_id,book_id,principal_id,access) do update set granted_by=excluded.granted_by returning *',[ctx.tenantId,entityId,bookId,principalId,access,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'book.grant',resourceType:'book',resourceId:bookId,resourceVersion:Number(book.version),reason:access+' for '+principalId});
 return {id:row.id,bookId,principalId,access};
}
export async function linkBook(tx,ctx,entityId,{sourceBookId,targetViewId,translationPolicy='closing_rate'}){
 requirePermission(ctx,'book.edit');requireEntity(ctx,entityId);
 const source=(await tx.query('select * from lara.books where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,sourceBookId])).rows[0];
 const target=(await tx.query('select * from lara.books where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,targetViewId])).rows[0];
 if(!source||!target)fail('NOT_FOUND','Book not found.');
 if(target.kind!=='management')fail('STATE_CONFLICT','Books link only into a management view.');
 if(source.kind==='management')fail('STATE_CONFLICT','A management view is not a source.');
 if(!['as_is','closing_rate','exclude'].includes(translationPolicy))fail('VALIDATION_FAILED','translationPolicy is as_is, closing_rate or exclude.',{fieldErrors:[{path:'translationPolicy',message:'Invalid'}]});
 const row=(await tx.query('insert into lara.book_links(tenant_id,entity_id,source_book_id,target_view_id,translation_policy,created_by) values($1,$2,$3,$4,$5,$6) on conflict (tenant_id,source_book_id,target_view_id) do update set translation_policy=excluded.translation_policy returning *',[ctx.tenantId,entityId,sourceBookId,targetViewId,translationPolicy,ctx.principalId])).rows[0];
 await audit(tx,ctx,{entityId,action:'book.link',resourceType:'book',resourceId:targetViewId,resourceVersion:Number(target.version),reason:source.code+' '+translationPolicy});
 return {id:row.id,sourceBookId,targetViewId,translationPolicy};
}
// Per-book functional trial balances at the cutoff, each counted once, translated
// into the view's currency at the approved closing rate when the policy says so,
// labelled with basis and exclusions. No group consolidation and no eliminations.
export async function combinedView(tx,ctx,entityId,{viewBookId,asOf}){
 requirePermission(ctx,'book.read');requireEntity(ctx,entityId);
 if(!isUuid(viewBookId))fail('NOT_FOUND','Book not found.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf||''))fail('VALIDATION_FAILED','asOf is a date.',{fieldErrors:[{path:'asOf',message:'Date'}]});
 const view=(await tx.query('select * from lara.books where tenant_id=$1 and entity_id=$2 and id=$3',[ctx.tenantId,entityId,viewBookId])).rows[0];
 if(!view)fail('NOT_FOUND','Book not found.');
 if(view.kind!=='management')fail('STATE_CONFLICT','Combined views are read from a management book.');
 const links=(await tx.query('select l.*,b.code,b.kind,b.functional_currency,b.status from lara.book_links l join lara.books b on b.tenant_id=l.tenant_id and b.id=l.source_book_id where l.tenant_id=$1 and l.target_view_id=$2 order by b.code',[ctx.tenantId,viewBookId])).rows;
 const books=[];const totals=new Map();const excluded=[];let blocked=[];
 for(const l of links){
  if(l.translation_policy==='exclude'){excluded.push({bookId:l.source_book_id,code:l.code,kind:l.kind,reason:'excluded by policy'});continue;}
  try{await requireBookAccess(tx,ctx,{id:l.source_book_id,code:l.code,kind:l.kind},'read');}catch{excluded.push({bookId:l.source_book_id,code:l.code,kind:l.kind,reason:'no read access'});continue;}
  let rate={rate:PICO,text:'1',id:null};
  if(l.functional_currency!==view.functional_currency){
   if(l.translation_policy==='as_is'){excluded.push({bookId:l.source_book_id,code:l.code,kind:l.kind,reason:'as_is policy with a different currency; not combined'});continue;}
   try{rate=await rateFor(tx,ctx,entityId,{base:l.functional_currency,quote:view.functional_currency,onDate:asOf});}catch(e){blocked.push({bookId:l.source_book_id,code:l.code,reason:e.message});continue;}
  }
  const rows=(await tx.query('select a.code,a.name,a.category,coalesce(sum(j.func_debit-j.func_credit),0)::text as balance from lara.accounts a left join lara.journal_lines j on j.tenant_id=a.tenant_id and j.account_id=a.id left join lara.journal_entries e on e.tenant_id=j.tenant_id and e.id=j.entry_id and e.accounting_date<=$3::date where a.tenant_id=$1 and a.book_id=$2 and (j.id is null or e.id is not null) group by a.code,a.name,a.category having coalesce(sum(j.func_debit-j.func_credit),0)<>0 order by a.code',[ctx.tenantId,l.source_book_id,asOf])).rows;
  const accounts=rows.map(r=>{const native=signedMicros(r.balance);const translated=convert(native,rate.rate);const key=r.code;totals.set(key,{code:r.code,name:r.name,category:r.category,balance:(totals.get(key)?.balance||0n)+translated});return {code:r.code,name:r.name,category:r.category,nativeBalance:decimal(native),translated:decimal(translated)};});
  books.push({bookId:l.source_book_id,code:l.code,kind:l.kind,functionalCurrency:l.functional_currency,policy:l.translation_policy,rate:rate.text,accounts});
 }
 const combined=[...totals.values()].sort((a,b)=>a.code.localeCompare(b.code)).map(t=>({...t,balance:decimal(t.balance)}));
 const body={viewBookId,viewCode:view.code,currency:view.functional_currency,asOf,basis:'functional balances per book at the cutoff, translated at the approved closing rate where the policy says so; each source book counted once; no eliminations or consolidation',books,combined,excluded,blocked};
 return {...body,checksum:contentHash(body)};
}
