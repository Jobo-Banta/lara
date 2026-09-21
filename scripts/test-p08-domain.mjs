// P08-02 financial institution coexistence domain against real PostgreSQL
// through the runtime role: P08-T01 the same batch presented 100 times yields
// one journal and the same id with another checksum conflicts; P08-T02 a
// missing or late batch blocks the affected close only; P08-T03 a manifest
// that disagrees with the staged detail cannot be approved; P08-T04 an
// interbranch pair appears in both branches and cancels in the entity roll-up;
// P08-T05 every enabled GRT/DST rule carries reviewed golden cases and the
// worksheet classifies instrument facts by category and maturity band without
// silent zeros. Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,sales,fi} from '../packages/domain/src/index.mjs';
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
const FI_PERMS=['source_ownership.create','source_ownership.edit','source_ownership.read','import.create','import.validate','import.read','import.edit','evidence.upload','evidence.read','tax_rule.read','account.read','book.read','branch.read','journal.read','period.read'];
try{
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-fi-'+suffix,name:'Institution domain',mode:'demo'});
  for(const n of ['officer','accountant','tax','controller','director','auditor','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['accountant','tax','controller','auditor','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  roles.fi=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'fi_officer','Institution officer',$2,'approved',$3,$4) returning id",[tenantId,JSON.stringify(FI_PERMS),sha('fi'),principals.security])).rows[0].id;
  for(const [p,r] of [['officer','fi'],['director','fi'],['accountant','accountant'],['tax','tax'],['controller','controller'],['director','controller'],['auditor','auditor'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'fi-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Pilot Rural Bank',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const officer=await ctxFor('officer'),acc=await ctxFor('accountant'),tax=await ctxFor('tax'),dir=await ctxFor('director'),aud=await ctxFor('auditor');
 const hq=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 const br1=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'BR1',name:'Branch one',address:'Cebu'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing','treasury','compliance'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const cash=await mk('1010','Cash','asset'),loans=await mk('1300','Loans receivable','asset'),dueFrom=await mk('1900','Due from branches','asset'),deposits=await mk('2100','Deposit liabilities','liability'),dueTo=await mk('2900','Due to branches','liability'),interest=await mk('4100','Interest income','income'),fees=await mk('4200','Service fees','income');
 for(const [s,e] of [['2026-10-01','2026-10-31'],['2026-11-01','2026-11-30']])await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const store=new MemoryEvidenceStore();
 const uploaded=new Map();
 const upload=async(name,content,mime='text/csv',who=officer)=>{const bytes=Buffer.from(content);if(uploaded.has(sha(bytes)))return uploaded.get(sha(bytes));const reg=await run(who,tx=>evidence.registerUpload(tx,who,entityId,{filename:name,mime,byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(who,tx=>evidence.completeUpload(tx,who,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));uploaded.set(sha(bytes),reg.evidenceId);return reg.evidenceId;};
 const approve=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 const circular=await upload('rr-grt.pdf','%PDF-1.4 GRT regulation and advisor memo\n','application/pdf',tax);
 const rule=async(code,taxType,rate)=>{const r=await run(tax,tx=>sales.createTaxRule(tx,tax,entityId,{code,taxType,validFrom:'2026-01-01',rate,basis:'instrument',recognition:'profile_event',rounding:'line_half_up',applicabilityProfileId:randomUUID(),sourceEvidenceIds:[circular],goldenCaseIds:['GRT-BOUNDARY-5Y','GRT-MATURITY-'+code]}));await run(ctrl,tx=>sales.approveTaxRule(tx,ctrl,entityId,r.id,{decision:'approve',contentVersion:1}));await run(ctrl,tx=>sales.activateTaxRule(tx,ctrl,entityId,r.id,{reason:'Advisor signed'}));return r;};
 await rule('GRT5','grt','0.05');await rule('GRT1','grt','0.01');await rule('DST-LOAN','dst','0.0075');
 // Capability gate before activation.
 await rejects(run(officer,tx=>fi.createSourceSystem(tx,officer,entityId,{code:'CBS',name:'Core banking',ownerName:'IT operations'})),'FEATURE_NOT_ENABLED','source systems before the capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'fi_coexistence','active','p08.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 await approve('fi_profile',{dueFromAccountId:dueFrom.id,dueToAccountId:dueTo.id,instrumentRules:[{incomeCategory:'interest_income',instrumentType:'loan',maxMaturityYears:5,ruleCode:'GRT5'},{incomeCategory:'interest_income',instrumentType:'loan',minMaturityYears:5,ruleCode:'GRT1'},{incomeCategory:'loan_principal',instrumentType:'loan',ruleCode:'DST-LOAN'}],profileVersion:'fi-2026'});
 const cbs=await run(officer,tx=>fi.createSourceSystem(tx,officer,entityId,{code:'CBS',name:'Core banking',ownerName:'IT operations',granularity:'detail'}));
 await run(officer,tx=>fi.createSourceSystem(tx,officer,entityId,{code:'MANUAL',name:'Manual spreadsheets',ownerName:'Accounting',granularity:'summary'}));
 await rejects(run(aud,tx=>fi.createSourceSystem(tx,aud,entityId,{code:'X',name:'x',ownerName:'x'})),'FORBIDDEN','examiner scope is read-only');
 pass('fixture: pilot bank with two branches, capabilities through fi_coexistence, institution profile with interbranch accounts and instrument rules, GRT/DST rules with advisor golden cases, source system CBS');

 // Source ownership: reviewed operations, independent approval, no overlapping windows.
 const memo=await upload('ownership-memo.pdf','%PDF-1.4 signed feed matrix\n','application/pdf');
 const own=await run(officer,tx=>fi.createSourceOwnership(tx,officer,entityId,{sourceSystem:'CBS',bookId:book.id,transactionFamily:'journal',effectiveFrom:'2026-01-01',evidenceIds:[memo]}));
 assert.equal(own.state,'draft');
 await rejects(run(officer,tx=>fi.approveSourceOwnership(tx,officer,entityId,own.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','officer approving ownership');
 const ownCtrl=await run(dir,tx=>fi.createSourceOwnership(tx,dir,entityId,{sourceSystem:'CBS',bookId:book.id,transactionFamily:'balances',effectiveFrom:'2026-01-01',evidenceIds:[memo]}));
 await rejects(run(dir,tx=>fi.approveSourceOwnership(tx,dir,entityId,ownCtrl.id,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','author approving ownership');
 await run(ctrl,tx=>fi.approveSourceOwnership(tx,ctrl,entityId,own.id,{decision:'approve',contentVersion:1}));
 await run(ctrl,tx=>fi.approveSourceOwnership(tx,ctrl,entityId,ownCtrl.id,{decision:'approve',contentVersion:1}));
 const overlap=await run(officer,tx=>fi.createSourceOwnership(tx,officer,entityId,{sourceSystem:'MANUAL',bookId:book.id,transactionFamily:'journal',effectiveFrom:'2026-06-01',effectiveTo:'2026-12-31',evidenceIds:[memo]}));
 await rejects(run(ctrl,tx=>fi.approveSourceOwnership(tx,ctrl,entityId,overlap.id,{decision:'approve',contentVersion:1})),'STATE_CONFLICT','overlapping ownership window');
 const ownNow=await run(aud,tx=>fi.getSourceOwnership(tx,aud,entityId,own.id));
 await rejects(run(officer,tx=>fi.updateSourceOwnership(tx,officer,entityId,own.id,ownNow.version,{sourceSystem:'CBS',bookId:book.id,transactionFamily:'journal',effectiveFrom:'2026-02-01',evidenceIds:[memo]})),'STATE_CONFLICT','editing approved ownership');
 assert.equal((await run(aud,tx=>fi.listSourceOwnership(tx,aud,entityId,{}))).items.length,3);
 pass('source ownership is created from evidence, approved by another principal, immutable afterwards, and never overlaps an approved window for the same book and family');

 // Mapping versions from reviewed CSV; diff between versions.
 const mapCsv=v=>['source_account,target_account_code,dimensions,tax_profile','100100,1010,,','130100,1300,,loan_principal','210100,2100,,','410100,4100,,interest_income','190100,1900,,','290100,2900,,'].concat(v>1?['420100,4200,,fee_income']:[]).join('\n')+'\n';
 const mapEv1=await upload('cbs-map-v1.csv',mapCsv(1)),mapEv2=await upload('cbs-map-v2.csv',mapCsv(2)),mapEvBad=await upload('cbs-map-bad.csv','source_account,target_account_code\n999,9999\n');
 const map1=await run(officer,tx=>fi.importMappingVersion(tx,officer,entityId,{sourceSystemId:cbs.id,bookId:book.id,versionLabel:'cbs-2026-v1',evidenceId:mapEv1},{store}));
 await rejects(run(officer,tx=>fi.approveMappingVersion(tx,officer,entityId,map1.id)),'FORBIDDEN','officer approving the mapping');
 await run(ctrl,tx=>fi.approveMappingVersion(tx,ctrl,entityId,map1.id));
 const map2=await run(officer,tx=>fi.importMappingVersion(tx,officer,entityId,{sourceSystemId:cbs.id,bookId:book.id,versionLabel:'cbs-2026-v2',evidenceId:mapEv2},{store}));
 const diff=await run(aud,tx=>fi.mappingLines(tx,aud,entityId,map2.id,{againstId:map1.id}));
 assert.deepEqual([diff.lines.length,diff.diff.added.map(l=>l.sourceAccount),diff.diff.removed.length,diff.diff.changed.length],[7,['420100'],0,0]);
 await rejects(run(officer,tx=>fi.importMappingVersion(tx,officer,entityId,{sourceSystemId:cbs.id,bookId:book.id,versionLabel:'bad',evidenceId:mapEvBad},{store})),'VALIDATION_FAILED','mapping to an unknown account');
 pass('mapping versions are imported from reviewed CSV evidence, approved by another principal, and the diff between versions lists added, removed and changed source accounts');

 // Canonical journal feed.
 const feed=(id,rows,{replaces=null,count=null,hash=null,debit=null,credit=null}={})=>{
  const header='external_line_id,accounting_date,book_code,branch_code,account_code,currency,debit,credit,source_document_ref,dimensions,tax_event_ref,instrument_ref,instrument_type,maturity_date,income_category';
  const data=rows.map((r,i)=>[id+'-'+(i+1),r.date,'PHP-MAIN',r.branch,r.account,'PHP',r.debit||'0',r.credit||'0',r.ref||'DOC-'+i,r.dims||'',r.taxRef||'',r.instrument||'',r.type||'',r.maturity||'',r.category||''].join(','));
  const d=rows.reduce((t,r)=>t+Number(r.debit||0),0).toFixed(2),c=rows.reduce((t,r)=>t+Number(r.credit||0),0).toFixed(2);
  const manifest=['MANIFEST','','','','count='+(count??rows.length)+';sha256='+(hash??sha(data.join('\n'))),'',debit??d,credit??c,replaces?'replaces='+replaces:'','','','','','',''].join(',');
  return [header,...data,manifest].join('\n')+'\n';
 };
 const stage=async(id,csv,{kind='journal',mapping='cbs-2026-v1',cutoff='2026-10-31',who=officer,source='CBS'}={})=>{const ev=await upload(id+'.csv',csv);return run(who,tx=>ledger.createImport(tx,who,entityId,{kind,evidenceId:ev,mappingVersion:mapping,sourceId:source,externalBatchId:id,cutoffDate:cutoff},{sourceFeed:fi.sourceFeed}));};
 const validate=(id,who=officer)=>run(who,tx=>ledger.validateImport(tx,who,entityId,id,{},undefined,{store,sourceFeed:fi.sourceFeed}));
 const approveImport=async(id)=>{const imp=await run(ctrl,tx=>ledger.getImport(tx,ctrl,entityId,id));return run(ctrl,tx=>ledger.approveImport(tx,ctrl,entityId,id,{decision:'approve',contentVersion:imp.contentVersion},undefined,{sourceFeed:fi.sourceFeed}));};
 const commit=(id)=>run(ctrl,tx=>ledger.commitImport(tx,ctrl,entityId,id,{},undefined,{store,sourceFeed:fi.sourceFeed}));
 const b1csv=feed('B1',[
  {date:'2026-10-05',branch:'BR1',account:'130100',debit:'100000.00',ref:'LN-1',instrument:'LN-1',type:'loan',maturity:'2029-10-05',category:'loan_principal'},
  {date:'2026-10-05',branch:'BR1',account:'100100',credit:'100000.00',ref:'LN-1'},
  {date:'2026-10-05',branch:'BR1',account:'100100',debit:'5000.00',ref:'INT-1'},
  {date:'2026-10-05',branch:'BR1',account:'410100',credit:'5000.00',ref:'INT-1',instrument:'LN-1',type:'loan',maturity:'2029-10-05',category:'interest_income'}]);
 await rejects(stage('B0',b1csv,{source:'MANUAL'}),'STATE_CONFLICT','ingestion from a system without effective ownership');
 await rejects(stage('B0',b1csv,{mapping:'cbs-2026-v2'}),'VALIDATION_FAILED','ingestion under an unapproved mapping version');
 const b1=await stage('B1',b1csv);
 assert.equal(b1.state,'staged');
 const v1=await validate(b1.id);assert.equal(v1.state,'validated');
 await rejects(run(officer,tx=>ledger.approveImport(tx,officer,entityId,b1.id,{decision:'approve',contentVersion:1},undefined,{sourceFeed:fi.sourceFeed})),'FORBIDDEN','officer approving the batch');
 await approveImport(b1.id);
 const c1=await commit(b1.id);
 assert.equal(c1.journalEntryIds.length,1);
 const batches=await run(aud,tx=>fi.listSourceBatches(tx,aud,entityId,{}));
 const sb1=batches.items.find(b=>b.externalBatchId==='B1');
 assert.deepEqual([sb1.state,sb1.rowCount,sb1.debitTotal,sb1.postedEntryId],['posted',4,'105000.00',c1.journalEntryIds[0]]);
 // P08-T01: the same batch 100 times is one batch and one journal; a changed checksum conflicts.
 for(let i=0;i<100;i++){const again=await stage('B1',b1csv);assert.equal(again.id,b1.id,'same import returned');}
 const dup=await run(aud,tx=>fi.getSourceBatch(tx,aud,entityId,sb1.id));
 assert.equal(dup.duplicateCount,100);
 assert.equal((await run(ctrl,tx=>tx.query("select count(*)::int n from lara.journal_entries where tenant_id=$1 and source_type='source_batch' and source_id=$2",[tenantId,sb1.id]))).rows[0].n,1);
 await rejects(stage('B1',feed('B1',[{date:'2026-10-05',branch:'BR1',account:'130100',debit:'1.00'},{date:'2026-10-05',branch:'BR1',account:'100100',credit:'1.00'}])),'DUPLICATE_SOURCE','same batch id with another checksum');
 assert.equal((await commit(b1.id)).journalEntryIds[0],c1.journalEntryIds[0],'recommit is idempotent');
 pass('P08-T01: a canonical batch stages under effective ownership and an approved mapping, posts one journal after independent approval, the same batch presented 100 times counts as duplicates of the one batch, and the same id with a different checksum conflicts');

 // P08-T03: manifest mismatches and unmapped accounts cannot be approved silently.
 const rowsB2=[{date:'2026-10-06',branch:'HQ',account:'100100',debit:'700.00'},{date:'2026-10-06',branch:'HQ',account:'410100',credit:'700.00'}];
 const b2=await stage('B2',feed('B2',rowsB2,{count:3}));
 const e2=await validate(b2.id);
 assert.deepEqual([e2.state,e2.errors>0,e2.fieldErrors.some(f=>f.path==='manifest'&&/count/.test(f.message))],['staged',true,true],JSON.stringify(e2.fieldErrors));
 await rejects(approveImport(b2.id),'STATE_CONFLICT','approving a staged batch');
 const b3=await stage('B3',feed('B3',rowsB2,{debit:'800.00'}));
 assert.ok((await validate(b3.id)).fieldErrors.some(f=>/manifest totals/.test(f.message)),'manifest total mismatch');
 const b4=await stage('B4',feed('B4',rowsB2,{hash:'0'.repeat(64)}));
 assert.ok((await validate(b4.id)).fieldErrors.some(f=>/sha256/.test(f.message)),'manifest hash mismatch');
 const b5=await stage('B5',feed('B5',[{date:'2026-10-06',branch:'HQ',account:'420100',debit:'10.00'},{date:'2026-10-06',branch:'HQ',account:'410100',credit:'10.00'}]));
 const e5=await validate(b5.id);
 assert.ok(e5.fieldErrors.some(f=>/unmapped source account 420100/.test(f.message)));
 const sb5=(await run(aud,tx=>fi.listSourceBatches(tx,aud,entityId,{}))).items.find(b=>b.externalBatchId==='B5');
 const rows5=await run(aud,tx=>fi.sourceBatchRows(tx,aud,entityId,sb5.id,{status:'error'}));
 assert.equal(rows5.items.length,1);
 const b6=await stage('B6',feed('B6',[{date:'2026-10-06',branch:'HQ',account:'100100',debit:'700.00'},{date:'2026-10-06',branch:'HQ',account:'410100',credit:'699.00'}]));
 const e6=await validate(b6.id);
 assert.ok(e6.fieldErrors.some(f=>/does not balance/.test(f.message)));
 const usd=await stage('B7',feed('B7',rowsB2).replace(/,PHP,/g,',USD,'));
 const e7=await validate(usd.id);
 assert.ok(e7.fieldErrors.some(f=>/P09/.test(f.message)));
 pass('P08-T03: a manifest whose count, totals or hash disagree with the staged detail, an unmapped account, an unbalanced atomic batch and a foreign-currency row each leave the batch staged with the error on the workbench; approval is refused');

 // P08-T04: interbranch pair cancels in the roll-up; an asymmetric batch stays visible.
 const ib=await stage('IB1',feed('IB1',[
  {date:'2026-10-10',branch:'HQ',account:'190100',debit:'10000.00',dims:'counter_branch=BR1'},{date:'2026-10-10',branch:'HQ',account:'100100',credit:'10000.00'},
  {date:'2026-10-10',branch:'BR1',account:'100100',debit:'10000.00'},{date:'2026-10-10',branch:'BR1',account:'290100',credit:'10000.00',dims:'counter_branch=HQ'}]));
 await validate(ib.id);await approveImport(ib.id);await commit(ib.id);
 let roll=await run(aud,tx=>fi.branchRollup(tx,aud,entityId,{bookId:book.id,periodStart:'2026-10-01',periodEnd:'2026-10-31'}));
 const hqRow=roll.branches.find(b=>b.branchCode==='HQ'),brRow=roll.branches.find(b=>b.branchCode==='BR1');
 assert.deepEqual([hqRow.dueFrom,brRow.dueTo,roll.pairs.length,roll.pairs[0].state,roll.rollup.eliminated,roll.rollup.difference],['10000.00','10000.00',1,'cancels','10000.00','0.00']);
 const ib2=await stage('IB2',feed('IB2',[{date:'2026-10-12',branch:'HQ',account:'190100',debit:'2500.00',dims:'counter_branch=BR1'},{date:'2026-10-12',branch:'HQ',account:'100100',credit:'2500.00'}]));
 await validate(ib2.id);await approveImport(ib2.id);await commit(ib2.id);
 roll=await run(aud,tx=>fi.branchRollup(tx,aud,entityId,{bookId:book.id,periodStart:'2026-10-01',periodEnd:'2026-10-31'}));
 assert.deepEqual([roll.pairs[0].state,roll.pairs[0].difference,roll.pairs[0].latestFromDate,roll.pairs[0].latestToDate,roll.rollup.eliminated,roll.rollup.difference],['open','2500.00','2026-10-12','2026-10-10','10000.00','2500.00']);
 const recorded=await run(ctrl,tx=>fi.branchRollup(tx,ctrl,entityId,{bookId:book.id,periodStart:'2026-10-01',periodEnd:'2026-10-31'},{record:true}));
 assert.ok(recorded.rollupId&&recorded.checksum===roll.checksum,'recorded manifest carries the same checksum');
 pass('P08-T04: the interbranch pair shows as due-from in HQ and due-to in BR1, cancels in the entity roll-up with the elimination recorded, and a one-sided later batch stays open with both dates visible; no cross-entity consolidation exists');

 // P08-T02: an overdue expected batch blocks only the affected period.
 const exp=await run(officer,tx=>fi.expectBatch(tx,officer,entityId,{sourceSystemId:cbs.id,bookId:book.id,kind:'source_balances',periodStart:'2026-10-01',periodEnd:'2026-10-31',deadlineAt:'2026-09-15T00:00:00Z'}));
 const listed=await run(aud,tx=>fi.listExpectedBatches(tx,aud,entityId,{}));
 assert.equal(listed.items.find(e=>e.id===exp.id).state,'missing');
 const periods=(await run(ctrl,tx=>ledger.listPeriods(tx,ctrl,entityId,{bookId:book.id}))).items;
 const oct=periods.find(p=>p.startsOn==='2026-10-01'),nov=periods.find(p=>p.startsOn==='2026-11-01');
 await run(ctrl,tx=>ledger.softClosePeriod(tx,ctrl,entityId,oct.id,{reason:'Month end'},undefined,{feeds:fi.feeds}));
 const e2b=await rejects(run(ctrl,tx=>ledger.lockPeriod(tx,ctrl,entityId,oct.id,{reason:'Lock'},undefined,{feeds:fi.feeds})),'STATE_CONFLICT','locking with a missing feed');
 assert.ok(/source_feed_cbs_20261001/.test(e2b.message),e2b.message);
 await run(ctrl,tx=>ledger.softClosePeriod(tx,ctrl,entityId,nov.id,{reason:'Unrelated period'},undefined,{feeds:fi.feeds}));
 await run(ctrl,tx=>ledger.lockPeriod(tx,ctrl,entityId,nov.id,{reason:'Lock November'},undefined,{feeds:fi.feeds}));
 // The late batch arrives: the expected batch is received and its task completes with the feed evidence.
 const balCsv=['external_line_id,cutoff_date,book_code,branch_code,account_code,currency,balance','BAL-1,2026-10-31,PHP-MAIN,BR1,130100,PHP,100000.00','BAL-2,2026-10-31,PHP-MAIN,BR1,210100,PHP,-40000.00'];
 const balHash=sha(balCsv.slice(1).join('\n'));
 const bal=await stage('BAL-OCT',balCsv.concat(['MANIFEST,,,,count=2;sha256='+balHash+',,60000.00']).join('\n')+'\n',{kind:'source_balances',mapping:'n/a'});
 await validate(bal.id);await approveImport(bal.id);const cb=await commit(bal.id);
 assert.equal(cb.journalEntryIds.length,0,'balance batches post nothing');
 const after=await run(aud,tx=>fi.listExpectedBatches(tx,aud,entityId,{}));
 assert.deepEqual([after.items.find(e=>e.id===exp.id).state,!!after.items.find(e=>e.id===exp.id).receivedBatchId],['received',true]);
 await run(ctrl,tx=>ledger.lockPeriod(tx,ctrl,entityId,oct.id,{reason:'Lock after feed'},undefined,{feeds:fi.feeds}));
 pass('P08-T02: an overdue expected batch is missing on the calendar, soft close raises the required close task and the lock of that period is refused while an unrelated period locks; the late batch marks the expectation received, completes the task with its evidence and the period locks');

 // Feed reconciliation: source balances versus the mapped ledger accounts.
 const rec=await run(aud,tx=>fi.feedReconciliation(tx,aud,entityId,{bookId:book.id,asOf:'2026-10-31'}));
 const cbsRec=rec.sourceSystems.find(s=>s.code==='CBS');
 const loansRec=cbsRec.accounts.find(a=>a.accountCode==='130100'),depRec=cbsRec.accounts.find(a=>a.accountCode==='210100');
 assert.deepEqual([loansRec.state,loansRec.ledgerBalance,depRec.state,depRec.ledgerBalance,depRec.difference],['ties','100000.00','differs','0.00','-40000.00']);
 pass('feed reconciliation compares the latest source balance per account and branch with the mapped ledger balance at the cutoff and names every difference');

 // P08-T05 and the worksheet: classified facts, unclassified facts listed, replacement supersedes facts.
 const rules=(await run(tax,tx=>tx.query("select code,golden_case_ids from lara.tax_rule_versions where tenant_id=$1 and entity_id=$2 and status='active' and tax_type in ('grt','dst')",[tenantId,entityId]))).rows;
 assert.equal(rules.length,3);for(const r of rules)assert.ok(r.golden_case_ids.length>=2,'golden cases on '+r.code);
 await run(ctrl,tx=>ledger.reopenPeriod(tx,ctrl,entityId,oct.id,{reason:'Late instrument feed'}));
 const lf=await stage('LF1',feed('LF1',[
  {date:'2026-10-15',branch:'HQ',account:'100100',debit:'2000.00',ref:'INT-2'},{date:'2026-10-15',branch:'HQ',account:'410100',credit:'2000.00',ref:'INT-2',instrument:'LN-9',type:'loan',maturity:'2036-10-15',category:'interest_income'},
  {date:'2026-10-15',branch:'HQ',account:'100100',debit:'300.00',ref:'FEE-1'},{date:'2026-10-15',branch:'HQ',account:'410100',credit:'300.00',ref:'FEE-1',instrument:'ACCT-7',type:'deposit',category:'penalty_income'}]));
 await validate(lf.id);await approveImport(lf.id);await commit(lf.id);
 let ws=await run(tax,tx=>fi.institutionTaxWorksheet(tx,tax,entityId,{periodStart:'2026-10-01',periodEnd:'2026-10-31'}));
 const byRule=Object.fromEntries(ws.rows.map(r=>[r.ruleCode+'/'+r.incomeCategory,r]));
 assert.deepEqual([byRule['GRT5/interest_income'].tax,byRule['GRT1/interest_income'].tax,byRule['DST-LOAN/loan_principal'].tax,ws.unclassified.length,ws.unclassified[0].instrumentRef,ws.totals.tax],['250.00','20.00','750.00',1,'ACCT-7','1020.00']);
 // A correction replaces B1: linked reversal, superseded facts, the worksheet drops them.
 const rep=await stage('B1R',feed('B1R',[
  {date:'2026-10-20',branch:'BR1',account:'130100',debit:'100000.00',ref:'LN-1',instrument:'LN-1',type:'loan',maturity:'2029-10-05',category:'loan_principal'},
  {date:'2026-10-20',branch:'BR1',account:'100100',credit:'100000.00',ref:'LN-1'},
  {date:'2026-10-20',branch:'BR1',account:'100100',debit:'4000.00',ref:'INT-1'},
  {date:'2026-10-20',branch:'BR1',account:'410100',credit:'4000.00',ref:'INT-1',instrument:'LN-1',type:'loan',maturity:'2029-10-05',category:'interest_income'}],{replaces:'B1'}));
 await validate(rep.id);await approveImport(rep.id);const cr=await commit(rep.id);
 const repBatch=(await run(aud,tx=>fi.listSourceBatches(tx,aud,entityId,{}))).items.find(b=>b.externalBatchId==='B1R');
 const oldBatch=await run(aud,tx=>fi.getSourceBatch(tx,aud,entityId,sb1.id));
 assert.deepEqual([oldBatch.state,oldBatch.replacedByBatchId,repBatch.replacesBatchId,!!repBatch.reversalEntryId],['replaced',repBatch.id,sb1.id,true]);
 const reversal=(await run(ctrl,tx=>tx.query('select reversal_of from lara.journal_entries where tenant_id=$1 and id=$2',[tenantId,repBatch.reversalEntryId]))).rows[0];
 assert.equal(reversal.reversal_of,c1.journalEntryIds[0],'linked reversal of the replaced entry');
 ws=await run(tax,tx=>fi.institutionTaxWorksheet(tx,tax,entityId,{periodStart:'2026-10-01',periodEnd:'2026-10-31'}));
 assert.equal(ws.rows.find(r=>r.ruleCode==='GRT5').tax,'200.00','worksheet uses the replacement facts only');
 await rejects(run(ctrl,tx=>tx.query("update lara.tax_instrument_facts set amount=amount+1 where tenant_id=$1 and batch_id=$2",[tenantId,repBatch.id])),'STATE_CONFLICT','editing an instrument fact');
 pass('P08-T05: every enabled GRT/DST rule is an active reviewed version with advisor golden cases; the worksheet classifies interest by maturity band and principal by DST, lists unclassified facts instead of zeroing them, and a linked replacement reverses the original entry and supersedes its facts');
 console.log('P08-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
