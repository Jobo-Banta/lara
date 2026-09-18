import { createHmac, timingSafeEqual } from 'node:crypto';
export function signIdentity(subject, method, path, secret, now = Date.now()) {
  const body=Buffer.from(JSON.stringify({sub:subject,aud:'lara-api',exp:now+30000,method,path})).toString('base64url');
  return body+'.'+createHmac('sha256',secret).update('lara-bff:'+body).digest('base64url');
}
// The last rejection reason is kept for operators (never the token itself);
// the API reports it outside production so intermittent failures are
// diagnosable.
export const CLOCK_SKEW_MS=5000;
export let lastRejection=null;
function reject(reason){lastRejection=reason;return null;}
export function verifyIdentity(value, method, path, secret, now=Date.now()) {
  try {
    const [body,signature,...extra]=value.split('.');
    if(extra.length || !body || !signature) return reject('malformed');
    const keys=Array.isArray(secret)?secret:[secret];
    const actual=Buffer.from(signature,'base64url');
    if(!keys.some(key=>{const expected=createHmac('sha256',key).update('lara-bff:'+body).digest();return actual.length===expected.length && timingSafeEqual(actual,expected);})) return reject('signature');
    const claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(typeof claims.sub!=='string' || !claims.sub) return reject('subject');
    if(claims.aud!=='lara-api') return reject('audience');
    if(!Number.isFinite(claims.exp) || claims.exp<=now) return reject('expired exp='+claims.exp+' now='+now);
    // Issuer and verifier read clocks independently; a few seconds of skew is
    // tolerated on the upper bound, never on expiry.
    if(claims.exp>now+30000+CLOCK_SKEW_MS) return reject('future exp='+claims.exp+' now='+now);
    if(claims.method!==method) return reject('method '+claims.method+' vs '+method);
    if(claims.path!==path) return reject('path '+claims.path+' vs '+path);
    lastRejection=null;
    return claims;
  } catch {return reject('unreadable');}
}
