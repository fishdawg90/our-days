export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAw3Ge98mwh4Ziv8Zpo_vNRp_OgqQfcj1g',
  authDomain: 'la-spesa-5cc7a.firebaseapp.com',
  projectId: 'la-spesa-5cc7a',
  appId: '1:767696505467:web:82873e463a2f93782bb0de',
} as const;

// Matching the existing Firebase app name lets the SDK share persisted auth when
// this app and Our Basket are served from the same fishdawg90.github.io origin.
export const FIREBASE_APP_NAME = 'la-spesa-5cc7a';
export const HOUSEHOLD_ID = 'home';
export const WORKER_URL = (import.meta.env.VITE_CALENDAR_WORKER_URL ||
  'https://our-days-calendar.mckibbon-ross.workers.dev').replace(/\/$/, '');
export const IS_E2E = import.meta.env.DEV && import.meta.env.VITE_E2E_MODE === 'true' &&
  ['127.0.0.1', 'localhost'].includes(window.location.hostname);

export const DESCRIPTION_SEEDS = [
  'Franci', 'Ross', 'Giulia', 'Nina', 'Dentist', 'Scan', 'Vaccine', 'Work Trip',
  'Flight', 'Meal', 'Arrival', 'Departure', 'airport', 'train', 'road trip',
  'midwife', 'blood test',
];

export const LOCATION_SEEDS = [
  'Heathrow', 'Gatwick', 'Stansted', 'Luton', 'London', 'Wales', 'Woking', 'Overseas',
  'Royal Surrey', 'St Johns Midwife', 'Mycroft Dentist', 'Sunny Mead Heathcote Road',
];
