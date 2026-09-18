import 'server-only';
import { createHmac } from 'node:crypto';
import { currentSession, authConfig } from './auth';
export async function scopedFetch(path: string, init: RequestInit = {}) {
  const session=await currentSession();
  if(!session) return Response.json({error:'Sign in to continue.'},{status:401});
  const method=init.method || 'GET';
  const payload=Buffer.from(JSON.stringify({sub:session.sub,aud:'lara-api',exp:Date.now()+30000,method,path})).toString('base64url');
  const signature=createHmac('sha256',authConfig().secret).update('lara-bff:'+payload).digest('base64url');
  return fetch((process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000')+path,{...init,cache:'no-store',headers:{'content-type':'application/json',authorization:'Bearer '+payload+'.'+signature}});
}
