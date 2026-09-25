import { describe, expect, it } from 'vitest';
import { addPhrase, dateRange, rankPhrases, toggleDate, validateDraft } from '../src/domain.ts';
import type { AppointmentDraft, HistoryRecord, Phrase, PhraseKind } from '../src/types.ts';

const NOW = Date.parse('2026-02-01T12:00:00Z');

function phrase(text: string, useCount = 0, kind: PhraseKind = 'description'): Phrase {
  return { kind, text, normalised: text.toLocaleLowerCase('en-GB'), useCount };
}

function history(
  text: string,
  eventDates: string[],
  submittedAt = '2026-02-01T10:00:00Z',
  kind: PhraseKind = 'description',
): HistoryRecord {
  return {
    descriptionPhrases: kind === 'description' ? [text] : [],
    locationPhrases: kind === 'location' ? [text] : [],
    eventDates,
    submittedAt,
  };
}

describe('phrase input', () => {
  it('deduplicates case and collapsed whitespace variants', () => {
    const first = addPhrase([], '  Blood   Test  ');
    expect(addPhrase(first, 'blood test')).toEqual(['Blood Test']);
  });

  it('deduplicates loaded phrase variants and excludes selected variants', () => {
    const variants = [phrase('Blood Test', 1), phrase('  blood   test ', 4)];
    expect(rankPhrases('description', variants, [], '2026-02-02', '', [], NOW)).toHaveLength(1);
    expect(rankPhrases('description', variants, [], '2026-02-02', '', ['BLOOD TEST'], NOW)).toEqual([]);
  });
});

describe('date limits', () => {
  it('builds an inclusive contiguous range and honours the 20-day cap', () => {
    expect(dateRange('2026-09-28', '2026-10-02')).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02',
    ]);
    expect(dateRange('2026-09-01', '2026-10-01')).toHaveLength(20);
  });

  it('does not toggle more than 20 selected dates', () => {
    const dates = Array.from({ length: 20 }, (_, index) => `2026-03-${String(index + 1).padStart(2, '0')}`);
    expect(toggleDate(dates, '2026-03-21')).toEqual(dates);
  });

  it('rejects a draft containing more than 20 dates even if it bypasses the picker', () => {
    const draft: AppointmentDraft = {
      selectedDates: Array.from({ length: 21 }, (_, index) => `2026-03-${String(index + 1).padStart(2, '0')}`),
      allDay: true,
      time: '09:00',
      durationMinutes: 60,
      descriptionParts: ['Dentist'],
      locationParts: [],
    };
    expect(validateDraft(draft)).toBe('Choose no more than 20 dates.');
  });
});

describe('phrase ranking', () => {
  it('lets decayed recent history outweigh a very large lifetime counter', () => {
    const phrases = [phrase('Old favourite', 10_000), phrase('Recently useful')];
    const histories = [
      history('Recently useful', ['2026-02-03']),
      history('Recently useful', ['2026-02-04'], '2026-01-31T10:00:00Z'),
      history('Old favourite', ['2024-01-01'], '2024-01-01T10:00:00Z'),
    ];
    expect(rankPhrases('description', phrases, histories, '2026-02-10', '', [], NOW)[0].text)
      .toBe('Recently useful');
  });

  it('decays old history rather than treating all uses equally', () => {
    const phrases = [phrase('Old use'), phrase('Fresh use')];
    const histories = [
      history('Old use', ['2025-01-01'], '2025-01-01T10:00:00Z'),
      history('Old use', ['2025-01-02'], '2025-01-02T10:00:00Z'),
      history('Fresh use', ['2026-02-04']),
    ];
    expect(rankPhrases('description', phrases, histories, '2026-02-10', '', [], NOW)[0].text)
      .toBe('Fresh use');
  });

  it('infers a non-standard recurring interval from recent event dates', () => {
    const phrases = [phrase('Ten day treatment'), phrase('Often used')];
    const histories = [
      history('Ten day treatment', ['2026-01-01']),
      history('Ten day treatment', ['2026-01-11']),
      history('Ten day treatment', ['2026-01-21']),
      history('Often used', ['2026-01-03']),
      history('Often used', ['2026-01-08']),
      history('Often used', ['2026-01-17']),
      history('Often used', ['2026-01-25']),
    ];
    expect(rankPhrases('description', phrases, histories, '2026-01-31', '', [], NOW)[0].text)
      .toBe('Ten day treatment');
  });

  it('does not infer recurrence from one sparse observation', () => {
    const phrases = [phrase('Zulu sparse'), phrase('Alpha ordinary')];
    const histories = [
      history('Zulu sparse', ['2026-01-25']),
      history('Alpha ordinary', ['2026-01-14']),
    ];
    expect(rankPhrases('description', phrases, histories, '2026-02-01', '', [], NOW)[0].text)
      .toBe('Alpha ordinary');
  });

  it('uses only history for the requested phrase kind', () => {
    const phrases = [phrase('Zulu', 0), phrase('Alpha', 0)];
    const histories = [history('Zulu', ['2026-01-25'], '2026-02-01T10:00:00Z', 'location')];
    expect(rankPhrases('description', phrases, histories, '2026-02-01', '', [], NOW)[0].text).toBe('Alpha');
  });

  it('caps ranked output at 100 unique phrases', () => {
    const phrases = Array.from({ length: 120 }, (_, index) => phrase(`Phrase ${index}`));
    expect(rankPhrases('description', phrases, [], '2026-02-01', '', [], NOW)).toHaveLength(100);
  });
});
