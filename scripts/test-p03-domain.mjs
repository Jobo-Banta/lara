// P03-02 ledger domain against real PostgreSQL through the runtime role:
// P03-T01 balanced/unbalanced/retry/immutability, P03-T02 opening import
// replay and changed-hash conflict, P03-T03 reports reconcile to lines across
// a reversal with unchanged snapshot checksums, P03-T04 control/frozen/
// inactive/non-leaf refusals, P03-T05 year close once. Test tenants removed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence} from '../packages/domain/src/index.mjs';
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
async function rejects(promise,code,label){try{await promise;}catch(e){assert.ok(e instanceof DomainError,label+': not a DomainError: '+e.message);assert.equal(e.code,code,label+': '+e.message);return e;}assert.fail(label+' should fail with '+code);}
const run=(ctx,fn)=>inTransaction(api,ctx,fn);
try{
 // Provision: accountant (prepare/submit/edit/post), controller (approve, periods, reports, imports approve), clerk (none)
 const principals={},roles={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-ledger-'+suffix,name:'Ledger domain',mode:'demo'});
  for(const n of ['accountant','controller','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['accountant','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  for(const [p,r] of [['accountant','accountant'],['controller','controller'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>inTransaction(api,{tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'ledger-'+n}));
 let acc=await ctxFor('accountant'),ctrl=await ctxFor('controller');
 const entityRow=await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Ledger Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}));
 acc=await ctxFor('accountant');ctrl=await ctxFor('controller');
 const entityId=entityRow.id;
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 // Capability gate: the ledger refuses work until general_ledger is active (workspace first).
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'workspace','active','p02.1',$3,now(),$4)",[tenantId,entityId,principals.controller,principals.accountant]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 await rejects(run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code:'1000',name:'Assets',category:'asset',controlType:'none',requiredDimensions:[]})),'FEATURE_NOT_ENABLED','ledger before activation');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'general_ledger','active','p03.1',$3,now(),$4)",[tenantId,entityId,principals.controller,principals.accountant]));
 pass('ledger work requires the general_ledger capability, which needs the workspace first');

 // Chart
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const assets=await mk('1000','Assets','asset');
 const cash=await mk('1010','Cash','asset',{parentId:assets.id});
 const ar=await mk('1200','Receivables','asset',{parentId:assets.id,controlType:'ar'});
 const retained=await mk('3100','Retained earnings','equity');
 const capital=await mk('3000','Share capital','equity');
 const revenue=await mk('4000','Service revenue','income');
 const expense=await mk('5000','Rent expense','expense',{requiredDimensions:['cost_center']});
 assert.deepEqual(expense.requiredDimensions,['cost_center']);
 await rejects(mk('4100','Bad parent','income',{parentId:assets.id}),'VALIDATION_FAILED','parent category mismatch');
 const frozen=await mk('1300','Old deposits','asset',{parentId:assets.id});
 await run(acc,tx=>ledger.freezeAccount(tx,acc,entityId,frozen.id,'frozen','Dormant'));
 const cc=(await run(ctrl,tx=>tx.query("insert into lara.dimensions(tenant_id,entity_id,type,code,name,created_by) values($1,$2,'cost_center','OPS','Operations',$3) returning id",[tenantId,entityId,principals.controller]))).rows[0].id;
 const list=await run(acc,tx=>ledger.listAccounts(tx,acc,entityId,{bookId:book.id}));
 assert.equal(list.items.length,8);
 pass('chart of accounts with hierarchy, control type, required dimensions and a frozen account');

 // Periods
 const sep=await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-09-01',endsOn:'2026-09-30'}));
 const oct=await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-10-01',endsOn:'2026-10-31'}));
 await rejects(run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-09-15','endsOn':'2026-10-15'})),'STATE_CONFLICT','overlap');
 for(let m=11;m<=12;m++)await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-'+m+'-01',endsOn:m===11?'2026-11-30':'2026-12-31'}));
 for(let m=1;m<=8;m++)await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2026-'+String(m).padStart(2,'0')+'-01',endsOn:'2026-'+String(m).padStart(2,'0')+'-'+new Date(Date.UTC(2026,m,0)).getUTCDate()}));
 pass('twelve non-overlapping monthly periods for fiscal year 2026');

 // Journal lifecycle (P03-T01, P03-T04)
 const lines=(d,c,dbt='1000.00')=>[{accountId:d,branchId:branch.id,debit:dbt,credit:'0',dimensions:{}},{accountId:c,branchId:branch.id,debit:'0',credit:dbt,dimensions:{}}];
 const jbody={bookId:book.id,accountingDate:'2026-09-18',documentDate:'2026-09-18',currency:'PHP',description:'Cash service revenue',lines:lines(cash.id,revenue.id),evidenceIds:[]};
 await rejects(run(acc,tx=>ledger.createJournal(tx,acc,entityId,{...jbody,lines:lines(cash.id,revenue.id).map((l,i)=>i?{...l,credit:'999.00'}:l)})),'UNBALANCED_ENTRY','unbalanced draft');
 await rejects(run(acc,tx=>ledger.createJournal(tx,acc,entityId,{...jbody,currency:'USD'})),'FEATURE_NOT_ENABLED','foreign currency');
 const j1=await run(acc,tx=>ledger.createJournal(tx,acc,entityId,jbody));
 assert.equal(j1.state,'draft');
 await rejects(run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,j1.id,{decision:'approve',contentVersion:1})),'STATE_CONFLICT','approval before submission');
 pass('drafts validate balance and currency; approval requires submission');
 const submitted=await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,j1.id,{}));
 assert.equal(submitted.state,'submitted');
 await rejects(run(acc,tx=>ledger.approveJournal(tx,acc,entityId,j1.id,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','preparer approving');
 await rejects(run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,j1.id,{decision:'approve',contentVersion:2})),'VERSION_CONFLICT','approval bound to content version');
 await rejects(run(ctrl,tx=>ledger.postJournal(tx,ctrl,entityId,j1.id,{})),'STATE_CONFLICT','post before approval');
 const approved=await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,j1.id,{decision:'approve',contentVersion:1}));
 assert.equal(approved.state,'approved');
 // Material edit after approval returns the journal to draft and invalidates the approval.
 const edited=await run(acc,tx=>ledger.updateJournal(tx,acc,entityId,j1.id,approved.version,{...jbody,description:'Cash service revenue (corrected)'}));
 assert.equal(edited.state,'draft');assert.equal(edited.contentVersion,2);
 await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,j1.id,{}));
 await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,j1.id,{decision:'approve',contentVersion:2}));
 const posted=await run(acc,tx=>ledger.postJournal(tx,acc,entityId,j1.id,{}));
 assert.equal(posted.state,'posted');assert.equal(posted.journalEntryIds.length,1);
 const replay=await run(acc,tx=>ledger.postJournal(tx,acc,entityId,j1.id,{}).catch(e=>e));
 assert.ok(replay instanceof DomainError&&replay.code==='STATE_CONFLICT','posting twice is a state conflict, not a second entry');
 assert.equal((await run(acc,tx=>tx.query('select count(*)::int n from lara.journal_entries where source_id=$1',[j1.id]))).rows[0].n,1);
 await rejects(run(acc,tx=>ledger.updateJournal(tx,acc,entityId,j1.id,posted.version,jbody)),'STATE_CONFLICT','edit posted journal');
 // Refusals through the posting path (P03-T04)
 const refuse=async(l,code,label)=>{const d=await run(acc,tx=>ledger.createJournal(tx,acc,entityId,{...jbody,description:label,lines:l}));await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,d.id,{}));await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,d.id,{decision:'approve',contentVersion:1}));await rejects(run(acc,tx=>ledger.postJournal(tx,acc,entityId,d.id,{})),code,label);};
 await refuse(lines(ar.id,revenue.id),'STATE_CONFLICT','manual posting to a control account');
 await refuse(lines(frozen.id,revenue.id),'STATE_CONFLICT','posting to a frozen account');
 await refuse(lines(assets.id,revenue.id),'STATE_CONFLICT','posting to a non-leaf account');
 await refuse(lines(expense.id,cash.id,'200.00'),'VALIDATION_FAILED','missing required dimension');
 const dimDraft=await run(acc,tx=>ledger.createJournal(tx,acc,entityId,{...jbody,description:'Rent',lines:[{accountId:expense.id,branchId:branch.id,debit:'200.00',credit:'0',dimensions:{cost_center:cc}},{accountId:cash.id,branchId:branch.id,debit:'0',credit:'200.00',dimensions:{}}]}));
 await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,dimDraft.id,{}));await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,dimDraft.id,{decision:'approve',contentVersion:1}));
 const rent=await run(acc,tx=>ledger.postJournal(tx,acc,entityId,dimDraft.id,{}));
 assert.equal(rent.state,'posted');
 pass('journals: independent approval bound to the content version, material edits invalidate approval, posting is single-effect, posted journals are immutable, and control/frozen/non-leaf/missing-dimension postings are refused (P03-T01, P03-T04)');

 // Reports before and after a reversal (P03-T03)
 const tb1=await run(ctrl,tx=>ledger.trialBalance(tx,ctrl,entityId,{bookId:book.id,periodStart:'2026-09-01',periodEnd:'2026-09-30',asOf:new Date().toISOString()}));
 assert.equal(tb1.totals.balanced,true);assert.equal(tb1.totals.debit,'1200.00');
 assert.equal(tb1.lines.find(l=>l.code==='1010').balance,'800.00');
 const snap1=await run(ctrl,tx=>ledger.snapshotReport(tx,ctrl,entityId,{reportType:'trial_balance',bookId:book.id,periodStart:'2026-09-01',periodEnd:'2026-09-30',asOf:new Date().toISOString(),format:'json'}));
 assert.equal(snap1.versionNumber,1);
 const reversalDraft=await run(acc,tx=>ledger.reverseJournal(tx,acc,entityId,j1.id,{accountingDate:'2026-09-25',reason:'Duplicate billing'}));
 await rejects(run(acc,tx=>ledger.reverseJournal(tx,acc,entityId,j1.id,{accountingDate:'2026-09-26',reason:'again'})),'STATE_CONFLICT','second open reversal of the same entry');
 await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,reversalDraft.resourceId,{}));await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,reversalDraft.resourceId,{decision:'approve',contentVersion:1}));
 const reversed=await run(acc,tx=>ledger.postJournal(tx,acc,entityId,reversalDraft.resourceId,{}));
 assert.equal(reversed.state,'posted');
 const link=(await run(acc,tx=>tx.query('select reversal_of,purpose from lara.journal_entries where id=$1',[reversed.journalEntryIds[0]]))).rows[0];
 assert.equal(link.reversal_of,posted.journalEntryIds[0]);assert.equal(link.purpose,'reversal');
 const tb2=await run(ctrl,tx=>ledger.trialBalance(tx,ctrl,entityId,{bookId:book.id,periodStart:'2026-09-01',periodEnd:'2026-09-30',asOf:new Date().toISOString()}));
 assert.equal(tb2.lines.find(l=>l.code==='1010').balance,'-200.00');assert.equal(tb2.lines.find(l=>l.code==='4000').balance,'0.00');assert.equal(tb2.totals.balanced,true);
 const lineSum=(await run(acc,tx=>tx.query('select sum(func_debit) d,sum(func_credit) c from lara.journal_lines where book_id=$1',[book.id]))).rows[0];
 assert.equal(tb2.totals.debit,ledger.decimal(ledger.signedMicros(lineSum.d)));
 const stored=(await run(ctrl,tx=>tx.query('select checksum,payload from lara.report_snapshots where id=$1',[snap1.id]))).rows[0];
 assert.equal(stored.checksum,snap1.checksum);assert.equal(stored.payload.lines.find(l=>l.code==='1010').balance,'800.00','original snapshot unchanged after reversal');
 const snap2=await run(ctrl,tx=>ledger.snapshotReport(tx,ctrl,entityId,{reportType:'trial_balance',bookId:book.id,periodStart:'2026-09-01',periodEnd:'2026-09-30',asOf:new Date().toISOString(),format:'json'}));
 assert.equal(snap2.versionNumber,2);assert.notEqual(snap2.checksum,snap1.checksum);
 const st=await run(ctrl,tx=>ledger.statements(tx,ctrl,entityId,{bookId:book.id,periodStart:'2026-09-01',periodEnd:'2026-09-30',asOf:new Date().toISOString()}));
 assert.equal(st.incomeStatement.netIncome,'-200.00');assert.equal(st.balanceSheet.balanced,true);
 pass('trial balance and statements reconcile to posted lines before and after a linked reversal; the original snapshot checksum is unchanged and a new version is issued (P03-T03)');

 // Opening import (P03-T02)
 const store=new MemoryEvidenceStore();
 const csv=Buffer.from('source_key,account_code,branch_code,accounting_date,debit,credit\nOB-1,1010,HQ,2025-12-31,5000.00,0\nOB-2,3000,HQ,2025-12-31,0,5000.00\n');
 const reg=await run(acc,tx=>evidence.registerUpload(tx,acc,entityId,{filename:'openings.csv',mime:'text/csv',byteCount:csv.length,sha256:sha(csv),classification:'confidential'}));
 await run(acc,tx=>evidence.completeUpload(tx,acc,entityId,reg.evidenceId,csv,store));
 await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));
 await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:'2025-12-01',endsOn:'2025-12-31'}));
 const imp=await run(acc,tx=>ledger.createImport(tx,acc,entityId,{kind:'openings',evidenceId:reg.evidenceId,mappingVersion:'v1',sourceId:'legacy-gl',externalBatchId:'B-2025',cutoffDate:'2025-12-31'}));
 assert.equal(imp.state,'staged');
 await rejects(run(acc,tx=>ledger.createImport(tx,acc,entityId,{kind:'openings',evidenceId:reg.evidenceId,mappingVersion:'v1',sourceId:'legacy-gl',externalBatchId:'B-2025',cutoffDate:'2025-12-31'})),'STATE_CONFLICT','same external batch again');
 const validated=await run(acc,tx=>ledger.validateImport(tx,acc,entityId,imp.id,{},undefined,{store}));
 if(validated.state!=='validated')console.error('IMPORT ROWS',JSON.stringify(await run(acc,tx=>ledger.importRows(tx,acc,entityId,imp.id))));
 assert.equal(validated.state,'validated');assert.equal(validated.errors,0);
 await rejects(run(acc,tx=>ledger.approveImport(tx,acc,entityId,imp.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','the accountant template holds no import approval; the database also refuses author approval (schema test)');
 await rejects(run(ctrl,tx=>ledger.commitImport(tx,ctrl,entityId,imp.id,{})),'STATE_CONFLICT','commit before approval');
 await run(ctrl,tx=>ledger.approveImport(tx,ctrl,entityId,imp.id,{decision:'approve',contentVersion:1}));
 const committed=await run(ctrl,tx=>ledger.commitImport(tx,ctrl,entityId,imp.id,{}));
 assert.equal(committed.state,'committed');
 const committedAgain=await run(ctrl,tx=>ledger.commitImport(tx,ctrl,entityId,imp.id,{}));
 assert.deepEqual(committedAgain.journalEntryIds,committed.journalEntryIds,'second commit returns the prior result');
 const csv2=Buffer.from('source_key,account_code,branch_code,accounting_date,debit,credit\nOB-1,1010,HQ,2025-12-31,6000.00,0\nOB-2,3000,HQ,2025-12-31,0,6000.00\n');
 const reg2=await run(acc,tx=>evidence.registerUpload(tx,acc,entityId,{filename:'openings-v2.csv',mime:'text/csv',byteCount:csv2.length,sha256:sha(csv2),classification:'confidential'}));
 await run(acc,tx=>evidence.completeUpload(tx,acc,entityId,reg2.evidenceId,csv2,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg2.evidenceId,new FixtureScanner(),store));
 await rejects(run(acc,tx=>ledger.createImport(tx,acc,entityId,{kind:'openings',evidenceId:reg2.evidenceId,mappingVersion:'v1',sourceId:'legacy-gl',externalBatchId:'B-2025',cutoffDate:'2025-12-31'})),'STATE_CONFLICT','same external batch with a changed source hash conflicts');
 const imp2=await run(acc,tx=>ledger.createImport(tx,acc,entityId,{kind:'openings',evidenceId:reg2.evidenceId,mappingVersion:'v1',sourceId:'legacy-gl',externalBatchId:'B-2025-R',cutoffDate:'2025-12-31'}));
 await run(acc,tx=>ledger.validateImport(tx,acc,entityId,imp2.id,{},undefined,{store}));await run(ctrl,tx=>ledger.approveImport(tx,ctrl,entityId,imp2.id,{decision:'approve',contentVersion:1}));
 await rejects(run(ctrl,tx=>ledger.commitImport(tx,ctrl,entityId,imp2.id,{})),'STATE_CONFLICT','overlapping opening load for the same cutoff');
 const opening=await run(ctrl,tx=>ledger.trialBalance(tx,ctrl,entityId,{bookId:book.id,periodStart:'2025-12-01',periodEnd:'2025-12-31',asOf:new Date().toISOString()}));
 assert.equal(opening.lines.find(l=>l.code==='1010').balance,'5000.00');
 pass('opening imports: duplicate external batch, replayed commit returns the prior entry, changed source hash conflicts, overlapping cutoff refused, openings post through the function (P03-T02)');

 // Close: soft close, lock with close-task gate, year-end close once (P03-T05)
 const softSep=await run(ctrl,tx=>ledger.softClosePeriod(tx,ctrl,entityId,sep.id,{reason:'Month end'}));
 assert.equal(softSep.state,'soft_closed');
 const task=await run(ctrl,tx=>ledger.addCloseTask(tx,ctrl,entityId,sep.id,{requirement:'bank_reconciliation',required:true}));
 await rejects(run(ctrl,tx=>ledger.lockPeriod(tx,ctrl,entityId,sep.id,{reason:'Lock'})),'STATE_CONFLICT','lock with an open required task');
 await run(ctrl,tx=>ledger.completeCloseTask(tx,ctrl,entityId,task.id,{evidenceId:reg.evidenceId}));
 const locked=await run(ctrl,tx=>ledger.lockPeriod(tx,ctrl,entityId,sep.id,{reason:'Lock'}));
 assert.equal(locked.state,'locked');
 const late=await run(acc,tx=>ledger.createJournal(tx,acc,entityId,{...jbody,description:'Late'}));await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,late.id,{}));await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,late.id,{decision:'approve',contentVersion:1}));
 await rejects(run(acc,tx=>ledger.postJournal(tx,acc,entityId,late.id,{})),'PERIOD_LOCKED','posting into a locked period');
 const reopened=await run(ctrl,tx=>ledger.reopenPeriod(tx,ctrl,entityId,sep.id,{reason:'Audit adjustment'}));
 assert.equal(reopened.state,'open');
 assert.equal((await run(ctrl,tx=>tx.query('select close_version from lara.periods where id=$1',[sep.id]))).rows[0].close_version,1);
 // Year-end: lock every 2026 period, then close to retained earnings once.
 const periods=(await run(ctrl,tx=>tx.query("select id,status from lara.periods where tenant_id=$1 and book_id=$2 and starts_on>='2026-01-01' order by starts_on",[tenantId,book.id]))).rows;
 for(const p of periods){if(p.status==='open')await run(ctrl,tx=>ledger.softClosePeriod(tx,ctrl,entityId,p.id,{reason:'Year end'}));await run(ctrl,tx=>ledger.lockPeriod(tx,ctrl,entityId,p.id,{reason:'Year end'}));}
 const close1=await run(ctrl,tx=>ledger.closeFiscalYear(tx,ctrl,entityId,{bookId:book.id,fiscalYear:2026,retainedEarningsAccountId:retained.id,branchId:branch.id,reason:'FY2026 close'}));
 assert.equal(close1.netIncome,'-200.00');
 const close2=await run(ctrl,tx=>ledger.closeFiscalYear(tx,ctrl,entityId,{bookId:book.id,fiscalYear:2026,retainedEarningsAccountId:retained.id,branchId:branch.id,reason:'FY2026 close again'}));
 assert.deepEqual(close2.journalEntryIds,close1.journalEntryIds,'closing twice yields one retained-earnings effect');
 assert.equal((await run(ctrl,tx=>tx.query("select count(*)::int n from lara.journal_entries where book_id=$1 and purpose='closing'",[book.id]))).rows[0].n,1);
 const dec=(await run(ctrl,tx=>tx.query("select status from lara.periods where tenant_id=$1 and book_id=$2 and starts_on='2026-12-01'",[tenantId,book.id]))).rows[0];
 assert.equal(dec.status,'locked','year-end period is locked again after the close');
 const fy=await run(ctrl,tx=>ledger.trialBalance(tx,ctrl,entityId,{bookId:book.id,periodStart:'2026-01-01',periodEnd:'2026-12-31',asOf:new Date().toISOString()}));
 assert.equal(fy.lines.find(l=>l.code==='4000').balance,'0.00');assert.equal(fy.lines.find(l=>l.code==='5000').balance,'0.00');assert.equal(fy.lines.find(l=>l.code==='3100').balance,'-200.00');
 const bs=await run(ctrl,tx=>ledger.statements(tx,ctrl,entityId,{bookId:book.id,periodStart:'2026-01-01',periodEnd:'2026-12-31',asOf:new Date().toISOString()}));
 assert.equal(bs.balanceSheet.balanced,true);assert.equal(bs.balanceSheet.equity,'4800.00');
 pass('periods soft close, lock only with required close tasks complete, refuse late postings, reopen with a new close version; the fiscal year closes to retained earnings exactly once and the new-year balance sheet balances (P03-T05)');
 console.log('PASS P03-02 ledger domain: '+step+' groups');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
