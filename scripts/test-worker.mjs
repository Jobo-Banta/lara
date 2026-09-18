import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const child=spawn(process.execPath,['apps/worker/src/main.mjs'],{stdio:['ignore','pipe','pipe']});
let ready=false;child.stdout.on('data',b=>{if(b.toString().includes('"status":"ready"'))ready=true;});child.stderr.resume();
try{for(let i=0;i<100&&!ready;i++)await new Promise(r=>setTimeout(r,100));assert.ok(ready,'Worker must connect with its runtime role');console.log('PASS: worker ready with its non-owner role');}
finally{const exited=once(child,'exit');child.kill();await exited;}
