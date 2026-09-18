import { NextRequest } from 'next/server';
import { authConfig } from '../../../../lib/auth';
import { scopedFetch } from '../../../../lib/api';
// Forwards workspace calls to the API with the signed BFF identity. Only the
// contract headers pass through; the tenant and entity scope stay in headers
// so the API can bind them to committed memberships.
const passthrough=['x-entity-id','x-tenant-id','idempotency-key','if-match','content-type'];
async function handle(request: NextRequest, context: {params:Promise<{path:string[]}>}) {
  if(request.method!=='GET' && request.headers.get('origin')!==authConfig().appOrigin) return Response.json({code:'FORBIDDEN',message:'Invalid request origin',traceId:'',fieldErrors:[],retryable:false},{status:403});
  const {path}=await context.params;
  if(path.some(segment=>! /^[a-zA-Z0-9_.-]+$/.test(segment))) return Response.json({code:'VALIDATION_FAILED',message:'Invalid path',traceId:'',fieldErrors:[],retryable:false},{status:400});
  const headers: Record<string,string>={};
  for(const name of passthrough){const value=request.headers.get(name);if(value)headers[name]=value;}
  const query=request.nextUrl.search||'';
  try {
    const body=request.method==='GET'?undefined:Buffer.from(await request.arrayBuffer());
    const result=await scopedFetch('/v1/'+path.join('/')+query,{method:request.method,body,headers});
    const out=new Headers({'cache-control':'no-store'});
    for(const name of ['content-type','etag','retry-after','content-disposition','x-content-sha256','x-trace-id'])if(result.headers.get(name))out.set(name,result.headers.get(name)!);
    return new Response(result.status===204?null:await result.arrayBuffer(),{status:result.status,headers:out});
  } catch {return Response.json({code:'DEPENDENCY_UNAVAILABLE',message:'Service unavailable. Retry shortly.',traceId:'',fieldErrors:[],retryable:true},{status:503});}
}
export const GET=handle;
export const POST=handle;
export const PATCH=handle;
export const PUT=handle;
