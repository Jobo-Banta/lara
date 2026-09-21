// P14-01 firm workspace schema acceptance against real PostgreSQL through
// the runtime role: one firm per organization with enrolled staff; client
// mandates inside the client tenant with an approver other than the drafter,
// one live per firm, never widened once approved, final once revoked;
// assignments one per mandate and principal; aggregate snapshots keyed by
// mandate; the restricted functions answer only for the caller's own
// identity; row-level security isolates every table.
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
const F={id:randomUUID(),slug:'p02-test-firm-'+suffix},C={id:randomUUID(),slug:'p02-test-client-'+suffix},other={id:randomUUID(),slug:'p02-test-firm-other-'+suffix};
const run=async(db,tenant,sql,params=[])=>{await db.query("select set_config('lara.tenant_id',$1,false)",[tenant||'']);return db.query(sql,params);};
async function rejects(promise,pattern,label){let failed=false;try{await promise;}catch(e){failed=true;assert.match(e.message,pattern,label+': '+e.message);}assert.ok(failed,label+' should fail');}
let step=0;const pass=l=>console.log('PASS '+(++step)+': '+l);
try{
 for(const t of [F,C,other])await run(owner,t.id,"insert into lara.tenants(id,slug,name,mode) values($1,$2,$3,'demo')",[t.id,t.slug,t.slug]);
 const partner=(await run(owner,F.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Partner') returning id",[F.id,'partner-'+suffix])).rows[0].id;
 const staff=(await run(owner,F.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Staff') returning id",[F.id,'staff-'+suffix])).rows[0].id;
 const ctrl=(await run(owner,C.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Controller') returning id",[C.id,'ctrl-'+suffix])).rows[0].id;
 const dir=(await run(owner,C.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Director') returning id",[C.id,'dir-'+suffix])).rows[0].id;
 const delegate=(await run(owner,C.id,"insert into lara.principals(tenant_id,oidc_issuer,oidc_subject,display_name) values($1,'https://identity.invalid',$2,'Partner (firm)') returning id",[C.id,'partner-'+suffix])).rows[0].id;
 const entity=(await run(owner,C.id,"insert into lara.entities(tenant_id,legal_name,fiscal_year_start_month,base_currency,timezone,content_hash,created_by,status) values($1,'Client entity',1,'PHP','Asia/Manila',$2,$3,'active') returning id",[C.id,hash('e'),ctrl])).rows[0].id;
 const firmSql="insert into lara.firms(tenant_id,name,owner_principal_id,created_by) values($1,$2,$3,$3) returning id";
 const firm=(await run(api,F.id,firmSql,[F.id,'Ledger & Co',partner])).rows[0].id;
 await rejects(run(api,F.id,firmSql,[F.id,'Again',partner]),/duplicate key/,'two firms in one organization');
 await run(api,F.id,"insert into lara.firm_staff(tenant_id,firm_id,principal_id,role,created_by) values($1,$2,$3,'staff',$4)",[F.id,firm,staff,partner]);
 await rejects(run(api,F.id,"insert into lara.firm_staff(tenant_id,firm_id,principal_id,role,created_by) values($1,$2,$3,'staff',$4)",[F.id,firm,staff,partner]),/duplicate key/,'staff enrolled twice');
 await rejects(run(api,F.id,"insert into lara.firm_staff(tenant_id,firm_id,principal_id,role,created_by) values($1,$2,$3,'intern',$4)",[F.id,firm,partner,partner]),/check constraint|violates/,'unknown role');
 pass('one firm per organization; staff enrolled once with an enumerated role');

 const soon=new Date(Date.now()+30*86400000).toISOString();
 const mSql="insert into lara.client_mandates(tenant_id,entity_id,firm_id,firm_name,entity_ids,permissions,valid_to,evidence_ids,content_hash,created_by) values($1,$2,$3,'Ledger & Co',$4,$5,$6,$7,$8,$9) returning id";
 const m=(await run(api,C.id,mSql,[C.id,entity,firm,[entity],['task.read'],soon,JSON.stringify([randomUUID()]),hash('m1'),ctrl])).rows[0].id;
 await rejects(run(api,C.id,mSql,[C.id,entity,firm,[entity],['task.read'],soon,JSON.stringify([randomUUID()]),hash('m2'),ctrl]),/one_live|duplicate key/,'second live mandate for the firm');
 await rejects(run(api,C.id,mSql,[C.id,entity,firm,[],['task.read'],soon,JSON.stringify([randomUUID()]),hash('m3'),ctrl]),/check constraint|violates/,'no entities');
 await rejects(run(api,C.id,mSql,[C.id,entity,randomUUID(),[entity],['task.read'],soon,JSON.stringify([]),hash('m4'),ctrl]),/check constraint|violates|foreign key/,'no evidence or unknown firm');
 await rejects(run(api,C.id,"update lara.client_mandates set state='approved',approved_by=$2,approved_at=now() where id=$1",[m,ctrl]),/check constraint|violates/,'approved by the drafter');
 await rejects(run(api,C.id,"update lara.client_mandates set state='expired' where id=$1",[m]),/cannot move from draft|check constraint|violates/,'draft straight to expired');
 await run(api,C.id,"update lara.client_mandates set state='approved',approved_by=$2,approved_at=now() where id=$1",[m,dir]);
 await rejects(run(api,C.id,"update lara.client_mandates set permissions=array['task.read','journal.post'] where id=$1",[m]),/never widens/,'approved mandate widened');
 await rejects(run(api,C.id,"update lara.client_mandates set valid_to=now()+interval '400 days' where id=$1",[m]),/never widens/,'approved mandate extended');
 await run(api,C.id,"update lara.client_mandates set permissions=array['task.read'] where id=$1",[m]);
 const aSql="insert into lara.client_assignments(tenant_id,entity_id,mandate_id,principal_id,firm_principal_id,firm_role,entity_ids,permission_subset,created_by) values($1,$2,$3,$4,$5,'partner',$6,$7,$8) returning id";
 const a=(await run(api,C.id,aSql,[C.id,entity,m,delegate,partner,[entity],['task.read'],dir])).rows[0].id;
 await rejects(run(api,C.id,aSql,[C.id,entity,m,delegate,partner,[entity],['task.read'],dir]),/duplicate key/,'two assignments for one mandate and principal');
 await rejects(run(api,C.id,aSql,[C.id,entity,m,dir,partner,[entity],[],ctrl]),/check constraint|violates/,'empty subset');
 await rejects(run(api,C.id,"update lara.client_assignments set state='revoked' where id=$1",[a]),/check constraint|violates/,'revoked without a reason');
 pass('mandates are one live per firm with entities, permissions, evidence and an approver other than the drafter, never widened or extended once approved; assignments are one per mandate and principal with a non-empty subset and a reason to revoke');

 const scopes=(await run(api,F.id,'select * from lara.firm_scopes($1,$2)',['https://identity.invalid','partner-'+suffix])).rows;
 assert.equal(scopes.length,1);assert.equal(scopes[0].client_tenant_id,C.id);assert.deepEqual(scopes[0].permissions,['task.read']);
 assert.equal((await run(api,F.id,'select * from lara.firm_scopes($1,$2)',['https://identity.invalid','staff-'+suffix])).rows.length,0,'unassigned staff hold no scope');
 const agg=(await run(api,F.id,'select lara.firm_aggregate($1,$2,$3,$4) as c',['https://identity.invalid','partner-'+suffix,C.id,entity])).rows[0].c;
 assert.equal(agg.openTasks,0);assert.equal(agg.mandateId,m);assert.ok(!('openItems' in agg),'no open_item.read, no open items');
 await rejects(run(api,F.id,'select lara.firm_aggregate($1,$2,$3,$4)',['https://identity.invalid','staff-'+suffix,C.id,entity]),/FORBIDDEN/,'aggregate for an unheld scope');
 const snapSql="insert into lara.aggregate_snapshots(tenant_id,firm_id,actor_principal_id,mandate_id,client_tenant_id,client_entity_id,scope_hash,counts) values($1,$2,$3,$4,$5,$6,$7,'{\"openTasks\":0}') returning id";
 await run(api,F.id,snapSql,[F.id,firm,partner,m,C.id,entity,hash('s')]);
 await rejects(run(api,F.id,snapSql,[F.id,firm,partner,m,C.id,entity,hash('s')]),/duplicate key/,'one snapshot per actor and scope');
 await rejects(run(api,F.id,'select lara.firm_invalidate_snapshots($1)',[m]),/FORBIDDEN/,'the firm cannot invalidate a client\'s mandate snapshots');
 assert.equal((await run(api,C.id,'select lara.firm_invalidate_snapshots($1) as n',[m])).rows[0].n,1,'the client invalidates across tenants');
 assert.equal((await run(api,F.id,'select count(*)::int as n from lara.aggregate_snapshots')).rows[0].n,0);
 await run(api,C.id,"update lara.client_mandates set state='revoked',revoked_reason='ended',revoked_at=now() where id=$1",[m]);
 await rejects(run(api,C.id,"update lara.client_mandates set state='approved' where id=$1",[m]),/final/,'revoked mandate reopened');
 assert.equal((await run(api,F.id,'select * from lara.firm_scopes($1,$2)',['https://identity.invalid','partner-'+suffix])).rows.length,0,'no scope from a revoked mandate');
 pass('the restricted functions resolve scopes and aggregates for the caller\'s identity only, aggregates carry only the reads assigned, snapshots are one per actor and scope and invalidated by the client across tenants, and a revoked mandate is final and yields no scope');

 for(const table of ['firms','firm_staff','aggregate_snapshots'])assert.equal((await run(api,other.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' visible across tenants');
 for(const table of ['client_mandates','client_assignments'])assert.equal((await run(api,F.id,'select count(*)::int n from lara.'+table)).rows[0].n,0,table+' of the client visible to the firm');
 assert.equal((await run(api,null,'select count(*)::int n from lara.firms')).rows[0].n,0,'firms visible without a tenant');
 await rejects(run(api,other.id,firmSql,[F.id,'Intruder',partner]),/row-level security|violates/,'writing into another tenant');
 for(const table of ['firms','client_mandates','client_assignments'])await rejects(run(api,C.id,'delete from lara.'+table),/permission denied/,table+' deleted by the application');
 pass('row-level security keeps firm records in the firm tenant and mandates and assignments in the client tenant; the runtime role cannot delete them');
 console.log('P14-01 schema acceptance passed ('+step+' groups)');
}finally{
 await removeTenants(owner,[C.id,F.id,other.id]);
 await Promise.all([owner.end(),api.end()]);
}
