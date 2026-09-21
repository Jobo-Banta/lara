// P16-02 planning domain against real PostgreSQL through the runtime role:
// P16-T01 two simultaneous commitments cannot overspend a blocking budget;
// P16-T02 a bill against the order consumes the commitment without double
// counting; P16-T03 the allocation residual preserves the exact pool and a
// rerun is refused; P16-T04 a progress invoice recoups the advance, holds
// retention and the release settles the control account; P16-T05 a change
// order is a visible approved version and past billing is unchanged.
// Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales,purchasing,planning} from '../packages/domain/src/index.mjs';
const {MemoryEvidenceStore,FixtureScanner}=evidence;
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
process.env.FIELD_ENCRYPTION_KEY??=randomBytes(32).toString('hex');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:60000});
const api=client(process.env.DATABASE_URL),api2=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),api2.connect(),owner.connect()]);
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
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-plan-'+suffix,name:'Planning domain',mode:'demo'});
  for(const n of ['clerk','purchaser','billing','accountant','treasury','controller','director','security','planner','pm'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['clerk','billing','accountant','treasury','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds the purchase order, budget, allocation or project authorities; tenant roles cover the purchaser, the planner (budgets, rules, runs, projects) and the project manager (certification, billing, approvals) — noted for owner review.
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.purchaser=await role('purchaser',['purchase_order.create','purchase_order.edit','purchase_order.read','purchase_order.submit','purchase_order.cancel','bill.read','party.read']);
  roles.planner=await role('planner',['budget.create','budget.edit','budget.read','allocation_run.create','allocation_run.edit','allocation_run.read','allocation_run.preview','project.create','project.edit','project.read']);
  roles.pm=await role('project_manager',['budget.approve','budget.activate','budget.read','allocation_run.approve','allocation_run.post','allocation_run.read','project.read','project.progress_billing','purchase_order.approve','purchase_order.read']);
  for(const [p,r] of [['clerk','clerk'],['purchaser','purchaser'],['billing','billing'],['accountant','accountant'],['treasury','treasury'],['controller','controller'],['director','controller'],['security','security_admin'],['planner','planner'],['pm','pm']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=(n,db=api)=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'plan-'+n}),db);
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Planning Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const clerk=await ctxFor('clerk'),buyer=await ctxFor('purchaser'),bill=await ctxFor('billing'),acc=await ctxFor('accountant'),tre=await ctxFor('treasury'),dir=await ctxFor('director'),plan=await ctxFor('planner'),pm=await ctxFor('pm');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing','treasury','compliance','inventory','assets'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),ar=await mk('1200','Receivables','asset',{controlType:'ar'}),retention=await mk('1250','Retention receivable','asset'),inTax=await mk('1300','Input tax','asset',{controlType:'input_tax'}),adv=await mk('1400','Advances','asset'),ap=await mk('2100','Payables','liability',{controlType:'ap'}),outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'}),whtPay=await mk('2300','Withholding payable','liability'),revenue=await mk('4000','Contract revenue','income'),fees=await mk('5000','Professional fees','expense'),rent=await mk('5200','Rent','expense'),overhead=await mk('5900','Allocated overhead','expense');
 const periods={};for(const [s,e] of [['2026-09-01','2026-09-30'],['2026-10-01','2026-10-31']])periods[s.slice(0,7)]=await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const settle=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await settle('sales_profile',{arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:cash.id,scale:2,dueDays:30});
 await settle('purchasing_profile',{apAccountId:ap.id,inputTaxAccountId:inTax.id,cashAccountId:cash.id,withholdingPayableAccountId:whtPay.id,advanceAccountId:adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
 for(const [kind,prefix] of [['invoice','INV'],['bill','BILL']])await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branch.id,kind,prefix,principals.controller]));
 const supplier=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Supplies Inc',roles:['supplier'],identityStatus:'unknown',address:'Cebu'},env));
 const customer=await run(clerk,tx=>parties.createParty(tx,clerk,entityId,{legalName:'Build Corp',roles:['customer'],identityStatus:'unknown',address:'Makati'},env));
 const upload=async(name)=>{const bytes=Buffer.from('%PDF-1.4 '+name+String.fromCharCode(10));const reg=await run(clerk,tx=>evidence.registerUpload(tx,clerk,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(clerk,tx=>evidence.completeUpload(tx,clerk,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const line=(accountId,unitPrice,extra={})=>({description:'Services',quantity:'1',unitPrice,discount:'0',priceBasis:'exclusive',accountId,dimensions:{},...extra});
 const doc=(kind,partyId,lines,extra={})=>({kind,branchId:branch.id,bookId:book.id,partyId,documentDate:'2026-10-05',accountingDate:'2026-10-05',currency:'PHP',ruleProfileVersion:'ph-2026',lines,evidenceIds:[],...extra});
 const journal=async(lines,description,date='2026-10-05')=>{const j=await run(acc,tx=>ledger.createJournal(tx,acc,entityId,{bookId:book.id,accountingDate:date,documentDate:date,currency:'PHP',description,lines:lines.map(([accountId,debit,credit,dimensions={}])=>({accountId,branchId:branch.id,debit,credit,dimensions})),evidenceIds:[]}));await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,j.id,{}));await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,j.id,{decision:'approve',contentVersion:1}));await run(ctrl,tx=>ledger.postJournal(tx,ctrl,entityId,j.id,{}));return j;};
 const budgetBody={periodStart:'2026-10-01',periodEnd:'2026-10-31',currency:'PHP',policy:'block',lines:[{accountId:fees.id,dimensions:{},amount:'10000.00'},{accountId:rent.id,dimensions:{},amount:'5000.00'}]};
 await rejects(run(plan,tx=>planning.createBudget(tx,plan,entityId,budgetBody)),'FEATURE_NOT_ENABLED','budgets before the capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'planning','active','p16.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 pass('fixture: entity with the purchasing chain, planning active, a supplier and a customer, a purchaser, a planner and a project manager');

 // Budgets: versioned, approved and activated by others; availability.
 await rejects(run(plan,tx=>planning.createBudget(tx,plan,entityId,{...budgetBody,currency:'USD'})),'VALIDATION_FAILED','budgets in the functional currency');
 await rejects(run(plan,tx=>planning.createBudget(tx,plan,entityId,{...budgetBody,lines:[budgetBody.lines[0],budgetBody.lines[0]]})),'VALIDATION_FAILED','one bucket per account and dimensions');
 const b1=await run(plan,tx=>planning.createBudget(tx,plan,entityId,budgetBody));
 assert.equal(b1.state,'draft');
 await rejects(run(plan,tx=>planning.approveBudget(tx,plan,entityId,b1.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the planner does not approve');
 await run(pm,tx=>planning.approveBudget(tx,pm,entityId,b1.id,{decision:'approve',contentVersion:1}));
 await rejects(run(plan,tx=>planning.updateBudget(tx,plan,entityId,b1.id,undefined,budgetBody)),'STATE_CONFLICT','approved budgets are immutable');
 await run(pm,tx=>planning.activateBudget(tx,pm,entityId,b1.id,{reason:'Board approved'}));
 let avail=await run(plan,tx=>planning.availability(tx,plan,entityId,b1.id));
 assert.deepEqual(avail.lines.map(l=>[l.code,l.budget,l.actual,l.committed,l.available]),[['5000','10000.00','0.00','0.00','10000.00'],['5200','5000.00','0.00','0.00','5000.00']]);
 pass('a budget version drafted by the planner, approved and activated by the project manager, immutable once approved, with its availability per bucket');

 // P16-T01: two simultaneous commitments against a blocking bucket.
 const poFor=async(amount,who=buyer)=>{const po=await run(who,tx=>purchasing.createDocument(tx,who,entityId,doc('purchase_order',supplier.id,[line(fees.id,amount)])));await run(who,tx=>purchasing.submitDocument(tx,who,entityId,po.id,{}));return po;};
 const po1=await poFor('7000'),po2=await poFor('6000');
 const pm2=await ctxFor('pm',api2);
 // Both approvals start together; the bucket lock serializes them so the second sees the first and the blocking policy refuses it.
 const first=inTransaction(api,pm,async tx=>{const r=await purchasing.approveDocument(tx,pm,entityId,po1.id,{decision:'approve',contentVersion:1});await new Promise(res=>setTimeout(res,800));return r;});
 await new Promise(res=>setTimeout(res,200));
 const second=inTransaction(api2,pm2,tx=>purchasing.approveDocument(tx,pm2,entityId,po2.id,{decision:'approve',contentVersion:1})).then(r=>({ok:r}),e=>({error:e}));
 const r1=await first;assert.equal(r1.state,'approved');
 const r2=await second;assert.ok(r2.error instanceof DomainError,'the second commitment is refused');assert.equal(r2.error.code,'STATE_CONFLICT');assert.match(r2.error.message,/Budget exceeded/);
 avail=await run(plan,tx=>planning.availability(tx,plan,entityId,b1.id));
 assert.deepEqual(avail.lines[0].committed,'7000.00');assert.equal(avail.lines[0].available,'3000.00');
 // The authorized approver overrides with a recorded reason; a plain approver cannot.
 await rejects(run(ctrl,tx=>purchasing.approveDocument(tx,ctrl,entityId,po2.id,{decision:'approve',contentVersion:1,reason:'Urgent'})),'STATE_CONFLICT','an approver without budget authority cannot override');
 await run(pm,tx=>purchasing.approveDocument(tx,pm,entityId,po2.id,{decision:'approve',contentVersion:1,reason:'Board-approved overrun for the audit'}));
 const commitments=await run(plan,tx=>planning.listCommitments(tx,plan,entityId,{}));
 assert.equal(commitments.items.length,2);assert.equal(commitments.items.find(c=>c.sourceId===po2.id).overrideReason,'Board-approved overrun for the audit');
 avail=await run(plan,tx=>planning.availability(tx,plan,entityId,b1.id));
 assert.equal(avail.lines[0].available,'-3000.00');assert.equal(avail.lines[0].overrides,1);
 // Cancellation releases; a warn budget records a warning instead.
 await run(buyer,tx=>purchasing.cancelDocument(tx,buyer,entityId,po2.id,{reason:'Withdrawn'}));
 avail=await run(plan,tx=>planning.availability(tx,plan,entityId,b1.id));assert.equal(avail.lines[0].available,'3000.00');
 pass('P16-T01: two simultaneous commitments serialize on the budget bucket; the second is refused by the blocking policy, an override needs budget authority and a recorded reason, cancellation releases the commitment');

 // P16-T02: the bill against the order consumes the commitment, no double counting.
 const siPo1=await upload('si-po1.pdf');
 const bill1=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,doc('bill',supplier.id,[line(fees.id,'7000')],{externalReference:'SI-PO1',sourceDocumentId:po1.id,evidenceIds:[siPo1]})));
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,bill1.id,{}));await run(ctrl,tx=>purchasing.approveDocument(tx,ctrl,entityId,bill1.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,bill1.id,{}));
 avail=await run(plan,tx=>planning.availability(tx,plan,entityId,b1.id));
 assert.deepEqual([avail.lines[0].actual,avail.lines[0].committed,avail.lines[0].available],['7000.00','0.00','3000.00'],'the actual took over from the commitment');
 const consumed=(await run(plan,tx=>planning.listCommitments(tx,plan,entityId,{status:'consumed'}))).items;
 assert.equal(consumed.length,1);assert.equal(consumed[0].consumed,'7000.00');
 // A bill without an order counts as actual only.
 const siRent=await upload('si-rent.pdf');
 const bill2=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,doc('bill',supplier.id,[line(rent.id,'1500')],{externalReference:'SI-RENT',evidenceIds:[siRent]})));
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,bill2.id,{}));await run(ctrl,tx=>purchasing.approveDocument(tx,ctrl,entityId,bill2.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,bill2.id,{}));
 avail=await run(plan,tx=>planning.availability(tx,plan,entityId,b1.id));assert.equal(avail.lines[1].available,'3500.00');
 // Review correction: reversing a posting gives the budget back; the reversal nets the original instead of the original standing alone.
 const wrongRent=await journal([[rent.id,'800.00','0'],[cash.id,'0','800.00']],'Rent posted twice','2026-10-06');
 avail=await run(plan,tx=>planning.availability(tx,plan,entityId,b1.id));assert.equal(avail.lines[1].available,'2700.00');
 const undo=await run(acc,tx=>ledger.reverseJournal(tx,acc,entityId,wrongRent.id,{accountingDate:'2026-10-07',reason:'Posted twice'}));
 await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,undo.resourceId,{}));await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,undo.resourceId,{decision:'approve',contentVersion:1}));await run(ctrl,tx=>ledger.postJournal(tx,ctrl,entityId,undo.resourceId,{}));
 avail=await run(plan,tx=>planning.availability(tx,plan,entityId,b1.id));assert.deepEqual([avail.lines[1].actual,avail.lines[1].available],['1500.00','3500.00'],'the reversed posting no longer consumes the budget');
 pass('P16-T02: the bill posting against the order consumes the commitment and becomes the actual once; a bill without an order is actual only');

 // P16-T03: allocation residual and no duplicate rerun.
 const cc=[randomUUID(),randomUUID(),randomUUID()];
 const driverEvidence=await upload('drivers.pdf');
 await rejects(run(plan,tx=>planning.createRule(tx,plan,entityId,{code:'OVH',name:'Overhead',bookId:book.id,sourceAccountIds:[fees.id,rent.id],targetAccountId:overhead.id,drivers:[{dimensions:{cost_center:cc[0]},weight:'0'}],effectiveFrom:'2026-01-01'})),'VALIDATION_FAILED','driver total must be positive');
 await rejects(run(plan,tx=>planning.createRule(tx,plan,entityId,{code:'OVH',name:'Overhead',bookId:book.id,sourceAccountIds:[ap.id],targetAccountId:overhead.id,drivers:[{dimensions:{cost_center:cc[0]},weight:'1'}],effectiveFrom:'2026-01-01'})),'VALIDATION_FAILED','control accounts are never allocated');
 const rule=await run(plan,tx=>planning.createRule(tx,plan,entityId,{code:'OVH',name:'Overhead',bookId:book.id,sourceAccountIds:[fees.id,rent.id],targetAccountId:overhead.id,drivers:[{dimensions:{cost_center:cc[0]},weight:'1'},{dimensions:{cost_center:cc[1]},weight:'1'},{dimensions:{cost_center:cc[2]},weight:'1'}],effectiveFrom:'2026-01-01'}));
 await rejects(run(plan,tx=>planning.approveRule(tx,plan,entityId,rule.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the planner does not approve rules');
 await run(pm,tx=>planning.approveRule(tx,pm,entityId,rule.id,{decision:'approve',contentVersion:1}));
 const runBody={ruleVersionId:rule.id,periodId:periods['2026-10'].id,sourceCutoff:'2026-11-05T00:00:00.000Z',driverEvidenceId:driverEvidence};
 const ar1=await run(plan,tx=>planning.createRun(tx,plan,entityId,runBody));
 await run(plan,tx=>planning.previewRun(tx,plan,entityId,ar1.id,{}));
 let lines=await run(plan,tx=>planning.runLines(tx,plan,entityId,ar1.id));
 // Pool 8,500 (fees 7,000 + rent 1,500) over three equal drivers: 2,833.33 + 2,833.33 + 2,833.33 = 8,499.99; the residual cent sits on the first driver.
 assert.equal(lines.pool,'8500.00');assert.deepEqual(lines.lines.map(l=>[l.amount,l.residual]),[['2833.34',true],['2833.33',false],['2833.33',false]]);
 assert.equal(lines.lines.reduce((s,l)=>s+Math.round(Number(l.amount)*100),0),850000,'allocated amounts sum exactly to the pool');
 // A source posting after the preview invalidates it.
 const stale=await journal([[rent.id,'100.00','0'],[cash.id,'0','100.00']],'Late rent');
 await rejects(run(pm,tx=>planning.approveRun(tx,pm,entityId,ar1.id,{decision:'approve',contentVersion:1})),'STATE_CONFLICT','pool changed since preview');
 await run(plan,tx=>planning.previewRun(tx,plan,entityId,ar1.id,{}));
 lines=await run(plan,tx=>planning.runLines(tx,plan,entityId,ar1.id));assert.equal(lines.pool,'8600.00');
 await rejects(run(plan,tx=>planning.approveRun(tx,plan,entityId,ar1.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the planner does not approve runs');
 await run(pm,tx=>planning.approveRun(tx,pm,entityId,ar1.id,{decision:'approve',contentVersion:1}));
 const posted=await run(pm,tx=>planning.postRun(tx,pm,entityId,ar1.id,{}));
 assert.equal(posted.state,'posted');assert.equal(posted.journalEntryIds.length,1);
 const entryLines=(await run(acc,tx=>tx.query('select account_id,func_debit::text as d,func_credit::text as c,dimensions_json from lara.journal_lines where tenant_id=$1 and entry_id=$2 order by line_no',[tenantId,posted.journalEntryIds[0]]))).rows;
 assert.equal(entryLines.filter(l=>l.account_id===overhead.id).length,3);assert.equal(entryLines.filter(l=>l.account_id===overhead.id).reduce((s,l)=>s+Number(l.d),0),8600);
 assert.equal(entryLines.find(l=>l.account_id===fees.id).c,'7000.000000');assert.equal(entryLines.find(l=>l.account_id===rent.id).c,'1600.000000');
 assert.equal(entryLines.find(l=>l.account_id===overhead.id).dimensions_json.cost_center,cc[0]);
 // The allocation moved the spend out of the budget buckets; a rerun for the period is refused.
 await rejects(run(plan,tx=>planning.createRun(tx,plan,entityId,runBody)),'STATE_CONFLICT','no duplicate rerun');
 assert.equal((await run(pm,tx=>planning.postRun(tx,pm,entityId,ar1.id,{}))).state,'posted','posting again replays');
 pass('P16-T03: the allocated amounts sum exactly to the pool with the residual on the first driver in stable order, a changed pool invalidates the preview, posting moves the pool to the target per driver dimension once, and a rerun for the period is refused');

 // Projects: contract, milestones, advance, progress billing with retention and recoupment (P16-T04), change order (P16-T05).
 const contractEvidence=await upload('contract.pdf');
 await rejects(run(plan,tx=>planning.createProject(tx,plan,entityId,{code:'TOWER',customerId:supplier.id,contractAmount:'100000.00',currency:'PHP',evidenceIds:[contractEvidence]})),'NOT_FOUND','a supplier is not a customer');
 const project=await run(plan,tx=>planning.createProject(tx,plan,entityId,{code:'TOWER',customerId:customer.id,contractAmount:'100000.00',currency:'PHP',evidenceIds:[contractEvidence]}));
 assert.equal(project.contractAmount,'100000.00');
 const m1=await run(plan,tx=>planning.createMilestone(tx,plan,entityId,project.id,{name:'Foundation',amount:'40000.00'}));
 const m2=await run(plan,tx=>planning.createMilestone(tx,plan,entityId,project.id,{name:'Structure',amount:'60000.00'}));
 await settle('project_profile',{retentionReceivableAccountId:retention.id,revenueAccountId:revenue.id,retentionDueCondition:'Release on final acceptance',profileVersion:'project-2026'});
 // The contract version needs approval before billing; the planner (project owner) cannot certify.
 const versions=await run(plan,tx=>planning.listChangeOrders(tx,plan,entityId,project.id));
 assert.equal(versions.items[0].versionNumber,1);assert.equal(versions.items[0].state,'draft');
 await run(pm,tx=>planning.approveChangeOrder(tx,pm,entityId,versions.items[0].id,{decision:'approve',contentVersion:1}));
 const certEvidence=await upload('certificate-1.pdf');
 await rejects(run(plan,tx=>planning.certifyMilestone(tx,plan,entityId,m1.id,{certifiedValue:'30000.00',evidenceIds:[certEvidence]})),'FORBIDDEN','the planner holds no certification authority');
 await rejects(run(pm,tx=>planning.certifyMilestone(tx,pm,entityId,m1.id,{certifiedValue:'50000.00',evidenceIds:[certEvidence]})),'VALIDATION_FAILED','certification beyond the milestone');
 await run(pm,tx=>planning.certifyMilestone(tx,pm,entityId,m1.id,{certifiedValue:'30000.00',evidenceIds:[certEvidence]}));
 // A documented advance: a posted, unapplied collection from the customer.
 const receipt=await run(bill,tx=>sales.createCollection(tx,bill,entityId,{direction:'receipt',partyId:customer.id,currency:'PHP',valueDate:'2026-10-02',grossAmount:'8000.00',cashAmount:'8000.00',withholdingAmount:'0.00',method:'transfer',allocations:[],evidenceIds:[]}));
 await run(bill,tx=>sales.submitCollection(tx,bill,entityId,receipt.id,{}));await run(acc,tx=>sales.approveCollection(tx,acc,entityId,receipt.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>sales.postCollection(tx,acc,entityId,receipt.id,{}));
 await rejects(run(plan,tx=>planning.createAdvance(tx,plan,entityId,project.id,{collectionId:receipt.id,amount:'9000.00'})),'ALLOCATION_EXCEEDS_BALANCE','advance beyond the unapplied receipt');
 const advance=await run(plan,tx=>planning.createAdvance(tx,plan,entityId,project.id,{collectionId:receipt.id,amount:'8000.00'}));
 assert.equal(advance.remaining,'8000.00');
 const billingEvidence=await upload('progress-1.pdf');
 await rejects(run(pm,tx=>planning.progressBilling(tx,pm,entityId,project.id,{milestoneId:m1.id,certifiedAmount:'31000.00',retentionAmount:'3000.00',advanceRecoupment:'5000.00',accountingDate:'2026-10-20',evidenceIds:[billingEvidence]})),'STATE_CONFLICT','billing beyond the certified value');
 await rejects(run(pm,tx=>planning.progressBilling(tx,pm,entityId,project.id,{milestoneId:m1.id,certifiedAmount:'30000.00',retentionAmount:'3000.00',advanceRecoupment:'9000.00',accountingDate:'2026-10-20',evidenceIds:[billingEvidence]})),'ALLOCATION_EXCEEDS_BALANCE','recoupment beyond the documented advance');
 const billed=await run(pm,tx=>planning.progressBilling(tx,pm,entityId,project.id,{milestoneId:m1.id,certifiedAmount:'30000.00',retentionAmount:'3000.00',advanceRecoupment:'5000.00',accountingDate:'2026-10-20',evidenceIds:[billingEvidence]}));
 const invoice=await run(bill,tx=>sales.getDocument(tx,bill,entityId,billed.resourceId,{kinds:['invoice','credit_note']}));
 assert.equal(invoice.state,'draft');assert.equal(invoice.gross,'27000.00','the invoice is the certified amount less retention');
 // The invoice follows maker-checker; retention and recoupment take effect when it posts.
 await run(bill,tx=>sales.submitDocument(tx,bill,entityId,invoice.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,invoice.id,{decision:'approve',contentVersion:1}));
 const postedInvoice=await run(acc,tx=>sales.postDocument(tx,acc,entityId,invoice.id,{}));
 assert.equal(postedInvoice.state,'posted');
 const openItem=(await run(acc,tx=>tx.query("select (original_amount-lara.open_item_allocated(tenant_id,id))::text as outstanding from lara.open_items where tenant_id=$1 and document_id=$2",[tenantId,invoice.id]))).rows[0];
 assert.equal(Number(openItem.outstanding),22000,'due now = 30,000 − 3,000 retention − 5,000 recouped from the advance');
 const held=await run(plan,tx=>planning.listRetention(tx,plan,entityId,project.id));
 assert.equal(held.items.length,1);assert.equal(held.items[0].held,'3000.00');assert.equal(held.items[0].state,'held');
 const retentionEntry=(await run(acc,tx=>tx.query("select l.account_id,l.func_debit::text as d,l.func_credit::text as c from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and e.source_type='project_billing' order by l.line_no",[tenantId]))).rows;
 assert.deepEqual(retentionEntry.map(l=>[l.account_id,Number(l.d),Number(l.c)]),[[retention.id,3000,0],[revenue.id,0,3000]],'retention sits in its receivable with its revenue');
 const advances=await run(plan,tx=>planning.listAdvances(tx,plan,entityId,project.id));assert.equal(advances.items[0].recouped,'5000.00');
 let profit=await run(plan,tx=>planning.profitability(tx,plan,entityId,project.id));
 assert.deepEqual([profit.certified,profit.billed,profit.retentionHeld,profit.advancesRecouped,profit.revenuePosted],['30000.00','30000.00','3000.00','5000.00','30000.00']);
 // Release on evidence: the release invoice settles the retention receivable and creates the due-now receivable.
 const releaseEvidence=await upload('acceptance.pdf');
 const release=await run(pm,tx=>planning.releaseRetention(tx,pm,entityId,held.items[0].id,{accountingDate:'2026-10-28',evidenceIds:[releaseEvidence],reason:'Final acceptance signed'}));
 await rejects(run(pm,tx=>planning.releaseRetention(tx,pm,entityId,held.items[0].id,{accountingDate:'2026-10-28',evidenceIds:[releaseEvidence]})),'STATE_CONFLICT','released twice');
 await run(bill,tx=>sales.submitDocument(tx,bill,entityId,release.resourceId,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,release.resourceId,{decision:'approve',contentVersion:1}));await run(acc,tx=>sales.postDocument(tx,acc,entityId,release.resourceId,{}));
 const releaseLines=(await run(acc,tx=>tx.query("select l.account_id,l.func_debit::text as d,l.func_credit::text as c from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and e.source_type='document' and e.source_id=$2 order by l.line_no",[tenantId,release.resourceId]))).rows;
 assert.ok(releaseLines.some(l=>l.account_id===ar.id&&Number(l.d)===3000)&&releaseLines.some(l=>l.account_id===retention.id&&Number(l.c)===3000),'the release debits the AR control and credits the retention receivable');
 assert.equal((await run(plan,tx=>planning.listRetention(tx,plan,entityId,project.id))).items[0].state,'released');
 profit=await run(plan,tx=>planning.profitability(tx,plan,entityId,project.id));assert.equal(profit.retentionHeld,'0.00');assert.equal(profit.revenuePosted,'30000.00','the release recognizes no revenue twice');
 pass('P16-T04: the progress invoice bills the certified amount less retention, recoups the documented advance by allocation when it posts, holds the retention in its own receivable with its revenue, and the release invoice settles the control account without recognizing revenue again');

 // P16-T05: change order as a visible approved version; past billing unchanged; billing beyond the contract refused until approved.
 await run(pm,tx=>planning.certifyMilestone(tx,pm,entityId,m2.id,{certifiedValue:'60000.00',evidenceIds:[certEvidence]}));
 await run(pm,tx=>planning.certifyMilestone(tx,pm,entityId,m1.id,{certifiedValue:'40000.00',evidenceIds:[certEvidence]}));
 // Variation work certified beyond the original contract: 30,000 billed + 60,000 + 20,000 would exceed 100,000.
 const m3=await run(plan,tx=>planning.createMilestone(tx,plan,entityId,project.id,{name:'Additional floor',amount:'20000.00'}));
 await run(pm,tx=>planning.certifyMilestone(tx,pm,entityId,m3.id,{certifiedValue:'20000.00',evidenceIds:[certEvidence]}));
 const b2=await run(pm,tx=>planning.progressBilling(tx,pm,entityId,project.id,{milestoneId:m2.id,certifiedAmount:'60000.00',retentionAmount:'0.00',advanceRecoupment:'3000.00',accountingDate:'2026-10-25',evidenceIds:[billingEvidence]}));
 assert.ok(b2.resourceId);
 await rejects(run(pm,tx=>planning.progressBilling(tx,pm,entityId,project.id,{milestoneId:m3.id,certifiedAmount:'20000.00',retentionAmount:'0.00',advanceRecoupment:'0.00',accountingDate:'2026-10-26',evidenceIds:[billingEvidence]})),'STATE_CONFLICT','billing beyond the approved contract is refused until a reviewed change order');
 await rejects(run(plan,tx=>planning.updateProject(tx,plan,entityId,project.id,undefined,{code:'TOWER',customerId:customer.id,contractAmount:'120000.00',currency:'PHP',evidenceIds:[contractEvidence]})),'STATE_CONFLICT','the contract amount never changes in place');
 const coEvidence=await upload('change-order-1.pdf');
 const co=await run(plan,tx=>planning.createChangeOrder(tx,plan,entityId,project.id,{contractAmount:'120000.00',reason:'Additional floor',evidenceIds:[coEvidence]}));
 assert.equal(co.versionNumber,2);assert.equal(co.state,'draft');
 assert.equal((await run(plan,tx=>planning.getProject(tx,plan,entityId,project.id))).contractAmount,'100000.00','the draft change order changes nothing yet');
 await rejects(run(plan,tx=>planning.approveChangeOrder(tx,plan,entityId,co.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the planner does not approve change orders');
 await run(pm,tx=>planning.approveChangeOrder(tx,pm,entityId,co.id,{decision:'approve',contentVersion:1}));
 assert.equal((await run(plan,tx=>planning.getProject(tx,plan,entityId,project.id))).contractAmount,'120000.00');
 const list=await run(plan,tx=>planning.listChangeOrders(tx,plan,entityId,project.id));
 assert.deepEqual(list.items.map(v=>[v.versionNumber,v.contractAmount,v.state]),[[1,'100000.00','approved'],[2,'120000.00','approved']],'both versions visible');
 const b3=await run(pm,tx=>planning.progressBilling(tx,pm,entityId,project.id,{milestoneId:m3.id,certifiedAmount:'20000.00',retentionAmount:'0.00',advanceRecoupment:'0.00',accountingDate:'2026-10-26',evidenceIds:[billingEvidence]}));
 assert.ok(b3.resourceId);
 const earlier=await run(bill,tx=>sales.getDocument(tx,bill,entityId,invoice.id,{kinds:['invoice','credit_note']}));
 assert.equal(earlier.gross,'27000.00');assert.equal(earlier.state,'posted','past billing unchanged');
 profit=await run(plan,tx=>planning.profitability(tx,plan,entityId,project.id));
 assert.equal(profit.contractVersion,2);assert.equal(profit.billed,'110000.00');assert.equal(profit.revenuePosted,'30000.00','the unposted draft is work in progress, excluded');
 pass('P16-T05: a change order is the next contract version, approved by another principal and visible with the original; billing beyond the earlier contract waits for it; past billing is unchanged and unposted drafts stay out of profitability');
 console.log('P16-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),api2.end(),owner.end()]);
}
