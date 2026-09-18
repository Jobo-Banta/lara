import { readFileSync } from 'node:fs';
export function loadLocalEnv(target = process.env) {
  const local = {};
  try {
    for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index > 0 && !line.startsWith('#')) local[line.slice(0,index)] = line.slice(index+1);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [key,value] of Object.entries(local)) target[key] ??= value;
  return target;
}
