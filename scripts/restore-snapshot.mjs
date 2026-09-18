import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {restoreRehearsal} from './snapshot-lib.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const data=JSON.parse(await readFile(process.env.BACKUP_OUTPUT||'.local/backups/lara-phase0.json','utf8'));
const db=new pg.Client(connectionOptions(process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL));
await db.connect();
try{console.log(JSON.stringify({verified:true,counts:await restoreRehearsal(db,data),rollback:true}));}finally{await db.end();}
