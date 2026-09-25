# Our Days — implementation plan

## Outcome

A tiny installable appointment-entry app for Ross and Franci. Open directly on dates; tap dates, optionally choose a time, assemble a short description from personal phrases, optionally choose a location, then save directly to the shared Google calendar. No AI, calendar viewer or Outlook connection in this version.

## Existing foundation inspected

- Shopping source: `../Shop List`; React 19, TypeScript, Vite 6, pnpm.
- Existing live shopping URL: `https://fishdawg90.github.io/shop-list-phone/`.
- Firebase project `la-spesa-5cc7a`, existing public web configuration and email/password accounts.
- Firebase app is named `la-spesa-5cc7a` in the shopping code. Reuse the exact name/config so Firebase can reuse browser authentication on the same `https://fishdawg90.github.io` origin. Separate devices/browser profiles still require initial login; deleted storage/revoked sessions can require login again.
- Existing authorization is membership documents `households/home/members/{uid}`. Reuse these as the authoritative household access check. Never let the new app grant membership.
- Existing Cloudflare account/subdomain `mckibbon-ross.workers.dev`. Add a separate calendar Worker to this account, leaving the photo Worker intact.
- Existing Firestore shopping collections are explicitly allowed by rules. Add only isolated calendar phrase/history paths while preserving shopping rules. Do not reuse shopping document names or broaden access indiscriminately.

## UI / interaction

1. Open immediately to a compact month date picker with Today/Tomorrow, easy month navigation and selected-day chips. Multiple dates toggle independently, including across months. Explicit Continue prevents advancing after the first date.
2. One date: time entry, useful quick times and 30/60/120 minute durations, or All day. Multiple dates: skip time and create a separate all-day event for each selected date (not a span across gaps). State this clearly in summary.
3. Description: input at top, selected phrase chips in insertion order, animated suggestion cloud below. Typed custom phrases can be added directly and become reusable. Reject empty descriptions and deduplicate case/whitespace variants. Phrases such as Work Trip and blood test remain intact.
4. Optional location with matching input/cloud interaction. Skip location is one tap. Preserve typed text when saving/continuing without a separate Add tap.
5. Compact final summary on the last step and one Add appointment button. Only claim Saved after every intended event is confirmed by Google. Separate partial/pending/failure states and retries. Another appointment returns to dates.

Seed descriptions: Franci, Ross, Giulia, Nina, Dentist, Scan, Vaccine, Work Trip, Flight, Meal, Arrival, Departure, airport, train, road trip, midwife, blood test.

Seed locations: Heathrow, Gatwick, Stansted, Luton, London, Wales, Woking, Overseas, Royal Surrey, St Johns Midwife, Mycroft Dentist, Sunny Mead Heathcote Road.

Use the shopping app's compact soft-green surfaces, dark-green actions, responsive pressed states, short springy transitions and chip entrances; improve legibility/touch sizes. Respect reduced motion, support keyboard navigation and screen-reader labels. Mobile first, with no intro screen or marketing content.

## Suggestions

Small seeded personal vocabulary, with an active window of 100 phrases per kind and 200 recent history records loaded. Stored learning records can grow gradually; no large preloaded catalogue. Store confirmed usage once per submitted appointment (not once per selected date). Rank by decayed recent frequency plus recurring interval evidence, with conservative priors for sparse history. Use event dates for repeat timing and submission timestamps for recency. Share the vocabulary/history through isolated Firestore documents; retain local cache and drafts when offline. Transactional/idempotent history records prevent two phones or retries from losing/inflating usage. Make failures to sync suggestions visible without incorrectly marking a confirmed calendar insertion as failed.

## Calendar and authentication

