// P17-03 HTTP acceptance: the five local operations features through the
// API as a process. A lease drafted, approved, scheduled, billed and its
// deposit received and applied; an eligibility recorded and approved and
// the discount applied to a draft invoice; a channel, a payout reconciled
// and posted, a POS machine and closing approved and matched; a payroll
// batch imported, its records restricted, approved and posted, a remittance
// approved and remitted; a local obligation completed on evidence; gates.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,evidence,ledger,parties,sales,assets,FilesystemEvidenceStore} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4040,BASE='http://127.0.0.1:'+PORT,bucket='.local/p17-api-test-'+randomBytes(3).toString('hex');
const fieldKey=process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex');
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:fieldKey,RATE_LIMIT_WRITES_PER_MINUTE:'2000',RATE_LIMIT_READS_PER_MINUTE:'5000'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
const children=[];
function start(file){const c=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>{out+=b;});c.stderr.on('data',b=>{out+=b;});c.log=()=>out;c.done=false;c.once('exit',()=>{c.done=true;});children.push(c);return c;}
async function stop(c){if(c.done)return;const exited=new Promise(r=>c.once('exit',r));c.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);if(!c.done)c.kill('SIGKILL');}
async function waitFor(fn,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,200));}assert.fail('timeout: '+label);}
const call=async(subject,method,path,{body,headers={}}={})=>{const token=signIdentity(subject,method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET);return fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});};
const must=async(r,status)=>{const t=await r.text();assert.equal(r.status,status,t);try{return JSON.parse(t);}catch{return {raw:t};}};
const key=()=>({'idempotency-key':randomUUID()});
const im=v=>({'if-match':'"'+v+'"'});
const contract=(op,body)=>{const v=validateResponse(op,body);assert.equal(v.ok,true,op+' drifted: '+JSON.stringify(v.fieldErrors)+' '+JSON.stringify(body).slice(0,300));};
const OPS='ops-'+suffix,REV='rev-'+suffix,HR='hr-'+suffix,CTRL='ctrl-'+suffix,BILLING='billing-'+suffix,ACC='acc-'+suffix,TRE='tre-'+suffix,SEC='sec-'+suffix;
const apiProcess=start('apps/api/src/server.mjs');
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 const pr={};let entityId,book,branch,a={},lessee,senior,walkin,scheduleId,ev={},salesEntry,deposit;
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-local-'+suffix,name:'Local Co',mode:'demo'});
  for(const [n,s] of [['ops',OPS],['reviewer',REV],['hr',HR],['controller',CTRL],['billing',BILLING],['accountant',ACC],['treasury',TRE],['security',SEC]])pr[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:s,displayName:n})).id;
  const roles={};
  for(const code of ['controller','billing','accountant','treasury','security_admin','clerk'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),pr.security,code])).rows[0].id;
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),pr.security])).rows[0].id;
  roles.ops=await role('local_ops',['lease.create','lease.edit','lease.read','discount_eligibility.create','discount_eligibility.edit','discount_eligibility.read','channel.create','channel.read','payout.create','payout.read','pos_closing.create','pos_closing.read','payroll_batch.create','payroll_batch.read','remittance.create','remittance.read','local_obligation.create','local_obligation.edit','local_obligation.read','session.read','evidence.read','invoice.read','party.read','schedule.read','collection.read']);
  roles.reviewer=await role('local_reviewer',['lease.approve','lease.edit','lease.read','discount_eligibility.approve','discount_eligibility.read','channel.read','payout.read','payout.reconcile','payout.post','pos_closing.read','pos_closing.approve','payroll_batch.read','payroll_batch.approve','payroll_batch.post','remittance.read','remittance.approve','local_obligation.read','local_obligation.complete','session.read','invoice.read']);
  roles.hr=await role('hr',['payroll_batch.read','payroll_record.read','session.read']);
  for(const [p,r] of [['ops','ops'],['ops','clerk'],['reviewer','reviewer'],['hr','hr'],['controller','controller'],['billing','billing'],['accountant','accountant'],['treasury','treasury'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,pr[p],roles[r],pr.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,pr.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Local Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,pr.controller),traceId:'setup'};
  const acc={...await identity.actorContext(tx,tenantId,pr.accountant),traceId:'setup'},ops={...await identity.actorContext(tx,tenantId,pr.ops),traceId:'setup'},bill={...await identity.actorContext(tx,tenantId,pr.billing),traceId:'setup'},tre={...await identity.actorContext(tx,tenantId,pr.treasury),traceId:'setup'},dir={...ctrl,principalId:pr.reviewer,permissions:new Set(['entity.activate'])};
  branch=await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'});
  for(const cap of ['workspace','general_ledger','sales','purchasing','treasury','compliance','inventory','assets','leases','statutory_discounts','marketplace_pos','payroll_data','local_obligations'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,pr.reviewer,pr.controller]);
  book=await ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'});
  const mk=(code,name,category,extra={})=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra});
  a={cash:await mk('1010','Cash','asset'),clearing:await mk('1020','Payout clearing','asset'),ar:await mk('1200','Receivables','asset',{controlType:'ar'}),channelAr:await mk('1210','Marketplace receivable','asset'),inTax:await mk('1300','Input tax','asset',{controlType:'input_tax'}),cwt:await mk('1350','Creditable withholding','asset'),adv:await mk('1400','Advances','asset'),ap:await mk('2100','Payables','liability',{controlType:'ap'}),outTax:await mk('2200','Output tax','liability',{controlType:'output_tax'}),whtPay:await mk('2300','Withholding payable','liability'),deposits:await mk('2400','Lease deposits held','liability'),advances:await mk('2410','Rent in advance','liability'),sss:await mk('2510','SSS payable','liability'),ph:await mk('2520','PhilHealth payable','liability'),pi:await mk('2530','Pag-IBIG payable','liability'),netPay:await mk('2540','Salaries payable','liability'),rent:await mk('4100','Rent income','income'),sales:await mk('4200','Store sales','income'),services:await mk('4300','Service income','income'),salaries:await mk('5100','Salaries','expense'),fees:await mk('5300','Platform fees','expense')};
  for(const [s,e] of [['2026-10-01','2026-10-31'],['2026-11-01','2026-11-30']])await ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e});
  const settle=async(kind,payload)=>{const s=await organization.saveSettings(tx,ctrl,entityId,kind,payload);await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});};
  await settle('sales_profile',{arAccountId:a.ar.id,outputTaxAccountId:a.outTax.id,cashAccountId:a.cash.id,scale:2,dueDays:30});
  await settle('purchasing_profile',{apAccountId:a.ap.id,inputTaxAccountId:a.inTax.id,cashAccountId:a.cash.id,withholdingPayableAccountId:a.whtPay.id,advanceAccountId:a.adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
  await settle('recognition_policy_monthly_billing',{code:'monthly_billing',kind:'recurring_invoice'});
  await settle('lease_withholding_profile',{profileVersion:'lease-wht-2026',rates:{corporate:'0.05'}});
  await settle('lease_profile',{depositLiabilityAccountId:a.deposits.id,advanceLiabilityAccountId:a.advances.id,cashAccountId:a.cash.id});
  await settle('discount_profile_senior_citizen',{profileVersion:'sc-2026',rate:'0.2',basis:'net',eligibleAccountIds:[a.services.id],exemptionProfile:'vat-exempt-sc',requiredEvidence:['osca_id'],goldenCases:[{id:'SC-01',match:'any'}]});
  await settle('payroll_profile',{salaryExpenseAccountId:a.salaries.id,withholdingPayableAccountId:a.whtPay.id,sssPayableAccountId:a.sss.id,philhealthPayableAccountId:a.ph.id,pagibigPayableAccountId:a.pi.id,netPayableAccountId:a.netPay.id});
  await settle('local_authority_profile',{authority:'Makati City',profileVersion:'lgu-2026',kinds:['business_permit','local_business_tax','real_property_tax'],filingRequired:['business_permit']});
  for(const [kind,prefix] of [['invoice','INV'],['bill','BILL']])await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branch.id,kind,prefix,pr.controller]);
  const envKeys={FIELD_ENCRYPTION_KEY:fieldKey};
  const clerk={...ops};
  lessee=await parties.createParty(tx,clerk,entityId,{legalName:'Tenant Co',roles:['customer'],identityStatus:'unknown',address:'Makati'},envKeys);
  senior=await parties.createParty(tx,clerk,entityId,{legalName:'Maria Santos',roles:['customer'],identityStatus:'unknown',address:'Pasig'},envKeys);
  walkin=await parties.createParty(tx,clerk,entityId,{legalName:'Walk-in',roles:['customer'],identityStatus:'unknown',address:'Manila'},envKeys);
  const template=await sales.createDocument(tx,bill,entityId,{kind:'invoice',branchId:branch.id,bookId:book.id,partyId:lessee.id,documentDate:'2026-10-05',accountingDate:'2026-10-05',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Monthly rent',quantity:'1',unitPrice:'20000',discount:'0',priceBasis:'exclusive',accountId:a.rent.id,dimensions:{}}],evidenceIds:[]});
  scheduleId=(await assets.createSchedule(tx,{...ops,permissions:new Set([...ops.permissions,'schedule.create'])},entityId,{kind:'recurring_invoice',sourceId:template.id,startDate:'2026-10-01',endDate:'2027-09-30',basisAmount:'20000',currency:'PHP',policyVersion:'monthly_billing'})).id;
  const store=new FilesystemEvidenceStore(bucket);
  for(const name of ['lease.pdf','slip.pdf','sc-id.pdf','statement.pdf','tape.pdf','register.pdf','sss.pdf','or.pdf','permit.pdf']){const bytes=Buffer.from('%PDF-1.4 '+name+String.fromCharCode(10));const reg=await evidence.registerUpload(tx,ctrl,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'});await evidence.completeUpload(tx,ctrl,entityId,reg.evidenceId,bytes,store);await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);ev[name]=reg.evidenceId;}
  const j=await ledger.createJournal(tx,acc,entityId,{bookId:book.id,accountingDate:'2026-10-15',documentDate:'2026-10-15',currency:'PHP',description:'ShopCo sales',lines:[{accountId:a.channelAr.id,branchId:branch.id,debit:'10000.00',credit:'0',dimensions:{}},{accountId:a.sales.id,branchId:branch.id,debit:'0',credit:'10000.00',dimensions:{}}],evidenceIds:[]});
  await ledger.submitJournal(tx,acc,entityId,j.id,{});await ledger.approveJournal(tx,ctrl,entityId,j.id,{decision:'approve',contentVersion:1});salesEntry=(await ledger.postJournal(tx,ctrl,entityId,j.id,{})).journalEntryIds[0];
  const rc=await sales.createCollection(tx,bill,entityId,{direction:'receipt',partyId:walkin.id,currency:'PHP',valueDate:'2026-10-21',grossAmount:'3000.00',cashAmount:'3000.00',withholdingAmount:'0.00',method:'cash',allocations:[],evidenceIds:[]});
  await sales.submitCollection(tx,bill,entityId,rc.id,{});await sales.approveCollection(tx,acc,entityId,rc.id,{decision:'approve',contentVersion:1});await sales.postCollection(tx,acc,entityId,rc.id,{});deposit=rc.id;
 });
 const eh={'x-entity-id':entityId};
 // P17A
 const leaseBody={partyId:lessee.id,startDate:'2026-10-01',endDate:'2027-09-30',currency:'PHP',deposit:'40000.00',advance:'0.00',billingScheduleId:scheduleId,withholdingProfileVersion:'lease-wht-2026',evidenceIds:[ev['lease.pdf']],escalation:[{effectiveFrom:'2027-01-01',rate:'0.05'}]};
 let r=await call(REV,'POST','/leases',{body:leaseBody,headers:{...key(),...eh}});assert.equal(r.status,403,'the reviewer drafts no lease');
 r=await call(OPS,'POST','/leases',{body:leaseBody,headers:{...key(),...eh}});const lease=await must(r,201);contract('post_leases',lease);assert.equal(lease.baseRent,'20000.00');
 r=await call(OPS,'GET','/leases',{headers:eh});contract('get_leases',await must(r,200));
 r=await call(OPS,'GET','/leases/'+lease.id,{headers:eh});contract('get_leases_id',await must(r,200));
 r=await call(OPS,'PATCH','/leases/'+lease.id,{body:{...leaseBody,deposit:'40000.00',advance:'20000.00'},headers:{...eh,...im(lease.version)}});const edited=await must(r,200);contract('patch_leases_id',edited);
 r=await call(REV,'POST','/leases/'+lease.id+'/approve',{body:{decision:'approve',contentVersion:edited.contentVersion},headers:{...key(),...eh,...im(edited.version)}});contract('post_leases_id_approve',await must(r,200));
 r=await call(OPS,'GET','/leases/'+lease.id+'/schedule',{headers:eh});const sched=await must(r,200);contract('get_leases_id_schedule',sched);assert.equal(sched.total,'249000.00');
 r=await call(REV,'POST','/leases/'+lease.id+'/bill',{body:{periodStart:'2026-10-01',periodEnd:'2026-10-31',accountingDate:'2026-10-01',evidenceIds:[]},headers:{...key(),...eh}});const billed=await must(r,200);contract('post_leases_id_bill',billed);
 r=await call(BILLING,'POST','/invoices/'+billed.resourceId+'/submit',{body:{},headers:{...key(),...eh,...im(billed.version)}});await must(r,200);
 r=await call(ACC,'GET','/invoices/'+billed.resourceId,{headers:eh});let inv=await must(r,200);
 r=await call(ACC,'POST','/invoices/'+billed.resourceId+'/approve',{body:{decision:'approve',contentVersion:inv.contentVersion},headers:{...key(),...eh,...im(inv.version)}});await must(r,200);
 r=await call(ACC,'GET','/invoices/'+billed.resourceId,{headers:eh});inv=await must(r,200);
 r=await call(ACC,'POST','/invoices/'+billed.resourceId+'/post',{body:{},headers:{...key(),...eh,...im(inv.version)}});await must(r,200);
 r=await call(OPS,'POST','/leases/'+lease.id+'/events',{body:{kind:'deposit_received',amount:'40000.00',eventDate:'2026-10-01',evidenceIds:[ev['slip.pdf']]},headers:{...key(),...eh}});const dep=await must(r,200);contract('post_leases_id_events',dep);assert.equal(dep.journalEntryIds.length,1);
 r=await call(OPS,'POST','/leases/'+lease.id+'/events',{body:{kind:'deposit_applied',amount:'20000.00',eventDate:'2026-10-31',documentId:billed.resourceId,evidenceIds:[]},headers:{...key(),...eh}});assert.equal(r.status,403,'the recorder of the receipt cannot apply it');
 r=await call(REV,'POST','/leases/'+lease.id+'/events',{body:{kind:'deposit_applied',amount:'20000.00',eventDate:'2026-10-31',documentId:billed.resourceId,evidenceIds:[]},headers:{...key(),...eh}});await must(r,200);
 r=await call(OPS,'GET','/leases/'+lease.id+'/events',{headers:eh});const events=await must(r,200);contract('get_leases_id_events',events);assert.deepEqual(events.items.map(e=>e.kind),['rent_billed','deposit_received','deposit_applied']);
 pass('a lease drafted and edited by the officer, approved by the reviewer, its schedule with the escalated total, October billed and posted, the deposit received and applied by another principal');
 // P17B
 r=await call(OPS,'POST','/discount-eligibility',{body:{partyId:senior.id,category:'senior_citizen',profileVersion:'sc-2026',validUntil:'2027-12-31',evidenceIds:[ev['sc-id.pdf']],idReference:'OSCA-123456'},headers:{...key(),...eh}});const elig=await must(r,201);contract('post_discount_eligibility',elig);assert.equal(elig.idReferenceMasked,'*******3456');
 r=await call(OPS,'GET','/discount-eligibility',{headers:eh});contract('get_discount_eligibility',await must(r,200));
 r=await call(OPS,'GET','/discount-eligibility/'+elig.id,{headers:eh});contract('get_discount_eligibility_id',await must(r,200));
 r=await call(OPS,'PATCH','/discount-eligibility/'+elig.id,{body:{partyId:senior.id,category:'senior_citizen',profileVersion:'sc-2026',validUntil:'2027-06-30',evidenceIds:[ev['sc-id.pdf']]},headers:{...eh,...im(elig.version)}});const eligEdited=await must(r,200);contract('patch_discount_eligibility_id',eligEdited);
 r=await call(REV,'POST','/discount-eligibility/'+elig.id+'/approve',{body:{decision:'approve',contentVersion:eligEdited.contentVersion},headers:{...key(),...eh,...im(eligEdited.version)}});contract('post_discount_eligibility_id_approve',await must(r,200));
 r=await call(BILLING,'POST','/invoices',{body:{kind:'invoice',branchId:branch.id,bookId:book.id,partyId:senior.id,documentDate:'2026-10-05',accountingDate:'2026-10-05',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Consultation',quantity:'1',unitPrice:'1000',discount:'0',priceBasis:'exclusive',accountId:a.services.id,dimensions:{}},{description:'Merchandise',quantity:'1',unitPrice:'500',discount:'0',priceBasis:'exclusive',accountId:a.sales.id,dimensions:{}}],evidenceIds:[]},headers:{...key(),...eh}});const mixed=await must(r,201);
 r=await call(REV,'POST','/invoices/'+mixed.id+'/statutory-discount',{body:{},headers:{...key(),...eh}});const applied=await must(r,200);contract('post_invoices_id_statutory_discount',applied);
 r=await call(OPS,'GET','/invoices/'+mixed.id+'/statutory-discount',{headers:eh});const dl=await must(r,200);contract('get_invoices_id_statutory_discount',dl);assert.equal(dl.items.length,1);assert.equal(dl.items[0].amount,'200.00');
 r=await call(OPS,'GET','/invoices/'+mixed.id,{headers:eh});assert.equal((await must(r,200)).net,'1300.00');
 pass('eligibility recorded with a masked identity reference, edited, approved by the reviewer, and the discount applied to the eligible line of a mixed draft invoice');
 // P17C
 r=await call(OPS,'POST','/channels',{body:{code:'SHOP',name:'ShopCo',kind:'marketplace',provider:'ShopCo',mappingVersion:'shop-2026',receivableAccountId:a.channelAr.id,feeAccountId:a.fees.id,withholdingAccountId:a.cwt.id,clearingAccountId:a.clearing.id},headers:{...key(),...eh}});const channel=await must(r,201);contract('post_channels',channel);
 r=await call(OPS,'GET','/channels',{headers:eh});contract('get_channels',await must(r,200));
 r=await call(OPS,'POST','/payouts',{body:{channelId:channel.id,sourceId:'STM-A',periodStart:'2026-10-01',periodEnd:'2026-10-15',gross:'10000.00',fees:'500.00',withholding:'100.00',otherDeductions:[{kind:'clawback',amount:'50.00'}],net:'9400.00',evidenceIds:[ev['statement.pdf']]},headers:{...key(),...eh}});assert.equal(r.status,422,'unexplained net');
 r=await call(OPS,'POST','/payouts',{body:{channelId:channel.id,sourceId:'STM-A',periodStart:'2026-10-01',periodEnd:'2026-10-15',gross:'10000.00',fees:'500.00',withholding:'100.00',otherDeductions:[{kind:'clawback',amount:'50.00'}],net:'9350.00',evidenceIds:[ev['statement.pdf']]},headers:{...key(),...eh}});const payout=await must(r,201);contract('post_payouts',payout);
 r=await call(OPS,'GET','/payouts',{headers:eh});contract('get_payouts',await must(r,200));
 r=await call(OPS,'GET','/payouts/'+payout.id,{headers:eh});contract('get_payouts_id',await must(r,200));
 r=await call(REV,'POST','/payouts/'+payout.id+'/reconcile',{body:{salesReferenceIds:[salesEntry]},headers:{...key(),...eh,...im(payout.version)}});const rec=await must(r,200);contract('post_payouts_id_reconcile',rec);assert.equal(rec.state,'reconciled');
 r=await call(REV,'POST','/payouts/'+payout.id+'/post',{body:{},headers:{...key(),...eh,...im(rec.version)}});const pp=await must(r,200);contract('post_payouts_id_post',pp);assert.equal(pp.journalEntryIds.length,1);
 r=await call(OPS,'POST','/pos-machines',{body:{branchId:branch.id,brand:'Acme',model:'X1',serialNumber:'SN-1',machineIdentificationNumber:'MIN-1',permitNumber:'PTU-1'},headers:{...key(),...eh}});const machine=await must(r,201);contract('post_pos_machines',machine);
 r=await call(OPS,'GET','/pos-machines',{headers:eh});contract('get_pos_machines',await must(r,200));
 r=await call(OPS,'POST','/pos-closings',{body:{machineId:machine.id,shiftDate:'2026-10-20',shiftNo:1,readingKind:'Z',beginningReading:'100000.00',endingReading:'103500.00',cashCounted:'3000.00',nonCash:'500.00',evidenceIds:[ev['tape.pdf']]},headers:{...key(),...eh}});const closing=await must(r,201);contract('post_pos_closings',closing);
 r=await call(OPS,'GET','/pos-closings',{headers:eh});contract('get_pos_closings',await must(r,200));
 r=await call(REV,'POST','/pos-closings/'+closing.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(closing.version)}});const ca=await must(r,200);contract('post_pos_closings_id_approve',ca);
 r=await call(REV,'POST','/pos-closings/'+closing.id+'/match',{body:{settlementId:deposit},headers:{...key(),...eh,...im(ca.version)}});const cm=await must(r,200);contract('post_pos_closings_id_match',cm);assert.equal(cm.state,'matched');
 pass('a channel registered, a payout with every deduction explained reconciled to the imported sales and posted once, a POS machine registered and its Z closing approved and matched to the deposit');
 // P17D
 const records=[{employeeReference:'EMP-0001',gross:'30000.00',withholding:'2500.00',sss:'1350.00',philhealth:'600.00',pagibig:'200.00',net:'25350.00'},{employeeReference:'EMP-0002',gross:'20000.00',withholding:'1000.00',sss:'900.00',philhealth:'400.00',pagibig:'200.00',net:'17500.00'}];
 r=await call(OPS,'POST','/payroll-batches',{body:{sourceSystem:'PayrollCo',periodKey:'2026-10',mappingVersion:'pay-2026',grossTotal:'50000.00',withholdingTotal:'3500.00',sssTotal:'2250.00',philhealthTotal:'1000.00',pagibigTotal:'400.00',netTotal:'42850.00',records,evidenceIds:[ev['register.pdf']]},headers:{...key(),...eh}});const batch=await must(r,201);contract('post_payroll_batches',batch);assert.equal(batch.state,'reconciled');
 r=await call(OPS,'GET','/payroll-batches',{headers:eh});contract('get_payroll_batches',await must(r,200));
 r=await call(OPS,'GET','/payroll-batches/'+batch.id,{headers:eh});contract('get_payroll_batches_id',await must(r,200));
 r=await call(OPS,'GET','/payroll-batches/'+batch.id+'/records',{headers:eh});assert.equal(r.status,403,'individual records are restricted');
 r=await call(HR,'GET','/payroll-batches/'+batch.id+'/records',{headers:eh});const recs=await must(r,200);contract('get_payroll_batches_id_records',recs);assert.equal(recs.items[0].employeeReferenceMasked,'****0001');
 r=await call(REV,'POST','/payroll-batches/'+batch.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(batch.version)}});const ba=await must(r,200);contract('post_payroll_batches_id_approve',ba);
 r=await call(REV,'POST','/payroll-batches/'+batch.id+'/post',{body:{},headers:{...key(),...eh,...im(ba.version)}});const bp=await must(r,200);contract('post_payroll_batches_id_post',bp);assert.equal(bp.journalEntryIds.length,1);
 r=await call(OPS,'POST','/remittances',{body:{batchId:batch.id,agency:'SSS',periodKey:'2026-10',amount:'2250.00',dueDate:'2026-11-15'},headers:{...key(),...eh}});const remit=await must(r,201);contract('post_remittances',remit);
 r=await call(OPS,'GET','/remittances',{headers:eh});contract('get_remittances',await must(r,200));
 r=await call(REV,'POST','/remittances/'+remit.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(remit.version)}});const ra=await must(r,200);contract('post_remittances_id_approve',ra);
 r=await call(REV,'POST','/remittances/'+remit.id+'/remit',{body:{reference:'SSS-PRN-1',evidenceIds:[ev['sss.pdf']]},headers:{...key(),...eh,...im(ra.version)}});const rr=await must(r,200);contract('post_remittances_id_remit',rr);assert.equal(rr.state,'remitted');
 pass('a payroll batch imported with tying totals, its records restricted to HR and masked, approved and posted by the reviewer, and the SSS remittance approved and remitted on evidence');
 // P17E
 r=await call(OPS,'POST','/local-obligations',{body:{authority:'Makati City',authorityProfileVersion:'lgu-2026',kind:'business_permit',periodKey:'2026',dueDate:'2026-01-20',amount:'8000.00',requiresFiling:true,evidenceIds:[]},headers:{...key(),...eh}});const ob=await must(r,201);contract('post_local_obligations',ob);
 r=await call(OPS,'GET','/local-obligations',{headers:eh});contract('get_local_obligations',await must(r,200));
 r=await call(OPS,'GET','/local-obligations/'+ob.id,{headers:eh});contract('get_local_obligations_id',await must(r,200));
 r=await call(OPS,'PATCH','/local-obligations/'+ob.id,{body:{authority:'Makati City',authorityProfileVersion:'lgu-2026',kind:'business_permit',periodKey:'2026',dueDate:'2026-01-25',amount:'8000.00',requiresFiling:true,evidenceIds:[]},headers:{...eh,...im(ob.version)}});const obEdited=await must(r,200);contract('patch_local_obligations_id',obEdited);
 r=await call(REV,'POST','/local-obligations/'+ob.id+'/complete',{body:{paymentEvidenceIds:[ev['or.pdf']],filingEvidenceIds:[]},headers:{...key(),...eh,...im(obEdited.version)}});assert.equal(r.status,409,'filing evidence required by the authority');
 r=await call(REV,'POST','/local-obligations/'+ob.id+'/complete',{body:{paymentEvidenceIds:[ev['or.pdf']],filingEvidenceIds:[ev['permit.pdf']]},headers:{...key(),...eh,...im(obEdited.version)}});const done=await must(r,200);contract('post_local_obligations_id_complete',done);assert.equal(done.state,'complete');
 r=await call(OPS,'POST','/local-obligations',{body:{authority:'Makati City',authorityProfileVersion:'lgu-2026',kind:'local_business_tax',periodKey:'2026-Q1',dueDate:'2026-01-20',amount:'5000.00',requiresFiling:false,evidenceIds:[]},headers:{...key(),...eh}});const lbt=await must(r,201);
 r=await call(REV,'POST','/local-obligations/'+lbt.id+'/waive',{body:{reason:'Exempt this year'},headers:{...key(),...eh,...im(lbt.version)}});contract('post_local_obligations_id_waive',await must(r,200));
 pass('a local obligation recorded and edited by the officer, completed by the reviewer only with the payment and filing evidence the authority requires, and another waived with a reason');
 // Gates.
 r=await call(OPS,'GET','/leases/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call(OPS,'POST','/packs/install',{body:{},headers:{...key(),...eh}});assert.ok([403,404,409].includes(r.status),'later-phase operations stay gated or refused for the caller');
 pass('unknown records answer 404 and later-phase operations stay gated');
 console.log('P17-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-30).join(String.fromCharCode(10)));throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
