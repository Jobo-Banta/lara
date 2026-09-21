import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sessionKeys } from '../../../../packages/config/src/session-keys.mjs';
import { unseal } from '../../../../packages/config/src/session-cookie.mjs';
export { seal, unseal } from '../../../../packages/config/src/session-cookie.mjs';

function loadLocalEnv() {
  const result: Record<string, string> = {};
  const path = join(process.cwd(), "..", "..", ".env.local");
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const index = line.indexOf("=");
      if (index > 0 && !line.startsWith("#")) result[line.slice(0, index)] = line.slice(index + 1);
    }
  } catch {}
  return { ...result, ...process.env };
}

export function authConfig() {
  const env = loadLocalEnv();
  const issuer = env.OIDC_ISSUER;
  const clientId = env.OIDC_CLIENT_ID;
  const clientSecret = env.OIDC_CLIENT_SECRET;
  const redirectUri = env.OIDC_REDIRECT_URI || "http://localhost:3000/auth/callback";
  if (!issuer || !clientId || !clientSecret) throw new Error("OIDC configuration is incomplete");
  const keys = sessionKeys(env);
  return { appOrigin: new URL(env.APP_BASE_URL || redirectUri).origin, issuer, clientId, clientSecret, redirectUri, secret: keys.current, verificationKeys: keys.verification, publishableKey: env.SUPABASE_PUBLISHABLE_KEY, devLogin: devLogin(env) };
}

// Development sign-in prefill (scripts/dev-account.mjs): only the demo and
// local compositions ever see these credentials; production and staging get null.
function devLogin(env: Record<string, string | undefined>) {
  if (!["demo", "local"].includes(env.LARA_MODE || "demo")) return null;
  if (!env.DEV_LOGIN_EMAIL || !env.DEV_LOGIN_PASSWORD) return null;
  return { email: env.DEV_LOGIN_EMAIL, password: env.DEV_LOGIN_PASSWORD };
}

export function stateToken() {
  return randomBytes(32).toString("base64url");
}

export async function currentSession() {
  const config = authConfig();
  const value = (await cookies()).get("lara_session")?.value;
  if (!value) return null;
  const session = unseal(value, config.verificationKeys);
  return session && session.expiresAt > Date.now() ? session : null;
}
