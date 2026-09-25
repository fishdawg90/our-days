import { describe, expect, it, vi } from 'vitest';
import { sendOutboxItem } from '../src/calendar.ts';
import type { OutboxItem } from '../src/types.ts';

function item(): OutboxItem {
  return {
    uid: 'uid-a',
    request: {
      submissionId: 'submission123', dates: ['2026-10-01', '2026-10-02'], allDay: true,
      summary: 'Work Trip', timeZone: 'Europe/London',
    },
    pendingDates: ['2026-10-01', '2026-10-02'], confirmedDates: [], status: 'pending', attempts: 0,
    createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T10:00:00.000Z',
  };
}

const token = async () => 'firebase-token';
const persistence = () => ({ put: vi.fn(async () => {}) });

describe('calendar transport', () => {
  it('keeps only failed dates pending after a partial response', async () => {
    const store = persistence();
    const fetcher = vi.fn(async () => Response.json({ results: [
      { date: '2026-10-01', status: 'confirmed', eventId: 'google-event-1' },
      { date: '2026-10-02', status: 'failed', code: 'upstream-unavailable', message: 'Try again' },
    ]}, { status: 207 })) as unknown as typeof fetch;
    const result = await sendOutboxItem(item(), token, fetcher, store);
    expect(result.complete).toBe(false);
    expect(result.permanent).toBe(false);
    expect(result.item.status).toBe('partial');
    expect(result.item.confirmedDates).toEqual(['2026-10-01']);
    expect(result.item.pendingDates).toEqual(['2026-10-02']);
    expect(store.put).toHaveBeenCalledOnce();
  });

  it('does not trust a confirmed result without an event ID', async () => {
    const store = persistence();
    const fetcher = vi.fn(async () => Response.json({ results: [
      { date: '2026-10-01', status: 'confirmed' },
      { date: '2026-10-02', status: 'confirmed', eventId: '' },
    ]})) as unknown as typeof fetch;
    const result = await sendOutboxItem(item(), token, fetcher, store);
    expect(result.complete).toBe(false);
    expect(result.item.confirmedDates).toEqual([]);
    expect(result.item.pendingDates).toEqual(item().pendingDates);
  });

  it('classifies a 400 response as permanent and retains the outbox record', async () => {
    const store = persistence();
    const fetcher = vi.fn(async () => Response.json({ error: 'Invalid local time' }, { status: 400 })) as unknown as typeof fetch;
    const result = await sendOutboxItem(item(), token, fetcher, store);
    expect(result.permanent).toBe(true);
    expect(result.item.status).toBe('invalid');
    expect(result.item.lastError).toBe('Invalid local time');
    expect(store.put).toHaveBeenCalledWith(expect.objectContaining({ uid: 'uid-a' }));
  });

  it('ignores confirmations for dates that were not requested', async () => {
    const store = persistence();
    const fetcher = vi.fn(async () => Response.json({ results: [
      { date: '2026-12-25', status: 'confirmed', eventId: 'wrong-date' },
    ]})) as unknown as typeof fetch;
    const result = await sendOutboxItem(item(), token, fetcher, store);
    expect(result.complete).toBe(false);
    expect(result.item.confirmedDates).toEqual([]);
  });
});
