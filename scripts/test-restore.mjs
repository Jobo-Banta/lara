import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {snapshot,restoreRehearsal} from './snapshot-lib.mjs';
loadLocalEnv();const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL));
await db.connect();
try{
 const data=await snapshot(db);const counts=await restoreRehearsal(db,data);
 assert.ok(counts['public.schema_migrations']>0);
 assert.ok(counts['lara_demo.tasks']>0);
 const damaged=structuredClone(data);damaged.tables['lara_demo.tasks'].rows[0].title='corrupted';
 await assert.rejects(restoreRehearsal(db,damaged),/integrity/);
 console.log(JSON.stringify({result:'PASS',counts,corruption_rejected:true,content_hashes_verified:true}));
}finally{await db.end();}
