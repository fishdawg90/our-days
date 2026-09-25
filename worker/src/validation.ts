import type { ValidatedAppointment } from "./types";

export const MAX_BODY_BYTES = 16_384;
// 20 dates leaves room under Workers' 50-subrequest limit even when every insert
// conflicts and requires a verification GET, plus auth and membership requests.
export const MAX_DATES = 20;

export class ValidationError extends Error {}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    year >= 2000 &&
    year <= 2100
  );
}

export function validateAppointment(value: unknown): ValidatedAppointment {
  if (!plainObject(value)) throw new ValidationError("Request body must be an object");

  const allowed = new Set([
    "submissionId",
    "dates",
    "summary",
    "location",
    "allDay",
    "time",
    "durationMinutes",
    "timeZone",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ValidationError("Request contains an unknown field");
  }

  if (
    typeof value.submissionId !== "string" ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(value.submissionId)
  ) {
    throw new ValidationError("submissionId must be 8-100 URL-safe characters");
  }
  if (!Array.isArray(value.dates) || value.dates.length === 0 || value.dates.length > MAX_DATES) {
    throw new ValidationError(`dates must contain 1-${MAX_DATES} dates`);
  }
  if (!value.dates.every((date): date is string => typeof date === "string" && validDate(date))) {
    throw new ValidationError("Every date must be a real YYYY-MM-DD date from 2000 to 2100");
  }
  if (new Set(value.dates).size !== value.dates.length) {
    throw new ValidationError("dates must not contain duplicates");
  }
  const dates = [...value.dates].sort();

  if (typeof value.summary !== "string") throw new ValidationError("summary is required");
  const summary = value.summary.trim().replace(/\s+/g, " ");
  if (!summary || summary.length > 200) {
    throw new ValidationError("summary must be 1-200 characters");
  }

  let location: string | undefined;
  if (value.location !== undefined) {
    if (typeof value.location !== "string") throw new ValidationError("location must be text");
    location = value.location.trim().replace(/\s+/g, " ") || undefined;
    if (location && location.length > 200) throw new ValidationError("location must be at most 200 characters");
  }

  if (typeof value.allDay !== "boolean") throw new ValidationError("allDay must be a boolean");
  if (value.timeZone !== "Europe/London") {
    throw new ValidationError("timeZone must be Europe/London");
  }
  if (dates.length > 1 && !value.allDay) {
    throw new ValidationError("Multiple dates must be submitted as separate all-day events");
  }

  if (value.allDay) {
    if (value.time !== undefined || value.durationMinutes !== undefined) {
      throw new ValidationError("All-day appointments cannot include time or durationMinutes");
    }
    return { submissionId: value.submissionId, dates, summary, location, allDay: true, timeZone: "Europe/London" };
  }

  if (typeof value.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) {
    throw new ValidationError("time must be HH:mm");
  }
  if (
    typeof value.durationMinutes !== "number" ||
    !Number.isInteger(value.durationMinutes) ||
    value.durationMinutes < 1 ||
    value.durationMinutes > 1_440
  ) {
    throw new ValidationError("durationMinutes must be a whole number from 1 to 1440");
  }

  return {
    submissionId: value.submissionId,
    dates,
    summary,
    location,
    allDay: false,
    time: value.time,
    durationMinutes: value.durationMinutes,
    timeZone: "Europe/London",
  };
}
