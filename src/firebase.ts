import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence, getAuth, onAuthStateChanged, sendPasswordResetEmail,
  setPersistence, signInWithEmailAndPassword, signOut, type Auth, type User,
} from 'firebase/auth';
import {
  collection, doc, getDoc, getDocFromCache, getDocs, getDocsFromCache, initializeFirestore, limit, orderBy,
  persistentLocalCache, persistentMultipleTabManager, query, runTransaction, serverTimestamp,
  where, type Firestore, type Query, type QuerySnapshot,
} from 'firebase/firestore';
import { DESCRIPTION_SEEDS, FIREBASE_APP_NAME, FIREBASE_CONFIG, HOUSEHOLD_ID, LOCATION_SEEDS } from './config.ts';
import { cleanPhrase, normalisePhrase, phraseId } from './domain.ts';
import type { HistoryRecord, Phrase, PhraseKind } from './types.ts';

let opened: { app: FirebaseApp; auth: Auth; db: Firestore } | null = null;

export function openFirebase(): { auth: Auth; db: Firestore } {
  if (opened) return opened;
  const app = getApps().find(candidate => candidate.name === FIREBASE_APP_NAME) ||
    initializeApp(FIREBASE_CONFIG, FIREBASE_APP_NAME);
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  const auth = getAuth(app);
  void setPersistence(auth, browserLocalPersistence);
  opened = { app, auth, db };
  return { auth, db };
}

export { onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut };

export async function hasHouseholdAccess(db: Firestore, user: User): Promise<boolean> {
  const member = doc(db, 'households', HOUSEHOLD_ID, 'members', user.uid);
  try { if ((await getDocFromCache(member)).exists()) return true; } catch { /* not cached */ }
  return (await getDoc(member)).exists();
}

const seeds = (kind: PhraseKind): Phrase[] => (kind === 'description' ? DESCRIPTION_SEEDS : LOCATION_SEEDS).map(text => ({
  kind, text, normalised: normalisePhrase(text), useCount: 0, seeded: true,
}));

async function getDocsWithCacheFallback(source: Query): Promise<QuerySnapshot> {
  try {
    return await getDocs(source);
  } catch (serverError) {
    const code = (serverError as { code?: string }).code || '';
    if (code === 'failed-precondition' || code === 'permission-denied') throw serverError;
    try { return await getDocsFromCache(source); } catch { throw serverError; }
  }
}

export async function loadSuggestions(db: Firestore): Promise<{ phrases: Phrase[]; histories: HistoryRecord[] }> {
  const phraseCollection = collection(db, 'households', HOUSEHOLD_ID, 'appointmentPhrases');
  const descriptionQuery = query(phraseCollection, where('kind', '==', 'description'), orderBy('lastUsedAt', 'desc'), limit(100));
  const locationQuery = query(phraseCollection, where('kind', '==', 'location'), orderBy('lastUsedAt', 'desc'), limit(100));
  const historyQuery = query(collection(db, 'households', HOUSEHOLD_ID, 'appointmentHistory'), orderBy('submittedAt', 'desc'), limit(200));
  const [descriptionRows, locationRows, historyRows] = await Promise.all([
    getDocsWithCacheFallback(descriptionQuery),
    getDocsWithCacheFallback(locationQuery),
    getDocsWithCacheFallback(historyQuery),
  ]);
  const phrases = [
    ...seeds('description'), ...seeds('location'),
    ...descriptionRows.docs.map(row => row.data() as Phrase),
    ...locationRows.docs.map(row => row.data() as Phrase),
  ];
  const histories = historyRows.docs.map(row => {
    const data = row.data();
    return {
      descriptionPhrases: Array.isArray(data.descriptionPhrases) ? data.descriptionPhrases : [],
      locationPhrases: Array.isArray(data.locationPhrases) ? data.locationPhrases : [],
      eventDates: Array.isArray(data.eventDates) ? data.eventDates : [],
      submittedAt: data.submittedAt?.toDate?.().toISOString?.() || new Date(0).toISOString(),
    } satisfies HistoryRecord;
  });
  return { phrases, histories };
}

export function localSeedSuggestions(): { phrases: Phrase[]; histories: HistoryRecord[] } {
  return { phrases: [...seeds('description'), ...seeds('location')], histories: [] };
}

export async function recordConfirmedUsage(db: Firestore, uid: string, submissionId: string,
                                           descriptionPhrases: string[], locationPhrases: string[], eventDates: string[]): Promise<void> {
  const historyRef = doc(db, 'households', HOUSEHOLD_ID, 'appointmentHistory', submissionId);
  await runTransaction(db, async transaction => {
    if ((await transaction.get(historyRef)).exists()) return;
    const sanitisePhrases = (values: string[], max: number): string[] => {
      const unique = new Map<string, string>();
      for (const raw of values) {
        const text = cleanPhrase(raw);
        const key = normalisePhrase(text);
        if (key && !unique.has(key)) unique.set(key, text);
        if (unique.size === max) break;
      }
      return [...unique.values()];
    };
    const safeDescriptions = sanitisePhrases(descriptionPhrases, 20);
    const safeLocations = sanitisePhrases(locationPhrases, 10);
    const safeDates = [...new Set(eventDates.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].slice(0, 20);
    const all = [
      ...safeDescriptions.map(text => ({ kind: 'description' as const, text })),
      ...safeLocations.map(text => ({ kind: 'location' as const, text })),
    ];
    const refs = all.map(item => doc(db, 'households', HOUSEHOLD_ID, 'appointmentPhrases', phraseId(item.kind, item.text)));
    const existing = await Promise.all(refs.map(ref => transaction.get(ref)));
    const usedAt = new Date().toISOString();
    all.forEach((item, index) => {
      const previous = existing[index].data() as Phrase | undefined;
      transaction.set(refs[index], {
        kind: item.kind,
        text: item.text,
        normalised: normalisePhrase(item.text),
        useCount: Math.min(10_000, (previous?.useCount || 0) + 1),
        lastUsedAt: usedAt,
      });
    });
    transaction.set(historyRef, {
      descriptionPhrases: safeDescriptions, locationPhrases: safeLocations, eventDates: safeDates,
      submittedAt: serverTimestamp(), createdBy: uid,
    });
  });
}
