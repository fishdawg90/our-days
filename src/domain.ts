import type { AppointmentDraft, CalendarRequest, HistoryRecord, Phrase, PhraseKind } from './types.ts';

export const normalisePhrase = (text: string): string => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
export const cleanPhrase = (text: string): string => text.trim().replace(/\s+/g, ' ').slice(0, 80);

export function addPhrase(parts: string[], raw: string): string[] {
  const text = cleanPhrase(raw);
  if (!text) return parts;
  const key = normalisePhrase(text);
  if (parts.some(part => normalisePhrase(part) === key)) return parts;
  return [...parts, text].slice(0, 20);
}

export function isoDateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(iso: string, count: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day + count, 12);
  return isoDateLocal(date);
}

export function toggleDate(selected: string[], date: string, max = 20): string[] {
  if (selected.includes(date)) return selected.filter(item => item !== date);
  if (selected.length >= max) return selected;
  return [...selected, date].sort();
}

export function formatDate(iso: string, style: 'short' | 'long' = 'long'): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', style === 'short'
    ? { weekday: 'short', day: 'numeric', month: 'short' }
    : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, day, 12));
}

export function validateDraft(draft: AppointmentDraft): string | null {
  if (!draft.selectedDates.length) return 'Choose at least one date.';
  if (draft.selectedDates.length > 20) return 'Choose no more than 20 dates.';
  if (!draft.descriptionParts.length || !draft.descriptionParts.join(' ').trim()) return 'Add a description.';
  if (draft.descriptionParts.join(' ').trim().length > 200) return 'Keep the description under 200 characters.';
  if (draft.locationParts.join(' ').trim().length > 200) return 'Keep the location under 200 characters.';
  if (draft.selectedDates.length === 1 && !draft.allDay && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time))
    return 'Choose a valid time.';
  return null;
}

export function makeSubmissionId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 26);
}

export function toCalendarRequest(draft: AppointmentDraft, submissionId = makeSubmissionId()): CalendarRequest {
  const error = validateDraft(draft);
  if (error) throw new Error(error);
  const allDay = draft.selectedDates.length > 1 || draft.allDay;
  return {
    submissionId,
    dates: [...draft.selectedDates].sort(),
    allDay,
    ...(allDay ? {} : { time: draft.time, durationMinutes: draft.durationMinutes }),
    summary: draft.descriptionParts.join(' '),
    ...(draft.locationParts.length ? { location: draft.locationParts.join(' ') } : {}),
    timeZone: 'Europe/London',
  };
}

const DAY_MS = 86_400_000;

function parseIsoDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function phrasesForKind(row: HistoryRecord, kind: PhraseKind): string[] {
  return kind === 'description' ? row.descriptionPhrases : row.locationPhrases;
}

function historyUsesPhrase(row: HistoryRecord, kind: PhraseKind, key: string): boolean {
  return phrasesForKind(row, kind).some(value => normalisePhrase(value) === key);
}

function recentHistoryFrequency(kind: PhraseKind, key: string, histories: HistoryRecord[], now: number): number {
  return histories.reduce((total, row) => {
    if (!historyUsesPhrase(row, kind, key)) return total;
    const submittedAt = Date.parse(row.submittedAt);
    if (!Number.isFinite(submittedAt)) return total;
    const ageDays = Math.max(0, (now - submittedAt) / DAY_MS);
    return total + Math.exp(-ageDays / 60);
  }, 0);
}

/**
 * Rewards a phrase only when at least two recent observed intervals agree with
 * the gap to the proposed date. The interval itself is learned from history;
 * no weekly/monthly/yearly periods are baked in. Three observations are still
 * deliberately weak evidence, with confidence growing as intervals repeat.
 */
function intervalAffinity(kind: PhraseKind, key: string, histories: HistoryRecord[], eventDate: string): number {
  const target = parseIsoDay(eventDate);
  if (target === null) return 0;

  const observed = histories
    .filter(row => historyUsesPhrase(row, kind, key))
    .flatMap(row => row.eventDates)
    .map(parseIsoDay)
    .filter((date): date is number => date !== null && date < target)
    .filter((date, index, dates) => dates.indexOf(date) === index)
    .sort((a, b) => a - b)
    .slice(-10);
  if (observed.length < 3) return 0;

  const intervals = observed.slice(1).map((date, index) => (date - observed[index]) / DAY_MS)
    .filter(days => days >= 3 && days <= 400)
    .slice(-6);
  if (intervals.length < 2) return 0;

  const typical = median(intervals);
  const tolerance = Math.max(2, typical * .12);
  const consistency = intervals.reduce((sum, days) =>
    sum + Math.exp(-Math.pow((days - typical) / tolerance, 2)), 0) / intervals.length;
  const proposedGap = (target - observed[observed.length - 1]) / DAY_MS;
  const targetFit = Math.exp(-Math.pow((proposedGap - typical) / tolerance, 2));
  const confidence = Math.min(1, (intervals.length - 1) / 3);
  return 2.8 * confidence * consistency * targetFit;
}

export function rankPhrases(kind: PhraseKind, phrases: Phrase[], histories: HistoryRecord[], eventDate: string,
                            query = '', selected: string[] = [], now = Date.now()): Phrase[] {
  const selectedKeys = new Set(selected.map(normalisePhrase));
  const q = normalisePhrase(query);
  const unique = new Map<string, Phrase>();
  for (const phrase of phrases) {
    if (phrase.kind !== kind) continue;
    const key = normalisePhrase(phrase.text);
    if (!key || selectedKeys.has(key)) continue;
    const existing = unique.get(key);
    if (!existing || phrase.useCount > existing.useCount) unique.set(key, { ...phrase, normalised: key });
  }
  return [...unique.values()].map(phrase => {
    const key = normalisePhrase(phrase.text);
    const ageDays = phrase.lastUsedAt ? Math.max(0, (now - Date.parse(phrase.lastUsedAt)) / 86_400_000) : 180;
    const fieldRecency = Number.isFinite(ageDays) ? .35 * Math.exp(-ageDays / 42) : 0;
    const recentFrequency = 2 * Math.log1p(recentHistoryFrequency(kind, key, histories, now));
    const boundedLifetimePrior = .12 * Math.log1p(Math.min(50, Math.max(0, phrase.useCount)));
    const match = !q ? 0 : key.startsWith(q) ? 7 : key.includes(q) ? 3 : -10;
    const prior = phrase.seeded ? .35 : 0;
    return {
      phrase,
      score: recentFrequency + fieldRecency + boundedLifetimePrior + match + prior +
        intervalAffinity(kind, key, histories, eventDate),
    };
  }).filter(row => row.score > -5)
    .sort((a, b) => b.score - a.score || a.phrase.text.localeCompare(b.phrase.text))
    .slice(0, 100).map(row => row.phrase);
}

export function phraseId(kind: PhraseKind, text: string): string {
  const value = `${kind}:${normalisePhrase(text)}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `${kind}-${(hash >>> 0).toString(36)}`;
}
