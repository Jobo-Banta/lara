import {sessionKeys} from './session-keys.mjs';
const MODES = new Set(['local', 'demo', 'staging', 'production']);
export function loadConfig(s = process.env) {
  const mode = s.LARA_MODE;
  if (!MODES.has(mode)) throw new Error('Invalid LARA_MODE');
  for (const name of ['APP_BASE_URL','API_INTERNAL_URL','DATABASE_URL','OIDC_ISSUER','OIDC_CLIENT_ID','OIDC_CLIENT_SECRET','OBJECT_ADAPTER','OBJECT_BUCKET','OBJECT_REGION','MAIL_ADAPTER','EINVOICE_ADAPTER','AI_ADAPTER','RULE_PROFILE_ID']) {
    if (!s[name]) throw new Error('Missing required configuration: ' + name);
  }
  sessionKeys(s);
  for (const name of ['APP_BASE_URL','API_INTERNAL_URL','OIDC_ISSUER']) {
    let url;
    try { url = new URL(s[name]); } catch { throw new Error('Invalid URL configuration: ' + name); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')) throw new Error('Invalid origin configuration: ' + name);
    if (mode !== 'local' && url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('TLS required: ' + name);
  }
  let db;
  try { db = new URL(s.DATABASE_URL); } catch { throw new Error('Invalid DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol)) throw new Error('Invalid DATABASE_URL');
  if (/^(postgres|lara_migrator)(\.|$)/.test(db.username)) throw new Error('Runtime database role must not be an owner');
  if (!['localhost','127.0.0.1'].includes(db.hostname) && !['require','verify-ca','verify-full'].includes(db.searchParams.get('sslmode'))) throw new Error('Database TLS required');
  if (!['true','false',undefined].includes(s.DEMO_RESET_ENABLED)) throw new Error('Invalid DEMO_RESET_ENABLED');
  if (mode !== 'demo' && s.DEMO_RESET_ENABLED === 'true') throw new Error('Demo reset only allowed in demo');
  if (mode === 'production' || mode === 'staging') {
    if (s.EINVOICE_ADAPTER === 'fixture' || s.AI_ADAPTER === 'fixture' || s.RULE_PROFILE_ID.startsWith('fixture') || s.OBJECT_ADAPTER === 'filesystem' || s.MAIL_ADAPTER === 'local') throw new Error('Local and fixture adapters forbidden outside local/demo');
  }
  return Object.freeze({ mode });
}
export function safeConfigError(error) {
  const message = error instanceof Error ? error.message : '';
  return /^(Invalid LARA_MODE|Missing required configuration: [A-Z_]+|SESSION_SECRET must contain at least 32 characters|Invalid (URL|origin) configuration: [A-Z_]+|TLS required: [A-Z_]+|Invalid DATABASE_URL|Runtime database role must not be an owner|Database TLS required|Invalid DEMO_RESET_ENABLED|Demo reset only allowed in demo|Local and fixture adapters forbidden outside local\/demo)$/.test(message) ? message : 'Dependency unavailable';
}
