import {demoRequest} from './demo-service.mjs';
import {createWorkspaceApi} from './workspace-api.mjs';
import {evidenceStoreFromEnv} from '@lara/domain';
import {DemoError} from './demo-domain.mjs';
import {requestTrace,exportTrace} from '../../../packages/config/src/telemetry.mjs';
import {sessionKeys} from '../../../packages/config/src/session-keys.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { verifyIdentity } from './identity.mjs';
const scope = new AsyncLocalStorage();
import { connectionOptions } from '../../../packages/database/src/connection.mjs';
import http from "node:http";
import { loadLocalEnv as loadRootEnv } from "../../../scripts/local-env.mjs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { loadConfig, safeConfigError } from "../../../packages/config/src/env.mjs";
const pg = createRequire(import.meta.url)("pg");
loadRootEnv();
let config;
try { config = loadConfig(); } catch (error) { console.error(safeConfigError(error)); process.exit(1); }
const port = Number(process.env.API_PORT || 4000);
function database() { return new pg.Client({...connectionOptions(process.env.DATABASE_URL),connectionTimeoutMillis:3000,query_timeout:5000}); }
const pool=new pg.Pool({...connectionOptions(process.env.DATABASE_URL),max:Number(process.env.API_POOL_SIZE)||10,connectionTimeoutMillis:3000,query_timeout:10000,idleTimeoutMillis:30000});
pool.on('error',error=>console.error(JSON.stringify({service:'api',event:'pool_error',message:safeConfigError(error)})));
const workspace=createWorkspaceApi({pool,issuer:process.env.OIDC_ISSUER,store:evidenceStoreFromEnv(),mode:config.mode});
async function query(sql, params = []) {
 const db=database();await db.connect();
 try {await db.query('begin');await db.query("select set_config('lara.subject',$1,true),set_config('lara.run_id',$2,true)",[scope.getStore()?.sub || '',scope.getStore()?.run || '']);const result=await db.query(sql,params);await db.query('commit');return result;}
 catch(error){await db.query('rollback');throw error;}finally{await db.end();}
}
async function body(request) { let text = ""; for await (const chunk of request) {text += chunk;if(Buffer.byteLength(text)>65536)throw new DemoError(413,"Command is too large.");} try{return text ? JSON.parse(text) : {};}catch{throw new DemoError(400,"Invalid JSON.");} }
function send(response, status, value) { response.statusCode = status; response.end(JSON.stringify(value)); }
async function ready() { try { const config = loadConfig(); const schema = await query("select version from schema_migrations order by version"); if (!schema.rows.some(row => row.version === "0010_p02_principal_directory")) throw new Error("Schema incompatible"); return { ok: true, mode: config.mode }; } catch (error) { return { ok: false, error: safeConfigError(error) }; } }
const server = http.createServer((request, response) => scope.run({}, async () => {
  const started=performance.now();
  const trace=requestTrace();response.setHeader("x-trace-id",trace.traceId);
  response.once("finish",()=>{const record=JSON.stringify({service:"api",event:"request_completed",trace_id:trace.traceId,request_id:response.getHeader("x-request-id"),status:response.statusCode,duration_ms:Math.round(performance.now()-started)});if(response.statusCode>=500)console.error(record);else console.log(record);void exportTrace(trace,response.statusCode);});
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-request-id", randomUUID());
  response.setHeader("cache-control", "no-store");
  try {
    const url = new URL(request.url, "http://localhost"); const path = url.pathname; const method = request.method;
    if (path === "/health/live") return send(response, 200, { ok: true });
    if (path === "/health/ready") { const state = await ready(); return send(response, state.ok ? 200 : 503, state); }
    const identity=verifyIdentity((request.headers.authorization || '').replace(/^Bearer /,''),method,path,sessionKeys().verification);
    if(!identity) return send(response,401,{error:'AUTHENTICATION_REQUIRED'});
    scope.getStore().sub=identity.sub;
    if (path === "/ops/version") {
      const versions=await query('select version from schema_migrations order by version');
      return send(response,200,{version:'0.0.1',commit:process.env.LARA_COMMIT || 'local-unreleased',schema:versions.rows.at(-1)?.version});
    }
    if(path.startsWith('/demo/')) {
      if(config.mode!=='demo')return send(response,404,{error:'NOT_FOUND'});
      return send(response,200,await demoRequest(database(),identity,method,path,method==='POST'?await body(request):{}));
    }
    if(path==='/v1'||path.startsWith('/v1/'))return workspace(request,response,{identity,path:path.slice(3)||'/',method,traceId:trace.traceId,send:(res,status,value)=>{res.statusCode=status;res.end(typeof value==='string'?value:JSON.stringify(value));}});
    return send(response, 404, { error: "NOT_FOUND" });
  } catch (error) { return send(response, error instanceof DemoError?error.status:500, { error: error instanceof DemoError?error.message:safeConfigError(error) }); }
}));
server.listen(port, process.env.API_BIND_HOST || "127.0.0.1", () => console.log("LARA API listening on http://127.0.0.1:" + port));
