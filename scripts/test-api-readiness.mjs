import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['apps/api/src/server.mjs'],{env:{...process.env,API_PORT:'4011'},stdio:['ignore','pipe','pipe']});
let errors='';child.stderr.on('data',b=>errors+=b);
try {
 let response;
 for(let i=0;i<50;i++){try{response=await fetch('http://127.0.0.1:4011/health/live');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.equal(response?.status,200,errors);
 const r=await fetch('http://127.0.0.1:4011/health/ready');console.log('Readiness:',r.status,await r.text());
 assert.equal(r.status,200);
 assert.equal((await fetch('http://127.0.0.1:4011/ops/version')).status,401);
 console.log('PASS: live, ready, unauthenticated version denial');
}finally{child.kill();}
