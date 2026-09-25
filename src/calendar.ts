import { IS_E2E, WORKER_URL } from './config.ts';
import { listOutbox, putOutbox } from './storage.ts';
import type { CalendarRequest, CalendarResult, OutboxItem } from './types.ts';

export type TokenProvider = () => Promise<string>;
type Persistence = { put: (item: OutboxItem) => Promise<void> };
const PERMANENT_CODES = new Set(['INVALID_REQUEST', 'INVALID_DATE', 'INVALID_TIME', 'AMBIGUOUS_LOCAL_TIME', 'NONEXISTENT_LOCAL_TIME']);

class TransportError extends Error {
  permanent: boolean;
  constructor(message: string, permanent = false) { super(message); this.permanent = permanent; }
}

export async function queueRequest(uid: string, request: CalendarRequest,
                                   usage?: OutboxItem['usage']): Promise<OutboxItem> {
  const now = new Date().toISOString();
  const item: OutboxItem = {
    uid, request, pendingDates: [...request.dates], confirmedDates: [], status: 'pending', attempts: 0,
    createdAt: now, updatedAt: now, usage,
  };
  await putOutbox(item);
  return item;
}

function classifyError(error: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'You’re offline. This appointment is waiting on this device.';
  const message = error instanceof Error ? error.message : '';
  if (!message || /failed to (fetch|load)|networkerror|load failed/i.test(message))
    return 'Could not reach the calendar. This appointment is waiting on this device.';
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return 'The calendar took too long to respond. This appointment is waiting on this device.';
  return message;
}

export async function sendOutboxItem(item: OutboxItem, getToken: TokenProvider,
                                     fetcher: typeof fetch = fetch,
                                     persistence: Persistence = { put: putOutbox }): Promise<{ item: OutboxItem; complete: boolean; permanent: boolean }> {
  if (item.pendingDates.length === 0) return { item, complete: true, permanent: false };
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    return { item: { ...item, lastError: classifyError(null) }, complete: false, permanent: false };
  try {
    const token = await getToken();
    let results: CalendarResult[];
    if (IS_E2E) {
      results = item.pendingDates.map(date => ({ date, eventId: `e2e-${date}`, status: 'confirmed' as const }));
    } else {
      const response = await fetcher(`${WORKER_URL}/appointments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...item.request, dates: item.pendingDates }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({})) as { results?: CalendarResult[]; error?: string };
      if (!response.ok && !body.results) throw new TransportError(body.error || `Calendar service returned ${response.status}.`, response.status === 400 || response.status === 413);
      results = Array.isArray(body.results) ? body.results : [];
    }
    const requested = new Set(item.pendingDates);
    const confirmedNow = results.filter(result => result.status === 'confirmed' && requested.has(result.date) && typeof result.eventId === 'string' && result.eventId.length > 0).map(result => result.date);
    const confirmedDates = [...new Set([...item.confirmedDates, ...confirmedNow])].sort();
    const pendingDates = item.request.dates.filter(date => !confirmedDates.includes(date));
    const failure = results.find(result => result.status === 'failed');
    const permanent = Boolean(failure?.code && PERMANENT_CODES.has(failure.code));
    const next: OutboxItem = {
      ...item, confirmedDates, pendingDates,
      status: !pendingDates.length ? 'learning' : permanent ? 'invalid' : confirmedDates.length ? 'partial' : 'failed',
      attempts: item.attempts + 1, updatedAt: new Date().toISOString(),
      ...(failure?.message ? { lastError: failure.message } : {}),
    };
    await persistence.put(next);
    return { item: next, complete: !pendingDates.length, permanent };
  } catch (error) {
    const permanent = error instanceof TransportError && error.permanent;
    const next: OutboxItem = {
      ...item, status: permanent ? 'invalid' : item.confirmedDates.length ? 'partial' : 'failed', attempts: item.attempts + 1,
      updatedAt: new Date().toISOString(), lastError: classifyError(error),
    };
    await persistence.put(next);
    return { item: next, complete: false, permanent };
  }
}

export async function retryOutbox(uid: string, getToken: TokenProvider,
                                  onUpdate?: (item: OutboxItem) => void): Promise<OutboxItem[]> {
  const results: OutboxItem[] = [];
  for (const item of await listOutbox(uid)) {
    const result = item.pendingDates.length ? await sendOutboxItem(item, getToken) : { item, complete: true, permanent: false };
    results.push(result.item); onUpdate?.(result.item);
  }
  return results;
}
