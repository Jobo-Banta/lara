import { connectionOptions } from '../packages/database/src/connection.mjs';
import { createRequire } from 'node:module';
import { loadLocalEnv } from './local-env.mjs';
loadLocalEnv();
if (process.env.LARA_MODE !== 'demo') throw new Error('Demo seeding requires LARA_MODE=demo');
if (process.env.DEMO_DATABASE_CONFIRMED !== 'true') throw new Error('Explicit demo database confirmation required');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.DATABASE_URL));
await db.connect();
try { await db.query("insert into lara.demo_seed_runs(fixture_version,row_count) values($1,$2)",['phase0-v1',0]); }
finally { await db.end(); }
console.log('Demo seed complete.');
