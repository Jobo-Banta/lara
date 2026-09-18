export type Session = {sub: string; email?: string; name?: string; expiresAt: number; accessToken?: string; refreshToken?: string};
export function seal(session: Session, secret: string): string;
export function unseal(value: string, secrets: string | string[]): Session | null;
