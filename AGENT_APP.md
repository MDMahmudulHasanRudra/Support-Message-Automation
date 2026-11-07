# Instant inbox, phone app and notifications

Priority item 3. Entirely in the web app: nothing in the WhatsApp worker changed, and deploying it does not reconnect any number.

## Instant inbox
`/p/<slug>/api/inbox/live` is a server-sent stream that only says "something changed". `LiveRefresh` then refreshes the ordinary page, at most once every 700 ms. One check per project being watched (`server/inboxLive.ts`, every 1.5 s), whatever the number of viewers. With the connection up the page also refreshes every 20 s, without it every 4 s, as before. Hidden tabs do nothing. A connection is re-checked by reconnecting every 5 minutes. `INBOX_LIVE_DISABLED=true` turns it off.

## Phone app
An installable web app: `/manifest.webmanifest` (name and icon follow Branding), `public/sw.js`, `public/offline.html`. **The service worker caches only the offline page**: customer data must never sit in a browser cache.

## Notifications
My account → This device. `PushDevice` is one row per browser that said yes.

Rules worth not undoing:
- **Only the browsers' own push services are accepted as an address** (`isAllowedPushEndpoint`). The server POSTs to that address, so anything else would let a signed-in person aim the server wherever they like.
- **A device belongs to a sign-in.** Signing out, a revoked or expired session, or a deactivated user ends its alerts. A browser that already said yes re-registers to the next sign-in, so a shared phone stops receiving the first person's alerts. A support session never registers.
- **Every alert asks what the inbox asks**: the person's customer, project access, `messages.view`, the module on, the project active (`mayRead`).
- **No message text unless that device chose it** (`showPreview`, off). A lock screen is visible to whoever is nearby.
- **It reads stored rows from the app process** (`server/pushProcessor.ts`), and the position is in memory. A restart starts from now, never replaying a backlog at someone's phone. A message written more than 15 minutes ago is recovered history, not a customer waiting.
- **Limits**: a customer message at most once per 5 minutes per person per conversation; "waiting" at most once a minute per person, as a count when several are waiting. Assigned and mentioned always come through.

Not covered: Support Assignment cases assigned through My assignments (they have their own WhatsApp notices).

## To switch on
`npx web-push generate-vapid-keys`, put the pair in `.env` as `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, set `VAPID_SUBJECT=mailto:you@yourdomain`, then rebuild the app. Changing the keys later means everyone turns notifications on again. iPhones need the app installed to the home screen first (iOS 16.4 or newer).
