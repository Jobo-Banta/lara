import { connectionOptions } from '../packages/database/src/connection.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir,readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { loadLocalEnv } from './local-env.mjs';
import { applyMigrations } from '../packages/database/src/runner.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL || process.env.MIGRATION_DATABASE_URL));
await db.connect();
const prefix='lara_check_'+randomBytes(6).toString('hex');
const metadata=prefix+'_meta', live=prefix+'_base', demo=prefix+'_demo';
try {
 await db.query('begin');
 await db.query('create schema '+metadata);
 const dir=new URL('../packages/database/migrations/',import.meta.url);
 const files=await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.sql')).sort().map(async n=>({version:n.slice(0,-4),sql:(await readFile(new URL(n,dir),'utf8')).replace(/\blara_demo\b/g,demo).replace(/\blara\b/g,live)})));
 const opts={metadataSchema:metadata,transaction:false};
 assert.deepEqual(await applyMigrations(db,files.slice(0,1),opts),[files[0].version]);
 assert.equal((await applyMigrations(db,files,opts)).length,files.length-1);
 assert.deepEqual(await applyMigrations(db,files,opts),[]);
 assert.deepEqual(await applyMigrations(db,files.map(f=>({...f,sql:f.sql.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n')})),opts),[]);
 console.log('PASS: clean schema, prior-version upgrade and no-op rerun using real migration SQL in rollback-only namespaces');
 await assert.rejects(applyMigrations(db,[{...files[0],sql:files[0].sql+'\n-- changed'}],opts),/checksum mismatch/);
 console.log('PASS: changed checksum rejected');
 await db.query('savepoint before_failure');
 await assert.rejects(applyMigrations(db,[{version:'9999_failure',sql:'select * from '+metadata+'.missing_table'}],opts));
 await db.query('rollback to savepoint before_failure');
 assert.equal((await db.query('select count(*)::int n from '+metadata+".schema_migrations where version='9999_failure'")).rows[0].n,0);
 console.log('PASS: failed migration leaves no version metadata');
 } finally {await db.query('rollback');await db.end();}
const runtime = new pg.Client(connectionOptions(process.env.DATABASE_URL));
await runtime.connect();
try {
 await runtime.query('begin');
 await assert.rejects(runtime.query('create schema '+prefix+'_denied'), e=>e.code==='42501');
 console.log('PASS: runtime DDL denied');
} finally {await runtime.query('rollback');await runtime.end();}
console.log('Rehearsal rolled back; existing tables and data unchanged.');
