import type { Env } from "./types";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { fetchWithTimeout } from "./fetch";

const FIREBASE_JWKS =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
type FirebaseJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let cachedKeys: { expiresAt: number; keys: FirebaseJwk[] } | undefined;
let lastUnknownKidRefreshAt = 0;
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 30_000;

export class AuthError extends Error {
  constructor(message: string, public readonly status = 401) {
    super(message);
  }
}

async function firebaseKeys(forceRefresh = false): Promise<FirebaseJwk[]> {
  if (!forceRefresh && cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  let response: Response;
  try {
    response = await fetchWithTimeout(FIREBASE_JWKS);
  } catch {
    throw new AuthError("Unable to verify authentication", 503);
  }
  if (!response.ok) throw new AuthError("Unable to verify authentication", 503);
  const body = (await response.json()) as { keys?: FirebaseJwk[] };
  if (!Array.isArray(body.keys)) throw new AuthError("Unable to verify authentication", 503);
  const maxAge = Number(/max-age=(\d+)/i.exec(response.headers.get("Cache-Control") ?? "")?.[1] ?? 300);
  cachedKeys = { keys: body.keys, expiresAt: Date.now() + Math.min(Math.max(maxAge, 60), 3600) * 1000 };
  return body.keys;
}

export async function verifyFirebaseToken(token: string, projectId: string): Promise<string> {
  if (token.length > 4096) throw new AuthError("Invalid Firebase ID token");
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("bad header");
    const hadFreshCache = Boolean(cachedKeys && cachedKeys.expiresAt > Date.now());
    let keys = await firebaseKeys();
    if (!keys.some((key) => key.kid === header.kid) && hadFreshCache) {
      const now = Date.now();
      if (now - lastUnknownKidRefreshAt >= UNKNOWN_KID_REFRESH_COOLDOWN_MS) {
        // Firebase rotates signing keys. Refresh once when a new kid is seen, while
        // rate-limiting misses so arbitrary tokens cannot hammer Google's JWKS URL.
        lastUnknownKidRefreshAt = now;
        keys = await firebaseKeys(true);
      }
    }
    if (!keys.some((key) => key.kid === header.kid)) throw new Error("unknown key");
    const { payload: claims } = await jwtVerify(token, createLocalJWKSet({ keys: keys as any }), {
      algorithms: ["RS256"],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
      clockTolerance: 5,
    });
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 128 ||
      typeof claims.exp !== "number" ||
      typeof claims.iat !== "number" ||
      claims.iat > now + 300 ||
      typeof claims.auth_time !== "number" ||
      claims.auth_time > now + 300
    ) throw new Error("bad claims");
    return claims.sub;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("Invalid Firebase ID token");
  }
}

export function bearerToken(request: Request): string {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) throw new AuthError("A Firebase ID token is required");
  return match[1];
}

export async function requireHouseholdMember(token: string, uid: string, env: Env): Promise<void> {
  const projectId = env.FIREBASE_PROJECT_ID ?? "la-spesa-5cc7a";
  const path = `projects/${projectId}/databases/(default)/documents/households/home/members/${encodeURIComponent(uid)}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(`https://firestore.googleapis.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new AuthError("Unable to verify household membership", 503);
  }
  if (response.ok) return;
  if (response.status === 401) throw new AuthError("Authentication expired");
  if (response.status === 403 || response.status === 404) {
    throw new AuthError("Household membership is required", 403);
  }
  throw new AuthError("Unable to verify household membership", 503);
}
