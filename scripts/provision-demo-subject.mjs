import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
const subject=process.argv[2];
if(process.env.LARA_MODE!=='demo') throw new Error('Provisioning requires demo mode');
if(!subject || subject.length>255 || /\s/.test(subject)) throw new Error('Usage: node scripts/provision-demo-subject.mjs <verified-oidc-subject>');
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
const db=new pg.Client(connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL || process.env.MIGRATION_DATABASE_URL));
await db.connect();
try{
 const result=await db.query("insert into lara_demo.runs(id,fixture_version,label,owner_subject) values($1,'phase1-v1','LARA Demo Finance',$2) on conflict (owner_subject) where owner_subject is not null do update set owner_subject=excluded.owner_subject returning id",['demo-'+randomUUID(),subject]);
 console.log('Assigned isolated demo run: '+result.rows[0].id);
 console.log('The run starts empty. This command never grants production access or assigns existing shared fixtures.');
}finally{await db.end();}
