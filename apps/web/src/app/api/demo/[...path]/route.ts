import { NextRequest } from 'next/server';
import { authConfig } from '../../../../lib/auth';
import { scopedFetch } from '../../../../lib/api';
async function handle(request: NextRequest, context: {params:Promise<{path:string[]}>}) {
  if(request.method!=='GET' && request.headers.get('origin')!==authConfig().appOrigin) return Response.json({error:'Invalid request origin'},{status:403});
  const {path}=await context.params;
  if(path.some(segment=>! /^[a-zA-Z0-9_-]+$/.test(segment))) return Response.json({error:'Invalid path'},{status:400});
  try {
    const result=await scopedFetch('/demo/'+path.join('/'),{method:request.method,body:request.method==='GET'?undefined:await request.text()});
    return new Response(await result.text(),{status:result.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  } catch {return Response.json({error:'Service unavailable. Retry shortly.'},{status:503});}
}
export const GET=handle;
export const POST=handle;
