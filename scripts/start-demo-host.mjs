import {spawn} from 'node:child_process';
import {loadConfig} from '../packages/config/src/env.mjs';
if(process.env.LARA_MODE!=='demo')throw Error('This host entry point is only for the synthetic demo.');
loadConfig();
const children=[];let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');process.exitCode=code;setTimeout(()=>process.exit(code),5000).unref();}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
function start(file,env){const child=spawn(process.execPath,[file],{env:{...process.env,...env},stdio:'inherit'});children.push(child);child.on('error',()=>stop(1));child.on('exit',code=>{if(!stopping)stop(code||1);});}
start('apps/api/src/server.mjs',{API_PORT:'4000',API_BIND_HOST:'127.0.0.1'});
start('apps/worker/src/main.mjs',{});
start('apps/web/server.js',{PORT:process.env.PORT||'3000',HOSTNAME:'0.0.0.0'});
