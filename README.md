# Our Days

Our Days is a small, installable appointment-entry app for Ross and Franci. It opens on a future-only calendar, creates one timed or all-day event for a single date, and creates separate all-day events for a selected continuous range. Range endpoints can be dragged to adjust them, and timed appointments use a one-finger control in ten-minute increments. It writes only to one fixed, user-owned Google Calendar.

The frontend is designed for `https://fishdawg90.github.io/our-days/`. It reuses the existing Firebase project `la-spesa-5cc7a`, Firebase app name, email/password accounts, and `households/home/members/{uid}` authorization used by Our Basket. It never creates household membership.

## Current integration status

The application, Worker, offline outbox, rules, index, and deployment are live. The shared calendar, no-role service account, encrypted Cloudflare secrets, Firestore rules, and composite index were configured on 25 September 2026. Ross then created a real appointment through the deployed app and confirmed that it reached the shared Google Calendar. Automated Calendar API edge-case tests still use mocked upstream responses; the real event is the separate end-to-end integration evidence.

No new Google, Firebase, Cloudflare, or GitHub account is needed. The setup adds resources inside the existing accounts:

- a secondary Google Calendar owned by one of the users;
- a no-role Google service account in `la-spesa-5cc7a`;
- the separate `our-days-calendar` Worker;
- two isolated Firestore collections and one index; and
- the `fishdawg90/our-days` GitHub Pages site.

## Local development

Requirements: Node.js 24+ and pnpm 11.19+.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5173/our-days/`. Firebase's browser configuration in `src/config.ts` is public configuration, not a secret. Never add a service-account key or private key to this repository.

Useful checks:

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm --dir worker exec wrangler deploy --dry-run
```

The browser suite uses a clearly labelled local-only test mode. It is gated to Vite development on localhost, never appears in the production build, and never calls Google.

The production PWA smoke test verifies a cold reload after its local origin server is shut down, including cached JavaScript/CSS and cache isolation. This is strong browser-level offline evidence, but it is not a substitute for a final airplane-mode test on each real phone after deployment.

## One-time calendar and Worker setup

### 1. Create the shared secondary calendar

