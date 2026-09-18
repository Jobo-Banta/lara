import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrackerServer} from '../scripts/serve-build-status.mjs';

test('tracker serves its page, live data and assets without exposing workspace secrets', async t => {
 const server=createTrackerServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port;
 for(const path of ['/build-status.html','/status/build-status.js','/status/build-status-data.js','/status/build-status.css','/images/branding/ledger-l/web/lara-theme.css','/images/branding/ledger-l/web/logos/lara-logo-primary.svg','/docs/development/README.md']){
  const r=await fetch(base+path);assert.equal(r.status,200,path);assert.equal(r.headers.get('cache-control'),'no-store');
 }
 const view=await (await fetch(base+'/status/build-status-view.json')).json();
 assert.equal(view.releases.length,26);assert.equal(view.tickets.length,162);
 for(const path of ['/.env.local','/.git/config','/status/build-status.json','/scripts/setup.mjs','/docs/development/%2e%2e%2f%2e%2e%2f.env.local']){
  assert.equal((await fetch(base+path)).status,404,path);
 }
 assert.equal((await fetch(base+'/build-status.html',{method:'POST'})).status,405);
 assert.equal(await (await fetch(base+'/build-status.html',{method:'HEAD'})).text(),'');
});
