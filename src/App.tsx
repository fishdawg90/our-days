import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ArrowLeft, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, CloudOff, LogOut, MapPin, Minus, Plus, RotateCw, X } from 'lucide-react';
import type { Auth, User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { IS_E2E } from './config.ts';
import { sendOutboxItem, queueRequest, retryOutbox } from './calendar.ts';
import { addDays, addPhrase, cleanPhrase, dateRange, formatDate, isoDateLocal, normalisePhrase, rankPhrases, toCalendarRequest } from './domain.ts';
import {
  hasHouseholdAccess, loadSuggestions, localSeedSuggestions, onAuthStateChanged, openFirebase,
  recordConfirmedUsage, sendPasswordResetEmail, signInWithEmailAndPassword, signOut,
} from './firebase.ts';
import { clearDraft, listOutbox, loadDraft, removeOutbox, saveDraft } from './storage.ts';
import { emptyDraft, type AppointmentDraft, type HistoryRecord, type OutboxItem, type Phrase, type PhraseKind, type Step } from './types.ts';

type AuthState = 'restoring' | 'signed-out' | 'checking' | 'ready' | 'denied' | 'error';
type SaveState = 'idle' | 'saving' | 'pending' | 'partial' | 'invalid' | 'saved';
const stepOrder: Step[] = ['dates', 'time', 'description', 'location'];
const labels: Record<Step, string> = { dates: 'Dates', time: 'Time', description: 'What', location: 'Where', review: 'Review' };

function monthStart(date: Date): Date { return new Date(date.getFullYear(), date.getMonth(), 1, 12); }
function moveMonth(date: Date, by: number): Date { return new Date(date.getFullYear(), date.getMonth() + by, 1, 12); }
function dateFromIso(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}
function startOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}
function endOfWeek(date: Date): Date {
  const result = startOfWeek(date);
  result.setDate(result.getDate() + 6);
  return result;
}
function sameMonth(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
}

