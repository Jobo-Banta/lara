import test from 'node:test';
import assert from 'node:assert/strict';
import { signIdentity,verifyIdentity } from '../apps/api/src/identity.mjs';
const secret='test-only-'.repeat(8), now=100000;
test('signed BFF identity binds subject, audience, path, method and expiry',()=>{
 const token=signIdentity('actor-a','GET','/demo/work',secret,now);
 assert.equal(verifyIdentity(token,'GET','/demo/work',secret,now).sub,'actor-a');
 for(const [method,path,key,time] of [['POST','/demo/work',secret,now],['GET','/ops/version',secret,now],['GET','/demo/work','wrong',now],['GET','/demo/work',secret,now+30001]]) assert.equal(verifyIdentity(token,method,path,key,time),null);
 assert.equal(verifyIdentity(token+'x','GET','/demo/work',secret,now),null);
 assert.equal(verifyIdentity('forged','GET','/demo/work',secret,now),null);
});
test('a fresh token survives small clock skew between issuer and verifier but not a forged far-future expiry',()=>{
 const token=signIdentity('actor-a','GET','/v1/me',secret,now);
 assert.equal(verifyIdentity(token,'GET','/v1/me',secret,now-1)?.sub,'actor-a','verifier clock 1ms behind the issuer');
 assert.equal(verifyIdentity(token,'GET','/v1/me',secret,now-4999)?.sub,'actor-a');
 assert.equal(verifyIdentity(token,'GET','/v1/me',secret,now-5001),null,'beyond the tolerated skew');
 assert.equal(verifyIdentity(token,'GET','/v1/me',secret,now+30000),null,'expired exactly at exp');
});
