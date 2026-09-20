// P05-02 purchasing domain against real PostgreSQL through the runtime role:
// P05-T01 AC-03/04 bill posting with expense, input tax, payable and accrued
// withholding, supplier credit, payment that does not repeat tax;
// P05-T02 payment-time withholding recognized once at settlement;
// P05-T03 normalized supplier reference duplicates and the reviewer's
// disposition; P05-T04 beneficiary change withdrawing payment authority and
// one effect for repeated settlement; P05-T05 partial advance liquidation and
// return; plus purchase orders with receipt of service and two-way match,
// and withholding certificates derived from tax events. Test tenants are
// removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales,purchasing} from '../packages/domain/src/index.mjs';
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
 // Provision: clerk (bills, claims), purchaser (orders), accountant (approve/post/correct bills and claims), treasury (settlements, payments, collections), tax (rules, certificates), controller and director (settings, order approval, payment authority), security.
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-purch-'+suffix,name:'Purchasing domain',mode:'demo'});
  for(const n of ['clerk','purchaser','accountant','treasury','tax','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['clerk','accountant','treasury','tax','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds purchase_order.create/edit/submit/cancel; a tenant role covers it (noted for owner review).
  roles.purchaser=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'purchaser','Purchaser','[\"purchase_order.create\",\"purchase_order.edit\",\"purchase_order.read\",\"purchase_order.submit\",\"purchase_order.cancel\",\"bill.read\",\"party.read\"]','approved',$2,$3) returning id",[tenantId,sha('purchaser'),principals.security])).rows[0].id;
  for(const [p,r] of [['clerk','clerk'],['purchaser','purchaser'],['accountant','accountant'],['treasury','treasury'],['tax','tax'],['controller','controller'],['director','controller'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'purch-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Purchasing Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const clerk=await ctxFor('clerk'),buyer=await ctxFor('purchaser'),acc=await ctxFor('accountant'),tre=await ctxFor('treasury'),tax=await ctxFor('tax'),dir=await ctxFor('director');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger','sales'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),advances=await mk('1400','Employee advances','asset'),inputTax=await mk('1300','Input tax','asset',{controlType:'input_tax'}),ap=await mk('2100','Payables','liability',{controlType:'ap'}),whtPayable=await mk('2300','Withholding payable','liability'),expense=await mk('5000','Professional fees','expense'),expense2=await mk('5100','Utilities','expense'),revenue=await mk('4000','Revenue','income');
 for(const [s,e] of [['2026-09-01','2026-09-30'],['2026-10-01','2026-10-31']])await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const supplier=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Supplies Inc',roles:['supplier'],identityStatus:'unknown',address:'Cebu'},env));
 const utility=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Power Corp',roles:['supplier'],identityStatus:'unknown',address:'Manila'},env));
 const employee=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Juan Dela Cruz',roles:['employee'],identityStatus:'unknown',address:'Pasig'},env));
 const customer=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Acme Trading',roles:['customer'],identityStatus:'unknown',address:'Cebu'},env));
 const line=(accountId,unitPrice,extra={})=>({description:'Services',quantity:'1',unitPrice,discount:'0',priceBasis:'exclusive',accountId,dimensions:{},...extra});
 const doc=(kind,partyId,lines,extra={})=>({kind,branchId:branch.id,bookId:book.id,partyId,documentDate:'2026-09-18',accountingDate:'2026-09-18',currency:'PHP',ruleProfileVersion:'ph-2026',lines,evidenceIds:[],...extra});
 const billBody=(lines,extra={})=>doc('bill',supplier.id,lines,{externalReference:'SI-0001',...extra});
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'100')]))),'FEATURE_NOT_ENABLED','bills before the purchasing capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'purchasing','active','p05.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'100')]))),'RULE_PROFILE_NOT_APPROVED','bills before an approved purchasing profile');
 const profileBody={apAccountId:ap.id,inputTaxAccountId:inputTax.id,cashAccountId:cash.id,withholdingPayableAccountId:whtPayable.id,advanceAccountId:advances.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:true,nonPoAccountIds:[expense2.id],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{[supplier.id]:'EWT2'}};
 const approveProfile=async payload=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,'purchasing_profile',payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await approveProfile(profileBody);
 // Sales profile for the advance return receipt (collections need it); series for bills.
 const sp=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,'sales_profile',{arAccountId:ap.id,outputTaxAccountId:whtPayable.id,cashAccountId:cash.id,scale:2,dueDays:30}));
 await run(dir,tx=>organization.approveSettings(tx,dir,entityId,sp.id,{payloadHash:sp.payloadHash}));
 await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'bill','BILL','numbering-2026',$4)",[tenantId,entityId,branch.id,principals.controller]));
 pass('purchasing work requires the purchasing capability and an approved purchasing profile (control accounts, withholding timing, PO and receipt policy, supplier withholding codes)');

 // Tax rules: input VAT 12% (accrual) and expanded withholding 2%.
 const store=new MemoryEvidenceStore();
 const upload=async(name,content)=>{const bytes=Buffer.from(content);const reg=await run(clerk,tx=>evidence.registerUpload(tx,clerk,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(clerk,tx=>evidence.completeUpload(tx,clerk,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const circular=await upload('rr-2-98.pdf','%PDF-1.4 withholding circular\n');
 const ruleBody=(code,rate,extra={})=>({code,taxType:'vat',validFrom:'2026-01-01',rate,basis:'net',recognition:'accrual',rounding:'line_half_up',applicabilityProfileId:randomUUID(),sourceEvidenceIds:[circular],goldenCaseIds:['AC-03'],...extra});
 const activate=async body=>{const r=await run(tax,tx=>sales.createTaxRule(tx,tax,entityId,body));await run(ctrl,tx=>sales.approveTaxRule(tx,ctrl,entityId,r.id,{decision:'approve',contentVersion:1}));await run(ctrl,tx=>sales.activateTaxRule(tx,ctrl,entityId,r.id,{reason:'Effective 2026'}));return r;};
 const vat=await activate(ruleBody('VAT12','0.12'));
 const ewt=await activate(ruleBody('EWT2','0.02',{taxType:'withholding'}));
 pass('input VAT and expanded withholding rule versions are approved and activated by another principal');

 // P05-T01 AC-03/04: bill 10,000 + 1,200 VAT, 2% withholding accrued: Dr expense, Dr input tax, Cr AP 11,000, Cr withholding payable 200.
 const billEvidence=await upload('si-0001.pdf','%PDF-1.4 supplier invoice\n');
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(revenue.id,'100')]))),'VALIDATION_FAILED','bill line on a revenue account');
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'100')],{partyId:customer.id}))),'VALIDATION_FAILED','customer as supplier');
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'100')],{externalReference:undefined}))),'VALIDATION_FAILED','bill without the supplier reference');
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'100')],{kind:'invoice'}))),'FEATURE_NOT_ENABLED','sales kinds under purchasing');
 const bill=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'10000',{taxCodeId:vat.id})],{evidenceIds:[billEvidence]})));
 assert.deepEqual([bill.net,bill.tax,bill.gross,bill.state,bill.settlementState],['10000.00','1200.00','11200.00','draft','unpaid']);
 assert.equal((await run(acc,tx=>tx.query('select withholding::text as w,supplier_reference_normalized as n from lara.documents where tenant_id=$1 and id=$2',[tenantId,bill.id]))).rows.map(r=>r.w+'|'+r.n)[0],'200.000000|si0001');
 await rejects(run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,bill.id,{},bill.version+1)),'VERSION_CONFLICT','submit with a stale version');
 const noEvidence=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'10')],{externalReference:'SI-NOEV'})));
 await rejects(run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,noEvidence.id,{})),'EVIDENCE_NOT_READY','bill submitted without evidence');
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,bill.id,{}));
 await rejects(run(clerk,tx=>purchasing.approveDocument(tx,clerk,entityId,bill.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','clerk cannot approve bills');
 await rejects(run(acc,tx=>purchasing.postDocument(tx,acc,entityId,bill.id,{})),'STATE_CONFLICT','post before approval');
 await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,bill.id,{decision:'approve',contentVersion:1}));
 const posted=await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,bill.id,{}));
 assert.equal(posted.state,'posted');
 const entryLines=async id=>(await run(acc,tx=>tx.query('select a.code,l.txn_debit::text as debit,l.txn_credit::text as credit from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entry_id=$2 order by l.line_no',[tenantId,id]))).rows.map(r=>[r.code,ledger.decimal(ledger.micros(r.debit)),ledger.decimal(ledger.micros(r.credit))]);
 assert.deepEqual(await entryLines(posted.journalEntryIds[0]),[['5000','10000.00','0.00'],['1300','1200.00','0.00'],['2100','0.00','11000.00'],['2300','0.00','200.00']]);
 const billView=await run(clerk,tx=>purchasing.getDocument(tx,clerk,entityId,bill.id,{kinds:['bill','credit_note']}));
 assert.equal(billView.officialNumber,'BILL-000001');
 await rejects(run(clerk,tx=>sales.getDocument(tx,clerk,entityId,bill.id,{kinds:['invoice','credit_note']})),'NOT_FOUND','a bill is not an invoice');
 const items=()=>run(acc,tx=>sales.listOpenItems(tx,acc,entityId,{partyId:supplier.id,side:'AP'}));
 assert.deepEqual((await items()).items.map(i=>[i.originalAmount,i.outstandingAmount,i.dueDate]),[['11000.00','11000.00','2026-10-18']]);
 const events=async id=>(await run(acc,tx=>tx.query('select recognition,amount::text as amount,line_id is null as header from lara.tax_events where tenant_id=$1 and document_id=$2 and reversed_by is null order by created_at',[tenantId,id]))).rows.map(r=>[r.recognition,ledger.decimal(ledger.micros(r.amount)),r.header]);
 assert.deepEqual(await events(bill.id),[['accrual','1200.00',false],['accrual','200.00',true]]);
 assert.deepEqual(await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,bill.id,{})).then(r=>r.journalEntryIds),posted.journalEntryIds,'re-posting returns the same entry');
 // Supplier credit of 2,000 net against the bill: mirrored entry, withholding reduced, applied to the payable.
 await rejects(run(acc,tx=>purchasing.correctDocument(tx,acc,entityId,bill.id,{kind:'credit_note',accountingDate:'2026-09-20',reason:'Too much',lines:[line(expense.id,'10001',{taxCodeId:vat.id})]})),'STATE_CONFLICT','credit beyond the original account');
 const cn=await run(acc,tx=>purchasing.correctDocument(tx,acc,entityId,bill.id,{kind:'credit_note',accountingDate:'2026-09-20',reason:'Scope reduced',lines:[line(expense.id,'2000',{taxCodeId:vat.id})],evidenceIds:[billEvidence]}));
 const cnDoc=await run(clerk,tx=>purchasing.getDocument(tx,clerk,entityId,cn.resourceId,{kinds:['bill','credit_note']}));
 assert.deepEqual([cnDoc.kind,cnDoc.net,cnDoc.tax,cnDoc.gross,cnDoc.sourceDocumentId],['credit_note','2000.00','240.00','2240.00',bill.id]);
 assert.equal((await run(clerk,tx=>sales.listDocuments(tx,clerk,entityId,{},{kinds:['invoice','credit_note']}))).items.length,0,'supplier credits never appear under invoices');
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,cn.resourceId,{}));
 await rejects(run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,cn.resourceId,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','the accountant who raised the credit cannot approve it');
 await run(ctrl,tx=>purchasing.approveDocument(tx,ctrl,entityId,cn.resourceId,{decision:'approve',contentVersion:1}));
 const cnPosted=await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,cn.resourceId,{}));
 assert.deepEqual(await entryLines(cnPosted.journalEntryIds[0]),[['5000','0.00','2000.00'],['1300','0.00','240.00'],['2100','2200.00','0.00'],['2300','40.00','0.00']]);
 const item=(await items()).items[0];
 assert.deepEqual([item.allocatedAmount,item.outstandingAmount],['2200.00','8800.00']);
 assert.equal((await run(clerk,tx=>purchasing.getDocument(tx,clerk,entityId,bill.id,{kinds:['bill']}))).settlementState,'partial');
 pass('P05-T01 AC-03/04: a bill posts Dr expense 10,000 / Dr input tax 1,200 / Cr payables 11,000 / Cr withholding payable 200 with accrued withholding and input tax events, numbers BILL-000001, opens the 11,000 payable; a supplier credit mirrors it and applies 2,200 to the payable');

 // Payment for the remaining 8,800: proposal, beneficiary, order, independent authority, manual release with evidence, settlement posts once; no tax repeats.
 const settlementBody=(over={})=>({direction:'payment',partyId:supplier.id,currency:'PHP',valueDate:'2026-09-25',grossAmount:'8800.00',cashAmount:'8800.00',withholdingAmount:'0.00',method:'transfer',allocations:[{openItemId:item.id,amount:'8800.00'}],evidenceIds:[],...over});
 await rejects(run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,settlementBody({direction:'receipt'}))),'VALIDATION_FAILED','receipt through the payment proposal');
 await rejects(run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,settlementBody({allocations:[{openItemId:item.id,amount:'8800.01'}],grossAmount:'8800.01',cashAmount:'8800.01'}))),'ALLOCATION_EXCEEDS_BALANCE','paying beyond the outstanding');
 await rejects(run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,settlementBody({withholdingAmount:'100.00',cashAmount:'8700.00'}))),'VALIDATION_FAILED','withholding on a bill already accrued');
 await rejects(run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,settlementBody({allocations:[]}))),'VALIDATION_FAILED','supplier payment without allocations');
 const proposal=await run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,settlementBody()));
 assert.deepEqual([proposal.state,proposal.direction,proposal.allocations.length],['draft','payment',1]);
 await rejects(run(tre,tx=>sales.getCollection(tx,tre,entityId,proposal.id)),'NOT_FOUND','a payment proposal is not a collection');
 const ben=await run(tre,tx=>purchasing.createBeneficiary(tx,tre,entityId,{partyId:supplier.id,bankName:'BDO',accountName:'Supplies Inc',accountNumber:'0012 3456 7890'},env));
 assert.deepEqual([ben.state,ben.accountNumberLast4,ben.versionNumber],['draft','7890',1]);
 await rejects(run(tre,tx=>purchasing.approveBeneficiary(tx,tre,entityId,ben.id)),'FORBIDDEN','treasury cannot approve beneficiaries');
 await rejects(run(tre,tx=>purchasing.createPayment(tx,tre,entityId,{settlementId:proposal.id,beneficiaryVersionId:ben.id,scheduledDate:'2026-09-26'})),'STATE_CONFLICT','payment to an unreviewed beneficiary');
 await run(ctrl,tx=>purchasing.approveBeneficiary(tx,ctrl,entityId,ben.id));
 const order=await run(tre,tx=>purchasing.createPayment(tx,tre,entityId,{settlementId:proposal.id,beneficiaryVersionId:ben.id,scheduledDate:'2026-09-26'}));
 assert.equal(order.state,'draft');
 await rejects(run(tre,tx=>purchasing.createPayment(tx,tre,entityId,{settlementId:proposal.id,beneficiaryVersionId:ben.id,scheduledDate:'2026-09-27'})),'STATE_CONFLICT','one live payment per settlement');
 await rejects(run(tre,tx=>purchasing.submitPayment(tx,tre,entityId,order.id,{})),'STATE_CONFLICT','payment submitted before the proposal');
 await run(tre,tx=>purchasing.submitSettlement(tx,tre,entityId,proposal.id,{}));
 await run(tre,tx=>purchasing.submitPayment(tx,tre,entityId,order.id,{}));
 await rejects(run(tre,tx=>purchasing.authorizePayment(tx,tre,entityId,order.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','treasury holds no payment authority');
 await rejects(run(ctrl,tx=>purchasing.authorizePayment(tx,ctrl,entityId,order.id,{decision:'approve',contentVersion:2})),'VERSION_CONFLICT','authority binds the payment content version');
 await rejects(run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order.id,{channel:'manual',externalReference:'TXN-1',evidenceIds:[billEvidence]})),'STATE_CONFLICT','release before authority');
 await run(ctrl,tx=>purchasing.authorizePayment(tx,ctrl,entityId,order.id,{decision:'approve',contentVersion:1}));
 assert.equal((await run(tre,tx=>purchasing.getSettlement(tx,tre,entityId,proposal.id))).state,'approved');
 await rejects(run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,order.id,{externalReference:'BANK-1',settledAt:'2026-09-26T02:00:00Z',valueDate:'2026-09-26',evidenceIds:[billEvidence]})),'STATE_CONFLICT','settlement before release');
 await rejects(run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order.id,{channel:'bank_file',externalReference:'FILE-1',evidenceIds:[billEvidence]})),'FEATURE_NOT_ENABLED','bank-file release before P06');
 await rejects(run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order.id,{channel:'manual',externalReference:'TXN-1',evidenceIds:[randomUUID()]})),'EVIDENCE_NOT_READY','release without available evidence');
 const released=await run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order.id,{channel:'manual',externalReference:'TXN-1',evidenceIds:[billEvidence]}));
 assert.equal(released.state,'released');
 assert.equal((await run(acc,tx=>tx.query('select count(*)::int n from lara.journal_entries where tenant_id=$1',[tenantId]))).rows[0].n,2,'release posts nothing');
 const settleBody={externalReference:'BANK-1',settledAt:'2026-09-26T02:00:00Z',valueDate:'2026-09-26',evidenceIds:[billEvidence]};
 const settled=await run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,order.id,settleBody));
 assert.equal(settled.state,'settled');
 assert.deepEqual(await entryLines(settled.journalEntryIds[0]),[['2100','8800.00','0.00'],['1010','0.00','8800.00']]);
 assert.deepEqual(await events(bill.id),[['accrual','1200.00',false],['accrual','200.00',true]],'payment does not repeat tax');
 assert.equal((await run(clerk,tx=>purchasing.getDocument(tx,clerk,entityId,bill.id,{kinds:['bill']}))).settlementState,'paid');
 const again=await run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,order.id,settleBody));
 assert.deepEqual(again.journalEntryIds,settled.journalEntryIds,'repeated settlement yields one effect');
 assert.equal((await run(tre,tx=>purchasing.getSettlement(tx,tre,entityId,proposal.id))).state,'posted');
 pass('payment: proposal separate from the bill, reviewed beneficiary, authority independent of preparer and submitter bound to the content version, manual release with evidence posts nothing, settlement posts Dr payables 8,800 / Cr cash 8,800 once and repeats without a second effect; accrued tax is not repeated');

 // P05-T02: payment-time profile recognizes withholding once at settlement.
 await approveProfile({...profileBody,withholdingRecognition:'payment'});
 const bill2=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'5000',{taxCodeId:vat.id})],{externalReference:'SI-0002',documentDate:'2026-10-02',accountingDate:'2026-10-02',evidenceIds:[billEvidence]})));
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,bill2.id,{}));await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,bill2.id,{decision:'approve',contentVersion:1}));
 const posted2=await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,bill2.id,{}));
 assert.deepEqual(await entryLines(posted2.journalEntryIds[0]),[['5000','5000.00','0.00'],['1300','600.00','0.00'],['2100','0.00','5600.00']]);
 assert.deepEqual(await events(bill2.id),[['accrual','600.00',false]]);
 const item2=(await items()).items.find(i=>i.documentId===bill2.id);
 assert.equal(item2.outstandingAmount,'5600.00');
 await rejects(run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,settlementBody({grossAmount:'5600.00',cashAmount:'5600.00',withholdingAmount:'0.00',allocations:[{openItemId:item2.id,amount:'5600.00'}]}))),'VALIDATION_FAILED','payment-time withholding must be carried by the payment');
 const proposal2=await run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,settlementBody({valueDate:'2026-10-05',grossAmount:'5600.00',cashAmount:'5500.00',withholdingAmount:'100.00',allocations:[{openItemId:item2.id,amount:'5600.00'}]})));
 await run(tre,tx=>purchasing.submitSettlement(tx,tre,entityId,proposal2.id,{}));
 const order2=await run(tre,tx=>purchasing.createPayment(tx,tre,entityId,{settlementId:proposal2.id,beneficiaryVersionId:ben.id,scheduledDate:'2026-10-05'}));
 await run(tre,tx=>purchasing.submitPayment(tx,tre,entityId,order2.id,{}));
 await run(ctrl,tx=>purchasing.authorizePayment(tx,ctrl,entityId,order2.id,{decision:'approve',contentVersion:1}));
 await run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order2.id,{channel:'manual',externalReference:'TXN-2',evidenceIds:[billEvidence]}));
 const settled2=await run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,order2.id,{...settleBody,externalReference:'BANK-2',valueDate:'2026-10-05'}));
 assert.deepEqual(await entryLines(settled2.journalEntryIds[0]),[['2100','5600.00','0.00'],['1010','0.00','5500.00'],['2300','0.00','100.00']]);
 assert.deepEqual(await events(bill2.id),[['accrual','600.00',false],['payment','100.00',true]]);
 await run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,order2.id,{...settleBody,externalReference:'BANK-2',valueDate:'2026-10-05'}));
 assert.deepEqual(await events(bill2.id),[['accrual','600.00',false],['payment','100.00',true]],'withholding recognized once');
 // Return of the payment mirrors the entry, unwinds the allocation and reverses the withholding event.
 const returned=await run(tre,tx=>purchasing.returnPayment(tx,tre,entityId,order2.id,{accountingDate:'2026-10-06',reason:'Bank returned the transfer'}));
 assert.equal(returned.state,'returned');
 assert.deepEqual(await entryLines(returned.journalEntryIds[0]),[['2100','0.00','5600.00'],['1010','5500.00','0.00'],['2300','100.00','0.00']]);
 assert.equal((await items()).items.find(i=>i.documentId===bill2.id).outstandingAmount,'5600.00');
 assert.deepEqual(await events(bill2.id),[['accrual','600.00',false],['payment','100.00',true]],'the live view keeps the mirror; the original is marked reversed');
 assert.equal((await run(acc,tx=>tx.query("select count(*)::int n from lara.tax_events where tenant_id=$1 and document_id=$2 and recognition='payment'",[tenantId,bill2.id]))).rows[0].n,2);
 await approveProfile(profileBody);
 pass('P05-T02: under the payment-time profile the bill posts Cr payables 5,600 without withholding; settlement posts Cr cash 5,500 / Cr withholding payable 100 and records the withholding event once; a repeated settlement adds nothing; the return mirrors the entry, unwinds the allocation and reverses the event');

 // P05-T03: normalized supplier reference duplicates; legitimate distinct reference proceeds with a reviewer disposition.
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'10000',{taxCodeId:vat.id})],{externalReference:' si/0001 '}))),'DUPLICATE_SOURCE','case, spacing and punctuation variants of a recorded reference');
 const similar=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'10000',{taxCodeId:vat.id})],{externalReference:'SI-0003',documentDate:'2026-09-20',accountingDate:'2026-09-20',evidenceIds:[billEvidence]})));
 const submitted=await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,similar.id,{}));
 assert.equal(submitted.taskIds.length,1,'a possible duplicate opens a review task');
 await rejects(run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,similar.id,{decision:'approve',contentVersion:1})),'VALIDATION_FAILED','approval of a flagged bill without a disposition');
 await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,similar.id,{decision:'approve',contentVersion:1,reason:'Second engagement, distinct supplier invoice checked'}));
 assert.equal((await run(acc,tx=>tx.query('select status from lara.tasks where tenant_id=$1 and id=$2',[tenantId,submitted.taskIds[0]]))).rows[0].status,'resolved');
 await rejects(run(clerk,tx=>purchasing.updateDocument(tx,clerk,entityId,similar.id,3,billBody([line(expense.id,'10000',{taxCodeId:vat.id})],{externalReference:'SI-0001',documentDate:'2026-09-20',accountingDate:'2026-09-20',evidenceIds:[billEvidence]}))),'DUPLICATE_SOURCE','editing a bill onto a recorded reference');
 pass('P05-T03: "si/0001" is refused as a duplicate of SI-0001 and the original reference is retained; a distinct reference with the same amount and date proceeds only with the approver\'s recorded disposition');

 // Purchase orders: receipt of service policy and two-way match.
 const po=await run(buyer,tx=>purchasing.createDocument(tx,buyer,entityId,doc('purchase_order',supplier.id,[line(expense.id,'12000',{description:'Phase 1'}),line(expense.id,'8000',{description:'Phase 2'})])));
 assert.deepEqual([po.kind,po.net,po.state],['purchase_order','20000.00','draft']);
 await run(buyer,tx=>purchasing.submitDocument(tx,buyer,entityId,po.id,{}));
 await rejects(run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,po.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','accountant holds no order approval');
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'12000')],{externalReference:'SI-PO1',sourceDocumentId:po.id}))),'STATE_CONFLICT','bill against an unapproved order');
 await run(ctrl,tx=>purchasing.approveDocument(tx,ctrl,entityId,po.id,{decision:'approve',contentVersion:1}));
 await rejects(run(acc,tx=>purchasing.postDocument(tx,acc,entityId,po.id,{})),'STATE_CONFLICT','orders never post');
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'12000')],{externalReference:'SI-PO1',sourceDocumentId:po.id}))),'STATE_CONFLICT','bill before the receipt of service');
 const receiptEvidence=await upload('acceptance.pdf','%PDF-1.4 acceptance\n');
 await rejects(run(buyer,tx=>purchasing.recordReceipt(tx,buyer,entityId,po.id,{evidenceId:receiptEvidence,lines:[{lineNo:1,amount:'20001'}]})),'STATE_CONFLICT','receipt beyond the order');
 const receipt=await run(buyer,tx=>purchasing.recordReceipt(tx,buyer,entityId,po.id,{evidenceId:receiptEvidence,lines:[{lineNo:1,amount:'12000'},{lineNo:2,amount:'8000'}]}));
 assert.equal(receipt.total,'20000.00');
 const poBill=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'12000')],{externalReference:'SI-PO1',sourceDocumentId:po.id,evidenceIds:[billEvidence]})));
 assert.equal(poBill.sourceDocumentId,po.id);
 const status=await run(buyer,tx=>purchasing.purchaseOrderStatus(tx,buyer,entityId,po.id));
 assert.deepEqual([status.ordered,status.received,status.invoiced,status.remaining],['20000.00','20000.00','12000.00','8000.00']);
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'9000')],{externalReference:'SI-PO2',sourceDocumentId:po.id}))),'STATE_CONFLICT','two-way match: billing beyond the order');
 await rejects(run(buyer,tx=>purchasing.cancelDocument(tx,buyer,entityId,po.id,{reason:'No longer needed'})),'STATE_CONFLICT','cancelling an order with bills');
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'100')],{externalReference:'SI-X',sourceDocumentId:bill.id}))),'VALIDATION_FAILED','bill linked to a bill');
 // PO requirement: with the policy on, a non-PO bill is allowed only on the profile's non-PO accounts (utilities).
 await approveProfile({...profileBody,requirePurchaseOrder:true});
 const nonPo=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,billBody([line(expense.id,'300')],{externalReference:'SI-NPO',evidenceIds:[billEvidence]})));
 await rejects(run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,nonPo.id,{})),'STATE_CONFLICT','non-PO bill on a PO-required account');
 const utilityBill=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,doc('bill',utility.id,[line(expense2.id,'300')],{externalReference:'PWR-09',evidenceIds:[billEvidence]})));
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,utilityBill.id,{}));
 await approveProfile(profileBody);
 const spare=await run(buyer,tx=>purchasing.createDocument(tx,buyer,entityId,doc('purchase_order',supplier.id,[line(expense.id,'1')])));
 const cancelled=await run(buyer,tx=>purchasing.cancelDocument(tx,buyer,entityId,spare.id,{reason:'Duplicate order'}));
 assert.equal(cancelled.state,'cancelled');
 pass('purchase orders: approval by the order approver, receipts of service with evidence gate PO bills under the policy, the two-way match refuses billing beyond the ordered net, orders with bills do not cancel, and the PO policy leaves utility bills without a dummy order');

 // P05-T04: beneficiary change after authorization withdraws the authority; release is refused until re-authorized.
 const item3=(await items()).items.find(i=>i.documentId===bill2.id);
 const proposal3=await run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,settlementBody({valueDate:'2026-10-10',grossAmount:'5600.00',cashAmount:'5500.00',withholdingAmount:'100.00',allocations:[{openItemId:item3.id,amount:'5600.00'}]})));
 await run(tre,tx=>purchasing.submitSettlement(tx,tre,entityId,proposal3.id,{}));
 const order3=await run(tre,tx=>purchasing.createPayment(tx,tre,entityId,{settlementId:proposal3.id,beneficiaryVersionId:ben.id,scheduledDate:'2026-10-10'}));
 await run(tre,tx=>purchasing.submitPayment(tx,tre,entityId,order3.id,{}));
 await run(ctrl,tx=>purchasing.authorizePayment(tx,ctrl,entityId,order3.id,{decision:'approve',contentVersion:1}));
 const ben2=await run(tre,tx=>purchasing.createBeneficiary(tx,tre,entityId,{partyId:supplier.id,bankName:'BPI',accountName:'Supplies Inc',accountNumber:'9988776655'},env));
 await run(dir,tx=>purchasing.approveBeneficiary(tx,dir,entityId,ben2.id));
 const withdrawn=await run(tre,tx=>purchasing.getPayment(tx,tre,entityId,order3.id));
 assert.equal(withdrawn.state,'draft','authority withdrawn when the beneficiary changed');
 assert.equal((await run(tre,tx=>purchasing.listBeneficiaries(tx,tre,entityId,{partyId:supplier.id}))).map(b=>b.state).join(','),'superseded,approved');
 await rejects(run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order3.id,{channel:'manual',externalReference:'TXN-3',evidenceIds:[billEvidence]})),'STATE_CONFLICT','release after the beneficiary changed');
 await run(tre,tx=>purchasing.updatePayment(tx,tre,entityId,order3.id,withdrawn.version,{settlementId:proposal3.id,beneficiaryVersionId:ben2.id,scheduledDate:'2026-10-10'}));
 await run(tre,tx=>purchasing.submitSettlement(tx,tre,entityId,proposal3.id,{}));
 await run(tre,tx=>purchasing.submitPayment(tx,tre,entityId,order3.id,{}));
 await run(ctrl,tx=>purchasing.authorizePayment(tx,ctrl,entityId,order3.id,{decision:'approve',contentVersion:2}));
 // Editing the proposal after authorization withdraws it again.
 const p3=await run(tre,tx=>purchasing.getSettlement(tx,tre,entityId,proposal3.id));
 await run(tre,tx=>purchasing.updateSettlement(tx,tre,entityId,proposal3.id,p3.version,settlementBody({valueDate:'2026-10-11',grossAmount:'5600.00',cashAmount:'5500.00',withholdingAmount:'100.00',allocations:[{openItemId:item3.id,amount:'5600.00'}]})));
 assert.equal((await run(tre,tx=>purchasing.getPayment(tx,tre,entityId,order3.id))).state,'draft');
 await run(tre,tx=>purchasing.submitSettlement(tx,tre,entityId,proposal3.id,{}));
 await run(tre,tx=>purchasing.submitPayment(tx,tre,entityId,order3.id,{}));
 await run(ctrl,tx=>purchasing.authorizePayment(tx,ctrl,entityId,order3.id,{decision:'approve',contentVersion:2}));
 await run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order3.id,{channel:'manual',externalReference:'TXN-3',evidenceIds:[billEvidence]}));
 const s3a=await run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,order3.id,{...settleBody,externalReference:'BANK-3',valueDate:'2026-10-11'}));
 const s3b=await run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,order3.id,{...settleBody,externalReference:'BANK-3',valueDate:'2026-10-11'}));
 assert.deepEqual(s3a.journalEntryIds,s3b.journalEntryIds);
 assert.equal((await run(acc,tx=>tx.query("select count(*)::int n from lara.journal_entries where tenant_id=$1 and source_id=$2",[tenantId,proposal3.id]))).rows[0].n,1);
 pass('P05-T04: approving a new beneficiary version supersedes the old one and returns authorized payments to draft; release is refused; after re-authorization the settlement is recorded once');

 // P05-T05: employee advance 10,000, claim 6,000 liquidates part of it, the remaining 4,000 is returned by receipt.
 const empBen=await run(tre,tx=>purchasing.createBeneficiary(tx,tre,entityId,{partyId:employee.id,bankName:'BDO',accountName:'Juan Dela Cruz',accountNumber:'5555666677'},env));
 await run(ctrl,tx=>purchasing.approveBeneficiary(tx,ctrl,entityId,empBen.id));
 const advanceProposal=await run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,settlementBody({partyId:employee.id,valueDate:'2026-10-12',grossAmount:'10000.00',cashAmount:'10000.00',withholdingAmount:'0.00',allocations:[]})));
 await run(tre,tx=>purchasing.submitSettlement(tx,tre,entityId,advanceProposal.id,{}));
 const advOrder=await run(tre,tx=>purchasing.createPayment(tx,tre,entityId,{settlementId:advanceProposal.id,beneficiaryVersionId:empBen.id,scheduledDate:'2026-10-12',reason:'Field trip advance'}));
 await run(tre,tx=>purchasing.submitPayment(tx,tre,entityId,advOrder.id,{}));
 await run(ctrl,tx=>purchasing.authorizePayment(tx,ctrl,entityId,advOrder.id,{decision:'approve',contentVersion:1}));
 await run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,advOrder.id,{channel:'manual',externalReference:'TXN-ADV',evidenceIds:[billEvidence]}));
 const advSettled=await run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,advOrder.id,{...settleBody,externalReference:'BANK-ADV',valueDate:'2026-10-12'}));
 assert.deepEqual(await entryLines(advSettled.journalEntryIds[0]),[['1400','10000.00','0.00'],['1010','0.00','10000.00']]);
 let adv=await run(acc,tx=>purchasing.listAdvances(tx,acc,entityId,{partyId:employee.id}));
 assert.deepEqual([adv[0].amount,adv[0].used,adv[0].remaining,adv[0].state],['10000.00','0.00','10000.00','open']);
 await rejects(run(tre,tx=>purchasing.returnPayment(tx,tre,entityId,advOrder.id,{accountingDate:'2026-10-13',reason:'oops'})),'STATE_CONFLICT','an issued advance is returned by receipt, not by payment return');
 const claimEvidence=await upload('receipts.pdf','%PDF-1.4 receipts\n');
 await rejects(run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,doc('expense_claim',supplier.id,[line(expense.id,'10')]))),'VALIDATION_FAILED','claim for a non-employee');
 const claim=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,doc('expense_claim',employee.id,[line(expense.id,'6000',{description:'Transport and lodging'})],{documentDate:'2026-10-15',accountingDate:'2026-10-15',evidenceIds:[claimEvidence]})));
 assert.equal((await run(acc,tx=>tx.query('select advance_id,policy_version from lara.expense_claims where tenant_id=$1 and document_id=$2',[tenantId,claim.id]))).rows.map(r=>r.advance_id+'|'+r.policy_version)[0],adv[0].id+'|expense-2026');
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,claim.id,{}));
 await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,claim.id,{decision:'approve',contentVersion:1}));
 const claimPosted=await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,claim.id,{}));
 assert.deepEqual(await entryLines(claimPosted.journalEntryIds[0]),[['5000','6000.00','0.00'],['1400','0.00','6000.00']]);
 adv=await run(acc,tx=>purchasing.listAdvances(tx,acc,entityId,{partyId:employee.id}));
 assert.deepEqual([adv[0].used,adv[0].remaining,adv[0].state],['6000.00','4000.00','partially_liquidated']);
 assert.equal((await run(clerk,tx=>purchasing.getDocument(tx,clerk,entityId,claim.id,{kinds:['expense_claim']}))).settlementState,'paid');
 await rejects(run(tre,tx=>sales.createCollection(tx,tre,entityId,{direction:'receipt',partyId:employee.id,currency:'PHP',valueDate:'2026-10-16',grossAmount:'4000.01',cashAmount:'4000.01',withholdingAmount:'0.00',method:'cash',allocations:[],evidenceIds:[]})),'ALLOCATION_EXCEEDS_BALANCE','returning more than the unliquidated advance');
 const ret=await run(tre,tx=>sales.createCollection(tx,tre,entityId,{direction:'receipt',partyId:employee.id,currency:'PHP',valueDate:'2026-10-16',grossAmount:'4000.00',cashAmount:'4000.00',withholdingAmount:'0.00',method:'cash',allocations:[],evidenceIds:[]}));
 await run(tre,tx=>sales.submitCollection(tx,tre,entityId,ret.id,{}));
 await run(acc,tx=>sales.approveCollection(tx,acc,entityId,ret.id,{decision:'approve',contentVersion:1}));
 const retPosted=await run(acc,tx=>sales.postCollection(tx,acc,entityId,ret.id,{}));
 assert.deepEqual(await entryLines(retPosted.journalEntryIds[0]),[['1010','4000.00','0.00'],['1400','0.00','4000.00']]);
 adv=await run(acc,tx=>purchasing.listAdvances(tx,acc,entityId,{partyId:employee.id}));
 assert.deepEqual([adv[0].used,adv[0].remaining,adv[0].state],['10000.00','0.00','closed']);
 const advanceBalance=(await run(acc,tx=>tx.query('select coalesce(sum(txn_debit-txn_credit),0)::text as b from lara.journal_lines where tenant_id=$1 and account_id=$2',[tenantId,advances.id]))).rows[0].b;
 assert.equal(ledger.decimal(ledger.micros(advanceBalance)),'0.00');
 // A claim beyond the advance opens a payable to the employee for the difference.
 const claim2=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,doc('expense_claim',employee.id,[line(expense.id,'900',{description:'Meals'})],{documentDate:'2026-10-17',accountingDate:'2026-10-17',evidenceIds:[claimEvidence]})));
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,claim2.id,{}));await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,claim2.id,{decision:'approve',contentVersion:1}));
 const claim2Posted=await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,claim2.id,{}));
 assert.deepEqual(await entryLines(claim2Posted.journalEntryIds[0]),[['5000','900.00','0.00'],['2100','0.00','900.00']]);
 assert.deepEqual((await run(acc,tx=>sales.listOpenItems(tx,acc,entityId,{partyId:employee.id,side:'AP'}))).items.map(i=>i.outstandingAmount),['900.00']);
 const tb=await run(ctrl,tx=>ledger.trialBalance(tx,ctrl,entityId,{bookId:book.id,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:new Date().toISOString()}));
 assert.equal(tb.totals.balanced,true);
 pass('P05-T05: the advance posts Dr employee advances 10,000; the 6,000 claim liquidates it (Cr advances 6,000, no payable); the 4,000 return posts Dr cash / Cr advances and closes the advance with a zero balance; a claim without advance cover opens a payable to the employee; the ledger balances');

 // Withholding certificates derive from the tax events: 200 accrued − 40 credited on the accrual bills (Q3) and 100 at payment (Q4, reversed by the return, then 100 again).
 await rejects(run(tax,tx=>purchasing.prepareCertificate(tx,tax,entityId,{partyId:supplier.id,periodKey:'2026-08',taxRuleVersionId:ewt.id})),'STATE_CONFLICT','certificate for a period without withholding');
 const cert=await run(tax,tx=>purchasing.prepareCertificate(tx,tax,entityId,{partyId:supplier.id,periodKey:'2026-Q3',taxRuleVersionId:ewt.id}));
 assert.deepEqual([cert.basisTotal,cert.taxTotal,cert.taxEventIds.length,cert.state,cert.outputVersion],['8000.00','160.00',2,'draft','wht-certificate-1']);
 await rejects(run(tax,tx=>purchasing.reviewCertificate(tx,tax,entityId,cert.id)),'FORBIDDEN','the tax officer cannot review');
 await run(ctrl,tx=>purchasing.reviewCertificate(tx,ctrl,entityId,cert.id));
 await rejects(run(tax,tx=>purchasing.prepareCertificate(tx,tax,entityId,{partyId:supplier.id,periodKey:'2026-Q3',taxRuleVersionId:ewt.id})),'STATE_CONFLICT','a second certificate over the same events');
 const issued=await run(ctrl,tx=>purchasing.issueCertificate(tx,ctrl,entityId,cert.id));
 assert.equal(issued.state,'issued');
 await rejects(run(ctrl,tx=>tx.query("update lara.withholding_certificates set tax_total=1 where tenant_id=$1 and id=$2",[tenantId,cert.id])),'STATE_CONFLICT','issued certificates are immutable');
 const q4=await run(tax,tx=>purchasing.prepareCertificate(tx,tax,entityId,{partyId:supplier.id,periodKey:'2026-10',taxRuleVersionId:ewt.id}));
 assert.deepEqual([q4.basisTotal,q4.taxTotal],['5000.00','100.00'],'the returned payment and its reversal cancel out');
 const aging=await run(acc,tx=>sales.agingReport(tx,acc,entityId,{asOf:'2026-11-30',side:'AP'}));
 assert.deepEqual([aging.side,aging.parties.map(p=>p.total)],['AP',['900.00']]);
 pass('withholding certificates derive from live tax events (credits reduce, reversals cancel), are reviewed and issued by another principal, and are immutable once issued; supplier aging serves the payable side');
 console.log('P05-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
