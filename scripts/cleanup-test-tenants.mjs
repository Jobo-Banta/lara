// Removes tenants left behind by interrupted P02 test runs (slugs prefixed
// p02-test-, dom-, api-). Runs as the bypass owner with the maintenance flag;
// refuses anything else. Engineering databases only.
import {createRequire} from 'node:module';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL||process.env.MIGRATION_DATABASE_URL));
await db.connect();
try{
 const role=(await db.query('select current_user as name,(select rolbypassrls or rolsuper from pg_roles where rolname=current_user) as privileged')).rows[0];
 if(!role.privileged)throw Error('Cleanup requires a bypass owner connection');
 await db.query("select set_config('lara.maintenance','teardown',false)");
 const tenants=(await db.query("select id,slug from lara.tenants where slug ~ '^(p02-test-|dom-|api-)'")).rows;
 for(const t of tenants){
  await db.query("select set_config('lara.tenant_id',$1,false)",[t.id]);
  for(const table of ['audit_events','audit_chain_heads','inbox_receipts','outbox_events','jobs','command_receipts','approval_decisions','approval_requests','obligations','task_comments','tasks','evidence_links','party_bank_accounts','party_roles','party','evidence','settings_versions','onboarding_checks','capability_activations','approval_policies','delegation','memberships','roles','principals','books','branches','entities']){
   if(table==='inbox_receipts')await db.query('delete from lara.inbox_receipts where event_id in (select event_id from lara.outbox_events where tenant_id=$1)',[t.id]);
   else await db.query('delete from lara.'+table+' where tenant_id=$1',[t.id]);
  }
  await db.query('delete from lara.tenants where id=$1',[t.id]);
  console.log('removed',t.slug);
 }
 const left=(await db.query('select (select count(*)::int from lara.tenants) tenants,(select count(*)::int from lara.principal_directory) directory,(select count(*)::int from lara.audit_events) audit')).rows[0];
 console.log(JSON.stringify({removed:tenants.length,remaining:left}));
}finally{await db.end();}
