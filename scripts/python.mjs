import { spawnSync } from 'node:child_process';
const command = process.platform === 'win32' ? 'py' : 'python3';
const result = spawnSync(command, [...(process.platform === 'win32' ? ['-3'] : []), ...process.argv.slice(2)], {stdio:'inherit'});
process.exit(result.status ?? 1);
