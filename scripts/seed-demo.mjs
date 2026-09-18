import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
if(process.env.LARA_MODE!=='demo')throw Error('Demo seeding requires LARA_MODE=demo');
if(process.env.DEMO_DATABASE_CONFIRMED!=='true')throw Error('Explicit demo database confirmation required');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.SEED_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL));
await db.connect();
try{
 await db.query('begin');
 const marker=await db.query("select purpose from lara.environment where id=true");
 if(marker.rows[0]?.purpose!=='demo')throw Error('Target is not a demo database');
 await db.query(await readFile(new URL('../packages/database/seeds/demo.sql',import.meta.url),'utf8'));
 const count=(await db.query("select count(*)::int n from lara_demo.tasks where run_id='demo-run-001'")).rows[0].n;
 await db.query("insert into lara.demo_seed_runs(fixture_version,row_count) values('phase1-v1',$1)",[count]);
 await db.query('commit');
 console.log('Demo fixtures seeded idempotently. Shared fixtures remain unassigned.');
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
