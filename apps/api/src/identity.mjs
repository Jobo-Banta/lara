import { createHmac, timingSafeEqual } from 'node:crypto';
export function signIdentity(subject, method, path, secret, now = Date.now()) {
  const body=Buffer.from(JSON.stringify({sub:subject,aud:'lara-api',exp:now+30000,method,path})).toString('base64url');
  return body+'.'+createHmac('sha256',secret).update('lara-bff:'+body).digest('base64url');
}
export function verifyIdentity(value, method, path, secret, now=Date.now()) {
  try {
    const [body,signature,...extra]=value.split('.');
    if(extra.length || !body || !signature) return null;
    const keys=Array.isArray(secret)?secret:[secret];
    const actual=Buffer.from(signature,'base64url');
    if(!keys.some(key=>{const expected=createHmac('sha256',key).update('lara-bff:'+body).digest();return actual.length===expected.length && timingSafeEqual(actual,expected);})) return null;
    const claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(typeof claims.sub!=='string' || !claims.sub || claims.aud!=='lara-api' || !Number.isFinite(claims.exp) || claims.exp<=now || claims.exp>now+30000 || claims.method!==method || claims.path!==path) return null;
    return claims;
  } catch {return null;}
}
