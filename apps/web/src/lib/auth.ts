import { cookies } from "next/headers";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Session = { sub: string; email?: string; name?: string; expiresAt: number };

function loadLocalEnv() {
  const result: Record<string, string> = { ...process.env } as Record<string, string>;
  const path = join(process.cwd(), "..", "..", ".env.local");
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const index = line.indexOf("=");
      if (index > 0 && !line.startsWith("#")) result[line.slice(0, index)] ??= line.slice(index + 1);
    }
  } catch {}
  return result;
}

export function authConfig() {
  const env = loadLocalEnv();
  const issuer = env.OIDC_ISSUER;
  const clientId = env.OIDC_CLIENT_ID;
  const clientSecret = env.OIDC_CLIENT_SECRET;
  const redirectUri = env.OIDC_REDIRECT_URI || "http://localhost:3000/auth/callback";
  if (!issuer || !clientId || !clientSecret) throw new Error("OIDC configuration is incomplete");
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Session secret is missing or too short");
  return { issuer, clientId, clientSecret, redirectUri, secret };
}

export function stateToken() {
  return randomBytes(32).toString("base64url");
}

function key(secret: string) {
  return createHash("sha256").update(secret).digest();
}

export function seal(session: Session, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

export function unseal(value: string, secret: string): Session | null {
  try {
    const [iv, tag, body] = value.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key(secret), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as Session;
  } catch {
    return null;
  }
}

export async function currentSession() {
  const config = authConfig();
  const value = (await cookies()).get("lara_session")?.value;
  if (!value) return null;
  const session = unseal(value, config.secret);
  return session && session.expiresAt > Date.now() ? session : null;
}
