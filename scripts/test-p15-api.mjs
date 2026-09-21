// P15-03 HTTP acceptance: intercompany and consolidation through the API as
// a process. A group defined, mapped and activated by two principals; a
// rate set entered and approved; an intercompany pair raised in the parent,
// accepted in the subsidiary under its own authority, posted side by side
// with the exception path; a consolidation run created, previewed, worked
// through the worksheet, approved and published; isolation and gates.
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
const PORT=4038,BASE='http://127.0.0.1:'+PORT,bucket='.local/p15-api-test-'+randomBytes(3).toString('hex');
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
const ACC='acc-'+suffix,REV='rev-'+suffix,CTRL='ctrl-'+suffix,CLERK='clerk-'+suffix,BILLING='billing-'+suffix,SEC='sec-'+suffix;
const CHAIN=['workspace','general_ledger','sales','purchasing','treasury','compliance','fi_coexistence','multi_currency','inventory','assets'];
const apiProcess=start('apps/api/src/server.mjs');
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 const pr={};const F={};let subAsCustomer,parentAsSupplier,ratesEvidence,subEvidence;
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-group-'+suffix,name:'Holdings',mode:'demo'});
  for(const [n,s] of [['accountant',ACC],['reviewer',REV],['controller',CTRL],['clerk',CLERK],['billing',BILLING],['security',SEC]])pr[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:s,displayName:n})).id;
  const roles={};
  for(const code of ['accountant','controller','clerk','billing','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),pr.security,code])).rows[0].id;
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),pr.security])).rows[0].id;
  roles.groupAccountant=await role('group_accountant',['group.create','group.edit','group.read','intercompany_pair.create','intercompany_pair.edit','intercompany_pair.read','intercompany_pair.accept','intercompany_pair.post','consolidation.create','consolidation.edit','consolidation.read','consolidation.preview']);
  roles.groupReviewer=await role('group_reviewer',['group.read','group.activate','intercompany_pair.read','consolidation.read','consolidation.approve','consolidation.publish','report.generate','session.read']);
  for(const [p,r] of [['accountant','accountant'],['accountant','groupAccountant'],['reviewer','groupReviewer'],['controller','controller'],['clerk','clerk'],['billing','billing'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,pr[p],roles[r],pr.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,pr.controller),traceId:'setup'};
  const ids={};
  for(const [k,name] of [['parent','Parent Holdings'],['sub','Subsidiary Trading']]){ids[k]=(await organization.createEntity(tx,ctrl,{legalName:name,baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;ctrl={...await identity.actorContext(tx,tenantId,pr.controller),traceId:'setup'};}
  const acc={...await identity.actorContext(tx,tenantId,pr.accountant),traceId:'setup'},clerk={...await identity.actorContext(tx,tenantId,pr.clerk),traceId:'setup'};
  for(const k of ['parent','sub']){
   const entityId=ids[k];
   const branch=await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'});
   for(const cap of CHAIN)await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,pr.reviewer,pr.controller]);
   const book=await ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'});
   const mk=(code,name,category,extra={})=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra});
   const a={cash:await mk('1010','Cash','asset'),ar:await mk('1200','Receivables','asset',{controlType:'ar'}),inTax:await mk('1300','Input tax','asset',{controlType:'input_tax'}),adv:await mk('1400','Advances','asset'),ap:await mk('2100','Payables','liability',{controlType:'ap'}),outTax:await mk('2200','Output tax','liability',{controlType:'output_tax'}),whtPay:await mk('2300','Withholding payable','liability'),equity:await mk('3000','Share capital','equity'),revenue:await mk('4000','Service revenue','income'),icrev:await mk('4100','Intercompany revenue','income'),fees:await mk('5000','Professional fees','expense'),icexp:await mk('5100','Intercompany services','expense')};
   const period=await ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-10-01',endsOn:'2026-10-31'});
   const approve=async(kind,payload)=>{const s=await organization.saveSettings(tx,ctrl,entityId,kind,payload);await organization.approveSettings(tx,{...await identity.actorContext(tx,tenantId,pr.reviewer),traceId:'setup',permissions:new Set(['entity.activate'])},entityId,s.id,{payloadHash:s.payloadHash});};
   await approve('sales_profile',{arAccountId:a.ar.id,outputTaxAccountId:a.outTax.id,cashAccountId:a.cash.id,scale:2,dueDays:30});
   await approve('purchasing_profile',{apAccountId:a.ap.id,inputTaxAccountId:a.inTax.id,cashAccountId:a.cash.id,withholdingPayableAccountId:a.whtPay.id,advanceAccountId:a.adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
   for(const [kind,prefix] of [['invoice','INV'],['bill','BILL']])await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branch.id,kind,prefix,pr.controller]);
   const j=await ledger.createJournal(tx,acc,entityId,{bookId:book.id,accountingDate:'2026-10-01',documentDate:'2026-10-01',currency:'PHP',description:'Share capital',lines:[{accountId:a.cash.id,branchId:branch.id,debit:k==='parent'?'100000.00':'50000.00',credit:'0',dimensions:{}},{accountId:a.equity.id,branchId:branch.id,debit:'0',credit:k==='parent'?'100000.00':'50000.00',dimensions:{}}],evidenceIds:[]});
   await ledger.submitJournal(tx,acc,entityId,j.id,{});await ledger.approveJournal(tx,ctrl,entityId,j.id,{decision:'approve',contentVersion:1});await ledger.postJournal(tx,ctrl,entityId,j.id,{});
   F[k]={entityId,branch,book,a,period};
  }
  const envKeys={FIELD_ENCRYPTION_KEY:fieldKey};
  subAsCustomer=await parties.createParty(tx,clerk,F.parent.entityId,{legalName:'Subsidiary Trading',roles:['customer'],identityStatus:'unknown',address:'Makati'},envKeys);
  parentAsSupplier=await parties.createParty(tx,clerk,F.sub.entityId,{legalName:'Parent Holdings',roles:['supplier'],identityStatus:'unknown',address:'Makati'},envKeys);
  const store=new FilesystemEvidenceStore(bucket);const letter=Buffer.from('%PDF-1.4 closing rates'+String.fromCharCode(10));
  const reg=await evidence.registerUpload(tx,ctrl,F.parent.entityId,{filename:'rates.pdf',mime:'application/pdf',byteCount:letter.length,sha256:sha(letter),classification:'internal'});
  await evidence.completeUpload(tx,ctrl,F.parent.entityId,reg.evidenceId,letter,store);await evidence.recordScan(tx,{tenantId,principalId:null},F.parent.entityId,reg.evidenceId,new evidence.FixtureScanner(),store);ratesEvidence=reg.evidenceId;
  const reg2=await evidence.registerUpload(tx,ctrl,F.sub.entityId,{filename:'intercompany-invoice.pdf',mime:'application/pdf',byteCount:letter.length,sha256:sha(letter),classification:'internal'});
  await evidence.completeUpload(tx,ctrl,F.sub.entityId,reg2.evidenceId,letter,store);await evidence.recordScan(tx,{tenantId,principalId:null},F.sub.entityId,reg2.evidenceId,new evidence.FixtureScanner(),store);subEvidence=reg2.evidenceId;
 });
 const P=F.parent,S=F.sub;const ph={'x-entity-id':P.entityId},sh={'x-entity-id':S.entityId};
 const members=[{entityId:P.entityId,ownershipPercent:'100',method:'full',effectiveFrom:'2026-01-01'},{entityId:S.entityId,ownershipPercent:'100',method:'full',effectiveFrom:'2026-01-01'}];
 // Group definition, mapping and activation.
 let r=await call(ACC,'POST','/groups',{body:{name:'Holdings group',reportingCurrency:'PHP',members},headers:{...key(),...ph}});assert.equal(r.status,409,'the capability gate');
 await inTransaction(api,{tenantId,principalId:null},tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'group_accounting','active','p15.1',$3,now(),$4)",[tenantId,P.entityId,pr.reviewer,pr.controller]));
 r=await call(REV,'POST','/groups',{body:{name:'Holdings group',reportingCurrency:'PHP',members},headers:{...key(),...ph}});assert.equal(r.status,403,'the reviewer defines no group');
 r=await call(ACC,'POST','/groups',{body:{name:'Holdings group',reportingCurrency:'PHP',members:[members[0],{...members[1],ownershipPercent:'60'}]},headers:{...key(),...ph}});assert.equal(r.status,409,'partial ownership blocks the member');
 r=await call(ACC,'POST','/groups',{body:{name:'Holdings group',reportingCurrency:'PHP',members},headers:{...key(),...ph}});const group=await must(r,201);contract('post_groups',group);
 r=await call(ACC,'GET','/groups',{headers:ph});const groups=await must(r,200);contract('get_groups',groups);assert.equal(groups.items[0].id,group.id);
 r=await call(ACC,'GET','/groups/'+group.id,{headers:ph});contract('get_groups_id',await must(r,200));
 r=await call(ACC,'PATCH','/groups/'+group.id,{body:{name:'Holdings group (2026)',reportingCurrency:'PHP',members},headers:{...ph,...im(group.version)}});const edited=await must(r,200);contract('patch_groups_id',edited);
 r=await call(REV,'POST','/groups/'+group.id+'/activate',{body:{reason:'go'},headers:{...key(),...ph,...im(edited.version)}});assert.equal(r.status,409,'activation before an approved mapping');
 const entry=(E,k,code,name,cat,role=null)=>({memberEntityId:E.entityId,accountId:E.a[k].id,groupAccountCode:code,groupAccountName:name,groupCategory:cat,role});
 const entries=[];for(const E of [P,S])entries.push(entry(E,'cash','G1010','Cash','asset'),entry(E,'ar','G1200','Receivables','asset'),entry(E,'inTax','G1300','Input tax','asset'),entry(E,'adv','G1400','Advances','asset'),entry(E,'ap','G2100','Payables','liability'),entry(E,'outTax','G2200','Output tax','liability'),entry(E,'whtPay','G2300','Withholding payable','liability'),entry(E,'equity','G3000','Share capital','equity'),entry(E,'revenue','G4000','Revenue','income'),entry(E,'icrev','G4100','Intercompany revenue','income','intercompany_revenue'),entry(E,'fees','G5000','Professional fees','expense'),entry(E,'icexp','G5100','Intercompany services','expense','intercompany_expense'));
 r=await call(ACC,'POST','/groups/'+group.id+'/mappings',{body:{mappingVersion:'2026.1',entries},headers:{...key(),...ph}});const mapping=await must(r,201);contract('post_groups_id_mappings',mapping);
 r=await call(ACC,'GET','/groups/'+group.id+'/mappings',{headers:ph});const mappings=await must(r,200);contract('get_groups_id_mappings',mappings);assert.equal(mappings.items[0].entries.length,entries.length);
 r=await call(ACC,'POST','/group-mappings/'+mapping.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...ph,...im(mapping.version)}});assert.equal(r.status,403);
 r=await call(REV,'POST','/group-mappings/'+mapping.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...ph,...im(mapping.version)}});contract('post_group_mappings_id_approve',await must(r,200));
 r=await call(REV,'POST','/groups/'+group.id+'/activate',{body:{reason:'Ownership, method and mapping reviewed'},headers:{...key(),...ph,...im(edited.version)}});const active=await must(r,200);contract('post_groups_id_activate',active);assert.equal(active.state,'active');
 r=await call(ACC,'PATCH','/groups/'+group.id,{body:{name:'x',reportingCurrency:'USD',members},headers:{...ph,...im(active.version)}});assert.equal(r.status,409,'an active group is frozen');
 pass('a group defined by the accountant with wholly-owned members, mapped, the mapping approved and the group activated by the reviewer; minority interests and the capability gate refused; frozen once active');

 // Rate set.
 r=await call(ACC,'POST','/rate-sets',{body:{code:'2026-10',periodEnd:'2026-10-31',rates:[{currency:'USD',closing:'58',average:'57',historical:'56'}],sourceEvidenceId:ratesEvidence},headers:{...key(),...ph}});const rateSet=await must(r,201);contract('post_rate_sets',rateSet);
 r=await call(ACC,'GET','/rate-sets',{headers:ph});contract('get_rate_sets',await must(r,200));
 r=await call(ACC,'GET','/rate-sets/'+rateSet.id,{headers:ph});contract('get_rate_sets_id',await must(r,200));
 r=await call(ACC,'POST','/rate-sets/'+rateSet.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...ph,...im(rateSet.version)}});assert.equal(r.status,403);
 r=await call(REV,'POST','/rate-sets/'+rateSet.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...ph,...im(rateSet.version)}});contract('post_rate_sets_id_approve',await must(r,200));
 pass('a rate set from source evidence, approved by the reviewer');

 // Intercompany pair over HTTP: the parent invoices the subsidiary; acceptance in the subsidiary; the saga.
 r=await call(BILLING,'POST','/invoices',{body:{kind:'invoice',branchId:P.branch.id,bookId:P.book.id,partyId:subAsCustomer.id,documentDate:'2026-10-10',accountingDate:'2026-10-10',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Management services',quantity:'1',unitPrice:'12000',discount:'0',priceBasis:'exclusive',accountId:P.a.icrev.id,dimensions:{}}],evidenceIds:[]},headers:{...key(),...ph}});const invoice=await must(r,201);
 const targetDraft={kind:'bill',branchId:S.branch.id,bookId:S.book.id,partyId:parentAsSupplier.id,documentDate:'2026-10-10',accountingDate:'2026-10-10',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Management services',quantity:'1',unitPrice:'12000',discount:'0',priceBasis:'exclusive',accountId:S.a.icexp.id,dimensions:{}}],evidenceIds:[subEvidence]};
 r=await call(ACC,'POST','/intercompany-pairs',{body:{sourceEntityId:P.entityId,targetEntityId:S.entityId,sourceDocumentId:invoice.id,targetDraft},headers:{...key(),...sh}});assert.equal(r.status,422,'raised in the source entity only');
 r=await call(ACC,'POST','/intercompany-pairs',{body:{sourceEntityId:P.entityId,targetEntityId:S.entityId,sourceDocumentId:invoice.id,targetDraft},headers:{...key(),...ph}});const pair=await must(r,201);contract('post_intercompany_pairs',pair);
 r=await call(ACC,'GET','/intercompany-pairs',{headers:ph});contract('get_intercompany_pairs',await must(r,200));
 r=await call(ACC,'GET','/intercompany-pairs?detail=1',{headers:sh});const seen=await must(r,200);assert.equal(seen.items[0].sharedReference,'ICP-000001','the target entity sees the pair with its shared reference');
 r=await call(ACC,'GET','/intercompany-pairs/'+pair.id,{headers:sh});contract('get_intercompany_pairs_id',await must(r,200));
 r=await call(ACC,'PATCH','/intercompany-pairs/'+pair.id,{body:{sourceEntityId:P.entityId,targetEntityId:S.entityId,sourceDocumentId:invoice.id,targetDraft:{...targetDraft,lines:[{...targetDraft.lines[0],description:'Management services Q4'}]}},headers:{...ph,...im(pair.version)}});const edit=await must(r,200);contract('patch_intercompany_pairs_id',edit);
 r=await call(ACC,'POST','/intercompany-pairs/'+pair.id+'/accept',{body:{decision:'approve',contentVersion:edit.contentVersion},headers:{...key(),...ph,...im(edit.version)}});assert.equal(r.status,403,'the source entity does not accept');
 r=await call(REV,'POST','/intercompany-pairs/'+pair.id+'/accept',{body:{decision:'approve',contentVersion:edit.contentVersion},headers:{...key(),...sh,...im(edit.version)}});assert.equal(r.status,403,'the reviewer holds no acceptance authority');
 r=await call(ACC,'POST','/intercompany-pairs/'+pair.id+'/accept',{body:{decision:'approve',contentVersion:edit.contentVersion},headers:{...key(),...sh,...im(edit.version)}});const accepted=await must(r,200);contract('post_intercompany_pairs_id_accept',accepted);assert.equal(accepted.state,'accepted');
 r=await call(ACC,'GET','/bills',{headers:sh});const bills=await must(r,200);assert.equal(bills.items.length,1);const bill=bills.items[0];assert.equal(bill.state,'draft');
 r=await call(BILLING,'POST','/invoices/'+invoice.id+'/submit',{body:{},headers:{...key(),...ph,...im(invoice.version)}});await must(r,200);
 r=await call(ACC,'GET','/invoices/'+invoice.id,{headers:ph});let inv=await must(r,200);
 r=await call(ACC,'POST','/invoices/'+invoice.id+'/approve',{body:{decision:'approve',contentVersion:inv.contentVersion},headers:{...key(),...ph,...im(inv.version)}});await must(r,200);
 r=await call(ACC,'GET','/intercompany-pairs/'+pair.id,{headers:ph});let p=await must(r,200);
 r=await call(ACC,'POST','/intercompany-pairs/'+pair.id+'/post',{body:{},headers:{...key(),...ph,...im(p.version)}});const sourcePosted=await must(r,200);contract('post_intercompany_pairs_id_post',sourcePosted);assert.equal(sourcePosted.state,'accepted');assert.equal(sourcePosted.journalEntryIds.length,1);
 r=await call(ACC,'GET','/intercompany-pairs/'+pair.id,{headers:sh});p=await must(r,200);
 r=await call(ACC,'POST','/intercompany-pairs/'+pair.id+'/post',{body:{},headers:{...key(),...sh,...im(p.version)}});const exception=await must(r,200);assert.equal(exception.state,'exception','the unapproved target side is an exception, not a fabricated journal');
 r=await call(ACC,'GET','/intercompany-pairs?detail=1&status=exception',{headers:sh});const ex=await must(r,200);assert.match(ex.items[0].exceptionReason,/STATE_CONFLICT/);
 r=await call(CLERK,'POST','/bills/'+bill.id+'/submit',{body:{},headers:{...key(),...sh,...im(bill.version)}});await must(r,200);
 r=await call(ACC,'GET','/bills/'+bill.id,{headers:sh});let b=await must(r,200);
 r=await call(ACC,'POST','/bills/'+bill.id+'/approve',{body:{decision:'approve',contentVersion:b.contentVersion},headers:{...key(),...sh,...im(b.version)}});assert.equal(r.status,403,'the accepter prepared the bill and cannot approve it');
 r=await call(CTRL,'POST','/bills/'+bill.id+'/approve',{body:{decision:'approve',contentVersion:b.contentVersion},headers:{...key(),...sh,...im(b.version)}});await must(r,200);
 r=await call(ACC,'GET','/intercompany-pairs/'+pair.id,{headers:sh});p=await must(r,200);
 r=await call(ACC,'POST','/intercompany-pairs/'+pair.id+'/post',{body:{},headers:{...key(),...sh,...im(p.version)}});const posted=await must(r,200);assert.equal(posted.state,'posted');assert.equal(posted.journalEntryIds.length,1);
 pass('a pair raised in the parent, edited, accepted in the subsidiary under its own authority (the accepter prepares, another principal approves), the source side issued, the second side an exception until approved, then posted');

 // Consolidation run from frozen member snapshots.
 const snaps={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{const rev={...await identity.actorContext(tx,tenantId,pr.reviewer),traceId:'setup'};const ctrl={...await identity.actorContext(tx,tenantId,pr.controller),traceId:'setup'};for(const [k,E] of Object.entries(F)){await ledger.softClosePeriod(tx,ctrl,E.entityId,E.period.id,{reason:'Month end'});snaps[k]=(await ledger.snapshotReport(tx,rev,E.entityId,{reportType:'statements',bookId:E.book.id,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:'2026-11-05T00:00:00.000Z',format:'json'})).id;}});
 r=await call(ACC,'GET','/groups/'+group.id+'/readiness?periodEnd=2026-10-31',{headers:ph});const ready=await must(r,200);contract('get_groups_id_readiness',ready);assert.ok(ready.members.every(m=>m.ready),'both members ready');assert.deepEqual(ready.members.map(m=>m.snapshotId).sort(),[snaps.parent,snaps.sub].sort());
 const runBody={groupId:group.id,periodEnd:'2026-10-31',memberSnapshotIds:[snaps.parent,snaps.sub],rateSetId:rateSet.id,mappingVersion:'2026.1'};
 r=await call(ACC,'POST','/consolidations',{body:{...runBody,memberSnapshotIds:[snaps.parent]},headers:{...key(),...ph}});assert.equal(r.status,422,'every member needs a snapshot');
 r=await call(ACC,'POST','/consolidations',{body:runBody,headers:{...key(),...ph}});const run1=await must(r,201);contract('post_consolidations',run1);
 r=await call(ACC,'GET','/consolidations',{headers:ph});contract('get_consolidations',await must(r,200));
 r=await call(ACC,'GET','/consolidations/'+run1.id,{headers:ph});contract('get_consolidations_id',await must(r,200));
 r=await call(REV,'POST','/consolidations/'+run1.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...ph,...im(run1.version)}});assert.equal(r.status,409,'approval before preview');
 r=await call(ACC,'POST','/consolidations/'+run1.id+'/preview',{body:{},headers:{...key(),...ph,...im(run1.version)}});const preview=await must(r,200);contract('post_consolidations_id_preview',preview);assert.equal(preview.state,'previewed');
 r=await call(REV,'GET','/consolidations/'+run1.id+'/worksheet',{headers:ph});const ws=await must(r,200);contract('get_consolidations_id_worksheet',ws);
 const line=code=>ws.lines.find(l=>l.groupAccountCode===code);
 assert.equal(line('G1200').consolidated,'0.00');assert.equal(line('G2100').consolidated,'0.00');assert.equal(line('G4100').consolidated,'0.00');assert.equal(line('G5100').consolidated,'0.00');
 assert.equal(line('G1010').consolidated,'150000.00');assert.equal(ws.totals.balanced,true);assert.equal(ws.differences.length,0);assert.equal(ws.eliminations.length,1);
 r=await call(ACC,'POST','/consolidations/'+run1.id+'/eliminations',{body:{lines:[{groupAccountCode:'G1010',debit:'0.00',credit:'5.00'}],reason:'Test adjustment',evidenceIds:[ratesEvidence]},headers:{...key(),...ph}});const elim=await must(r,201);contract('post_consolidations_id_eliminations',elim);
 r=await call(ACC,'GET','/consolidations/'+run1.id,{headers:ph});let run=await must(r,200);assert.equal(run.state,'draft','a manual elimination returns the run to draft');
 r=await call(ACC,'POST','/consolidations/'+run1.id+'/preview',{body:{},headers:{...key(),...ph,...im(run.version)}});await must(r,200);
 r=await call(ACC,'GET','/consolidations/'+run1.id,{headers:ph});run=await must(r,200);
 r=await call(REV,'POST','/consolidations/'+run1.id+'/approve',{body:{decision:'approve',contentVersion:run.contentVersion},headers:{...key(),...ph,...im(run.version)}});assert.equal(r.status,409,'an unbalanced elimination is never plugged');
 r=await call(ACC,'POST','/consolidations',{body:runBody,headers:{...key(),...ph}});const run2=await must(r,201);
 r=await call(ACC,'POST','/consolidations/'+run2.id+'/preview',{body:{},headers:{...key(),...ph,...im(run2.version)}});await must(r,200);
 r=await call(ACC,'GET','/consolidations?detail=1',{headers:ph});const runs=await must(r,200);const d1=runs.items.find(x=>x.id===run1.id),d2=runs.items.find(x=>x.id===run2.id);assert.equal(d2.versionNumber,2);assert.equal(d2.resultHash,ws.resultHash,'same snapshots, same hash');assert.notEqual(d1.resultHash,ws.resultHash);
 r=await call(ACC,'GET','/consolidations/'+run2.id,{headers:ph});run=await must(r,200);
 r=await call(ACC,'POST','/consolidations/'+run2.id+'/approve',{body:{decision:'approve',contentVersion:run.contentVersion},headers:{...key(),...ph,...im(run.version)}});assert.equal(r.status,403,'the preparer role does not approve');
 r=await call(REV,'POST','/consolidations/'+run2.id+'/approve',{body:{decision:'approve',contentVersion:run.contentVersion},headers:{...key(),...ph,...im(run.version)}});const approved=await must(r,200);contract('post_consolidations_id_approve',approved);
 r=await call(ACC,'PATCH','/consolidations/'+run2.id,{body:runBody,headers:{...ph,...im(approved.version)}});assert.equal(r.status,409,'approved inputs are frozen');
 r=await call(ACC,'POST','/consolidations/'+run2.id+'/publish',{body:{},headers:{...key(),...ph,...im(approved.version)}});assert.equal(r.status,403);
 r=await call(REV,'POST','/consolidations/'+run2.id+'/publish',{body:{},headers:{...key(),...ph,...im(approved.version)}});const published=await must(r,200);contract('post_consolidations_id_publish',published);assert.equal(published.state,'published');
 r=await call(ACC,'GET','/consolidations/'+run2.id+'/worksheet',{headers:ph});assert.equal((await must(r,200)).state,'published');
 pass('a run created from frozen snapshots, previewed, its worksheet balanced with the pair eliminated once, a manual elimination and its unresolved difference blocking approval, a second run with the same hash approved and published by the reviewer');

 // Isolation and gates.
 r=await call(REV,'POST','/journals',{body:{bookId:S.book.id,accountingDate:'2026-10-05',documentDate:'2026-10-05',currency:'PHP',description:'x',lines:[{accountId:S.a.cash.id,branchId:S.branch.id,debit:'1.00',credit:'0',dimensions:{}},{accountId:S.a.revenue.id,branchId:S.branch.id,debit:'0',credit:'1.00',dimensions:{}}],evidenceIds:[]},headers:{...key(),...sh}});assert.equal(r.status,403,'the reviewer writes no subsidiary journal');
 r=await call(ACC,'GET','/consolidations/'+run2.id,{headers:sh});assert.equal(r.status,404,'runs live in the reporting entity');
 r=await call(ACC,'GET','/groups/'+randomUUID(),{headers:ph});assert.equal(r.status,404);
 r=await call(ACC,'POST','/packs/install',{body:{},headers:{...key(),...ph}});assert.ok([403,404,409].includes(r.status),'later-phase operations stay gated or refused for the caller');
 pass('the reviewer holds no subsidiary authority; runs are read in the reporting entity only; unknown records answer 404 and later-phase operations stay gated');
 console.log('P15-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-30).join(String.fromCharCode(10)));throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
