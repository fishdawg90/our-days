import { londonLocalToInstant, nextIsoDate, TIME_ZONE } from "./timezone";
import type { CalendarEvent, DateResult, Env, ValidatedAppointment } from "./types";
import { importPKCS8, SignJWT } from "jose";
import { fetchWithTimeout } from "./fetch";

const encoder = new TextEncoder();
let cachedAccessToken: { email: string; value: string; expiresAt: number } | undefined;

async function serviceAccountAssertion(env: Env, now: number): Promise<string> {
  try {
    const key = await importPKCS8(env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), "RS256");
    return await new SignJWT({ scope: "https://www.googleapis.com/auth/calendar.events" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(env.GOOGLE_SERVICE_ACCOUNT_EMAIL)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
  } catch {
    throw new Error("Google Calendar credentials are not configured correctly");
  }
}

async function accessToken(env: Env): Promise<string> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new Error("Google Calendar credentials are not configured");
  }
  if (
    cachedAccessToken &&
    cachedAccessToken.email === env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    cachedAccessToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedAccessToken.value;
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = await serviceAccountAssertion(env, now);
  const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error("Google Calendar authentication failed");
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (typeof body.access_token !== "string") throw new Error("Google Calendar authentication failed");
  cachedAccessToken = {
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    value: body.access_token,
    expiresAt: Date.now() + Math.min(body.expires_in ?? 3600, 3600) * 1000,
  };
  return body.access_token;
}

async function eventId(submissionId: string, date: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`${submissionId}\n${date}`));
  return `od${[...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40)}`;
}

function intendedEvent(id: string, appointment: ValidatedAppointment, date: string): CalendarEvent {
  const common = {
    id,
    summary: appointment.summary,
    ...(appointment.location ? { location: appointment.location } : {}),
    extendedProperties: {
      private: { submissionId: appointment.submissionId, appointmentDate: date, source: "our-days" },
    },
  };
  if (appointment.allDay) {
    return { ...common, start: { date }, end: { date: nextIsoDate(date) } };
  }
  const start = londonLocalToInstant(date, appointment.time!);
  const end = new Date(start.getTime() + appointment.durationMinutes! * 60_000);
  return {
    ...common,
    start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
    end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
  };
}

function sameDateTime(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && !Number.isNaN(Date.parse(actual)) && Date.parse(actual) === Date.parse(expected);
}

function eventMatches(actual: Record<string, any>, expected: CalendarEvent): boolean {
  if (actual.status === "cancelled" || actual.id !== expected.id || actual.summary !== expected.summary || (actual.location ?? "") !== (expected.location ?? "")) {
    return false;
  }
  const actualPrivate = actual.extendedProperties?.private;
  const expectedPrivate = expected.extendedProperties.private;
  if (
    actualPrivate?.submissionId !== expectedPrivate.submissionId ||
    actualPrivate?.appointmentDate !== expectedPrivate.appointmentDate ||
    actualPrivate?.source !== expectedPrivate.source
  ) {
    return false;
  }
  if ("date" in expected.start && "date" in expected.end) {
    return actual.start?.date === expected.start.date && actual.end?.date === expected.end.date;
  }
  if ("dateTime" in expected.start && "dateTime" in expected.end) {
    return (
      sameDateTime(actual.start?.dateTime, expected.start.dateTime) &&
      sameDateTime(actual.end?.dateTime, expected.end.dateTime)
    );
  }
  return false;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function addOne(
  baseUrl: string,
  token: string,
  event: CalendarEvent,
  date: string,
): Promise<DateResult> {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/events?sendUpdates=none`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (response.ok) {
      const created = (await response.json()) as Record<string, any>;
      if (eventMatches(created, event)) return {
        date, eventId: event.id, status: "confirmed", code: "created",
        ...(typeof created.htmlLink === "string" ? { href: created.htmlLink } : {}),
      };
      return { date, eventId: event.id, status: "failed", retryable: true, code: "unconfirmed", message: "Google returned an unconfirmed event" };
    }
    if (response.status !== 409) {
      return {
        date,
        eventId: event.id,
        status: "failed",
        retryable: retryableStatus(response.status),
        code: `google-${response.status}`,
        message: `Google Calendar rejected the event (${response.status})`,
      };
    }

    const existingResponse = await fetchWithTimeout(`${baseUrl}/events/${encodeURIComponent(event.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!existingResponse.ok) {
      return {
        date,
        eventId: event.id,
        status: "failed",
        retryable: retryableStatus(existingResponse.status) || existingResponse.status === 404,
        code: "duplicate-unverified",
        message: "Could not verify the existing calendar event",
      };
    }
    const existing = (await existingResponse.json()) as Record<string, any>;
    if (!eventMatches(existing, event)) {
      return {
        date,
        eventId: event.id,
        status: "failed",
        retryable: false,
        code: "duplicate-mismatch",
        message: "The stable event ID already belongs to different appointment data",
      };
    }
    return {
      date, eventId: event.id, status: "confirmed", code: "already-existed",
      ...(typeof existing.htmlLink === "string" ? { href: existing.htmlLink } : {}),
    };
  } catch {
    return { date, eventId: event.id, status: "failed", retryable: true, code: "upstream-unavailable", message: "Google Calendar is temporarily unavailable" };
  }
}

export async function createCalendarEvents(
  appointment: ValidatedAppointment,
  env: Env,
): Promise<DateResult[]> {
  if (!env.CALENDAR_ID || env.CALENDAR_ID === "REPLACE_WITH_SHARED_CALENDAR_ID") {
    throw new Error("The shared calendar is not configured");
  }
  // Resolve local times before authenticating so DST errors remain permanent validation errors.
  const events = await Promise.all(
    appointment.dates.map(async (date) => {
      const id = await eventId(appointment.submissionId, date);
      return { date, event: intendedEvent(id, appointment, date) };
    }),
  );
  const token = await accessToken(env);
  const baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}`;
  return Promise.all(events.map(({ date, event }) => addOne(baseUrl, token, event, date)));
}
