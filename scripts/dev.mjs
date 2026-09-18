import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {loadLocalEnv} from './local-env.mjs';
loadLocalEnv();
const webRequire=createRequire(new URL('../apps/web/package.json',import.meta.url));
const children=[];
function start(args,cwd){const child=spawn(process.execPath,args,{cwd,env:{...process.env},stdio:'inherit'});children.push(child);child.once('exit',code=>{if(code){stop();process.exitCode=code;}});return child;}
function stop(){for(const child of children)child.kill();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
const trackerPort=Number(process.env.LARA_TRACKER_PORT || 8765);
let trackerRunning=false;
try{const response=await fetch('http://127.0.0.1:'+trackerPort+'/_tracker/health',{signal:AbortSignal.timeout(500)});trackerRunning=response.ok && (await response.json()).service==='lara-build-tracker';}catch{}
if(!trackerRunning) start(['scripts/serve-build-status.mjs']);
start(['--watch','apps/api/src/server.mjs']);
for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:4000/health/ready');if(r.ok)break;if(i===59)throw Error('API not ready');}catch(e){if(i===59){stop();throw e;}}await new Promise(r=>setTimeout(r,500));}
start(['apps/worker/src/main.mjs']);
start([webRequire.resolve('next/dist/bin/next'),'dev','--hostname','127.0.0.1'],new URL('../apps/web/',import.meta.url));
