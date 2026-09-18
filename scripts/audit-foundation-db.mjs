import { connectionOptions } from '../packages/database/src/connection.mjs';
import { createRequire } from 'node:module';
import { loadLocalEnv } from './local-env.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL));
await db.connect();
try {
 const version=await db.query('show server_version');
 const migrations=await db.query('select version,sha256 from schema_migrations order by version');
 const roles=await db.query("select rolname,rolsuper,rolbypassrls from pg_roles where rolname in ('lara_api','lara_worker','lara_audit_reader','lara_migrator')");
 const tables=await db.query("select tablename,rowsecurity from pg_tables where schemaname='lara_demo' order by tablename");
 const report={checked_at:new Date().toISOString(),postgres:version.rows[0].server_version,migrations:migrations.rows,roles:roles.rows,demo_tables:tables.rows};
 await mkdir('.local/verification',{recursive:true});
 await writeFile('.local/verification/p00-database-audit.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
} finally {await db.end();}
