export interface Env {
  CALENDAR_ID: string;
  FIREBASE_PROJECT_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
}

export interface AppointmentRequest {
  submissionId: string;
  dates: string[];
  summary: string;
  location?: string;
  allDay: boolean;
  time?: string;
  durationMinutes?: number;
  timeZone: "Europe/London";
}

export interface ValidatedAppointment extends AppointmentRequest {
  dates: string[];
  summary: string;
  location?: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  location?: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  extendedProperties: {
    private: { submissionId: string; appointmentDate: string; source: string };
  };
}

export interface DateResult {
  date: string;
  eventId: string;
  status: "confirmed" | "failed";
  code?: string;
  message?: string;
  href?: string;
  retryable?: boolean;
}
