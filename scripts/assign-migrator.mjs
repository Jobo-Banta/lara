import {createRequire} from 'node:module';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
if(process.env.LARA_MODE!=='demo')throw Error('Ownership assignment restricted to demo');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL));
await db.connect();
try{
 await db.query('begin');
 for(const schema of ['lara','lara_demo']){
  await db.query('alter schema '+schema+' owner to lara_migrator');
  const tables=(await db.query("select tablename from pg_tables where schemaname=$1",[schema])).rows;
  for(const {tablename} of tables)await db.query('alter table '+schema+'."'+tablename.replaceAll('"','""')+'" owner to lara_migrator');
  await db.query('alter schema '+schema+' owner to lara_migrator');
 }
 await db.query('alter table public.schema_migrations owner to lara_migrator');
 await db.query('commit');console.log('Only LARA schemas and migration metadata assigned to lara_migrator.');
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
