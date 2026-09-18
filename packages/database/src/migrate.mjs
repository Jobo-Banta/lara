import { connectionOptions } from './connection.mjs';
import { readdir,readFile } from 'node:fs/promises';
import pg from 'pg';
import { loadLocalEnv } from '../../../scripts/local-env.mjs';
import { applyMigrations } from './runner.mjs';
loadLocalEnv();
const url=process.env.MIGRATION_DATABASE_URL || process.env.SUPABASE_OWNER_DATABASE_URL;
if(!url) throw new Error('MIGRATION_DATABASE_URL is required');
const dir=new URL('../migrations/',import.meta.url);
const files=await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.sql')).sort().map(async n=>({version:n.slice(0,-4),sql:await readFile(new URL(n,dir),'utf8')})));
const db=new pg.Client(connectionOptions(url));
await db.connect();
try { const applied=await applyMigrations(db,files); for(const f of files) console.log((applied.includes(f.version)?'Applied ':'Skipped ')+f.version); }
finally {await db.end();}
