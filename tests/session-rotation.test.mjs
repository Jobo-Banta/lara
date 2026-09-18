import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sessionKeys} from '../packages/config/src/session-keys.mjs';
import {seal,unseal} from '../packages/config/src/session-cookie.mjs';
import {signIdentity,verifyIdentity} from '../apps/api/src/identity.mjs';
const oldKey='old-test-key-'.repeat(5),newKey='new-test-key-'.repeat(5),now=100000;
const env={SESSION_SECRET:newKey,SESSION_PREVIOUS_SECRET:oldKey,SESSION_PREVIOUS_SECRET_EXPIRES_AT:new Date(now+1000).toISOString()};
test('rotation preserves old sessions only during explicit overlap; new writes use current key',()=>{
 const oldCookie=seal({sub:'actor',expiresAt:now+5000},oldKey);
 assert.equal(unseal(oldCookie,sessionKeys(env,now).verification).sub,'actor');
 assert.equal(unseal(oldCookie,sessionKeys(env,now+1000).verification),null);
 const newCookie=seal({sub:'actor',expiresAt:now+5000},sessionKeys(env,now).current);
 assert.equal(unseal(newCookie,oldKey),null);
 assert.equal(unseal(newCookie,newKey).sub,'actor');
 const [iv,tag,body]=newCookie.split('.');
 const changed=Buffer.from(body,'base64url');changed[0]^=1;
 assert.equal(unseal([iv,tag,changed.toString('base64url')].join('.'),[newKey,oldKey]),null);
 assert.equal(unseal(newCookie+'.extra',newKey),null);
});
test('API verifies previous BFF signatures only inside the key overlap',()=>{
 const token=signIdentity('actor','GET','/ops/version',oldKey,now);
 assert.equal(verifyIdentity(token,'GET','/ops/version',sessionKeys(env,now).verification,now).sub,'actor');
 assert.equal(verifyIdentity(token,'GET','/ops/version',sessionKeys(env,now+1000).verification,now+1000),null);
});
test('mounted and environment secret references resolve; invalid references and overlap fail closed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lara-key-test-'));
 try{
  const path=join(dir,'secret');writeFileSync(path,newKey+'\n',{mode:0o600});
  assert.equal(sessionKeys({SESSION_SECRET_REF:'file:'+path}).current,newKey);
  assert.equal(sessionKeys({SESSION_SECRET_REF:'env:INJECTED',INJECTED:newKey}).current,newKey);
  for(const input of [{SESSION_SECRET_REF:'http://unsupported'}, {SESSION_SECRET_REF:'file:'+join(dir,'absent')},{SESSION_SECRET:newKey,SESSION_PREVIOUS_SECRET:oldKey},{...env,SESSION_PREVIOUS_SECRET:'short'}])assert.throws(()=>sessionKeys(input,now));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
