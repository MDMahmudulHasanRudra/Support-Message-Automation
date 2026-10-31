# Website Chat V3 — release report (31 Oct 2026)

Branch `rudra`. Not merged, not deployed, no production migration run. Commits: `80e357d` (V3 slice 1) and
`{{SHA2}}` (browser-pass fixes, docs). Audit: `01-audit.md`; browser record: `02-browser-e2e.md`.

## Existing features reused (not rebuilt)

The one embed line and the public API, the closed Shadow DOM widget, the origin allowlist and per-origin CORS, the
hashed visitor token, signed identity, the omnichannel pipeline (`ChannelInboundEvent` → worker inbound processor →
`ChannelConversation` / `ChannelMessage`), the channel send queue, the channel AI path and its gates, the agent
attachment route, the visitor card, business hours, typing and seen, `LocalMediaStorage`, the WordPress zip. No
second chat platform, no second AI credential system, no second send path.

## New widget functionality

Builder-driven look (4 editable presets, colours with contrast warnings, theme, header, radius, sizes, shadow,
safe font stacks incl. Bengali), launcher styles (icon, icon + text, logo, team photo, custom icon) with image
fallbacks, greeting bubble with frequency caps and dismissal cooldown, optional auto-open (off by default, never on
phones), page and device targeting with checkout/cart/payment hidden by default, SPA navigation awareness, date
separators, real seen ticks only, typing, a "new messages" pill that keeps the reader's place, reconnect state with
backoff, retry, emoji picker (search, recent, keyboard), composer with auto-resize, Enter / Shift+Enter and a
character limit, photos both ways with preview, caption, progress, retry and inline display, an `open / close /
destroy` API, reduced-motion and phone full-screen handling.

## New configuration (all in `ChannelConnection.widgetSettings`)

See `WEBSITE_CHAT.md` → Setting it up. Defaults keep an existing widget's look and behaviour; AI stays as the
connection's switch has it.

## Install script

Unchanged embed line and data attributes, no secret. The script is 3.0.0, served `public, max-age=3600`, so
installed sites pick it up within an hour of a deploy. The config request doubles as the install heartbeat (at most
one write a minute per widget). Old `window.GetAssistChat` identity snippets work unchanged.

## WordPress plugin (1.1.0)

Hide on listed paths, hide for logged-in administrators, a Settings link on the Plugins list, `uninstall.php`, a
changelog; 1.0.0 option names kept; still no secret in the zip; WooCommerce phone signing unchanged. **Not linted or
run against WordPress** — no PHP or WordPress image was available and none was pulled. To check:

```bash
docker run --rm -v "$PWD/getassist-chat:/p" php:8.2-cli php -l /p/getassist-chat.php
```

then install the zip on a throwaway WordPress (`wordpress:6` + `mysql:8`), list the site's address on the widget,
and confirm the launcher, the hide rules and Verify installation.

## Media and AI behaviour

Photos only (JPEG / PNG / WebP, type from the bytes, 10 MB); no video; PDFs only for widgets saved before V3. A
visitor reads photos only with their token and only from their conversation (an agent's only once sent); agents
through the project route. Any message with a photo is handed to a person (`MEDIA_ONLY_MESSAGE`). AI never switches
on by creating a widget. WhatsApp's file delivery is untouched.

## Database

One additive migration, `20261030150000_webchat_v3`: five nullable columns on `ChannelConnection` (`widgetSeenAt`,
`widgetSeenOrigin`, `widgetSeenVersion`, `widgetRefusedAt`, `widgetRefusedOrigin`). Deploy runs it with
`docker compose run --rm migrate` before the app; it locks nothing large.

## Security checks

Untrusted text never as HTML (test refuses `innerHTML`/`insertAdjacentHTML`/`document.write`/`eval`); the browser
receives `publicWidgetSettings` only; builder images only through the upload route, sniffed, 512 KB, never SVG or a
remote URL; team photos need a recorded consent; the form cannot inject images or consent; public brand images only
while listed; visitor media scoped to the token's conversation; agent photo route needs `conversations.reply` +
OMNICHANNEL and refuses other channels; hex storage keys (base64 keys starting with `-`/`_` were refused by the
storage key check about once in 32 uploads — fixed with a regression assertion); refused origins recorded but never
served. Mutation check: 9 of 10 protections caught by a failing test; the tenth (upload nonce pre-check) is
equivalent to the database's unique dedup key.

## Performance

`widget.js` 58,862 B raw, 17,212 B gzip, 15,140 B brotli (budget 70 KB / 20 KB, enforced by a test). One request
for the config; polling every 3 s while open, 30 s while closed, none while the tab is hidden, backing off to 60 s
on failures; CORS preflights cached 10 minutes. No fonts, images or libraries loaded unless the builder set them.

## Tests

All on 31 Oct 2026 against the isolated test database (port 5433):

| Suite | Result |
|---|---|
| `packages/shared` | 76 files, 1,219 tests passed |
| `apps/web` `test:isolated` (incl. `webchatV3.integration` 11, `webchatWidgetScript` 9) | 95 files passed, 2 skipped; 1,129 tests passed, 7 skipped |
| `apps/worker` `test:isolated` | 130 files passed, 1 skipped; 1,416 tests passed, 6 skipped |
| `apps/web` typecheck and lint of the changed files | clean |
| Browser pass | `02-browser-e2e.md`: plain HTML, React SPA, phone viewport, builder, inbox; WordPress not run |

The two new widget tests were confirmed to fail against the script before the browser-pass fixes.

## Remaining blockers before customers

1. WordPress: lint and a real install (above).
2. Website chat photos are not in the media retention job; they stay on the media volume.
3. Safari, Firefox and real phones not tried; Chromium only.
4. Never run against a live site or the production build; deploy needs the migration step.
5. Polling only (no push); overnight business hours unsupported.
