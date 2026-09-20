// P06-03 HTTP acceptance: treasury operations through the API and worker as
// processes. Bank account review, statement import through /imports with
// the treasury validation, the propose-matches job, statement lines and
// reconciliation reads, match confirmation and reversal with typed refusals,
// transfers, checks, cash sessions, a bank-file payment release generating
// one run under idempotent replay, and isolation.
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
const PORT=4029,BASE='http://127.0.0.1:'+PORT,bucket='.local/p06-api-test-'+randomBytes(3).toString('hex');
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
const call=async(name,method,path,{body,headers={},raw}={})=>{const token=signIdentity(name+'-'+suffix,method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET);return fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token,...(raw?{}:{'content-type':'application/json'}),...headers},body:raw??(body===undefined?undefined:JSON.stringify(body))});};
const json=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return {raw:t};}};
const must=async(r,status)=>{const t=await r.text();assert.equal(r.status,status,t);try{return JSON.parse(t);}catch{return {raw:t};}};
const key=()=>({'idempotency-key':randomUUID()});
const im=v=>({'if-match':'"'+v+'"'});
const contract=(op,body)=>{const v=validateResponse(op,body);assert.equal(v.ok,true,op+' drifted: '+JSON.stringify(v.fieldErrors)+' '+JSON.stringify(body).slice(0,300));};
const apiProcess=start('apps/api/src/server.mjs');let worker=null;
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 let entityId,branchId,bookId,customerId,supplierId,evidenceId,beneficiaryId;const accounts={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-treas-'+suffix,name:'Treasury API',mode:'demo'});
  for(const n of ['billing','clerk','accountant','treasury','cashier','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['billing','clerk','accountant','treasury','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  roles.approver=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'treasury_approver','Treasury approver','[\"transfer.approve\",\"transfer.post\",\"transfer.read\",\"report.generate\"]','approved',$2,$3) returning id",[tenantId,sha('approver'),principals.security])).rows[0].id;
  for(const [p,r] of [['billing','billing'],['clerk','clerk'],['accountant','accountant'],['treasury','treasury'],['cashier','treasury'],['controller','controller'],['controller','approver'],['director','controller'],['director','approver'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Treasury API Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  branchId=(await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'})).id;
  for(const c of ['workspace','general_ledger','sales','purchasing','treasury'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.director,principals.controller]);
  bookId=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,principals.controller])).rows[0].id;
  for(const [code,name,category,control] of [['1010','Petty cash','asset','none'],['1020','Bank BDO','asset','none'],['1030','Bank BPI','asset','none'],['1200','Receivables','asset','ar'],['1300','Input tax','asset','input_tax'],['2100','Payables','liability','ap'],['2200','Output tax','liability','output_tax'],['4000','Revenue','income','none'],['5000','Fees','expense','none'],['5950','Cash over and short','expense','none']])accounts[code]=(await tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id",[tenantId,entityId,bookId,code,name,category,category==='asset'||category==='expense'?'debit':'credit',control,control==='none',sha(code),principals.accountant])).rows[0].id;
  await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4)",[tenantId,entityId,bookId,principals.controller]);
  const dir={...await identity.actorContext(tx,tenantId,principals.director),traceId:'setup'};
  for(const [kind,payload] of [['sales_profile',{arAccountId:accounts['1200'],outputTaxAccountId:accounts['2200'],cashAccountId:accounts['1020'],scale:2,dueDays:30}],['purchasing_profile',{apAccountId:accounts['2100'],inputTaxAccountId:accounts['1300'],cashAccountId:accounts['1020'],scale:2,dueDays:30}],['treasury_profile',{cashAccountId:accounts['1010'],cashVarianceAccountId:accounts['5950'],fileFormatVersion:'lara-csv-1',matchWindowDays:3}]]){const s=await organization.saveSettings(tx,ctrl,entityId,kind,payload);await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});}
  const clerk={...await identity.actorContext(tx,tenantId,principals.clerk),traceId:'setup'};
  customerId=(await parties.createParty(tx,clerk,entityId,{legalName:'Acme Trading',roles:['customer'],identityStatus:'unknown',address:'Cebu'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  supplierId=(await parties.createParty(tx,clerk,entityId,{legalName:'Supplies Inc',roles:['supplier'],identityStatus:'unknown',address:'Cebu'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  const pdf=Buffer.from('%PDF-1.4 bank confirmation\n');const store=new evidence.MemoryEvidenceStore();
  const reg=await evidence.registerUpload(tx,clerk,entityId,{filename:'bank.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'internal'});
  await evidence.completeUpload(tx,clerk,entityId,reg.evidenceId,pdf,store);
  await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);
  evidenceId=reg.evidenceId;
  const tre={...await identity.actorContext(tx,tenantId,principals.treasury),traceId:'setup'};
  const ben=await purchasing.createBeneficiary(tx,tre,entityId,{partyId:supplierId,bankName:'BDO',accountName:'Supplies Inc',accountNumber:'0012345678'},{FIELD_ENCRYPTION_KEY:fieldKey});
  beneficiaryId=(await purchasing.approveBeneficiary(tx,ctrl,entityId,ben.id)).id;
 });
 const eh={'x-entity-id':entityId};
 // Bank accounts
 let r=await call('treasury','POST','/bank-accounts',{body:{bookId,ledgerAccountId:accounts['1200'],bankCode:'BDO',accountNumber:'001234567890',currency:'PHP',evidenceIds:[evidenceId]},headers:{...key(),...eh}});assert.equal(r.status,422,'control account');
 r=await call('treasury','POST','/bank-accounts',{body:{bookId,ledgerAccountId:accounts['1020'],bankCode:'BDO',accountNumber:'001234567890',currency:'PHP',evidenceIds:[evidenceId]},headers:{...key(),...eh}});const bdo=await must(r,201);contract('post_bank_accounts',bdo);assert.deepEqual([bdo.state,bdo.accountNumberMasked],['draft','••••7890']);
 r=await call('treasury','POST','/bank-accounts/'+bdo.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(bdo.version)}});assert.equal(r.status,403);
 r=await call('controller','POST','/bank-accounts/'+bdo.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(bdo.version)}});const approved=await must(r,200);contract('post_bank_accounts_id_approve',approved);assert.equal(approved.state,'approved');
 r=await call('treasury','POST','/bank-accounts',{body:{bookId,ledgerAccountId:accounts['1030'],bankCode:'BPI',accountNumber:'9988776655',currency:'PHP',evidenceIds:[evidenceId]},headers:{...key(),...eh}});const bpi=await must(r,201);
 r=await call('controller','POST','/bank-accounts/'+bpi.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(bpi.version)}});await must(r,200);
 r=await call('treasury','GET','/bank-accounts',{headers:eh});const banks=await must(r,200);contract('get_bank_accounts',banks);assert.equal(banks.items.length,2);
 pass('bank accounts: control-account refusal 422, draft with masked number, approval under another role, listed with contract shape');
 // A receipt to reconcile.
 const inv=await must(await call('billing','POST','/invoices',{body:{kind:'invoice',branchId,bookId,partyId:customerId,documentDate:'2026-10-01',accountingDate:'2026-10-01',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Services',quantity:'1',unitPrice:'3000',discount:'0',priceBasis:'exclusive',accountId:accounts['4000'],dimensions:{}}],evidenceIds:[]},headers:{...key(),...eh}}),201);
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 await api.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4)",[tenantId,entityId,branchId,principals.controller]);
 let s=await must(await call('billing','POST','/invoices/'+inv.id+'/submit',{body:{},headers:{...key(),...eh,...im(inv.version)}}),200);
 s=await must(await call('accountant','POST','/invoices/'+inv.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}}),200);
 await must(await call('accountant','POST','/invoices/'+inv.id+'/post',{body:{},headers:{...key(),...eh,...im(s.version)}}),200);
 const item=(await must(await call('billing','GET','/open-items?partyId='+customerId+'&side=AR',{headers:eh}),200)).items[0];
 const rc=await must(await call('billing','POST','/collections',{body:{direction:'receipt',partyId:customerId,bankAccountId:bdo.id,currency:'PHP',valueDate:'2026-10-03',grossAmount:'3000.00',cashAmount:'3000.00',withholdingAmount:'0.00',method:'transfer',allocations:[{openItemId:item.id,amount:'3000.00'}],evidenceIds:[]},headers:{...key(),...eh}}),201);
 s=await must(await call('billing','POST','/collections/'+rc.id+'/submit',{body:{},headers:{...key(),...eh,...im(rc.version)}}),200);
 s=await must(await call('accountant','POST','/collections/'+rc.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}}),200);
 await must(await call('accountant','POST','/collections/'+rc.id+'/post',{body:{},headers:{...key(),...eh,...im(s.version)}}),200);
 await api.query("update lara.settlements set bank_reference='TRF-2001' where tenant_id=$1 and id=$2",[tenantId,rc.id]);
 // Statement import through /imports: upload CSV evidence, create, validate (treasury rules), approve, commit; the worker proposes matches.
 worker=start('apps/worker/src/main.mjs');
 const uploadCsv=async(name,text)=>{const bytes=Buffer.from(text);const reg=await must(await call('clerk','POST','/evidence/uploads',{body:{filename:name,mime:'text/csv',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'},headers:{...key(),...eh}}),201);await call('clerk','PUT','/evidence/'+reg.evidenceId+'/content',{raw:bytes,headers:{...eh,'content-type':'text/csv'}});const c=await call('clerk','POST','/evidence/'+reg.evidenceId+'/complete',{body:{},headers:{...key(),...eh,...im(reg.version)}});assert.equal(c.status,202,await c.text());await waitFor(async()=>(await json(await call('clerk','GET','/evidence/'+reg.evidenceId,{headers:eh}))).state==='available','scan',60000);return reg.evidenceId;};
 const csv=(rows,closing)=>['source_line_key,booked_date,value_date,signed_amount,currency,reference,description','opening_balance,2026-10-01,,10000.00,PHP,,','closing_balance,2026-10-05,,'+closing+',PHP,,',...rows].join('\n')+'\n';
 const badCsv=await uploadCsv('bad.csv',csv(['L1,2026-10-03,,3000.00,PHP,TRF-2001,Acme'],'13001.00'));
 r=await call('accountant','POST','/imports',{body:{kind:'bank_statement',evidenceId:badCsv,mappingVersion:'lara-csv-1',sourceId:bdo.id,externalBatchId:'STMT-BAD',cutoffDate:'2026-10-05'},headers:{...key(),...eh}});const badImport=await must(r,201);contract('post_imports',badImport);
 r=await call('accountant','POST','/imports/'+badImport.id+'/validate',{body:{},headers:{...key(),...eh,...im(badImport.version)}});assert.equal(r.status,422);assert.match((await json(r)).message,/not the closing/);
 const goodCsv=await uploadCsv('good.csv',csv(['L1,2026-10-03,,3000.00,PHP,TRF-2001,Acme','L2,2026-10-04,,-50.00,PHP,FEE,Charge'],'12950.00'));
 r=await call('accountant','POST','/imports',{body:{kind:'bank_statement',evidenceId:goodCsv,mappingVersion:'lara-csv-1',sourceId:bdo.id,externalBatchId:'STMT-1',cutoffDate:'2026-10-05'},headers:{...key(),...eh}});const imp=await must(r,201);
 r=await call('accountant','POST','/imports/'+imp.id+'/validate',{body:{},headers:{...key(),...eh,...im(imp.version)}});const validated=await must(r,200);contract('post_imports_id_validate',validated);assert.equal(validated.state,'validated');
 r=await call('controller','POST','/imports/'+imp.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(validated.version)}});const impApproved=await must(r,200);
 const ck=key();
 r=await call('controller','POST','/imports/'+imp.id+'/commit',{body:{},headers:{...ck,...eh,...im(impApproved.version)}});const committed=await must(r,200);contract('post_imports_id_commit',committed);assert.deepEqual([committed.state,committed.journalEntryIds],['committed',[]]);
 r=await call('controller','POST','/imports/'+imp.id+'/commit',{body:{},headers:{...ck,...eh,...im(impApproved.version)}});assert.equal((await must(r,200)).state,'committed','replay');
 r=await call('treasury','GET','/bank-statement-lines?bankAccountId='+bdo.id,{headers:eh});const lines=await must(r,200);contract('get_bank_statement_lines',lines);assert.deepEqual(lines.items.map(l=>[l.sourceLineKey,l.signedAmount]),[['L1','3000.00'],['L2','-50.00']]);
 await waitFor(async()=>(await json(await call('treasury','GET','/bank-matches?state=proposed',{headers:eh}))).items?.length===1,'propose job',60000);
 const proposed=(await must(await call('treasury','GET','/bank-matches?state=proposed',{headers:eh}),200)).items[0];contract('get_bank_matches',{items:[proposed],nextCursor:null});
 assert.deepEqual([proposed.allocations[0].resourceId,proposed.reason],[rc.id,'Exact reference and amount']);
 pass('statement import: unbalanced statement 422 with the balance message, balanced statement validates, approves and commits without posting (idempotent replay), lines are listed, and the worker proposes the exact-reference match');
 // Matches: fee needs its own journal; conserve amounts; confirm by another role; reverse.
 r=await call('treasury','POST','/bank-matches',{body:{statementLineIds:[lines.items[1].id],allocations:[{resourceType:'settlement',resourceId:rc.id,amount:'50.00'}]},headers:{...key(),...eh}});assert.equal(r.status,422,'fee against a receipt');
 r=await call('accountant','POST','/journals',{body:{bookId,accountingDate:'2026-10-04',documentDate:'2026-10-04',currency:'PHP',description:'Bank charge',lines:[{accountId:accounts['5000'],branchId,debit:'50.00',credit:'0',dimensions:{}},{accountId:accounts['1020'],branchId,debit:'0',credit:'50.00',dimensions:{}}],evidenceIds:[]},headers:{...key(),...eh}});const j=await must(r,201);
 s=await must(await call('accountant','POST','/journals/'+j.id+'/submit',{body:{},headers:{...key(),...eh,...im(j.version)}}),200);
 s=await must(await call('controller','POST','/journals/'+j.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}}),200);
 const jPosted=await must(await call('accountant','POST','/journals/'+j.id+'/post',{body:{},headers:{...key(),...eh,...im(s.version)}}),200);
 r=await call('treasury','POST','/bank-matches',{body:{statementLineIds:[lines.items[1].id],allocations:[{resourceType:'journal',resourceId:jPosted.journalEntryIds[0],amount:'50.00'}],reason:'Service charge'},headers:{...key(),...eh}});const feeMatch=await must(r,201);contract('post_bank_matches',feeMatch);
 r=await call('treasury','POST','/bank-matches/'+feeMatch.id+'/confirm',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(feeMatch.version)}});assert.equal(r.status,403);assert.equal((await json(r)).code,'SELF_APPROVAL');
 r=await call('accountant','POST','/bank-matches/'+feeMatch.id+'/confirm',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(feeMatch.version)}});const confirmed=await must(r,200);contract('post_bank_matches_id_confirm',confirmed);assert.equal(confirmed.state,'confirmed');
 r=await call('accountant','POST','/bank-matches/'+proposed.id+'/confirm',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(proposed.version)}});await must(r,200);
 r=await call('treasury','GET','/bank-reconciliation?bankAccountId='+bdo.id+'&asOf=2026-10-05',{headers:eh});const recon=await must(r,200);contract('get_bank_reconciliation',recon);assert.deepEqual([recon.statementBalance,recon.unmatchedLines.length],['12950.00',0]);
 r=await call('accountant','POST','/bank-matches/'+feeMatch.id+'/reverse',{body:{reason:'Wrong charge'},headers:{...key(),...eh,...im(confirmed.version)}});const rev=await must(r,200);contract('post_bank_matches_id_reverse',rev);assert.equal(rev.state,'reversed');
 r=await call('treasury','GET','/bank-statement-lines?bankAccountId='+bdo.id+'&matchState=unmatched',{headers:eh});assert.deepEqual((await must(r,200)).items.map(l=>l.sourceLineKey),['L2']);
 pass('matches: a fee cannot hide in a receipt match (422), reconciles through its approved journal, needs another confirmer (SELF_APPROVAL), the reconciliation view balances, and a reversal reopens the line');
 // Transfers
 r=await call('treasury','POST','/transfers',{body:{fromAccountId:bdo.id,toAccountId:bpi.id,currency:'PHP',amount:'1500.00',valueDate:'2026-10-06',evidenceIds:[]},headers:{...key(),...eh}});const t=await must(r,201);contract('post_transfers',t);
 s=await must(await call('treasury','POST','/transfers/'+t.id+'/submit',{body:{},headers:{...key(),...eh,...im(t.version)}}),200);
 r=await call('treasury','POST','/transfers/'+t.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}});assert.equal(r.status,403);
 s=await must(await call('controller','POST','/transfers/'+t.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}}),200);
 const tPosted=await must(await call('director','POST','/transfers/'+t.id+'/post',{body:{},headers:{...key(),...eh,...im(s.version)}}),200);contract('post_transfers_id_post',tPosted);assert.equal(tPosted.journalEntryIds.length,1);
 r=await call('treasury','GET','/transfers',{headers:eh});const ts=await must(r,200);contract('get_transfers',ts);assert.equal(ts.items[0].state,'posted');
 pass('transfers: submit, forbidden and independent approval, posting of one entry, listed with contract shape');
 // Checks
 r=await call('treasury','POST','/checks',{body:{direction:'received',bankAccountId:bdo.id,number:'CHK-1',amount:'500.00',currency:'PHP',dueDate:'2026-10-15',partyId:customerId},headers:{...key(),...eh}});const chk=await must(r,201);contract('post_checks',chk);assert.equal(chk.state,'custody');
 r=await call('treasury','POST','/checks/'+chk.id+'/release',{body:{reason:'x'},headers:{...key(),...eh,...im(chk.version)}});assert.equal(r.status,409);
 s=await must(await call('treasury','POST','/checks/'+chk.id+'/deposit',{body:{reason:'Deposited'},headers:{...key(),...eh,...im(chk.version)}}),200);contract('post_checks_id_deposit',s);
 s=await must(await call('treasury','POST','/checks/'+chk.id+'/clear',{body:{reason:'Cleared'},headers:{...key(),...eh,...im(s.version)}}),200);assert.equal(s.state,'cleared');
 r=await call('treasury','POST','/checks/'+chk.id+'/dishonor',{body:{accountingDate:'2026-10-16',reason:'Bounced'},headers:{...key(),...eh,...im(s.version)}});const dis=await must(r,200);contract('post_checks_id_dishonor',dis);assert.equal(dis.state,'dishonored');
 r=await call('treasury','GET','/checks?direction=received',{headers:eh});const cks=await must(r,200);contract('get_checks',cks);
 pass('checks: custody, deposit, clear and dishonor over HTTP with typed refusals');
 // Cash sessions
 r=await call('cashier','POST','/cash-sessions',{body:{branchId,cashierId:principals.cashier,businessDate:'2026-10-09',openingAmount:'5000.00'},headers:{...key(),...eh}});const cs=await must(r,201);contract('post_cash_sessions',cs);
 r=await call('cashier','POST','/cash-sessions/'+cs.id+'/count',{body:{lines:[{denomination:'1000.00',quantity:4},{denomination:'500.00',quantity:1},{denomination:'100.00',quantity:3}],evidenceIds:[]},headers:{...key(),...eh,...im(cs.version)}});assert.equal(r.status,422,'variance without reason');
 s=await must(await call('cashier','POST','/cash-sessions/'+cs.id+'/count',{body:{lines:[{denomination:'1000.00',quantity:4},{denomination:'500.00',quantity:1},{denomination:'100.00',quantity:3}],reason:'Short 200',evidenceIds:[]},headers:{...key(),...eh,...im(cs.version)}}),200);contract('post_cash_sessions_id_count',s);
 s=await must(await call('cashier','POST','/cash-sessions/'+cs.id+'/close',{body:{reason:'End of day'},headers:{...key(),...eh,...im(s.version)}}),200);assert.equal(s.journalEntryIds.length,1);
 r=await call('cashier','POST','/cash-sessions/'+cs.id+'/handover',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}});assert.equal(r.status,403);assert.equal((await json(r)).code,'SELF_APPROVAL');
 s=await must(await call('treasury','POST','/cash-sessions/'+cs.id+'/handover',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}}),200);assert.equal(s.state,'handed_over');
 r=await call('treasury','GET','/cash-sessions',{headers:eh});const css=await must(r,200);contract('get_cash_sessions',css);
 pass('cash sessions: count with a reason, close posting the variance, the cashier refused their own handover, independent handover');
 // Bank-file payment release: one run per release under replay.
 const bl=await must(await call('clerk','POST','/bills',{body:{kind:'bill',branchId,bookId,partyId:supplierId,documentDate:'2026-10-02',accountingDate:'2026-10-02',currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:'SI-1',lines:[{description:'Fees',quantity:'1',unitPrice:'900',discount:'0',priceBasis:'exclusive',accountId:accounts['5000'],dimensions:{}}],evidenceIds:[evidenceId]},headers:{...key(),...eh}}),201);
 s=await must(await call('clerk','POST','/bills/'+bl.id+'/submit',{body:{},headers:{...key(),...eh,...im(bl.version)}}),200);
 s=await must(await call('accountant','POST','/bills/'+bl.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}}),200);
 await must(await call('accountant','POST','/bills/'+bl.id+'/post',{body:{},headers:{...key(),...eh,...im(s.version)}}),200);
 const apItem=(await must(await call('clerk','GET','/open-items?partyId='+supplierId+'&side=AP',{headers:eh}),200)).items[0];
 const prop=await must(await call('treasury','POST','/settlements',{body:{direction:'payment',partyId:supplierId,bankAccountId:bdo.id,currency:'PHP',valueDate:'2026-10-05',grossAmount:'900.00',cashAmount:'900.00',withholdingAmount:'0.00',method:'transfer',allocations:[{openItemId:apItem.id,amount:'900.00'}],evidenceIds:[]},headers:{...key(),...eh}}),201);
 await must(await call('treasury','POST','/settlements/'+prop.id+'/submit',{body:{},headers:{...key(),...eh,...im(prop.version)}}),200);
 const pay=await must(await call('treasury','POST','/payments',{body:{settlementId:prop.id,beneficiaryVersionId:beneficiaryId,scheduledDate:'2026-10-05'},headers:{...key(),...eh}}),201);
 s=await must(await call('treasury','POST','/payments/'+pay.id+'/submit',{body:{},headers:{...key(),...eh,...im(pay.version)}}),200);
 s=await must(await call('controller','POST','/payments/'+pay.id+'/authorize',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}}),200);
 const rk=key();
 r=await call('treasury','POST','/payments/'+pay.id+'/release',{body:{channel:'bank_file',externalReference:'run-1',evidenceIds:[evidenceId]},headers:{...rk,...eh,...im(s.version)}});const released=await must(r,200);contract('post_payments_id_release',released);assert.equal(released.state,'released');
 r=await call('treasury','POST','/payments/'+pay.id+'/release',{body:{channel:'bank_file',externalReference:'run-1',evidenceIds:[evidenceId]},headers:{...rk,...eh,...im(s.version)}});assert.equal((await must(r,200)).state,'released','replay with the same key');
 r=await call('treasury','POST','/payments/'+pay.id+'/release',{body:{channel:'bank_file',externalReference:'run-2',evidenceIds:[evidenceId]},headers:{...key(),...eh,...im(released.version)}});assert.equal(r.status,409,'a second release is refused');
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 const runs=(await api.query('select count(*)::int n from lara.bank_file_runs where tenant_id=$1',[tenantId])).rows[0].n;assert.equal(runs,1,'one run');
 const runEvidence=(await api.query('select export_evidence_id from lara.bank_file_runs where tenant_id=$1',[tenantId])).rows[0].export_evidence_id;
 r=await call('treasury','GET','/evidence/'+runEvidence+'/content',{headers:eh});assert.equal(r.status,200);assert.match(await r.text(),/^format,payment_id/);
 pass('P06-T03 over HTTP: a bank-file release generates one locked run stored as evidence; the same key replays, a new key is refused, and the file downloads through the evidence endpoint');
 // Isolation and later-phase gate
 r=await call('treasury','GET','/bank-accounts/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('treasury','GET','/bank-accounts/'+bdo.id,{headers:{'x-entity-id':randomUUID()}});assert.equal(r.status,404);
 r=await call('treasury','GET','/bank-statement-lines?bankAccountId='+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('treasury','POST','/packs/install',{body:{},headers:{...key(),...eh}});assert.equal(r.status,409);assert.equal((await json(r)).code,'FEATURE_NOT_ENABLED');
 pass('unknown accounts and foreign entities answer 404; P07 operations stay gated');
 console.log('P06-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split('\n').slice(-15).join('\n'));console.error(worker?.log().split('\n').slice(-8).join('\n')||'');throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
