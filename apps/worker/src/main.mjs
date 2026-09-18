import {createRequire} from 'node:module';
import {loadLocalEnv} from '../../../scripts/local-env.mjs';
import {connectionOptions} from '../../../packages/database/src/connection.mjs';
loadLocalEnv();
const pg=createRequire(new URL('../../api/package.json',import.meta.url))('pg');
if(!process.env.SUPABASE_LARA_WORKER_DATABASE_URL && !process.env.WORKER_DATABASE_URL)throw Error('Worker runtime connection required');
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
while(!stopping){
 const db=new pg.Client(connectionOptions(process.env.WORKER_DATABASE_URL||process.env.SUPABASE_LARA_WORKER_DATABASE_URL));
 try{await db.connect();await db.query('select version from public.schema_migrations limit 1');console.log(JSON.stringify({service:'worker',event:'heartbeat',status:'ready',time:new Date().toISOString()}));}
 catch{console.error(JSON.stringify({service:'worker',event:'dependency_unavailable',severity:'error',time:new Date().toISOString()}));}
 finally{await db.end().catch(()=>{});}
 for(let i=0;i<30&&!stopping;i++)await new Promise(r=>setTimeout(r,1000));
}