- Frontend uses existing Firebase email/password login, local persistence and existing membership document. Start rendering dates immediately while authentication restores.
- Worker validates Firebase ID tokens and verifies household membership through Firestore using the user's token (server-side, fail closed). CORS restricts the GitHub origin but is not the authorization mechanism.
- Google service account is granted writer access only to a user-owned, secondary shared calendar. Its private credential is a Cloudflare secret, never shipped in frontend/build files.
- Calendar ID fixed in Worker configuration; the browser cannot select arbitrary calendars. Worker signs/exchanges service account credentials via a maintained library, caches access tokens, and calls Calendar API. No attendee invitations; both people subscribe to the shared calendar directly.
- Validate dates, time, duration, lengths, request sizes and max date count on server. Default `Europe/London`; handle DST and exclusive all-day end dates correctly. Explicitly reject nonexistent/ambiguous local DST times unless safely resolved and surfaced.
- Stable per-submission/per-date Calendar event IDs support retry without duplicate events. If a duplicate exists, verify it matches the request before confirming. Partial multi-date failures are retryable with the same IDs.
- Durable local outbox scoped to the signed-in UID. Save request before sending; do not transfer pending work to a different signed-in account. Retry while app is open/on reconnect; explicitly explain that a closed PWA cannot guarantee background delivery. Retain pending drafts across refresh; distinguish offline, setup missing and permanent invalid input.

## Hosting / reusable structure

- New repository/site candidate: `our-days`, URL `https://fishdawg90.github.io/our-days/` (planned until created and verified).
- Static GitHub Pages deployment and path-scoped PWA manifest/service worker. Cache only this app's assets and never delete other apps' caches on the shared origin.
- Source split into household auth/config, appointment domain, phrase ranking/storage, calendar transport/outbox and UI. Document how future apps reuse accounts/membership without sharing unrelated data.
- Cloudflare Worker name `our-days-calendar`, independent deployment/configuration in existing account. Firebase database need not store appointment bodies; only small learning records needed.
- Include deployable rules preserving the shopping access model, Worker Wrangler config, ignored secrets example, GitHub Actions workflow and a concrete setup guide.

## Implementation / verification

Implementation delegated to GPT-5.6-Sol as requested. Parent reviews architecture/integration evidence and checks available deployment access independently.

Build and typecheck; focused domain/ranking tests; Worker mocked-upstream tests for authorization, request validation, DST, duplicate retries and partial failure; browser interaction tests for date selection, time skipping, phrase addition, location skipping, keyboard use, refresh/offline outbox and honest confirmation. Use DOM assertions primarily, at most a small number of screenshots for final visual review. Mocked Google success is not live verification.

Before claiming a live integration, create/read a clearly named test event with configured credentials and report cleanup. If CLI credentials or calendar sharing are missing, finish the app/tests/deployment preparation, state exactly what remains, and give numbered steps with existing project names and URLs. Do not expose credentials or ask for passwords/private keys in chat.

## Integration inspection results

- GitHub account verified as `fishdawg90`; existing stored Git credential works from the user's account. `shop-list-phone` is public, default branch `main`, Pages enabled. New app hosting can be prepared through the GitHub API/CLI without a new account.
- No existing Cloudflare Wrangler, Firebase CLI or Google Cloud CLI sign-in/configuration found in the standard user locations. The available browser also opens Cloudflare and Firebase at their sign-in pages. These services will need one-time owner authentication before external configuration can be completed.
- Google Calendar reminders are per-user. Both Ross and Franci must enable the shared calendar and configure their own default timed/all-day reminders; the service account cannot set both people's notification preferences.
- Sources checked: [Firestore REST authentication](https://firebase.google.com/docs/firestore/use-rest-api), [Google Calendar sharing](https://developers.google.com/workspace/calendar/api/concepts/sharing), [calendar ownership](https://developers.google.com/workspace/calendar/api/concepts/events-calendars), [reminders](https://developers.google.com/workspace/calendar/api/concepts/reminders), [GitHub Pages API](https://docs.github.com/en/rest/pages/pages), [Cloudflare free limits](https://developers.cloudflare.com/workers/platform/limits/).
- Up to 20 dates per submission keeps even a full duplicate-retry batch within Cloudflare Free's 50-subrequest budget. One-date entry defaults to timed; multiple dates always become separate all-day events.
- Review is integrated into the optional location step. There is no separate review screen/tap.
