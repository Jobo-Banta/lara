// P08-03 HTTP acceptance: institution coexistence through the API and worker
// as processes. Source ownership over the reviewed operations (creation,
// edit, independent approval, list and read); the canonical feed through the
// import pipeline (staging, validation with the error workbench, approval,
// commit posting once, duplicates and checksum conflicts); mapping versions,
// batches, rows and expected batches over the read operations; feed
// reconciliation, branch roll-up, the institution tax worksheet and their
// report snapshots; and isolation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,evidence,fi,evidenceStoreFromEnv} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4031,BASE='http://127.0.0.1:'+PORT,bucket='.local/p08-api-test-'+randomBytes(3).toString('hex');
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
const FI_PERMS=['source_ownership.create','source_ownership.edit','source_ownership.read','import.create','import.validate','import.read','import.edit','evidence.upload','evidence.read','tax_rule.read','account.read','book.read','branch.read','journal.read','period.read','report.generate','job.read'];
const apiProcess=start('apps/api/src/server.mjs');let worker=null;
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 let entityId,bookId,evidenceId,systemId;const accounts={};const branches={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-fi-'+suffix,name:'Institution API',mode:'demo'});
  for(const n of ['officer','tax','controller','director','auditor','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['tax','controller','auditor','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  roles.fi=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'fi_officer','Institution officer',$2,'approved',$3,$4) returning id",[tenantId,JSON.stringify(FI_PERMS),sha('fi'),principals.security])).rows[0].id;
  for(const [p,r] of [['officer','fi'],['tax','tax'],['controller','controller'],['director','controller'],['auditor','auditor'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Pilot Rural Bank',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  for(const [code,name] of [['HQ','Head office'],['BR1','Branch one']])branches[code]=(await organization.createBranch(tx,ctrl,entityId,{code,name,address:'Makati'})).id;
  for(const c of ['workspace','general_ledger','sales','purchasing','treasury','compliance','fi_coexistence'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.director,principals.controller]);
  bookId=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,principals.controller])).rows[0].id;
  for(const [code,name,category,side] of [['1010','Cash','asset','debit'],['1300','Loans','asset','debit'],['1900','Due from branches','asset','debit'],['2900','Due to branches','liability','credit'],['4100','Interest income','income','credit']])accounts[code]=(await tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,'none',true,$8,$9) returning id",[tenantId,entityId,bookId,code,name,category,side,sha(code),principals.controller])).rows[0].id;
  await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4)",[tenantId,entityId,bookId,principals.controller]);
  const dir={...await identity.actorContext(tx,tenantId,principals.director),traceId:'setup'};
  const s=await organization.saveSettings(tx,ctrl,entityId,'fi_profile',{dueFromAccountId:accounts['1900'],dueToAccountId:accounts['2900'],instrumentRules:[{incomeCategory:'interest_income',instrumentType:'loan',maxMaturityYears:5,ruleCode:'GRT5'}],profileVersion:'fi-2026'});
  await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});
  const pdf=Buffer.from('%PDF-1.4 signed feed matrix\n');const store=new evidence.MemoryEvidenceStore();
  const off={...await identity.actorContext(tx,tenantId,principals.officer),traceId:'setup'};
  const reg=await evidence.registerUpload(tx,off,entityId,{filename:'feed-matrix.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'internal'});
  await evidence.completeUpload(tx,off,entityId,reg.evidenceId,pdf,store);
  await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);
  evidenceId=reg.evidenceId;
  await tx.query("insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,content_hash,created_by,status,approved_by,activated_by,activated_at) values($1,$2,'GRT5',1,'grt','2026-01-01',0.05,'instrument','profile_event','line_half_up',gen_random_uuid(),$3,'[\"GRT-5Y\"]',$4,$5,'active',$6,$6,now())",[tenantId,entityId,JSON.stringify([evidenceId]),sha('grt'),principals.tax,principals.controller]);
  systemId=(await fi.createSourceSystem(tx,off,entityId,{code:'CBS',name:'Core banking',ownerName:'IT operations',granularity:'detail'})).id;
 });
 const eh={'x-entity-id':entityId};
 worker=start('apps/worker/src/main.mjs');
 const uploadCsv=async(name,text,who='officer')=>{const bytes=Buffer.from(text);const reg=await must(await call(who,'POST','/evidence/uploads',{body:{filename:name,mime:'text/csv',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'},headers:{...key(),...eh}}),201);await call(who,'PUT','/evidence/'+reg.evidenceId+'/content',{raw:bytes,headers:{...eh,'content-type':'text/csv'}});const c=await call(who,'POST','/evidence/'+reg.evidenceId+'/complete',{body:{},headers:{...key(),...eh,...im(reg.version)}});assert.equal(c.status,202,await c.text());await waitFor(async()=>(await json(await call(who,'GET','/evidence/'+reg.evidenceId,{headers:eh}))).state==='available','scan',60000);return reg.evidenceId;};
 // Source ownership over the reviewed operations.
 let r=await call('auditor','POST','/source-ownership',{body:{sourceSystem:'CBS',bookId,transactionFamily:'journal',effectiveFrom:'2026-01-01',evidenceIds:[evidenceId]},headers:{...key(),...eh}});assert.equal(r.status,403,'examiner scope is read-only');
 r=await call('officer','POST','/source-ownership',{body:{sourceSystem:'CBS',bookId,transactionFamily:'journal',effectiveFrom:'2026-01-01',evidenceIds:[evidenceId]},headers:{...key(),...eh}});const own=await must(r,201);contract('post_source_ownership',own);assert.equal(own.state,'draft');
 r=await call('officer','PATCH','/source-ownership/'+own.id,{body:{sourceSystem:'CBS',bookId,transactionFamily:'journal',effectiveFrom:'2026-01-01',effectiveTo:'2027-12-31',evidenceIds:[evidenceId]},headers:{...eh,...im(own.version)}});const edited=await must(r,200);contract('patch_source_ownership_id',edited);assert.equal(edited.effectiveTo,'2027-12-31');
 r=await call('officer','POST','/source-ownership/'+own.id+'/approve',{body:{decision:'approve',contentVersion:edited.contentVersion},headers:{...key(),...eh,...im(edited.version)}});assert.equal(r.status,403);
 r=await call('controller','POST','/source-ownership/'+own.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(edited.version)}});assert.equal(r.status,412,'stale content version');
 r=await call('controller','POST','/source-ownership/'+own.id+'/approve',{body:{decision:'approve',contentVersion:edited.contentVersion},headers:{...key(),...eh,...im(edited.version)}});const approved=await must(r,200);contract('post_source_ownership_id_approve',approved);assert.equal(approved.state,'approved');
 r=await call('auditor','GET','/source-ownership',{headers:eh});const owns=await must(r,200);contract('get_source_ownership',owns);assert.equal(owns.items.length,1);
 r=await call('auditor','GET','/source-ownership/'+own.id,{headers:eh});const one=await must(r,200);contract('get_source_ownership_id',one);assert.equal(one.state,'approved');
 r=await call('auditor','GET','/source-systems',{headers:eh});const systems=await must(r,200);contract('get_source_systems',systems);assert.equal(systems.items[0].code,'CBS');
 pass('source ownership over HTTP: created from evidence by the officer, edited while draft, approved by the controller against the content version, listed and read by the examiner who cannot write');
 // Mapping version (domain import; no contract operation) and its reads.
 const mapEv=await uploadCsv('cbs-map.csv',['source_account,target_account_code,dimensions,tax_profile','100100,1010,,','130100,1300,,','190100,1900,,','290100,2900,,','410100,4100,,interest_income'].join('\n')+'\n');
 let mappingId;
 await inTransaction(api,{tenantId,principalId:principals.officer},async tx=>{const off={...await identity.actorContext(tx,tenantId,principals.officer),traceId:'setup'};const store=evidenceStoreFromEnv(env);const m=await fi.importMappingVersion(tx,off,entityId,{sourceSystemId:systemId,bookId,versionLabel:'cbs-v1',evidenceId:mapEv},{store});mappingId=m.id;const ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};await fi.approveMappingVersion(tx,ctrl,entityId,m.id);});
 r=await call('auditor','GET','/mapping-versions?sourceSystemId='+systemId,{headers:eh});const mvs=await must(r,200);contract('get_mapping_versions',mvs);assert.deepEqual([mvs.items.length,mvs.items[0].state,mvs.items[0].lineCount],[1,'approved',5]);
 r=await call('auditor','GET','/mapping-versions/'+mappingId+'/lines',{headers:eh});const ml=await must(r,200);contract('get_mapping_versions_id_lines',ml);assert.equal(ml.lines.length,5);
 pass('mapping versions and their lines are read over HTTP with contract shapes');
 // The feed calendar expects an October journal batch and an October balance batch (already overdue).
 await inTransaction(api,{tenantId,principalId:principals.officer},async tx=>{const off={...await identity.actorContext(tx,tenantId,principals.officer),traceId:'setup'};await fi.expectBatch(tx,off,entityId,{sourceSystemId:systemId,bookId,kind:'journal',periodStart:'2026-10-01',periodEnd:'2026-10-31',deadlineAt:'2026-11-03T00:00:00Z'});await fi.expectBatch(tx,off,entityId,{sourceSystemId:systemId,bookId,kind:'source_balances',periodStart:'2026-10-01',periodEnd:'2026-10-31',deadlineAt:'2026-09-01T00:00:00Z'});});
 // The canonical feed through the import pipeline.
 const feed=(id,rows,{count=null}={})=>{const header='external_line_id,accounting_date,book_code,branch_code,account_code,currency,debit,credit,source_document_ref,dimensions,tax_event_ref,instrument_ref,instrument_type,maturity_date,income_category';const data=rows.map((x,i)=>[id+'-'+(i+1),x.date,'MAIN',x.branch,x.account,'PHP',x.debit||'0',x.credit||'0',x.ref||'DOC-'+i,x.dims||'',x.taxRef||'',x.instrument||'',x.type||'',x.maturity||'',x.category||''].join(','));const d=rows.reduce((t,x)=>t+Number(x.debit||0),0).toFixed(2),c=rows.reduce((t,x)=>t+Number(x.credit||0),0).toFixed(2);return [header,...data,['MANIFEST','','','','count='+(count??rows.length)+';sha256='+sha(data.join('\n')),'',d,c,'','','','','','',''].join(',')].join('\n')+'\n';};
 const b1csv=feed('B1',[{date:'2026-10-05',branch:'BR1',account:'130100',debit:'100000.00',ref:'LN-1'},{date:'2026-10-05',branch:'BR1',account:'100100',credit:'100000.00',ref:'LN-1'},{date:'2026-10-05',branch:'BR1',account:'100100',debit:'5000.00',ref:'INT-1'},{date:'2026-10-05',branch:'BR1',account:'410100',credit:'5000.00',ref:'INT-1',instrument:'LN-1',type:'loan',maturity:'2029-10-05',category:'interest_income'},{date:'2026-10-05',branch:'HQ',account:'190100',debit:'1000.00',dims:'counter_branch=BR1'},{date:'2026-10-05',branch:'HQ',account:'100100',credit:'1000.00'},{date:'2026-10-05',branch:'BR1',account:'100100',debit:'1000.00'},{date:'2026-10-05',branch:'BR1',account:'290100',credit:'1000.00',dims:'counter_branch=HQ'}]);
 const b1ev=await uploadCsv('B1.csv',b1csv);
 const importBody=(ev,ext,mapping='cbs-v1',kind='journal')=>({kind,evidenceId:ev,mappingVersion:mapping,sourceId:'CBS',externalBatchId:ext,cutoffDate:'2026-10-31'});
 r=await call('officer','POST','/imports',{body:importBody(b1ev,'B1','cbs-v9'),headers:{...key(),...eh}});assert.equal(r.status,422,'unapproved mapping version');
 r=await call('officer','POST','/imports',{body:importBody(b1ev,'B1'),headers:{...key(),...eh}});const imp=await must(r,201);contract('post_imports',imp);assert.equal(imp.state,'staged');
 r=await call('officer','POST','/imports/'+imp.id+'/validate',{body:{},headers:{...key(),...eh,...im(imp.version)}});const val=await must(r,200);contract('post_imports_id_validate',val);assert.equal(val.state,'validated');
 r=await call('auditor','GET','/source-batches?sourceSystemId='+systemId,{headers:eh});let sbs=await must(r,200);contract('get_source_batches',sbs);const sb1=sbs.items.find(b=>b.externalBatchId==='B1');assert.deepEqual([sb1.state,sb1.rowCount,sb1.errorCount,sb1.debitTotal],['validated',8,0,'107000.00']);
 r=await call('controller','POST','/imports/'+imp.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(val.version)}});const app=await must(r,200);assert.equal(app.state,'approved');
 r=await call('controller','POST','/imports/'+imp.id+'/commit',{body:{},headers:{...key(),...eh,...im(app.version)}});const com=await must(r,200);contract('post_imports_id_commit',com);assert.deepEqual([com.state,com.journalEntryIds.length],['committed',1]);
 // Duplicates and conflicts.
 for(let i=0;i<5;i++){r=await call('officer','POST','/imports',{body:importBody(b1ev,'B1'),headers:{...key(),...eh}});const again=await must(r,201);assert.equal(again.id,imp.id,'the same batch returns the one import');}
 r=await call('auditor','GET','/source-batches?state=posted',{headers:eh});sbs=await must(r,200);assert.deepEqual([sbs.items.length,sbs.items[0].duplicateCount,!!sbs.items[0].postedEntryId],[1,5,true]);
 const b1bEv=await uploadCsv('B1b.csv',feed('B1',[{date:'2026-10-05',branch:'BR1',account:'130100',debit:'1.00'},{date:'2026-10-05',branch:'BR1',account:'100100',credit:'1.00'}]));
 r=await call('officer','POST','/imports',{body:importBody(b1bEv,'B1'),headers:{...key(),...eh}});assert.equal(r.status,409);assert.equal((await json(r)).code,'DUPLICATE_SOURCE');
 // Error workbench: a manifest mismatch stays staged with its rows.
 const b2ev=await uploadCsv('B2.csv',feed('B2',[{date:'2026-10-06',branch:'HQ',account:'100100',debit:'700.00'},{date:'2026-10-06',branch:'HQ',account:'999999',credit:'700.00'}],{count:3}));
 r=await call('officer','POST','/imports',{body:importBody(b2ev,'B2'),headers:{...key(),...eh}});const imp2=await must(r,201);
 r=await call('officer','POST','/imports/'+imp2.id+'/validate',{body:{},headers:{...key(),...eh,...im(imp2.version)}});const val2=await must(r,200);assert.equal(val2.state,'staged');
 r=await call('controller','POST','/imports/'+imp2.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(val2.version)}});assert.equal(r.status,409,'staged batches are not approved');
 r=await call('auditor','GET','/source-batches?state=staged',{headers:eh});sbs=await must(r,200);const sb2=sbs.items.find(b=>b.externalBatchId==='B2');assert.ok(sb2.errorCount>=2,'row and manifest errors counted');
 r=await call('auditor','GET','/source-batches/'+sb2.id+'/rows?status=error',{headers:eh});const rows=await must(r,200);contract('get_source_batches_id_rows',rows);assert.deepEqual(rows.items.map(x=>x.error),['unmapped source account 999999']);
 pass('the canonical feed stages through POST /imports under ownership and mapping checks, validates, is approved by the controller and posts once; the same batch returns the one import with its duplicate count, a changed checksum answers DUPLICATE_SOURCE, and a manifest or mapping error stays staged with its rows on the workbench');
 // Expected batches, reconciliation, roll-up, worksheet and their snapshots.
 r=await call('auditor','GET','/expected-batches',{headers:eh});const exp=await must(r,200);contract('get_expected_batches',exp);assert.deepEqual(exp.items.map(e=>[e.kind,e.state]).sort(),[['journal','received'],['source_balances','missing']]);
 r=await call('auditor','GET','/feed-reconciliation?bookId='+bookId+'&asOf=2026-10-31',{headers:eh});const rec=await must(r,200);contract('get_feed_reconciliation',rec);assert.deepEqual([rec.sourceSystems[0].code,rec.sourceSystems[0].accounts.length,rec.expected.length],['CBS',0,2]);
 r=await call('auditor','GET','/branch-rollup?bookId='+bookId+'&periodStart=2026-10-01&periodEnd=2026-10-31',{headers:eh});const roll=await must(r,200);contract('get_branch_rollup',roll);assert.deepEqual([roll.pairs.length,roll.pairs[0].state,roll.rollup.eliminated,roll.rollupId],[1,'cancels','1000.00',null]);
 r=await call('tax','GET','/institution-tax-worksheet?periodStart=2026-10-01&periodEnd=2026-10-31',{headers:eh});const ws=await must(r,200);contract('get_institution_tax_worksheet',ws);assert.deepEqual([ws.rows.length,ws.rows[0].ruleCode,ws.rows[0].tax,ws.unclassified.length],[1,'GRT5','250.00',0]);
 r=await call('officer','GET','/institution-tax-worksheet?periodStart=2026-10-01&periodEnd=2026-10-31',{headers:eh});assert.equal(r.status,200,'tax_rule.read reads the worksheet');
 r=await call('controller','POST','/reports',{body:{reportType:'branch_rollup',bookId,periodStart:'2026-10-01',periodEnd:'2026-10-31',asOf:new Date().toISOString(),format:'json'},headers:{...key(),...eh}});const rj=await must(r,202);
 await waitFor(async()=>['succeeded','failed'].includes((await json(await call('controller','GET','/jobs/'+rj.id,{headers:eh}))).state),'roll-up report job',60000);
 const done=await json(await call('controller','GET','/jobs/'+rj.id,{headers:eh}));assert.equal(done.state,'succeeded',worker?.log().split('\n').slice(-6).join('\n'));
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 assert.equal((await api.query('select count(*)::int n from lara.branch_rollups where tenant_id=$1',[tenantId])).rows[0].n,1,'the report snapshot records the roll-up manifest');
 pass('expected batches, feed reconciliation, the branch roll-up and the institution tax worksheet are read over HTTP with contract shapes; the branch_rollup report job records the immutable manifest');
 // Isolation and later-phase gate.
 r=await call('officer','GET','/source-ownership/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('officer','GET','/source-ownership/'+own.id,{headers:{'x-entity-id':randomUUID()}});assert.equal(r.status,404);
 r=await call('officer','GET','/source-batches/'+randomUUID()+'/rows',{headers:eh});assert.equal(r.status,404);
 r=await call('officer','GET','/mapping-versions/'+mappingId+'/lines?againstId='+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('officer','POST','/packs/install',{body:{packId:'retail-ph',version:'1.0.0',manifestHash:'0'.repeat(64),evidenceIds:['00000000-0000-4000-8000-000000000001']},headers:{...key(),...eh}});assert.ok([403,404,409].includes(r.status),'later-phase operations stay gated or refused for the caller');
 pass('unknown records and foreign entities answer 404; later-phase operations stay gated');
 console.log('P08-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-60).join(String.fromCharCode(10)));console.error(worker?.log().split(String.fromCharCode(10)).slice(-8).join(String.fromCharCode(10))||'');throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
