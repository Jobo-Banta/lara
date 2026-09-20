// P05-03 HTTP acceptance: purchasing operations through the API and worker as
// processes. Purchase order approval, bill with server totals and the
// supplier reference duplicate guard, independent approval and posting,
// idempotent replay, supplier credit correction, payment proposal, payment
// order authority, release and settlement with evidence and typed refusals,
// expense claim, AP open items and the supplier aging job, and isolation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,parties,evidence,purchasing} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4028,BASE='http://127.0.0.1:'+PORT,bucket='.local/p05-api-test-'+randomBytes(3).toString('hex');
const fieldKey=process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex');
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:fieldKey,WORKER_POLL_MS:'200',RATE_LIMIT_WRITES_PER_MINUTE:'1000',RATE_LIMIT_READS_PER_MINUTE:'5000',MAIL_ADAPTER:'local'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
const children=[];
function start(file){const c=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>{out+=b;});c.stderr.on('data',b=>{out+=b;});c.log=()=>out;c.done=false;c.once('exit',()=>{c.done=true;});children.push(c);return c;}
async function stop(c){if(c.done)return;const exited=new Promise(r=>c.once('exit',r));c.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);if(!c.done)c.kill('SIGKILL');}
async function waitFor(fn,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,200));}assert.fail('timeout: '+label);}
const principals={};
const call=async(name,method,path,{body,headers={}}={})=>{const token=signIdentity(name+'-'+suffix,method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET);return fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});};
const json=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return {raw:t};}};
const must=async(r,status)=>{const t=await r.text();assert.equal(r.status,status,t);try{return JSON.parse(t);}catch{return {raw:t};}};
const key=()=>({'idempotency-key':randomUUID()});
const im=v=>({'if-match':'"'+v+'"'});
const contract=(op,body)=>{const v=validateResponse(op,body);assert.equal(v.ok,true,op+' drifted: '+JSON.stringify(v.fieldErrors)+' '+JSON.stringify(body).slice(0,300));};
const apiProcess=start('apps/api/src/server.mjs');let worker=null;
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 let entityId,branchId,bookId,supplierId,employeeId,evidenceId,vatId,beneficiaryId;const accounts={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-purch-'+suffix,name:'Purchasing API',mode:'demo'});
  for(const n of ['clerk','purchaser','accountant','treasury','tax','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['clerk','accountant','treasury','tax','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  roles.purchaser=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'purchaser','Purchaser','[\"purchase_order.create\",\"purchase_order.edit\",\"purchase_order.read\",\"purchase_order.submit\",\"purchase_order.cancel\",\"bill.read\",\"party.read\",\"report.generate\"]','approved',$2,$3) returning id",[tenantId,sha('purchaser'),principals.security])).rows[0].id;
  for(const [p,r] of [['clerk','clerk'],['purchaser','purchaser'],['accountant','accountant'],['treasury','treasury'],['tax','tax'],['controller','controller'],['director','controller'],['director','purchaser'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Purchasing API Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  branchId=(await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'})).id;
  for(const c of ['workspace','general_ledger','sales','purchasing'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.director,principals.controller]);
  bookId=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,principals.controller])).rows[0].id;
  for(const [code,name,category,control] of [['1010','Cash','asset','none'],['1300','Input tax','asset','input_tax'],['1400','Employee advances','asset','none'],['2100','Payables','liability','ap'],['2300','Withholding payable','liability','none'],['5000','Professional fees','expense','none']])accounts[code]=(await tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id",[tenantId,entityId,bookId,code,name,category,category==='asset'||category==='expense'?'debit':'credit',control,control==='none',sha(code),principals.accountant])).rows[0].id;
  await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-09-01','2026-09-30',$4)",[tenantId,entityId,bookId,principals.controller]);
  await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'bill','BILL','numbering-2026',$4)",[tenantId,entityId,branchId,principals.controller]);
  const clerk={...await identity.actorContext(tx,tenantId,principals.clerk),traceId:'setup'};
  supplierId=(await parties.createParty(tx,clerk,entityId,{legalName:'Supplies Inc',roles:['supplier'],identityStatus:'unknown',address:'Cebu'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  employeeId=(await parties.createParty(tx,clerk,entityId,{legalName:'Juan Dela Cruz',roles:['employee'],identityStatus:'unknown',address:'Pasig'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  const s=await organization.saveSettings(tx,ctrl,entityId,'purchasing_profile',{apAccountId:accounts['2100'],inputTaxAccountId:accounts['1300'],cashAccountId:accounts['1010'],withholdingPayableAccountId:accounts['2300'],advanceAccountId:accounts['1400'],withholdingRecognition:'accrual',scale:2,dueDays:30,requireReceiptOfService:false,supplierWithholding:{[supplierId]:'EWT2'}});
  const dir={...await identity.actorContext(tx,tenantId,principals.director),traceId:'setup'};
  await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});
  const pdf=Buffer.from('%PDF-1.4 supplier invoice\n');const store=new evidence.MemoryEvidenceStore();
  const reg=await evidence.registerUpload(tx,clerk,entityId,{filename:'si.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'internal'});
  await evidence.completeUpload(tx,clerk,entityId,reg.evidenceId,pdf,store);
  await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);
  evidenceId=reg.evidenceId;
  // Active VAT and withholding rule versions and an approved beneficiary are seeded: rules have P04 operations, beneficiaries none yet.
  const rule=async(code,type,rate)=>(await tx.query("insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,content_hash,created_by,status,approved_by,activated_by,activated_at) values($1,$2,$3,1,$4,'2026-01-01',$5,'net','accrual','line_half_up',gen_random_uuid(),$6,'[\"AC-03\"]',$7,$8,'active',$9,$9,now()) returning id",[tenantId,entityId,code,type,rate,JSON.stringify([evidenceId]),sha(code),principals.tax,principals.controller])).rows[0].id;
  vatId=await rule('VAT12','vat','0.12');await rule('EWT2','withholding','0.02');
  const tre={...await identity.actorContext(tx,tenantId,principals.treasury),traceId:'setup'};
  const ben=await purchasing.createBeneficiary(tx,tre,entityId,{partyId:supplierId,bankName:'BDO',accountName:'Supplies Inc',accountNumber:'0012345678'},{FIELD_ENCRYPTION_KEY:fieldKey});
  beneficiaryId=(await purchasing.approveBeneficiary(tx,ctrl,entityId,ben.id)).id;
 });
 const eh={'x-entity-id':entityId};
 const line=(unitPrice,extra={})=>({description:'Consulting',quantity:'1',unitPrice,discount:'0',priceBasis:'exclusive',accountId:accounts['5000'],taxCodeId:vatId,dimensions:{},...extra});
 const docBody=(kind,partyId,lines,extra={})=>({kind,branchId,bookId,partyId,documentDate:'2026-09-18',accountingDate:'2026-09-18',currency:'PHP',ruleProfileVersion:'ph-2026',lines,evidenceIds:[evidenceId],...extra});
 // Purchase order
 let r=await call('clerk','POST','/purchase-orders',{body:docBody('purchase_order',supplierId,[line('20000')]),headers:{...key(),...eh}});assert.equal(r.status,403,'clerk holds no purchase_order.create');
 r=await call('purchaser','POST','/purchase-orders',{body:docBody('bill',supplierId,[line('20000')]),headers:{...key(),...eh}});assert.equal(r.status,422,'kind must be purchase_order');
 r=await call('purchaser','POST','/purchase-orders',{body:docBody('purchase_order',supplierId,[line('20000')]),headers:{...key(),...eh}});const po=await must(r,201);contract('post_purchase_orders',po);assert.deepEqual([po.kind,po.net,po.state],['purchase_order','20000.00','draft']);
 r=await call('purchaser','POST','/purchase-orders/'+po.id+'/submit',{body:{},headers:{...key(),...eh,...im(po.version)}});const poSub=await must(r,200);contract('post_purchase_orders_id_submit',poSub);
 r=await call('accountant','POST','/purchase-orders/'+po.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(poSub.version)}});assert.equal(r.status,403);
 r=await call('controller','POST','/purchase-orders/'+po.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(poSub.version)}});const poApp=await must(r,200);assert.equal(poApp.state,'approved');
 r=await call('purchaser','GET','/purchase-orders',{headers:eh});const pos=await must(r,200);contract('get_purchase_orders',pos);assert.equal(pos.items[0].state,'approved');
 pass('purchase order: kind enforced, submit and approval under separate roles, listed with contract shape');
 // Bill lifecycle with duplicate guard, idempotent replay, ETag/If-Match, posting
 const billBody=(lines,extra={})=>docBody('bill',supplierId,lines,{externalReference:'SI-0001',...extra});
 r=await call('clerk','POST','/bills',{body:billBody([line('10000')]),headers:eh});assert.equal(r.status,428);
 r=await call('clerk','POST','/bills',{body:{...billBody([line('10000')]),gross:'1.00'},headers:{...key(),...eh}});assert.equal(r.status,422,'client totals are not part of the contract');
 const k=key();
 r=await call('clerk','POST','/bills',{body:billBody([line('12000')],{sourceDocumentId:po.id}),headers:{...k,...eh}});const bill=await must(r,201);contract('post_bills',bill);
 assert.deepEqual([bill.net,bill.tax,bill.gross,bill.state,bill.sourceDocumentId,bill.settlementState],['12000.00','1440.00','13440.00','draft',po.id,'unpaid']);
 r=await call('clerk','POST','/bills',{body:billBody([line('12000')],{sourceDocumentId:po.id}),headers:{...k,...eh}});assert.equal(r.status,201);assert.equal((await json(r)).id,bill.id,'idempotent replay returns the same bill');
 r=await call('clerk','POST','/bills',{body:billBody([line('100')],{externalReference:' si/0001 '}),headers:{...key(),...eh}});assert.equal(r.status,409);assert.equal((await json(r)).code,'DUPLICATE_SOURCE');
 r=await call('clerk','POST','/bills',{body:billBody([line('9000')],{externalReference:'SI-0009',sourceDocumentId:po.id}),headers:{...key(),...eh}});assert.equal(r.status,409,'two-way match');assert.match((await json(r)).message,/Two-way match/);
 r=await call('clerk','GET','/bills/'+bill.id,{headers:eh});assert.equal(r.headers.get('etag'),'"1"');
 r=await call('clerk','POST','/bills/'+bill.id+'/submit',{body:{},headers:{...key(),...eh,...im(1)}});const submitted=await must(r,200);contract('post_bills_id_submit',submitted);assert.equal(submitted.state,'submitted');
 r=await call('clerk','POST','/bills/'+bill.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(submitted.version)}});assert.equal(r.status,403);
 r=await call('accountant','POST','/bills/'+bill.id+'/approve',{body:{decision:'approve',contentVersion:9},headers:{...key(),...eh,...im(submitted.version)}});assert.equal(r.status,412);assert.equal((await json(r)).code,'VERSION_CONFLICT');
 r=await call('accountant','POST','/bills/'+bill.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(submitted.version)}});const approved=await must(r,200);assert.equal(approved.state,'approved');
 r=await call('accountant','POST','/bills/'+bill.id+'/post',{body:{},headers:{...key(),...eh,...im(approved.version-1)}});assert.equal(r.status,412);
 r=await call('accountant','POST','/bills/'+bill.id+'/post',{body:{},headers:{...key(),...eh,...im(approved.version)}});const posted=await must(r,200);contract('post_bills_id_post',posted);assert.equal(posted.state,'posted');assert.equal(posted.journalEntryIds.length,1);
 r=await call('clerk','GET','/bills/'+bill.id,{headers:eh});const billView=await must(r,200);contract('get_bills_id',billView);assert.equal(billView.officialNumber,'BILL-000001');
 r=await call('clerk','PATCH','/bills/'+bill.id,{body:billBody([line('1')],{sourceDocumentId:po.id}),headers:{...eh,...im(billView.version)}});assert.equal(r.status,409);
 r=await call('clerk','GET','/open-items?partyId='+supplierId+'&side=AP',{headers:eh});const items=await must(r,200);contract('get_open_items',items);
 assert.deepEqual(items.items.map(i=>[i.side,i.originalAmount,i.outstandingAmount]),[['AP','13200.00','13200.00']],'payable net of the 2% withholding accrued (240)');
 r=await call('purchaser','POST','/purchase-orders/'+po.id+'/cancel',{body:{reason:'Done'},headers:{...key(),...eh,...im(poApp.version)}});assert.equal(r.status,409,'orders with bills do not cancel');
 pass('bill: missing idempotency key 428, client totals rejected, PO-linked bill with server totals 12,000 / 1,440 / 13,440, idempotent replay, normalized duplicate reference 409 DUPLICATE_SOURCE, two-way match refusal, ETag, forbidden and stale approvals, versioned posting to BILL-000001 opening the 13,200 payable');
 // Supplier credit correction
 r=await call('accountant','POST','/bills/'+bill.id+'/correct',{body:{kind:'credit_note',accountingDate:'2026-09-20',reason:'Too much',lines:[line('12001')]},headers:{...key(),...eh,...im(billView.version)}});assert.equal(r.status,409);
 r=await call('accountant','POST','/bills/'+bill.id+'/correct',{body:{kind:'credit_note',accountingDate:'2026-09-20',reason:'Scope reduced',lines:[line('2000')],evidenceIds:[evidenceId]},headers:{...key(),...eh,...im(billView.version)}});const corr=await must(r,200);contract('post_bills_id_correct',corr);
 r=await call('clerk','GET','/bills/'+corr.resourceId,{headers:eh});const cn=await must(r,200);assert.deepEqual([cn.kind,cn.gross],['credit_note','2240.00']);
 r=await call('clerk','GET','/invoices/'+corr.resourceId,{headers:eh});assert.equal(r.status,404,'a supplier credit is not an invoice');
 r=await call('clerk','POST','/bills/'+corr.resourceId+'/submit',{body:{},headers:{...key(),...eh,...im(1)}});const cnSub=await must(r,200);
 r=await call('controller','POST','/bills/'+corr.resourceId+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(cnSub.version)}});const cnApp=await must(r,200);
 r=await call('accountant','POST','/bills/'+corr.resourceId+'/post',{body:{},headers:{...key(),...eh,...im(cnApp.version)}});const cnPosted=await must(r,200);assert.equal(cnPosted.state,'posted');
 r=await call('clerk','GET','/open-items?partyId='+supplierId+'&side=AP',{headers:eh});const afterCredit=await must(r,200);
 assert.deepEqual(afterCredit.items.map(i=>[i.allocatedAmount,i.outstandingAmount]),[['2200.00','11000.00']]);
 r=await call('clerk','GET','/bills?state=posted',{headers:eh});const postedBills=await must(r,200);contract('get_bills',postedBills);assert.deepEqual(postedBills.items.map(d=>d.kind).sort(),['bill','credit_note']);
 pass('correction: over-credit refused, a supplier credit travels through review, posts and applies 2,200 to the payable; supplier credits list under bills, never under invoices');
 // Payment proposal, order, authority, release, settlement
 const item=afterCredit.items[0];
 const proposal={direction:'payment',partyId:supplierId,currency:'PHP',valueDate:'2026-09-25',grossAmount:'11000.00',cashAmount:'11000.00',withholdingAmount:'0.00',method:'transfer',allocations:[{openItemId:item.id,amount:'11000.00'}],evidenceIds:[]};
 r=await call('treasury','POST','/settlements',{body:{...proposal,direction:'receipt'},headers:{...key(),...eh}});assert.equal(r.status,422);
 r=await call('treasury','POST','/settlements',{body:{...proposal,withholdingAmount:'100.00',cashAmount:'10900.00'},headers:{...key(),...eh}});assert.equal(r.status,422,'withholding already accrued');
 r=await call('treasury','POST','/settlements',{body:proposal,headers:{...key(),...eh}});const st=await must(r,201);contract('post_settlements',st);assert.deepEqual([st.state,st.direction],['draft','payment']);
 r=await call('treasury','GET','/collections/'+st.id,{headers:eh});assert.equal(r.status,404,'a payment proposal is not a collection');
 r=await call('treasury','POST','/payments',{body:{settlementId:st.id,beneficiaryVersionId:randomUUID(),scheduledDate:'2026-09-26'},headers:{...key(),...eh}});assert.equal(r.status,404);
 r=await call('treasury','POST','/payments',{body:{settlementId:st.id,beneficiaryVersionId:beneficiaryId,scheduledDate:'2026-09-26'},headers:{...key(),...eh}});const pay=await must(r,201);contract('post_payments',pay);assert.equal(pay.state,'draft');
 r=await call('treasury','POST','/payments/'+pay.id+'/submit',{body:{},headers:{...key(),...eh,...im(pay.version)}});assert.equal(r.status,409,'the proposal is submitted first');
 r=await call('treasury','POST','/settlements/'+st.id+'/submit',{body:{},headers:{...key(),...eh,...im(st.version)}});const stSub=await must(r,200);contract('post_settlements_id_submit',stSub);
 r=await call('treasury','POST','/payments/'+pay.id+'/submit',{body:{},headers:{...key(),...eh,...im(pay.version)}});const paySub=await must(r,200);contract('post_payments_id_submit',paySub);
 r=await call('treasury','POST','/payments/'+pay.id+'/authorize',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(paySub.version)}});assert.equal(r.status,403);
 r=await call('controller','POST','/payments/'+pay.id+'/authorize',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(paySub.version)}});const auth=await must(r,200);contract('post_payments_id_authorize',auth);assert.equal(auth.state,'authorized');
 r=await call('treasury','GET','/settlements/'+st.id,{headers:eh});const stView=await must(r,200);contract('get_settlements_id',stView);assert.equal(stView.state,'approved');
 r=await call('treasury','POST','/payments/'+pay.id+'/settle',{body:{externalReference:'BANK-1',settledAt:'2026-09-26T02:00:00Z',valueDate:'2026-09-26',evidenceIds:[evidenceId]},headers:{...key(),...eh,...im(auth.version)}});assert.equal(r.status,409,'settle before release');
 r=await call('treasury','POST','/payments/'+pay.id+'/release',{body:{channel:'bank_file',externalReference:'F1',evidenceIds:[evidenceId]},headers:{...key(),...eh,...im(auth.version)}});assert.equal(r.status,409);assert.equal((await json(r)).code,'FEATURE_NOT_ENABLED');
 r=await call('treasury','POST','/payments/'+pay.id+'/release',{body:{channel:'manual',externalReference:'TXN-1',evidenceIds:[]},headers:{...key(),...eh,...im(auth.version)}});assert.equal(r.status,422,'release evidence is mandatory');
 r=await call('treasury','POST','/payments/'+pay.id+'/release',{body:{channel:'manual',externalReference:'TXN-1',evidenceIds:[evidenceId]},headers:{...key(),...eh,...im(auth.version)}});const rel=await must(r,200);contract('post_payments_id_release',rel);assert.equal(rel.state,'released');
 const sk=key();
 const settleBody={externalReference:'BANK-1',settledAt:'2026-09-26T02:00:00Z',valueDate:'2026-09-26',evidenceIds:[evidenceId]};
 r=await call('treasury','POST','/payments/'+pay.id+'/settle',{body:settleBody,headers:{...sk,...eh,...im(rel.version)}});const settled=await must(r,200);contract('post_payments_id_settle',settled);assert.equal(settled.state,'settled');assert.equal(settled.journalEntryIds.length,1);
 r=await call('treasury','POST','/payments/'+pay.id+'/settle',{body:settleBody,headers:{...sk,...eh,...im(rel.version)}});assert.deepEqual((await must(r,200)).journalEntryIds,settled.journalEntryIds,'replay returns the same effect');
 r=await call('treasury','POST','/payments/'+pay.id+'/settle',{body:settleBody,headers:{...key(),...eh,...im(settled.version)}});assert.deepEqual((await must(r,200)).journalEntryIds,settled.journalEntryIds,'a new command on a settled payment adds nothing');
 r=await call('clerk','GET','/bills/'+bill.id,{headers:eh});assert.equal((await json(r)).settlementState,'paid');
 r=await call('treasury','GET','/payments',{headers:eh});const pays=await must(r,200);contract('get_payments',pays);assert.equal(pays.items[0].state,'settled');
 r=await call('treasury','GET','/settlements',{headers:eh});const sts=await must(r,200);contract('get_settlements',sts);assert.equal(sts.items[0].state,'posted');
 r=await call('treasury','POST','/payments/'+pay.id+'/return',{body:{accountingDate:'2026-09-27',reason:'Bank returned it'},headers:{...key(),...eh,...im(settled.version)}});const ret=await must(r,200);contract('post_payments_id_return',ret);assert.equal(ret.state,'returned');assert.equal(ret.journalEntryIds.length,1);
 r=await call('clerk','GET','/bills/'+bill.id,{headers:eh});assert.equal((await json(r)).settlementState,'partial');
 pass('payment: proposal separate from the bill, unknown beneficiary 404, order submitted after the proposal, authority under another role, settle before release 409, bank-file release gated, evidence mandatory, settlement posts once under replay and repeat, return mirrors it and reopens the payable');
 // Expense claim with advance
 const claim=docBody('expense_claim',employeeId,[line('900',{taxCodeId:undefined,description:'Meals'})]);
 r=await call('clerk','POST','/expense-claims',{body:docBody('expense_claim',supplierId,claim.lines),headers:{...key(),...eh}});assert.equal(r.status,422,'claims name an employee');
 r=await call('clerk','POST','/expense-claims',{body:claim,headers:{...key(),...eh}});const ec=await must(r,201);contract('post_expense_claims',ec);assert.equal(ec.gross,'900.00');
 r=await call('clerk','POST','/expense-claims/'+ec.id+'/submit',{body:{},headers:{...key(),...eh,...im(ec.version)}});const ecSub=await must(r,200);
 r=await call('accountant','POST','/expense-claims/'+ec.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(ecSub.version)}});const ecApp=await must(r,200);
 r=await call('accountant','POST','/expense-claims/'+ec.id+'/post',{body:{},headers:{...key(),...eh,...im(ecApp.version)}});const ecPosted=await must(r,200);contract('post_expense_claims_id_post',ecPosted);assert.equal(ecPosted.journalEntryIds.length,1);
 r=await call('clerk','GET','/open-items?partyId='+employeeId+'&side=AP',{headers:eh});assert.deepEqual((await must(r,200)).items.map(i=>i.outstandingAmount),['900.00']);
 r=await call('clerk','GET','/expense-claims',{headers:eh});const claims=await must(r,200);contract('get_expense_claims',claims);assert.equal(claims.items[0].state,'posted');
 pass('expense claim: employee required, review and posting open a payable to the employee');
 // Worker: supplier aging job
 worker=start('apps/worker/src/main.mjs');
 r=await call('director','POST','/reports',{body:{reportType:'ap_aging',bookId,periodStart:'2026-09-01',periodEnd:'2026-11-30',asOf:new Date().toISOString(),format:'csv'},headers:{...key(),...eh}});const job=await must(r,202);contract('post_reports',job);
 await waitFor(async()=>['succeeded','failed'].includes((await json(await call('director','GET','/jobs/'+job.id,{headers:eh}))).state),'ap aging job',60000);
 const done=await json(await call('director','GET','/jobs/'+job.id,{headers:eh}));assert.equal(done.state,'succeeded',worker?.log().split('\n').slice(-6).join('\n'));
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 const snap=(await api.query("select payload from lara.report_snapshots where tenant_id=$1 and report_type='ap_aging'",[tenantId])).rows[0].payload;
 assert.equal(snap.side,'AP');assert.equal(snap.totals.total,'11900.00');
 pass('worker: the supplier aging report runs as a job into an immutable snapshot (11,000 reopened + 900 employee payable)');
 // Isolation and unknown resources
 r=await call('clerk','GET','/bills/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('clerk','GET','/bills/'+bill.id,{headers:{'x-entity-id':randomUUID()}});assert.equal(r.status,404);
 r=await call('purchaser','GET','/purchase-orders/'+bill.id,{headers:eh});assert.equal(r.status,404,'a bill is not addressable as a purchase order');
 r=await call('clerk','GET','/expense-claims/'+bill.id,{headers:eh});assert.equal(r.status,404);
 r=await call('treasury','GET','/payments/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('clerk','POST','/bank-accounts',{body:{},headers:{...key(),...eh}});assert.equal(r.status,409);assert.equal((await json(r)).code,'FEATURE_NOT_ENABLED');
 pass('unknown documents, foreign entities and mismatched families answer 404; P06 bank operations stay gated');
 console.log('P05-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split('\n').slice(-15).join('\n'));throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
