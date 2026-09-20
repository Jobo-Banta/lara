// P04-03 HTTP acceptance: sales operations through the API and worker as
// processes. Tax rule lifecycle, invoice creation with server totals,
// independent approval, issuance with numbering, idempotent replay, credit
// note correction, collections with allocations and refusals with typed codes,
// open items, delivery job, aging report job and cross-tenant isolation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,parties,evidence} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4027,BASE='http://127.0.0.1:'+PORT,bucket='.local/p04-api-test-'+randomBytes(3).toString('hex');
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
const call=async(name,method,path,{body,headers={}}={})=>{const token=signIdentity(name+'-'+suffix,method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET);return fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});};
const json=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return {raw:t};}};
const must=async(r,status)=>{const t=await r.text();assert.equal(r.status,status,t);try{return JSON.parse(t);}catch{return {raw:t};}};
const key=()=>({'idempotency-key':randomUUID()});
const im=v=>({'if-match':'"'+v+'"'});
const contract=(op,body)=>{const v=validateResponse(op,body);assert.equal(v.ok,true,op+' drifted: '+JSON.stringify(v.fieldErrors)+' '+JSON.stringify(body).slice(0,300));};
const apiProcess=start('apps/api/src/server.mjs');let worker=null;
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 let entityId,branchId,bookId,customerId,evidenceId;const accounts={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-sales-'+suffix,name:'Sales API',mode:'demo'});
  for(const n of ['billing','accountant','tax','controller','director','security','clerk'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['billing','accountant','tax','controller','security_admin','clerk'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  roles.orders=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,'order_approver','Order approver','[\"sales_order.approve\",\"sales_order.convert\",\"sales_order.read\",\"report.generate\"]','approved',$2,$3) returning id",[tenantId,sha('orders'),principals.security])).rows[0].id;
  for(const [p,r] of [['billing','billing'],['accountant','accountant'],['tax','tax'],['controller','controller'],['director','controller'],['director','orders'],['security','security_admin'],['clerk','clerk']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Sales API Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  branchId=(await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'})).id;
  for(const c of ['workspace','general_ledger','sales'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.director,principals.controller]);
  bookId=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,principals.controller])).rows[0].id;
  for(const [code,name,category,control] of [['1010','Cash','asset','none'],['1200','Receivables','asset','ar'],['1250','Withholding receivable','asset','none'],['2200','Output tax','liability','output_tax'],['4000','Service revenue','income','none']])accounts[code]=(await tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id",[tenantId,entityId,bookId,code,name,category,category==='asset'?'debit':'credit',control,control==='none',sha(code),principals.accountant])).rows[0].id;
  await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-09-01','2026-09-30',$4)",[tenantId,entityId,bookId,principals.controller]);
  for(const [kind,prefix] of [['invoice','INV'],['credit_note','CN']])await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,$4,$5,'numbering-2026',$6)",[tenantId,entityId,branchId,kind,prefix,principals.controller]);
  const s=await organization.saveSettings(tx,ctrl,entityId,'sales_profile',{arAccountId:accounts['1200'],outputTaxAccountId:accounts['2200'],cashAccountId:accounts['1010'],withholdingReceivableAccountId:accounts['1250'],scale:2,dueDays:30});
  const dir={...await identity.actorContext(tx,tenantId,principals.director),traceId:'setup'};
  await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});
  const bill={...await identity.actorContext(tx,tenantId,principals.billing),traceId:'setup'};
  customerId=(await parties.createParty(tx,bill,entityId,{legalName:'Acme Trading',roles:['customer'],identityStatus:'unknown',address:'Cebu City'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  const pdf=Buffer.from('%PDF-1.4 tax circular\n');const store=new evidence.MemoryEvidenceStore();
  const tax={...await identity.actorContext(tx,tenantId,principals.tax),traceId:'setup'};
  const reg=await evidence.registerUpload(tx,tax,entityId,{filename:'rr.pdf',mime:'application/pdf',byteCount:pdf.length,sha256:sha(pdf),classification:'internal'});
  await evidence.completeUpload(tx,tax,entityId,reg.evidenceId,pdf,store);
  await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);
  evidenceId=reg.evidenceId;
 });
 const eh={'x-entity-id':entityId};
 // Tax rules
 const ruleBody={code:'VAT12',taxType:'vat',validFrom:'2026-01-01',rate:'0.12',basis:'net',recognition:'issue',rounding:'line_half_up',applicabilityProfileId:randomUUID(),sourceEvidenceIds:[evidenceId],goldenCaseIds:['AC-01']};
 let r=await call('tax','POST','/tax-rules',{body:{...ruleBody,goldenCaseIds:['AC-99']},headers:{...key(),...eh}});assert.equal(r.status,422);assert.equal((await json(r)).code,'VALIDATION_FAILED');
 r=await call('tax','POST','/tax-rules',{body:ruleBody,headers:{...key(),...eh}});const rule=await must(r,201);contract('post_tax_rules',rule);assert.equal(rule.state,'draft');
 r=await call('tax','POST','/tax-rules/'+rule.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(rule.version)}});assert.equal(r.status,403);
 r=await call('controller','POST','/tax-rules/'+rule.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(rule.version)}});const approved=await must(r,200);contract('post_tax_rules_id_approve',approved);assert.equal(approved.state,'approved');
 r=await call('controller','POST','/tax-rules/'+rule.id+'/activate',{body:{reason:'Effective'},headers:{...key(),...eh,...im(approved.version)}});const active=await must(r,200);assert.equal(active.state,'active');
 r=await call('tax','PATCH','/tax-rules/'+rule.id,{body:{...ruleBody,rate:'0.10'},headers:{...eh,...im(active.version)}});assert.equal(r.status,409);assert.equal((await json(r)).code,'STATE_CONFLICT');
 r=await call('tax','GET','/tax-rules',{headers:eh});const rules=await must(r,200);contract('get_tax_rules',rules);assert.equal(rules.items[0].state,'active');
 pass('tax rules: unknown golden case refused, approval and activation under separate roles, active version immutable, listed with contract shape');
 // Invoice lifecycle
 const line=(unitPrice,extra={})=>({description:'Consulting',quantity:'1',unitPrice,discount:'0',priceBasis:'exclusive',accountId:accounts['4000'],taxCodeId:rule.id,dimensions:{},...extra});
 const invoiceBody=(lines,extra={})=>({kind:'invoice',branchId,bookId,partyId:customerId,documentDate:'2026-09-18',accountingDate:'2026-09-18',currency:'PHP',ruleProfileVersion:'ph-vat-2026',lines,evidenceIds:[],...extra});
 r=await call('billing','POST','/invoices',{body:invoiceBody([line('10000')]),headers:eh});assert.equal(r.status,428);
 r=await call('billing','POST','/invoices',{body:{...invoiceBody([line('10000')]),net:'1.00'},headers:{...key(),...eh}});assert.equal(r.status,422,'client totals are not part of the contract');
 r=await call('clerk','POST','/invoices',{body:invoiceBody([line('10000')]),headers:{...key(),...eh}});assert.equal(r.status,201,'clerk holds invoice.prepare');const clerkDraft=await json(r);
 const k=key();
 r=await call('billing','POST','/invoices',{body:invoiceBody([line('6000'),line('4000',{description:'Training'})]),headers:{...k,...eh}});const inv=await must(r,201);contract('post_invoices',inv);
 assert.deepEqual([inv.net,inv.tax,inv.gross,inv.state,inv.officialNumber,inv.settlementState,inv.lines.length],['10000.00','1200.00','11200.00','draft',null,'unpaid',2]);
 r=await call('billing','POST','/invoices',{body:invoiceBody([line('6000'),line('4000',{description:'Training'})]),headers:{...k,...eh}});assert.equal(r.status,201);assert.equal((await json(r)).id,inv.id,'idempotent replay returns the same invoice');
 r=await call('billing','GET','/invoices/'+inv.id,{headers:eh});assert.equal(r.headers.get('etag'),'"1"');
 r=await call('billing','POST','/invoices/'+inv.id+'/submit',{body:{},headers:{...key(),...eh,...im(1)}});const submitted=await must(r,200);contract('post_invoices_id_submit',submitted);assert.equal(submitted.state,'submitted');
 r=await call('billing','POST','/invoices/'+inv.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(submitted.version)}});assert.equal(r.status,403);
 r=await call('accountant','POST','/invoices/'+inv.id+'/approve',{body:{decision:'approve',contentVersion:9},headers:{...key(),...eh,...im(submitted.version)}});assert.equal(r.status,412);assert.equal((await json(r)).code,'VERSION_CONFLICT');
 r=await call('accountant','POST','/invoices/'+inv.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(submitted.version)}});const approvedInv=await must(r,200);assert.equal(approvedInv.state,'approved');
 r=await call('accountant','POST','/invoices/'+inv.id+'/post',{body:{},headers:{...key(),...eh,...im(approvedInv.version-1)}});assert.equal(r.status,412);
 r=await call('accountant','POST','/invoices/'+inv.id+'/post',{body:{},headers:{...key(),...eh,...im(approvedInv.version)}});const posted=await must(r,200);contract('post_invoices_id_post',posted);assert.equal(posted.state,'posted');assert.equal(posted.journalEntryIds.length,1);
 r=await call('billing','GET','/invoices/'+inv.id,{headers:eh});const issued=await must(r,200);contract('get_invoices_id',issued);assert.equal(issued.officialNumber,'INV-000001');
 r=await call('billing','PATCH','/invoices/'+inv.id,{body:invoiceBody([line('1')]),headers:{...eh,...im(issued.version)}});assert.equal(r.status,409);assert.equal((await json(r)).code,'STATE_CONFLICT');
 r=await call('billing','GET','/invoices?state=draft',{headers:eh});const drafts=await must(r,200);contract('get_invoices',drafts);assert.deepEqual(drafts.items.map(d=>d.id),[clerkDraft.id]);
 pass('invoice: missing idempotency key 428, client totals rejected by the contract, server totals 10,000 / 1,200 / 11,200, idempotent replay, ETag, submit, forbidden and stale approvals, versioned issuance to INV-000001, posted immutability and filtered listing');
 // Correction and open items
 r=await call('billing','POST','/invoices/'+inv.id+'/correct',{body:{kind:'credit_note',accountingDate:'2026-09-20',reason:'Scope reduced',lines:[line('5000')]},headers:{...key(),...eh,...im(issued.version)}});assert.equal(r.status,403);
 r=await call('accountant','POST','/invoices/'+inv.id+'/correct',{body:{kind:'credit_note',accountingDate:'2026-09-20',reason:'Too much',lines:[line('10001')]},headers:{...key(),...eh,...im(issued.version)}});assert.equal(r.status,409);
 r=await call('accountant','POST','/invoices/'+inv.id+'/correct',{body:{kind:'credit_note',accountingDate:'2026-09-20',reason:'Scope reduced',lines:[line('5000')]},headers:{...key(),...eh,...im(issued.version)}});const corr=await must(r,200);contract('post_invoices_id_correct',corr);assert.equal(corr.state,'draft');
 r=await call('billing','POST','/invoices/'+corr.resourceId+'/submit',{body:{},headers:{...key(),...eh,...im(1)}});const cnSub=await must(r,200);
 r=await call('controller','POST','/invoices/'+corr.resourceId+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(cnSub.version)}});const cnApp=await must(r,200);
 r=await call('accountant','POST','/invoices/'+corr.resourceId+'/post',{body:{},headers:{...key(),...eh,...im(cnApp.version)}});const cnPosted=await must(r,200);assert.equal(cnPosted.state,'posted');
 r=await call('billing','GET','/open-items?partyId='+customerId,{headers:eh});const items=await must(r,200);contract('get_open_items',items);
 assert.deepEqual(items.items.map(i=>[i.originalAmount,i.allocatedAmount,i.outstandingAmount]),[['11200.00','5600.00','5600.00']]);
 r=await call('billing','GET','/invoices/'+inv.id,{headers:eh});assert.equal((await json(r)).settlementState,'partial');
 pass('correction: billing cannot correct, over-credit refused, a partial credit note travels through review and posts, applying 5,600 to the open item');
 // Collection with withholding, allocation refusals, reversal
 const item=items.items[0];
 const receipt={direction:'receipt',partyId:customerId,currency:'PHP',valueDate:'2026-09-25',grossAmount:'5600.00',cashAmount:'5500.00',withholdingAmount:'100.00',method:'transfer',allocations:[{openItemId:item.id,amount:'5600.00'}],evidenceIds:[]};
 r=await call('billing','POST','/collections',{body:{...receipt,cashAmount:'5000.00'},headers:{...key(),...eh}});assert.equal(r.status,422);
 r=await call('billing','POST','/collections',{body:receipt,headers:{...key(),...eh}});const rc=await must(r,201);contract('post_collections',rc);assert.equal(rc.allocations.length,1);
 r=await call('billing','POST','/collections/'+rc.id+'/submit',{body:{},headers:{...key(),...eh,...im(rc.version)}});const rcSub=await must(r,200);
 r=await call('accountant','POST','/collections/'+rc.id+'/approve',{body:{decision:'approve',contentVersion:1},headers:{...key(),...eh,...im(rcSub.version)}});const rcApp=await must(r,200);
 r=await call('accountant','POST','/collections/'+rc.id+'/post',{body:{},headers:{...key(),...eh,...im(rcApp.version)}});const rcPosted=await must(r,200);contract('post_collections_id_post',rcPosted);assert.equal(rcPosted.journalEntryIds.length,1);
 r=await call('billing','GET','/invoices/'+inv.id,{headers:eh});assert.equal((await json(r)).settlementState,'paid');
 r=await call('accountant','POST','/collections/'+rc.id+'/allocations',{body:{allocations:[{openItemId:item.id,amount:'0.01'}]},headers:{...key(),...eh,...im(rcPosted.version)}});assert.equal(r.status,409);assert.equal((await json(r)).code,'ALLOCATION_EXCEEDS_BALANCE');
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 const applied=(await api.query("select id from lara.allocation_events where tenant_id=$1 and settlement_id=$2 and action='apply'",[tenantId,rc.id])).rows[0].id;
 r=await call('accountant','POST','/allocations/'+applied+'/reverse',{body:{reason:'Wrong invoice'},headers:{...key(),...eh,...im(1)}});const rev=await must(r,200);contract('post_allocations_id_reverse',rev);assert.equal(rev.state,'reversed');
 r=await call('accountant','POST','/allocations/'+applied+'/reverse',{body:{reason:'Again'},headers:{...key(),...eh,...im(1)}});assert.equal(r.status,409);
 r=await call('billing','GET','/open-items?partyId='+customerId+'&open=true',{headers:eh});assert.equal((await must(r,200)).items[0].outstandingAmount,'5600.00');
 r=await call('accountant','GET','/collections/'+rc.id,{headers:eh});const rcView=await must(r,200);contract('get_collections_id',rcView);
 r=await call('accountant','POST','/collections/'+rc.id+'/reverse',{body:{accountingDate:'2026-09-26',reason:'Bounced'},headers:{...key(),...eh,...im(rcView.version)}});const rcRev=await must(r,200);assert.equal(rcRev.state,'reversed');assert.equal(rcRev.journalEntryIds.length,1);
 r=await call('accountant','GET','/collections',{headers:eh});const cols=await must(r,200);contract('get_collections',cols);assert.equal(cols.items[0].state,'reversed');
 pass('collection: component mismatch 422, receipt with withholding posts and settles the invoice, double allocation 409 ALLOCATION_EXCEEDS_BALANCE, one reversal per allocation, receipt reversal posts the mirrored entry');
 // Worker: delivery job and aging report
 worker=start('apps/worker/src/main.mjs');
 const current=await json(await call('billing','GET','/invoices/'+inv.id,{headers:eh}));
 r=await call('billing','POST','/invoices/'+inv.id+'/deliver',{body:{},headers:{...key(),...eh,...im(current.version)}});const del=await must(r,200);contract('post_invoices_id_deliver',del);
 await waitFor(async()=>(await json(await call('billing','GET','/invoices/'+inv.id,{headers:eh}))).deliveryState==='sent','delivery job',60000);
 r=await call('director','POST','/reports',{body:{reportType:'aging',bookId,periodStart:'2026-09-01',periodEnd:'2026-11-30',asOf:new Date().toISOString(),format:'csv'},headers:{...key(),...eh}});const job=await must(r,202);contract('post_reports',job);
 await waitFor(async()=>['succeeded','failed'].includes((await json(await call('director','GET','/jobs/'+job.id,{headers:eh}))).state),'aging job',60000);
 const done=await json(await call('director','GET','/jobs/'+job.id,{headers:eh}));assert.equal(done.state,'succeeded',worker?.log().split('\n').slice(-6).join('\n'));
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 const snap=(await api.query("select payload from lara.report_snapshots where tenant_id=$1 and report_type='aging'",[tenantId])).rows[0].payload;
 assert.equal(snap.totals.total,'5600.00');assert.equal(snap.parties[0].buckets['31_60'],'5600.00');
 pass('worker: delivery job marks the invoice sent; the aging report runs as a job into an immutable snapshot with CSV rendering');
 // Isolation and unknown resources
 r=await call('billing','GET','/invoices/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('billing','GET','/invoices/'+inv.id,{headers:{'x-entity-id':randomUUID()}});assert.equal(r.status,404);
 r=await call('billing','GET','/sales-orders/'+inv.id,{headers:eh});assert.equal(r.status,404,'an invoice is not addressable as a sales order');
 r=await call('billing','POST','/returns',{body:{},headers:{...key(),...eh}});assert.equal(r.status,409);assert.equal((await json(r)).code,'FEATURE_NOT_ENABLED');
 pass('unknown documents, foreign entities and mismatched kinds answer 404; P07 return operations stay gated');
 console.log('P04-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split('\n').slice(-15).join('\n'));throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
