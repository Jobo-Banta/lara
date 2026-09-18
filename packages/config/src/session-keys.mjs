import {readFileSync} from 'node:fs';

function resolve(ref, fallback, env) {
  if (!ref || ref === 'local-file') return fallback;
  if (ref.startsWith('env:')) return env[ref.slice(4)];
  if (ref.startsWith('file:')) {
    try { return readFileSync(ref.slice(5), 'utf8').trim(); }
    catch { throw Error('Session secret reference unavailable'); }
  }
  throw Error('Unsupported session secret reference');
}

// file: supports a secret-manager volume; never fetch or log secret values.
export function sessionKeys(env = process.env, now = Date.now()) {
  const current = resolve(env.SESSION_SECRET_REF, env.SESSION_SECRET, env);
  if (!current) throw Error('Missing required configuration: SESSION_SECRET');
  if (current.length < 32) throw Error('SESSION_SECRET must contain at least 32 characters');
  const previous = resolve(env.SESSION_PREVIOUS_SECRET_REF, env.SESSION_PREVIOUS_SECRET, env);
  if (!previous) return {current, verification: [current]};
  const expiry = Date.parse(env.SESSION_PREVIOUS_SECRET_EXPIRES_AT || '');
  if (previous.length < 32 || !Number.isFinite(expiry)) throw Error('Invalid session key overlap configuration');
  return {current, verification: expiry > now ? [current, previous] : [current]};
}
