import { NextRequest } from 'next/server';
// Public verification of a share link (P13): the recipient holds no session,
// so this route forwards the opaque token to the API without the BFF identity.
// The API answers only the minimal approved fields and rate-limits the route.
export async function GET(_request: NextRequest, context: {params:Promise<{token:string}>}) {
  const {token}=await context.params;
  if(!/^[0-9a-f-]{36}\.[a-f0-9]{48}$/.test(token)) return Response.json({code:'NOT_FOUND',message:'No such link.',traceId:'',fieldErrors:[],retryable:false},{status:404});
  try {
    const result=await fetch((process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000')+'/v1/verify/'+token,{cache:'no-store'});
    const out=new Headers({'cache-control':'no-store'});
    for(const name of ['content-type','retry-after','x-trace-id'])if(result.headers.get(name))out.set(name,result.headers.get(name)!);
    return new Response(await result.arrayBuffer(),{status:result.status,headers:out});
  } catch {return Response.json({code:'DEPENDENCY_UNAVAILABLE',message:'Service unavailable. Retry shortly.',traceId:'',fieldErrors:[],retryable:true},{status:503});}
}
