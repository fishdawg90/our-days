import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { toCalendarRequest } from "../../src/domain";

const ORIGIN = "https://fishdawg90.github.io";
const PROJECT = "la-spesa-5cc7a";
const UID = "household-user";
const KID = "test-key";

let firebasePrivateKey: CryptoKey;
let firebaseJwk: JsonWebKey & { kid?: string; alg?: string; use?: string };
let googlePrivatePem: string;

function b64url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pem(bytes: ArrayBuffer): string {
  const raw = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const lines = raw.match(/.{1,64}/g)?.join("\n") ?? raw;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

async function idToken(
  overrides: Record<string, unknown> = {},
  signer = firebasePrivateKey,
  kid = KID,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const claims = b64url(
    JSON.stringify({
      aud: PROJECT,
      iss: `https://securetoken.google.com/${PROJECT}`,
      sub: UID,
      iat: now - 5,
      exp: now + 3600,
      auth_time: now - 10,
      ...overrides,
    }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${b64url(new Uint8Array(signature))}`;
}

function env(): Env {
  return {
    CALENDAR_ID: "shared-calendar@example.com",
    FIREBASE_PROJECT_ID: PROJECT,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: `calendar-${crypto.randomUUID()}@example.iam.gserviceaccount.com`,
    GOOGLE_PRIVATE_KEY: googlePrivatePem,
  };
}

function appointment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submissionId: "submit_123456",
    dates: ["2026-10-12"],
    summary: "Dentist",
    allDay: true,
    timeZone: "Europe/London",
    ...overrides,
  };
}

async function request(body: unknown, options: { token?: string; origin?: string; headers?: HeadersInit } = {}) {
  const token = options.token ?? (await idToken());
  return new Request("https://worker.example/appointments", {
    method: "POST",
    headers: {
      Origin: options.origin ?? ORIGIN,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
}

type CalendarResponder = (url: string, init: RequestInit | undefined, event?: any) => Response | Promise<Response>;

function mockUpstreams(calendar: CalendarResponder = (_url, _init, event) => Response.json(event)) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : input.toString();
    if (url.includes("/service_accounts/v1/jwk/")) {
      return Response.json({ keys: [firebaseJwk] }, { headers: { "Cache-Control": "max-age=3600" } });
    }
    if (url.includes("firestore.googleapis.com")) return Response.json({ name: "member" });
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "google-access-token", expires_in: 3600 });
    }
    if (url.includes("/calendar/v3/calendars/")) {
      const event = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return calendar(url, init, event);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

beforeAll(async () => {
  const firebasePair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  firebasePrivateKey = firebasePair.privateKey;
  firebaseJwk = await crypto.subtle.exportKey("jwk", firebasePair.publicKey);
  firebaseJwk.kid = KID;
  firebaseJwk.alg = "RS256";
  firebaseJwk.use = "sig";

  const googlePair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  googlePrivatePem = pem(await crypto.subtle.exportKey("pkcs8", googlePair.privateKey));
});

beforeEach(() => vi.restoreAllMocks());

describe("authorization and CORS", () => {
  it("reports setup readiness without returning credential values", async () => {
    const incomplete = { ...env(), CALENDAR_ID: "REPLACE_WITH_SHARED_CALENDAR_ID", GOOGLE_PRIVATE_KEY: "" };
    const response = await worker.fetch(
      new Request("https://worker.example/health", { headers: { Origin: ORIGIN } }),
      incomplete,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      ready: false,
      checks: { calendarId: false, serviceAccountEmail: true, privateKey: false },
    });
  });

  it("rejects a request without a Firebase bearer token", async () => {
    mockUpstreams();
    const response = await worker.fetch(
      new Request("https://worker.example/appointments", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify(appointment()),
      }),
      env(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
  });

  it("validates the ID token and checks the exact household member with the caller token", async () => {
    const upstream = mockUpstreams();
    const token = await idToken();
    const response = await worker.fetch(await request(appointment(), { token }), env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    const firestoreCall = upstream.mock.calls.find(([input]) => String(input).includes("firestore.googleapis.com"));
    expect(String(firestoreCall?.[0])).toContain(`/households/home/members/${UID}`);
    expect((firestoreCall?.[1] as RequestInit).headers).toEqual({ Authorization: `Bearer ${token}` });
  });

  it("refreshes cached Firebase keys once when a rotated signing kid appears", async () => {
    const rotatedKid = "rotated-key";
    const rotatedPair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const rotatedJwk = await crypto.subtle.exportKey("jwk", rotatedPair.publicKey) as JsonWebKey & {
      kid?: string; alg?: string; use?: string;
    };
    rotatedJwk.kid = rotatedKid;
    rotatedJwk.alg = "RS256";
    rotatedJwk.use = "sig";

    const upstream = mockUpstreams();
    upstream.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : "url" in input ? input.url : input.toString();
      if (url.includes("/service_accounts/v1/jwk/")) {
        return Response.json({ keys: [firebaseJwk, rotatedJwk] }, { headers: { "Cache-Control": "max-age=3600" } });
      }
      if (url.includes("firestore.googleapis.com")) return Response.json({ name: "member" });
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "google-access-token", expires_in: 3600 });
      }
      if (url.includes("/calendar/v3/calendars/")) {
        const event = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Response.json(event);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const token = await idToken({}, rotatedPair.privateKey, rotatedKid);
    const response = await worker.fetch(await request(appointment(), { token }), env(), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(upstream.mock.calls.filter(([input]) => String(input).includes("/service_accounts/v1/jwk/")).length).toBe(1);
  });

  it("fails closed when the member document is absent", async () => {
    mockUpstreams();
    const baseFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/service_accounts/v1/jwk/")) return Response.json({ keys: [firebaseJwk] });
      if (url.includes("firestore.googleapis.com")) return new Response("missing", { status: 404 });
      throw new Error(`Unexpected fetch: ${url} ${String(init?.method)}`);
    });
    const response = await worker.fetch(await request(appointment()), env(), {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Household membership is required" });
  });

  it.each([
    ["wrong audience", { aud: "another-project" }],
    ["wrong issuer", { iss: "https://securetoken.google.com/another-project" }],
    ["expired", { exp: 1 }],
  ])("rejects a correctly signed token with %s before calendar access", async (_label, claims) => {
    const upstream = mockUpstreams();
    const response = await worker.fetch(
      await request(appointment(), { token: await idToken(claims) }),
      env(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect(upstream.mock.calls.some(([input]) => String(input).includes("calendar/v3"))).toBe(false);
    expect(upstream.mock.calls.some(([input]) => String(input).includes("firestore.googleapis.com"))).toBe(false);
  });

  it("rejects a token with a bad signature before calendar access", async () => {
    const otherPair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const upstream = mockUpstreams();
    const response = await worker.fetch(
      await request(appointment(), { token: await idToken({}, otherPair.privateKey) }),
      env(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect(upstream.mock.calls.some(([input]) => String(input).includes("calendar/v3"))).toBe(false);
    expect(upstream.mock.calls.some(([input]) => String(input).includes("firestore.googleapis.com"))).toBe(false);
  });

  it("only grants CORS to the configured GitHub origin", async () => {
    const response = await worker.fetch(
      await request(appointment(), { origin: "https://evil.example" }),
      env(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const preflight = await worker.fetch(
      new Request("https://worker.example/appointments", { method: "OPTIONS", headers: { Origin: ORIGIN } }),
      env(),
      {} as ExecutionContext,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
});

describe("validation and London time", () => {
  it("accepts the frontend's actual toCalendarRequest contract", async () => {
    mockUpstreams();
    const body = toCalendarRequest({
      selectedDates: ["2026-10-12"],
      allDay: false,
      time: "09:30",
      durationMinutes: 60,
      descriptionParts: ["Ross", "Dentist"],
      locationParts: ["Mycroft Dentist"],
    }, "frontend_contract_123");
    const response = await worker.fetch(await request(body), env(), {} as ExecutionContext);
    const result = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(result.results[0]).toMatchObject({ status: "confirmed", code: "created" });
  });

  it("rejects too many dates and oversized bodies", async () => {
    mockUpstreams();
    const dates = Array.from({ length: 21 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
    const invalid = await worker.fetch(await request(appointment({ dates })), env(), {} as ExecutionContext);
    expect(invalid.status).toBe(400);

    const oversized = await worker.fetch(
      await request(appointment(), { headers: { "Content-Length": "20000" } }),
      env(),
      {} as ExecutionContext,
    );
    expect(oversized.status).toBe(413);

    const actualOversized = await worker.fetch(
      await request(appointment({ summary: "x".repeat(17_000) })),
      env(),
      {} as ExecutionContext,
    );
    expect(actualOversized.status).toBe(413);

    const longSummary = await worker.fetch(
      await request(appointment({ summary: "x".repeat(201) })),
      env(),
      {} as ExecutionContext,
    );
    expect(longSummary.status).toBe(400);
  });

  it.each([
    ["2026-03-29", "01:30", "nonexistent"],
    ["2026-10-25", "01:30", "ambiguous"],
  ])("rejects %s %s as a %s local time", async (date, time, reason) => {
    mockUpstreams();
    const response = await worker.fetch(
      await request(appointment({ dates: [date], allDay: false, time, durationMinutes: 30 })),
      env(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain(reason);
  });

  it("uses an exclusive next-day end and never sends attendees", async () => {
    let sent: any;
    mockUpstreams((_url, _init, event) => {
      sent = event;
      return Response.json(event);
    });
    const response = await worker.fetch(
      await request(appointment({ dates: ["2026-12-31"], location: "London" })),
      env(),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(sent.start).toEqual({ date: "2026-12-31" });
    expect(sent.end).toEqual({ date: "2027-01-01" });
    expect(sent).not.toHaveProperty("attendees");
  });
});

describe("idempotency and partial results", () => {
  it("uses a stable event ID and verifies a duplicate matches", async () => {
    const stored = new Map<string, any>();
    mockUpstreams((url, init, event) => {
      if (init?.method === "POST") {
        if (stored.has(event.id)) return new Response("duplicate", { status: 409 });
        stored.set(event.id, { ...event, htmlLink: "https://www.google.com/calendar/event?eid=test" });
        return Response.json(stored.get(event.id));
      }
      const id = decodeURIComponent(url.split("/").at(-1)!);
      return stored.has(id) ? Response.json(stored.get(id)) : new Response("missing", { status: 404 });
    });
    const body = appointment();
    const first = await worker.fetch(await request(body), env(), {} as ExecutionContext);
    const second = await worker.fetch(await request(body), env(), {} as ExecutionContext);
    const firstJson = (await first.json()) as any;
    const secondJson = (await second.json()) as any;
    expect(firstJson.results[0]).toMatchObject({ status: "confirmed", code: "created" });
    expect(secondJson.results[0]).toMatchObject({ status: "confirmed", code: "already-existed" });
    expect(secondJson.results[0].eventId).toBe(firstJson.results[0].eventId);
    expect(secondJson.results[0].href).toBe("https://www.google.com/calendar/event?eid=test");
    expect(secondJson.complete).toBe(true);
  });

  it("rejects a duplicate that does not match the intended event", async () => {
    let posted: any;
    mockUpstreams((_url, init, event) => {
      if (init?.method === "POST") {
        posted = event;
        return new Response("duplicate", { status: 409 });
      }
      return Response.json({ ...posted, summary: "Different appointment" });
    });
    const response = await worker.fetch(await request(appointment()), env(), {} as ExecutionContext);
    const body = (await response.json()) as any;
    expect(response.status).toBe(207);
    expect(body.complete).toBe(false);
    expect(body.results[0]).toMatchObject({ status: "failed", retryable: false });
  });

  it("does not confirm a cancelled duplicate", async () => {
    let posted: any;
    mockUpstreams((_url, init, event) => {
      if (init?.method === "POST") {
        posted = event;
        return new Response("duplicate", { status: 409 });
      }
      return Response.json({ ...posted, status: "cancelled" });
    });
    const response = await worker.fetch(await request(appointment()), env(), {} as ExecutionContext);
    const body = (await response.json()) as any;
    expect(response.status).toBe(207);
    expect(body.results[0]).toMatchObject({ status: "failed", code: "duplicate-mismatch", retryable: false });
  });

  it("keeps the worst-case 20-date duplicate retry under 50 upstream requests", async () => {
    const upstream = mockUpstreams((_url, init, event) => {
      if (init?.method === "POST") return new Response("duplicate", { status: 409 });
      const postCall = upstream.mock.calls.find(([, candidate]) => {
        if (candidate?.method !== "POST" || typeof candidate.body !== "string") return false;
        return JSON.parse(candidate.body).id === decodeURIComponent(_url.split("/").at(-1)!);
      });
      return Response.json(JSON.parse(String(postCall?.[1]?.body)));
    });
    const dates = Array.from({ length: 20 }, (_, index) => `2026-11-${String(index + 1).padStart(2, "0")}`);
    const response = await worker.fetch(await request(appointment({ dates })), env(), {} as ExecutionContext);
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(20);
    expect(body.results.every((result: any) => result.status === "confirmed")).toBe(true);
    expect(upstream.mock.calls.length).toBeLessThan(50);
  });

  it("returns per-date success and retryable failure for a partial insertion", async () => {
    mockUpstreams((_url, _init, event) =>
      event.start.date === "2026-10-13" ? new Response("busy", { status: 503 }) : Response.json(event),
    );
    const response = await worker.fetch(
      await request(appointment({ dates: ["2026-10-12", "2026-10-13"] })),
      env(),
      {} as ExecutionContext,
    );
    const body = (await response.json()) as any;
    expect(response.status).toBe(207);
    expect(body.complete).toBe(false);
    expect(body.results).toEqual([
      expect.objectContaining({ date: "2026-10-12", status: "confirmed" }),
      expect.objectContaining({ date: "2026-10-13", status: "failed", retryable: true }),
    ]);
  });
});
