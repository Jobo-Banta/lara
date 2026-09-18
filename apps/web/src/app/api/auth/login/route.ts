import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { authConfig, stateToken } from "../../../../lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const config = authConfig();
  const state = stateToken();
  const nonce = stateToken();
  const verifier = stateToken();
  const url = new URL(config.issuer + "/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  const response = NextResponse.redirect(url);
  const secure = new URL(request.url).protocol === "https:";
  response.cookies.set("lara_oauth_state", state + "." + nonce + "." + verifier, { httpOnly: true, sameSite: "lax", secure, maxAge: 600, path: "/" });
  return response;
}
