import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadConfig, safeConfigError } from '../packages/config/src/env.mjs';
const base = {LARA_MODE:'demo', APP_BASE_URL:'http://localhost:3000', API_INTERNAL_URL:'http://127.0.0.1:4000', DATABASE_URL:'postgresql://lara_api:fixture@localhost/lara_test', OIDC_ISSUER:'https://identity.example', OIDC_CLIENT_ID:'test', OIDC_CLIENT_SECRET:'test', SESSION_SECRET:'x'.repeat(48), OBJECT_ADAPTER:'filesystem', OBJECT_BUCKET:'test', OBJECT_REGION:'local', MAIL_ADAPTER:'local', EINVOICE_ADAPTER:'fixture', AI_ADAPTER:'fixture', RULE_PROFILE_ID:'fixture-test', DEMO_RESET_ENABLED:'false'};
test('runtime configuration needs no migration credential', () => assert.equal(loadConfig(base).mode,'demo'));
test('missing secrets and unsafe runtime URLs fail without exposing their value', () => {
  for (const key of ['SESSION_SECRET','DATABASE_URL','OIDC_CLIENT_SECRET']) assert.throws(()=>loadConfig({...base,[key]:''}), /Missing required/);
  for (const value of ['https://postgres:secret@example.org','postgresql://postgres:secret@localhost/postgres','postgresql://lara_api:secret@db.example/postgres']) assert.throws(()=>loadConfig({...base,DATABASE_URL:value}));
  assert.equal(safeConfigError(new Error('password secret token=abc postgres://a:b@x/db')), 'Dependency unavailable');
});
test('production rejects fixtures and demo reset', () => {
  assert.throws(()=>loadConfig({...base,LARA_MODE:'production'}),/forbidden/);
  assert.throws(()=>loadConfig({...base,LARA_MODE:'local',DEMO_RESET_ENABLED:'true'}),/only allowed/);
});
test('invalid config prevents API from listening', () => {
  const r=spawnSync(process.execPath,['apps/api/src/server.mjs'],{env:{...process.env,LARA_MODE:'invalid'},encoding:'utf8',timeout:5000});
  assert.equal(r.status,1); assert.match(r.stderr,/Invalid LARA_MODE/); assert.doesNotMatch(r.stdout,/listening/);
});
test('seed refuses production before opening a database connection', () => {
  const r=spawnSync(process.execPath,['scripts/seed-demo.mjs'],{env:{...process.env,LARA_MODE:'production'},encoding:'utf8',timeout:5000});
  assert.equal(r.status,1); assert.match(r.stderr,/Demo seeding requires/);
});
test('approved asset packaging is deterministic and source-derived', () => {
  for(let i=0;i<2;i++) { const r=spawnSync(process.execPath,['scripts/copy-brand-assets.mjs'],{encoding:'utf8'}); assert.equal(r.status,0); if(i===0) globalThis.firstManifest=readFileSync('apps/web/public/assets/lara/asset-manifest.json','utf8'); }
  const value=readFileSync('apps/web/public/assets/lara/asset-manifest.json','utf8');
  assert.equal(value,globalThis.firstManifest); assert.equal(JSON.parse(value).files['asset-manifest.json'],undefined);
});