function MonthPicker({ selected, onChange }: { selected: string[]; onChange: (dates: string[]) => void }) {
  const today = isoDateLocal(new Date());
  const tomorrow = addDays(today, 1);
  const currentMonth = monthStart(new Date());
  const [month, setMonth] = useState(currentMonth);
  const isCurrentMonth = sameMonth(month, currentMonth);
  const firstVisible = isCurrentMonth ? startOfWeek(dateFromIso(today)) : startOfWeek(month);
  const lastVisible = endOfWeek(new Date(month.getFullYear(), month.getMonth() + 1, 0, 12));
  const cells: string[] = [];
  for (let date = firstVisible; date <= lastVisible; date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12)) {
    cells.push(isoDateLocal(date));
  }
  const drag = useRef<{ endpoint: 'start' | 'end'; origin: string; start: string; end: string; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const start = selected[0];
  const end = selected[selected.length - 1];
  const choose = (iso: string) => {
    if (iso < today) return;
    if (!selected.length) return onChange([iso]);
    if (selected.length === 1) {
      if (iso === start) return onChange([]);
      return onChange(iso > start ? dateRange(start, iso) : [iso]);
    }
    if (iso === start || iso === end) return;
    onChange([iso]);
  };
  const moveEndpoint = (endpoint: 'start' | 'end', iso: string, bounds = { start, end }) => {
    if (iso < today) return;
    if (endpoint === 'start' && iso <= bounds.end) {
      const next = dateRange(iso, bounds.end);
      onChange(next.length === 20 && next[19] < bounds.end ? dateRange(addDays(bounds.end, -19), bounds.end) : next);
    }
    if (endpoint === 'end' && iso >= bounds.start) onChange(dateRange(bounds.start, iso));
  };
  const beginDrag = (endpoint: 'start' | 'end', event: ReactPointerEvent<HTMLButtonElement>) => {
    if (selected.length < 2) return;
    drag.current = { endpoint, origin: event.currentTarget.dataset.iso || '', start, end, moved: false };
    setDragging(endpoint);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const dragMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>('button[data-iso]');
    const iso = target?.dataset.iso;
    if (!iso || iso === drag.current.origin) return;
    drag.current.moved = true;
    suppressClick.current = true;
    moveEndpoint(drag.current.endpoint, iso, drag.current);
  };
  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (current) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>('button[data-iso]');
      const iso = target?.dataset.iso;
      if (iso && iso !== current.origin) {
        current.moved = true; suppressClick.current = true;
        moveEndpoint(current.endpoint, iso, current);
      }
    }
    drag.current = null; setDragging(null);
  };
  return <>
    <div className="quick-row" aria-label="Quick dates">
      {[['Today', today], ['Tomorrow', tomorrow]].map(([name, iso]) =>
        <button type="button" className="quick-date" aria-pressed={selected.includes(iso)} key={iso} onClick={() => choose(iso)}>
          <span>{name}</span><strong>{new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</strong>
        </button>)}
    </div>
    <section className={`calendar-card${dragging ? ' dragging' : ''}`} aria-label="Choose appointment dates"
      onPointerMove={dragMove} onPointerUp={finishDrag} onPointerCancel={() => { drag.current = null; setDragging(null); }}>
      <div className="month-head">
        <button className="icon-button" type="button" aria-label="Previous month" disabled={isCurrentMonth}
          onClick={() => setMonth(value => moveMonth(value, -1))}><ChevronLeft /></button>
        <h2 aria-live="polite">{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h2>
        <button className="icon-button" type="button" aria-label="Next month" onClick={() => setMonth(value => moveMonth(value, 1))}><ChevronRight /></button>
      </div>
      <div className="weekdays" aria-hidden="true">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span key={`${day}${index}`}>{day}</span>)}</div>
      <div className="month-grid">
        {cells.map((iso, index) => {
          const date = dateFromIso(iso);
          const day = date.getDate();
          const chosen = selected.includes(iso);
          const endpoint = selected.length > 1 ? iso === start ? 'start' : iso === end ? 'end' : null : null;
          const outside = !sameMonth(date, month);
          const past = iso < today;
          const showMonth = index === 0 || day === 1;
          return <button type="button" key={iso} data-iso={iso} data-past={past || undefined}
            aria-label={`${formatDate(iso)}${past ? ', unavailable' : endpoint ? `, ${endpoint} of selected range, drag to adjust` : ''}`}
            aria-pressed={chosen} disabled={past}
            className={`${outside ? 'outside ' : ''}${past ? 'past ' : ''}${iso === today ? 'today ' : ''}${chosen ? 'selected ' : ''}${endpoint ? `range-${endpoint} ` : chosen ? 'range-middle ' : ''}${dragging === endpoint ? 'active-drag' : ''}`}
            onPointerDown={event => endpoint && beginDrag(endpoint, event)}
            onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } choose(iso); }}>
            {showMonth && <small>{date.toLocaleDateString('en-GB', { month: 'short' })}</small>}
            <strong>{day}</strong>
            {endpoint && <span className="drag-grip" aria-hidden="true" />}
          </button>;
        })}
      </div>
    </section>
    {selected.length > 0 && <div className={`range-feedback${selected.length === 1 ? ' waiting' : ''}`} aria-live="polite">
      <div><strong>{selected.length === 1 ? `${formatDate(start, 'short')} selected` : `${selected.length}-day range`}</strong>
        <span>{selected.length === 1 ? 'Tap a later day for a range, or continue for one day.' : `${formatDate(start, 'short')} – ${formatDate(end, 'short')}. Drag either end to adjust.`}</span></div>
      <button type="button" onClick={() => onChange([])} aria-label="Clear selected dates"><X size={16} /> Clear</button>
    </div>}
  </>;
}

