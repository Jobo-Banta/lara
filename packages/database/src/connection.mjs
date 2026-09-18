import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// Business dates are date-only values: the driver hands them back as ISO
// strings instead of local-midnight Date objects, which shift across zones.
const pg=createRequire(import.meta.url)('pg');
pg.types.setTypeParser(1082,value=>value);
export function connectionOptions(value) {
  if(!value) throw new Error('Database URL is required');
  const url=new URL(value);
  const remote=!['localhost','127.0.0.1'].includes(url.hostname);
  let ssl;
  if(remote) {
    ssl={rejectUnauthorized:true};
    if(url.hostname.endsWith('.supabase.com') || url.hostname.endsWith('.supabase.co')) ssl.ca=readFileSync(new URL('../../../infra/certs/supabase-ca.crt',import.meta.url),'utf8');
  }
  for(const key of ['sslmode','sslrootcert','sslcert','sslkey','uselibpqcompat']) url.searchParams.delete(key);
  return {connectionString:url.toString(),ssl};
}