In [Google Calendar](https://calendar.google.com/), use **Other calendars → + → Create new calendar**. A name such as `Our Days` is suitable. This must be a secondary calendar owned by Ross or Franci; do not use a service-account-owned calendar.

Open the calendar's **Settings and sharing → Integrate calendar** and keep the Calendar ID available. This ID is not a private key.

Share the calendar with the other person so both accounts can see it. Both people should subscribe to this same calendar directly; the Worker deliberately creates no attendees and sends no invitations.

### 2. Enable Calendar API and create a no-role service account

This deployment was configured in Google Cloud Console: enable the Google Calendar API in `la-spesa-5cc7a`, create `our-days-calendar`, assign no IAM role, then create a JSON key. The equivalent CLI commands are:

```powershell
gcloud auth login
gcloud services enable calendar-json.googleapis.com --project=la-spesa-5cc7a
gcloud iam service-accounts create our-days-calendar --display-name="Our Days Calendar writer" --project=la-spesa-5cc7a
gcloud iam service-accounts keys create "$env:LOCALAPPDATA\Temp\our-days-service-account.json" --iam-account=our-days-calendar@la-spesa-5cc7a.iam.gserviceaccount.com --project=la-spesa-5cc7a
```

The service account needs **no Google Cloud IAM role**, no Project Editor access, and no domain-wide delegation. Its only authority comes from the single calendar shared in the next step. Keep the temporary JSON key local and remove it after its values are stored in Cloudflare. Delete and recreate the Google key immediately if it is ever exposed.

Return to the secondary calendar's **Settings and sharing → Share with specific people**, add `our-days-calendar@la-spesa-5cc7a.iam.gserviceaccount.com`, and grant **Make changes to events**. Do not grant broader calendar-account access.

### 3. Configure and deploy the Cloudflare Worker

The Calendar ID is stored as an encrypted Worker secret, keeping it out of the public repository. The fixed Worker name is `our-days-calendar`; this is separate from the existing photo Worker.

Authenticate Wrangler once using the existing Cloudflare account:

```powershell
pnpm --dir worker exec wrangler login
pnpm --dir worker exec wrangler deploy
```

The first deploy creates the Worker before any secret value is piped to Wrangler. Its health response remains `ready: false` until all three secrets exist.

Load the calendar ID and two credentials as encrypted Worker secrets without copying them into source. Put the Calendar ID from step 1 into the temporary text file named below, without additional text:

```powershell
$ourDaysCalendarId = Get-Content -Raw "$env:LOCALAPPDATA\Temp\our-days-calendar-id.txt"
$ourDaysCalendarId.Trim() | pnpm --dir worker exec wrangler secret put CALENDAR_ID
$ourDaysCredentials = Get-Content -Raw "$env:LOCALAPPDATA\Temp\our-days-service-account.json" | ConvertFrom-Json
$ourDaysCredentials.client_email | pnpm --dir worker exec wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
$ourDaysCredentials.private_key | pnpm --dir worker exec wrangler secret put GOOGLE_PRIVATE_KEY
Remove-Variable ourDaysCalendarId,ourDaysCredentials
pnpm --dir worker exec wrangler deploy
Remove-Item -LiteralPath "$env:LOCALAPPDATA\Temp\our-days-service-account.json", "$env:LOCALAPPDATA\Temp\our-days-calendar-id.txt" -Force
```

Then check readiness. This endpoint exposes booleans only, never secret values:

```powershell
Invoke-RestMethod https://our-days-calendar.mckibbon-ross.workers.dev/health
```

`ready` must be `true`. Browser CORS is restricted to `https://fishdawg90.github.io`; authorization still comes from a valid Firebase ID token plus the existing Firestore household member document.

### 4. Deploy the isolated Firestore rules and index

Review `firestore.rules` before deployment. It preserves the existing shopping collections and adds only `appointmentPhrases` and `appointmentHistory`. Then authenticate to the existing Firebase account and deploy only rules and indexes:

```powershell
pnpm dlx firebase-tools login
pnpm dlx firebase-tools deploy --only "firestore:rules,firestore:indexes" --project la-spesa-5cc7a
```

This command does not deploy Firebase Hosting or create another Firebase project. Phrase queries keep an active window of at most 100 records per kind; ranking reads at most 200 recent history submissions. History documents are append-only for idempotency, so the database itself is not claimed to be permanently capped.

The same change can be made manually in Firebase Console. Publish the complete `firestore.rules` file on **Firestore Database → Rules**, then create one collection-scoped composite index for collection ID `appointmentPhrases`: `kind` ascending followed by `lastUsedAt` descending. This was the method used for the live deployment.

### 5. Frontend hosting (already configured)

The repository already exists at [fishdawg90/our-days](https://github.com/fishdawg90/our-days), and GitHub Pages is configured to use the included **Deploy GitHub Pages** workflow. No new repository or hosting setup is needed. Future pushes to `main` run all unit and Worker tests before building and publishing `dist`. Check the [deployment workflow](https://github.com/fishdawg90/our-days/actions) for its current status.

The Pages URL is [Our Days](https://fishdawg90.github.io/our-days/). Firebase Auth must continue to allow `fishdawg90.github.io` as an authorized domain. Users sign in with an existing household email/password account; do not create a new member UID from this app.

## Live verification

The initial live write was confirmed during setup. For later credential rotations or deployment changes, repeat this check:

1. Open the deployed app while online and sign in with an existing household member account.
2. Add a clearly named event such as `Our Days integration test`, a few minutes in the future.
3. Confirm the app reports **Saved to our calendar** only after the Worker returns the Google event ID.
4. Open the shared Google Calendar in a separate tab and confirm the title, date/time, location, and Europe/London time are correct.
5. Delete the test event from Google Calendar.
6. Test one all-day appointment and, around a clock change if relevant, verify that invalid ambiguous/nonexistent local times are rejected rather than shifted silently.

Until this read-back succeeds, describe the system as deployed but not live-verified.

## Phone installation and reminders

On each phone, open the Pages URL and use the browser's **Add to Home Screen** / **Install app** action. Open it once online so the app shell is cached. Pending calendar writes are stored per signed-in UID and retry while the app is open and connectivity returns. A closed PWA cannot guarantee background delivery.

Google Calendar reminders/default notifications are user-specific and are not shared with an event. On **both** phones:

1. Enable sync for the `Our Days` calendar in Google Calendar.
2. Configure that user's default timed-event and all-day-event notifications for the calendar.
3. Allow Google Calendar notification permissions in Android/iOS settings.

The service account cannot configure reminders for both users.

## Security and data model

- The browser receives only Firebase public web configuration and the Worker URL.
- Google private credentials exist only as Cloudflare secrets.
- The Worker validates Firebase JWT signatures and checks `households/home/members/{uid}` through Firestore on every request.
- The browser cannot choose a calendar; `CALENDAR_ID` is fixed in Worker configuration.
- Stable submission/date IDs make retries idempotent. Existing duplicates are accepted only when their complete event body matches.
- Appointment bodies are sent to Google Calendar and held in the UID-scoped local outbox only while needed. Firestore stores small phrase/history learning records, not a calendar mirror.
- The PWA cache uses only the `our-days-` prefix and path scope, so it never deletes Our Basket caches on the shared origin.

## Reusing the household foundation

Future apps on `https://fishdawg90.github.io` can reuse the same Firebase web configuration, named app `la-spesa-5cc7a`, local auth persistence, and membership check. They should use their own path-scoped PWA cache, isolated Firestore collection names and least-privilege backend. Reusing household identity does not authorize reuse of unrelated shopping or appointment data.
