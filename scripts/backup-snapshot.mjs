import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
import {snapshot} from './snapshot-lib.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.MIGRATION_DATABASE_URL||process.env.SUPABASE_OWNER_DATABASE_URL));
await db.connect();
try{const data=await snapshot(db);const out=process.env.BACKUP_OUTPUT||'.local/backups/lara-phase0.json';await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(data,null,2)+'\n');console.log('Snapshot written: '+out);}finally{await db.end();}
