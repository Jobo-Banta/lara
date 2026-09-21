import 'server-only';
import { cookies } from 'next/headers';
import { createHmac, createHash } from 'node:crypto';
import { currentSession, authConfig } from './auth';
// Signs the BFF identity for one API call. The signature binds method and
// pathname only; the query string travels unsigned because the API binds
// scope through headers and membership, not query parameters.
export async function scopedFetch(path: string, init: RequestInit & {headers?: Record<string,string>} = {}) {
  const session=await currentSession();
  if(!session) return Response.json({code:'UNAUTHENTICATED',message:'Sign in to continue.',traceId:'',fieldErrors:[],retryable:false},{status:401});
  const method=init.method || 'GET';
  const pathname=path.split('?')[0];
  const sid=createHash('sha256').update((await cookies()).get('lara_session')?.value || '').digest('hex');
  const payload=Buffer.from(JSON.stringify({sub:session.sub,sid,aud:'lara-api',exp:Date.now()+30000,method,path:pathname})).toString('base64url');
  const signature=createHmac('sha256',authConfig().secret).update('lara-bff:'+payload).digest('base64url');
  return fetch((process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000')+path,{...init,cache:'no-store',headers:{'content-type':'application/json',...(init.headers||{}),authorization:'Bearer '+payload+'.'+signature}});
}
