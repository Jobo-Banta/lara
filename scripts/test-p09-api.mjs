// P09-03 HTTP acceptance: multi-currency and separate books through the API
// as a process. FX rates over the reviewed operations (draft, edit,
// independent approval, inverted pair refused, list and read); a USD invoice
// issued and settled at another rate with the layers and realized FX read
// over HTTP (AC-10); separate books created, edited and activated with the
// combined management view; a revaluation created, previewed, approved and
// posted once with its preview read; and isolation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,evidence,parties,sales,fx} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4032,BASE='http://127.0.0.1:'+PORT,bucket='.local/p09-api-test-'+randomBytes(3).toString('hex');
const fieldKey=process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex');
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:fieldKey,RATE_LIMIT_WRITES_PER_MINUTE:'2000',RATE_LIMIT_READS_PER_MINUTE:'5000',MAIL_ADAPTER:'local',EINVOICE_ADAPTER:'fixture'};
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
const apiProcess=start('apps/api/src/server.mjs');
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 let entityId,branchId,bookId,customerId,evidenceId,zeroId,periodId;const accounts={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-fx-'+suffix,name:'FX API',mode:'demo'});
  for(const n of ['billing','accountant','treasury','tax','controller','director','auditor','security'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['billing','accountant','treasury','tax','controller','auditor','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.fx_desk=await role('fx_desk',['fx_rate.create','fx_rate.edit','fx_rate.read']);
  roles.fx_preparer=await role('fx_preparer',['revaluation.create','revaluation.edit','revaluation.preview','revaluation.read','fx_rate.read']);
  roles.fx_approver=await role('fx_approver',['revaluation.approve','revaluation.post','revaluation.read']);
  for(const [p,r] of [['billing','billing'],['accountant','accountant'],['accountant','fx_preparer'],['treasury','treasury'],['treasury','fx_desk'],['tax','tax'],['controller','controller'],['controller','fx_desk'],['controller','fx_approver'],['director','controller'],['director','fx_approver'],['auditor','auditor'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Exporter API Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  branchId=(await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'})).id;
  for(const c of ['workspace','general_ledger','sales','purchasing','treasury','compliance','fi_coexistence','multi_currency'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.director,principals.controller]);
  bookId=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,principals.controller])).rows[0].id;
  for(const [code,name,category,side,control] of [['1010','Cash','asset','debit','none'],['1200','Receivables','asset','debit','ar'],['2200','Output tax','liability','credit','output_tax'],['4000','Revenue','income','credit','none'],['7100','Realized FX gain','income','credit','none'],['7200','Realized FX loss','expense','debit','none'],['7300','Unrealized FX gain','income','credit','none'],['7400','Unrealized FX loss','expense','debit','none']])accounts[code]=(await tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$11,$9,$10) returning id",[tenantId,entityId,bookId,code,name,category,side,control,sha(code),principals.controller,control==='none'])).rows[0].id;
  periodId=(await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4) returning id",[tenantId,entityId,bookId,principals.controller])).rows[0].id;
  await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-11-01','2026-11-30',$4)",[tenantId,entityId,bookId,principals.controller]);
  await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4)",[tenantId,entityId,branchId,principals.controller]);
  const dir={...await identity.actorContext(tx,tenantId,principals.director),traceId:'setup'};
  for(const [kind,payload] of [['sales_profile',{arAccountId:accounts['1200'],outputTaxAccountId:accounts['2200'],cashAccountId:accounts['1010'],scale:2,dueDays:30}],['fx_profile',{realizedGainAccountId:accounts['7100'],realizedLossAccountId:accounts['7200'],unrealizedGainAccountId:accounts['7300'],unrealizedLossAccountId:accounts['7400'],monetaryAccountIds:[accounts['1200']],profileVersion:'fx-2026'}]]){const s=await organization.saveSettings(tx,ctrl,entityId,kind,payload);await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});}
  const clerk={...await identity.actorContext(tx,tenantId,principals.billing),traceId:'setup'};
  customerId=(await parties.createParty(tx,clerk,entityId,{legalName:'Overseas Buyer',roles:['customer'],identityStatus:'unknown',address:'Singapore'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  const pdf=Buffer.from('%PDF-1.4 BSP reference rates\n');const store=new evidence.MemoryEvidenceStore();
  const taxCtx={...await identity.actorContext(tx,tenantId,principals.tax),traceId:'setup'};
  const reg=await evidence.registerUpload(tx,taxCtx,entityId,{filename:'bsp.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'internal'});
  await evidence.completeUpload(tx,taxCtx,entityId,reg.evidenceId,pdf,store);
  await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);
  evidenceId=reg.evidenceId;
  zeroId=(await tx.query("insert into lara.tax_rule_versions(tenant_id,entity_id,code,version_number,tax_type,valid_from,rate,basis,recognition,rounding,applicability_profile_id,source_evidence_ids,golden_case_ids,content_hash,created_by,status,approved_by,activated_by,activated_at) values($1,$2,'ZERO',1,'vat','2026-01-01',0,'net','issue','line_half_up',gen_random_uuid(),$3,'[\"AC-10\"]',$4,$5,'active',$6,$6,now()) returning id",[tenantId,entityId,JSON.stringify([evidenceId]),sha('zero'),principals.tax,principals.controller])).rows[0].id;
 });
 const eh={'x-entity-id':entityId};
 // Currencies and rates.
 let r=await call('auditor','GET','/currencies',{headers:eh});const cur=await must(r,200);contract('get_currencies',cur);assert.ok(cur.items.some(c=>c.code==='JPY'&&c.minorUnits===0));
 r=await call('treasury','POST','/fx-rates',{body:{baseCurrency:'PHP',quoteCurrency:'USD',rateDate:'2026-10-05',rate:'56',sourceEvidenceId:evidenceId},headers:{...key(),...eh}});assert.equal(r.status,422,'inverted pair refused');assert.match((await json(r)).message,/inverted/);
 r=await call('treasury','POST','/fx-rates',{body:{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:'2026-10-05',rate:'55',sourceEvidenceId:evidenceId},headers:{...key(),...eh}});const rate=await must(r,201);contract('post_fx_rates',rate);assert.equal(rate.state,'draft');
 r=await call('treasury','PATCH','/fx-rates/'+rate.id,{body:{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:'2026-10-05',rate:'56',sourceEvidenceId:evidenceId},headers:{...eh,...im(rate.version)}});const edited=await must(r,200);contract('patch_fx_rates_id',edited);assert.equal(edited.rate,'56');
 r=await call('treasury','POST','/fx-rates/'+rate.id+'/approve',{body:{decision:'approve',contentVersion:edited.contentVersion},headers:{...key(),...eh,...im(edited.version)}});assert.equal(r.status,403,'the desk holds no approval');
 r=await call('controller','POST','/fx-rates/'+rate.id+'/approve',{body:{decision:'approve',contentVersion:edited.contentVersion},headers:{...key(),...eh,...im(edited.version)}});const approved=await must(r,200);contract('post_fx_rates_id_approve',approved);assert.equal(approved.state,'approved');
 const approveRate=async(date,value)=>{const c=await must(await call('treasury','POST','/fx-rates',{body:{baseCurrency:'USD',quoteCurrency:'PHP',rateDate:date,rate:value,sourceEvidenceId:evidenceId},headers:{...key(),...eh}}),201);await must(await call('controller','POST','/fx-rates/'+c.id+'/approve',{body:{decision:'approve',contentVersion:c.contentVersion},headers:{...key(),...eh,...im(c.version)}}),200);return c;};
 await approveRate('2026-10-15','57');const closing=await approveRate('2026-10-31','58');
 r=await call('auditor','GET','/fx-rates',{headers:eh});const rates=await must(r,200);contract('get_fx_rates',rates);assert.equal(rates.items.length,3);
 r=await call('auditor','GET','/fx-rates/'+rate.id,{headers:eh});contract('get_fx_rates_id',await must(r,200));
 pass('FX rates over HTTP: an inverted pair is refused, a draft is edited and approved by another role, listed and read with contract shapes');
 // AC-10 over HTTP: USD 100 invoice at 56, receipt at 57.
 const issue=async(price,date)=>{const d=await must(await call('billing','POST','/invoices',{body:{kind:'invoice',branchId,bookId,partyId:customerId,documentDate:date,accountingDate:date,currency:'USD',ruleProfileVersion:'ph-2026',lines:[{description:'Export services',quantity:'1',unitPrice:price,discount:'0',priceBasis:'exclusive',accountId:accounts['4000'],taxCodeId:zeroId,dimensions:{}}],evidenceIds:[]},headers:{...key(),...eh}}),201);const s=await must(await call('billing','POST','/invoices/'+d.id+'/submit',{body:{},headers:{...key(),...eh,...im(d.version)}}),200);const a=await must(await call('accountant','POST','/invoices/'+d.id+'/approve',{body:{decision:'approve',contentVersion:d.contentVersion},headers:{...key(),...eh,...im(s.version)}}),200);const p=await must(await call('accountant','POST','/invoices/'+d.id+'/post',{body:{},headers:{...key(),...eh,...im(a.version)}}),200);return {id:d.id,posted:p};};
 const inv=await issue('100','2026-10-05');
 assert.equal(inv.posted.journalEntryIds.length,1);
 r=await call('billing','GET','/open-items?side=AR&partyId='+customerId,{headers:eh});const items=await must(r,200);const item=items.items.find(i=>i.documentId===inv.id);
 r=await call('billing','GET','/fx-layers?openItemId='+item.id,{headers:eh});let layers=await must(r,200);contract('get_fx_layers',layers);assert.deepEqual([layers.items.length,layers.items[0].txnRemaining,layers.items[0].funcCarrying,layers.items[0].rate],[1,'100.00','5600.00','56']);
 const rc=await must(await call('billing','POST','/collections',{body:{direction:'receipt',partyId:customerId,currency:'USD',valueDate:'2026-10-15',grossAmount:'100.00',cashAmount:'100.00',withholdingAmount:'0.00',method:'transfer',allocations:[{openItemId:item.id,amount:'100.00'}],evidenceIds:[]},headers:{...key(),...eh}}),201);
 const rs=await must(await call('billing','POST','/collections/'+rc.id+'/submit',{body:{},headers:{...key(),...eh,...im(rc.version)}}),200);
 const ra=await must(await call('accountant','POST','/collections/'+rc.id+'/approve',{body:{decision:'approve',contentVersion:rc.contentVersion},headers:{...key(),...eh,...im(rs.version)}}),200);
 const rp=await must(await call('accountant','POST','/collections/'+rc.id+'/post',{body:{},headers:{...key(),...eh,...im(ra.version)}}),200);
 assert.equal(rp.journalEntryIds.length,2,'transaction entry and the realized FX adjustment');
 r=await call('billing','GET','/fx-layers?openItemId='+item.id,{headers:eh});layers=await must(r,200);assert.deepEqual([layers.items[1].event,layers.items[1].funcConsumed,layers.items[1].realizedFx,layers.items[1].txnRemaining],['settle','5600.00','100.00','0.00']);
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 const bal=async(code,asOf='2026-12-31')=>(await api.query('select coalesce(sum(l.func_debit-l.func_credit),0)::text as b from lara.journal_lines l join lara.journal_entries e on e.tenant_id=l.tenant_id and e.id=l.entry_id where l.tenant_id=$1 and l.account_id=$2 and e.accounting_date<=$3::date',[tenantId,accounts[code],asOf])).rows[0].b;
 assert.deepEqual([Number(await bal('1010')),Number(await bal('1200')),Number(await bal('7100'))],[5700,0,-100],'AC-10: Bank 5,700 / AR 5,600 / FX gain 100');
 pass('AC-10 over HTTP: a USD 100 invoice issued at 56 opens a 100 / 5,600 layer; the receipt at 57 posts the transaction entry and the realized gain of 100; the layer clears and the functional balances tie');
 // Separate books and the combined view.
 r=await call('accountant','POST','/books',{body:{code:'fcdu',kind:'fcdu',functionalCurrency:'USD',sourceOwner:'lara'},headers:{...key(),...eh}});assert.equal(r.status,403);
 r=await call('controller','POST','/books',{body:{code:'fcdu',kind:'fcdu',functionalCurrency:'USD',sourceOwner:'lara'},headers:{...key(),...eh}});const fcdu=await must(r,201);contract('post_books',fcdu);assert.equal(fcdu.state,'draft');
 r=await call('controller','PATCH','/books/'+fcdu.id,{body:{code:'fcdu',kind:'fcdu',functionalCurrency:'USD',sourceOwner:'core-banking'},headers:{...eh,...im(fcdu.version)}});const fcduEdited=await must(r,200);contract('patch_books_id',fcduEdited);assert.equal(fcduEdited.sourceOwner,'core-banking');
 r=await call('controller','POST','/books/'+fcdu.id+'/activate',{body:{reason:'FCDU licence'},headers:{...key(),...eh,...im(fcduEdited.version)}});assert.equal(r.status,403,'creator activating');
 r=await call('director','POST','/books/'+fcdu.id+'/activate',{body:{reason:'FCDU licence on file'},headers:{...key(),...eh,...im(fcduEdited.version)}});const act=await must(r,200);contract('post_books_id_activate',act);assert.equal(act.state,'active');
 r=await call('auditor','GET','/books/'+fcdu.id,{headers:eh});const fb=await must(r,200);contract('get_books_id',fb);assert.equal(fb.state,'active');
 const view=await must(await call('controller','POST','/books',{body:{code:'mgmt',kind:'management',functionalCurrency:'PHP',sourceOwner:'lara'},headers:{...key(),...eh}}),201);
 await must(await call('director','POST','/books/'+view.id+'/activate',{body:{reason:'Management view'},headers:{...key(),...eh,...im(view.version)}}),200);
 await inTransaction(api,{tenantId,principalId:principals.controller},async tx=>{const ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};await fx.linkBook(tx,ctrl,entityId,{sourceBookId:bookId,targetViewId:view.id,translationPolicy:'as_is'});await fx.linkBook(tx,ctrl,entityId,{sourceBookId:fcdu.id,targetViewId:view.id,translationPolicy:'closing_rate'});});
 r=await call('auditor','GET','/books/'+view.id+'/combined?asOf=2026-10-31',{headers:eh});const combined=await must(r,200);contract('get_books_id_combined',combined);assert.deepEqual([combined.books.map(b=>b.code).sort(),combined.combined.find(a=>a.code==='1010').balance,combined.blocked.length],[['FCDU','MAIN'],'5700.00',0]);
 r=await call('auditor','GET','/books/'+view.id+'/combined?asOf=2026-10-20',{headers:eh});const blocked=await must(r,200);assert.deepEqual(blocked.blocked.map(b=>b.code),['FCDU'],'a missing closing rate blocks the translated book');
 pass('books over HTTP: a partition is created by the controller, edited while draft, activated by another principal and read; the management view combines PHP as is and FCDU at the closing rate and blocks on a missing rate');
 // Revaluation of the AR balance of an unpaid USD invoice.
 const inv2=await issue('50','2026-10-05');
 r=await call('accountant','POST','/revaluations',{body:{bookId,periodId,rateSetId:rate.id,accountIds:[accounts['1200']],reverseNextPeriod:true},headers:{...key(),...eh}});assert.equal(r.status,422,'not the period-end rate');
 r=await call('accountant','POST','/revaluations',{body:{bookId,periodId,rateSetId:closing.id,accountIds:[accounts['1200'],accounts['1010']],reverseNextPeriod:true},headers:{...key(),...eh}});assert.equal(r.status,422,'cash is not classified monetary in this profile');
 r=await call('accountant','POST','/revaluations',{body:{bookId,periodId,rateSetId:closing.id,accountIds:[accounts['1200']],reverseNextPeriod:true},headers:{...key(),...eh}});const rv=await must(r,201);contract('post_revaluations',rv);assert.equal(rv.state,'draft');
 r=await call('accountant','POST','/revaluations/'+rv.id+'/preview',{body:{},headers:{...key(),...eh,...im(rv.version)}});const pv=await must(r,200);contract('post_revaluations_id_preview',pv);assert.equal(pv.state,'previewed');
 r=await call('accountant','GET','/revaluations/'+rv.id+'/lines',{headers:eh});const lines=await must(r,200);contract('get_revaluations_id_lines',lines);assert.deepEqual([lines.lines[0].txnBalance,lines.lines[0].carrying,lines.lines[0].revalued,lines.lines[0].difference],['50.00','2800.00','2900.00','100.00']);
 r=await call('accountant','GET','/revaluations/'+rv.id,{headers:eh});const rvv=await must(r,200);contract('get_revaluations_id',rvv);
 r=await call('accountant','POST','/revaluations/'+rv.id+'/approve',{body:{decision:'approve',contentVersion:rvv.contentVersion},headers:{...key(),...eh,...im(rvv.version)}});assert.equal(r.status,403);
 r=await call('controller','POST','/revaluations/'+rv.id+'/approve',{body:{decision:'approve',contentVersion:rvv.contentVersion},headers:{...key(),...eh,...im(rvv.version)}});const rva=await must(r,200);contract('post_revaluations_id_approve',rva);assert.equal(rva.state,'approved');
 r=await call('controller','POST','/revaluations/'+rv.id+'/post',{body:{},headers:{...key(),...eh,...im(rva.version)}});const rvp=await must(r,200);contract('post_revaluations_id_post',rvp);assert.deepEqual([rvp.state,rvp.journalEntryIds.length],['posted',2]);
 r=await call('controller','POST','/revaluations/'+rv.id+'/post',{body:{},headers:{...key(),...eh,...im(rvp.version)}});const rvp2=await must(r,200);assert.deepEqual(rvp2.journalEntryIds,rvp.journalEntryIds,'posting again has one effect');
 r=await call('auditor','GET','/revaluations?bookId='+bookId,{headers:eh});const rvs=await must(r,200);contract('get_revaluations',rvs);assert.equal(rvs.items.length,1);
 assert.deepEqual([Number(await bal('1200','2026-10-31')),Number(await bal('7300','2026-10-31')),Number(await bal('7300','2026-11-30'))],[2900,-100,0],'the AR carrying value is revalued to 2,900 with an unrealized gain of 100 at October end, reversed in November');
 pass('revaluation over HTTP: refused for a non-closing rate and an unclassified account, created, previewed with the lines read, approved by another role, posted once with its next-period reversal, listed');
 // Isolation and later-phase gate.
 r=await call('auditor','GET','/fx-rates/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('auditor','GET','/revaluations/'+rv.id,{headers:{'x-entity-id':randomUUID()}});assert.equal(r.status,404);
 r=await call('auditor','GET','/books/'+randomUUID()+'/combined?asOf=2026-10-31',{headers:eh});assert.equal(r.status,404);
 r=await call('auditor','POST','/packs/install',{body:{},headers:{...key(),...eh}});assert.ok([404,409].includes(r.status),'later-phase operations stay gated');
 pass('unknown records and foreign entities answer 404; later-phase operations stay gated');
 console.log('P09-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-40).join(String.fromCharCode(10)));throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
