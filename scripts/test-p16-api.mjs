// P16-03 HTTP acceptance: budgets, allocations and projects through the API
// as a process. A budget drafted, approved, activated and its availability;
// a purchase order approved over HTTP reserving a commitment, a bill against
// it consuming the commitment; an allocation rule approved, a run previewed,
// its lines, approval and posting; a project with milestones, a certified
// milestone, a change order, an advance from a posted collection, progress
// billing, the invoice through maker-checker, retention and its release,
// profitability; isolation and gates.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,evidence,ledger,parties,FilesystemEvidenceStore} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4039,BASE='http://127.0.0.1:'+PORT,bucket='.local/p16-api-test-'+randomBytes(3).toString('hex');
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
const PLAN='plan-'+suffix,PM='pm-'+suffix,CTRL='ctrl-'+suffix,CLERK='clerk-'+suffix,BUYER='buyer-'+suffix,BILLING='billing-'+suffix,ACC='acc-'+suffix,TRE='tre-'+suffix,SEC='sec-'+suffix;
const apiProcess=start('apps/api/src/server.mjs');
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 const pr={};let entityId,book,branch,a={},supplier,customer,period,ev={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-plan-'+suffix,name:'Planning Co',mode:'demo'});
  for(const [n,s] of [['planner',PLAN],['pm',PM],['controller',CTRL],['clerk',CLERK],['buyer',BUYER],['billing',BILLING],['accountant',ACC],['treasury',TRE],['security',SEC]])pr[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:s,displayName:n})).id;
  const roles={};
  for(const code of ['controller','clerk','billing','accountant','treasury','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),pr.security,code])).rows[0].id;
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),pr.security])).rows[0].id;
  roles.purchaser=await role('purchaser',['purchase_order.create','purchase_order.edit','purchase_order.read','purchase_order.submit','purchase_order.cancel','bill.read','party.read','session.read']);
  roles.planner=await role('planner',['budget.create','budget.edit','budget.read','allocation_run.create','allocation_run.edit','allocation_run.read','allocation_run.preview','project.create','project.edit','project.read','session.read','evidence.read']);
  roles.pm=await role('project_manager',['budget.approve','budget.activate','budget.read','allocation_run.approve','allocation_run.post','allocation_run.read','project.read','project.progress_billing','purchase_order.approve','purchase_order.read','session.read']);
  for(const [p,r] of [['planner','planner'],['pm','pm'],['controller','controller'],['clerk','clerk'],['buyer','purchaser'],['billing','billing'],['accountant','accountant'],['treasury','treasury'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,pr[p],roles[r],pr.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,pr.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Planning Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,pr.controller),traceId:'setup'};
  const acc={...await identity.actorContext(tx,tenantId,pr.accountant),traceId:'setup'},clerk={...await identity.actorContext(tx,tenantId,pr.clerk),traceId:'setup'},dir={...ctrl,principalId:pr.pm,permissions:new Set(['entity.activate'])};
  branch=await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'});
  for(const cap of ['workspace','general_ledger','sales','purchasing','treasury','compliance','inventory','assets','planning'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,pr.pm,pr.controller]);
  book=await ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'});
  const mk=(code,name,category,extra={})=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra});
  a={cash:await mk('1010','Cash','asset'),ar:await mk('1200','Receivables','asset',{controlType:'ar'}),retention:await mk('1250','Retention receivable','asset'),inTax:await mk('1300','Input tax','asset',{controlType:'input_tax'}),adv:await mk('1400','Advances','asset'),ap:await mk('2100','Payables','liability',{controlType:'ap'}),outTax:await mk('2200','Output tax','liability',{controlType:'output_tax'}),whtPay:await mk('2300','Withholding payable','liability'),revenue:await mk('4000','Contract revenue','income'),fees:await mk('5000','Professional fees','expense'),rent:await mk('5200','Rent','expense'),overhead:await mk('5900','Allocated overhead','expense')};
  period=await ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-10-01',endsOn:'2026-10-31'});
  const settle=async(kind,payload)=>{const s=await organization.saveSettings(tx,ctrl,entityId,kind,payload);await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});};
  await settle('sales_profile',{arAccountId:a.ar.id,outputTaxAccountId:a.outTax.id,cashAccountId:a.cash.id,scale:2,dueDays:30});
  await settle('purchasing_profile',{apAccountId:a.ap.id,inputTaxAccountId:a.inTax.id,cashAccountId:a.cash.id,withholdingPayableAccountId:a.whtPay.id,advanceAccountId:a.adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
  await settle('project_profile',{retentionReceivableAccountId:a.retention.id,revenueAccountId:a.revenue.id,retentionDueCondition:'Release on final acceptance',profileVersion:'project-2026'});
  for(const [kind,prefix] of [['invoice','INV'],['bill','BILL']])await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branch.id,kind,prefix,pr.controller]);
  const envKeys={FIELD_ENCRYPTION_KEY:fieldKey};
  supplier=await parties.createParty(tx,clerk,entityId,{legalName:'Supplies Inc',roles:['supplier'],identityStatus:'unknown',address:'Cebu'},envKeys);
  customer=await parties.createParty(tx,clerk,entityId,{legalName:'Build Corp',roles:['customer'],identityStatus:'unknown',address:'Makati'},envKeys);
  const store=new FilesystemEvidenceStore(bucket);
  for(const name of ['drivers.pdf','contract.pdf','certificate.pdf','progress.pdf','acceptance.pdf','change-order.pdf','si.pdf']){const bytes=Buffer.from('%PDF-1.4 '+name+String.fromCharCode(10));const reg=await evidence.registerUpload(tx,ctrl,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'});await evidence.completeUpload(tx,ctrl,entityId,reg.evidenceId,bytes,store);await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);ev[name]=reg.evidenceId;}
 });
 const eh={'x-entity-id':entityId};
 // Budgets over HTTP.
 const budgetBody={periodStart:'2026-10-01',periodEnd:'2026-10-31',currency:'PHP',policy:'block',lines:[{accountId:a.fees.id,dimensions:{},amount:'10000.00'},{accountId:a.rent.id,dimensions:{},amount:'5000.00'}]};
 let r=await call(PM,'POST','/budgets',{body:budgetBody,headers:{...key(),...eh}});assert.equal(r.status,403,'the approver drafts no budget');
 r=await call(PLAN,'POST','/budgets',{body:budgetBody,headers:{...key(),...eh}});const budget=await must(r,201);contract('post_budgets',budget);
 r=await call(PLAN,'GET','/budgets',{headers:eh});contract('get_budgets',await must(r,200));
 r=await call(PLAN,'GET','/budgets/'+budget.id,{headers:eh});contract('get_budgets_id',await must(r,200));
 r=await call(PLAN,'PATCH','/budgets/'+budget.id,{body:{...budgetBody,policy:'block',lines:[{...budgetBody.lines[0],amount:'12000.00'},budgetBody.lines[1]]},headers:{...eh,...im(budget.version)}});const edited=await must(r,200);contract('patch_budgets_id',edited);
 r=await call(PLAN,'POST','/budgets/'+budget.id+'/approve',{body:{decision:'approve',contentVersion:edited.contentVersion},headers:{...key(),...eh,...im(edited.version)}});assert.equal(r.status,403);
 r=await call(PM,'POST','/budgets/'+budget.id+'/approve',{body:{decision:'approve',contentVersion:edited.contentVersion},headers:{...key(),...eh,...im(edited.version)}});const approved=await must(r,200);contract('post_budgets_id_approve',approved);
 r=await call(PM,'POST','/budgets/'+budget.id+'/activate',{body:{reason:'Board approved'},headers:{...key(),...eh,...im(approved.version)}});const active=await must(r,200);contract('post_budgets_id_activate',active);assert.equal(active.state,'active');
 r=await call(PLAN,'GET','/budgets/'+budget.id+'/availability',{headers:eh});let avail=await must(r,200);contract('get_budgets_id_availability',avail);assert.equal(avail.lines[0].available,'12000.00');
 pass('a budget drafted and edited by the planner, approved and activated by the project manager, with its availability');
 // A purchase order approved over HTTP reserves a commitment; a bill against it consumes it.
 const poBody={kind:'purchase_order',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:'2026-10-05',accountingDate:'2026-10-05',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Audit',quantity:'1',unitPrice:'13000',discount:'0',priceBasis:'exclusive',accountId:a.fees.id,dimensions:{}}],evidenceIds:[]};
 r=await call(BUYER,'POST','/purchase-orders',{body:poBody,headers:{...key(),...eh}});const po=await must(r,201);
 r=await call(BUYER,'POST','/purchase-orders/'+po.id+'/submit',{body:{},headers:{...key(),...eh,...im(po.version)}});await must(r,200);
 r=await call(BUYER,'GET','/purchase-orders/'+po.id,{headers:eh});let poNow=await must(r,200);
 r=await call(PM,'POST','/purchase-orders/'+po.id+'/approve',{body:{decision:'approve',contentVersion:poNow.contentVersion},headers:{...key(),...eh,...im(poNow.version)}});assert.equal(r.status,409,'blocked beyond the budget without an override reason');
 r=await call(PM,'POST','/purchase-orders/'+po.id+'/approve',{body:{decision:'approve',contentVersion:poNow.contentVersion,reason:'Board-approved overrun'},headers:{...key(),...eh,...im(poNow.version)}});await must(r,200);
 r=await call(PLAN,'GET','/commitments',{headers:eh});const commitments=await must(r,200);contract('get_commitments',commitments);assert.equal(commitments.items.length,1);assert.equal(commitments.items[0].overrideReason,'Board-approved overrun');
 r=await call(PLAN,'GET','/budgets/'+budget.id+'/availability',{headers:eh});avail=await must(r,200);assert.equal(avail.lines[0].committed,'13000.00');assert.equal(avail.lines[0].overrides,1);
 r=await call(CLERK,'POST','/bills',{body:{...poBody,kind:'bill',externalReference:'SI-PO1',sourceDocumentId:po.id,evidenceIds:[ev['si.pdf']]},headers:{...key(),...eh}});const bill=await must(r,201);
 r=await call(CLERK,'POST','/bills/'+bill.id+'/submit',{body:{},headers:{...key(),...eh,...im(bill.version)}});await must(r,200);
 r=await call(ACC,'GET','/bills/'+bill.id,{headers:eh});let b=await must(r,200);
 r=await call(CTRL,'POST','/bills/'+bill.id+'/approve',{body:{decision:'approve',contentVersion:b.contentVersion},headers:{...key(),...eh,...im(b.version)}});await must(r,200);
 r=await call(ACC,'GET','/bills/'+bill.id,{headers:eh});b=await must(r,200);
 r=await call(ACC,'POST','/bills/'+bill.id+'/post',{body:{},headers:{...key(),...eh,...im(b.version)}});await must(r,200);
 r=await call(PLAN,'GET','/commitments?status=consumed',{headers:eh});assert.equal((await must(r,200)).items[0].consumed,'13000.00');
 r=await call(PLAN,'GET','/budgets/'+budget.id+'/availability',{headers:eh});avail=await must(r,200);assert.deepEqual([avail.lines[0].actual,avail.lines[0].committed,avail.lines[0].available],['13000.00','0.00','-1000.00']);
 pass('a purchase order approved over HTTP reserves a commitment (blocked beyond the budget without a recorded override), the bill against it consumes the commitment and becomes the actual once');
 // Allocation rule and run.
 const cc=[randomUUID(),randomUUID()];
 r=await call(PLAN,'POST','/allocation-rules',{body:{code:'OVH',name:'Overhead',bookId:book.id,sourceAccountIds:[a.fees.id],targetAccountId:a.overhead.id,drivers:[{dimensions:{cost_center:cc[0]},weight:'2'},{dimensions:{cost_center:cc[1]},weight:'1'}],effectiveFrom:'2026-01-01'},headers:{...key(),...eh}});const rule=await must(r,201);contract('post_allocation_rules',rule);
 r=await call(PLAN,'GET','/allocation-rules',{headers:eh});contract('get_allocation_rules',await must(r,200));
 r=await call(PM,'POST','/allocation-rules/'+rule.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(rule.version)}});contract('post_allocation_rules_id_approve',await must(r,200));
 const runBody={ruleVersionId:rule.id,periodId:period.id,sourceCutoff:'2026-11-05T00:00:00.000Z',driverEvidenceId:ev['drivers.pdf']};
 r=await call(PLAN,'POST','/allocation-runs',{body:runBody,headers:{...key(),...eh}});const run=await must(r,201);contract('post_allocation_runs',run);
 r=await call(PLAN,'GET','/allocation-runs',{headers:eh});contract('get_allocation_runs',await must(r,200));
 r=await call(PLAN,'GET','/allocation-runs/'+run.id,{headers:eh});contract('get_allocation_runs_id',await must(r,200));
 r=await call(PLAN,'PATCH','/allocation-runs/'+run.id,{body:{...runBody,sourceCutoff:'2026-11-06T00:00:00.000Z'},headers:{...eh,...im(run.version)}});const runEdited=await must(r,200);contract('patch_allocation_runs_id',runEdited);
 r=await call(PLAN,'POST','/allocation-runs/'+run.id+'/preview',{body:{},headers:{...key(),...eh,...im(runEdited.version)}});const previewed=await must(r,200);contract('post_allocation_runs_id_preview',previewed);
 r=await call(PLAN,'GET','/allocation-runs/'+run.id+'/lines',{headers:eh});const lines=await must(r,200);contract('get_allocation_runs_id_lines',lines);
 assert.equal(lines.pool,'13000.00');assert.deepEqual(lines.lines.map(l=>l.amount),['8666.67','4333.33']);assert.equal(lines.lines[0].residual,false,'an exact split carries no residual');
 r=await call(PLAN,'GET','/allocation-runs/'+run.id,{headers:eh});let runNow=await must(r,200);
 r=await call(PM,'POST','/allocation-runs/'+run.id+'/approve',{body:{decision:'approve',contentVersion:runNow.contentVersion},headers:{...key(),...eh,...im(runNow.version)}});const runApproved=await must(r,200);contract('post_allocation_runs_id_approve',runApproved);
 r=await call(PM,'POST','/allocation-runs/'+run.id+'/post',{body:{},headers:{...key(),...eh,...im(runApproved.version)}});const runPosted=await must(r,200);contract('post_allocation_runs_id_post',runPosted);assert.equal(runPosted.journalEntryIds.length,1);
 r=await call(PLAN,'POST','/allocation-runs',{body:runBody,headers:{...key(),...eh}});assert.equal(r.status,409,'no rerun for the period');
 pass('an allocation rule approved by the project manager; a run previewed with its lines summing to the pool, approved and posted once; a rerun refused');
 // Projects.
 r=await call(PLAN,'POST','/projects',{body:{code:'TOWER',customerId:customer.id,contractAmount:'100000.00',currency:'PHP',evidenceIds:[ev['contract.pdf']]},headers:{...key(),...eh}});const project=await must(r,201);contract('post_projects',project);
 r=await call(PLAN,'GET','/projects',{headers:eh});contract('get_projects',await must(r,200));
 r=await call(PLAN,'GET','/projects/'+project.id,{headers:eh});contract('get_projects_id',await must(r,200));
 r=await call(PLAN,'PATCH','/projects/'+project.id,{body:{code:'TOWER',customerId:customer.id,contractAmount:'100000.00',currency:'PHP',evidenceIds:[ev['contract.pdf'],ev['certificate.pdf']]},headers:{...eh,...im(project.version)}});contract('patch_projects_id',await must(r,200));
 r=await call(PLAN,'GET','/projects/'+project.id+'/change-orders',{headers:eh});const versions=await must(r,200);contract('get_projects_id_change_orders',versions);
 r=await call(PM,'POST','/change-orders/'+versions.items[0].id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(versions.items[0].version)}});contract('post_change_orders_id_approve',await must(r,200));
 r=await call(PLAN,'POST','/projects/'+project.id+'/milestones',{body:{name:'Foundation',amount:'40000.00'},headers:{...key(),...eh}});const m1=await must(r,201);contract('post_projects_id_milestones',m1);
 r=await call(PLAN,'GET','/projects/'+project.id+'/milestones',{headers:eh});contract('get_projects_id_milestones',await must(r,200));
 r=await call(PLAN,'POST','/milestones/'+m1.id+'/certify',{body:{certifiedValue:'30000.00',evidenceIds:[ev['certificate.pdf']]},headers:{...key(),...eh,...im(m1.version)}});assert.equal(r.status,403);
 r=await call(PM,'POST','/milestones/'+m1.id+'/certify',{body:{certifiedValue:'30000.00',evidenceIds:[ev['certificate.pdf']]},headers:{...key(),...eh,...im(m1.version)}});contract('post_milestones_id_certify',await must(r,200));
 // The advance: a posted collection with an unapplied remainder.
 r=await call(BILLING,'POST','/collections',{body:{direction:'receipt',partyId:customer.id,currency:'PHP',valueDate:'2026-10-02',grossAmount:'8000.00',cashAmount:'8000.00',withholdingAmount:'0.00',method:'transfer',allocations:[],evidenceIds:[]},headers:{...key(),...eh}});const receipt=await must(r,201);
 r=await call(BILLING,'POST','/collections/'+receipt.id+'/submit',{body:{},headers:{...key(),...eh,...im(receipt.version)}});await must(r,200);
 r=await call(TRE,'GET','/collections/'+receipt.id,{headers:eh});let rc=await must(r,200);
 r=await call(ACC,'POST','/collections/'+receipt.id+'/approve',{body:{decision:'approve',contentVersion:rc.contentVersion},headers:{...key(),...eh,...im(rc.version)}});await must(r,200);
 r=await call(TRE,'GET','/collections/'+receipt.id,{headers:eh});rc=await must(r,200);
 r=await call(ACC,'POST','/collections/'+receipt.id+'/post',{body:{},headers:{...key(),...eh,...im(rc.version)}});await must(r,200);
 r=await call(PLAN,'POST','/projects/'+project.id+'/advances',{body:{collectionId:receipt.id,amount:'8000.00'},headers:{...key(),...eh}});const advance=await must(r,201);contract('post_projects_id_advances',advance);
 r=await call(PLAN,'GET','/projects/'+project.id+'/advances',{headers:eh});contract('get_projects_id_advances',await must(r,200));
 r=await call(PM,'POST','/projects/'+project.id+'/progress-billing',{body:{milestoneId:m1.id,certifiedAmount:'30000.00',retentionAmount:'3000.00',advanceRecoupment:'5000.00',accountingDate:'2026-10-20',evidenceIds:[ev['progress.pdf']]},headers:{...key(),...eh}});const billed=await must(r,200);contract('post_projects_id_progress_billing',billed);
 const invoiceId=billed.resourceId;
 r=await call(BILLING,'GET','/invoices/'+invoiceId,{headers:eh});let inv=await must(r,200);assert.equal(inv.gross,'27000.00');
 r=await call(BILLING,'POST','/invoices/'+invoiceId+'/submit',{body:{},headers:{...key(),...eh,...im(inv.version)}});await must(r,200);
 r=await call(ACC,'GET','/invoices/'+invoiceId,{headers:eh});inv=await must(r,200);
 r=await call(ACC,'POST','/invoices/'+invoiceId+'/approve',{body:{decision:'approve',contentVersion:inv.contentVersion},headers:{...key(),...eh,...im(inv.version)}});await must(r,200);
 r=await call(ACC,'GET','/invoices/'+invoiceId,{headers:eh});inv=await must(r,200);
 r=await call(ACC,'POST','/invoices/'+invoiceId+'/post',{body:{},headers:{...key(),...eh,...im(inv.version)}});const postedInv=await must(r,200);assert.equal(postedInv.state,'posted');
 r=await call(PLAN,'GET','/projects/'+project.id+'/retention',{headers:eh});const held=await must(r,200);contract('get_projects_id_retention',held);assert.equal(held.items[0].held,'3000.00');assert.equal(held.items[0].state,'held');
 r=await call(PLAN,'GET','/projects/'+project.id+'/advances',{headers:eh});assert.equal((await must(r,200)).items[0].recouped,'5000.00');
 r=await call(ACC,'GET','/open-items?side=AR',{headers:eh});const items=await must(r,200);const oi=items.items.find(i=>i.documentId===invoiceId);assert.ok(oi,'open item for the progress invoice');assert.equal(Number(oi.outstandingAmount),22000);
 r=await call(PM,'POST','/retention-items/'+held.items[0].id+'/release',{body:{accountingDate:'2026-10-28',evidenceIds:[ev['acceptance.pdf']],reason:'Final acceptance'},headers:{...key(),...eh,...im(held.items[0].version)}});const release=await must(r,200);contract('post_retention_items_id_release',release);
 r=await call(PLAN,'GET','/projects/'+project.id+'/profitability',{headers:eh});const profit=await must(r,200);contract('get_projects_id_profitability',profit);assert.equal(profit.billed,'30000.00');assert.equal(profit.revenuePosted,'30000.00');
 // Change order.
 r=await call(PLAN,'POST','/projects/'+project.id+'/change-orders',{body:{contractAmount:'120000.00',reason:'Additional floor',evidenceIds:[ev['change-order.pdf']]},headers:{...key(),...eh}});const co=await must(r,201);contract('post_projects_id_change_orders',co);assert.equal(co.versionNumber,2);
 r=await call(PM,'POST','/change-orders/'+co.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(co.version)}});await must(r,200);
 r=await call(PLAN,'GET','/projects/'+project.id,{headers:eh});assert.equal((await must(r,200)).contractAmount,'120000.00');
 pass('a project with an approved contract, a certified milestone, a documented advance, progress billing whose invoice posts through maker-checker holding retention and recouping the advance, the retention released, profitability, and a change order approved as the next version');
 // Isolation and gates.
 r=await call(PLAN,'GET','/projects/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call(CLERK,'GET','/budgets',{headers:eh});assert.equal(r.status,403,'the clerk reads no budgets');
 r=await call(PLAN,'POST','/packs/install',{body:{},headers:{...key(),...eh}});assert.ok([403,404,409].includes(r.status),'later-phase operations stay gated or refused for the caller');
 pass('unknown records answer 404, budgets are read by permission, later-phase operations stay gated');
 console.log('P16-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-30).join(String.fromCharCode(10)));throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