function PhraseCloud({ kind, phrases, histories, selected, query, eventDate, onChoose }: {
  kind: PhraseKind; phrases: Phrase[]; histories: HistoryRecord[]; selected: string[]; query: string; eventDate: string;
  onChoose: (text: string) => void;
}) {
  const ranked = useMemo(() => rankPhrases(kind, phrases, histories, eventDate, query, selected).slice(0, 17),
    [kind, phrases, histories, eventDate, query, selected]);
  return <div className="phrase-cloud" aria-label={`${kind} suggestions`}>
    {ranked.map((phrase, index) => <button type="button" key={`${kind}-${phrase.normalised}`}
      style={{ '--i': index } as React.CSSProperties} onClick={() => onChoose(phrase.text)}>{phrase.text}</button>)}
  </div>;
}

function PhraseStep({ kind, title, hint, parts, setParts, phrases, histories, eventDate, onContinue, onSkip,
  actionLabel = 'Continue', actionDisabled = false, beforeActions }: {
  kind: PhraseKind; title: string; hint: string; parts: string[]; setParts: (parts: string[]) => void;
  phrases: Phrase[]; histories: HistoryRecord[]; eventDate: string; onContinue: (parts: string[]) => void; onSkip?: () => void;
  actionLabel?: string; actionDisabled?: boolean; beforeActions?: ReactNode;
}) {
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const add = () => { const next = addPhrase(parts, value); if (next !== parts) { setParts(next); setValue(''); } };
  const continueWithInput = () => {
    const next = addPhrase(parts, value);
    if (next !== parts) setParts(next);
    if (kind === 'description' && next.length === 0) { input.current?.focus(); return; }
    setValue(''); onContinue(next);
  };
  const choose = (text: string) => { setParts(addPhrase(parts, text)); setValue(''); };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); add(); } };
  return <section className="flow-section">
    <div className="section-title"><span className="round-icon">{kind === 'location' ? <MapPin /> : <Plus />}</span><div><h1>{title}</h1><p>{hint}</p></div></div>
    <label className="phrase-input"><span>{kind === 'description' ? 'Description' : 'Location'}</span><div>
      <input ref={input} value={value} onChange={event => setValue(event.target.value)} onKeyDown={keyDown}
        maxLength={80} placeholder={kind === 'description' ? 'Type something…' : 'Type a place…'} />
      <button type="button" onClick={add} disabled={!cleanPhrase(value)} aria-label={`Add ${kind}`}><Plus /></button>
    </div></label>
    {parts.length > 0 && <div className="chosen-phrases" aria-label={`Selected ${kind}`}>
      {parts.map((part, index) => <button type="button" key={`${normalisePhrase(part)}-${index}`} onClick={() => setParts(parts.filter((_, partIndex) => partIndex !== index))}>{part}<X size={13} /></button>)}
    </div>}
    <p className="suggest-label">Suggestions</p>
    <PhraseCloud kind={kind} phrases={phrases} histories={histories} selected={parts} query={value} eventDate={eventDate} onChoose={choose} />
    {beforeActions}
    <div className="flow-actions">
      {onSkip && <button type="button" className="quiet-button" onClick={onSkip}>Skip location</button>}
      <button type="button" className="primary-button" disabled={actionDisabled || (kind === 'description' && !parts.length && !cleanPhrase(value))} onClick={continueWithInput}>{actionLabel}</button>
    </div>
  </section>;
}

function SignInCard({ auth, email, setEmail, password, setPassword, error, setError }: {
  auth: Auth | null; email: string; setEmail: (value: string) => void; password: string; setPassword: (value: string) => void;
  error: string; setError: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!auth) return; setBusy(true); setError('');
    try { await signInWithEmailAndPassword(auth, email.trim(), password); setPassword(''); }
    catch { setError('That email or password was not accepted.'); }
    finally { setBusy(false); }
  };
  return <section className="auth-card" aria-labelledby="sign-in-title">
    <p className="eyebrow">SHARED CALENDAR</p><h2 id="sign-in-title">Sign in to add it</h2>
    <p>Use the same household account as Our Basket.</p>
    <form onSubmit={submit}>
      <label>Email<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="primary-button" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <button type="button" className="link-button" onClick={async () => {
        if (!auth || !email.trim()) return setError('Enter your email first.');
        try { await sendPasswordResetEmail(auth, email.trim()); setError('Password reset email sent.'); }
        catch { setError('The reset email could not be sent.'); }
      }}>Forgot password?</button>
    </form>
  </section>;
}

