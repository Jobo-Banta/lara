import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const owner=new pg.Client(connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL));
const runtime=new pg.Client(connectionOptions(process.env.DATABASE_URL));
const prefix='test-isolation-'+randomUUID(), a=prefix+'-a',b=prefix+'-b';
await owner.connect();await runtime.connect();
try {
 await owner.query("insert into lara_demo.runs(id,fixture_version,label,owner_subject) values($1,'p00-test','Synthetic isolation A',$1),($2,'p00-test','Synthetic isolation B',$2)",[a,b]);
 await owner.query("insert into lara_demo.tasks(id,run_id,title,area,status,due_date,owner,source) values($1,$1,'Test A','Test','Open','2026-09-18','Test','synthetic'),($2,$2,'Test B','Test','Open','2026-09-18','Test','synthetic')",[a,b]);
 await runtime.query('begin');
 assert.equal((await runtime.query('select id from lara_demo.tasks where id=any($1::text[])',[[a,b]])).rowCount,0);
 await runtime.query("select set_config('lara.subject',$1,true)",[a]);
 const visible=await runtime.query('select id from lara_demo.tasks where id=any($1::text[])',[[a,b]]);
 assert.deepEqual(visible.rows,[{id:a}]);
 assert.equal((await runtime.query("update lara_demo.tasks set status='Changed' where id=$1",[b])).rowCount,0);
 await runtime.query('savepoint forbidden_insert');
 await assert.rejects(runtime.query("insert into lara_demo.tasks(id,run_id,title,area,status,due_date,owner,source) values($1,$2,'Intrusion','Test','Open','2026-09-18','Test','synthetic')",[prefix+'-intrusion',b]),e=>e.code==='42501');
 await runtime.query('rollback to savepoint forbidden_insert');
 await runtime.query('savepoint disable_rls');
 await assert.rejects(runtime.query('alter table lara_demo.tasks disable row level security'),e=>e.code==='42501');
 await runtime.query('rollback to savepoint disable_rls');
 await runtime.query('commit');
 assert.equal((await runtime.query('select id from lara_demo.tasks where id=any($1::text[])',[[a,b]])).rowCount,0);
 const unchanged=await owner.query('select status from lara_demo.tasks where id=$1',[b]);assert.equal(unchanged.rows[0].status,'Open');
 console.log('PASS: missing scope denial, own-run visibility, cross-run read/write/insert denial, RLS alteration denial and transaction scope cleanup');
}finally{
 await runtime.query('rollback').catch(()=>{});
 await owner.query('delete from lara_demo.tasks where id=any($1::text[])',[[a,b,prefix+'-intrusion']]);
 await owner.query('delete from lara_demo.runs where id=any($1::text[])',[[a,b]]);
 await runtime.end();await owner.end();
}
