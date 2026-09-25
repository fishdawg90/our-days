import { AuthError, bearerToken, requireHouseholdMember, verifyFirebaseToken } from "./auth";
import { createCalendarEvents } from "./google";
import { LocalTimeError } from "./timezone";
import type { Env } from "./types";
import { MAX_BODY_BYTES, validateAppointment, ValidationError } from "./validation";

const ALLOWED_ORIGIN = "https://fishdawg90.github.io";

function corsHeaders(request: Request): Headers {
  const headers = new Headers({ Vary: "Origin" });
  if (request.headers.get("Origin") === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  return headers;
}

function json(request: Request, body: unknown, status = 200): Response {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

async function handler(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== ALLOWED_ORIGIN) return json(request, { error: "Origin is not allowed" }, 403);

  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    if (origin !== ALLOWED_ORIGIN) return json(request, { error: "Origin is not allowed" }, 403);
    const headers = corsHeaders(request);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
    return new Response(null, { status: 204, headers });
  }
  if (url.pathname === "/health" && request.method === "GET") {
    const checks = {
      calendarId: Boolean(env.CALENDAR_ID && env.CALENDAR_ID !== "REPLACE_WITH_SHARED_CALENDAR_ID"),
      serviceAccountEmail: Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
      privateKey: Boolean(env.GOOGLE_PRIVATE_KEY),
    };
    return json(request, { ok: true, ready: Object.values(checks).every(Boolean), checks });
  }
  if (url.pathname !== "/appointments") return json(request, { error: "Not found" }, 404);
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    return json(request, { error: "Content-Type must be application/json" }, 415);
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json(request, { error: "Request body is too large" }, 413);
  }

  try {
    const token = bearerToken(request);
    const projectId = env.FIREBASE_PROJECT_ID ?? "la-spesa-5cc7a";
    const uid = await verifyFirebaseToken(token, projectId);
    await requireHouseholdMember(token, uid, env);

    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return json(request, { error: "Request body is too large" }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const raw = new TextDecoder().decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ValidationError("Request body must be valid JSON");
    }
    const appointment = validateAppointment(parsed);
    const results = await createCalendarEvents(appointment, env);
    const complete = results.every((result) => result.status === "confirmed");
    return json(request, { submissionId: appointment.submissionId, complete, results }, complete ? 200 : 207);
  } catch (error) {
    if (error instanceof AuthError) return json(request, { error: error.message }, error.status);
    if (error instanceof ValidationError || error instanceof LocalTimeError) {
      return json(request, { error: error.message }, 400);
    }
    return json(request, { error: "Calendar service is temporarily unavailable" }, 502);
  }
}

export { handler };

export default {
  fetch(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
    return handler(request, env);
  },
} satisfies ExportedHandler<Env>;