function SummaryPanel({ draft }: { draft: AppointmentDraft }) {
  return <div className="summary-wrap"><p className="suggest-label">Summary</p><div className="summary-card">
    <div><span>What</span><strong>{draft.descriptionParts.join(' ')}</strong></div>
    <div><span>{draft.selectedDates.length > 1 ? 'Dates' : 'Date'}</span><strong>{draft.selectedDates.map(date => formatDate(date, 'short')).join(', ')}</strong></div>
    <div><span>Time</span><strong>{draft.selectedDates.length > 1 ? `${draft.selectedDates.length} separate all-day events` : draft.allDay ? 'All day' : `${draft.time} · ${draft.durationMinutes} min`}</strong></div>
    {draft.locationParts.length > 0 && <div><span>Where</span><strong>{draft.locationParts.join(' ')}</strong></div>}
  </div></div>;
}

function timeToTick(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return Math.max(0, Math.min(143, Math.round((hours * 60 + minutes) / 10)));
}

function tickToTime(tick: number): string {
  const minutes = Math.max(0, Math.min(143, tick)) * 10;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function TimeChooser({ draft, update }: { draft: AppointmentDraft; update: (change: Partial<AppointmentDraft>) => void }) {
  const tick = timeToTick(draft.time);
  const chooseTick = (next: number) => update({ time: tickToTime(next) });
  return <div className="time-card">
    <div className="time-readout"><span>Start time</span><output htmlFor="time-dial" aria-live="polite">{tickToTime(tick)}</output></div>
    <div className="time-dial-row">
      <button type="button" aria-label="10 minutes earlier" onClick={() => chooseTick(tick - 1)} disabled={tick === 0}><Minus /></button>
      <input id="time-dial" type="range" min="0" max="143" step="1" value={tick}
        aria-label="Start time" aria-valuetext={tickToTime(tick)}
        style={{ '--time-progress': `${tick / 143 * 100}%` } as React.CSSProperties}
        onChange={event => chooseTick(Number(event.target.value))} />
      <button type="button" aria-label="10 minutes later" onClick={() => chooseTick(tick + 1)} disabled={tick === 143}><Plus /></button>
    </div>
    <div className="time-scale" aria-hidden="true"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:50</span></div>
    <label className="duration-label">Duration</label>
    <div className="chip-row" aria-label="Duration">{[30, 60, 120].map(duration => <button key={duration} type="button"
      aria-pressed={draft.durationMinutes === duration} onClick={() => update({ durationMinutes: duration as 30 | 60 | 120 })}>
      {duration < 60 ? '30 min' : `${duration / 60} hr${duration === 120 ? 's' : ''}`}
    </button>)}</div>
  </div>;
}

function AppointmentStrip({ draft, showTime }: { draft: AppointmentDraft; showTime: boolean }) {
  if (!draft.selectedDates.length) return null;
  const first = draft.selectedDates[0];
  const last = draft.selectedDates[draft.selectedDates.length - 1];
  const dateText = draft.selectedDates.length === 1
    ? formatDate(first, 'short')
    : `${formatDate(first, 'short')} – ${formatDate(last, 'short')} · ${draft.selectedDates.length} days`;
  return <aside className="appointment-strip" aria-label="Appointment so far">
    <CalendarDays aria-hidden="true" />
    <div className="appointment-facts">
      <strong>{dateText}</strong>
      {showTime && draft.selectedDates.length === 1 && <span><Clock3 />{draft.allDay ? 'All day' : draft.time}</span>}
      {draft.descriptionParts.length > 0 && <span>{draft.descriptionParts.join(' ')}</span>}
      {draft.locationParts.length > 0 && <span><MapPin />{draft.locationParts.join(' ')}</span>}
    </div>
  </aside>;
}

function App() {
  const [draft, setDraft] = useState<AppointmentDraft>(() => loadDraft() || emptyDraft());
  const [step, setStep] = useState<Step>('dates');
  const [monthKey, setMonthKey] = useState(0);
  const initialSuggestions = useMemo(() => {
    try {
      const cached = JSON.parse(localStorage.getItem('our-days-suggestions-v1') || 'null');
      return cached?.phrases ? cached as { phrases: Phrase[]; histories: HistoryRecord[] } : localSeedSuggestions();
    } catch { return localSeedSuggestions(); }
  }, []);
  const [phrases, setPhrases] = useState(initialSuggestions.phrases);
  const [histories, setHistories] = useState(initialSuggestions.histories);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [db, setDb] = useState<Firestore | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authState, setAuthState] = useState<AuthState>(IS_E2E ? 'ready' : 'restoring');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [activeOutbox, setActiveOutbox] = useState<OutboxItem | null>(null);
  const activeOutboxId = useRef('');
  const [pendingCount, setPendingCount] = useState(0);
  const [learningCount, setLearningCount] = useState(0);
  const [saveMessage, setSaveMessage] = useState('');
  const [learningWarning, setLearningWarning] = useState('');
  const uid = IS_E2E ? 'local-e2e-user' : user?.uid || '';

  useEffect(() => { saveDraft(draft); }, [draft]);
  useEffect(() => {
    const today = isoDateLocal(new Date());
    setDraft(value => {
      const selectedDates = value.selectedDates.filter(date => date >= today);
      return selectedDates.length === value.selectedDates.length ? value : { ...value, selectedDates };
    });
  }, [monthKey]);
  useEffect(() => {
    if (IS_E2E) return;
    let cancelled = false;
    let generation = 0;
    try {
      const opened = openFirebase(); setAuth(opened.auth); setDb(opened.db);
      const unsubscribe = onAuthStateChanged(opened.auth, async nextUser => {
        const currentGeneration = ++generation;
        if (cancelled) return;
        setUser(nextUser); setAuthError('');
        if (!nextUser) { setAuthState('signed-out'); return; }
        setAuthState('checking');
        try {
          if (!await hasHouseholdAccess(opened.db, nextUser)) {
            if (!cancelled && currentGeneration === generation) setAuthState('denied');
            return;
          }
          if (cancelled || currentGeneration !== generation) return;
          setAuthState('ready');
          try {
            const loaded = await loadSuggestions(opened.db);
            if (!cancelled && currentGeneration === generation) {
              setPhrases(loaded.phrases); setHistories(loaded.histories);
              localStorage.setItem('our-days-suggestions-v1', JSON.stringify(loaded));
            }
          } catch { setLearningWarning('Suggestions are using the saved copy for now.'); }
        } catch { if (!cancelled && currentGeneration === generation) setAuthState('error'); }
      });
      return () => { cancelled = true; generation++; unsubscribe(); };
    } catch { setAuthState('error'); }
  }, []);

  const recordUsage = useCallback(async (item: OutboxItem): Promise<boolean> => {
    if (IS_E2E || !item.usage) { await removeOutbox(item.uid, item.request.submissionId); return true; }
    if (!db || !user) return false;
    try {
      await recordConfirmedUsage(db, user.uid, item.request.submissionId, item.usage.descriptions, item.usage.locations, item.request.dates);
      const loaded = await loadSuggestions(db); setPhrases(loaded.phrases); setHistories(loaded.histories);
      localStorage.setItem('our-days-suggestions-v1', JSON.stringify(loaded));
      await removeOutbox(item.uid, item.request.submissionId);
      return true;
    } catch { setLearningWarning('Appointment saved. Suggestions could not sync yet.'); return false; }
  }, [db, user]);

  const refreshPending = useCallback(async () => {
    if (!uid) return;
    try {
      const rows = await listOutbox(uid);
      setPendingCount(rows.filter(row => row.pendingDates.length > 0).length);
      setLearningCount(rows.filter(row => row.pendingDates.length === 0).length);
    } catch { /* surfaced on save */ }
  }, [uid]);

  useEffect(() => { activeOutboxId.current = activeOutbox?.request.submissionId || ''; }, [activeOutbox]);

  const retryAll = useCallback(async () => {
    if (!uid || authState !== 'ready') return;
    const token = async () => IS_E2E ? 'e2e' : user!.getIdToken();
    const results = await retryOutbox(uid, token, item => setActiveOutbox(item));
    for (const item of results) if (!item.pendingDates.length) await recordUsage(item);
    const completedActive = results.find(item => item.request.submissionId === activeOutboxId.current && !item.pendingDates.length);
    if (completedActive) {
      setSaveState('saved');
      setSaveMessage(IS_E2E ? 'Test save confirmed locally.' : 'Saved to our calendar.');
      clearDraft();
    }
    await refreshPending();
  }, [uid, authState, user, recordUsage, refreshPending]);

  useEffect(() => {
    if (!uid || authState !== 'ready') return;
    void refreshPending();
    const online = () => void retryAll();
    window.addEventListener('online', online); void retryAll();
    return () => window.removeEventListener('online', online);
  }, [uid, authState, refreshPending, retryAll]);

  useEffect(() => {
    if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  }, []);

  useEffect(() => {
    if (IS_E2E || authState !== 'ready' || !db || !user) return;
    let active = true;
    let visibleDate = isoDateLocal(new Date());
    const resume = async () => {
      if (document.visibilityState !== 'visible') return;
      const nextDate = isoDateLocal(new Date());
      if (nextDate !== visibleDate) { visibleDate = nextDate; setMonthKey(value => value + 1); }
      try {
        const loaded = await loadSuggestions(db);
        if (active) {
          setPhrases(loaded.phrases); setHistories(loaded.histories);
          localStorage.setItem('our-days-suggestions-v1', JSON.stringify(loaded));
        }
      } catch { if (active) setLearningWarning('Suggestions are using the saved copy for now.'); }
    };
    document.addEventListener('visibilitychange', resume);
    return () => { active = false; document.removeEventListener('visibilitychange', resume); };
  }, [authState, db, user]);

  const actualSteps = draft.selectedDates.length > 1 ? stepOrder.filter(item => item !== 'time') : stepOrder;
  const currentIndex = actualSteps.indexOf(step);
  const goBack = () => { if (currentIndex > 0) setStep(actualSteps[currentIndex - 1]); };
  const goNext = () => { if (currentIndex < actualSteps.length - 1) setStep(actualSteps[currentIndex + 1]); };
  const update = (change: Partial<AppointmentDraft>) => setDraft(value => ({ ...value, ...change }));
  const reset = () => {
    const next = emptyDraft(); setDraft(next); clearDraft(); setStep('dates'); setSaveState('idle'); setActiveOutbox(null);
    setSaveMessage(''); setLearningWarning(''); setMonthKey(value => value + 1);
  };

  const submit = async (appointment: AppointmentDraft = draft) => {
    if (!uid || authState !== 'ready') return;
    setSaveState('saving'); setSaveMessage(''); setLearningWarning('');
    try {
      if (activeOutbox?.status === 'invalid' && activeOutbox.confirmedDates.length === 0)
        await removeOutbox(uid, activeOutbox.request.submissionId);
      const request = toCalendarRequest(appointment);
      const queued = await queueRequest(uid, request, { descriptions: appointment.descriptionParts, locations: appointment.locationParts });
      setActiveOutbox(queued); await refreshPending();
      const result = await sendOutboxItem(queued, async () => IS_E2E ? 'e2e' : user!.getIdToken());
      setActiveOutbox(result.item); await refreshPending();
      if (result.complete) {
        setSaveState('saved'); setSaveMessage(IS_E2E ? 'Test save confirmed locally.' : 'Saved to our calendar.');
        await recordUsage(result.item); await refreshPending(); clearDraft();
      } else {
        const some = result.item.confirmedDates.length > 0;
        setSaveState(result.permanent ? 'invalid' : some ? 'partial' : 'pending');
        setSaveMessage(result.item.lastError || (some ? 'Some dates saved. The rest are waiting.' : 'Waiting to reach the calendar.'));
      }
    } catch (error) {
      setSaveState('pending'); setSaveMessage(error instanceof Error ? error.message : 'Could not prepare this appointment.');
    }
  };

  const retryActive = async () => {
    if (!activeOutbox) return;
    setSaveState('saving');
    const result = await sendOutboxItem(activeOutbox, async () => IS_E2E ? 'e2e' : user!.getIdToken());
    setActiveOutbox(result.item);
    if (result.complete) {
      setSaveState('saved'); setSaveMessage(IS_E2E ? 'Test save confirmed locally.' : 'Saved to our calendar.');
      await recordUsage(result.item); clearDraft();
    } else setSaveState(result.permanent ? 'invalid' : result.item.confirmedDates.length ? 'partial' : 'pending');
    await refreshPending();
  };

  const title = step === 'dates' ? 'Choose your days' : labels[step];
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><CalendarDays /><div><strong>Our Days</strong><small>{authState === 'ready' ? (IS_E2E ? 'local test mode' : 'household connected') : authState === 'restoring' || authState === 'checking' ? 'connecting…' : 'dates work offline'}</small></div></div>
      <div className="top-actions">
        {pendingCount > 0 && <button type="button" className="pending-pill" onClick={() => void retryAll()}><CloudOff size={14} />{pendingCount} waiting</button>}
        {pendingCount === 0 && learningCount > 0 && <button type="button" className="pending-pill learning" onClick={() => void retryAll()}><RotateCw size={14} />suggestions waiting</button>}
        {user && <button type="button" className="icon-button account" aria-label="Sign out" onClick={() => auth && void signOut(auth)}><LogOut size={18} /></button>}
      </div>
    </header>
    {IS_E2E && <div className="test-banner" role="status">Local test mode — no Google events are created.</div>}
    <main className="content">
      {saveState !== 'saved' && <AppointmentStrip draft={draft} showTime={step !== 'dates'} />}
      {step !== 'dates' && !['saving', 'pending', 'partial', 'saved'].includes(saveState) && <button type="button" className="back-button" onClick={goBack}><ArrowLeft /> Back</button>}
      {saveState !== 'saved' && <div className="progress" aria-label={`Step ${currentIndex + 1} of ${actualSteps.length}: ${title}`}>
        {actualSteps.map((item, index) => <span key={item} className={index <= currentIndex ? 'active' : ''} />)}
      </div>}

      {step === 'dates' && saveState !== 'saved' && <section className="flow-section dates-step">
        <div className="section-title"><span className="round-icon"><CalendarDays /></span><div><h1>Choose your days</h1><p>Choose one day, or a start and end date.</p></div></div>
        <MonthPicker key={monthKey} selected={draft.selectedDates} onChange={selectedDates => update({ selectedDates })} />
        {draft.selectedDates.length >= 20 && <p className="inline-note">20 dates is the maximum for one appointment.</p>}
        <div className="sticky-actions"><button type="button" className="primary-button full" disabled={!draft.selectedDates.length}
          onClick={() => setStep(draft.selectedDates.length > 1 ? 'description' : 'time')}>
          {draft.selectedDates.length > 1 ? `Continue with ${draft.selectedDates.length} days` : 'Continue with this day'}
        </button></div>
      </section>}

      {step === 'time' && saveState !== 'saved' && <section className="flow-section">
        <div className="section-title"><span className="round-icon"><Clock3 /></span><div><h1>When?</h1><p>{formatDate(draft.selectedDates[0])}</p></div></div>
        <div className="segmented" role="group" aria-label="Appointment timing">
          <button type="button" aria-pressed={draft.allDay} onClick={() => update({ allDay: true })}>All day</button>
          <button type="button" aria-pressed={!draft.allDay} onClick={() => update({ allDay: false })}>Set a time</button>
        </div>
        {!draft.allDay && <TimeChooser draft={draft} update={update} />}
        <div className="sticky-actions"><button type="button" className="primary-button full" onClick={goNext}>Continue to description</button></div>
      </section>}

      {step === 'description' && saveState !== 'saved' && <PhraseStep kind="description" title="Description" hint="Build a short description." parts={draft.descriptionParts}
        setParts={descriptionParts => update({ descriptionParts })} phrases={phrases} histories={histories} eventDate={draft.selectedDates[0]}
        onContinue={descriptionParts => { update({ descriptionParts }); setStep('location'); }} />}

      {step === 'location' && saveState !== 'saved' && <PhraseStep key="location" kind="location" title="Where?" hint="Add a place, or leave it blank." parts={draft.locationParts}
        setParts={locationParts => update({ locationParts })} phrases={phrases} histories={histories} eventDate={draft.selectedDates[0]}
        actionLabel={saveState === 'saving' ? 'Adding…' : saveState === 'invalid' ? 'Replace appointment' : 'Add appointment'}
        actionDisabled={authState !== 'ready' || ['saving', 'pending', 'partial'].includes(saveState)}
        onContinue={locationParts => { const next = { ...draft, locationParts }; setDraft(next); void submit(next); }}
        onSkip={() => { const next = { ...draft, locationParts: [] }; setDraft(next); void submit(next); }}
        beforeActions={<>
        <SummaryPanel draft={draft} />
        {authState === 'signed-out' && <SignInCard auth={auth} email={loginEmail} setEmail={setLoginEmail} password={loginPassword} setPassword={setLoginPassword} error={authError} setError={setAuthError} />}
        {authState === 'denied' && <p className="status-card error" role="alert">This account is not a member of the household. Use an existing household account.</p>}
        {authState === 'error' && <p className="status-card error" role="alert">Household access could not be checked. Reconnect and reload.</p>}
        {(authState === 'restoring' || authState === 'checking') && <p className="status-card">Checking household access…</p>}
        {(['pending', 'partial', 'invalid'] as SaveState[]).includes(saveState) && <div className={`status-card ${saveState === 'invalid' ? 'error' : 'warning'}`} role="status">
          <strong>{saveState === 'partial' ? 'Partly saved' : saveState === 'invalid' ? 'Needs a change' : 'Not confirmed yet'}</strong><p>{saveMessage}</p>
          {activeOutbox && <p>{activeOutbox.confirmedDates.length} of {activeOutbox.request.dates.length} confirmed.</p>}
          {saveState !== 'invalid' && <button type="button" className="secondary-button" onClick={() => void retryActive()}><RotateCw /> Retry now</button>}
          <small>{saveState === 'invalid' ? 'Go back and change the date or time, then replace this attempt.' : 'Waiting items retry while this app is open and online. A closed app cannot guarantee background delivery.'}</small>
        </div>}
        {learningWarning && <p className="inline-note" role="status">{learningWarning}</p>}
        </>} />}

      {saveState === 'saved' && <section className="success-card" role="status">
        <span className="success-mark"><Check /></span><p className="eyebrow">ALL DONE</p><h1>{saveMessage}</h1>
        <p>{draft.selectedDates.length > 1 ? `${draft.selectedDates.length} separate events were confirmed.` : formatDate(draft.selectedDates[0])}</p>
        {learningWarning && <p className="inline-note">{learningWarning}</p>}
        <button type="button" className="primary-button" onClick={reset}>Another appointment</button>
      </section>}
    </main>
  </div>;
}

export default App;
