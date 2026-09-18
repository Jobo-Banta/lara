import {loadLocalEnv} from './local-env.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
loadLocalEnv();
const traces=[];
const collector=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;traces.push(JSON.parse(body));res.writeHead(200,{'content-type':'application/json'});res.end('{}');});
await new Promise(resolve=>collector.listen(0,'127.0.0.1',resolve));
const endpoint='http://127.0.0.1:'+collector.address().port;
async function exercise(database,expected){
 const child=spawn(process.execPath,['apps/api/src/server.mjs'],{env:{...process.env,API_PORT:'4012',DATABASE_URL:database,OTEL_EXPORTER_OTLP_ENDPOINT:endpoint},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 try{
  let live;for(let i=0;i<50;i++){try{live=await fetch('http://127.0.0.1:4012/health/live');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.equal(live?.status,200);
  const ready=await fetch('http://127.0.0.1:4012/health/ready');assert.equal(ready.status,expected);
  assert.match(ready.headers.get('x-trace-id'),/^[a-f0-9]{32}$/);
  if(expected===503)assert.equal((await ready.json()).error,'Dependency unavailable');
  for(let i=0;i<40&&!output.includes('"status":'+expected);i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(output.includes('"status":'+expected));
  assert.ok(!output.includes(database));
  if(expected===503)assert.ok(output.includes('"event":"request_completed"'));
 }finally{const exited=once(child,'exit');child.kill();await exited;}
}
try{
 await exercise('postgresql://lara_api:readiness-test-secret@127.0.0.1:1/postgres',503);
 await exercise(process.env.DATABASE_URL,200);
 for(let i=0;i<40&&traces.length<4;i++)await new Promise(r=>setTimeout(r,50));
 const spans=traces.flatMap(t=>t.resourceSpans.flatMap(r=>r.scopeSpans.flatMap(s=>s.spans)));
 assert.ok(spans.some(s=>s.status.code===2));assert.ok(spans.some(s=>s.status.code===1));
 assert.ok(!JSON.stringify(traces).includes('readiness-test-secret'));
 console.log('PASS: unavailable DB gives live 200/ready 503, safe stderr alert, OTLP trace; healthy replacement recovers ready 200');
}finally{collector.closeAllConnections();await new Promise(resolve=>collector.close(resolve));}
