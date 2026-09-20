// P13-03 HTTP acceptance: portals and messaging through the API and worker
// as processes with the local mail and fixture payment adapters. An invite
// created, its message drafted, authorized by another role and delivered by
// the worker into the local mailbox; acceptance by the invited identity
// through the public accept route; the member's fenced reads (own invoices
// only, another party's invoice 404, internal operations 403); a supplier
// upload routing to review; a payment link, the claim, the signed webhook
// settling once and replays ignored; the public verification link; gates.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,createHmac,randomUUID,randomBytes} from 'node:crypto';
import {readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,ledger,parties,sales,treasury,evidence,portals,FilesystemEvidenceStore} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4036,BASE='http://127.0.0.1:'+PORT,bucket='.local/p13-api-test-'+randomBytes(3).toString('hex');
const fieldKey=process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex');
const WEBHOOK_SECRET='api-test-webhook-secret';
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:fieldKey,WORKER_POLL_MS:'200',RATE_LIMIT_WRITES_PER_MINUTE:'2000',RATE_LIMIT_READS_PER_MINUTE:'5000',MAIL_ADAPTER:'local',EINVOICE_ADAPTER:'fixture',AI_PROVIDER:'fixture',PAYMENT_ADAPTER:'fixture',PAYMENT_WEBHOOK_SECRET:WEBHOOK_SECRET};
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),tenantId=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
const children=[];
function start(file){const c=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>{out+=b;});c.stderr.on('data',b=>{out+=b;});c.log=()=>out;c.done=false;c.once('exit',()=>{c.done=true;});children.push(c);return c;}
async function stop(c){if(c.done)return;const exited=new Promise(r=>c.once('exit',r));c.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);if(!c.done)c.kill('SIGKILL');}
async function waitFor(fn,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,200));}assert.fail('timeout: '+label);}
const principals={};
const call=async(name,method,path,{body,headers={},raw,subject}={})=>{const token=signIdentity(subject||(name+'-'+suffix),method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET);return fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token,...(raw?{}:{'content-type':'application/json'}),...headers},body:raw??(body===undefined?undefined:JSON.stringify(body))});};
const anon=async(method,path,{body,headers={},raw}={})=>fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(20000),headers:{...(raw?{}:{'content-type':'application/json'}),...headers},body:raw??(body===undefined?undefined:JSON.stringify(body))});
const json=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return {raw:t};}};
const must=async(r,status)=>{const t=await r.text();assert.equal(r.status,status,t);try{return JSON.parse(t);}catch{return {raw:t};}};
const key=()=>({'idempotency-key':randomUUID()});
const im=v=>({'if-match':'"'+v+'"'});
const contract=(op,body)=>{const v=validateResponse(op,body);assert.equal(v.ok,true,op+' drifted: '+JSON.stringify(v.fieldErrors)+' '+JSON.stringify(body).slice(0,300));};
const jobDone=async(who,id,eh)=>{await waitFor(async()=>['succeeded','failed','dead_letter'].includes((await json(await call(who,'GET','/jobs/'+id,{headers:eh}))).state),'job '+id,60000);return json(await call(who,'GET','/jobs/'+id,{headers:eh}));};
const apiProcess=start('apps/api/src/server.mjs');let worker=null;
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 let entityId,bookId,customerA,customerB,supplier,invA,invB;const accounts={};
 await inTransaction(api,{tenantId,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:tenantId,slug:'api-portal-'+suffix,name:'Portal API',mode:'demo'});
  for(const n of ['billing','clerk','accountant','tax','treasury','controller','director','auditor','security','relations'])principals[n]=(await identity.resolvePrincipal(tx,tenantId,{issuer:process.env.OIDC_ISSUER,subject:n+'-'+suffix,displayName:n})).id;
  const roles={};
  for(const code of ['billing','clerk','accountant','tax','treasury','controller','auditor','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[tenantId,sha(code),principals.security,code])).rows[0].id;
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[tenantId,code,JSON.stringify(perms),sha(code),principals.security])).rows[0].id;
  roles.relations=await role('relations',['portal_invite.create','portal_invite.edit','portal_invite.read','message_request.create','message_request.edit','message_request.read','payment_link.create','payment_link.edit','payment_link.read','payment_link.cancel','party.read','invoice.read','open_item.read','collection.create','collection.read','evidence.read','job.read','task.read']);
  roles.authorizer=await role('message_authorizer',['message_request.send','message_request.read','portal_invite.revoke','portal_invite.read','payment_link.read','job.read']);
  for(const [p,r] of [['billing','billing'],['clerk','clerk'],['accountant','accountant'],['tax','tax'],['treasury','treasury'],['controller','controller'],['controller','authorizer'],['director','controller'],['director','authorizer'],['auditor','auditor'],['relations','relations'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[tenantId,principals[p],roles[r],principals.security]);
  let ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Portal API Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,tenantId,principals.controller),traceId:'setup'};
  const branchId=(await organization.createBranch(tx,ctrl,entityId,{code:'HQ',name:'Head office',address:'Makati'})).id;
  for(const c of ['workspace','general_ledger','sales','purchasing','treasury','compliance','portals'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[tenantId,entityId,c,principals.director,principals.controller]);
  bookId=(await tx.query("insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,source_owner,status,created_by) values($1,$2,'MAIN','primary','PHP','lara','active',$3) returning id",[tenantId,entityId,principals.controller])).rows[0].id;
  for(const [code,name,category,side,control] of [['1010','Cash','asset','debit','none'],['1020','Provider clearing','asset','debit','none'],['1200','Receivables','asset','debit','ar'],['2200','Output tax','liability','credit','output_tax'],['4000','Service revenue','income','credit','none']])accounts[code]=(await tx.query("insert into lara.accounts(tenant_id,entity_id,book_id,code,name,category,normal_side,control_type,allow_manual,content_hash,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id",[tenantId,entityId,bookId,code,name,category,side,control,control==='none',sha(code),principals.controller])).rows[0].id;
  await tx.query("insert into lara.periods(tenant_id,entity_id,book_id,starts_on,ends_on,created_by) values($1,$2,$3,'2026-10-01','2026-10-31',$4)",[tenantId,entityId,bookId,principals.controller]);
  const dir={...await identity.actorContext(tx,tenantId,principals.director),traceId:'setup'};
  const settle=async(kind,payload)=>{const s=await organization.saveSettings(tx,ctrl,entityId,kind,payload);await organization.approveSettings(tx,dir,entityId,s.id,{payloadHash:s.payloadHash});};
  await settle('sales_profile',{arAccountId:accounts['1200'],outputTaxAccountId:accounts['2200'],cashAccountId:accounts['1010'],scale:2,dueDays:30});
  const treCtx={...await identity.actorContext(tx,tenantId,principals.treasury),traceId:'setup'};
  const fsStore=new FilesystemEvidenceStore(bucket);const letter=Buffer.from('%PDF-1.4 bank letter'+String.fromCharCode(10));
  const reg=await evidence.registerUpload(tx,treCtx,entityId,{filename:'bank-letter.pdf',mime:'application/pdf',byteCount:letter.length,sha256:sha(letter),classification:'internal'});
  await evidence.completeUpload(tx,treCtx,entityId,reg.evidenceId,letter,fsStore);await evidence.recordScan(tx,{tenantId,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),fsStore);
  const bank=await treasury.createBankAccount(tx,treCtx,entityId,{bookId,ledgerAccountId:accounts['1020'],bankCode:'GCASH',accountNumber:'0917 000 1234',currency:'PHP',evidenceIds:[reg.evidenceId]},{FIELD_ENCRYPTION_KEY:fieldKey});
  await treasury.approveBankAccount(tx,ctrl,entityId,bank.id,{decision:'approve',contentVersion:1});
  await settle('portal_profile',{messagingProvider:'local-mail',paymentProvider:'fixture-pay',paymentBankAccountId:bank.id,shareDays:14,termsVersion:'portal-2026',supportEmail:'support@portal.invalid',baseUrl:'https://portal.test.invalid'});
  await tx.query("insert into lara.document_series(tenant_id,entity_id,branch_id,kind,prefix,profile_version,created_by) values($1,$2,$3,'invoice','INV','numbering-2026',$4)",[tenantId,entityId,branchId,principals.controller]);
  const clerkCtx={...await identity.actorContext(tx,tenantId,principals.clerk),traceId:'setup'},billCtx={...await identity.actorContext(tx,tenantId,principals.billing),traceId:'setup'},accCtx={...await identity.actorContext(tx,tenantId,principals.accountant),traceId:'setup'};
  customerA=(await parties.createParty(tx,clerkCtx,entityId,{legalName:'Alpha Retail',roles:['customer'],identityStatus:'unknown',address:'Makati'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  customerB=(await parties.createParty(tx,clerkCtx,entityId,{legalName:'Beta Stores',roles:['customer'],identityStatus:'unknown',address:'Cebu'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  supplier=(await parties.createParty(tx,clerkCtx,entityId,{legalName:'Gamma Supplies',roles:['supplier'],identityStatus:'unknown',address:'Pasig'},{FIELD_ENCRYPTION_KEY:fieldKey})).id;
  const invoiceFor=async(party,price)=>{const d=await sales.createDocument(tx,billCtx,entityId,{kind:'invoice',branchId,bookId,partyId:party,documentDate:'2026-10-05',accountingDate:'2026-10-05',currency:'PHP',ruleProfileVersion:'ph-2026',lines:[{description:'Retainer',quantity:'1',unitPrice:price,discount:'0',priceBasis:'exclusive',accountId:accounts['4000'],dimensions:{}}],evidenceIds:[]});await sales.submitDocument(tx,billCtx,entityId,d.id,{});await sales.approveDocument(tx,accCtx,entityId,d.id,{decision:'approve',contentVersion:1});await sales.postDocument(tx,accCtx,entityId,d.id,{});return d.id;};
  invA=await invoiceFor(customerA,'5000');invB=await invoiceFor(customerB,'7000');
 });
 const eh={'x-entity-id':entityId};
 worker=start('apps/worker/src/main.mjs');
 // Invite, message, authorized send, delivery, acceptance.
 const soon=new Date(Date.now()+3*86400000).toISOString();
 let r=await call('auditor','POST','/portal-invites',{body:{partyId:customerA,email:'owner@alpha.invalid',role:'customer',expiresAt:soon},headers:{...key(),...eh}});assert.equal(r.status,403);
 r=await call('relations','POST','/portal-invites',{body:{partyId:customerA,email:'owner@alpha.invalid',role:'customer',expiresAt:soon},headers:{...key(),...eh}});const invite=await must(r,201);contract('post_portal_invites',invite);assert.equal(invite.email,'o***@alpha.invalid');
 r=await call('relations','GET','/portal-invites',{headers:eh});contract('get_portal_invites',await must(r,200));
 r=await call('relations','PATCH','/portal-invites/'+invite.id,{body:{partyId:customerA,email:'owner@alpha.invalid',role:'customer',expiresAt:new Date(Date.now()+5*86400000).toISOString()},headers:{...eh,...im(invite.version)}});const edited=await must(r,200);contract('patch_portal_invites_id',edited);
 r=await call('relations','POST','/message-requests',{body:{sourceType:'portal_invite',sourceId:invite.id,recipientPartyId:customerA,channel:'email',templateVersion:'invite-2026'},headers:{...key(),...eh}});const msg=await must(r,201);contract('post_message_requests',msg);
 r=await call('relations','POST','/message-requests/'+msg.id+'/send',{body:{reason:'go'},headers:{...key(),...eh,...im(msg.version)}});assert.equal(r.status,403,'the drafter role does not send');
 r=await call('controller','POST','/message-requests/'+msg.id+'/send',{body:{reason:'Onboarding Alpha'},headers:{...key(),...eh,...im(msg.version)}});const sent=await must(r,200);contract('post_message_requests_id_send',sent);assert.equal(sent.state,'authorized');
 await waitFor(async()=>(await json(await call('controller','GET','/message-requests/'+msg.id,{headers:eh}))).state==='sent','message delivered',60000);
 r=await call('controller','GET','/message-requests/'+msg.id+'/receipts',{headers:eh});const receipts=await must(r,200);contract('get_message_requests_id_receipts',receipts);assert.equal(receipts.receipts[0].outcome,'sent');
 const files=(await readdir(join(bucket,'messages'))).filter(f=>f.endsWith('.json'));assert.equal(files.length,1,'one message in the local mailbox');
 const mail=JSON.parse(await readFile(join(bucket,'messages',files[0]),'utf8'));
 const token=new URL(mail.link).searchParams.get('token');
 // Acceptance: wrong address, then the invited one; a second acceptance is refused.
 r=await call('x','POST','/portal-invites/'+invite.id+'/accept',{subject:'someone@else.invalid',body:{token,email:'someone@else.invalid'},headers:{...key(),'x-tenant-id':tenantId}});assert.equal(r.status,403);
 r=await call('x','POST','/portal-invites/'+invite.id+'/accept',{subject:'owner@alpha.invalid',body:{token,email:'owner@alpha.invalid'},headers:{...key(),'x-tenant-id':tenantId}});const accepted=await must(r,200);contract('post_portal_invites_id_accept',accepted);assert.equal(accepted.state,'active');
 r=await call('x','POST','/portal-invites/'+invite.id+'/accept',{subject:'owner@alpha.invalid',body:{token,email:'owner@alpha.invalid'},headers:{...key(),'x-tenant-id':tenantId}});assert.equal(r.status,409);
 r=await call('relations','GET','/portal-memberships',{headers:eh});const members=await must(r,200);contract('get_portal_memberships',members);assert.equal(members.items[0].partyId,customerA);
 pass('an invite over HTTP: refused to the examiner, created with a masked address, edited with If-Match, its message drafted by relations and authorized by the controller, delivered by the worker into the local mailbox with only a link, accepted once by the invited address through the public accept route, and the membership listed');
 // The member's fenced world.
 const alpha={subject:'owner@alpha.invalid'};
 r=await call('x','GET','/portal/me',{...alpha,headers:eh});const me=await must(r,200);contract('get_portal_me',me);assert.equal(me.partyName,'Alpha Retail');assert.equal(me.role,'customer');
 r=await call('x','GET','/invoices',{...alpha,headers:eh});const mine=await must(r,200);assert.deepEqual(mine.items.map(d=>d.id),[invA]);
 r=await call('x','GET','/invoices/'+invB,{...alpha,headers:eh});assert.equal(r.status,404,'another party\'s invoice');
 r=await call('x','GET','/invoices?partyId='+customerB,{...alpha,headers:eh});assert.equal((await must(r,200)).items.length,0);
 r=await call('x','GET','/open-items?open=true',{...alpha,headers:eh});assert.ok((await must(r,200)).items.every(i=>i.partyId===customerA));
 r=await call('x','GET','/parties',{...alpha,headers:eh});assert.equal(r.status,403,'internal listing refused');
 r=await call('x','POST','/portal-invites',{...alpha,body:{partyId:customerB,email:'b@b.invalid',role:'customer',expiresAt:soon},headers:{...key(),...eh}});assert.equal(r.status,403);
 r=await call('x','GET','/certificates',{...alpha,headers:eh});contract('get_certificates',await must(r,200));
 pass('the member reads their scope, their own invoices and open items only; another party\'s invoice answers 404, a party filter cannot widen the fence, and internal operations answer 403');
 // Payment link, claim, webhook once.
 r=await call('relations','POST','/payment-links',{body:{invoiceId:invA,amount:'5000.00',currency:'PHP',expiresAt:soon},headers:{...key(),...eh}});const link=await must(r,201);contract('post_payment_links',link);assert.equal(link.state,'pending');
 r=await call('x','GET','/payment-links',{...alpha,headers:eh});const myLinks=await must(r,200);contract('get_payment_links',myLinks);assert.equal(myLinks.items.length,1);
 r=await call('x','POST','/payment-links/'+link.id+'/claim',{...alpha,body:{reason:'Paid through the app'},headers:{...key(),...eh,...im(link.version)}});const claim=await must(r,200);contract('post_payment_links_id_claim',claim);assert.equal(claim.state,'pending');
 await api.query("select set_config('lara.tenant_id',$1,false)",[tenantId]);
 const providerKey=(await api.query('select provider_key from lara.provider_payment_intents where tenant_id=$1 and id=$2',[tenantId,link.id])).rows[0].provider_key;
 const store=new FilesystemEvidenceStore(bucket);
 const {fixturePaymentProvider}=await import('../packages/domain/src/index.mjs');
 const pay=fixturePaymentProvider(store,WEBHOOK_SECRET);
 const hook=async(event,{timestamp=Math.floor(Date.now()/1000),signature}={})=>{const body=JSON.stringify(event);const sig=signature??createHmac('sha256',WEBHOOK_SECRET).update(timestamp+'.'+body).digest('hex');return json(await anon('POST','/webhooks/fixture-pay',{raw:body,headers:{'content-type':'application/json','x-tenant-id':tenantId,'x-webhook-timestamp':String(timestamp),'x-webhook-signature':sig,'idempotency-key':event.id}}));};
 assert.equal((await hook({id:'evt-1',type:'payment.paid',providerKey},{signature:'bad'})).outcome,'rejected');
 assert.equal((await hook({id:'evt-2',type:'payment.paid',providerKey})).outcome,'rejected','not yet paid at the provider');
 await pay.settleAtProvider(providerKey,{amount:'5000.00',currency:'PHP'});
 const applied=await hook({id:'evt-3',type:'payment.paid',providerKey});contract('post_webhooks_provider',applied);assert.equal(applied.outcome,'applied');assert.ok(applied.settlementId);
 assert.equal((await hook({id:'evt-3',type:'payment.paid',providerKey})).outcome,'ignored','replay');
 assert.equal((await hook({id:'evt-4',type:'payment.paid',providerKey})).outcome,'ignored','second paid event');
 r=await call('relations','GET','/payment-links/'+link.id,{headers:eh});assert.equal((await must(r,200)).state,'settled');
 r=await call('relations','GET','/webhook-receipts',{headers:eh});const wh=await must(r,200);contract('get_webhook_receipts',wh);assert.equal(wh.items.length,4);
 assert.equal((await api.query("select count(*)::int as n from lara.settlements where tenant_id=$1 and state='draft'",[tenantId])).rows[0].n,1,'one collection draft for review');
 r=await call('x','GET','/payment-links/'+link.id,{...alpha,headers:eh});assert.equal((await must(r,200)).state,'settled');
 pass('a payment link over HTTP: created on the posted invoice, visible to the member, claimed from the browser without settling, then settled once by the signed provider event verified server to server (a forged signature and a premature event rejected, replays and repeats ignored), one collection draft for review, the event log read');
 // Public verification link and gates.
 const share=await inTransaction(api,{tenantId,principalId:principals.relations},async tx=>{const rel={...await identity.actorContext(tx,tenantId,principals.relations),traceId:'share'};return portals.createShare(tx,rel,entityId,{resourceType:'document',resourceId:invA});});
 r=await anon('GET','/verify/'+share.token);const view=await must(r,200);contract('get_verify_token',view);assert.equal(view.gross,'5000.00');assert.equal(view.partyDisplay,'A***');
 r=await anon('GET','/verify/'+tenantId+'.'+'0'.repeat(48));assert.equal(r.status,404);
 r=await anon('GET','/invoices/'+invA);assert.equal(r.status,401,'nothing else is public');
 r=await call('relations','POST','/portal-invites/'+invite.id+'/revoke',{body:{reason:'Contact left'},headers:{...key(),...eh,...im(edited.version)}});assert.equal(r.status,403);
 const current=await must(await call('controller','GET','/portal-invites/'+invite.id,{headers:eh}),200);contract('get_portal_invites_id',current);assert.equal(current.state,'accepted');
 r=await call('controller','POST','/portal-invites/'+invite.id+'/revoke',{body:{reason:'Contact left'},headers:{...key(),...eh,...im(current.version)}});const revoked=await must(r,200);contract('post_portal_invites_id_revoke',revoked);
 r=await call('x','GET','/invoices',{...alpha,headers:eh});assert.equal(r.status,404,'revoked member reads nothing: its entity is gone from its scope');
 r=await call('auditor','GET','/portal-invites/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call('auditor','POST','/packs/install',{body:{},headers:{...key(),...eh}});assert.ok([404,409].includes(r.status),'later-phase operations stay gated');
 pass('the verification link shows minimal fields without a session and an unknown token 404s while every other route needs a session; revocation by the authorizer ends the member\'s access; unknown records answer 404 and later-phase operations stay gated');
 console.log('P13-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-40).join(String.fromCharCode(10)));console.error(worker?.log().split(String.fromCharCode(10)).slice(-8).join(String.fromCharCode(10))||'');throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[tenantId]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
