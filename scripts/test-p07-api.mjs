// P07-03 HTTP acceptance: compliance operations through the API and worker
// as processes. Return run through creation, preparation from the reviewed
// mapping artifact, independent approval, filing with evidence and the lines
// read; a reporting-required issuance transmitted by the worker with the
// fixture transport, a lost acknowledgement reconciled by status query, an
// envelope rejection retried as a new payload version, a financial rejection
// refused; the registration pack job; and isolation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,parties,evidence,compliance} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4030,BASE='http://127.0.0.1:'+PORT,bucket='.local/p07-api-test-'+randomBytes(3).toString('hex');
const fieldKey=process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex');
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:fieldKey,WORKER_POLL_MS:'200',RATE_LIMIT_WRITES_PER_MINUTE:'1000',RATE_LIMIT_READS_PER_MINUTE:'5000',MAIL_ADAPTER:'local',EINVOICE_ADAPTER:'fixture',TEST_EINVOICE_KEY:'test-signing-key',TEST_EINVOICE_CREDENTIALS:'123-456-789-000:secret'};
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
 let entityId,branchId,bookId,customerId,evidenceId,vatId,profileId;const accounts={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-comp-'+suffix,name:'Compliance API',mode:'demo'});
  for(const n of ['billing','accountant','tax','controller','director','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['billing','accountant','tax','controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  for(const [p,r] of [['billing','billing'],['accountant','accountant'],['tax','tax'],['controller','controller'],['director','controller'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Compliance API Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  branchId=(await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'})).id;
  for(const c of ['workspace','general_ledger','sales','purchasing','treasury','compliance'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.director,principals.controller]);
  bookId=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,principals.controller])).rows[0].id;
  for(const [code,name,category,control] of [['1010','Cash','asset','none'],['1200','Receivables','asset','ar'],['2200','Output tax','liability','output_tax'],['4000','Revenue','income','none']])accounts[code]=(await tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id",[tenantId,entityId,bookId,code,name,category,category==='asset'?'debit':'credit',control,control==='none',sha(code),principals.accountant])).rows[0].id;
  await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-09-01','2026-09-30',$4)",[tenantId,entityId,bookId,principals.controller]);
  await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4)",[tenantId,entityId,branchId,principals.controller]);
  const dir={...await identity.actorContext(tx,tenantId,principals.director),traceId:'setup'};
  for(const [kind,payload] of [['sales_profile',{arAccountId:accounts['1200'],outputTaxAccountId:accounts['2200'],cashAccountId:accounts['1010'],scale:2,dueDays:30,reportingRequired:true}],['compliance_profile',{jurisdiction:'PH',taxpayerId:'123-456-789-000',transport:'fixture',destination:'fixture-authority',deadlineHours:72,signingKeyRef:'TEST_EINVOICE_KEY',credentialsRef:'TEST_EINVOICE_CREDENTIALS',profileVersion:'compliance-2026'}]]){const s=await organization.saveSettings(tx,ctrl,entityId,kind,payload);await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});}
  const clerk={...await identity.actorContext(tx,tenantId,principals.billing),traceId:'setup'};
  customerId=(await parties.createParty(tx,clerk,entityId,{legalName:'Acme Trading',roles:['customer'],identityStatus:'unknown',address:'Cebu'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  const pdf=Buffer.from('%PDF-1.4 regulation\n');const store=new evidence.MemoryEvidenceStore();
  const taxCtx={...await identity.actorContext(tx,tenantId,principals.tax),traceId:'setup'};
  const reg=await evidence.registerUpload(tx,taxCtx,entityId,{filename:'rr.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'internal'});
  await evidence.completeUpload(tx,taxCtx,entityId,reg.evidenceId,pdf,store);
  await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);
  evidenceId=reg.evidenceId;
  vatId=(await tx.query("insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,content_hash,created_by,status,approved_by,activated_by,activated_at) values($1,$2,'VAT12',1,'vat','2026-01-01',0.12,'net','issue','line_half_up',gen_random_uuid(),$3,'[\"AC-01\"]',$4,$5,'active',$6,$6,now()) returning id",[tenantId,entityId,JSON.stringify([evidenceId]),sha('vat'),principals.tax,principals.controller])).rows[0].id;
  // Regulatory profile approved and activated (domain functions; no contract operations for them yet).
  const rp=await compliance.createRegulatoryProfile(tx,taxCtx,entityId,{jurisdiction:'PH',coverage:['2550Q'],validFrom:'2026-01-01',validTo:null,evidenceIds:[evidenceId]});
  await compliance.approveRegulatoryProfile(tx,ctrl,entityId,rp.id);await compliance.activateRegulatoryProfile(tx,ctrl,entityId,rp.id,{reason:'reviewed'});
  profileId=rp.id;
 });
 const eh={'x-entity-id':entityId};
 worker=start('apps/worker/src/main.mjs');
 const uploadCsv=async(name,text)=>{const bytes=Buffer.from(text);const reg=await must(await call('tax','POST','/evidence/uploads',{body:{filename:name,mime:'text/csv',byteCount:bytes.length,sha256:sha(bytes),classification:'internal'},headers:{...key(),...eh}}),201);await call('tax','PUT','/evidence/'+reg.evidenceId+'/content',{raw:bytes,headers:{...eh,'content-type':'text/csv'}});const c=await call('tax','POST','/evidence/'+reg.evidenceId+'/complete',{body:{},headers:{...key(),...eh,...im(reg.version)}});assert.equal(c.status,202,await c.text());await waitFor(async()=>(await json(await call('tax','GET','/evidence/'+reg.evidenceId,{headers:eh}))).state==='available','scan',60000);return reg.evidenceId;};
 // Issue two invoices; the reporting-required profile queues transmissions the worker sends (one lost acknowledgement).
 const issue=async(price,description)=>{const d=await must(await call('billing','POST','/invoices',{body:{kind:'invoice',branchId,bookId,partyId:customerId,documentDate:'2026-09-10',accountingDate:'2026-09-10',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description,quantity:'1',unitPrice:price,discount:'0',priceBasis:'exclusive',accountId:accounts['4000'],taxCodeId:vatId,dimensions:{}}],evidenceIds:[]},headers:{...key(),...eh}}),201);let s=await must(await call('billing','POST','/invoices/'+d.id+'/submit',{body:{},headers:{...key(),...eh,...im(d.version)}}),200);s=await must(await call('accountant','POST','/invoices/'+d.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(s.version)}}),200);const p=await must(await call('accountant','POST','/invoices/'+d.id+'/post',{body:{},headers:{...key(),...eh,...im(s.version)}}),200);return {id:d.id,posted:p};};
 const inv1=await issue('10000','Consulting'),inv2=await issue('5000','Consulting LOSE-RESPONSE');
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 const jobsOf=async id=>(await api.query('select * from lara.transmission_jobs where tenant_id=$1 and document_id=$2 order by payload_version',[tenantId,id])).rows;
 await waitFor(async()=>(await jobsOf(inv1.id))[0]?.state==='accepted','transmission accepted',60000);
 const t1=(await jobsOf(inv1.id))[0];
 let r=await call('tax','GET','/transmissions/'+t1.id,{headers:eh});const tr=await must(r,200);contract('get_transmissions_id',tr);assert.deepEqual([tr.state,tr.attemptCount,tr.payloadVersion],['accepted',1,1]);
 r=await call('billing','GET','/invoices/'+inv1.id,{headers:eh});assert.equal((await must(r,200)).reportingState,'accepted');
 await waitFor(async()=>(await jobsOf(inv2.id))[0]?.state==='unknown','lost acknowledgement',60000);
 const t2=(await jobsOf(inv2.id))[0];
 r=await call('billing','POST','/transmissions/'+t2.id+'/reconcile',{body:{reason:'x'},headers:{...key(),...eh,...im(t2.version)}});assert.equal(r.status,403,'billing holds no transmission.reconcile');
 r=await call('tax','POST','/transmissions/'+t2.id+'/reconcile',{body:{reason:'Acknowledgement lost'},headers:{...key(),...eh,...im(t2.version)}});const rj=await must(r,202);contract('post_transmissions_id_reconcile',rj);
 await waitFor(async()=>(await jobsOf(inv2.id))[0]?.state==='accepted','reconciled',60000);
 r=await call('tax','GET','/transmissions/'+t2.id,{headers:eh});const t2v=await must(r,200);assert.deepEqual([t2v.state,t2v.attemptCount],['accepted',1],'no second submission');
 r=await call('tax','POST','/transmissions/'+t2.id+'/retry',{body:{reason:'x'},headers:{...key(),...eh,...im(t2v.version)}});assert.equal(r.status,409,'an accepted transmission is not retried');
 pass('reporting-required issuance queues transmissions the worker sends with the fixture transport; a lost acknowledgement is reconciled by status query to accepted with one attempt; retry of an accepted transmission is refused');
 // Envelope rejection retried as a new payload version; financial rejection refused.
 const inv3=await issue('700','Consulting REJECT-ENVELOPE'),inv4=await issue('600','Consulting REJECT-FINANCIAL');
 await waitFor(async()=>(await jobsOf(inv3.id))[0]?.state==='rejected'&&(await jobsOf(inv4.id))[0]?.state==='rejected','rejections',60000);
 const t3=(await jobsOf(inv3.id))[0],t4=(await jobsOf(inv4.id))[0];
 r=await call('tax','POST','/transmissions/'+t3.id+'/retry',{body:{reason:'Schema field repaired'},headers:{...key(),...eh,...im(t3.version)}});const retry=await must(r,202);contract('post_transmissions_id_retry',retry);
 await waitFor(async()=>(await jobsOf(inv3.id))[1]?.state==='rejected','retried version sent',60000);
 assert.deepEqual((await jobsOf(inv3.id)).map(j=>[j.payload_version,j.state]),[[1,'superseded'],[2,'rejected']],'the re-encoding is a new payload version (the fixture still rejects the marker)');
 r=await call('tax','POST','/transmissions/'+t4.id+'/retry',{body:{reason:'again'},headers:{...key(),...eh,...im(t4.version)}});assert.equal(r.status,409);assert.match((await json(r)).message,/correction document/);
 pass('an envelope rejection re-encodes as payload version 2 through the retry job; a financial rejection points to a correction document and refuses the retry');
 // Return run: mapping artifact from CSV evidence (domain), then the operations over HTTP.
 const mapping=['line_code,description,family,tax_type,recognition,kinds,measure,sign','12A,Vatable sales,sales,vat,any,invoice,basis,1','12B,Output tax due,sales,vat,any,invoice,amount,1'].join('\n')+'\n';
 const mappingEvidence=await uploadCsv('2550q.csv',mapping);
 await inTransaction(api,{tenantId,principalId:principals.tax},async tx=>{const taxCtx={...await identity.actorContext(tx,tenantId,principals.tax),traceId:'setup'};const a=await compliance.importArtifact(tx,taxCtx,entityId,{profileId,artifactType:'form_mapping',code:'2550Q',versionLabel:'v1',evidenceId:mappingEvidence});const ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};await compliance.approveArtifact(tx,ctrl,entityId,a.id);});
 r=await call('billing','POST','/returns',{body:{formCode:'2550Q',periodStart:'2026-07-01',periodEnd:'2026-09-30',profileVersion:'ph-2026',dataCutoff:new Date().toISOString()},headers:{...key(),...eh}});assert.equal(r.status,403);
 r=await call('tax','POST','/returns',{body:{formCode:'2550Q',periodStart:'2026-07-01',periodEnd:'2026-09-30',profileVersion:'ph-2026',dataCutoff:new Date().toISOString()},headers:{...key(),...eh}});const ret=await must(r,201);contract('post_returns',ret);assert.equal(ret.state,'draft');
 r=await call('tax','POST','/returns/'+ret.id+'/prepare',{body:{},headers:{...key(),...eh,...im(ret.version)}});const prepared=await must(r,200);contract('post_returns_id_prepare',prepared);assert.equal(prepared.state,'prepared');
 r=await call('tax','GET','/returns/'+ret.id+'/lines',{headers:eh});const lines=await must(r,200);contract('get_returns_id_lines',lines);
 assert.deepEqual(lines.lines.map(l=>[l.lineCode,l.basis,l.amount]),[['12A','16300.00','1956.00'],['12B','16300.00','1956.00']]);
 assert.equal(lines.tieOut.ties,true);
 r=await call('tax','GET','/returns/'+ret.id,{headers:eh});const rv=await must(r,200);contract('get_returns_id',rv);
 r=await call('tax','PATCH','/returns/'+ret.id,{body:{formCode:'2550Q',periodStart:'2026-07-01',periodEnd:'2026-09-30',profileVersion:'ph-2026',dataCutoff:new Date().toISOString()},headers:{...eh,...im(rv.version)}});assert.equal(r.status,409,'prepared returns are frozen');
 r=await call('tax','POST','/returns/'+ret.id+'/approve',{body:{decision:'approve',contentVersion:rv.contentVersion},headers:{...key(),...eh,...im(rv.version)}});assert.equal(r.status,403);
 r=await call('controller','POST','/returns/'+ret.id+'/approve',{body:{decision:'approve',contentVersion:rv.contentVersion},headers:{...key(),...eh,...im(rv.version)}});const approved=await must(r,200);contract('post_returns_id_approve',approved);assert.equal(approved.state,'approved');
 r=await call('tax','POST','/returns/'+ret.id+'/filed',{body:{externalReference:'ACK-1',filedAt:'2026-10-20T08:00:00Z',evidenceIds:[]},headers:{...key(),...eh,...im(approved.version)}});assert.equal(r.status,422,'filing needs evidence');
 r=await call('tax','POST','/returns/'+ret.id+'/filed',{body:{externalReference:'ACK-1',filedAt:'2026-10-20T08:00:00Z',evidenceIds:[evidenceId]},headers:{...key(),...eh,...im(approved.version)}});const filed=await must(r,200);contract('post_returns_id_filed',filed);assert.equal(filed.state,'filed');
 r=await call('tax','GET','/returns?state=filed',{headers:eh});const rets=await must(r,200);contract('get_returns',rets);assert.equal(rets.items.length,1);
 pass('return run over HTTP: creation, preparation from the approved mapping (lines and tie-out through the lines read), frozen once prepared, approval under another role, filing only with evidence, listed by state');
 // Registration pack job.
 r=await call('tax','POST','/registration-packs',{body:{reportType:'BIR',bookId,periodStart:'2026-01-01',periodEnd:'2026-12-31',asOf:new Date().toISOString(),format:'json'},headers:{...key(),...eh}});const pj=await must(r,202);contract('post_registration_packs',pj);
 await waitFor(async()=>['succeeded','failed'].includes((await json(await call('tax','GET','/jobs/'+pj.id,{headers:eh}))).state),'pack job',60000);
 const done=await json(await call('tax','GET','/jobs/'+pj.id,{headers:eh}));assert.equal(done.state,'succeeded',worker?.log().split('\n').slice(-6).join('\n'));
 r=await call('tax','GET','/evidence/'+done.resultResourceId+'/content',{headers:eh});assert.equal(r.status,200);assert.match(await r.text(),/recorded separately/);
 const cases=(await api.query('select status from lara.registration_cases where tenant_id=$1',[tenantId])).rows;assert.deepEqual(cases.map(c=>c.status),['pack_generated']);
 pass('the registration pack job stores the pack as restricted evidence and opens the case as pack_generated, never as a permit');
 // Isolation and later-phase gate
 r=await call('tax','GET','/returns/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('tax','GET','/returns/'+ret.id,{headers:{'x-entity-id':randomUUID()}});assert.equal(r.status,404);
 r=await call('tax','GET','/transmissions/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('tax','POST','/packs/install',{body:{packId:'retail-ph',version:'1.0.0',manifestHash:'0'.repeat(64),evidenceIds:['00000000-0000-4000-8000-000000000001']},headers:{...key(),...eh}});assert.ok([403,404,409].includes(r.status),'later-phase operations stay gated or refused for the caller');
 pass('unknown returns and transmissions and foreign entities answer 404; later-phase operations stay gated');
 console.log('P07-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-60).join(String.fromCharCode(10)));console.error(worker?.log().split(String.fromCharCode(10)).slice(-8).join(String.fromCharCode(10))||'');throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
