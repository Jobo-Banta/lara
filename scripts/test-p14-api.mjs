// P14-03 HTTP acceptance: the firm workspace through the API as a process
// with one firm tenant and one client tenant. The firm and its staff over
// HTTP; a mandate drafted, approved and listed in the client; the partner's
// client scopes and roll-up in the firm tenant; the client context header
// binding the partner to the delegated identity; an assignment and the
// staff member's fenced scope; revocation; isolation and later-phase gates.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {signIdentity} from '../apps/api/src/identity.mjs';
import {validateResponse} from '../packages/contracts/src/index.mjs';
import {inTransaction,identity,organization,evidence,workflow,FilesystemEvidenceStore} from '../packages/domain/src/index.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const api=client(process.env.DATABASE_URL),owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
await Promise.all([api.connect(),owner.connect()]);
const PORT=4037,BASE='http://127.0.0.1:'+PORT,bucket='.local/p14-api-test-'+randomBytes(3).toString('hex');
const fieldKey=process.env.FIELD_ENCRYPTION_KEY||randomBytes(32).toString('hex');
const env={...process.env,API_PORT:String(PORT),API_BIND_HOST:'127.0.0.1',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:bucket,FIELD_ENCRYPTION_KEY:fieldKey,RATE_LIMIT_WRITES_PER_MINUTE:'2000',RATE_LIMIT_READS_PER_MINUTE:'5000'};
const sha=b=>createHash('sha256').update(b).digest('hex');
const suffix=randomBytes(3).toString('hex'),firmTenant=randomUUID(),clientTenant=randomUUID();
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
const children=[];
function start(file){const c=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>{out+=b;});c.stderr.on('data',b=>{out+=b;});c.log=()=>out;c.done=false;c.once('exit',()=>{c.done=true;});children.push(c);return c;}
async function stop(c){if(c.done)return;const exited=new Promise(r=>c.once('exit',r));c.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))]);if(!c.done)c.kill('SIGKILL');}
async function waitFor(fn,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,200));}assert.fail('timeout: '+label);}
const call=async(subject,method,path,{body,headers={}}={})=>{const token=signIdentity(subject,method,'/v1'+path.split('?')[0],process.env.SESSION_SECRET);return fetch(BASE+'/v1'+path,{method,signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});};
const must=async(r,status)=>{const t=await r.text();assert.equal(r.status,status,t);try{return JSON.parse(t);}catch{return {raw:t};}};
const key=()=>({'idempotency-key':randomUUID()});
const im=v=>({'if-match':'"'+v+'"'});
const contract=(op,body)=>{const v=validateResponse(op,body);assert.equal(v.ok,true,op+' drifted: '+JSON.stringify(v.fieldErrors)+' '+JSON.stringify(body).slice(0,300));};
const PARTNER='partner-'+suffix,STAFF='staff-'+suffix,CTRL='ctrl-'+suffix,DIR='dir-'+suffix,SEC='sec-'+suffix;
const apiProcess=start('apps/api/src/server.mjs');
try{
 await waitFor(async()=>{try{return (await fetch(BASE+'/health/live')).ok;}catch{return false;}},'api live');
 // The firm tenant: partner and staff with firm roles.
 const firmPrincipals={};
 await inTransaction(api,{tenantId:firmTenant,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:firmTenant,slug:'api-firm-'+suffix,name:'Ledger & Co',mode:'demo'});
  for(const [n,s] of [['partner',PARTNER],['staff',STAFF],['security',SEC]])firmPrincipals[n]=(await identity.resolvePrincipal(tx,firmTenant,{issuer:process.env.OIDC_ISSUER,subject:s,displayName:n})).id;
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[firmTenant,code,JSON.stringify(perms),sha(code),firmPrincipals.security])).rows[0].id;
  const partnerRole=await role('firm_partner',['firm_assignment.create','firm_assignment.read','firm_mandate.read','session.read','entity.create','entity.read','task.read']),staffRole=await role('firm_staff',['firm_assignment.read','firm_mandate.read','session.read']);
  await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4),($1,$5,$6,$4)',[firmTenant,firmPrincipals.partner,partnerRole,firmPrincipals.security,firmPrincipals.staff,staffRole]);
  const p={...await identity.actorContext(tx,firmTenant,firmPrincipals.partner),traceId:'setup'};
  await organization.createEntity(tx,p,{legalName:'Ledger & Co',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1});
 });
 // The client tenant: controller drafts mandates, director approves; the capability active; an engagement letter; an open task.
 let entityId,engagement;const cp={};
 await inTransaction(api,{tenantId:clientTenant,principalId:null},async tx=>{
  await organization.provisionTenant(tx,{id:clientTenant,slug:'api-client-'+suffix,name:'Alpha Trading',mode:'demo'});
  for(const [n,s] of [['controller',CTRL],['director',DIR],['security',SEC+'-c']])cp[n]=(await identity.resolvePrincipal(tx,clientTenant,{issuer:process.env.OIDC_ISSUER,subject:s,displayName:n})).id;
  const roles={};
  for(const code of ['controller','security_admin'])roles[code]=(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by,protected) select $1,code,name,permissions,'approved',$2,$3,true from lara.role_templates where code=$4 returning id",[clientTenant,sha(code),cp.security,code])).rows[0].id;
  const role=async(code,perms)=>(await tx.query("insert into lara.roles(tenant_id,code,name,permissions,status,content_hash,created_by) values($1,$2,$2,$3,'approved',$4,$5) returning id",[clientTenant,code,JSON.stringify(perms),sha(code),cp.security])).rows[0].id;
  roles.mandates=await role('mandates',['firm_mandate.create','firm_mandate.edit','firm_mandate.read','firm_mandate.revoke','firm_assignment.read','evidence.upload','evidence.read']);
  roles.approver=await role('mandate_approver',['firm_mandate.approve','firm_mandate.read']);
  for(const [p,r] of [['controller','controller'],['controller','mandates'],['director','controller'],['director','approver'],['security','security_admin']])await tx.query('insert into lara.memberships(tenant_id,principal_id,role_id,created_by) values($1,$2,$3,$4)',[clientTenant,cp[p],roles[r],cp.security]);
  let ctrl={...await identity.actorContext(tx,clientTenant,cp.controller),traceId:'setup'};
  entityId=(await organization.createEntity(tx,ctrl,{legalName:'Alpha Trading',baseCurrency:'PHP',timezone:'Asia/Manila',fiscalYearStartMonth:1})).id;
  ctrl={...await identity.actorContext(tx,clientTenant,cp.controller),traceId:'setup'};
  for(const c of ['workspace','general_ledger','sales','purchasing','treasury','compliance','firm_workspace'])await tx.query("insert into lara.capability_activations(tenant_id,entity_id,capability,status,profile_version,approved_by,activated_at,created_by) values($1,$2,$3,'active','p.1',$4,now(),$5)",[clientTenant,entityId,c,cp.director,cp.controller]);
  const store=new FilesystemEvidenceStore(bucket);const letter=Buffer.from('%PDF-1.4 engagement'+String.fromCharCode(10));
  const reg=await evidence.registerUpload(tx,ctrl,entityId,{filename:'engagement.pdf',mime:'application/pdf',byteCount:letter.length,sha256:sha(letter),classification:'internal'});
  await evidence.completeUpload(tx,ctrl,entityId,reg.evidenceId,letter,store);await evidence.recordScan(tx,{tenantId:clientTenant,principalId:null},entityId,reg.evidenceId,new evidence.FixtureScanner(),store);engagement=reg.evidenceId;
  await workflow.createObligation(tx,ctrl,entityId,{kind:'vat_return',periodKey:'2026-06',dueAt:'2026-07-20T00:00:00Z',ownerId:cp.controller,ruleVersion:'bir-2026'});
 });
 const eh={'x-entity-id':entityId};
 // The firm record and staff over HTTP.
 let r=await call(STAFF,'POST','/firms',{body:{name:'Ledger & Co'},headers:key()});assert.equal(r.status,403);
 r=await call(PARTNER,'POST','/firms',{body:{name:'Ledger & Co',plan:{tier:'standard'}},headers:key()});const firm=await must(r,201);contract('post_firms',firm);
 r=await call(PARTNER,'GET','/firms');const firms=await must(r,200);contract('get_firms',firms);assert.equal(firms.items[0].id,firm.id);
 r=await call(PARTNER,'POST','/firms/'+firm.id+'/staff',{body:{principalId:firmPrincipals.staff,role:'staff'},headers:key()});const st=await must(r,201);contract('post_firms_id_staff',st);
 r=await call(PARTNER,'GET','/firms/'+firm.id+'/staff');contract('get_firms_id_staff',await must(r,200));
 r=await call(PARTNER,'GET','/firm/clients');const none=await must(r,200);contract('get_firm_clients',none);assert.equal(none.items.length,0,'no client without a mandate');
 pass('the firm is registered by the partner (not by staff), listed with its id, staff enrolled and listed, and no client scope exists before a mandate');
 // The mandate in the client: drafted by the controller, approved by the director.
 const soon=new Date(Date.now()+60*86400000).toISOString();
 const body={firmId:firm.id,permissions:['task.read','obligation.read','open_item.read','period.read','firm_assignment.create','firm_assignment.read','firm_assignment.edit'],entityIds:[entityId],validUntil:soon,evidenceIds:[engagement]};
 r=await call(CTRL,'POST','/firm-mandates',{body:{...body,permissions:['membership.create']},headers:{...key(),...eh}});assert.equal(r.status,422,'security authority never delegated');
 r=await call(CTRL,'POST','/firm-mandates',{body,headers:{...key(),...eh}});const mandate=await must(r,201);contract('post_firm_mandates',mandate);assert.equal(mandate.state,'draft');
 r=await call(CTRL,'PATCH','/firm-mandates/'+mandate.id,{body:{...body,validUntil:new Date(Date.now()+30*86400000).toISOString()},headers:{...eh,...im(mandate.version)}});const edited=await must(r,200);contract('patch_firm_mandates_id',edited);
 r=await call(CTRL,'POST','/firm-mandates/'+mandate.id+'/approve',{body:{decision:'approve',contentVersion:edited.contentVersion},headers:{...key(),...eh,...im(edited.version)}});assert.equal(r.status,403,'the drafter role does not approve');
 r=await call(DIR,'POST','/firm-mandates/'+mandate.id+'/approve',{body:{decision:'approve',contentVersion:edited.contentVersion},headers:{...key(),...eh,...im(edited.version)}});const approved=await must(r,200);contract('post_firm_mandates_id_approve',approved);assert.equal(approved.state,'approved');
 r=await call(CTRL,'GET','/firm-mandates',{headers:eh});const ml=await must(r,200);contract('get_firm_mandates',ml);assert.equal(ml.items[0].state,'approved');
 r=await call(CTRL,'GET','/firm-mandates/'+mandate.id,{headers:eh});contract('get_firm_mandates_id',await must(r,200));
 pass('a mandate over HTTP: security authorities refused, drafted and edited with If-Match by the controller, refused to the drafter role and approved by the director, listed and read');
 // The partner's scopes and roll-up in the firm tenant; the client context header binds the delegated identity.
 r=await call(PARTNER,'GET','/firm/clients',{headers:{'x-tenant-id':firmTenant}});const clients=await must(r,200);contract('get_firm_clients',clients);assert.equal(clients.items.length,1);assert.equal(clients.items[0].entityName,'Alpha Trading');
 r=await call(PARTNER,'GET','/firm/rollup',{headers:{'x-tenant-id':firmTenant}});const roll=await must(r,200);contract('get_firm_rollup',roll);assert.equal(roll.items[0].counts.overdueObligations,1);assert.deepEqual(roll.items[0].counts.openItems,[]);
 r=await call(PARTNER,'GET','/firm/snapshots',{headers:{'x-tenant-id':firmTenant}});const snaps=await must(r,200);contract('get_firm_snapshots',snaps);assert.equal(snaps.items.length,1);
 r=await call(PARTNER,'GET','/tasks',{headers:eh});assert.equal(r.status,428,'two tenants: the client context header is required');
 r=await call(PARTNER,'GET','/tasks',{headers:{...eh,'x-tenant-id':clientTenant}});const tasks=await must(r,200);assert.equal(tasks.items.length,0);
 r=await call(PARTNER,'GET','/me',{headers:{'x-tenant-id':clientTenant}});const me=await must(r,200);assert.deepEqual(me.entityIds,[entityId]);assert.ok(me.permissions.includes('task.read')&&!me.permissions.includes('journal.post'));
 r=await call(PARTNER,'GET','/invoices',{headers:{...eh,'x-tenant-id':clientTenant}});assert.equal(r.status,403,'outside the mandate');
 r=await call(PARTNER,'POST','/firm-mandates',{body,headers:{...key(),...eh,'x-tenant-id':clientTenant}});assert.equal(r.status,403,'a delegate grants no mandate');
 // The partner assigns the staff member a subset; the staff member's scope is fenced.
 r=await call(PARTNER,'POST','/firm-assignments',{body:{mandateId:mandate.id,principalId:firmPrincipals.staff,entityIds:[entityId],permissionSubset:['task.read','journal.post']},headers:{...key(),...eh,'x-tenant-id':clientTenant}});assert.equal(r.status,422,'outside the mandate');
 r=await call(PARTNER,'POST','/firm-assignments',{body:{mandateId:mandate.id,principalId:firmPrincipals.staff,entityIds:[entityId],permissionSubset:['task.read']},headers:{...key(),...eh,'x-tenant-id':clientTenant}});const assignment=await must(r,201);contract('post_firm_assignments',assignment);
 r=await call(PARTNER,'GET','/firm-assignments',{headers:{...eh,'x-tenant-id':clientTenant}});contract('get_firm_assignments',await must(r,200));
 r=await call(PARTNER,'GET','/firm-assignments/'+assignment.id,{headers:{...eh,'x-tenant-id':clientTenant}});contract('get_firm_assignments_id',await must(r,200));
 r=await call(PARTNER,'PATCH','/firm-assignments/'+assignment.id,{body:{mandateId:mandate.id,principalId:firmPrincipals.staff,entityIds:[entityId],permissionSubset:['task.read','obligation.read']},headers:{...eh,'x-tenant-id':clientTenant,...im(assignment.version)}});contract('patch_firm_assignments_id',await must(r,200));
 r=await call(STAFF,'GET','/firm/clients',{headers:{'x-tenant-id':firmTenant}});const staffClients=await must(r,200);assert.equal(staffClients.items.length,1);assert.deepEqual([...staffClients.items[0].permissions].sort(),['obligation.read','task.read']);
 r=await call(STAFF,'GET','/tasks',{headers:{...eh,'x-tenant-id':clientTenant}});assert.equal(r.status,200);
 r=await call(STAFF,'GET','/open-items',{headers:{...eh,'x-tenant-id':clientTenant}});assert.equal(r.status,403,'the subset holds no open item read');
 r=await call(STAFF,'POST','/firm-assignments',{body:{mandateId:mandate.id,principalId:firmPrincipals.staff,entityIds:[entityId],permissionSubset:['task.read']},headers:{...key(),...eh,'x-tenant-id':clientTenant}});assert.equal(r.status,403,'staff assign nobody');
 r=await call(PARTNER,'POST','/firm/bulk-reminders',{body:{clients:[{tenantId:clientTenant,entityId}],templateVersion:'reminder-2026',channel:'email'},headers:{...key(),'x-tenant-id':firmTenant}});const bulk=await must(r,200);contract('post_firm_bulk_reminders',bulk);assert.ok(['nothing_due','failed'].includes(bulk.outcomes[0].outcome));
 pass('the partner lists the client scope and the labelled roll-up, must name the client context when two tenants apply, acts in the client as the delegated identity within the mandate only, assigns the staff member a subset (never wider), and the staff member sees that subset alone; bulk reminders answer per client');
 // Revocation and gates.
 r=await call(PARTNER,'POST','/firm-mandates/'+mandate.id+'/revoke',{body:{reason:'x'},headers:{...key(),...eh,'x-tenant-id':clientTenant,...im(approved.version)}});assert.equal(r.status,403,'a delegate revokes nothing');
 r=await call(CTRL,'POST','/firm-mandates/'+mandate.id+'/revoke',{body:{reason:'Engagement ended'},headers:{...key(),...eh,...im(approved.version)}});const revoked=await must(r,200);contract('post_firm_mandates_id_revoke',revoked);assert.equal(revoked.state,'revoked');
 r=await call(PARTNER,'GET','/firm/clients',{headers:{'x-tenant-id':firmTenant}});assert.equal((await must(r,200)).items.length,0);
 r=await call(PARTNER,'GET','/firm/snapshots',{headers:{'x-tenant-id':firmTenant}});assert.equal((await must(r,200)).items.length,0,'cached counts gone at once');
 r=await call(PARTNER,'GET','/tasks',{headers:{...eh,'x-tenant-id':clientTenant}});assert.equal(r.status,404,'the delegate has no entity left in the client');
 r=await call(CTRL,'GET','/firm-mandates/'+randomUUID(),{headers:eh});assert.equal(r.status,404);
 r=await call(CTRL,'POST','/packs/install',{body:{},headers:{...key(),...eh}});assert.ok([404,409].includes(r.status),'later-phase operations stay gated');
 pass('revocation by the client ends the partner\'s scope, snapshots and client access at once; unknown records answer 404 and later-phase operations stay gated');
 console.log('P14-03 API acceptance passed ('+step+' groups)');
}catch(e){console.error(apiProcess.log().split(String.fromCharCode(10)).slice(-30).join(String.fromCharCode(10)));throw e;}
finally{for(const c of children)await stop(c);await removeTenants(owner,[clientTenant,firmTenant]);await Promise.all([api.end(),owner.end()]);await rm(bucket,{recursive:true,force:true});}
