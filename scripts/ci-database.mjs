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
  const env={...process.env,SUPABASE_OWNER_DATABASE_URL:ownerURL.toString(),MIGRATION_DATABASE_URL:ownerURL.toString(),DATABASE_URL:runtimeURL.toString()};
  for(const script of ['scripts/test-foundation-db.mjs','scripts/test-subject-isolation.mjs','scripts/test-restore.mjs']){
   const result=spawnSync(process.execPath,[script],{env,stdio:'inherit'});if(result.status!==0)throw Error(script+' failed');
  }
  console.log('PASS: '+name+' real database migration, permissions, RLS and restore');
 }
}finally{await admin.end();}
