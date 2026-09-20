// P11-03 HTTP acceptance: assets and schedules through the API and worker as
// processes. An asset drafted from a posted bill, edited, refused to the
// examiner, approved by another role with its capitalization entry; the
// depreciation schedule previewed through the lines read, approved and
// executed by the worker from POST /schedule-runs (202) with AC-08 posted
// once and a rerun posting nothing; a lifecycle event with evidence and the
// events and book/tax reads; pause; the asset_register report; isolation and
// later-phase gates.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,evidence,parties,purchasing,assets} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4034,BASE='http://127.0.0.1:'+PORT,bucket='.local/p11-api-test-'+randomBytes(3).toString('hex');
const fieldKey=process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex');
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:fieldKey,WORKER_POLL_MS:'200',RATE_LIMIT_WRITES_PER_MINUTE:'2000',RATE_LIMIT_READS_PER_MINUTE:'5000',MAIL_ADAPTER:'local',EINVOICE_ADAPTER:'fixture'};
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
 let entityId,branchId,bookId,evidenceId,billId,classId,periodId,period2Id;const accounts={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-ast-'+suffix,name:'Assets API',mode:'demo'});
  for(const n of ['fixed','clerk','accountant','controller','director','auditor','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['clerk','accountant','controller','auditor','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.fixed=await role('asset_clerk',['asset.create','asset.edit','asset.read','schedule.create','schedule.edit','schedule.read','evidence.upload','evidence.read','account.read','book.read','branch.read','party.read','bill.read','journal.read','period.read','report.generate','job.read']);
  roles.approver=await role('asset_approver',['asset.approve','asset.events','asset.read','schedule.approve','schedule.pause','schedule.execute','schedule.read','evidence.read','task.read','journal.read','job.read']);
  for(const [p,r] of [['fixed','fixed'],['clerk','clerk'],['accountant','accountant'],['accountant','approver'],['controller','controller'],['director','controller'],['director','approver'],['auditor','auditor'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Plant API Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  branchId=(await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'})).id;
  for(const c of ['workspace','general_ledger','sales','purchasing','assets'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.director,principals.controller]);
  bookId=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,principals.controller])).rows[0].id;
  for(const [code,name,category,side] of [['1010','Cash','asset','debit'],['1300','Input tax','asset','debit'],['1400','Advances','asset','debit'],['1600','Asset clearing','asset','debit'],['1610','Disposal clearing','asset','debit'],['1700','Equipment','asset','debit'],['1710','Accumulated depreciation','asset','debit'],['2100','Payables','liability','credit'],['2300','Withholding payable','liability','credit'],['4300','Gain on disposal','income','credit'],['6100','Depreciation expense','expense','debit'],['6300','Loss on disposal','expense','debit']])accounts[code]=(await tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id",[tenantId,entityId,bookId,code,name,category,side,code==='2100'?'ap':code==='1300'?'input_tax':'none',!['2100','1300'].includes(code),sha(code),principals.controller])).rows[0].id;
  periodId=(await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4) returning id",[tenantId,entityId,bookId,principals.controller])).rows[0].id;
  period2Id=(await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-11-01','2026-11-30',$4) returning id",[tenantId,entityId,bookId,principals.controller])).rows[0].id;
  const dir={...await identity.actorContext(tx,tenantId,principals.director),traceId:'setup'};
  const settle=async(kind,payload)=>{const s=await organization.saveSettings(tx,ctrl,entityId,kind,payload);await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});};
  await settle('purchasing_profile',{apAccountId:accounts['2100'],inputTaxAccountId:accounts['1300'],cashAccountId:accounts['1010'],withholdingPayableAccountId:accounts['2300'],advanceAccountId:accounts['1400'],withholdingRecognition:'accrual',scale:2,dueDays:30,requirePurchaseOrder:false,requireReceiptOfService:false,nonPoAccountIds:[],duplicateWindowDays:7,expensePolicyVersion:'expense-2026',supplierWithholding:{}});
  await settle('asset_profile',{assetClearingAccountId:accounts['1600'],disposalClearingAccountId:accounts['1610'],profileVersion:'assets-2026'});
  await settle('recognition_policy_dep_monthly',{code:'dep_monthly',kind:'depreciation',proration:'monthly'});
  await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'bill','BILL','numbering-2026',$4)",[tenantId,entityId,branchId,principals.controller]);
  const fixedCtx={...await identity.actorContext(tx,tenantId,principals.fixed),traceId:'setup'},clerkCtx={...await identity.actorContext(tx,tenantId,principals.clerk),traceId:'setup'},accCtx={...await identity.actorContext(tx,tenantId,principals.accountant),traceId:'setup'};
  const pdf=Buffer.from('%PDF-1.4 delivery receipt\n');const store=new evidence.MemoryEvidenceStore();
  const reg=await evidence.registerUpload(tx,fixedCtx,entityId,{filename:'delivery.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'internal'});
  await evidence.completeUpload(tx,fixedCtx,entityId,reg.evidenceId,pdf,store);
  await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);
  evidenceId=reg.evidenceId;
  const party=await parties.createParty(tx,clerkCtx,entityId,{legalName:'Machines Inc',roles:['supplier'],identityStatus:'unknown',address:'Laguna'},{FIELD_ENCRYPTION_KEY:fieldKey});
  const bill=await purchasing.createDocument(tx,clerkCtx,entityId,{kind:'bill',branchId,bookId,partyId:party.id,documentDate:'2026-10-05',accountingDate:'2026-10-05',currency:'PHP',ruleProfileVersion:'ph-2026',externalReference:'MI-1',lines:[{description:'Packing machine',quantity:'1',unitPrice:'120000',discount:'0',priceBasis:'exclusive',accountId:accounts['1600'],dimensions:{}}],evidenceIds:[evidenceId]});
  await purchasing.submitDocument(tx,clerkCtx,entityId,bill.id,{});await purchasing.approveDocument(tx,accCtx,entityId,bill.id,{decision:'approve',contentVersion:1});await purchasing.postDocument(tx,accCtx,entityId,bill.id,{});
  billId=bill.id;
  classId=(await assets.createAssetClass(tx,accCtx,entityId,{code:'EQUIP',name:'Equipment',assetAccountId:accounts['1700'],accumulatedDepreciationAccountId:accounts['1710'],depreciationExpenseAccountId:accounts['6100'],disposalGainAccountId:accounts['4300'],disposalLossAccountId:accounts['6300'],defaultMethod:'straight_line',defaultUsefulLifeMonths:60,taxMethod:'declining_balance',taxUsefulLifeMonths:36})).id;
 });
 const eh={'x-entity-id':entityId};
 worker=start('apps/worker/src/main.mjs');
 // The register.
 const body={tag:'EQ-1',classId,cost:'120000',residual:'0',currency:'PHP',inServiceDate:'2026-10-01',usefulLifeMonths:60,method:'straight_line',sourceDocumentId:billId};
 let r=await call('auditor','POST','/assets',{body,headers:{...key(),...eh}});assert.equal(r.status,403,'the examiner creates nothing');
 r=await call('fixed','POST','/assets',{body:{...body,cost:'120001'},headers:{...key(),...eh}});assert.equal(r.status,422,'cost beyond the bill');
 r=await call('fixed','POST','/assets',{body,headers:{...key(),...eh}});const asset=await must(r,201);contract('post_assets',asset);assert.equal(asset.state,'draft');
 r=await call('fixed','PATCH','/assets/'+asset.id,{body:{...body,tag:'EQ-1A'},headers:{...eh,...im(asset.version)}});const edited=await must(r,200);contract('patch_assets_id',edited);assert.equal(edited.tag,'EQ-1A');assert.equal(edited.contentVersion,2);
 r=await call('fixed','PATCH','/assets/'+asset.id,{body,headers:{...eh,...im(asset.version)}});assert.equal(r.status,412,'stale If-Match');
 r=await call('auditor','GET','/asset-classes',{headers:eh});const classes=await must(r,200);contract('get_asset_classes',classes);assert.equal(classes.items[0].code,'EQUIP');
 r=await call('auditor','GET','/assets',{headers:eh});const list=await must(r,200);contract('get_assets',list);assert.equal(list.items.length,1);
 r=await call('auditor','GET','/assets/'+asset.id,{headers:eh});contract('get_assets_id',await must(r,200));
 r=await call('fixed','POST','/assets/'+asset.id+'/approve',{body:{decision:'approve',contentVersion:2},headers:{...key(),...eh,...im(edited.version)}});assert.equal(r.status,403,'the preparer role holds no approval');
 r=await call('accountant','POST','/assets/'+asset.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(edited.version)}});assert.equal(r.status,412,'stale content version');
 r=await call('accountant','POST','/assets/'+asset.id+'/approve',{body:{decision:'approve',contentVersion:2},headers:{...key(),...eh,...im(edited.version)}});const approved=await must(r,200);contract('post_assets_id_approve',approved);assert.equal(approved.state,'approved');assert.equal(approved.journalEntryIds.length,1,'capitalization posted');
 r=await call('auditor','GET','/assets/'+asset.id+'/events',{headers:eh});const ev0=await must(r,200);contract('get_assets_id_events',ev0);assert.equal(ev0.capitalizedEntryId,approved.journalEntryIds[0]);assert.equal(ev0.carryingAmount,'120000.00');
 pass('assets over HTTP: drafted from the posted bill by the clerk (cost within the bill), edited with If-Match, refused to the examiner and the preparer role, approved by the accountant with the capitalization entry, classes and register listed and read');
 // The schedule: preview, approval, execution by the worker.
 const sbody={kind:'depreciation',sourceId:asset.id,startDate:'2026-10-01',endDate:'2031-09-30',basisAmount:'120000',currency:'PHP',policyVersion:'dep_monthly'};
 r=await call('fixed','POST','/schedules',{body:{...sbody,policyVersion:'no_such'},headers:{...key(),...eh}});assert.equal(r.status,409,'an unapproved policy');
 r=await call('fixed','POST','/schedules',{body:sbody,headers:{...key(),...eh}});const sched=await must(r,201);contract('post_schedules',sched);assert.equal(sched.state,'draft');
 r=await call('auditor','GET','/schedules/'+sched.id+'/lines',{headers:eh});let lines=await must(r,200);contract('get_schedules_id_lines',lines);assert.equal(lines.lines.length,60);assert.equal(lines.lines[0].amount,'2000.00');assert.equal(lines.totalPlanned,'120000.00');
 r=await call('fixed','PATCH','/schedules/'+sched.id,{body:{...sbody,endDate:'2029-09-30'},headers:{...eh,...im(sched.version)}});assert.equal(r.status,422,'a draft depreciation schedule follows the asset life');
 r=await call('fixed','PATCH','/schedules/'+sched.id,{body:sbody,headers:{...eh,...im(sched.version)}});const s3=await must(r,200);contract('patch_schedules_id',s3);assert.equal(s3.contentVersion,2);
 r=await call('auditor','GET','/schedules/'+sched.id+'/lines',{headers:eh});lines=await must(r,200);assert.equal(lines.lines.length,60,'the draft was regenerated');assert.equal(lines.versions.length,2);
 r=await call('accountant','POST','/schedule-runs',{body:{periodId,scheduleIds:[sched.id]},headers:{...key(),...eh}});assert.equal(r.status,409,'a draft schedule does not run');
 r=await call('fixed','POST','/schedules/'+sched.id+'/approve',{body:{decision:'approve',contentVersion:s3.contentVersion},headers:{...key(),...eh,...im(s3.version)}});assert.equal(r.status,403);
 r=await call('accountant','POST','/schedules/'+sched.id+'/approve',{body:{decision:'approve',contentVersion:s3.contentVersion},headers:{...key(),...eh,...im(s3.version)}});const sa=await must(r,200);contract('post_schedules_id_approve',sa);assert.equal(sa.state,'approved');
 r=await call('auditor','GET','/schedules',{headers:eh});const slist=await must(r,200);contract('get_schedules',slist);assert.equal(slist.items.length,1);
 r=await call('auditor','GET','/schedules/'+sched.id,{headers:eh});contract('get_schedules_id',await must(r,200));
 r=await call('fixed','POST','/schedule-runs',{body:{periodId,scheduleIds:[sched.id]},headers:{...key(),...eh}});assert.equal(r.status,403,'execution is an explicit authority');
 r=await call('accountant','POST','/schedule-runs',{body:{periodId,scheduleIds:[sched.id]},headers:{...key(),...eh}});const job=await must(r,202);contract('post_schedule_runs',job);
 await waitFor(async()=>['succeeded','failed','dead_letter'].includes((await json(await call('accountant','GET','/jobs/'+job.id,{headers:eh}))).state),'schedule run job',60000);
 assert.equal((await json(await call('accountant','GET','/jobs/'+job.id,{headers:eh}))).state,'succeeded',worker?.log().split('\n').slice(-6).join('\n'));
 r=await call('auditor','GET','/schedule-runs',{headers:eh});const runs=await must(r,200);contract('get_schedule_runs',runs);assert.equal(runs.items[0].state,'completed');assert.equal(runs.items[0].results[0].outcome,'posted');
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 const entry=(await api.query('select a.code,l.txn_debit::text as d,l.txn_credit::text as c from lara.journal_lines l join lara.accounts a on a.tenant_id=l.tenant_id and a.id=l.account_id where l.tenant_id=$1 and l.entry_id=$2 order by l.line_no',[tenantId,runs.items[0].results[0].entryId])).rows;
 assert.deepEqual(entry.map(x=>x.code+' '+Number(x.d)+' '+Number(x.c)),['6100 2000 0','1710 0 2000'],'AC-08 through the worker');
 r=await call('accountant','POST','/schedule-runs',{body:{periodId,scheduleIds:[sched.id]},headers:{...key(),...eh}});const job2=await must(r,202);
 await waitFor(async()=>['succeeded','failed','dead_letter'].includes((await json(await call('accountant','GET','/jobs/'+job2.id,{headers:eh}))).state),'rerun job',60000);
 r=await call('auditor','GET','/schedule-runs',{headers:eh});const runs2=await must(r,200);assert.equal(runs2.items[1].results[0].outcome,'already_executed','a rerun posts nothing');
 assert.equal((await api.query("select count(*)::int as n from lara.journal_entries where tenant_id=$1 and source_type='schedule_line'",[tenantId])).rows[0].n,1);
 r=await call('auditor','GET','/schedules/'+sched.id+'/lines',{headers:eh});lines=await must(r,200);assert.equal(lines.lines[0].state,'posted');assert.equal(lines.totalExecuted,'2000.00');
 r=await call('auditor','GET','/assets/'+asset.id+'/layers',{headers:eh});const layers=await must(r,200);contract('get_assets_id_layers',layers);assert.equal(layers.layers.length,1);assert.equal(layers.layers[0].taxDepreciation,'6666.67');
 pass('a depreciation schedule over HTTP: refused without an approved policy, previewed through the lines read (60 × 2,000), redrafted, approved by another role, executed by the worker from POST /schedule-runs (202) posting AC-08 once, the rerun posting nothing, the run calendar and the book/tax layers read');
 // Events, pause, report.
 const av=(await must(await call('auditor','GET','/assets/'+asset.id,{headers:eh}),200)).version;
 r=await call('fixed','POST','/assets/'+asset.id+'/events',{body:{kind:'impairment',effectiveDate:'2026-11-01',amount:'18000',reason:'Damage',evidenceIds:[evidenceId]},headers:{...key(),...eh,...im(av)}});assert.equal(r.status,403);
 r=await call('accountant','POST','/assets/'+asset.id+'/events',{body:{kind:'impairment',effectiveDate:'2026-11-01',amount:'18000',reason:'Damage assessed',evidenceIds:[randomUUID()]},headers:{...key(),...eh,...im(av)}});assert.equal(r.status,409,'evidence must be available');
 r=await call('accountant','POST','/assets/'+asset.id+'/events',{body:{kind:'impairment',effectiveDate:'2026-11-01',amount:'18000',reason:'Damage assessed',evidenceIds:[evidenceId]},headers:{...key(),...eh,...im(av)}});const imp=await must(r,200);contract('post_assets_id_events',imp);assert.equal(imp.journalEntryIds.length,1);
 r=await call('auditor','GET','/assets/'+asset.id+'/events',{headers:eh});const ev=await must(r,200);assert.equal(ev.events.length,1);assert.equal(ev.events[0].kind,'impairment');assert.equal(ev.carryingAmount,'100000.00');
 r=await call('auditor','GET','/schedules/'+sched.id+'/lines',{headers:eh});lines=await must(r,200);assert.equal(lines.versions.length,3);assert.equal(lines.totalPlanned,'100000.00','the open periods regenerate prospectively');
 const cur=await must(await call('auditor','GET','/schedules/'+sched.id,{headers:eh}),200);
 r=await call('accountant','POST','/schedules/'+sched.id+'/pause',{body:{reason:'Under review'},headers:{...key(),...eh,...im(cur.version)}});const paused=await must(r,200);contract('post_schedules_id_pause',paused);assert.equal(paused.state,'paused');
 r=await call('accountant','POST','/schedule-runs',{body:{periodId:period2Id,scheduleIds:[sched.id]},headers:{...key(),...eh}});const job3=await must(r,202);
 await waitFor(async()=>['succeeded','failed','dead_letter'].includes((await json(await call('accountant','GET','/jobs/'+job3.id,{headers:eh}))).state),'paused run job',60000);
 r=await call('auditor','GET','/schedule-runs',{headers:eh});assert.equal((await must(r,200)).items[2].results[0].outcome,'paused');
 r=await call('fixed','POST','/reports',{body:{reportType:'asset_register',bookId,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:new Date().toISOString(),format:'json'},headers:{...key(),...eh}});const rj=await must(r,202);
 await waitFor(async()=>['succeeded','failed'].includes((await json(await call('fixed','GET','/jobs/'+rj.id,{headers:eh}))).state),'register report job',60000);
 assert.equal((await json(await call('fixed','GET','/jobs/'+rj.id,{headers:eh}))).state,'succeeded',worker?.log().split('\n').slice(-6).join('\n'));
 pass('an impairment event over HTTP needs the events authority and available evidence, posts once, shows in the events read with the carrying amount and regenerates the open periods; pause holds the run; the asset_register report renders through the worker');
 // Isolation and later-phase gate.
 r=await call('auditor','GET','/assets/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('auditor','GET','/schedules/'+sched.id,{headers:{'x-entity-id':randomUUID()}});assert.equal(r.status,404);
 r=await call('auditor','GET','/assets/'+asset.id+'/layers',{headers:{'x-entity-id':randomUUID()}});assert.equal(r.status,404);
 r=await call('auditor','POST','/packs/install',{body:{},headers:{...key(),...eh}});assert.ok([404,409].includes(r.status),'later-phase operations stay gated');
 pass('unknown records and foreign entities answer 404; later-phase operations stay gated');
 console.log('P11-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-40).join(String.fromCharCode(10)));console.error(worker?.log().split(String.fromCharCode(10)).slice(-8).join(String.fromCharCode(10))||'');throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
