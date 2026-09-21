// P17-02 local operations domain against real PostgreSQL through the
// runtime role: P17-T01 the lease schedule sums with escalation at its
// boundary and a deposit application settles the rent invoice without
// recognizing revenue twice; P17-T02 eligible, ineligible, expired and mixed
// lines follow the approved profile; P17-T03 the payout gross-to-net
// reconciliation explains every fee and tax and a replay never duplicates
// the sale or the payout; P17-T04 payroll totals tie and an unauthorized
// user cannot read individual records; P17-T05 a complete local obligation
// requires the payment and filing evidence the authority demands.
// Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales,assets,localops} from '../packages/domain/src/index.mjs';
const {MemoryEvidenceStore,FixtureScanner}=evidence;
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
process.env.FIELD_ENCRYPTION_KEY??=randomBytes(32).toString('hex');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:60000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
async function rejects(promise,code,label){try{await promise;}catch(e){assert.ok(e instanceof DomainError,label+': not a DomainError: '+e.stack);assert.equal(e.code,code,label+': '+e.message);return e;}assert.fail(label+' should fail with '+code);}
const run=(ctx,fn,db=api)=>inTransaction(db,ctx,fn);
const env={FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY};
const store=new MemoryEvidenceStore();
const ISSUER='https://identity.invalid';
try{
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-local-'+suffix,name:'Local ops domain',mode:'demo'});
  for(const n of ['clerk','billing','accountant','treasury','controller','director','security','ops','reviewer','hr'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['clerk','billing','accountant','treasury','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds the P17 authorities; tenant roles cover the operations officer (records), the reviewer (approvals, posting) and HR (payroll records) — noted for owner review.
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.ops=await role('local_ops',['lease.create','lease.edit','lease.read','discount_eligibility.create','discount_eligibility.edit','discount_eligibility.read','channel.create','channel.read','payout.create','payout.read','pos_closing.create','pos_closing.read','payroll_batch.create','payroll_batch.read','remittance.create','remittance.read','local_obligation.create','local_obligation.edit','local_obligation.read','schedule.create','schedule.read']);
  roles.reviewer=await role('local_reviewer',['lease.approve','lease.edit','lease.read','discount_eligibility.approve','discount_eligibility.read','channel.read','payout.read','payout.reconcile','payout.post','pos_closing.read','pos_closing.approve','payroll_batch.read','payroll_batch.approve','payroll_batch.post','remittance.read','remittance.approve','local_obligation.read','local_obligation.complete','schedule.approve','schedule.read']);
  roles.hr=await role('hr',['payroll_batch.read','payroll_record.read']);
  for(const [p,r] of [['clerk','clerk'],['billing','billing'],['accountant','accountant'],['treasury','treasury'],['controller','controller'],['director','controller'],['security','security_admin'],['ops','ops'],['reviewer','reviewer'],['hr','hr']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'local-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Local Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const clerk=await ctxFor('clerk'),bill=await ctxFor('billing'),acc=await ctxFor('accountant'),tre=await ctxFor('treasury'),dir=await ctxFor('director'),ops=await ctxFor('ops'),rev=await ctxFor('reviewer'),hr=await ctxFor('hr');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing','treasury','compliance','inventory','assets'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const a={};
 a.cash=await mk('1010','Cash','asset');a.clearing=await mk('1020','Payout clearing','asset');a.ar=await mk('1200','Receivables','asset',{controlType:'ar'});a.channelAr=await mk('1210','Marketplace receivable','asset');a.inTax=await mk('1300','Input tax','asset',{controlType:'input_tax'});a.cwt=await mk('1350','Creditable withholding','asset');a.adv=await mk('1400','Advances','asset');
 a.ap=await mk('2100','Payables','liability',{controlType:'ap'});a.outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'});a.whtPay=await mk('2300','Withholding payable','liability');a.deposits=await mk('2400','Lease deposits held','liability');a.advances=await mk('2410','Rent received in advance','liability');a.sss=await mk('2510','SSS payable','liability');a.ph=await mk('2520','PhilHealth payable','liability');a.pi=await mk('2530','Pag-IBIG payable','liability');a.netPay=await mk('2540','Salaries payable','liability');
 a.rent=await mk('4100','Rent income','income');a.sales=await mk('4200','Store sales','income');a.services=await mk('4300','Service income','income');a.salaries=await mk('5100','Salaries','expense');a.fees=await mk('5300','Platform fees','expense');
 for(const [s,e] of [['2026-10-01','2026-10-31'],['2026-11-01','2026-11-30'],['2026-12-01','2026-12-31'],['2027-01-01','2027-01-31']])await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const settle=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await settle('sales_profile',{arAccountId:a.ar.id,outputTaxAccountId:a.outTax.id,cashAccountId:a.cash.id,scale:2,dueDays:30});
 await settle('purchasing_profile',{apAccountId:a.ap.id,inputTaxAccountId:a.inTax.id,cashAccountId:a.cash.id,withholdingPayableAccountId:a.whtPay.id,advanceAccountId:a.adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
 await settle('recognition_policy_monthly_billing',{code:'monthly_billing',kind:'recurring_invoice'});
 for(const [kind,prefix] of [['invoice','INV'],['bill','BILL']])await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branch.id,kind,prefix,principals.controller]));
 const lessee=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Tenant Co',roles:['customer'],identityStatus:'unknown',address:'Makati'},env));
 const senior=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Maria Santos',roles:['customer'],identityStatus:'unknown',address:'Pasig'},env));
 const walkin=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Walk-in Customer',roles:['customer'],identityStatus:'unknown',address:'Manila'},env));
 const upload=async(name,who=clerk)=>{const bytes=Buffer.from('%PDF-1.4 '+name+String.fromCharCode(10));const reg=await run(who,tx=>evidence.registerUpload(tx,who,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(who,tx=>evidence.completeUpload(tx,who,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const activate=cap=>run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p17.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const invoiceBody=(partyId,lines,extra={})=>({kind:'invoice',branchId:branch.id,bookId:book.id,partyId,documentDate:'2026-10-05',accountingDate:'2026-10-05',currency:'PHP',ruleProfileVersion:'ph-2026',lines,evidenceIds:[],...extra});
 const line=(accountId,unitPrice,extra={})=>({description:'Line',quantity:'1',unitPrice,discount:'0',priceBasis:'exclusive',accountId,dimensions:{},...extra});
 const postInvoice=async id=>{await run(bill,tx=>sales.submitDocument(tx,bill,entityId,id,{}));const d=await run(bill,tx=>sales.getDocument(tx,bill,entityId,id,{kinds:['invoice','credit_note']}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,id,{decision:'approve',contentVersion:d.contentVersion}));return run(acc,tx=>sales.postDocument(tx,acc,entityId,id,{}));};
 pass('fixture: entity with the sales, purchasing, treasury, compliance, inventory and assets chain, an operations officer, a reviewer and HR');

 // P17A leases.
 const template=await run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody(lessee.id,[line(a.rent.id,'20000',{description:'Monthly rent'})])));
 const schedule=await run(ops,tx=>assets.createSchedule(tx,ops,entityId,{kind:'recurring_invoice',sourceId:template.id,startDate:'2026-10-01',endDate:'2027-09-30',basisAmount:'20000',currency:'PHP',policyVersion:'monthly_billing'}));
 const leaseDoc=await upload('lease.pdf');
 const leaseBody={partyId:lessee.id,startDate:'2026-10-01',endDate:'2027-09-30',currency:'PHP',deposit:'40000.00',advance:'20000.00',billingScheduleId:schedule.id,withholdingProfileVersion:'lease-wht-2026',evidenceIds:[leaseDoc],escalation:[{effectiveFrom:'2027-01-01',rate:'0.05'}]};
 await rejects(run(ops,tx=>localops.createLease(tx,ops,entityId,leaseBody)),'FEATURE_NOT_ENABLED','leases before the capability');
 await activate('leases');
 await rejects(run(ops,tx=>localops.createLease(tx,ops,entityId,leaseBody)),'RULE_PROFILE_NOT_APPROVED','leases need an approved withholding profile version');
 await settle('lease_withholding_profile',{profileVersion:'lease-wht-2026',rates:{corporate:'0.05',individual:'0.05'}});
 await settle('lease_profile',{depositLiabilityAccountId:a.deposits.id,advanceLiabilityAccountId:a.advances.id,cashAccountId:a.cash.id});
 await rejects(run(ops,tx=>localops.createLease(tx,ops,entityId,{...leaseBody,escalation:[{effectiveFrom:'2026-09-01',rate:'0.05'}]})),'VALIDATION_FAILED','escalation outside the term');
 const lease=await run(ops,tx=>localops.createLease(tx,ops,entityId,leaseBody));
 assert.equal(lease.baseRent,'20000.00');
 const sched=await run(ops,tx=>localops.leaseScheduleFor(tx,ops,entityId,lease.id));
 assert.equal(sched.lines.length,12);assert.equal(sched.lines[2].rent,'20000.00');assert.equal(sched.lines[3].periodStart,'2027-01-01');assert.equal(sched.lines[3].rent,'21000.00','escalation applies from its boundary');
 assert.equal(sched.total,'249000.00','3 × 20,000 + 9 × 21,000');
 await rejects(run(ops,tx=>localops.approveLease(tx,ops,entityId,lease.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the officer does not approve');
 await rejects(run(ops,tx=>localops.billLease(tx,ops,entityId,lease.id,{periodStart:'2026-10-01',periodEnd:'2026-10-31',accountingDate:'2026-10-01',evidenceIds:[]})),'STATE_CONFLICT','billing before approval');
 await run(rev,tx=>localops.approveLease(tx,rev,entityId,lease.id,{decision:'approve',contentVersion:1}));
 const rentOct=await run(rev,tx=>localops.billLease(tx,rev,entityId,lease.id,{periodStart:'2026-10-01',periodEnd:'2026-10-31',accountingDate:'2026-10-01',evidenceIds:[]}));
 await rejects(run(rev,tx=>localops.billLease(tx,rev,entityId,lease.id,{periodStart:'2026-10-01',periodEnd:'2026-10-31',accountingDate:'2026-10-01',evidenceIds:[]})),'STATE_CONFLICT','a period bills once');
 const rentJan=await run(rev,tx=>localops.billLease(tx,rev,entityId,lease.id,{periodStart:'2027-01-01',periodEnd:'2027-01-31',accountingDate:'2027-01-01',evidenceIds:[]}));
 assert.equal((await run(bill,tx=>sales.getDocument(tx,bill,entityId,rentJan.resourceId,{kinds:['invoice','credit_note']}))).gross,'21000.00','January bills the escalated rent');
 await postInvoice(rentOct.resourceId);
 const bankSlip=await upload('deposit-slip.pdf');
 await rejects(run(ops,tx=>localops.leaseEvent(tx,ops,entityId,lease.id,{kind:'deposit_received',amount:'50000.00',eventDate:'2026-10-01',evidenceIds:[bankSlip]})),'VALIDATION_FAILED','deposit beyond the contract');
 const dep=await run(ops,tx=>localops.leaseEvent(tx,ops,entityId,lease.id,{kind:'deposit_received',amount:'40000.00',eventDate:'2026-10-01',evidenceIds:[bankSlip]}));
 assert.equal(dep.journalEntryIds.length,1);
 const revenueOf=async()=>Number((await run(acc,tx=>tx.query("select coalesce(sum(l.func_credit-l.func_debit),0)::text as r from lara.journal_lines l where l.tenant_id=$1 and l.entity_id=$2 and l.account_id=$3",[tenantId,entityId,a.rent.id]))).rows[0].r);
 const depositsOf=async()=>Number((await run(acc,tx=>tx.query("select coalesce(sum(l.func_credit-l.func_debit),0)::text as r from lara.journal_lines l where l.tenant_id=$1 and l.entity_id=$2 and l.account_id=$3",[tenantId,entityId,a.deposits.id]))).rows[0].r);
 assert.equal(await revenueOf(),20000,'revenue is the October rent alone');assert.equal(await depositsOf(),40000,'the deposit is a liability');
 await rejects(run(ops,tx=>localops.leaseEvent(tx,ops,entityId,lease.id,{kind:'deposit_applied',amount:'20000.00',eventDate:'2026-10-31',documentId:rentOct.resourceId,evidenceIds:[]})),'SELF_APPROVAL','the recorder of the receipt cannot apply it');
 await rejects(run(rev,tx=>localops.leaseEvent(tx,rev,entityId,lease.id,{kind:'deposit_applied',amount:'45000.00',eventDate:'2026-10-31',documentId:rentOct.resourceId,evidenceIds:[]})),'ALLOCATION_EXCEEDS_BALANCE','application beyond what is held');
 await run(rev,tx=>localops.leaseEvent(tx,rev,entityId,lease.id,{kind:'deposit_applied',amount:'20000.00',eventDate:'2026-10-31',documentId:rentOct.resourceId,evidenceIds:[]}));
 assert.equal(await revenueOf(),20000,'application recognizes no revenue again');assert.equal(await depositsOf(),20000);
 const outstanding=(await run(acc,tx=>tx.query("select (original_amount-lara.open_item_allocated(tenant_id,id))::text as o from lara.open_items where tenant_id=$1 and document_id=$2",[tenantId,rentOct.resourceId]))).rows[0].o;
 assert.equal(Number(outstanding),0,'the rent invoice is settled by the deposit');
 const after=await run(ops,tx=>localops.leaseScheduleFor(tx,ops,entityId,lease.id));
 assert.equal(after.depositHeld,'20000.00');assert.deepEqual(after.lines.filter(l=>l.billed).map(l=>l.periodStart),['2026-10-01','2027-01-01']);
 pass('P17-T01: the lease schedule sums with the escalation at its boundary, the escalated month bills at the escalated rent, a deposit is a liability until another principal applies it, and the application settles the rent invoice without recognizing revenue twice');

 // P17B statutory discounts.
 const scId=await upload('sc-id.pdf');
 await rejects(run(ops,tx=>localops.createEligibility(tx,ops,entityId,{partyId:senior.id,category:'senior_citizen',profileVersion:'sc-2026',validUntil:'2027-12-31',evidenceIds:[scId]},env)),'FEATURE_NOT_ENABLED','discounts before the capability');
 await activate('statutory_discounts');
 await rejects(run(ops,tx=>localops.createEligibility(tx,ops,entityId,{partyId:senior.id,category:'senior_citizen',profileVersion:'sc-2026',validUntil:'2027-12-31',evidenceIds:[scId]},env)),'RULE_PROFILE_NOT_APPROVED','no approved profile for the category');
 await settle('discount_profile_senior_citizen',{profileVersion:'sc-2026',rate:'0.2',basis:'net',eligibleAccountIds:[a.services.id],exemptionProfile:'vat-exempt-sc',requiredEvidence:['osca_id'],goldenCases:[{id:'SC-01',match:'any'}]});
 const elig=await run(ops,tx=>localops.createEligibility(tx,ops,entityId,{partyId:senior.id,category:'senior_citizen',profileVersion:'sc-2026',validUntil:'2027-12-31',evidenceIds:[scId],idReference:'OSCA-123456'},env));
 assert.equal(elig.idReferenceMasked,'*******3456','the identity reference is masked');
 const mixed=await run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody(senior.id,[line(a.services.id,'1000',{description:'Consultation'}),line(a.sales.id,'500',{description:'Merchandise'})])));
 await rejects(run(rev,tx=>localops.applyDiscount(tx,rev,entityId,mixed.id,{})),'STATE_CONFLICT','no approved eligibility yet');
 await run(rev,tx=>localops.approveEligibility(tx,rev,entityId,elig.id,{decision:'approve',contentVersion:1}));
 await run(rev,tx=>localops.applyDiscount(tx,rev,entityId,mixed.id,{}));
 const discounted=await run(bill,tx=>sales.getDocument(tx,bill,entityId,mixed.id,{kinds:['invoice','credit_note']}));
 assert.equal(discounted.net,'1300.00','1,000 less 20% plus 500 untouched');
 const dl=await run(ops,tx=>localops.discountLines(tx,ops,entityId,mixed.id));
 assert.deepEqual(dl.items.map(x=>[x.lineNo,x.rate,x.amount,x.goldenCaseId]),[[1,'0.2','200.00','SC-01']],'only the eligible line carries a discount line');
 const ineligible=await run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody(walkin.id,[line(a.services.id,'1000')])));
 await rejects(run(rev,tx=>localops.applyDiscount(tx,rev,entityId,ineligible.id,{})),'STATE_CONFLICT','a customer without eligibility');
 const expired=await run(bill,tx=>sales.createDocument(tx,bill,entityId,invoiceBody(senior.id,[line(a.services.id,'1000')],{documentDate:'2028-01-05',accountingDate:'2028-01-05'})));
 await rejects(run(rev,tx=>localops.applyDiscount(tx,rev,entityId,expired.id,{})),'STATE_CONFLICT','expired evidence at the document date');
 await postInvoice(mixed.id);
 await rejects(run(rev,tx=>localops.applyDiscount(tx,rev,entityId,mixed.id,{})),'STATE_CONFLICT','a posted invoice is corrected by a credit note, never re-discounted');
 pass('P17-T02: eligibility on masked identity evidence approved by another principal; the approved profile discounts the eligible line of a mixed invoice and leaves the rest, an ineligible customer and an expired eligibility are refused, and a posted invoice is not re-discounted');

 // P17C payouts and POS.
 await activate('marketplace_pos');
 const channel=await run(ops,tx=>localops.createChannel(tx,ops,entityId,{code:'SHOP',name:'ShopCo marketplace',kind:'marketplace',provider:'ShopCo',mappingVersion:'shop-2026',receivableAccountId:a.channelAr.id,feeAccountId:a.fees.id,withholdingAccountId:a.cwt.id,clearingAccountId:a.clearing.id}));
 // The sales already imported for the period: a posted journal (imported channel sales).
 const salesJ=await run(acc,tx=>ledger.createJournal(tx,acc,entityId,{bookId:book.id,accountingDate:'2026-10-15',documentDate:'2026-10-15',currency:'PHP',description:'ShopCo sales 1–15 Oct',lines:[{accountId:a.channelAr.id,branchId:branch.id,debit:'10000.00',credit:'0',dimensions:{}},{accountId:a.sales.id,branchId:branch.id,debit:'0',credit:'10000.00',dimensions:{}}],evidenceIds:[]}));
 await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,salesJ.id,{}));await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,salesJ.id,{decision:'approve',contentVersion:1}));const postedSales=await run(ctrl,tx=>ledger.postJournal(tx,ctrl,entityId,salesJ.id,{}));
 const stm=await upload('shopco-statement.pdf');
 await rejects(run(ops,tx=>localops.createPayout(tx,ops,entityId,{channelId:channel.id,sourceId:'STM-2026-10-A',periodStart:'2026-10-01',periodEnd:'2026-10-15',gross:'10000.00',fees:'500.00',withholding:'100.00',otherDeductions:[{kind:'shipping_subsidy_clawback',amount:'50.00'}],net:'9400.00',evidenceIds:[stm]})),'VALIDATION_FAILED','a net that the deductions do not explain');
 const payout=await run(ops,tx=>localops.createPayout(tx,ops,entityId,{channelId:channel.id,sourceId:'STM-2026-10-A',periodStart:'2026-10-01',periodEnd:'2026-10-15',gross:'10000.00',fees:'500.00',withholding:'100.00',otherDeductions:[{kind:'shipping_subsidy_clawback',amount:'50.00'}],net:'9350.00',evidenceIds:[stm]}));
 await rejects(run(ops,tx=>localops.createPayout(tx,ops,entityId,{channelId:channel.id,sourceId:'STM-2026-10-A',periodStart:'2026-10-01',periodEnd:'2026-10-15',gross:'10000.00',fees:'500.00',withholding:'100.00',otherDeductions:[{kind:'shipping_subsidy_clawback',amount:'50.00'}],net:'9350.00',evidenceIds:[stm]})),'STATE_CONFLICT','a replayed statement never duplicates the payout');
 await rejects(run(rev,tx=>localops.postPayout(tx,rev,entityId,payout.id,{})),'STATE_CONFLICT','posting before reconciliation');
 const rec=await run(rev,tx=>localops.reconcilePayout(tx,rev,entityId,payout.id,{salesReferenceIds:[postedSales.journalEntryIds[0]]}));
 assert.equal(rec.state,'reconciled');
 const posted=await run(rev,tx=>localops.postPayout(tx,rev,entityId,payout.id,{}));
 assert.equal(posted.journalEntryIds.length,1);
 const lines=(await run(acc,tx=>tx.query('select account_id,func_debit::text as d,func_credit::text as c from lara.journal_lines where tenant_id=$1 and entry_id=$2 order by line_no',[tenantId,posted.journalEntryIds[0]]))).rows;
 assert.deepEqual(lines.map(l=>[l.account_id,Number(l.d),Number(l.c)]),[[a.clearing.id,9350,0],[a.fees.id,500,0],[a.cwt.id,100,0],[a.fees.id,50,0],[a.channelAr.id,0,10000]],'net to clearing, every fee and tax explained, the channel receivable settled for the gross');
 assert.equal((await run(rev,tx=>localops.postPayout(tx,rev,entityId,payout.id,{}))).state,'posted','posting again replays');
 const second=await run(ops,tx=>localops.createPayout(tx,ops,entityId,{channelId:channel.id,sourceId:'STM-2026-10-B',periodStart:'2026-10-01',periodEnd:'2026-10-15',gross:'10000.00',fees:'0.00',withholding:'0.00',otherDeductions:[],net:'10000.00',evidenceIds:[stm]}));
 await rejects(run(rev,tx=>localops.reconcilePayout(tx,rev,entityId,second.id,{salesReferenceIds:[postedSales.journalEntryIds[0]]})),'STATE_CONFLICT','the same sales never reconcile to two payouts');
 const machine=await run(ops,tx=>localops.createMachine(tx,ops,entityId,{branchId:branch.id,brand:'Acme',model:'X1',serialNumber:'SN-001',machineIdentificationNumber:'MIN-001',permitNumber:'PTU-2026-1'}));
 const tape=await upload('z-reading.pdf');
 const closing=await run(ops,tx=>localops.createClosing(tx,ops,entityId,{machineId:machine.id,shiftDate:'2026-10-20',shiftNo:1,readingKind:'Z',beginningReading:'100000.00',endingReading:'103500.00',cashCounted:'3000.00',nonCash:'500.00',evidenceIds:[tape]}));
 assert.equal(closing.grossSales,'3500.00');
 await run(rev,tx=>localops.approveClosing(tx,rev,entityId,closing.id,{decision:'approve',contentVersion:1}));
 const deposit=await run(bill,tx=>sales.createCollection(tx,bill,entityId,{direction:'receipt',partyId:walkin.id,currency:'PHP',valueDate:'2026-10-21',grossAmount:'3000.00',cashAmount:'3000.00',withholdingAmount:'0.00',method:'cash',allocations:[],evidenceIds:[]}));
 await run(bill,tx=>sales.submitCollection(tx,bill,entityId,deposit.id,{}));await run(acc,tx=>sales.approveCollection(tx,acc,entityId,deposit.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>sales.postCollection(tx,acc,entityId,deposit.id,{}));
 const matched=await run(rev,tx=>localops.matchClosing(tx,rev,entityId,closing.id,{settlementId:deposit.id}));
 assert.equal(matched.state,'matched');
 pass('P17-T03: the payout records every fee and tax so gross less deductions equals the net, reconciles to the imported sales once, posts once with each deduction explained, a replay never duplicates the sale or the payout; a Z closing matches its deposit');

 // P17D payroll.
 await activate('payroll_data');
 await settle('payroll_profile',{salaryExpenseAccountId:a.salaries.id,withholdingPayableAccountId:a.whtPay.id,sssPayableAccountId:a.sss.id,philhealthPayableAccountId:a.ph.id,pagibigPayableAccountId:a.pi.id,netPayableAccountId:a.netPay.id});
 const register=await upload('payroll-register.pdf');
 const records=[{employeeReference:'EMP-0001',gross:'30000.00',withholding:'2500.00',sss:'1350.00',philhealth:'600.00',pagibig:'200.00',net:'25350.00'},{employeeReference:'EMP-0002',gross:'20000.00',withholding:'1000.00',sss:'900.00',philhealth:'400.00',pagibig:'200.00',net:'17500.00'}];
 const totals={grossTotal:'50000.00',withholdingTotal:'3500.00',sssTotal:'2250.00',philhealthTotal:'1000.00',pagibigTotal:'400.00',netTotal:'42850.00'};
 const off=await run(ops,tx=>localops.importPayroll(tx,ops,entityId,{sourceSystem:'PayrollCo',periodKey:'2026-10',mappingVersion:'pay-2026',...totals,netTotal:'42000.00',records,evidenceIds:[register]},env));
 assert.equal(off.state,'exception');assert.match(off.exceptionReason,/netTotal/);
 await rejects(run(rev,tx=>localops.approveBatch(tx,rev,entityId,off.id,{decision:'approve',contentVersion:1})),'STATE_CONFLICT','totals that do not tie are not approved');
 const batch=await run(ops,tx=>localops.importPayroll(tx,ops,entityId,{sourceSystem:'PayrollCo',periodKey:'2026-10',mappingVersion:'pay-2026',...totals,records,evidenceIds:[register]},env));
 assert.equal(batch.state,'reconciled');assert.equal(batch.employeeCount,2);
 await rejects(run(ops,tx=>localops.importPayroll(tx,ops,entityId,{sourceSystem:'PayrollCo',periodKey:'2026-10',mappingVersion:'pay-2026',...totals,records,evidenceIds:[register]},env)),'STATE_CONFLICT','the same file twice');
 await rejects(run(ops,tx=>localops.batchRecords(tx,ops,entityId,batch.id)),'FORBIDDEN','the importer cannot read individual records');
 await rejects(run(rev,tx=>localops.batchRecords(tx,rev,entityId,batch.id)),'FORBIDDEN','the reviewer cannot read individual records');
 const recs=await run(hr,tx=>localops.batchRecords(tx,hr,entityId,batch.id));
 assert.deepEqual(recs.items.map(r=>r.employeeReferenceMasked),['****0001','****0002'],'identifiers are masked even for HR');
 assert.equal((await run(hr,tx=>tx.query('select employee_reference_encrypted from lara.employee_tax_records where tenant_id=$1 and batch_id=$2 limit 1',[tenantId,batch.id]))).rows[0].employee_reference_encrypted.startsWith('v1.'),true,'stored encrypted');
 await run(rev,tx=>localops.approveBatch(tx,rev,entityId,batch.id,{decision:'approve',contentVersion:1}));
 const pj=await run(rev,tx=>localops.postBatch(tx,rev,entityId,batch.id,{}));
 const pl=(await run(acc,tx=>tx.query('select account_id,func_debit::text as d,func_credit::text as c from lara.journal_lines where tenant_id=$1 and entry_id=$2 order by line_no',[tenantId,pj.journalEntryIds[0]]))).rows;
 assert.deepEqual(pl.map(l=>[l.account_id,Number(l.d),Number(l.c)]),[[a.salaries.id,50000,0],[a.whtPay.id,0,3500],[a.sss.id,0,2250],[a.ph.id,0,1000],[a.pi.id,0,400],[a.netPay.id,0,42850]],'the payroll journal per the profile');
 await rejects(run(ops,tx=>localops.createRemittance(tx,ops,entityId,{batchId:batch.id,agency:'SSS',periodKey:'2026-10',amount:'2000.00',dueDate:'2026-11-15'})),'VALIDATION_FAILED','the remittance ties to the batch total');
 const remit=await run(ops,tx=>localops.createRemittance(tx,ops,entityId,{batchId:batch.id,agency:'SSS',periodKey:'2026-10',amount:'2250.00',dueDate:'2026-11-15'}));
 await run(rev,tx=>localops.approveRemittance(tx,rev,entityId,remit.id,{decision:'approve',contentVersion:1}));
 const proof=await upload('sss-payment.pdf');
 await run(rev,tx=>localops.remit(tx,rev,entityId,remit.id,{reference:'SSS-PRN-2026-10',evidenceIds:[proof]}));
 assert.equal((await run(ops,tx=>localops.listRemittances(tx,ops,entityId,{}))).items[0].state,'remitted');
 pass('P17-T04: a payroll file whose totals do not tie stays an exception, the tying file imports once, individual records are readable only with the restricted permission and masked, the journal follows the approved profile once per period, and the SSS remittance ties to the batch and is remitted on evidence');

 // P17E local obligations.
 await activate('local_obligations');
 await rejects(run(ops,tx=>localops.createObligation(tx,ops,entityId,{authority:'Makati City',authorityProfileVersion:'lgu-2026',kind:'real_property_tax',propertyRef:'TD-001',periodKey:'2026',dueDate:'2026-03-31',amount:'12000.00',requiresFiling:true,evidenceIds:[]})),'RULE_PROFILE_NOT_APPROVED','obligations need the reviewed authority profile');
 await settle('local_authority_profile',{authority:'Makati City',profileVersion:'lgu-2026',kinds:['business_permit','local_business_tax','real_property_tax'],filingRequired:['business_permit']});
 await rejects(run(ops,tx=>localops.createObligation(tx,ops,entityId,{authority:'Makati City',authorityProfileVersion:'lgu-2026',kind:'community_tax',periodKey:'2026',dueDate:'2026-02-28',amount:'500.00',requiresFiling:false,evidenceIds:[]})),'VALIDATION_FAILED','a kind outside the profile');
 await rejects(run(ops,tx=>localops.createObligation(tx,ops,entityId,{authority:'Makati City',authorityProfileVersion:'lgu-2026',kind:'business_permit',periodKey:'2026',dueDate:'2026-01-20',amount:'8000.00',requiresFiling:false,evidenceIds:[]})),'VALIDATION_FAILED','the authority requires filing evidence for the permit');
 const permit=await run(ops,tx=>localops.createObligation(tx,ops,entityId,{authority:'Makati City',authorityProfileVersion:'lgu-2026',kind:'business_permit',periodKey:'2026',dueDate:'2026-01-20',amount:'8000.00',requiresFiling:true,evidenceIds:[]}));
 const receipt=await upload('permit-or.pdf');
 await rejects(run(rev,tx=>localops.completeObligation(tx,rev,entityId,permit.id,{paymentEvidenceIds:[receipt],filingEvidenceIds:[]})),'EVIDENCE_NOT_READY','complete without the filing evidence');
 const filed=await upload('permit-certificate.pdf');
 await rejects(run(ops,tx=>localops.completeObligation(tx,ops,entityId,permit.id,{paymentEvidenceIds:[receipt],filingEvidenceIds:[filed]})),'FORBIDDEN','the officer does not complete');
 const done=await run(rev,tx=>localops.completeObligation(tx,rev,entityId,permit.id,{paymentEvidenceIds:[receipt],filingEvidenceIds:[filed]}));
 assert.equal(done.state,'complete');
 await rejects(run(rev,tx=>localops.waiveObligation(tx,rev,entityId,permit.id,{reason:'x'})),'STATE_CONFLICT','a complete obligation is final');
 const rpt=await run(ops,tx=>localops.createObligation(tx,ops,entityId,{authority:'Makati City',authorityProfileVersion:'lgu-2026',kind:'real_property_tax',propertyRef:'TD-001',periodKey:'2026',dueDate:'2026-03-31',amount:'12000.00',requiresFiling:false,evidenceIds:[]}));
 assert.equal((await run(rev,tx=>localops.completeObligation(tx,rev,entityId,rpt.id,{paymentEvidenceIds:[receipt],filingEvidenceIds:[]}))).state,'complete','payment evidence suffices where no filing is required');
 pass('P17-T05: obligations follow the reviewed authority profile; the permit completes only with payment and filing evidence, real property tax with payment evidence alone; completion is the reviewer\'s and final');
 console.log('P17-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
