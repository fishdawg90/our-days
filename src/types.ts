export type PhraseKind = 'description' | 'location';
export type Step = 'dates' | 'time' | 'description' | 'location' | 'review';

export type Phrase = {
  kind: PhraseKind;
  text: string;
  normalised: string;
  useCount: number;
  lastUsedAt?: string;
  seeded?: boolean;
};

export type HistoryRecord = {
  descriptionPhrases: string[];
  locationPhrases: string[];
  eventDates: string[];
  submittedAt: string;
};

export type AppointmentDraft = {
  selectedDates: string[];
  allDay: boolean;
  time: string;
  durationMinutes: 30 | 60 | 120;
  descriptionParts: string[];
  locationParts: string[];
};

export type CalendarRequest = {
  submissionId: string;
  dates: string[];
  allDay: boolean;
  time?: string;
  durationMinutes?: number;
  summary: string;
  location?: string;
  timeZone: 'Europe/London';
};

export type CalendarResult = {
  date: string;
  eventId?: string;
  status: 'confirmed' | 'failed';
  code?: string;
  message?: string;
};

export type OutboxItem = {
  uid: string;
  request: CalendarRequest;
  pendingDates: string[];
  confirmedDates: string[];
  status: 'pending' | 'partial' | 'failed' | 'invalid' | 'learning';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  usage?: { descriptions: string[]; locations: string[] };
};

export const emptyDraft = (): AppointmentDraft => ({
  selectedDates: [],
  allDay: false,
  time: '09:00',
  durationMinutes: 60,
  descriptionParts: [],
  locationParts: [],
});
