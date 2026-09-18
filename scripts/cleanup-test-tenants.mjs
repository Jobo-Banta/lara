// Removes tenants left behind by interrupted P02 test runs (slugs prefixed
// p02-test-, dom-, api-). Runs as the bypass owner with the maintenance flag;
// refuses anything else. Engineering databases only.
import {createRequire} from 'node:module';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {removeTenants} from './tenant-teardown.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL||process.env.MIGRATION_DATABASE_URL));
await db.connect();
try{
 const role=(await db.query('select current_user as name,(select rolbypassrls or rolsuper from pg_roles where rolname=current_user) as privileged')).rows[0];
 if(!role.privileged)throw Error('Cleanup requires a bypass owner connection');
 const tenants=(await db.query("select id,slug from lara.tenants where slug ~ '^(p02-test-|dom-|api-)'")).rows;
 await removeTenants(db,tenants.map(t=>t.id));
 for(const t of tenants)console.log('removed',t.slug);
 const left=(await db.query('select (select count(*)::int from lara.tenants) tenants,(select count(*)::int from lara.principal_directory) directory,(select count(*)::int from lara.audit_events) audit')).rows[0];
 console.log(JSON.stringify({removed:tenants.length,remaining:left}));
}finally{await db.end();}
