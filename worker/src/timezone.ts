const TIME_ZONE = "Europe/London";

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function displayedParts(epochMs: number): LocalParts {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function equalParts(left: LocalParts, right: LocalParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function offsetAt(epochMs: number): number {
  const parts = displayedParts(epochMs);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - epochMs;
}

export class LocalTimeError extends Error {
  constructor(public readonly kind: "nonexistent" | "ambiguous") {
    super(`The selected Europe/London time is ${kind} because of a daylight-saving change`);
  }
}

export function londonLocalToInstant(date: string, time: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wanted = { year, month, day, hour, minute };
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();

  // Sampling both sides of the requested day discovers both offsets on a DST transition.
  for (let hours = -36; hours <= 36; hours += 6) offsets.add(offsetAt(naive + hours * 3_600_000));

  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => equalParts(displayedParts(candidate), wanted));

  if (matches.length === 0) throw new LocalTimeError("nonexistent");
  if (matches.length > 1) throw new LocalTimeError("ambiguous");
  return new Date(matches[0]);
}

export function nextIsoDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

export { TIME_ZONE };
