// P09-02 multi-currency and separate books domain against real PostgreSQL
// through the runtime role: P09-T01 AC-10 and a partial settlement leave
// exact remaining foreign and functional balances with the final allocation
// absorbing rounding; P09-T02 the same revaluation posts one effect and a new
// rate set adjusts through a linked run; P09-T03 an unavailable rate, an
// inverted pair and unauthorized book access are refused; P09-T04 a reversal
// keeps the original rate and amounts; P09-T05 partitions reconcile on their
// own and the combined view counts each once. Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales,purchasing,fx} from '../packages/domain/src/index.mjs';
const {MemoryEvidenceStore,FixtureScanner}=evidence;
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
process.env.FIELD_ENCRYPTION_KEY??=randomBytes(32).toString('hex');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
async function rejects(promise,code,label){try{await promise;}catch(e){assert.ok(e instanceof DomainError,label+': not a DomainError: '+e.stack);assert.equal(e.code,code,label+': '+e.message);return e;}assert.fail(label+' should fail with '+code);}
const run=(ctx,fn,db=api)=>inTransaction(db,ctx,fn);
const env={FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY};
try{
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-fx-'+suffix,name:'FX domain',mode:'demo'});
  for(const n of ['billing','clerk','accountant','treasury','tax','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['billing','clerk','accountant','treasury','tax','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds fx_rate.create/edit or the revaluation permissions; tenant roles cover the FX desk, the revaluation preparer and the approver (noted for owner review).
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.fx_desk=await role('fx_desk',['fx_rate.create','fx_rate.edit','fx_rate.read']);
  roles.fx_preparer=await role('fx_preparer',['revaluation.create','revaluation.edit','revaluation.preview','revaluation.read','fx_rate.read']);
  roles.fx_approver=await role('fx_approver',['revaluation.approve','revaluation.post','revaluation.read']);
  for(const [p,r] of [['billing','billing'],['clerk','clerk'],['accountant','accountant'],['accountant','fx_preparer'],['treasury','treasury'],['treasury','fx_desk'],['tax','tax'],['controller','controller'],['controller','fx_desk'],['controller','fx_approver'],['director','controller'],['director','fx_desk'],['director','fx_approver'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'fx-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Exporter Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const bill=await ctxFor('billing'),clerk=await ctxFor('clerk'),acc=await ctxFor('accountant'),tre=await ctxFor('treasury'),tax=await ctxFor('tax'),dir=await ctxFor('director');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing','treasury','compliance','fi_coexistence'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 await rejects(run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'fcdu',kind:'fcdu',functionalCurrency:'USD',sourceOwner:'lara'})),'FEATURE_NOT_ENABLED','separate books before the capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'multi_currency','active','p09.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 const mk=(code,name,category,extra={},bookId=book.id)=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),ar=await mk('1200','Receivables','asset',{controlType:'ar'}),ap=await mk('2100','Payables','liability',{controlType:'ap'}),outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'}),inTax=await mk('1300','Input tax','asset',{controlType:'input_tax'}),whtPay=await mk('2300','Withholding payable','liability'),adv=await mk('1400','Advances','asset'),revenue=await mk('4000','Revenue','income'),expense=await mk('5000','Services','expense'),gain=await mk('7100','Realized FX gain','income'),loss=await mk('7200','Realized FX loss','expense'),ugain=await mk('7300','Unrealized FX gain','income'),uloss=await mk('7400','Unrealized FX loss','expense');
 for(const [s,e] of [['2026-10-01','2026-10-31'],['2026-11-01','2026-11-30']])await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const approve=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await approve('sales_profile',{arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,scale:2,dueDays:30});
 await approve('purchasing_profile',{apAccountId:ap.id,inputTaxAccountId:inTax.id,cashAccountId:cash.id,withholdingPayableAccountId:whtPay.id,advanceAccountId:adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
 await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4),($1,$2,$3,'bill','BILL','numbering-2026',$4)",[tenantId,entityId,branch.id,principals.controller]));
 const customer=await run(bill,tx=>parties.createParty(tx,bill,entityId,{legalName:'Overseas Buyer',roles:['customer'],identityStatus:'unknown',address:'Singapore'},env));
 const supplier=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Foreign Vendor',roles:['supplier'],identityStatus:'unknown',address:'Hong Kong'},env));
 const store=new MemoryEvidenceStore();
 const upload=async(name,content,who=tax)=>{const bytes=Buffer.from(content);const reg=await run(who,tx=>evidence.registerUpload(tx,who,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(who,tx=>evidence.completeUpload(tx,who,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const bsp=await upload('bsp-rates.pdf','%PDF-1.4 BSP reference rates\n');
 const zero=await run(tax,tx=>sales.createTaxRule(tx,tax,entityId,{code:'ZERO',taxType:'vat',validFrom:'2026-01-01',rate:'0',basis:'net',recognition:'issue',rounding:'line_half_up',applicabilityProfileId:randomUUID(),sourceEvidenceIds:[bsp],goldenCaseIds:['AC-10']}));
 await run(ctrl,tx=>sales.approveTaxRule(tx,ctrl,entityId,zero.id,{decision:'approve',contentVersion:1}));await run(ctrl,tx=>sales.activateTaxRule(tx,ctrl,entityId,zero.id,{reason:'Zero-rated exports'}));
 const entryLines=async id=>(await run(acc,tx=>tx.query('select a.code,l.txn_debit::text as td,l.txn_credit::text as tc,l.func_debit::text as fd,l.func_credit::text as fc,e.fx_rate::text as rate,e.transaction_currency as cur from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.entry_id=$2 order by l.line_no',[tenantId,id]))).rows.map(r=>[r.code,ledger.decimal(ledger.micros(r.td)),ledger.decimal(ledger.micros(r.tc)),ledger.decimal(ledger.micros(r.fd)),ledger.decimal(ledger.micros(r.fc))]);
 const funcBalance=async accountId=>ledger.decimal(ledger.signedMicros((await run(acc,tx=>tx.query('select coalesce(sum(func_debit-func_credit),0)::text as b from lara.journal_lines where tenant_id=$1 and account_id=$2',[tenantId,accountId]))).rows[0].b));
 pass('fixture: exporter with PHP primary book, control and FX accounts, zero-rated rule, customer and supplier, multi_currency active');

 // FX profile and rates: conventions and the inverted-pair guard (P09-T03).
 await approve('fx_profile',{realizedGainAccountId:gain.id,realizedLossAccountId:loss.id,unrealizedGainAccountId:ugain.id,unrealizedLossAccountId:uloss.id,monetaryAccountIds:[ar.id,ap.id],profileVersion:'fx-2026'});
 await rejects(run(tre,tx=>fx.createFxRate(tx,tre,entityId,{baseCurrency:'PHP',quoteCurrency:'USD',rateDate:'2026-10-05',rate:'56',sourceEvidenceId:bsp})),'VALIDATION_FAILED','quote in a foreign currency (inverted pair)');
 await rejects(run(tre,tx=>fx.createFxRate(tx,tre,entityId,{baseCurrency:'USD',quoteCurrency:'USD',rateDate:'2026-10-05',rate:'1',sourceEvidenceId:bsp})),'VALIDATION_FAILED','same currency');
 const rate=async(date,value,who=tre)=>{const r=await run(who,tx=>fx.createFxRate(tx,who,entityId,{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:date,rate:value,sourceEvidenceId:bsp}));await run(ctrl,tx=>fx.approveFxRate(tx,ctrl,entityId,r.id,{decision:'approve',contentVersion:1}));return r;};
 const r56=await rate('2026-10-05','56');
 await rejects(run(tre,tx=>fx.approveFxRate(tx,tre,entityId,r56.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','treasury approving rates');
 const draft=await run(tre,tx=>fx.createFxRate(tx,tre,entityId,{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:'2026-10-06',rate:'56.5',sourceEvidenceId:bsp}));
 await rejects(run(tre,tx=>fx.approveFxRate(tx,tre,entityId,draft.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','author approving (no permission)');
 const drafted=await run(ctrl,tx=>fx.createFxRate(tx,ctrl,entityId,{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:'2026-10-07',rate:'56.6',sourceEvidenceId:bsp}));
 await rejects(run(ctrl,tx=>fx.approveFxRate(tx,ctrl,entityId,drafted.id,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','author approving');
 await rejects(run(tre,tx=>fx.createFxRate(tx,tre,entityId,{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:'2026-10-08',rate:'0.0178',sourceEvidenceId:bsp})),'VALIDATION_FAILED','inverted value against the recent approved rate');
 await rejects(run(tre,tx=>fx.updateFxRate(tx,tre,entityId,r56.id,r56.version+1,{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:'2026-10-05',rate:'57',sourceEvidenceId:bsp})),'STATE_CONFLICT','editing an approved rate');
 assert.equal((await run(tre,tx=>fx.listFxRates(tx,tre,entityId,{}))).items.length,3);
 pass('P09-T03: rates are quoted in the functional currency per unit of the foreign currency (an inverted pair is refused), a value inverted against the recent approved rate is refused, approval is independent and approved rates are immutable');

 // P09-T01 / AC-10: a USD invoice posts both amounts at 56; a receipt at 57 realizes the gain.
 const line=(accountId,unitPrice)=>({description:'Export services',quantity:'1',unitPrice,discount:'0',priceBasis:'exclusive',accountId,taxCodeId:zero.id,dimensions:{}});
 const issue=async(price,date)=>{const d=await run(bill,tx=>sales.createDocument(tx,bill,entityId,{kind:'invoice',branchId:branch.id,bookId:book.id,partyId:customer.id,documentDate:date,accountingDate:date,currency:'USD',ruleProfileVersion:'ph-2026',lines:[line(revenue.id,price)],evidenceIds:[]}));await run(bill,tx=>sales.submitDocument(tx,bill,entityId,d.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,d.id,{decision:'approve',contentVersion:1}));return {id:d.id,posted:await run(acc,tx=>sales.postDocument(tx,acc,entityId,d.id,{}))};};
 const noRate=await run(bill,tx=>sales.createDocument(tx,bill,entityId,{kind:'invoice',branchId:branch.id,bookId:book.id,partyId:customer.id,documentDate:'2026-10-09',accountingDate:'2026-10-09',currency:'USD',ruleProfileVersion:'ph-2026',lines:[line(revenue.id,'10')],evidenceIds:[]}));
 await run(bill,tx=>sales.submitDocument(tx,bill,entityId,noRate.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,noRate.id,{decision:'approve',contentVersion:1}));
 const e=await rejects(run(acc,tx=>sales.postDocument(tx,acc,entityId,noRate.id,{})),'STATE_CONFLICT','posting without an approved rate');
 assert.match(e.message,/never default to 1/);
 const inv=await issue('100','2026-10-05');
 assert.deepEqual(await entryLines(inv.posted.journalEntryIds[0]),[['1200','100.00','0.00','5600.00','0.00'],['4000','0.00','100.00','0.00','5600.00']]);
 const items=await run(bill,tx=>sales.listOpenItems(tx,bill,entityId,{partyId:customer.id,open:'true'}));
 const item=items.items.find(i=>i.documentId===inv.id);
 let layers=await run(bill,tx=>fx.listLayers(tx,bill,entityId,{openItemId:item.id}));
 assert.deepEqual([layers.items.length,layers.items[0].event,layers.items[0].txnRemaining,layers.items[0].funcCarrying],[1,'open','100.00','5600.00']);
 await rate('2026-10-10','57');
 const receipt=async(gross,date,allocations)=>{const rc=await run(bill,tx=>sales.createCollection(tx,bill,entityId,{direction:'receipt',partyId:customer.id,currency:'USD',valueDate:date,grossAmount:gross,cashAmount:gross,withholdingAmount:'0.00',method:'transfer',allocations,evidenceIds:[]}));await run(bill,tx=>sales.submitCollection(tx,bill,entityId,rc.id,{}));await run(acc,tx=>sales.approveCollection(tx,acc,entityId,rc.id,{decision:'approve',contentVersion:1}));return {id:rc.id,posted:await run(acc,tx=>sales.postCollection(tx,acc,entityId,rc.id,{}))};};
 const partial=await receipt('40.00','2026-10-10',[{openItemId:item.id,amount:'40.00'}]);
 assert.equal(partial.posted.journalEntryIds.length,2,'transaction entry plus the realized FX adjustment');
 assert.deepEqual(await entryLines(partial.posted.journalEntryIds[0]),[['1010','40.00','0.00','2280.00','0.00'],['1200','0.00','40.00','0.00','2280.00']]);
 assert.deepEqual(await entryLines(partial.posted.journalEntryIds[1]),[['1200','40.00','0.00','40.00','0.00'],['7100','0.00','40.00','0.00','40.00']]);
 layers=await run(bill,tx=>fx.listLayers(tx,bill,entityId,{openItemId:item.id}));
 assert.deepEqual([layers.items[1].event,layers.items[1].funcConsumed,layers.items[1].realizedFx,layers.items[1].txnRemaining,layers.items[1].funcCarrying],['settle','2240.00','40.00','60.00','3360.00']);
 assert.deepEqual([await funcBalance(ar.id),await funcBalance(gain.id)],['3360.00','-40.00'],'AR carrying 3,360 after the partial settlement; gain 40');
 // P09-T04: the reversal keeps 57 and the original amounts (no rate exists for the reversal date).
 const reversed=await run(acc,tx=>sales.reverseCollection(tx,acc,entityId,partial.id,{accountingDate:'2026-10-12',reason:'Bounced remittance'}));
 assert.deepEqual(await entryLines(reversed.journalEntryIds[0]),[['1010','0.00','40.00','0.00','2280.00'],['1200','40.00','0.00','2280.00','0.00']]);
 const revEntry=(await run(acc,tx=>tx.query('select fx_rate::text as r from lara.journal_entries where tenant_id=$1 and id=$2',[tenantId,reversed.journalEntryIds[0]]))).rows[0];
 assert.equal(Number(revEntry.r),57,'reversal at the original rate');
 assert.deepEqual([await funcBalance(ar.id),await funcBalance(gain.id)],['5600.00','0.00'],'reversal restores carrying and unwinds the gain');
 layers=await run(bill,tx=>fx.listLayers(tx,bill,entityId,{openItemId:item.id}));
 assert.deepEqual([layers.items[2].event,layers.items[2].txnRemaining,layers.items[2].funcCarrying],['reverse','100.00','5600.00']);
 pass('P09-T04: a reversed foreign-currency receipt reverses at the original 57 with the original functional amounts and unwinds its realized FX; the layer returns to 100 / 5,600');
 // AC-10 exactly: USD 100 at 57 against the 5,600 carrying: Bank 5,700 / AR 5,600 / FX gain 100.
 await rate('2026-10-15','57');
 const full=await receipt('100.00','2026-10-15',[{openItemId:item.id,amount:'100.00'}]);
 assert.deepEqual(await entryLines(full.posted.journalEntryIds[0]),[['1010','100.00','0.00','5700.00','0.00'],['1200','0.00','100.00','0.00','5700.00']]);
 assert.deepEqual(await entryLines(full.posted.journalEntryIds[1]),[['1200','100.00','0.00','100.00','0.00'],['7100','0.00','100.00','0.00','100.00']]);
 assert.deepEqual([await funcBalance(cash.id),await funcBalance(ar.id),await funcBalance(gain.id)],['5700.00','0.00','-100.00'],'AC-10: Bank 5,700 / AR 5,600 / FXGain 100 in total');
 layers=await run(bill,tx=>fx.listLayers(tx,bill,entityId,{openItemId:item.id}));
 assert.deepEqual([layers.items.at(-1).txnRemaining,layers.items.at(-1).funcCarrying],['0.00','0.00'],'the final allocation absorbs the carrying value exactly');
 // Rounding: an invoice of USD 33.33 at 56 (1,866.48) settled in three parts of 11.11 at 57 leaves exact zero.
 const inv2=await issue('33.33','2026-10-05');
 const item2=(await run(bill,tx=>sales.listOpenItems(tx,bill,entityId,{partyId:customer.id,open:'true'}))).items.find(i=>i.documentId===inv2.id);
 for(let i=0;i<3;i++)await receipt('11.11','2026-10-15',[{openItemId:item2.id,amount:'11.11'}]);
 layers=await run(bill,tx=>fx.listLayers(tx,bill,entityId,{openItemId:item2.id}));
 assert.deepEqual([layers.items.at(-1).txnRemaining,layers.items.at(-1).funcCarrying,layers.items.slice(1).map(l=>l.funcConsumed)],['0.00','0.00',['622.16','622.16','622.16']]);
 assert.ok(!(await run(bill,tx=>sales.listOpenItems(tx,bill,entityId,{partyId:customer.id,open:'true'}))).items.some(i=>i.id===item2.id),'the item is cleared');
 pass('P09-T01 / AC-10: a USD 100 invoice at 56 posts AR 5,600; a partial receipt of 40 at 57 consumes 2,240 of carrying with a 40 gain and leaves 60 / 3,360; the full receipt at 57 gives Bank 5,700 / AR 5,600 / FX gain 100; three-way rounding settles to exact zero');

 // Bills in USD and the AP layer; revaluation (P09-T02).
 const billDoc=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,{kind:'bill',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:'2026-10-15',accountingDate:'2026-10-15',currency:'USD',ruleProfileVersion:'ph-2026',externalReference:'FV-1',lines:[{description:'Licence',quantity:'1',unitPrice:'200',discount:'0',priceBasis:'exclusive',accountId:expense.id,taxCodeId:zero.id,dimensions:{}}],evidenceIds:[bsp]}));
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,billDoc.id,{}));await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,billDoc.id,{decision:'approve',contentVersion:1}));
 const billPosted=await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,billDoc.id,{}));
 assert.deepEqual(await entryLines(billPosted.journalEntryIds[0]),[['5000','200.00','0.00','11400.00','0.00'],['2100','0.00','200.00','0.00','11400.00']]);
 const apItem=(await run(clerk,tx=>sales.listOpenItems(tx,clerk,entityId,{partyId:supplier.id,side:'AP',open:'true'}))).items[0];
 assert.deepEqual((await run(clerk,tx=>fx.listLayers(tx,clerk,entityId,{openItemId:apItem.id}))).items.map(l=>[l.event,l.txnRemaining,l.funcCarrying]),[['open','200.00','11400.00']]);
 const closing=await rate('2026-10-31','58');
 const periods=(await run(ctrl,tx=>ledger.listPeriods(tx,ctrl,entityId,{bookId:book.id}))).items;
 const oct=periods.find(p=>p.startsOn==='2026-10-01');
 await rejects(run(acc,tx=>fx.createRevaluation(tx,acc,entityId,{bookId:book.id,periodId:oct.id,rateSetId:closing.id,accountIds:[ap.id,cash.id],reverseNextPeriod:false})),'VALIDATION_FAILED','revaluing an account not classified monetary');
 await rejects(run(acc,tx=>fx.createRevaluation(tx,acc,entityId,{bookId:book.id,periodId:oct.id,rateSetId:r56.id,accountIds:[ap.id],reverseNextPeriod:false})),'VALIDATION_FAILED','a rate that is not the period-end closing rate');
 const run1=await run(acc,tx=>fx.createRevaluation(tx,acc,entityId,{bookId:book.id,periodId:oct.id,rateSetId:closing.id,accountIds:[ap.id,ar.id],reverseNextPeriod:false}));
 await rejects(run(ctrl,tx=>fx.approveRevaluation(tx,ctrl,entityId,run1.id,{decision:'approve',contentVersion:1})),'STATE_CONFLICT','approval before preview');
 const p1=await run(acc,tx=>fx.previewRevaluation(tx,acc,entityId,run1.id,{}));
 const apLine=p1.preview.lines.find(l=>l.accountId===ap.id),arLine=p1.preview.lines.find(l=>l.accountId===ar.id);
 assert.deepEqual([apLine.txnBalance,apLine.carrying,apLine.revalued,apLine.difference,arLine.txnBalance,arLine.carrying,arLine.difference,p1.preview.adjustsRunId],['-200.00','-11400.00','-11600.00','-200.00','0.00','0.00','0.00',null]);
 await rejects(run(acc,tx=>fx.approveRevaluation(tx,acc,entityId,run1.id,{decision:'approve',contentVersion:2})),'FORBIDDEN','preparer approving');
 await run(ctrl,tx=>fx.approveRevaluation(tx,ctrl,entityId,run1.id,{decision:'approve',contentVersion:2}));
 const posted1=await run(ctrl,tx=>fx.postRevaluation(tx,ctrl,entityId,run1.id,{}));
 assert.deepEqual(await entryLines(posted1.journalEntryIds[0]),[['2100','0.00','200.00','0.00','200.00'],['7400','200.00','0.00','200.00','0.00']]);
 const again=await run(ctrl,tx=>fx.postRevaluation(tx,ctrl,entityId,run1.id,{}));
 assert.deepEqual(again.journalEntryIds,posted1.journalEntryIds,'posting twice has one effect');
 assert.equal((await run(acc,tx=>tx.query("select count(*)::int n from lara.journal_entries where tenant_id=$1 and source_type='revaluation'",[tenantId]))).rows[0].n,1);
 await rejects(run(acc,tx=>fx.createRevaluation(tx,acc,entityId,{bookId:book.id,periodId:oct.id,rateSetId:closing.id,accountIds:[ap.id],reverseNextPeriod:false})),'STATE_CONFLICT','a second run for the same rate set');
 // A new closing rate set (59) adjusts the earlier run through a link: only the delta posts, reversed next period.
 const r59=await run(dir,tx=>fx.createFxRate(tx,dir,entityId,{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:'2026-10-31',rate:'59',sourceEvidenceId:bsp}));
 await rejects(run(ctrl,tx=>fx.approveFxRate(tx,ctrl,entityId,r59.id,{decision:'approve',contentVersion:1})),'STATE_CONFLICT','two approved rates for one date');
 await run(ctrl,tx=>tx.query("update lara.fx_rates set status='rejected' where tenant_id=$1 and id=$2",[tenantId,r59.id]));
 const nov=periods.find(p=>p.startsOn==='2026-11-01');
 const r58b=await run(dir,tx=>fx.createFxRate(tx,dir,entityId,{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:'2026-11-30',rate:'59',sourceEvidenceId:bsp}));
 await run(ctrl,tx=>fx.approveFxRate(tx,ctrl,entityId,r58b.id,{decision:'approve',contentVersion:1}));
 await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-12-01',endsOn:'2026-12-31'}));
 const run2=await run(acc,tx=>fx.createRevaluation(tx,acc,entityId,{bookId:book.id,periodId:nov.id,rateSetId:r58b.id,accountIds:[ap.id],reverseNextPeriod:true}));
 const p2=await run(acc,tx=>fx.previewRevaluation(tx,acc,entityId,run2.id,{}));
 assert.deepEqual([p2.preview.lines[0].carrying,p2.preview.lines[0].revalued,p2.preview.lines[0].difference],['-11600.00','-11800.00','-200.00'],'the carrying value includes the earlier run; only the delta posts');
 await run(ctrl,tx=>fx.approveRevaluation(tx,ctrl,entityId,run2.id,{decision:'approve',contentVersion:2}));
 const posted2=await run(ctrl,tx=>fx.postRevaluation(tx,ctrl,entityId,run2.id,{}));
 assert.equal(posted2.journalEntryIds.length,2,'adjustment and its next-period reversal');
 const rev2=(await run(acc,tx=>tx.query('select accounting_date::text as d,reversal_of from lara.journal_entries where tenant_id=$1 and id=$2',[tenantId,posted2.journalEntryIds[1]]))).rows[0];
 assert.deepEqual([rev2.d,rev2.reversal_of],['2026-12-01',posted2.journalEntryIds[0]]);
 pass('P09-T02: revaluation of classified monetary accounts at the period-end closing rate previews the difference from the carrying value, posts once (a retry has one effect), refuses a second run for the same rate set, and a later rate set adjusts through a linked run posting only the delta with its next-period reversal');

 // Payment in USD at 58: AP carrying 11,400 (bill at 56) less the revaluation (11,600 after run1, 11,800 after run2) versus cash 11,600 → the layer knows only the document carrying; realized FX = carrying consumed 11,400 − cash 11,600 = loss 200.
 const proposal=await run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,{direction:'payment',partyId:supplier.id,currency:'USD',valueDate:'2026-10-31',grossAmount:'200.00',cashAmount:'200.00',withholdingAmount:'0.00',method:'transfer',allocations:[{openItemId:apItem.id,amount:'200.00'}],evidenceIds:[]}));
 const ben=await run(tre,tx=>purchasing.createBeneficiary(tx,tre,entityId,{partyId:supplier.id,bankName:'HSBC',accountName:'Foreign Vendor',accountNumber:'9988 7766 5544'},env));
 await run(ctrl,tx=>purchasing.approveBeneficiary(tx,ctrl,entityId,ben.id));
 const order=await run(tre,tx=>purchasing.createPayment(tx,tre,entityId,{settlementId:proposal.id,beneficiaryVersionId:ben.id,scheduledDate:'2026-10-31'}));
 await run(tre,tx=>purchasing.submitSettlement(tx,tre,entityId,proposal.id,{}));
 await run(tre,tx=>purchasing.submitPayment(tx,tre,entityId,order.id,{}));
 await run(ctrl,tx=>purchasing.authorizePayment(tx,ctrl,entityId,order.id,{decision:'approve',contentVersion:1}));
 await run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order.id,{channel:'manual',externalReference:'WIRE-1',evidenceIds:[bsp]}));
 const settled=await run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,order.id,{externalReference:'WIRE-1',settledAt:'2026-10-31T02:00:00Z',valueDate:'2026-10-31',evidenceIds:[bsp]}));
 assert.deepEqual(await entryLines(settled.journalEntryIds[0]),[['2100','200.00','0.00','11600.00','0.00'],['1010','0.00','200.00','0.00','11600.00']]);
 assert.deepEqual(await entryLines(settled.journalEntryIds[1]),[['7200','200.00','0.00','200.00','0.00'],['2100','0.00','200.00','0.00','200.00']]);
 assert.deepEqual((await run(clerk,tx=>fx.listLayers(tx,clerk,entityId,{openItemId:apItem.id}))).items.at(-1).txnRemaining,'0.00');
 pass('a USD payment at 58 settles the bill carried at 56: AP 11,600 / Cash 11,600 in the transaction entry and a realized loss of 200 as the functional adjustment; the AP layer clears');

 // P09-T05: partitions and the combined view; unauthorized access refused (P09-T03).
 const fcdu=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'fcdu',kind:'fcdu',functionalCurrency:'USD',sourceOwner:'lara'}));
 assert.equal(fcdu.state,'draft');
 await rejects(run(ctrl,tx=>ledger.activateBook(tx,ctrl,entityId,fcdu.id,{reason:'go'})),'SELF_APPROVAL','creator activating the book');
 await run(dir,tx=>ledger.activateBook(tx,dir,entityId,fcdu.id,{reason:'FCDU licence on file'}));
 const trust=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'trust',kind:'trust',functionalCurrency:'PHP',sourceOwner:'trust-system'}));
 await run(dir,tx=>ledger.activateBook(tx,dir,entityId,trust.id,{reason:'Trust licence'}));
 const view=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'mgmt',kind:'management',functionalCurrency:'PHP',sourceOwner:'lara'}));
 await run(dir,tx=>ledger.activateBook(tx,dir,entityId,view.id,{reason:'Management view'}));
 await run(ctrl,tx=>fx.grantBookAccess(tx,ctrl,entityId,{bookId:fcdu.id,principalId:principals.treasury,access:'post'}));
 await rejects(run(ctrl,tx=>fx.grantBookAccess(tx,ctrl,entityId,{bookId:fcdu.id,principalId:principals.controller,access:'post'})),'SELF_APPROVAL','granting oneself');
 await run(dir,tx=>fx.grantBookAccess(tx,dir,entityId,{bookId:fcdu.id,principalId:principals.controller,access:'read'}));
 const fcduCash=await run(tre,tx=>tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,'1010','USD cash','asset','debit','none',true,$4,$5) returning id",[tenantId,entityId,fcdu.id,sha('fc'),principals.treasury])).then(r=>r.rows[0].id);
 const fcduDep=await run(tre,tx=>tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,'2100','USD deposits','liability','credit','none',true,$4,$5) returning id",[tenantId,entityId,fcdu.id,sha('fd'),principals.treasury])).then(r=>r.rows[0].id);
 await run(ctrl,tx=>tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4)",[tenantId,entityId,fcdu.id,principals.controller]));
 const jbody={bookId:fcdu.id,accountingDate:'2026-10-20',documentDate:'2026-10-20',currency:'USD',description:'USD deposit received',lines:[{accountId:fcduCash,branchId:branch.id,debit:'1000.00',credit:'0',dimensions:{}},{accountId:fcduDep,branchId:branch.id,debit:'0',credit:'1000.00',dimensions:{}}],evidenceIds:[]};
 await rejects(run(acc,tx=>ledger.createJournal(tx,acc,entityId,jbody)),'FORBIDDEN','accountant without FCDU access');
 await rejects(run(acc,tx=>ledger.trialBalance(tx,acc,entityId,{bookId:fcdu.id,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:new Date().toISOString()})),'FORBIDDEN','reading a closed partition');
 const treRole=(await run(ctrl,tx=>tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'fcdu_poster','FCDU poster','[\"journal.prepare\",\"journal.submit\",\"journal.post\",\"journal.read\",\"book.read\",\"account.read\",\"report.generate\"]','approved',$2,$3) returning id",[tenantId,sha('fp'),principals.security]))).rows[0].id;
 await run(ctrl,tx=>tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals.treasury,treRole,principals.security]));
 const tre2=await ctxFor('treasury');
 const j=await run(tre2,tx=>ledger.createJournal(tx,tre2,entityId,jbody));
 await run(tre2,tx=>ledger.submitJournal(tx,tre2,entityId,j.id,{}));
 await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,j.id,{decision:'approve',contentVersion:1}));
 await rejects(run(ctrl,tx=>ledger.postJournal(tx,ctrl,entityId,j.id,{})),'FORBIDDEN','posting into the partition without access');
 const jp=await run(tre2,tx=>ledger.postJournal(tx,tre2,entityId,j.id,{}));
 assert.deepEqual(await entryLines(jp.journalEntryIds[0]),[['1010','1000.00','0.00','1000.00','0.00'],['2100','0.00','1000.00','0.00','1000.00']],'a USD book posts USD as its functional currency');
 await rejects(run(tre2,tx=>ledger.createJournal(tx,tre2,entityId,{...jbody,bookId:view.id,lines:jbody.lines})),'STATE_CONFLICT','a management view never posts');
 await run(ctrl,tx=>fx.linkBook(tx,ctrl,entityId,{sourceBookId:book.id,targetViewId:view.id,translationPolicy:'as_is'}));
 await run(ctrl,tx=>fx.linkBook(tx,ctrl,entityId,{sourceBookId:fcdu.id,targetViewId:view.id,translationPolicy:'closing_rate'}));
 await run(ctrl,tx=>fx.linkBook(tx,ctrl,entityId,{sourceBookId:trust.id,targetViewId:view.id,translationPolicy:'exclude'}));
 const missing=await run(ctrl,tx=>fx.combinedView(tx,ctrl,entityId,{viewBookId:view.id,asOf:'2026-10-20'}));
 assert.deepEqual([missing.books.map(b=>b.code),missing.blocked.map(b=>b.code),missing.excluded.map(e=>e.code)],[['PHP-MAIN'],['FCDU'],['TRUST']],'a missing closing rate blocks the translated book instead of defaulting');
 const combined=await run(ctrl,tx=>fx.combinedView(tx,ctrl,entityId,{viewBookId:view.id,asOf:'2026-10-31'}));
 const fcduPart=combined.books.find(b=>b.code==='FCDU');
 assert.deepEqual([fcduPart.rate,fcduPart.accounts.find(a=>a.code==='1010').translated,combined.combined.find(a=>a.code==='1010').balance,combined.excluded.length],['58','58000.00',ledger.decimal(ledger.signedMicros(await funcBalance(cash.id))+58000n*1000000n),1]);
 const treView=await run(tre2,tx=>ledger.trialBalance(tx,tre2,entityId,{bookId:fcdu.id,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:new Date().toISOString()}));
 assert.equal(treView.lines.find(l=>l.code==='1010').balance,'1000.00','the partition reconciles on its own in its currency');
 pass('P09-T05 / P09-T03: an FCDU book in USD and a trust book activate independently, access grants close a partition to everyone else (drafting, reading and posting refused), the partition reconciles in its own currency, and the management view combines PHP as is and FCDU at the approved closing rate, excludes the trust book, blocks on a missing rate and counts each book once');
 console.log('P09-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
