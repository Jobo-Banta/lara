// P15-02 intercompany and consolidation domain against real PostgreSQL
// through the runtime role: P15-T01 a two-entity balanced fixture
// consolidates and eliminates reciprocal AR/AP and revenue/expense once;
// P15-T02 a missing second-side approval stays an exception with no
// fabricated journal; P15-T03 the translation difference lands in the
// reserve with a traceable rate; P15-T04 the same member snapshots yield
// the same result hash and a new snapshot a new run version; P15-T05 the
// group reviewer cannot touch a subsidiary book without entity authority.
// Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales,purchasing,consolidation} from '../packages/domain/src/index.mjs';
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
const CHAIN=['workspace','general_ledger','sales','purchasing','treasury','compliance','fi_coexistence','multi_currency','inventory','assets'];
try{
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-group-'+suffix,name:'Group domain',mode:'demo'});
  for(const n of ['billing','clerk','accountant','tax','treasury','controller','director','security','reviewer'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['billing','clerk','accountant','tax','treasury','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds the group, pair or consolidation authorities; the tenant defines a group accountant (prepares) and a group reviewer (approves, publishes) — noted for owner review.
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.groupAccountant=await role('group_accountant',['group.create','group.edit','group.read','intercompany_pair.create','intercompany_pair.edit','intercompany_pair.read','intercompany_pair.accept','intercompany_pair.post','consolidation.create','consolidation.edit','consolidation.read','consolidation.preview']);
  roles.groupReviewer=await role('group_reviewer',['group.read','group.activate','intercompany_pair.read','consolidation.read','consolidation.approve','consolidation.publish','report.generate']);
  for(const [p,r] of [['billing','billing'],['clerk','clerk'],['accountant','accountant'],['accountant','groupAccountant'],['tax','tax'],['treasury','treasury'],['controller','controller'],['director','controller'],['security','security_admin'],['reviewer','groupReviewer']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'group-'+n}));
 let ctrl=await ctxFor('controller');
 // Three entities: the parent and a subsidiary in PHP trading with each other; an overseas member in USD.
 const ids={};
 for(const [key,name,cur] of [['parent','Parent Holdings','PHP'],['sub','Subsidiary Trading','PHP'],['overseas','Overseas Services','USD']]){ids[key]=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:name,baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;ctrl=await ctxFor('controller');}
 let bill=await ctxFor('billing'),clerk=await ctxFor('clerk'),acc=await ctxFor('accountant'),dir=await ctxFor('director'),rev=await ctxFor('reviewer');
 const approve=async(entityId,kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 const fixtures={};
 for(const key of ['parent','sub','overseas']){
  const entityId=ids[key];const cur=key==='overseas'?'USD':'PHP';
  const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
  for(const cap of CHAIN)await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
  const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:cur.toLowerCase()+'-main',kind:'primary',functionalCurrency:cur,sourceOwner:'lara'}));
  const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
  const a={};
  a.cash=await mk('1010','Cash','asset');a.ar=await mk('1200','Receivables','asset',{controlType:'ar'});a.icar=await mk('1210','Intercompany receivables','asset',{controlType:'ar'});a.inTax=await mk('1300','Input tax','asset',{controlType:'input_tax'});a.adv=await mk('1400','Advances','asset');
  a.ap=await mk('2100','Payables','liability',{controlType:'ap'});a.icap=await mk('2110','Intercompany payables','liability',{controlType:'ap'});a.outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'});a.whtPay=await mk('2300','Withholding payable','liability');
  a.equity=await mk('3000','Share capital','equity');a.revenue=await mk('4000','Service revenue','income');a.icrev=await mk('4100','Intercompany revenue','income');a.fees=await mk('5000','Professional fees','expense');a.icexp=await mk('5100','Intercompany services','expense');
  const period=await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-10-01',endsOn:'2026-10-31'}));
  await approve(entityId,'sales_profile',{arAccountId:a.ar.id,outputTaxAccountId:a.outTax.id,cashAccountId:a.cash.id,scale:2,dueDays:30});
  await approve(entityId,'purchasing_profile',{apAccountId:a.ap.id,inputTaxAccountId:a.inTax.id,cashAccountId:a.cash.id,withholdingPayableAccountId:a.whtPay.id,advanceAccountId:a.adv.id,withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
  for(const [kind,prefix] of [['invoice','INV'],['bill','BILL']])await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branch.id,kind,prefix,principals.controller]));
  fixtures[key]={entityId,branch,book,a,period};
 }
 ctrl=await ctxFor('controller');bill=await ctxFor('billing');clerk=await ctxFor('clerk');acc=await ctxFor('accountant');dir=await ctxFor('director');rev=await ctxFor('reviewer');
 const P=fixtures.parent,S=fixtures.sub,O=fixtures.overseas;
 // Counterparties: the subsidiary as a customer of the parent; the parent as a supplier of the subsidiary; third parties for outside trade.
 const subAsCustomer=await run(clerk,tx=>parties.createParty(tx,clerk,P.entityId,{legalName:'Subsidiary Trading',roles:['customer'],identityStatus:'unknown',address:'Makati'},env));
 const parentAsSupplier=await run(clerk,tx=>parties.createParty(tx,clerk,S.entityId,{legalName:'Parent Holdings',roles:['supplier'],identityStatus:'unknown',address:'Makati'},env));
 const outsideCustomer=await run(clerk,tx=>parties.createParty(tx,clerk,S.entityId,{legalName:'Delta Retail',roles:['customer'],identityStatus:'unknown',address:'Cebu'},env));
 const journal=async(F,lines,description,date='2026-10-05')=>{const j=await run(acc,tx=>ledger.createJournal(tx,acc,F.entityId,{bookId:F.book.id,accountingDate:date,documentDate:date,currency:F.book.functionalCurrency,description,lines:lines.map(([accountId,debit,credit])=>({accountId,branchId:F.branch.id,debit,credit,dimensions:{}})),evidenceIds:[]}));await run(acc,tx=>ledger.submitJournal(tx,acc,F.entityId,j.id,{}));await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,F.entityId,j.id,{decision:'approve',contentVersion:1}));await run(ctrl,tx=>ledger.postJournal(tx,ctrl,F.entityId,j.id,{}));return j;};
 // Opening capital and outside trade so every member carries balances.
 await journal(P,[[P.a.cash.id,'100000.00','0'],[P.a.equity.id,'0','100000.00']],'Share capital','2026-10-01');
 await journal(S,[[S.a.cash.id,'50000.00','0'],[S.a.equity.id,'0','50000.00']],'Share capital','2026-10-01');
 await journal(O,[[O.a.cash.id,'1000.00','0'],[O.a.equity.id,'0','1000.00']],'Share capital','2026-10-01');
 await journal(O,[[O.a.cash.id,'200.00','0'],[O.a.revenue.id,'0','200.00']],'Consulting fees');
 const outsideInvoice=await run(bill,tx=>sales.createDocument(tx,bill,S.entityId,{kind:'invoice',branchId:S.branch.id,bookId:S.book.id,partyId:outsideCustomer.id,documentDate:'2026-10-06',accountingDate:'2026-10-06',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Goods',quantity:'1',unitPrice:'8000',discount:'0',priceBasis:'exclusive',accountId:S.a.revenue.id,dimensions:{}}],evidenceIds:[]}));
 await run(bill,tx=>sales.submitDocument(tx,bill,S.entityId,outsideInvoice.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,S.entityId,outsideInvoice.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>sales.postDocument(tx,acc,S.entityId,outsideInvoice.id,{}));
 pass('fixture: parent and subsidiary in PHP with intercompany control accounts, an overseas member in USD, capital, outside trade, a group accountant and a group reviewer');

 // Group definition (P15-T05 boundary: the reviewer holds no entity authority beyond the parent's reports).
 await rejects(run(acc,tx=>consolidation.createGroup(tx,acc,P.entityId,{name:'Holdings',reportingCurrency:'PHP',members:[{entityId:P.entityId,ownershipPercent:'100',method:'full',effectiveFrom:'2026-01-01'}]})),'FEATURE_NOT_ENABLED','group before the capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'group_accounting','active','p15.1',$3,now(),$4)",[tenantId,P.entityId,principals.director,principals.controller]));
 const members=[{entityId:P.entityId,ownershipPercent:'100',method:'full',effectiveFrom:'2026-01-01'},{entityId:S.entityId,ownershipPercent:'100',method:'full',effectiveFrom:'2026-01-01'},{entityId:O.entityId,ownershipPercent:'100',method:'full',effectiveFrom:'2026-01-01'}];
 await rejects(run(acc,tx=>consolidation.createGroup(tx,acc,P.entityId,{name:'Holdings',reportingCurrency:'PHP',members:[members[0],{...members[1],ownershipPercent:'60'}]})),'FEATURE_NOT_ENABLED','partial ownership blocks the member');
 await rejects(run(acc,tx=>consolidation.createGroup(tx,acc,P.entityId,{name:'Holdings',reportingCurrency:'PHP',members:[members[1]]})),'VALIDATION_FAILED','the reporting entity is a member');
 const group=await run(acc,tx=>consolidation.createGroup(tx,acc,P.entityId,{name:'Holdings group',reportingCurrency:'PHP',members}));
 assert.equal(group.state,'draft');assert.equal(group.members.length,3);
 await rejects(run(rev,tx=>consolidation.activateGroup(tx,rev,P.entityId,group.id,{reason:'go'})),'STATE_CONFLICT','activation before an approved mapping');
 const entry=(F,key,code,name,cat,role=null)=>({memberEntityId:F.entityId,accountId:F.a[key].id,groupAccountCode:code,groupAccountName:name,groupCategory:cat,role});
 const entries=[];
 for(const F of [P,S,O]){
  entries.push(entry(F,'cash','G1010','Cash','asset'),entry(F,'ar','G1200','Receivables','asset'),entry(F,'icar','G1210','Intercompany receivables','asset','intercompany_receivable'),entry(F,'inTax','G1300','Input tax','asset'),entry(F,'adv','G1400','Advances','asset'),
   entry(F,'ap','G2100','Payables','liability'),entry(F,'icap','G2110','Intercompany payables','liability','intercompany_payable'),entry(F,'outTax','G2200','Output tax','liability'),entry(F,'whtPay','G2300','Withholding payable','liability'),
   entry(F,'equity','G3000','Share capital','equity'),entry(F,'revenue','G4000','Revenue','income'),entry(F,'icrev','G4100','Intercompany revenue','income','intercompany_revenue'),entry(F,'fees','G5000','Professional fees','expense'),entry(F,'icexp','G5100','Intercompany services','expense','intercompany_expense'));
 }
 await rejects(run(acc,tx=>consolidation.createMapping(tx,acc,P.entityId,group.id,{mappingVersion:'2026.1',entries:[...entries,entry(P,'cash','G1010','Cash','liability')]})),'VALIDATION_FAILED','one account mapped twice');
 const mapping=await run(acc,tx=>consolidation.createMapping(tx,acc,P.entityId,group.id,{mappingVersion:'2026.1',entries}));
 await rejects(run(acc,tx=>consolidation.createMapping(tx,acc,P.entityId,group.id,{mappingVersion:'2026.1',entries})),'STATE_CONFLICT','mapping versions are immutable');
 await rejects(run(acc,tx=>consolidation.approveMapping(tx,acc,P.entityId,mapping.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the accountant does not approve mappings');
 await run(rev,tx=>consolidation.approveMapping(tx,rev,P.entityId,mapping.id,{decision:'approve',contentVersion:1}));
 await rejects(run(acc,tx=>consolidation.activateGroup(tx,acc,P.entityId,group.id,{reason:'go'})),'FORBIDDEN','the definer does not activate');
 await run(rev,tx=>consolidation.activateGroup(tx,rev,P.entityId,group.id,{reason:'Ownership and mapping reviewed'}));
 assert.equal((await run(acc,tx=>consolidation.getGroup(tx,acc,P.entityId,group.id))).state,'active');
 await rejects(run(acc,tx=>consolidation.updateGroup(tx,acc,P.entityId,group.id,undefined,{name:'Holdings',reportingCurrency:'USD',members})),'STATE_CONFLICT','an active group keeps its currency');
 pass('group with three wholly-owned members under the full method, minority interests and missing reporting entity refused, mapping version approved by the reviewer, activation by the reviewer only after an approved mapping, active group frozen');

 // Intercompany pair: the parent invoices the subsidiary; the subsidiary accepts the bill (P15-T02 first).
 const evidenceFor=async(entityId,name)=>{const bytes=Buffer.from('%PDF-1.4 '+name+String.fromCharCode(10));const reg=await run(acc,tx=>evidence.registerUpload(tx,acc,entityId,{filename:name,mime:'application/pdf',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(acc,tx=>evidence.completeUpload(tx,acc,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const subEvidence=await evidenceFor(S.entityId,'intercompany-invoice.pdf');
 const draftFor=(price,account=S.a.icexp)=>({kind:'bill',branchId:S.branch.id,bookId:S.book.id,partyId:parentAsSupplier.id,documentDate:'2026-10-10',accountingDate:'2026-10-10',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Management services',quantity:'1',unitPrice:price,discount:'0',priceBasis:'exclusive',accountId:account.id,dimensions:{}}],evidenceIds:[subEvidence]});
 const invoice=await run(bill,tx=>sales.createDocument(tx,bill,P.entityId,{kind:'invoice',branchId:P.branch.id,bookId:P.book.id,partyId:subAsCustomer.id,documentDate:'2026-10-10',accountingDate:'2026-10-10',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Management services',quantity:'1',unitPrice:'12000',discount:'0',priceBasis:'exclusive',accountId:P.a.icrev.id,dimensions:{}}],evidenceIds:[]}));
 await rejects(run(acc,tx=>consolidation.createPair(tx,acc,S.entityId,{sourceEntityId:P.entityId,targetEntityId:S.entityId,sourceDocumentId:invoice.id,targetDraft:draftFor('12000')})),'VALIDATION_FAILED','pair raised outside the source entity');
 await rejects(run(acc,tx=>consolidation.createPair(tx,acc,P.entityId,{sourceEntityId:P.entityId,targetEntityId:S.entityId,sourceDocumentId:invoice.id,targetDraft:{...draftFor('12000'),kind:'invoice'}})),'VALIDATION_FAILED','the target is the counterpart kind');
 await rejects(run(acc,tx=>consolidation.createPair(tx,acc,P.entityId,{sourceEntityId:P.entityId,targetEntityId:S.entityId,sourceDocumentId:invoice.id,targetDraft:{...draftFor('12000'),currency:'USD'}})),'VALIDATION_FAILED','both sides in the source currency');
 const pair=await run(acc,tx=>consolidation.createPair(tx,acc,P.entityId,{sourceEntityId:P.entityId,targetEntityId:S.entityId,sourceDocumentId:invoice.id,targetDraft:draftFor('12000')}));
 assert.equal(pair.state,'draft');
 await rejects(run(acc,tx=>consolidation.createPair(tx,acc,P.entityId,{sourceEntityId:P.entityId,targetEntityId:S.entityId,sourceDocumentId:invoice.id,targetDraft:draftFor('12000')})),'STATE_CONFLICT','one pair per source document');
 await rejects(run(acc,tx=>consolidation.postPair(tx,acc,P.entityId,pair.id,{})),'STATE_CONFLICT','posting before acceptance');
 await rejects(run(acc,tx=>consolidation.acceptPair(tx,acc,P.entityId,pair.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the source entity does not accept its own pair');
 const accepted=await run(acc,tx=>consolidation.acceptPair(tx,acc,S.entityId,pair.id,{decision:'approve',contentVersion:1}));
 assert.equal(accepted.state,'accepted');
 const targetBill=(await run(acc,tx=>tx.query('select * from lara.documents where tenant_id=$1 and id=$2',[tenantId,accepted.targetDocumentId]))).rows[0];
 assert.equal(targetBill.entity_id,S.entityId);assert.equal(targetBill.state,'draft');assert.equal(String(targetBill.gross),'12000.000000');
 // The source side issues; the target side is not yet approved: the pair is an exception and no journal appears in the subsidiary.
 await run(bill,tx=>sales.submitDocument(tx,bill,P.entityId,invoice.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,P.entityId,invoice.id,{decision:'approve',contentVersion:1}));
 const sourcePosted=await run(acc,tx=>consolidation.postPair(tx,acc,P.entityId,pair.id,{}));
 assert.equal(sourcePosted.state,'accepted');assert.equal(sourcePosted.journalEntryIds.length,1,'the source side posted one entry');
 const targetTry=await run(acc,tx=>consolidation.postPair(tx,acc,S.entityId,pair.id,{}));
 assert.equal(targetTry.state,'exception');assert.match(targetTry.exceptionReason,/STATE_CONFLICT/,'the failed second side is recorded');
 const subEntries=async()=>(await run(acc,tx=>tx.query('select count(*)::int n from lara.journal_entries where tenant_id=$1 and entity_id=$2 and source_type=$3',[tenantId,S.entityId,'document']))).rows[0].n;
 assert.equal(await subEntries(),1,'only the outside invoice is posted in the subsidiary; nothing fabricated');
 const invoiceRow=(await run(acc,tx=>tx.query('select state from lara.documents where tenant_id=$1 and id=$2',[tenantId,invoice.id]))).rows[0];
 assert.equal(invoiceRow.state,'posted','the issued first side stays posted');
 pass('P15-T02: the source side issues, the unapproved target side fails, the pair is an exception with the reason and no journal is fabricated; the issued side is never rolled back');

 // Second side approved and posted: the pair completes.
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,S.entityId,targetBill.id,{}));await rejects(run(acc,tx=>purchasing.approveDocument(tx,acc,S.entityId,targetBill.id,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','the accepter prepared the bill and cannot approve it');await run(ctrl,tx=>purchasing.approveDocument(tx,ctrl,S.entityId,targetBill.id,{decision:'approve',contentVersion:1}));
 const targetPosted=await run(acc,tx=>consolidation.postPair(tx,acc,S.entityId,pair.id,{}));
 assert.equal(targetPosted.state,'posted');assert.equal(await subEntries(),2);
 await rejects(run(acc,tx=>consolidation.updatePair(tx,acc,P.entityId,pair.id,undefined,{sourceEntityId:P.entityId,targetEntityId:S.entityId,sourceDocumentId:invoice.id,targetDraft:draftFor('1')})),'STATE_CONFLICT','a posted pair is final');
 pass('the pair completes once the target entity approves and posts its own bill; posted pairs are final');

 // Snapshots after freezing the closes; rate set; runs (P15-T01, T03, T04).
 const bspEvidence=await evidenceFor(P.entityId,'closing-rates.pdf');
 const rateSet=await run(acc,tx=>consolidation.createRateSet(tx,acc,P.entityId,{code:'2026-10',periodEnd:'2026-10-31',rates:[{currency:'USD',closing:'58',average:'57',historical:'56'}],sourceEvidenceId:bspEvidence}));
 await rejects(run(acc,tx=>consolidation.approveRateSet(tx,acc,P.entityId,rateSet.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the accountant does not approve rates');
 const snapshotFor=async F=>run(rev,tx=>ledger.snapshotReport(tx,rev,F.entityId,{reportType:'statements',bookId:F.book.id,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:'2026-11-05T00:00:00.000Z',format:'json'}));
 const snapP=await snapshotFor(P),snapS=await snapshotFor(S),snapO=await snapshotFor(O);
 const runInput={groupId:group.id,periodEnd:'2026-10-31',memberSnapshotIds:[snapP.id,snapS.id,snapO.id],rateSetId:rateSet.id,mappingVersion:'2026.1'};
 await rejects(run(acc,tx=>consolidation.createRun(tx,acc,P.entityId,runInput)),'STATE_CONFLICT','runs need frozen member closes');
 for(const F of [P,S,O])await run(ctrl,tx=>ledger.softClosePeriod(tx,ctrl,F.entityId,F.period.id,{reason:'Month end'}));
 await rejects(run(acc,tx=>consolidation.createRun(tx,acc,P.entityId,runInput)),'RULE_PROFILE_NOT_APPROVED','runs need an approved rate set');
 await run(rev,tx=>consolidation.approveRateSet(tx,rev,P.entityId,rateSet.id,{decision:'approve',contentVersion:1}));
 await rejects(run(acc,tx=>consolidation.createRun(tx,acc,P.entityId,{...runInput,memberSnapshotIds:[snapP.id,snapS.id]})),'VALIDATION_FAILED','every member needs a snapshot');
 await rejects(run(acc,tx=>consolidation.createRun(tx,acc,P.entityId,{...runInput,mappingVersion:'2026.9'})),'RULE_PROFILE_NOT_APPROVED','unknown mapping version');
 const run1=await run(acc,tx=>consolidation.createRun(tx,acc,P.entityId,runInput));
 assert.equal(run1.state,'draft');
 const preview1=await run(acc,tx=>consolidation.previewRun(tx,acc,P.entityId,run1.id,{}));
 assert.equal(preview1.state,'previewed');assert.equal(preview1.unresolvedCount,0,'no unresolved differences');assert.equal(preview1.balanced,true);
 const ws=await run(rev,tx=>consolidation.worksheet(tx,rev,P.entityId,run1.id));
 const line=code=>ws.lines.find(l=>l.groupAccountCode===code);
 // Reciprocal balances: the 12,000 receivable in the parent against the 12,000 payable in the subsidiary, eliminated once; the subsidiary's outside receivable of 8,000 stays.
 assert.equal(line('G1200').eliminations,'-12000.00','intercompany receivable eliminated');assert.equal(line('G1200').consolidated,'8000.00','outside receivable kept');
 assert.equal(line('G2100').eliminations,'12000.00','intercompany payable eliminated');assert.equal(line('G2100').consolidated,'0.00');
 // Intra-group revenue and expense: eliminated once; outside revenue (8,000 + 200 USD at 57) stays.
 assert.equal(line('G4100').consolidated,'0.00','intercompany revenue eliminated');assert.equal(line('G5100').consolidated,'0.00','intercompany expense eliminated');
 assert.equal(line('G4000').consolidated,'-19400.00','outside revenue 8,000 + 200 × 57');
 assert.equal(ws.eliminations.length,1,'one elimination for the one pair, balances and revenue/expense together');assert.equal(ws.eliminations[0].amount,'24000.00');
 assert.ok(ws.eliminations.every(e=>e.difference==='0.00'));
 // Translation (P15-T03): cash 1,200 USD at closing 58 = 69,600; capital 1,000 at historical 56 = 56,000; income 200 at average 57 = 11,400; the residual 2,200 sits in the reserve with the rates recorded.
 assert.equal(ws.totals.translationReserve,'2200.00');
 const reserve=line('3900');assert.ok(reserve,'reserve line present');assert.equal(reserve.translation,'-2200.00');
 const tr=ws.translation.filter(t=>t.memberEntityId===O.entityId);
 assert.deepEqual(tr.map(t=>[t.source,t.policy,t.rate,t.amount]),[['balance_sheet','closing','58','69600.00'],['income','period_average','57','-11400.00'],['equity','historical','56','-56000.00']]);
 assert.equal(ws.totals.balanced,true);
 const stored=(await run(acc,tx=>tx.query('select source,policy,rate::text as rate,amount::text as amount from lara.translation_adjustments where tenant_id=$1 and run_id=$2 and member_entity_id=$3 order by source',[tenantId,run1.id,O.entityId]))).rows;
 assert.equal(stored.length,3);assert.equal(stored.find(r=>r.source==='balance_sheet').rate.replace(/\.?0+$/,''),'58');
 pass('P15-T01 and T03: reciprocal intercompany balances and intra-group revenue and expense eliminated once, outside trade kept, the overseas member translated at closing, average and historical rates with the difference in the reserve and each rate traceable');

 // Determinism (P15-T04): the same inputs give the same hash; a new snapshot gives a new run version.
 const preview1b=await run(acc,tx=>consolidation.previewRun(tx,acc,P.entityId,run1.id,{}));
 assert.equal(preview1b.resultHash,preview1.resultHash,'re-preview is stable');
 const run2=await run(acc,tx=>consolidation.createRun(tx,acc,P.entityId,runInput));
 const preview2=await run(acc,tx=>consolidation.previewRun(tx,acc,P.entityId,run2.id,{}));
 assert.equal(preview2.resultHash,preview1.resultHash,'same member snapshots, same result hash');
 assert.equal((await run(acc,tx=>consolidation.listRunDetails(tx,acc,P.entityId,{}))).items.map(r=>r.versionNumber).join(','),'1,2');
 // Approval and publication by the reviewer; the preparer cannot approve; a run with a manual elimination that does not balance cannot be approved.
 await rejects(run(acc,tx=>consolidation.approveRun(tx,acc,P.entityId,run1.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the preparer role does not approve');
 await rejects(run(rev,tx=>consolidation.approveRun(tx,rev,P.entityId,run1.id,{decision:'approve',contentVersion:2})),'VERSION_CONFLICT','stale content version');
 await run(rev,tx=>consolidation.approveRun(tx,rev,P.entityId,run1.id,{decision:'approve',contentVersion:1}));
 await rejects(run(acc,tx=>consolidation.addElimination(tx,acc,P.entityId,run1.id,{lines:[{groupAccountCode:'G1010',debit:'1.00',credit:'0.00'}],reason:'late',evidenceIds:[bspEvidence]})),'STATE_CONFLICT','approved runs take no eliminations');
 const published=await run(rev,tx=>consolidation.publishRun(tx,rev,P.entityId,run1.id,{}));
 assert.equal(published.state,'published');
 const snap=(await run(acc,tx=>tx.query("select report_type,checksum,book_id from lara.report_snapshots where tenant_id=$1 and id=$2",[tenantId,published.snapshotId]))).rows[0];
 assert.equal(snap.report_type,'consolidated_statements');assert.equal(snap.checksum,preview1.resultHash);
 const groupBook=(await run(acc,tx=>tx.query("select code,kind from lara.books where tenant_id=$1 and id=$2",[tenantId,snap.book_id]))).rows[0];
 assert.deepEqual(groupBook,{code:'CONSOL',kind:'management'},'the consolidated snapshot lives in the group book');
 // A new member snapshot: a new run version with a different hash; publishing it supersedes the first.
 await run(ctrl,tx=>tx.query("update lara.periods set status='open' where tenant_id=$1 and id=$2",[tenantId,O.entityId&&O.period.id]));
 await journal(O,[[O.a.cash.id,'50.00','0'],[O.a.revenue.id,'0','50.00']],'Late fees','2026-10-20');
 await run(ctrl,tx=>ledger.softClosePeriod(tx,ctrl,O.entityId,O.period.id,{reason:'Month end again'}));
 const snapO2=await snapshotFor(O);
 assert.equal(snapO2.versionNumber,2);
 const run3=await run(acc,tx=>consolidation.createRun(tx,acc,P.entityId,{...runInput,memberSnapshotIds:[snapP.id,snapS.id,snapO2.id]}));
 assert.equal((await run(acc,tx=>consolidation.listRunDetails(tx,acc,P.entityId,{}))).items.find(r=>r.id===run3.id).versionNumber,3);
 const preview3=await run(acc,tx=>consolidation.previewRun(tx,acc,P.entityId,run3.id,{}));
 assert.notEqual(preview3.resultHash,preview1.resultHash,'a new snapshot changes the result');
 // Manual elimination with reason and evidence returns the run to draft; an unbalanced one blocks approval.
 await run(acc,tx=>consolidation.addElimination(tx,acc,P.entityId,run3.id,{lines:[{groupAccountCode:'G1010',debit:'0.00',credit:'10.00'}],reason:'Unsupported adjustment',evidenceIds:[bspEvidence]}));
 assert.equal((await run(acc,tx=>consolidation.getRun(tx,acc,P.entityId,run3.id))).state,'draft');
 const preview3b=await run(acc,tx=>consolidation.previewRun(tx,acc,P.entityId,run3.id,{}));
 assert.equal(preview3b.unresolvedCount,1);assert.equal(preview3b.balanced,false);
 await rejects(run(rev,tx=>consolidation.approveRun(tx,rev,P.entityId,run3.id,{decision:'approve',contentVersion:1})),'STATE_CONFLICT','unresolved differences are never plugged');
 pass('P15-T04: re-preview and a second run on the same snapshots give the same hash; a new member snapshot gives version 3 with a new hash; approval and publication by the reviewer write the consolidated snapshot in the group book; an unbalanced manual elimination stays unresolved and blocks approval');

 // P15-T05: the reviewer reads the parent's group but holds no authority in the subsidiary.
 await rejects(run(rev,tx=>ledger.createJournal(tx,rev,S.entityId,{bookId:S.book.id,accountingDate:'2026-10-05',documentDate:'2026-10-05',currency:'PHP',description:'Group adjustment',lines:[{accountId:S.a.cash.id,branchId:S.branch.id,debit:'1.00',credit:'0',dimensions:{}},{accountId:S.a.revenue.id,branchId:S.branch.id,debit:'0',credit:'1.00',dimensions:{}}],evidenceIds:[]})),'FORBIDDEN','the reviewer prepares no subsidiary journal');
 await rejects(run(rev,tx=>consolidation.acceptPair(tx,rev,S.entityId,pair.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the reviewer accepts no pair');
 await rejects(run(rev,tx=>consolidation.postPair(tx,rev,S.entityId,pair.id,{})),'FORBIDDEN','the reviewer posts no side');
 const reviewerScoped={...rev,entityIds:new Set([P.entityId])};
 await rejects(run(reviewerScoped,tx=>consolidation.listPairs(tx,reviewerScoped,S.entityId,{})),'NOT_FOUND','an entity outside the scope is not disclosed');
 assert.equal((await run(acc,tx=>tx.query('select count(*)::int n from lara.journal_entries where tenant_id=$1 and entity_id=$2',[tenantId,S.entityId]))).rows[0].n,3,'the subsidiary ledger holds only its own three entries');
 pass('P15-T05: the group reviewer approves and publishes the consolidation but cannot prepare, accept or post in a subsidiary without that entity\'s authority; subsidiary ledgers are never rewritten');
 console.log('P15-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
