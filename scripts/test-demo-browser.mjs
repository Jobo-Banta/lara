import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {loadLocalEnv} from './local-env.mjs';
import {connectionOptions} from '../packages/database/src/connection.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../packages/database/package.json',import.meta.url))('pg');
import {spawnSync} from 'node:child_process';
import {removeTenants} from './tenant-teardown.mjs';
const db=new pg.Client({...connectionOptions(process.env.SUPABASE_OWNER_DATABASE_URL),connectionTimeoutMillis:10000,query_timeout:15000});
const sub='test-browser-'+randomUUID(),suffix=randomUUID().slice(0,8);
await db.connect();
let tenantId=null;
try{
 await db.query("insert into lara_demo.runs(id,fixture_version,label,owner_subject) values($1,'browser-test','Synthetic browser acceptance',$1)",[sub]);
 // A workspace tenant for the local-mode servers; the browser identities are ci-workspace-<role>-<suffix>.
 const provision=spawnSync(process.execPath,['scripts/provision-workspace-tenant.mjs','--slug','api-e2e-'+suffix,'--name','Browser acceptance','--mode','demo','--issuer','https://identity.invalid','--controller','ci-workspace-controller-'+suffix,'--security','ci-workspace-security-'+suffix,'--preparer','ci-workspace-preparer-'+suffix,'--clerk','ci-workspace-clerk-'+suffix,'--billing','ci-workspace-billing-'+suffix,'--json'],{encoding:'utf8'});
 if(provision.status!==0)throw Error('Provisioning failed: '+provision.stderr);
 tenantId=JSON.parse(provision.stdout.trim().split(/\r?\n/).at(-1)).tenant.id;
 const child=spawn(process.platform==='win32'?'pnpm.cmd':'pnpm',['test:e2e','--workers=2','--reporter=line'],{shell:process.platform==='win32',stdio:'inherit',env:{...process.env,LARA_E2E_DATABASE_URL:process.env.DATABASE_URL,LARA_E2E_SUBJECT:sub,LARA_E2E_WORKSPACE_SUFFIX:suffix}});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});process.exitCode=code||0;
}finally{await db.query('delete from lara_demo.workspaces where owner_subject=$1',[sub]);await db.query('delete from lara_demo.runs where id=$1',[sub]);if(tenantId)await removeTenants(db,[tenantId]);await db.end();}
