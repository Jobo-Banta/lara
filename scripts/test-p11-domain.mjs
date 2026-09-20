// P11-02 assets and schedules domain against real PostgreSQL through the
// runtime role: P11-T01 AC-08 (120,000 over 60 months posts 2,000 a month)
// with the residual final month, a prospective method change and the
// leap-year daily policy; P11-T02 a rerun posts once and a locked period
// raises a task instead of a bypass; P11-T03 split and merge conserve cost
// and accumulated depreciation and a disposal recognizes the gain or loss;
// P11-T04 a deferred revenue schedule totals the contract with the rounding
// residue in the final period; P11-T05 book and tax layers reconcile
// independently and are reproducible from the rule version. Test tenants
// are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,purchasing,sales,assets} from '../packages/domain/src/index.mjs';
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
const m=v=>BigInt(Math.round(v*1e6));
try{
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-ast-'+suffix,name:'Assets domain',mode:'demo'});
  for(const n of ['fixed','clerk','accountant','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['clerk','accountant','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds the asset or schedule permissions beyond reads; tenant roles cover the fixed-asset clerk and the approver (noted for owner review).
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.fixed=await role('asset_clerk',['asset.create','asset.edit','asset.read','schedule.create','schedule.edit','schedule.read','evidence.upload','evidence.read','account.read','book.read','branch.read','party.read','bill.read','invoice.read','journal.read','period.read']);
  roles.approver=await role('asset_approver',['asset.approve','asset.events','asset.read','schedule.approve','schedule.pause','schedule.execute','schedule.read','evidence.read','task.read','journal.read','invoice.read','bill.read']);
  for(const [p,r] of [['fixed','fixed'],['clerk','clerk'],['accountant','accountant'],['accountant','approver'],['controller','controller'],['director','controller'],['director','approver'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'ast-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Plant Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const fixed=await ctxFor('fixed'),clerk=await ctxFor('clerk'),acc=await ctxFor('accountant'),dir=await ctxFor('director');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 const branch2=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'CEB',name:'Cebu plant',address:'Cebu'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),inTax=await mk('1300','Input tax','asset',{controlType:'input_tax'}),ar=await mk('1200','Receivables','asset',{controlType:'ar'}),outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'}),ap=await mk('2100','Payables','liability',{controlType:'ap'}),whtPay=await mk('2300','Withholding payable','liability'),adv=await mk('1400','Advances','asset');
 const prepaid=await mk('1450','Prepaid rent','asset'),empRec=await mk('1460','Employee receivables','asset'),clearing=await mk('1600','Asset clearing','asset'),dispClearing=await mk('1610','Disposal proceeds clearing','asset'),cip=await mk('1690','Construction in progress','asset'),equip=await mk('1700','Equipment','asset'),accDep=await mk('1710','Accumulated depreciation','asset'),deferred=await mk('2400','Deferred revenue','liability'),salPay=await mk('2500','Salaries payable','liability'),revenue=await mk('4000','Service revenue','income'),gainAcct=await mk('4300','Gain on disposal','income'),depExp=await mk('6100','Depreciation expense','expense'),rent=await mk('6200','Rent expense','expense'),lossAcct=await mk('6300','Loss on disposal and impairment','expense');
 const periods={};for(const [s,e] of [['2026-10-01','2026-10-31'],['2026-11-01','2026-11-30'],['2026-12-01','2026-12-31'],['2027-01-01','2027-01-31'],['2027-02-01','2027-02-28'],['2027-03-01','2027-03-31']])periods[s.slice(0,7)]=await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const approve=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await approve('sales_profile',{arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,scale:2,dueDays:30});
 await approve('purchasing_profile',{apAccountId:ap.id,inputTaxAccountId:inTax.id,cashAccountId:cash.id,withholdingPayableAccountId:whtPay.id,advanceAccountId:adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
 for(const [kind,prefix] of [['bill','BILL'],['invoice','INV']])await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branch.id,kind,prefix,principals.controller]));
 const supplier=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Machines Inc',roles:['supplier'],identityStatus:'unknown',address:'Laguna'},env));
 const customer=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Retainer Client',roles:['customer'],identityStatus:'unknown',address:'Taguig'},env));
 const employee=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Juan Dela Cruz',roles:['employee'],identityStatus:'unknown',address:'Pasig'},env));
 const store=new MemoryEvidenceStore();
 const upload=async(name,content,who=fixed)=>{const bytes=Buffer.from(content);const reg=await run(who,tx=>evidence.registerUpload(tx,who,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(who,tx=>evidence.completeUpload(tx,who,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const doc1=await upload('delivery-receipt.pdf','%PDF-1.4 delivery\n'),doc2=await upload('board-resolution.pdf','%PDF-1.4 resolution\n');
 const postBill=async(ref,lines,date='2026-10-05')=>{const d=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,{kind:'bill',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:date,accountingDate:date,currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:ref,lines,evidenceIds:[doc1]}));await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,d.id,{}));await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,d.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,d.id,{}));return d;};
 const machineBill=await postBill('MI-1001',[{description:'Packing machine',quantity:'1',unitPrice:'123000',discount:'0',priceBasis:'exclusive',accountId:clearing.id,dimensions:{}}]);
 const smallBill=await postBill('MI-1002',[{description:'Tools',quantity:'1',unitPrice:'4660',discount:'0',priceBasis:'exclusive',accountId:clearing.id,dimensions:{}}]);
 const cipBill=await postBill('MI-1003',[{description:'Warehouse extension works',quantity:'1',unitPrice:'50000',discount:'0',priceBasis:'exclusive',accountId:clearing.id,dimensions:{}}]);
 const rentBill=await postBill('LL-2026',[{description:'Rent Oct-Mar prepaid',quantity:'1',unitPrice:'12000',discount:'0',priceBasis:'exclusive',accountId:prepaid.id,dimensions:{}}]);
 const entryLines=async id=>(await run(acc,tx=>tx.query('select a.code,l.txn_debit::text as d,l.txn_credit::text as c from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entry_id=$2 order by l.line_no',[tenantId,id]))).rows.map(r=>r.code+' '+ledger.decimal(ledger.micros(r.d))+' '+ledger.decimal(ledger.micros(r.c)));
 const balance=async accountId=>ledger.decimal(ledger.signedMicros((await run(acc,tx=>tx.query('select coalesce(sum(func_debit-func_credit),0)::text as b from lara.journal_lines where tenant_id=$1 and account_id=$2',[tenantId,accountId]))).rows[0].b));
 await rejects(run(fixed,tx=>assets.createAsset(tx,fixed,entityId,{tag:'EQ-0',classId:randomUUID(),cost:'1',residual:'0',currency:'PHP',inServiceDate:'2026-10-01',usefulLifeMonths:1,method:'straight_line',sourceDocumentId:machineBill.id})),'FEATURE_NOT_ENABLED','assets before the capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'assets','active','p11.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 await approve('asset_profile',{assetClearingAccountId:clearing.id,disposalClearingAccountId:dispClearing.id,profileVersion:'assets-2026'});
 for(const p of [{code:'dep_monthly',kind:'depreciation',proration:'monthly'},{code:'dep_daily',kind:'depreciation',proration:'daily'},{code:'dep_syd',kind:'depreciation',proration:'monthly',method:'sum_of_years'},{code:'prepaid_rent',kind:'prepayment',debitAccountId:rent.id,creditAccountId:prepaid.id},{code:'retainer',kind:'deferred_revenue',debitAccountId:deferred.id,creditAccountId:revenue.id},{code:'salary_loan',kind:'employee_deduction',debitAccountId:salPay.id,creditAccountId:empRec.id},{code:'monthly_billing',kind:'recurring_invoice'}])await approve('recognition_policy_'+p.code,p);
 await rejects(run(fixed,tx=>assets.createAssetClass(tx,fixed,entityId,{code:'X',name:'x',assetAccountId:equip.id,accumulatedDepreciationAccountId:accDep.id,depreciationExpenseAccountId:depExp.id,disposalGainAccountId:gainAcct.id,disposalLossAccountId:lossAcct.id,defaultMethod:'straight_line',defaultUsefulLifeMonths:60})),'FORBIDDEN','the clerk cannot approve a class');
 const equipClass=await run(acc,tx=>assets.createAssetClass(tx,acc,entityId,{code:'EQUIP',name:'Equipment',assetAccountId:equip.id,accumulatedDepreciationAccountId:accDep.id,depreciationExpenseAccountId:depExp.id,disposalGainAccountId:gainAcct.id,disposalLossAccountId:lossAcct.id,defaultMethod:'straight_line',defaultUsefulLifeMonths:60,taxMethod:'declining_balance',taxUsefulLifeMonths:36}));
 const cipClass=await run(acc,tx=>assets.createAssetClass(tx,acc,entityId,{code:'BUILD','name':'Buildings (from CIP)',assetAccountId:equip.id,accumulatedDepreciationAccountId:accDep.id,depreciationExpenseAccountId:depExp.id,disposalGainAccountId:gainAcct.id,disposalLossAccountId:lossAcct.id,cipAccountId:cip.id,defaultMethod:'straight_line',defaultUsefulLifeMonths:240}));
 await rejects(run(acc,tx=>assets.createAssetClass(tx,acc,entityId,{code:'BAD',name:'x',assetAccountId:equip.id,accumulatedDepreciationAccountId:accDep.id,depreciationExpenseAccountId:revenue.id,disposalGainAccountId:gainAcct.id,disposalLossAccountId:lossAcct.id,defaultMethod:'straight_line',defaultUsefulLifeMonths:60})),'VALIDATION_FAILED','expense account required');
 pass('fixture: manufacturing entity with clearing, equipment, accumulated depreciation, CIP, prepaid, deferred revenue and deduction accounts, posted bills for the machine, tools, CIP works and prepaid rent, an approved asset profile, seven recognition policies and two classes approved by the accountant');

 // P11-T01 AC-08: 120,000 over 60 months posts 2,000; capitalization from the bill.
 const mk_asset=(body,who=fixed)=>run(who,tx=>assets.createAsset(tx,who,entityId,{currency:'PHP',residual:'0',method:'straight_line',...body}));
 await rejects(mk_asset({tag:'EQ-1',classId:equipClass.id,cost:'123001',inServiceDate:'2026-10-01',usefulLifeMonths:60,sourceDocumentId:machineBill.id}),'VALIDATION_FAILED','cost beyond the bill');
 await rejects(mk_asset({tag:'EQ-1',classId:equipClass.id,cost:'120000',inServiceDate:'2026-10-01',usefulLifeMonths:60,sourceDocumentId:rentBill.id}),'VALIDATION_FAILED','a bill without an asset clearing line');
 const eq1=await mk_asset({tag:'EQ-1',classId:equipClass.id,cost:'120000',inServiceDate:'2026-10-01',usefulLifeMonths:60,sourceDocumentId:machineBill.id});
 assert.equal(eq1.state,'draft');
 await rejects(run(fixed,tx=>assets.approveAsset(tx,fixed,entityId,eq1.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the clerk cannot approve');
 const approved=await run(acc,tx=>assets.approveAsset(tx,acc,entityId,eq1.id,{decision:'approve',contentVersion:1}));
 assert.deepEqual(await entryLines(approved.journalEntryIds[0]),['1700 120000.00 0.00','1600 0.00 120000.00'],'capitalization entry');
 await rejects(run(fixed,tx=>assets.updateAsset(tx,fixed,entityId,eq1.id,2,{tag:'EQ-1',classId:equipClass.id,cost:'120000',residual:'0',currency:'PHP',inServiceDate:'2026-10-01',usefulLifeMonths:48,method:'straight_line',sourceDocumentId:machineBill.id})),'STATE_CONFLICT','approved assets are not edited');
 await rejects(run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'depreciation',sourceId:eq1.id,startDate:'2026-10-01',endDate:'2031-09-30',basisAmount:'120000',currency:'PHP',policyVersion:'no_such'})),'RULE_PROFILE_NOT_APPROVED','policy must be approved');
 await rejects(run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'depreciation',sourceId:eq1.id,startDate:'2026-10-01',endDate:'2031-08-31',basisAmount:'120000',currency:'PHP',policyVersion:'dep_monthly'})),'VALIDATION_FAILED','end date follows the life');
 const dep1=await run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'depreciation',sourceId:eq1.id,startDate:'2026-10-01',endDate:'2031-09-30',basisAmount:'120000',currency:'PHP',policyVersion:'dep_monthly'}));
 let view=await run(fixed,tx=>assets.scheduleLines(tx,fixed,entityId,dep1.id));
 assert.equal(view.lines.length,60);assert.ok(view.lines.every(l=>l.amount==='2000.00'&&l.state==='planned'),'60 lines of 2,000');assert.equal(view.totalPlanned,'120000.00');
 await rejects(run(fixed,tx=>assets.approveSchedule(tx,fixed,entityId,dep1.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','clerk cannot approve the schedule');
 await rejects(run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-10'].id,scheduleIds:[dep1.id]})),'STATE_CONFLICT','a draft schedule does not run');
 await run(acc,tx=>assets.approveSchedule(tx,acc,entityId,dep1.id,{decision:'approve',contentVersion:1}));
 const runReq=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-10'].id,scheduleIds:[dep1.id]}));
 assert.equal(runReq.state,'queued');
 let ran=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,runReq.runId));
 assert.equal(ran.results[0].outcome,'posted');
 assert.deepEqual(await entryLines(ran.results[0].entryId),['6100 2000.00 0.00','1710 0.00 2000.00'],'AC-08: Dr depreciation expense 2,000; Cr accumulated depreciation 2,000');
 assert.equal((await run(fixed,tx=>assets.assetEvents(tx,fixed,entityId,eq1.id))).carryingAmount,'118000.00');
 // Residual and final month.
 const eq2=await mk_asset({tag:'EQ-2',classId:equipClass.id,cost:'1000',residual:'100',inServiceDate:'2026-10-01',usefulLifeMonths:7,sourceDocumentId:smallBill.id});
 await run(acc,tx=>assets.approveAsset(tx,acc,entityId,eq2.id,{decision:'approve',contentVersion:1}));
 const dep2=await run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'depreciation',sourceId:eq2.id,startDate:'2026-10-01',endDate:'2027-04-30',basisAmount:'900',currency:'PHP',policyVersion:'dep_monthly'}));
 view=await run(fixed,tx=>assets.scheduleLines(tx,fixed,entityId,dep2.id));
 assert.deepEqual(view.lines.map(l=>l.amount),['128.57','128.57','128.57','128.57','128.57','128.57','128.58'],'residual in the final month');
 // Method change: prospective sum-of-years over the remaining 35 months; October stays posted at 2,000.
 await rejects(run(fixed,tx=>assets.updateSchedule(tx,fixed,entityId,dep1.id,99,{kind:'depreciation',sourceId:eq1.id,startDate:'2026-10-01',endDate:'2029-09-30',basisAmount:'120000',currency:'PHP',policyVersion:'dep_syd'})),'VERSION_CONFLICT','If-Match');
 const dep1v=await run(fixed,tx=>assets.getSchedule(tx,fixed,entityId,dep1.id));
 await run(fixed,tx=>assets.updateSchedule(tx,fixed,entityId,dep1.id,dep1v.version,{kind:'depreciation',sourceId:eq1.id,startDate:'2026-10-01',endDate:'2029-09-30',basisAmount:'120000',currency:'PHP',policyVersion:'dep_syd'}));
 view=await run(fixed,tx=>assets.scheduleLines(tx,fixed,entityId,dep1.id));
 assert.equal(view.versions.length,2);assert.equal(view.versions[1].state,'draft');assert.equal(view.versions[1].effectiveFrom,'2026-11-01');assert.equal(view.versions[1].openingRecognized,'2000.00');
 assert.equal(view.lines[0].state,'posted');assert.equal(view.lines[0].amount,'2000.00');assert.equal(view.lines.length,36);assert.equal(view.totalPlanned,'118000.00');
 assert.equal(view.lines[1].amount,ledger.decimal(BigInt(Math.round(118000*35*24/(35*47)/12*100))*10000n,2),'first SYD year weight 35/(35+23+11 over 12)');
 let pend=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-11'].id,scheduleIds:[dep1.id]}));
 assert.equal((await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,pend.runId))).results[0].outcome,'pending_version','a pending prospective version holds the run');
 const sched1=await run(fixed,tx=>assets.getSchedule(tx,fixed,entityId,dep1.id));
 await run(dir,tx=>assets.approveSchedule(tx,dir,entityId,dep1.id,{decision:'approve',contentVersion:sched1.contentVersion}));
 view=await run(fixed,tx=>assets.scheduleLines(tx,fixed,entityId,dep1.id));
 assert.equal(view.versions[0].state,'superseded');assert.equal(view.versions[1].state,'approved');assert.equal(view.versionNo,2);
 pend=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-11'].id,scheduleIds:[dep1.id]}));
 ran=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,pend.runId));assert.equal(ran.results[0].outcome,'posted');
 assert.deepEqual(await entryLines(ran.results[0].entryId),['6100 '+view.lines[1].amount+' 0.00','1710 0.00 '+view.lines[1].amount],'November posts the approved sum-of-years amount');
 // Leap-year daily policy: 3,660 over twelve months from 1 March 2027 gives 10 a day; February 2028 carries 290.
 const eq3=await mk_asset({tag:'EQ-3',classId:equipClass.id,cost:'3660',inServiceDate:'2027-03-01',usefulLifeMonths:12,sourceDocumentId:smallBill.id});
 await run(acc,tx=>assets.approveAsset(tx,acc,entityId,eq3.id,{decision:'approve',contentVersion:1}));
 const dep3=await run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'depreciation',sourceId:eq3.id,startDate:'2027-03-01',endDate:'2028-02-29',basisAmount:'3660',currency:'PHP',policyVersion:'dep_daily'}));
 view=await run(fixed,tx=>assets.scheduleLines(tx,fixed,entityId,dep3.id));
 assert.equal(view.lines.length,12);assert.equal(view.lines[11].periodStart,'2028-02-01');assert.equal(view.lines[11].amount,'290.00');assert.equal(view.lines[0].amount,'310.00');assert.equal(view.totalPlanned,'3660.00');
 pass('P11-T01: AC-08 posts Dr 6100 2,000 / Cr 1710 2,000 from the approved 60-line schedule; capitalization Dr 1700 / Cr 1600 from the bill; the residual lands in the final month (128.58); the method change is a prospective version from November with October untouched; the daily policy counts 29 February');

 // P11-T02: a rerun posts once; a locked period raises a task.
 const rerun=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-10'].id,scheduleIds:[dep1.id]}));
 ran=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,rerun.runId));
 assert.equal(ran.results[0].outcome,'already_executed');
 assert.equal((await run(acc,tx=>tx.query("select count(*)::int as n from lara.journal_entries where tenant_id=$1 and source_type='schedule_line'",[tenantId]))).rows[0].n,2,'October and November postings only');
 await run(ctrl,tx=>ledger.softClosePeriod(tx,ctrl,entityId,periods['2026-12'].id,{reason:'Close'}));await run(ctrl,tx=>ledger.lockPeriod(tx,ctrl,entityId,periods['2026-12'].id,{reason:'Lock'}));
 const lockedRun=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-12'].id,scheduleIds:[dep1.id]}));
 ran=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,lockedRun.runId));
 assert.equal(ran.state,'completed_with_tasks');assert.equal(ran.results[0].outcome,'blocked');assert.ok(ran.results[0].taskId,'task raised');
 await rejects(run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-12'].id,scheduleIds:[dep2.id]})),'STATE_CONFLICT','a draft schedule is refused at request');
 const task=(await run(acc,tx=>tx.query('select * from lara.tasks where tenant_id=$1 and id=$2',[tenantId,ran.results[0].taskId]))).rows[0];
 assert.equal(task.kind,'schedule_blocked');assert.equal(task.status,'open');
 view=await run(fixed,tx=>assets.scheduleLines(tx,fixed,entityId,dep1.id));
 assert.equal(view.lines.find(l=>l.periodStart==='2026-12-01').state,'blocked');
 const again=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-12'].id,scheduleIds:[dep1.id]}));
 ran=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,again.runId));
 assert.equal(ran.results[0].taskId,task.id,'the same open task, not a second one');
 await rejects(run(acc,tx=>tx.query("update lara.schedule_lines set amount=amount+1 where tenant_id=$1 and schedule_id=$2 and state='posted'",[tenantId,dep1.id])),'STATE_CONFLICT','posted lines are immutable');
 await rejects(run(acc,tx=>tx.query("delete from lara.schedule_lines where tenant_id=$1 and schedule_id=$2 and state='posted'",[tenantId,dep1.id])),'STATE_CONFLICT','posted lines cannot be deleted');
 pass('P11-T02: the rerun answers already_executed and posts nothing; the locked December run blocks the line and opens one schedule_blocked task that a second run reuses; posted lines are immutable');

 // P11-T03: split and merge conserve; disposal gain and loss.
 const eq4=await mk_asset({tag:'EQ-4',classId:equipClass.id,cost:'3000',residual:'0',inServiceDate:'2026-10-01',usefulLifeMonths:30,sourceDocumentId:machineBill.id});
 await run(acc,tx=>assets.approveAsset(tx,acc,entityId,eq4.id,{decision:'approve',contentVersion:1}));
 const dep4=await run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'depreciation',sourceId:eq4.id,startDate:'2026-10-01',endDate:'2029-03-31',basisAmount:'3000',currency:'PHP',policyVersion:'dep_monthly'}));
 await run(acc,tx=>assets.approveSchedule(tx,acc,entityId,dep4.id,{decision:'approve',contentVersion:1}));
 for(const p of ['2026-10','2026-11']){const r=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods[p].id,scheduleIds:[dep4.id]}));const x=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,r.runId));assert.equal(x.results[0].outcome,'posted');}
 let ev=await run(fixed,tx=>assets.assetEvents(tx,fixed,entityId,eq4.id));
 assert.equal(ev.accumulatedDepreciation,'200.00');
 await rejects(run(fixed,tx=>assets.recordAssetEvent(tx,fixed,entityId,eq4.id,{kind:'split',effectiveDate:'2027-01-01',amount:'1000',reason:'x',evidenceIds:[doc2]})),'FORBIDDEN','the clerk records no events');
 await rejects(run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,eq4.id,{kind:'split',effectiveDate:'2026-11-15',amount:'1000',reason:'Backdated',evidenceIds:[doc2]})),'STATE_CONFLICT','posted periods are never rewritten');
 await rejects(run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,eq4.id,{kind:'split',effectiveDate:'2027-01-01',amount:'1000',reason:'No evidence',evidenceIds:[randomUUID()]})),'EVIDENCE_NOT_READY','evidence must be available');
 const split=await run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,eq4.id,{kind:'split',effectiveDate:'2027-01-01',amount:'1000',reason:'Conveyor separated from the line',evidenceIds:[doc2]}));
 assert.equal(split.journalEntryIds.length,0,'a split within one class posts nothing');
 const parent=await run(fixed,tx=>assets.assetEvents(tx,fixed,entityId,eq4.id)),child=await run(fixed,tx=>assets.assetEvents(tx,fixed,entityId,split.childAssetId));
 assert.equal(parent.cost,'2000.00');assert.equal(parent.accumulatedDepreciation,'133.33');assert.equal(child.cost,'1000.00');assert.equal(child.accumulatedDepreciation,'66.67');assert.equal(child.tag,'EQ-4-S1');
 assert.equal(parent.components[0].assetId,split.childAssetId);
 view=await run(fixed,tx=>assets.scheduleLines(tx,fixed,entityId,dep4.id));
 assert.equal(view.versions.length,2);assert.equal(view.versions[1].state,'approved');assert.equal(view.totalExecuted,'200.00');assert.equal(view.totalPlanned,'1866.67','2,000 cost less 133.33 accumulated remains');
 // Merge the child back: cost and accumulated depreciation return to 3,000 / 200.
 const merge=await run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,eq4.id,{kind:'merge',effectiveDate:'2027-01-01',relatedAssetIds:[split.childAssetId],reason:'Reassembled',evidenceIds:[doc2]}));
 assert.equal(merge.journalEntryIds.length,0);
 ev=await run(fixed,tx=>assets.assetEvents(tx,fixed,entityId,eq4.id));
 assert.equal(ev.cost,'3000.00');assert.equal(ev.accumulatedDepreciation,'200.00');assert.equal(ev.components.length,2);
 assert.equal((await run(fixed,tx=>assets.getAsset(tx,fixed,entityId,split.childAssetId))).state,'merged');
 // Disposal: carrying 2,800 sold for 3,100 is a 300 gain; EQ-2 (1,000, nothing posted) scrapped for 0 is a 1,000 loss.
 const disposal=await run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,eq4.id,{kind:'disposal',effectiveDate:'2027-01-15',proceeds:'3100',reason:'Sold to a reseller',evidenceIds:[doc2]}));
 assert.deepEqual(await entryLines(disposal.journalEntryIds[0]),['1610 3100.00 0.00','1710 200.00 0.00','1700 0.00 3000.00','4300 0.00 300.00'],'disposal with gain');
 assert.equal(disposal.state,'disposed');
 assert.equal((await run(fixed,tx=>assets.getSchedule(tx,fixed,entityId,dep4.id))).state,'completed','the schedule ends with the disposal');
 await rejects(run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,eq4.id,{kind:'transfer',effectiveDate:'2027-02-01',targetLocationId:branch2.id,reason:'x',evidenceIds:[doc2]})),'STATE_CONFLICT','a disposed asset has no further events');
 const scrap=await run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,eq2.id,{kind:'disposal',effectiveDate:'2027-01-15',proceeds:'0',reason:'Scrapped',evidenceIds:[doc2]}));
 assert.deepEqual(await entryLines(scrap.journalEntryIds[0]),['1700 0.00 1000.00','6300 1000.00 0.00'],'disposal at a loss');
 // Impairment reduces the carrying amount and the open lines; transfer changes the location only.
 const imp=await run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,eq1.id,{kind:'impairment',effectiveDate:'2027-01-01',amount:'18000',reason:'Damage assessed',evidenceIds:[doc2]}));
 assert.deepEqual(await entryLines(imp.journalEntryIds[0]),['6300 18000.00 0.00','1710 0.00 18000.00']);
 const moved=await run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,eq1.id,{kind:'transfer',effectiveDate:'2027-01-02',targetLocationId:branch2.id,reason:'Moved to Cebu',evidenceIds:[doc2]}));
 assert.equal(moved.journalEntryIds.length,0);assert.equal((await run(fixed,tx=>assets.getAsset(tx,fixed,entityId,eq1.id))).locationId,branch2.id);
 // CIP: no depreciation until capitalized into service.
 const bld=await mk_asset({tag:'BLD-1',classId:cipClass.id,cost:'50000',inServiceDate:'2027-03-01',usefulLifeMonths:240,sourceDocumentId:cipBill.id});
 await rejects(mk_asset({tag:'BLD-2',classId:cipClass.id,cost:'1',inServiceDate:'2027-03-01',usefulLifeMonths:240,sourceDocumentId:cipBill.id}),'VALIDATION_FAILED','the CIP bill is fully drawn by BLD-1');
 const bldOk=await run(acc,tx=>assets.approveAsset(tx,acc,entityId,bld.id,{decision:'approve',contentVersion:1}));
 assert.deepEqual(await entryLines(bldOk.journalEntryIds[0]),['1690 50000.00 0.00','1600 0.00 50000.00'],'CIP capitalization goes to the CIP account');
 await rejects(run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'depreciation',sourceId:bld.id,startDate:'2027-03-01',endDate:'2047-02-28',basisAmount:'50000',currency:'PHP',policyVersion:'dep_monthly'})),'STATE_CONFLICT','CIP does not depreciate');
 const inService=await run(acc,tx=>assets.recordAssetEvent(tx,acc,entityId,bld.id,{kind:'capitalize_cip',effectiveDate:'2027-03-01',reason:'Ready for use',evidenceIds:[doc2]}));
 assert.deepEqual(await entryLines(inService.journalEntryIds[0]),['1700 50000.00 0.00','1690 0.00 50000.00']);
 const depB=await run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'depreciation',sourceId:bld.id,startDate:'2027-03-01',endDate:'2047-02-28',basisAmount:'50000',currency:'PHP',policyVersion:'dep_monthly'}));
 assert.equal((await run(fixed,tx=>assets.scheduleLines(tx,fixed,entityId,depB.id))).lines.length,240);
 pass('P11-T03: split moves 1,000 cost and 66.67 of 200 accumulated to EQ-4-S1 (parent 2,000 / 133.33) and merge returns 3,000 / 200; disposal for 3,100 posts Dr 1610 3,100, Dr 1710 200, Cr 1700 3,000, Cr 4300 300; scrapping posts the 1,000 loss; impairment, transfer and CIP capitalization behave');

 // P11-T04: deferred revenue schedule totals the contract with the residue last; prepayment and deduction schedules.
 const invoice=await run(clerk,tx=>sales.createDocument(tx,clerk,entityId,{kind:'invoice',branchId:branch.id,bookId:book.id,partyId:customer.id,documentDate:'2026-10-01',accountingDate:'2026-10-01',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Retainer Oct-Mar',quantity:'1',unitPrice:'10000',discount:'0',priceBasis:'exclusive',accountId:deferred.id,dimensions:{}}],evidenceIds:[]}));
 await run(clerk,tx=>sales.submitDocument(tx,clerk,entityId,invoice.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,invoice.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>sales.postDocument(tx,acc,entityId,invoice.id,{}));
 await rejects(run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'deferred_revenue',sourceId:invoice.id,startDate:'2026-10-01',endDate:'2027-03-31',basisAmount:'10001',currency:'PHP',policyVersion:'retainer'})),'VALIDATION_FAILED','basis beyond the deferral line');
 const defer=await run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'deferred_revenue',sourceId:invoice.id,startDate:'2026-10-01',endDate:'2027-03-31',basisAmount:'10000',currency:'PHP',policyVersion:'retainer'}));
 view=await run(fixed,tx=>assets.scheduleLines(tx,fixed,entityId,defer.id));
 assert.deepEqual(view.lines.map(l=>l.amount),['1666.67','1666.67','1666.67','1666.67','1666.67','1666.65'],'the residue lands in March');assert.equal(view.totalPlanned,'10000.00');
 await run(acc,tx=>assets.approveSchedule(tx,acc,entityId,defer.id,{decision:'approve',contentVersion:1}));
 let r=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-10'].id,scheduleIds:[defer.id]}));ran=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,r.runId));
 assert.deepEqual(await entryLines(ran.results[0].entryId),['2400 1666.67 0.00','4000 0.00 1666.67']);
 const pre=await run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'prepayment',sourceId:rentBill.id,startDate:'2026-10-01',endDate:'2027-03-31',basisAmount:'12000',currency:'PHP',policyVersion:'prepaid_rent'}));
 await run(acc,tx=>assets.approveSchedule(tx,acc,entityId,pre.id,{decision:'approve',contentVersion:1}));
 r=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-10'].id,scheduleIds:[pre.id]}));ran=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,r.runId));
 assert.deepEqual(await entryLines(ran.results[0].entryId),['6200 2000.00 0.00','1450 0.00 2000.00']);
 assert.equal(await balance(prepaid.id),'10000.00');
 // Pause stops execution; resume restores it.
 await run(acc,tx=>assets.pauseSchedule(tx,acc,entityId,pre.id,{reason:'Lease dispute'}));
 r=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-11'].id,scheduleIds:[pre.id]}));ran=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,r.runId));
 assert.equal(ran.results[0].outcome,'paused');
 await run(acc,tx=>assets.pauseSchedule(tx,acc,entityId,pre.id,{reason:'Resolved'}));
 assert.equal((await run(fixed,tx=>assets.getSchedule(tx,fixed,entityId,pre.id))).state,'approved');
 // Recurring drafts: the deduction schedule drafts a journal; a recurring invoice drafts an invoice; neither posts.
 const loan=await run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'employee_deduction',sourceId:employee.id,startDate:'2026-10-01',endDate:'2026-12-31',basisAmount:'1000',currency:'PHP',policyVersion:'salary_loan'}));
 await run(acc,tx=>assets.approveSchedule(tx,acc,entityId,loan.id,{decision:'approve',contentVersion:1}));
 const recur=await run(fixed,tx=>assets.createSchedule(tx,fixed,entityId,{kind:'recurring_invoice',sourceId:invoice.id,startDate:'2026-11-01',endDate:'2027-03-31',basisAmount:'10000',currency:'PHP',policyVersion:'monthly_billing'}));
 await run(acc,tx=>assets.approveSchedule(tx,acc,entityId,recur.id,{decision:'approve',contentVersion:1}));
 r=await run(acc,tx=>assets.requestScheduleRun(tx,acc,entityId,{periodId:periods['2026-11'].id,scheduleIds:[loan.id,recur.id]}));ran=await run(acc,tx=>assets.executeScheduleRun(tx,acc,entityId,r.runId,{sales,ledger}));
 assert.equal(ran.results[0].outcome,'drafted');assert.equal(ran.results[1].outcome,'drafted');
 const draftJournal=(await run(acc,tx=>tx.query('select * from lara.journal_drafts where tenant_id=$1 and id=$2',[tenantId,ran.results[0].resourceId]))).rows[0];
 assert.equal(draftJournal.status,'draft');assert.equal(draftJournal.lines[0].debit,'333.33');
 const draftInvoice=(await run(acc,tx=>tx.query('select * from lara.documents where tenant_id=$1 and id=$2',[tenantId,ran.results[1].resourceId]))).rows[0];
 assert.equal(draftInvoice.state,'draft');assert.equal(draftInvoice.kind,'invoice');assert.equal(ledger.decimal(ledger.micros(String(draftInvoice.net))),'10000.00');
 pass('P11-T04: the 10,000 retainer over six months posts 1,666.67 with 1,666.65 in March and totals the contract; prepaid rent recognizes 2,000 (Dr 6200 / Cr 1450); pause skips the run and resume restores; the deduction and recurring invoice schedules draft a journal and an invoice for review and post nothing');

 // P11-T05: book and tax layers reconcile independently and reproduce from the rule version.
 const layers=await run(fixed,tx=>assets.bookTaxLayers(tx,fixed,entityId,eq1.id));
 assert.equal(layers.ruleVersion,'tax:declining_balance:36');
 assert.equal(layers.layers.length,2);
 assert.equal(layers.layers[0].bookDepreciation,'2000.00');assert.equal(layers.layers[0].bookValue,'118000.00');
 // Tax: double-declining over 36 months = 24/36 a year on 120,000 → 6,666.67 in the first month.
 assert.equal(layers.layers[0].taxDepreciation,'6666.67');assert.equal(layers.layers[0].taxValue,'113333.33');assert.equal(layers.layers[0].difference,'4666.67');
 const taxLines=assets.depreciationLines({cost:m(120000),residual:0n,months:36,startDate:'2026-10-01',method:'declining_balance'});
 assert.equal(ledger.decimal(taxLines[1].amount),layers.layers[1].taxDepreciation,'the tax layer reproduces from the rule');
 assert.equal(ledger.decimal(taxLines.reduce((s,l)=>s+l.amount,0n)),'120000.00');
 const again2=await run(fixed,tx=>assets.bookTaxLayers(tx,fixed,entityId,eq1.id));
 assert.equal(again2.checksum,layers.checksum,'deterministic');
 const bookAcc=await balance(accDep.id);
 const registerAcc=(await run(acc,tx=>tx.query("select coalesce(sum(accumulated_depreciation),0)::text as v from lara.assets where tenant_id=$1 and entity_id=$2 and state='approved'",[tenantId,entityId]))).rows[0].v;
 assert.equal(bookAcc,'-'+ledger.decimal(ledger.micros(registerAcc)),'the register accumulated depreciation ties to the ledger balance (credit)');
 await rejects(run(acc,tx=>tx.query('update lara.book_tax_layers set tax_value=0 where tenant_id=$1',[tenantId])),'FORBIDDEN','layers are append-only (no update grant)');
 const report=await run(acc,tx=>assets.reportBuilders.asset_register(tx,acc,entityId,{}));
 const eq1View=await run(fixed,tx=>assets.assetEvents(tx,fixed,entityId,eq1.id));
 assert.equal(report.lines.find(l=>l.tag==='EQ-1').carryingAmount,eq1View.carryingAmount,'register report');assert.equal(eq1View.carryingAmount,'94978.72','120,000 less 2,000, less the November sum-of-years 5,021.28, less the 18,000 impairment');
 pass('P11-T05: book layers (2,000 straight-line) and tax layers (6,666.67 double-declining over 36 months) sit side by side per period, reproduce from the rule version with a stable checksum, the register ties to the accumulated depreciation balance, and the layers are append-only');
 console.log('P11-02 domain acceptance passed ('+step+' groups)');
}finally{
 try{await removeTenants(owner,[tenantId]);}catch(e){console.error('teardown failed',e.message);}
 await Promise.all([api.end(),owner.end()]);
}
