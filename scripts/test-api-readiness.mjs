import { loadLocalEnv } from './local-env.mjs';
import { signIdentity } from '../apps/api/src/identity.mjs';
loadLocalEnv();
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
const latestMigration=readdirSync(new URL('../packages/database/migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort().at(-1).slice(0,-4);
const child=spawn(process.execPath,['apps/api/src/server.mjs'],{env:{...process.env,API_PORT:'4011'},stdio:['ignore','pipe','pipe']});
let errors='';child.stderr.on('data',b=>errors+=b);
try {
 let response;
 for(let i=0;i<50;i++){try{response=await fetch('http://127.0.0.1:4011/health/live');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.equal(response?.status,200,errors);
 const r=await fetch('http://127.0.0.1:4011/health/ready');console.log('Readiness:',r.status,await r.text());
 assert.equal(r.status,200);
 assert.equal((await fetch('http://127.0.0.1:4011/ops/version')).status,401);
 assert.equal((await fetch('http://127.0.0.1:4011/demo/work')).status,401);
 const token=signIdentity('unassigned-test-subject','GET','/ops/version',process.env.SESSION_SECRET);
 const version=await fetch('http://127.0.0.1:4011/ops/version',{headers:{authorization:'Bearer '+token}});
 assert.equal(version.status,200);assert.equal((await version.json()).schema,latestMigration);
 const denied=await fetch('http://127.0.0.1:4011/demo/work',{headers:{authorization:'Bearer '+signIdentity('unassigned-test-subject','GET','/demo/work',process.env.SESSION_SECRET)}});
 assert.equal(denied.status,401);
 // P01-T03: outside demo mode the synthetic routes are not registered at all, even for a signed identity.
 const local=spawn(process.execPath,['apps/api/src/server.mjs'],{env:{...process.env,LARA_MODE:'local',DEMO_RESET_ENABLED:'false',API_PORT:'4012'},stdio:['ignore','pipe','pipe']});
 let localErrors='';local.stderr.on('data',b=>localErrors+=b);
 try{
  let live;for(let i=0;i<50;i++){try{live=await fetch('http://127.0.0.1:4012/health/live');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.equal(live?.status,200,localErrors);
  for(const path of ['/demo/workspace','/demo/command','/demo/export']){
   const absent=await fetch('http://127.0.0.1:4012'+path,{method:path==='/demo/command'?'POST':'GET',headers:{authorization:'Bearer '+signIdentity('unassigned-test-subject',path==='/demo/command'?'POST':'GET',path,process.env.SESSION_SECRET),'content-type':'application/json'},body:path==='/demo/command'?'{}':undefined});
   assert.equal(absent.status,404,path);assert.deepEqual(await absent.json(),{error:'NOT_FOUND'});
  }
 }finally{local.kill();}
 console.log('PASS: live, ready, unsigned API denial, authenticated version, session-unbound demo identity denial, demo routes absent outside demo mode');
}finally{child.kill();}
