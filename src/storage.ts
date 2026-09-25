import type { AppointmentDraft, OutboxItem } from './types.ts';

const DB_NAME = 'our-days';
const DB_VERSION = 1;
const DRAFT_KEY = 'our-days-draft-v1';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: ['uid', 'request.submissionId'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open offline storage.'));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Offline storage failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Offline storage was interrupted.'));
  });
}

export async function putOutbox(item: OutboxItem): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction('outbox', 'readwrite');
  transaction.objectStore('outbox').put(item);
  await complete(transaction); db.close();
}

export async function removeOutbox(uid: string, submissionId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction('outbox', 'readwrite');
  transaction.objectStore('outbox').delete([uid, submissionId]);
  await complete(transaction); db.close();
}

export async function listOutbox(uid: string): Promise<OutboxItem[]> {
  const db = await openDatabase();
  const transaction = db.transaction('outbox', 'readonly');
  const request = transaction.objectStore('outbox').getAll();
  const rows = await new Promise<OutboxItem[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as OutboxItem[]);
    request.onerror = () => reject(request.error);
  });
  await complete(transaction); db.close();
  return rows.filter(row => row.uid === uid).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function saveDraft(draft: AppointmentDraft): void {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function loadDraft(): AppointmentDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') as AppointmentDraft | null;
    return value && Array.isArray(value.selectedDates) && Array.isArray(value.descriptionParts) ? value : null;
  } catch { return null; }
}

export function clearDraft(): void { localStorage.removeItem(DRAFT_KEY); }
