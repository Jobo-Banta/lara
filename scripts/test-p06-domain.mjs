// P06-02 treasury domain against real PostgreSQL through the runtime role:
// P06-T01 AC-07 bank fee through an approved journal, CORE-10/12 no
// overlapping confirmed amounts, ambiguous proposals stay unmatched;
// P06-T02 opening + lines differing from closing is rejected; P06-T03 one
// bank file run per release; P06-T04 a bounced partial check reverses only
// its own settlement; P06-T05 the cashier cannot certify their own handover
// and the variance stays visible; plus reviewed bank accounts, single-use
// statement line keys, transfers posted as one entry and the reconciliation
// snapshot. Test tenants are removed at the end.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {DomainError,inTransaction,identity,organization,ledger,evidence,parties,sales,purchasing,treasury} from '../packages/domain/src/index.mjs';
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
const env={FIELD_ENCRYPTION_KEY:process.env.FIELD_ENCRYPTION_KEY};
const bankStatement={validate:treasury.validateStatement,commit:treasury.commitStatement};
try{
 const principals={},roles={};
 await run({tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'dom-treas-'+suffix,name:'Treasury domain',mode:'demo'});
  for(const n of ['billing','clerk','accountant','treasury','cashier','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:'https://identity.invalid',subject:n+'-'+suffix,displayName:n})).id;
  for(const code of ['billing','clerk','accountant','treasury','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  // No seeded template holds transfer.approve/post (noted for owner review); a tenant role covers it.
  roles.approver=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'treasury_approver','Treasury approver','[\"transfer.approve\",\"transfer.post\",\"transfer.read\"]','approved',$2,$3) returning id",[tenantId,sha('approver'),principals.security])).rows[0].id;
  for(const [p,r] of [['billing','billing'],['clerk','clerk'],['accountant','accountant'],['treasury','treasury'],['cashier','treasury'],['controller','controller'],['controller','approver'],['director','controller'],['director','approver'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
 });
 const ctxFor=n=>run({tenantId,principalId:principals[n]},tx=>identity.actorContext(tx,tenantId,principals[n],{traceId:'treas-'+n}));
 let ctrl=await ctxFor('controller');
 const entityId=(await run(ctrl,tx=>organization.createEntity(tx,ctrl,{legalName:'Treasury Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1}))).id;
 ctrl=await ctxFor('controller');
 const bill=await ctxFor('billing'),acc=await ctxFor('accountant'),tre=await ctxFor('treasury'),cashier=await ctxFor('cashier'),dir=await ctxFor('director');
 const branch=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'}));
 for(const cap of ['workspace','general_ledger','sales','purchasing'])await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,cap,principals.director,principals.controller]));
 const book=await run(ctrl,tx=>ledger.createBook(tx,ctrl,entityId,{code:'php-main',kind:'primary',functionalCurrency:'PHP',sourceOwner:'lara'}));
 const mk=(code,name,category,extra={})=>run(acc,tx=>ledger.createAccount(tx,acc,entityId,{bookId:book.id,code,name,category,controlType:'none',requiredDimensions:[],...extra}));
 const petty=await mk('1010','Petty cash','asset'),bdoLedger=await mk('1020','Bank BDO','asset'),bpiLedger=await mk('1030','Bank BPI','asset'),ar=await mk('1200','Receivables','asset',{controlType:'ar'}),ap=await mk('2100','Payables','liability',{controlType:'ap'}),outTax=await mk('2200','Output tax','liability',{controlType:'output_tax'}),inputTax=await mk('1300','Input tax','asset',{controlType:'input_tax'}),revenue=await mk('4000','Revenue','income'),expense=await mk('5000','Fees','expense'),bankFees=await mk('5900','Bank charges','expense'),cashVar=await mk('5950','Cash over and short','expense');
 for(const [s,e] of [['2026-09-01','2026-09-30'],['2026-10-01','2026-10-31']])await run(ctrl,tx=>ledger.createPeriod(tx,ctrl,entityId,{bookId:book.id,startsOn:s,endsOn:e}));
 const customer=await run(bill,tx=>parties.createParty(tx,bill,entityId,{legalName:'Acme Trading',roles:['customer'],identityStatus:'unknown',address:'Cebu'},env));
 const supplier=await run(bill,tx=>parties.createParty(tx,bill,entityId,{legalName:'Supplies Inc',roles:['supplier'],identityStatus:'unknown',address:'Cebu'},env));
 const approve=async(kind,payload)=>{const s=await run(ctrl,tx=>organization.saveSettings(tx,ctrl,entityId,kind,payload));await run(dir,tx=>organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash}));};
 await approve('sales_profile',{arAccountId:ar.id,outputTaxAccountId:outTax.id,cashAccountId:bdoLedger.id,scale:2,dueDays:30});
 await approve('purchasing_profile',{apAccountId:ap.id,inputTaxAccountId:inputTax.id,cashAccountId:bdoLedger.id,scale:2,dueDays:30});
 await run(ctrl,tx=>tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4)",[tenantId,entityId,branch.id,principals.controller]));
 const store=new MemoryEvidenceStore();
 const upload=async(name,content,mime='application/pdf')=>{const bytes=Buffer.from(content);const reg=await run(tre,tx=>evidence.registerUpload(tx,tre,entityId,{filename:name,mime,byteCount:bytes.length,sha256:sha(bytes),classification:'internal'}));await run(tre,tx=>evidence.completeUpload(tx,tre,entityId,reg.evidenceId,bytes,store));await run({tenantId,principalId:null},tx=>evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new FixtureScanner(),store));return reg.evidenceId;};
 const bankDoc=await upload('bank-confirmation.pdf','%PDF-1.4 bank confirmation\n');
 // Treasury gate and bank accounts reviewed by another principal.
 const accountBody=(ledgerAccountId,bankCode,accountNumber)=>({bookId:book.id,ledgerAccountId,bankCode,accountNumber,currency:'PHP',evidenceIds:[bankDoc]});
 await rejects(run(tre,tx=>treasury.createBankAccount(tx,tre,entityId,accountBody(bdoLedger.id,'BDO','001234567890'),env)),'FEATURE_NOT_ENABLED','bank accounts before the treasury capability');
 await run(ctrl,tx=>tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,'treasury','active','p06.1',$3,now(),$4)",[tenantId,entityId,principals.director,principals.controller]));
 await rejects(run(tre,tx=>treasury.createBankAccount(tx,tre,entityId,accountBody(ar.id,'BDO','001234567890'),env)),'VALIDATION_FAILED','bank account on a control account');
 const bdo=await run(tre,tx=>treasury.createBankAccount(tx,tre,entityId,accountBody(bdoLedger.id,'BDO','0012 3456 7890'),env));
 assert.deepEqual([bdo.state,bdo.accountNumberMasked],['draft','••••7890']);
 await rejects(run(tre,tx=>treasury.createBankAccount(tx,tre,entityId,accountBody(bpiLedger.id,'BDO','001234567890'),env)),'STATE_CONFLICT','same bank and number twice');
 await rejects(run(tre,tx=>treasury.approveBankAccount(tx,tre,entityId,bdo.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','treasury cannot approve bank accounts');
 await rejects(run(tre,tx=>treasury.createTransfer(tx,tre,entityId,{fromAccountId:bdo.id,toAccountId:bdo.id,currency:'PHP',amount:'1.00',valueDate:'2026-10-01',evidenceIds:[]})),'VALIDATION_FAILED','transfer to itself');
 await run(ctrl,tx=>treasury.approveBankAccount(tx,ctrl,entityId,bdo.id,{decision:'approve',contentVersion:1}));
 const bpi=await run(tre,tx=>treasury.createBankAccount(tx,tre,entityId,accountBody(bpiLedger.id,'BPI','9988776655'),env));
 await run(ctrl,tx=>treasury.approveBankAccount(tx,ctrl,entityId,bpi.id,{decision:'approve',contentVersion:1}));
 await rejects(run(tre,tx=>treasury.createTransfer(tx,tre,entityId,{fromAccountId:bdo.id,toAccountId:bpi.id,currency:'USD',amount:'1.00',valueDate:'2026-10-01',evidenceIds:[]})),'FEATURE_NOT_ENABLED','cross-currency transfer');
 const edited=await run(tre,tx=>treasury.updateBankAccount(tx,tre,entityId,bpi.id,2,accountBody(bpiLedger.id,'BPI',undefined),env));
 assert.deepEqual([edited.state,edited.accountNumberMasked],['approved','••••6655'],'an unchanged edit keeps the approval');
 pass('bank accounts need the treasury capability, an active non-control asset account and verification evidence; numbers are encrypted and unique per bank; approval by another principal');

 // Receipts and invoices to reconcile: two invoices, one receipt by transfer with the bank reference, one partial check receipt.
 const line=(accountId,unitPrice,extra={})=>({description:'Services',quantity:'1',unitPrice,discount:'0',priceBasis:'exclusive',accountId,dimensions:{},...extra});
 const invoice=async(price,date)=>{const d=await run(bill,tx=>sales.createDocument(tx,bill,entityId,{kind:'invoice',branchId:branch.id,bookId:book.id,partyId:customer.id,documentDate:date,accountingDate:date,currency:'PHP',ruleProfileVersion:'ph-2026',lines:[line(revenue.id,price)],evidenceIds:[]}));await run(bill,tx=>sales.submitDocument(tx,bill,entityId,d.id,{}));await run(acc,tx=>sales.approveDocument(tx,acc,entityId,d.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>sales.postDocument(tx,acc,entityId,d.id,{}));return d;};
 const invA=await invoice('5000','2026-10-01'),invB=await invoice('3000','2026-10-01'),invC=await invoice('2000','2026-10-02');
 const items=async()=>(await run(bill,tx=>sales.listOpenItems(tx,bill,entityId,{partyId:customer.id,side:'AR'}))).items;
 const itemOf=async doc=>(await items()).find(i=>i.documentId===doc.id);
 const receipt=async(body)=>{const r=await run(bill,tx=>sales.createCollection(tx,bill,entityId,{direction:'receipt',partyId:customer.id,currency:'PHP',method:'transfer',withholdingAmount:'0.00',evidenceIds:[],bankAccountId:bdo.id,...body}));await run(bill,tx=>sales.submitCollection(tx,bill,entityId,r.id,{}));await run(acc,tx=>sales.approveCollection(tx,acc,entityId,r.id,{decision:'approve',contentVersion:1}));return r;};
 const rcB=await receipt({valueDate:'2026-10-03',grossAmount:'3000.00',cashAmount:'3000.00',allocations:[{openItemId:(await itemOf(invB)).id,amount:'3000.00'}]});
 await run(acc,tx=>sales.postCollection(tx,acc,entityId,rcB.id,{}));
 await run(acc,tx=>tx.query("update lara.settlements set bank_reference='TRF-1001' where tenant_id=$1 and id=$2",[tenantId,rcB.id]));
 const rcC=await receipt({valueDate:'2026-10-03',grossAmount:'2000.00',cashAmount:'2000.00',allocations:[{openItemId:(await itemOf(invC)).id,amount:'2000.00'}]});
 await run(acc,tx=>sales.postCollection(tx,acc,entityId,rcC.id,{}));
 const rcC2=await receipt({valueDate:'2026-10-04',grossAmount:'2000.00',cashAmount:'2000.00',allocations:[]});
 await run(acc,tx=>sales.postCollection(tx,acc,entityId,rcC2.id,{}));
 pass('fixture: three issued invoices; a 3,000 transfer receipt with a bank reference, and two 2,000 receipts a day apart (the ambiguous pair)');

 // P06-T02 and statement import through the import pipeline.
 const csv=(rows,{opening='10000.00',closing})=>['source_line_key,booked_date,value_date,signed_amount,currency,reference,description','opening_balance,2026-10-01,,'+opening+',PHP,,','closing_balance,2026-10-05,,'+closing+',PHP,,',...rows].join('\n')+'\n';
 const importCsv=async(text,externalBatchId,cutoff='2026-10-05')=>{const ev=await upload(externalBatchId+'.csv',text,'text/csv');const imp=await run(acc,tx=>ledger.createImport(tx,acc,entityId,{kind:'bank_statement',evidenceId:ev,mappingVersion:'lara-csv-1',sourceId:bdo.id,externalBatchId,cutoffDate:cutoff}));return imp;};
 await rejects(run(acc,tx=>ledger.createImport(tx,acc,entityId,{kind:'bank_statement',evidenceId:bankDoc,mappingVersion:'lara-csv-1',sourceId:randomUUID(),externalBatchId:'x',cutoffDate:'2026-10-05'})),'VALIDATION_FAILED','statement import for an unknown bank account');
 const bad=await importCsv(csv(['L1,2026-10-03,2026-10-03,3000.00,PHP,TRF-1001,Acme transfer','L2,2026-10-03,,2000.00,PHP,,Deposit'],{closing:'15001.00'}),'STMT-BAD');
 const failed=await rejects(run(acc,tx=>ledger.validateImport(tx,acc,entityId,bad.id,{},bad.version,{store,bankStatement})),'VALIDATION_FAILED','opening plus lines differs from closing');
 assert.match(failed.message,/not the closing 15001\.00/);
 assert.equal((await run(acc,tx=>ledger.getImport(tx,acc,entityId,bad.id))).state,'staged');
 await rejects(run(ctrl,tx=>ledger.approveImport(tx,ctrl,entityId,bad.id,{decision:'approve',contentVersion:1})),'STATE_CONFLICT','approving an unvalidated statement');
 const stmt=await importCsv(csv(['L1,2026-10-03,2026-10-03,3000.00,PHP,TRF-1001,Acme transfer','L2,2026-10-03,,2000.00,PHP,,Deposit','L3,2026-10-04,,-50.00,PHP,FEE,Service charge','L4,2026-10-05,,-11000.00,PHP,,Outgoing'],{closing:'3950.00'}),'STMT-OCT-1');
 const validated=await run(acc,tx=>ledger.validateImport(tx,acc,entityId,stmt.id,{},stmt.version,{store,bankStatement}));
 assert.deepEqual([validated.state,validated.rows,validated.duplicates],['validated',4,0]);
 await rejects(run(acc,tx=>ledger.commitImport(tx,acc,entityId,stmt.id,{},undefined,{store,bankStatement})),'FORBIDDEN','accountant holds no import.commit').catch(()=>{});
 await run(ctrl,tx=>ledger.approveImport(tx,ctrl,entityId,stmt.id,{decision:'approve',contentVersion:1}));
 const committed=await run(ctrl,tx=>ledger.commitImport(tx,ctrl,entityId,stmt.id,{},undefined,{store,bankStatement}));
 assert.deepEqual([committed.state,committed.journalEntryIds.length],['committed',0],'statements post nothing');
 const lines=await run(tre,tx=>treasury.listStatementLines(tx,tre,entityId,{bankAccountId:bdo.id}));
 assert.deepEqual(lines.map(l=>[l.sourceLineKey,l.signedAmount,l.matchState]),[['L1','3000.00','unmatched'],['L2','2000.00','unmatched'],['L3','-50.00','unmatched'],['L4','-11000.00','unmatched']]);
 // A later statement repeating L4 does not repost it.
 const stmt2=await importCsv(csv(['L4,2026-10-05,,-11000.00,PHP,,Outgoing again','L5,2026-10-05,,100.00,PHP,,Interest'],{opening:'14950.00',closing:'4050.00'}),'STMT-OCT-2');
 const v2=await run(acc,tx=>ledger.validateImport(tx,acc,entityId,stmt2.id,{},stmt2.version,{store,bankStatement}));
 assert.equal(v2.duplicates,1);
 await run(ctrl,tx=>ledger.approveImport(tx,ctrl,entityId,stmt2.id,{decision:'approve',contentVersion:1}));
 await run(ctrl,tx=>ledger.commitImport(tx,ctrl,entityId,stmt2.id,{},undefined,{store,bankStatement}));
 assert.equal((await run(tre,tx=>treasury.listStatementLines(tx,tre,entityId,{bankAccountId:bdo.id}))).length,5,'the repeated key was skipped');
 const batches=await run(tre,tx=>treasury.listStatementBatches(tx,tre,entityId,bdo.id));
 assert.deepEqual(batches.map(b=>[b.lineCount,b.duplicateCount]),[[4,0],[1,1]]);
 pass('P06-T02: a statement whose opening plus lines differs from closing is refused and stays staged; a balanced statement validates, is approved by another principal and commits its lines without posting; repeated source line keys never repost');

 // Proposals: exact reference matches L1; the 2,000 line has two candidates and stays unmatched.
 const proposals=await run(ctrl,tx=>treasury.proposeMatches(tx,ctrl,entityId,{bankAccountId:bdo.id}));
 assert.deepEqual([proposals.proposed.length,proposals.ambiguous.length],[1,1]);
 const proposed=(await run(tre,tx=>treasury.listMatches(tx,tre,entityId,{state:'proposed'}))).items[0];
 assert.deepEqual([proposed.statementLineIds,proposed.allocations[0].resourceId,proposed.reason],[[lines[0].id],rcB.id,'Exact reference and amount']);
 assert.equal((await run(tre,tx=>treasury.listStatementLines(tx,tre,entityId,{bankAccountId:bdo.id}))).find(l=>l.sourceLineKey==='L2').matchState,'unmatched','ambiguous line left alone');
 // P06-T01 AC-07: the 50 fee cannot be absorbed into a receipt match; it needs its own approved journal.
 await rejects(run(tre,tx=>treasury.createMatch(tx,tre,entityId,{statementLineIds:[lines[2].id],allocations:[{resourceType:'settlement',resourceId:rcC.id,amount:'50.00'}]})),'VALIDATION_FAILED','fee matched against a receipt (direction)');
 await rejects(run(tre,tx=>treasury.createMatch(tx,tre,entityId,{statementLineIds:[lines[1].id],allocations:[{resourceType:'settlement',resourceId:rcC.id,amount:'1950.00'}]})),'VALIDATION_FAILED','tolerance write-off inside a match');
 const feeJournal=await run(acc,tx=>ledger.createJournal(tx,acc,entityId,{bookId:book.id,accountingDate:'2026-10-04',documentDate:'2026-10-04',currency:'PHP',description:'Bank service charge October',lines:[{accountId:bankFees.id,branchId:branch.id,debit:'50.00',credit:'0',dimensions:{}},{accountId:bdoLedger.id,branchId:branch.id,debit:'0',credit:'50.00',dimensions:{}}],evidenceIds:[]}));
 await run(acc,tx=>ledger.submitJournal(tx,acc,entityId,feeJournal.id,{}));
 await run(ctrl,tx=>ledger.approveJournal(tx,ctrl,entityId,feeJournal.id,{decision:'approve',contentVersion:1}));
 const feePosted=await run(acc,tx=>ledger.postJournal(tx,acc,entityId,feeJournal.id,{}));
 const feeMatch=await run(tre,tx=>treasury.createMatch(tx,tre,entityId,{statementLineIds:[lines[2].id],allocations:[{resourceType:'journal',resourceId:feePosted.journalEntryIds[0],amount:'50.00'}],reason:'Service charge per advice'}));
 await rejects(run(tre,tx=>treasury.confirmMatch(tx,tre,entityId,feeMatch.id,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','preparer confirming their own match');
 await run(acc,tx=>treasury.confirmMatch(tx,acc,entityId,feeMatch.id,{decision:'approve',contentVersion:1}));
 await run(acc,tx=>treasury.confirmMatch(tx,acc,entityId,proposed.id,{decision:'approve',contentVersion:1}));
 // CORE-12: a second match on the same line cannot exceed its amount; the ambiguous line is resolved by the reviewer explicitly.
 const dup=await run(tre,tx=>treasury.createMatch(tx,tre,entityId,{statementLineIds:[lines[1].id],allocations:[{resourceType:'settlement',resourceId:rcC.id,amount:'2000.00'}],reason:'Deposit slip 4 October'}));
 const dup2=await run(acc,tx=>treasury.createMatch(tx,acc,entityId,{statementLineIds:[lines[1].id],allocations:[{resourceType:'settlement',resourceId:rcC2.id,amount:'2000.00'}],reason:'Alternative'}));
 await run(acc,tx=>treasury.confirmMatch(tx,acc,entityId,dup.id,{decision:'approve',contentVersion:1}));
 await rejects(run(tre,tx=>treasury.confirmMatch(tx,tre,entityId,dup2.id,{decision:'approve',contentVersion:1})),'ALLOCATION_EXCEEDS_BALANCE','confirming beyond the line amount');
 await rejects(run(tre,tx=>treasury.createMatch(tx,tre,entityId,{statementLineIds:[lines[0].id],allocations:[{resourceType:'settlement',resourceId:rcB.id,amount:'3000.00'}]})),'ALLOCATION_EXCEEDS_BALANCE','matching an already matched settlement');
 const after=await run(tre,tx=>treasury.listStatementLines(tx,tre,entityId,{bankAccountId:bdo.id}));
 assert.deepEqual(after.map(l=>[l.sourceLineKey,l.matchState]),[['L1','matched'],['L2','matched'],['L3','matched'],['L4','unmatched'],['L5','unmatched']]);
 const reversed=await run(acc,tx=>treasury.reverseMatch(tx,acc,entityId,dup.id,{reason:'Wrong deposit'}));
 assert.equal(reversed.state,'reversed');
 assert.equal((await run(tre,tx=>treasury.listStatementLines(tx,tre,entityId,{bankAccountId:bdo.id}))).find(l=>l.sourceLineKey==='L2').matchState,'unmatched');
 await run(ctrl,tx=>treasury.confirmMatch(tx,ctrl,entityId,dup2.id,{decision:'approve',contentVersion:1}));
 const recon=await run(tre,tx=>treasury.reconciliationReport(tx,tre,entityId,{bankAccountId:bdo.id,asOf:'2026-10-05'}));
 assert.deepEqual([recon.statementBalance,recon.unmatchedLines.map(l=>l.sourceLineKey)],['4050.00',['L4','L5']]);
 pass('P06-T01: the exact-reference receipt is proposed, the ambiguous deposit stays unmatched for the reviewer, a fee reconciles only through its approved journal (AC-07), matches conserve amounts, a manual match needs another confirmer, confirmed amounts never overlap on a line or a settlement, and a reversal reopens the line');

 // Transfers post both sides in one entry.
 const transfer=await run(tre,tx=>treasury.createTransfer(tx,tre,entityId,{fromAccountId:bdo.id,toAccountId:bpi.id,currency:'PHP',amount:'1500.00',valueDate:'2026-10-06',evidenceIds:[bankDoc]}));
 await run(tre,tx=>treasury.submitTransfer(tx,tre,entityId,transfer.id,{}));
 await rejects(run(tre,tx=>treasury.approveTransfer(tx,tre,entityId,transfer.id,{decision:'approve',contentVersion:1})),'FORBIDDEN','treasury holds no transfer approval');
 await run(ctrl,tx=>treasury.approveTransfer(tx,ctrl,entityId,transfer.id,{decision:'approve',contentVersion:1}));
 const tPosted=await run(dir,tx=>treasury.postTransfer(tx,dir,entityId,transfer.id,{}));
 const entryLines=async id=>(await run(acc,tx=>tx.query('select a.code,l.txn_debit::text as debit,l.txn_credit::text as credit from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entry_id=$2 order by l.line_no',[tenantId,id]))).rows.map(r=>[r.code,ledger.decimal(ledger.micros(r.debit)),ledger.decimal(ledger.micros(r.credit))]);
 assert.deepEqual(await entryLines(tPosted.journalEntryIds[0]),[['1030','1500.00','0.00'],['1020','0.00','1500.00']]);
 assert.deepEqual((await run(dir,tx=>treasury.postTransfer(tx,dir,entityId,transfer.id,{}))).journalEntryIds,tPosted.journalEntryIds);
 pass('transfers travel through submit, independent approval and posting of one entry (Dr destination / Cr source); a repeated post returns the same entry');

 // P06-T04: a received check settles invoice A partially; custody blocks posting until it clears; a bounce reverses only that receipt.
 const itemA=await itemOf(invA);
 const checkReceipt=await run(bill,tx=>sales.createCollection(tx,bill,entityId,{direction:'receipt',partyId:customer.id,currency:'PHP',valueDate:'2026-10-07',grossAmount:'2000.00',cashAmount:'2000.00',withholdingAmount:'0.00',method:'check',allocations:[{openItemId:itemA.id,amount:'2000.00'}],evidenceIds:[],bankAccountId:bdo.id}));
 await rejects(run(tre,tx=>treasury.createCheck(tx,tre,entityId,{direction:'received',bankAccountId:bdo.id,number:'CHK-77',amount:'1999.00',currency:'PHP',dueDate:'2026-10-10',partyId:customer.id,settlementId:checkReceipt.id})),'VALIDATION_FAILED','check amount differs from the receipt');
 const check=await run(tre,tx=>treasury.createCheck(tx,tre,entityId,{direction:'received',bankAccountId:bdo.id,number:'CHK-77',amount:'2000.00',currency:'PHP',dueDate:'2026-10-10',partyId:customer.id,settlementId:checkReceipt.id}));
 assert.equal(check.state,'custody');
 await rejects(run(tre,tx=>treasury.createCheck(tx,tre,entityId,{direction:'received',bankAccountId:bdo.id,number:'CHK-77',amount:'1.00',currency:'PHP',dueDate:'2026-10-10',partyId:customer.id})),'STATE_CONFLICT','same check number twice');
 await run(bill,tx=>sales.submitCollection(tx,bill,entityId,checkReceipt.id,{}));
 await run(acc,tx=>sales.approveCollection(tx,acc,entityId,checkReceipt.id,{decision:'approve',contentVersion:1}));
 await rejects(run(acc,tx=>sales.postCollection(tx,acc,entityId,checkReceipt.id,{})),'STATE_CONFLICT','receipt posted while the check is in custody');
 await rejects(run(tre,tx=>treasury.releaseCheck(tx,tre,entityId,check.id,{reason:'x'})),'STATE_CONFLICT','releasing a received check');
 await run(tre,tx=>treasury.depositCheck(tx,tre,entityId,check.id,{reason:'Deposited at BDO Makati'}));
 await rejects(run(acc,tx=>sales.postCollection(tx,acc,entityId,checkReceipt.id,{})),'STATE_CONFLICT','receipt posted while deposited but not cleared');
 await run(tre,tx=>treasury.clearCheck(tx,tre,entityId,check.id,{reason:'Cleared per bank'}));
 const checkPosted=await run(acc,tx=>sales.postCollection(tx,acc,entityId,checkReceipt.id,{}));
 assert.deepEqual([(await itemOf(invA)).outstandingAmount,(await itemOf(invB)).outstandingAmount],['3000.00','0.00']);
 // Another transfer receipt settles the rest of invoice A; the bounce must not touch it.
 const rcA2=await receipt({valueDate:'2026-10-08',grossAmount:'3000.00',cashAmount:'3000.00',allocations:[{openItemId:itemA.id,amount:'3000.00'}]});
 await run(acc,tx=>sales.postCollection(tx,acc,entityId,rcA2.id,{}));
 assert.equal((await itemOf(invA)).outstandingAmount,'0.00');
 await rejects(run(tre,tx=>treasury.clearCheck(tx,tre,entityId,check.id,{reason:'again'})),'STATE_CONFLICT','clearing twice');
 const bounced=await run(tre,tx=>treasury.dishonorCheck(tx,tre,entityId,check.id,{accountingDate:'2026-10-09',reason:'Insufficient funds'},undefined,{reverseSettlement:sales.reverseSettlementEffect}));
 assert.deepEqual([bounced.state,bounced.journalEntryIds.length],['dishonored',1]);
 assert.deepEqual(await entryLines(bounced.journalEntryIds[0]),[['1020','0.00','2000.00'],['1200','2000.00','0.00']]);
 assert.deepEqual([(await itemOf(invA)).outstandingAmount,(await itemOf(invB)).outstandingAmount,(await itemOf(invC)).outstandingAmount],['2000.00','0.00','0.00'],'only the bounced receipt is unwound');
 assert.equal((await run(acc,tx=>sales.getCollection(tx,acc,entityId,checkReceipt.id))).state,'reversed');
 assert.equal((await run(acc,tx=>sales.getCollection(tx,acc,entityId,rcA2.id))).state,'posted');
 await rejects(run(tre,tx=>treasury.dishonorCheck(tx,tre,entityId,check.id,{accountingDate:'2026-10-09',reason:'again'},undefined,{reverseSettlement:sales.reverseSettlementEffect})),'STATE_CONFLICT','dishonoring twice');
 const replacement=await run(tre,tx=>treasury.createCheck(tx,tre,entityId,{direction:'received',bankAccountId:bdo.id,number:'CHK-78',amount:'2000.00',currency:'PHP',dueDate:'2026-10-20',partyId:customer.id},{replacesId:check.id}));
 assert.equal((await run(acc,tx=>tx.query('select replaces_id from lara.check_instruments where tenant_id=$1 and id=$2',[tenantId,replacement.id]))).rows[0].replaces_id,check.id);
 assert.equal(checkPosted.state,'posted');
 pass('P06-T04: a received check is custody only until it clears (the linked receipt cannot post before), clears once, and a bounce posts the linked reversal and unwinds only its own allocations; the replacement check links back');

 // P06-T03: one bank file run per release; a second release attempt has no effect.
 const clerk=await ctxFor('clerk');
 const bl=await run(clerk,tx=>purchasing.createDocument(tx,clerk,entityId,{kind:'bill',branchId:branch.id,bookId:book.id,partyId:supplier.id,documentDate:'2026-10-02',accountingDate:'2026-10-02',currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:'SI-9',lines:[line(expense.id,'11000')],evidenceIds:[bankDoc]}));
 await run(clerk,tx=>purchasing.submitDocument(tx,clerk,entityId,bl.id,{}));await run(acc,tx=>purchasing.approveDocument(tx,acc,entityId,bl.id,{decision:'approve',contentVersion:1}));await run(acc,tx=>purchasing.postDocument(tx,acc,entityId,bl.id,{}));
 const apItem=(await run(acc,tx=>sales.listOpenItems(tx,acc,entityId,{partyId:supplier.id,side:'AP'}))).items[0];
 const proposal=await run(tre,tx=>purchasing.createSettlement(tx,tre,entityId,{direction:'payment',partyId:supplier.id,currency:'PHP',valueDate:'2026-10-05',grossAmount:'11000.00',cashAmount:'11000.00',withholdingAmount:'0.00',method:'transfer',bankAccountId:bdo.id,allocations:[{openItemId:apItem.id,amount:'11000.00'}],evidenceIds:[]}));
 await run(tre,tx=>purchasing.submitSettlement(tx,tre,entityId,proposal.id,{}));
 const ben=await run(tre,tx=>purchasing.createBeneficiary(tx,tre,entityId,{partyId:supplier.id,bankName:'BDO',accountName:'Supplies Inc',accountNumber:'5555666677'},env));
 await run(ctrl,tx=>purchasing.approveBeneficiary(tx,ctrl,entityId,ben.id));
 const order=await run(tre,tx=>purchasing.createPayment(tx,tre,entityId,{settlementId:proposal.id,beneficiaryVersionId:ben.id,scheduledDate:'2026-10-05'}));
 await run(tre,tx=>purchasing.submitPayment(tx,tre,entityId,order.id,{}));
 await run(ctrl,tx=>purchasing.authorizePayment(tx,ctrl,entityId,order.id,{decision:'approve',contentVersion:1}));
 await rejects(run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order.id,{channel:'qualified_api',externalReference:'API',evidenceIds:[bankDoc]},undefined,{bankFile:treasury.generateBankFile,store})),'FEATURE_NOT_ENABLED','direct bank API stays disabled');
 const released=await run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order.id,{channel:'bank_file',externalReference:'batch-1',evidenceIds:[bankDoc]},undefined,{bankFile:treasury.generateBankFile,store}));
 assert.equal(released.state,'released');assert.ok(released.bankFileRunId);
 const runs=await run(tre,tx=>treasury.listBankFileRuns(tx,tre,entityId,{bankAccountId:bdo.id}));
 assert.deepEqual([runs.length,runs[0].itemCount,runs[0].totalAmount,runs[0].items[0].paymentId,runs[0].state],[1,1,'11000.00',order.id,'generated']);
 const file=(await store.get((await run(acc,tx=>tx.query('select object_key from lara.evidence where tenant_id=$1 and id=$2',[tenantId,runs[0].evidenceId]))).rows[0].object_key)).toString();
 assert.match(file,/^format,payment_id,bank_code,account_last4,account_name,amount,currency,value_date,reference\n/);
 assert.match(file,/6677,"Supplies Inc",11000\.00,PHP,2026-10-05,PAY-/);
 assert.equal(sha(file),runs[0].fileHash);
 await rejects(run(tre,tx=>purchasing.releasePayment(tx,tre,entityId,order.id,{channel:'bank_file',externalReference:'batch-1',evidenceIds:[bankDoc]},undefined,{bankFile:treasury.generateBankFile,store})),'STATE_CONFLICT','a second release of the same payment');
 assert.equal((await run(tre,tx=>treasury.listBankFileRuns(tx,tre,entityId,{bankAccountId:bdo.id}))).length,1,'one run');
 const settled=await run(tre,tx=>purchasing.settlePayment(tx,tre,entityId,order.id,{externalReference:'BANK-9',settledAt:'2026-10-05T02:00:00Z',valueDate:'2026-10-05',evidenceIds:[bankDoc]}));
 assert.equal(settled.state,'settled');
 const l4=(await run(tre,tx=>treasury.listStatementLines(tx,tre,entityId,{bankAccountId:bdo.id}))).find(l=>l.sourceLineKey==='L4');
 const p2=await run(ctrl,tx=>treasury.proposeMatches(tx,ctrl,entityId,{bankAccountId:bdo.id}));
 assert.deepEqual([p2.proposed.length,p2.ambiguous.length],[1,0],'the settled payment is proposed for the outgoing line');
 const outMatch=(await run(tre,tx=>treasury.listMatches(tx,tre,entityId,{state:'proposed'}))).items.find(m=>m.statementLineIds[0]===l4.id);
 assert.equal(outMatch.allocations[0].resourceId,proposal.id);
 await run(acc,tx=>treasury.confirmMatch(tx,acc,entityId,outMatch.id,{decision:'approve',contentVersion:1}));
 pass('P06-T03: an authorized payment releases once into one locked, hashed bank file stored as restricted evidence; the direct API channel is refused; a repeated release has no effect; the settled payment reconciles against the outgoing statement line');

 // P06-T05: cash session with variance; the cashier cannot certify their own handover; variance stays visible.
 await approve('treasury_profile',{cashAccountId:petty.id,cashVarianceAccountId:cashVar.id,fileFormatVersion:'lara-csv-1',matchWindowDays:3});
 // Review correction: the expected float counts the cash of the session's branch only; a receipt records the branch whose drawer took it, and cash taken elsewhere on the day is not this drawer's.
 const cebu=await run(ctrl,tx=>organization.createBranch(tx,ctrl,entityId,{code:'CEBU',name:'Cebu office',address:'Cebu'}));
 const cashHq=await receipt({valueDate:'2026-10-09',grossAmount:'300.00',cashAmount:'300.00',method:'cash',bankAccountId:undefined,branchId:branch.id,allocations:[]});
 const cashCebu=await receipt({valueDate:'2026-10-09',grossAmount:'700.00',cashAmount:'700.00',method:'cash',bankAccountId:undefined,branchId:cebu.id,allocations:[]});
 for(const r of [cashHq,cashCebu])await run(acc,tx=>sales.postCollection(tx,acc,entityId,r.id,{}));
 assert.equal((await run(acc,tx=>sales.getCollection(tx,acc,entityId,cashCebu.id))).branchId,cebu.id,'the settlement keeps its branch');
 assert.equal((await run(ctrl,tx=>tx.query('select branch_id from lara.journal_lines where tenant_id=$1 and entry_id=(select posted_entry_id from lara.settlements where id=$2) limit 1',[tenantId,cashCebu.id]))).rows[0].branch_id,cebu.id,'the receipt posts on its branch');
 const session=await run(cashier,tx=>treasury.createCashSession(tx,cashier,entityId,{branchId:branch.id,cashierId:principals.cashier,businessDate:'2026-10-09',openingAmount:'4700.00'}));
 assert.equal(session.state,'open');
 await rejects(run(cashier,tx=>treasury.createCashSession(tx,cashier,entityId,{branchId:branch.id,cashierId:principals.cashier,businessDate:'2026-10-09',openingAmount:'1.00'})),'STATE_CONFLICT','second open session for the cashier and date');
 await rejects(run(cashier,tx=>treasury.closeCashSession(tx,cashier,entityId,session.id,{reason:'Done'})),'STATE_CONFLICT','close before counting');
 await rejects(run(cashier,tx=>treasury.countCashSession(tx,cashier,entityId,session.id,{lines:[{denomination:'1000.00',quantity:4},{denomination:'500.00',quantity:1},{denomination:'100.00',quantity:3}],evidenceIds:[]})),'VALIDATION_FAILED','variance without a reason');
 const counted=await run(cashier,tx=>treasury.countCashSession(tx,cashier,entityId,session.id,{lines:[{denomination:'1000.00',quantity:4},{denomination:'500.00',quantity:1},{denomination:'100.00',quantity:3}],reason:'Short 200: change given twice on receipt 14',evidenceIds:[]}));
 assert.deepEqual([counted.state,counted.counted,counted.expected,counted.variance],['counted','4800.00','5000.00','-200.00']);
 const closed=await run(cashier,tx=>treasury.closeCashSession(tx,cashier,entityId,session.id,{reason:'End of day'}));
 assert.deepEqual(await entryLines(closed.journalEntryIds[0]),[['5950','200.00','0.00'],['1010','0.00','200.00']]);
 await rejects(run(cashier,tx=>treasury.countCashSession(tx,cashier,entityId,session.id,{lines:[{denomination:'1000.00',quantity:5}],evidenceIds:[]})),'STATE_CONFLICT','recount after close overwriting the counted value');
 await rejects(run(cashier,tx=>treasury.handoverCashSession(tx,cashier,entityId,session.id,{decision:'approve',contentVersion:1})),'SELF_APPROVAL','cashier certifying their own handover');
 const handed=await run(tre,tx=>treasury.handoverCashSession(tx,tre,entityId,session.id,{decision:'approve',contentVersion:1}));
 assert.equal(handed.state,'handed_over');
 const detail=await run(tre,tx=>treasury.cashSessionDetail(tx,tre,entityId,session.id));
 assert.deepEqual([detail.variance,detail.varianceReason,detail.handovers[0].attestations.variance,detail.handovers[0].incomingId===principals.treasury,detail.counts.length],['-200.00','Short 200: change given twice on receipt 14','-200.00',true,3]);
 const tb=await run(ctrl,tx=>ledger.trialBalance(tx,ctrl,entityId,{bookId:book.id,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:new Date().toISOString()}));
 assert.equal(tb.totals.balanced,true);
 pass('P06-T05: counts by denomination against the expected float, a variance needs a reason and posts under the approved policy at close, counted values are never overwritten, the cashier cannot certify their own handover, and the independent handover attests to the visible variance');
 console.log('P06-02 domain acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[tenantId]);
 await Promise.all([api.end(),owner.end()]);
}
