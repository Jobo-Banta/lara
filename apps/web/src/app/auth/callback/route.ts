import { createRemoteJWKSet, jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { authConfig, seal } from "../../../lib/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const config = authConfig();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stored = request.cookies.get("lara_oauth_state")?.value;
  if (!code || !state || !stored || stored.split(".")[0] !== state) return NextResponse.json({ error: "Invalid OIDC callback state" }, { status: 400 });
  const tokenResponse = await fetch(config.issuer + "/oauth/token", {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(config.clientId + ":" + config.clientSecret).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }),
    cache: "no-store",
  });
  if (!tokenResponse.ok) return NextResponse.json({ error: "OIDC token exchange failed" }, { status: 502 });
  const tokens = await tokenResponse.json() as { id_token?: string };
  if (!tokens.id_token) return NextResponse.json({ error: "OIDC response did not contain an ID token" }, { status: 502 });
  const verified = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(config.issuer + "/.well-known/jwks.json")), { issuer: config.issuer, audience: config.clientId });
  const claims = verified.payload;
  const session = seal({ sub: String(claims.sub), email: typeof claims.email === "string" ? claims.email : undefined, name: typeof claims.name === "string" ? claims.name : undefined, expiresAt: Date.now() + 12 * 60 * 60 * 1000 }, config.secret);
  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set("lara_session", session, { httpOnly: true, secure: url.protocol === "https:", sameSite: "lax", maxAge: 12 * 60 * 60, path: "/" });
  response.cookies.delete("lara_oauth_state");
  return response;
}
