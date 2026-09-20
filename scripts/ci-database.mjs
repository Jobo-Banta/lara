import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {applyMigrations} from '../packages/database/src/runner.mjs';
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const adminURL=new URL(process.env.CI_DATABASE_URL||'postgresql://postgres:postgres@127.0.0.1:5432/postgres');
if(!['127.0.0.1','localhost'].includes(adminURL.hostname)||!process.env.CI)throw Error('CI database rehearsal only runs on ephemeral loopback PostgreSQL');
const admin=new pg.Client({connectionString:adminURL.toString()});await admin.connect();
const passwords={};
try{
 for(const role of ['lara_api','lara_worker','lara_audit_reader','lara_migrator']){
  const password=randomBytes(32).toString('hex');passwords[role]=password;
  if(!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await admin.query('create role '+role+' login nosuperuser nobypassrls password '+ "'"+password+"'");
 }
 const dir=new URL('../packages/database/migrations/',import.meta.url);
 const files=await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.sql')).sort().map(async n=>({version:n.slice(0,-4),sql:await readFile(new URL(n,dir),'utf8')})));
 for(const [name,upgrade] of [['lara_ci_clean',false],['lara_ci_upgrade',true]]){
  await admin.query('create database '+name+' owner lara_migrator');
  const migrationURL=new URL(adminURL);migrationURL.pathname='/'+name;migrationURL.username='lara_migrator';migrationURL.password=passwords.lara_migrator;
  const db=new pg.Client({connectionString:migrationURL.toString()});await db.connect();
  try{if(upgrade)await applyMigrations(db,files.slice(0,1));await applyMigrations(db,files);if((await applyMigrations(db,files)).length)throw Error('Migration replay changed database');}finally{await db.end();}
  const ownerURL=new URL(adminURL);ownerURL.pathname='/'+name;
  const runtimeURL=new URL(ownerURL);runtimeURL.username='lara_api';runtimeURL.password=passwords.lara_api;
  const workerURL=new URL(ownerURL);workerURL.username='lara_worker';workerURL.password=passwords.lara_worker;
  const env={...process.env,LARA_MODE:'demo',APP_BASE_URL:'http://localhost:3000',API_INTERNAL_URL:'http://127.0.0.1:4000',OIDC_ISSUER:'https://identity.invalid',OIDC_CLIENT_ID:'ci',OIDC_CLIENT_SECRET:'ci',SESSION_SECRET:'ci-test-session-key-32-characters-long',OBJECT_ADAPTER:'filesystem',OBJECT_BUCKET:'.local/ci',OBJECT_REGION:'local',MAIL_ADAPTER:'local',EINVOICE_ADAPTER:'fixture',AI_ADAPTER:'fixture',RULE_PROFILE_ID:'fixture-ci',WORKER_DATABASE_URL:workerURL.toString(),SUPABASE_OWNER_DATABASE_URL:ownerURL.toString(),MIGRATION_DATABASE_URL:ownerURL.toString(),LARA_MIGRATOR_DATABASE_URL:migrationURL.toString(),DATABASE_URL:runtimeURL.toString()};
  for(const script of ['scripts/test-foundation-db.mjs','scripts/test-subject-isolation.mjs','scripts/test-restore.mjs','scripts/test-api-readiness.mjs','scripts/test-readiness-recovery.mjs','scripts/test-worker.mjs','scripts/test-demo-workflows.mjs','scripts/test-p02-schema.mjs','scripts/test-p02-domain.mjs','scripts/test-p02-api.mjs','scripts/test-p03-schema.mjs','scripts/test-p03-domain.mjs','scripts/test-p03-api.mjs','scripts/test-p04-schema.mjs','scripts/test-p04-domain.mjs','scripts/test-p04-api.mjs','scripts/test-p05-schema.mjs','scripts/test-p05-domain.mjs','scripts/test-p05-api.mjs','scripts/test-p06-schema.mjs','scripts/test-p06-domain.mjs','scripts/test-p06-api.mjs']){
   const result=spawnSync(process.execPath,[script],{env,stdio:'inherit'});if(result.status!==0)throw Error(script+' failed');
  }
  if(!upgrade){
   const fixtures=new pg.Client({connectionString:ownerURL.toString()});await fixtures.connect();
   try{await fixtures.query("insert into lara_demo.runs(id,fixture_version,label,owner_subject) values('ci-browser','ci','CI browser','ci-browser-subject')");await fixtures.query("insert into lara_demo.tasks(id,run_id,title,area,status,due_date,owner,source) values('ci-browser-task','ci-browser','CI seeded isolated task','Demo','Open','2026-09-18','Test','Synthetic')");}finally{await fixtures.end();}
   // Workspace tenant for the production-composition browser tests (LARA_MODE=local servers).
   const provision=spawnSync(process.execPath,['scripts/provision-workspace-tenant.mjs','--slug','api-ci-workspace','--name','CI workspace','--mode','demo','--issuer','https://identity.invalid','--controller','ci-workspace-controller-ci','--security','ci-workspace-security-ci','--preparer','ci-workspace-preparer-ci','--clerk','ci-workspace-clerk-ci','--billing','ci-workspace-billing-ci','--treasury','ci-workspace-treasury-ci'],{env,stdio:'inherit'});if(provision.status!==0)throw Error('Workspace provisioning failed');
   const result=spawnSync('pnpm',['test:e2e'],{env:{...env,LARA_E2E_DATABASE_URL:runtimeURL.toString(),LARA_E2E_WORKSPACE_SUFFIX:'ci'},stdio:'inherit'});if(result.status!==0)throw Error('Seeded browser test failed');
   // Load profile asserted only here, on the local database (07-security operational profile).
   const load=spawnSync(process.execPath,['scripts/test-p02-load.mjs'],{env:{...env,LARA_LOAD_ASSERT:'1'},stdio:'inherit'});if(load.status!==0)throw Error('scripts/test-p02-load.mjs failed');
  }
  console.log('PASS: '+name+' real database migration, permissions, RLS and restore');
 }
}finally{await admin.end();}
