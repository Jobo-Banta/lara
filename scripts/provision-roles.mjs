import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
if(process.env.LARA_MODE!=='demo')throw Error('Engineering role provisioning requires demo mode');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const url=new URL(process.env.SUPABASE_OWNER_DATABASE_URL||process.env.DATABASE_ADMIN_URL);
const db=new pg.Client(connectionOptions(url.toString()));await db.connect();
const added=[];
try{
 await db.query('begin');
 for(const role of ['lara_api','lara_worker','lara_audit_reader','lara_migrator']){
  const existing=await db.query('select rolname,rolsuper,rolbypassrls from pg_roles where rolname=$1',[role]);
  if(existing.rowCount){if(existing.rows[0].rolsuper||existing.rows[0].rolbypassrls)throw Error('Unsafe existing runtime or migrator role: '+role);continue;}
  const password=randomBytes(40).toString('hex');
  await db.query('create role '+role+" login nosuperuser nocreatedb nocreaterole nobypassrls password '"+password+"'");
  if(role==='lara_migrator'){
   const who=(await db.query('select current_user as name,current_database() as db')).rows[0];
   const quote=s=>'"'+s.replaceAll('"','""')+'"';
   await db.query('grant '+role+' to '+quote(who.name));
   await db.query('grant create on database '+quote(who.db)+' to '+role);
   await db.query('grant usage,create on schema public to '+role);
  }
  const connection=new URL(url);const suffix=url.username.includes('.')?'.'+url.username.split('.').slice(1).join('.'):'';
  connection.username=role+suffix;connection.password=password;connection.search='?sslmode=verify-full';
  added.push('SUPABASE_'+role.toUpperCase()+'_DATABASE_URL='+connection.toString());
 }
 await db.query('commit');
 if(added.length)await appendFile(new URL('../.env.local',import.meta.url),'\n'+added.join('\n')+'\n');
 console.log('Provisioned '+added.length+' missing roles; existing credentials preserved. New credentials saved only to ignored .env.local.');
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
