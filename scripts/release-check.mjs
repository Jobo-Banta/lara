import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const result=spawnSync(process.platform==='win32'?'pnpm.cmd':'pnpm',['verify'],{stdio:'inherit',shell:process.platform==='win32'});
if(result.status!==0) process.exit(result.status ?? 1);
const status=JSON.parse(await readFile('status/build-status.json','utf8'));
const open=Object.entries(status.tickets).filter(([id,t])=>id.startsWith('P00-')&&t.status!=='done').map(([id])=>id);
if(open.length) { console.error('Release blocked by incomplete P00 tickets: '+open.join(', ')); process.exit(1); }
const manifest=spawnSync(process.execPath,['scripts/release-manifest.mjs'],{stdio:'inherit'});if(manifest.status!==0)process.exit(manifest.status??1);
console.log('Local checks passed. Actual signed tag, artifact delivery and external gates must still be attested before release.');
