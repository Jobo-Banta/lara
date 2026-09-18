import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
const key = secret => createHash('sha256').update(secret).digest();
export function seal(session, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.');
}
export function unseal(value, secrets) {
  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    try {
      const parts = value.split('.');
      if (parts.length !== 3) return null;
      const [iv, tag, body] = parts.map(part => Buffer.from(part, 'base64url'));
      if (iv.length !== 12 || tag.length !== 16) return null;
      const decipher = createDecipheriv('aes-256-gcm', key(secret), iv);
      decipher.setAuthTag(tag);
      const session = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
      if (typeof session.sub !== 'string' || !session.sub || !Number.isFinite(session.expiresAt)) return null;
      return session;
    } catch { /* Try the previous verification key during its bounded overlap. */ }
  }
  return null;
}
