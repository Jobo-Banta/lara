// P13-01 portals and messaging schema acceptance against real PostgreSQL
// through the runtime role: invites bound to one party and role with a
// unique token hash and final states; memberships one per principal and
// party; share grants unique per token; message requests authorized by a
// principal other than the drafter, frozen once authorized, sent once with
// a reference and receipts unique per attempt; payment intents unique per
// provider key with one live intent per invoice, amounts fixed once live and
// final states; webhook receipts unique per provider event and append-only;
// row-level security isolates every table.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const client=url=>new pg.Client({...connectionOptions(url),connectionTimeoutMillis:15000,query_timeout:30000});
const owner=client(process.env.LARA_MIGRATOR_DATABASE_URL||process.env.SUPABASE_LARA_MIGRATOR_DATABASE_URL||process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL);
const api=client(process.env.DATABASE_URL);
await Promise.all([owner.connect(),api.connect()]);
const hash=v=>createHash('sha256').update(v).digest('hex');
const suffix=randomBytes(4).toString('hex');
const T={id:randomUUID(),slug:'p02-test-portal-'+suffix};
const other={id:randomUUID(),slug:'p02-test-portal-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 await run(owner,T.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Portal schema test','demo')",[T.id,T.slug]);
 await run(owner,other.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,'Other tenant','demo')",[other.id,other.slug]);
 const principal=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Relations') returning id",[T.id,'rel-'+suffix])).rows[0].id;
 const approver=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Authorizer') returning id",[T.id,'auth-'+suffix])).rows[0].id;
 const external=(await run(owner,T.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'External') returning id",[T.id,'ext-'+suffix])).rows[0].id;
 const entity=(await run(owner,T.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Portal entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[T.id,hash('e'),principal])).rows[0].id;
 const branch=(await run(owner,T.id,"insert into lara.branches(tenant_id,entity_id,code,name,content_hash,created_by) values($1,$2,'HQ','Head office',$3,$4) returning id",[T.id,entity,hash('b'),principal])).rows[0].id;
 const book=(await run(owner,T.id,"insert into lara.books(tenant_id,entity_id,code,kind,functional_currency,status,created_by) values($1,$2,'PHP-MAIN','primary','PHP','active',$3) returning id",[T.id,entity,principal])).rows[0].id;
 const party=(await run(owner,T.id,"insert into lara.party(tenant_id,entity_id,legal_name,identity_status,status,content_hash,created_by) values($1,$2,'Alpha Retail','unknown','active',$3,$4) returning id",[T.id,entity,hash('p'),principal])).rows[0].id;
 const doc=(await run(api,T.id,"insert into lara.documents(tenant_id,entity_id,book_id,kind,branch_id,party_id,document_date,accounting_date,currency,rule_profile_version,payload_hash,created_by,net,tax,gross) values($1,$2,$3,'invoice',$4,$5,'2026-10-01','2026-10-01','PHP','ph-2026',$6,$7,1000,0,1000) returning id",[T.id,entity,book,branch,party,hash('d'),principal])).rows[0].id;
 const inviteSql="insert into lara.portal_invites(tenant_id,entity_id,party_id,email_hash,email_masked,role,token_hash,expires_at,content_hash,created_by) values($1,$2,$3,$4,'o***@alpha.invalid',$5,$6,$7,$8,$9) returning id";
 const soon=new Date(Date.now()+86400000).toISOString();
 const inv=(await run(api,T.id,inviteSql,[T.id,entity,party,hash('mail'),'customer',hash('t1'),soon,hash('c1'),principal])).rows[0].id;
 await rejects(run(api,T.id,inviteSql,[T.id,entity,party,hash('mail'),'customer',hash('t1'),soon,hash('c1'),principal]),/duplicate key/,'same token hash twice');
 await rejects(run(api,T.id,inviteSql,[T.id,entity,party,hash('mail'),'owner',hash('t2'),soon,hash('c1'),principal]),/check constraint|violates/,'unknown role');
 await rejects(run(api,T.id,"update lara.portal_invites set state='accepted' where id=$1",[inv]),/check constraint|violates/,'accepted without a principal');
 await rejects(run(api,T.id,"update lara.portal_invites set state='revoked' where id=$1",[inv]),/check constraint|violates/,'revoked without a reason');
 await rejects(run(api,T.id,"update lara.portal_invites set role='supplier' where id=$1",[inv]),/content version/,'scope change without a version bump');
 await run(api,T.id,"update lara.portal_invites set state='accepted',accepted_principal_id=$2,accepted_at=now() where id=$1",[inv,external]);
 await rejects(run(api,T.id,"update lara.portal_invites set state='pending' where id=$1",[inv]),/never reopened/,'accepted invite reopened');
 const memSql="insert into lara.portal_memberships(tenant_id,entity_id,principal_id,party_id,invite_id,role,allowed_kinds,created_by) values($1,$2,$3,$4,$5,'customer',$6,$3) returning id";
 const mem=(await run(api,T.id,memSql,[T.id,entity,external,party,inv,['invoice','statement']])).rows[0].id;
 await rejects(run(api,T.id,memSql,[T.id,entity,external,party,inv,['invoice']]),/duplicate key/,'two memberships for one principal and party');
 await rejects(run(api,T.id,memSql,[T.id,entity,principal,party,inv,[]]),/check constraint|violates/,'no allowed kinds');
 await rejects(run(api,T.id,"update lara.portal_memberships set status='revoked' where id=$1",[mem]),/check constraint|violates/,'revoked without a reason');
 pass('invites carry a unique token hash, an enumerated role, need a principal to accept and a reason to revoke and are final once accepted; memberships are one per principal and party with at least one allowed kind');

 const shareSql="insert into lara.share_grants(tenant_id,entity_id,resource_type,resource_id,recipient_party_id,token_hash,expires_at,created_by) values($1,$2,'document',$3,$4,$5,$6,$7) returning id";
 await run(api,T.id,shareSql,[T.id,entity,doc,party,hash('s1'),soon,principal]);
 await rejects(run(api,T.id,shareSql,[T.id,entity,doc,party,hash('s1'),soon,principal]),/duplicate key/,'same share token twice');
 await rejects(run(api,T.id,"insert into lara.share_grants(tenant_id,entity_id,resource_type,resource_id,token_hash,expires_at,created_by) values($1,$2,'ledger',$3,$4,$5,$6)",[T.id,entity,doc,hash('s3'),soon,principal]),/check constraint|violates/,'unknown resource type');
 const msgSql="insert into lara.message_requests(tenant_id,entity_id,source_type,source_id,recipient_party_id,channel,template_version,content_hash,created_by) values($1,$2,'document',$3,$4,'email','invoice-2026',$5,$6) returning id";
 const msg=(await run(api,T.id,msgSql,[T.id,entity,doc,party,hash('m1'),principal])).rows[0].id;
 await rejects(run(api,T.id,"insert into lara.message_requests(tenant_id,entity_id,source_type,source_id,recipient_party_id,channel,template_version,content_hash,created_by) values($1,$2,'document',$3,$4,'sms','x',$5,$6)",[T.id,entity,doc,party,hash('m2'),principal]),/check constraint|violates/,'unknown channel');
 await rejects(run(api,T.id,"update lara.message_requests set state='authorized',authorized_by=$2,authorized_at=now(),send_key='k1' where id=$1",[msg,principal]),/check constraint|violates/,'authorized by the drafter');
 await rejects(run(api,T.id,"update lara.message_requests set state='authorized',authorized_by=$2,authorized_at=now() where id=$1",[msg,approver]),/check constraint|violates/,'authorized without a send key');
 await rejects(run(api,T.id,"update lara.message_requests set state='sent',provider_reference='r' where id=$1",[msg]),/cannot move from draft|check constraint|violates/,'draft straight to sent');
 await run(api,T.id,"update lara.message_requests set state='authorized',authorized_by=$2,authorized_at=now(),send_key='k1' where id=$1",[msg,approver]);
 await rejects(run(api,T.id,"update lara.message_requests set channel='portal' where id=$1",[msg]),/never changes/,'authorized message changed');
 await rejects(run(api,T.id,"insert into lara.message_requests(tenant_id,entity_id,source_type,source_id,recipient_party_id,channel,template_version,content_hash,created_by,state,authorized_by,authorized_at,send_key) values($1,$2,'document',$3,$4,'email','x',$5,$6,'authorized',$7,now(),'k1')",[T.id,entity,doc,party,hash('m3'),principal,approver]),/duplicate key/,'same send key twice');
 await run(api,T.id,"update lara.message_requests set state='sending',attempts=1 where id=$1",[msg]);
 await rejects(run(api,T.id,"update lara.message_requests set state='sent' where id=$1",[msg]),/check constraint|violates/,'sent without a provider reference');
 const rcSql="insert into lara.delivery_receipts(tenant_id,entity_id,message_request_id,attempt,provider,outcome,provider_reference,error) values($1,$2,$3,$4,'local-mail',$5,$6,$7) returning id";
 const rc=(await run(api,T.id,rcSql,[T.id,entity,msg,1,'failed',null,'relay down'])).rows[0].id;
 await rejects(run(api,T.id,rcSql,[T.id,entity,msg,1,'sent','ref',null]),/duplicate key/,'two receipts for one attempt');
 await rejects(run(api,T.id,rcSql,[T.id,entity,msg,2,'sent',null,null]),/check constraint|violates/,'sent without a reference');
 await rejects(run(api,T.id,"update lara.delivery_receipts set outcome='sent' where id=$1",[rc]),/APPEND_ONLY|permission denied/,'receipt edited');
 await run(api,T.id,"update lara.message_requests set state='sent',provider_reference='local:1' where id=$1",[msg]);
 await rejects(run(api,T.id,"update lara.message_requests set state='authorized' where id=$1",[msg]),/final/,'sent message reopened');
 pass('share tokens are unique with enumerated resource types; a message is authorized only by another principal with a unique send key, never changes afterwards, needs a provider reference to be sent and is final; receipts are one per attempt, need a reference when sent and are append-only');

 const piSql="insert into lara.provider_payment_intents(tenant_id,entity_id,document_id,amount,currency,provider,provider_key,expires_at,status,content_hash,created_by) values($1,$2,$3,$4,'PHP','fixture-pay',$5,$6,'pending',$7,$8) returning id";
 const pi=(await run(api,T.id,piSql,[T.id,entity,doc,1000,'pi_1',soon,hash('pi1'),principal])).rows[0].id;
 await rejects(run(api,T.id,piSql,[T.id,entity,doc,500,'pi_2',soon,hash('pi2'),principal]),/one_live|duplicate key/,'two live intents for one invoice');
 await rejects(run(api,T.id,piSql,[T.id,entity,doc,0,'pi_3',soon,hash('pi3'),principal]),/check constraint|violates/,'zero amount');
 await rejects(run(api,T.id,"update lara.provider_payment_intents set amount=999 where id=$1",[pi]),/never changes/,'live intent amount changed');
 await rejects(run(api,T.id,"update lara.provider_payment_intents set status='settled' where id=$1",[pi]),/cannot move from pending|check constraint|violates/,'pending straight to settled');
 await rejects(run(api,T.id,"update lara.provider_payment_intents set status='paid' where id=$1",[pi]),/check constraint|violates/,'paid without a time');
 await run(api,T.id,"update lara.provider_payment_intents set status='paid',paid_at=now() where id=$1",[pi]);
 await rejects(run(api,T.id,"update lara.provider_payment_intents set status='cancelled',cancel_reason='x' where id=$1",[pi]),/cannot move from paid|check constraint|violates/,'paid intent cancelled');
 await rejects(run(api,T.id,"update lara.provider_payment_intents set status='settled' where id=$1",[pi]),/check constraint|violates/,'settled without a settlement');
 const whSql="insert into lara.webhook_receipts(tenant_id,provider,event_id,payload_hash,signature_state,event_type,intent_id,outcome,reason) values($1,'fixture-pay',$2,$3,$4,'payment.paid',$5,$6,null) returning id";
 const wh=(await run(api,T.id,whSql,[T.id,'evt-1',hash('w1'),'valid',pi,'applied'])).rows[0].id;
 await rejects(run(api,T.id,whSql,[T.id,'evt-1',hash('w2'),'valid',pi,'ignored']),/duplicate key/,'same provider event twice');
 await rejects(run(api,T.id,whSql,[T.id,'evt-2',hash('w3'),'forged',pi,'rejected']),/check constraint|violates/,'unknown signature state');
 await rejects(run(api,T.id,"update lara.webhook_receipts set outcome='ignored' where id=$1",[wh]),/APPEND_ONLY|permission denied/,'receipt edited');
 pass('payment intents are unique per provider key with one live intent per invoice, positive, fixed once live, paid only with a time, settled only with a settlement and final afterwards; webhook receipts are unique per provider event with enumerated verdicts and append-only');

 for(const table of ['portal_invites','portal_memberships','share_grants','message_requests','delivery_receipts','provider_payment_intents','webhook_receipts'])
  assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 assert.equal((await run(api,null,'select count(*)::int n from lara.portal_invites')).rows[0].n,0,'invites visible without a tenant');
 await rejects(run(api,other.id,inviteSql,[T.id,entity,party,hash('x'),'customer',hash('tx'),soon,hash('cx'),principal]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['portal_invites','portal_memberships','message_requests','provider_payment_intents','webhook_receipts'])await rejects(run(api,T.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security isolates tenants on every portal table and the runtime role cannot delete invites, memberships, messages, intents or receipts');
 console.log('P13-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[T.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
