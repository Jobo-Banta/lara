import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client({...connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL),connectionTimeoutMillis:10000,query_timeout:15000});
const sub='test-browser-'+randomUUID();
await db.connect();
try{
 await db.query("insert into lara_demo.runs(id,fixture_version,label,owner_subject) values($1,'browser-test','Synthetic browser acceptance',$1)",[sub]);
 const child=spawn(process.platform==='win32'?'pnpm.cmd':'pnpm',['test:e2e','--workers=2','--reporter=line'],{shell:process.platform==='win32',stdio:'inherit',env:{...process.env,LARA_E2E_DATABASE_URL:process.env.DATABASE_URL,LARA_E2E_SUBJECT:sub}});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});process.exitCode=code||0;
}finally{await db.query('delete from lara_demo.workspaces where owner_subject=$1',[sub]);await db.query('delete from lara_demo.runs where id=$1',[sub]);await db.end();}
