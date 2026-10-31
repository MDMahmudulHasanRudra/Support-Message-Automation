# Website live chat

A chat widget for the customer's own website, as a fourth channel beside Messenger, Instagram and Telegram
(`ChannelType.WEBCHAT`). Conversations land in All Conversations / Website Chat and get everything the
other channels have: replies, AI answers (the same channel AI path and gates), assignment, Team, notes,
tags, priority, Copilot. Behind the `OMNICHANNEL` feature, so it is available to every project type that
has it. Migrations `20261029120000_website_chat`, `20261030110000_webchat_v2` (visitor phone, page and
typing columns, agent typing) and `20261030150000_webchat_v3` (the install check's five columns on
`ChannelConnection`); nullable columns only. **V3 (31 Oct 2026, `docs/website-chat-v3/`)** added the Widget
Builder, photos both ways, the install check and the WordPress plugin 1.1.0, on the same tables, API and
embed line, so a site installed before V3 keeps working unchanged.

## Setting it up

Settings → Messaging Channels → Website chat → Connect: a name and the website addresses it may run on. A
bare domain is enough: `getassist.pro` is saved as `https://getassist.pro` (`normalizeOriginInput`, shown
live under the box); `www.` is offered as a separate button, never added silently; credentials, wildcards,
paths and other schemes are refused with the reason.

The widget page is the **Widget Builder** (`WebchatPanel.tsx`, `WidgetStudio`): sections General,
Appearance, Launcher, Chat window, Team & avatars, Greeting & behaviour, Messages & photos, Business hours,
AI & human handoff, Installation, Security & domains, Analytics; a sticky bar with "Unsaved changes",
Reset look to defaults and Save and apply (`saveWidgetBuilderAction`). Beside it a **live preview**: the
real `widget.js` in a `sandbox="allow-scripts"` iframe with `data-preview="1"`, fed by `postMessage`
(computer / phone, open / closed, online / away, greeting, sample chat, typing, dark site). The preview
sends nothing, creates no visitor and never calls AI (`api()` refuses in preview mode). Its script path is
relative on purpose: a `srcdoc` document resolves against the page, and the markup is then the same on
server and client.

Settings live in `ChannelConnection.widgetSettings` (JSON; `parseWidgetSettings` clamps every value, and
older settings keep their meaning): four editable presets (Modern Minimal, Corporate Support, Friendly
Rounded, Dark Premium), colours with a contrast warning, theme, header, radius, panel and launcher size,
shadow, a safe font stack (Bengali-capable), launcher style (icon, icon + text, logo, team photo, custom
icon), show delay, greeting bubble (delay, once per session, days before showing again, phones on/off,
hide after), auto-open (OFF by default, never on phones, once per session), page rules (all / only /
except, and hidden on checkout, cart and payment pages by default), devices, emoji and PDFs.

Installation shows the install line, `<script src="https://<app>/api/webchat/widget.js" data-key="<key>"
async></script>` (unchanged since V1, holds no secret), platform guides (HTML, WordPress, Shopify, React,
Next.js, Webflow, Wix, other; only WordPress has a plugin), the plugin download (`channels.manage`), and
**Verify installation** (below). The identity secret is shown once, for signed-in customers. The script is
cached for an hour (`max-age=3600`), so a site picks up a new widget version within the hour.

### WordPress

`/p/<slug>/api/webchat/wordpress/<connectionId>` returns `getassist-chat.zip` (`server/channels/webchatWordpress.ts`,
zipped by `server/zip.ts`, no dependency). Plugin 1.1.0: one PHP file that prints the widget in `wp_footer`,
with the widget key and script address written in; a settings page (Settings → Get Assist Chat, also linked
from the Plugins list) to hide the chat, hide it on listed paths (`getassist_chat_hide_paths`) or for
logged-in administrators (`getassist_chat_hide_admins`), paste the identity secret and turn on "show
logged-in customers as verified"; and `uninstall.php`. 1.0.0's option names are kept, so updating keeps
the site's settings. Design lives in the Widget Builder, not in WordPress.
- **The identity secret is never in the zip.** The download can be passed around; only the site's own
  administrator types the secret into WordPress, and the signatures are computed by PHP on the server.
- With the secret set, a logged-in WordPress user is signed (`hash`), and their WooCommerce `billing_phone`
  too (`phoneHash`), so the conversation shows their client record and orders.

## How it works

| Piece | Where |
|---|---|
| Widget script (Shadow DOM, textContent only, no dependencies) | `server/channels/webchatWidgetScript.ts`, served at `/api/webchat/widget.js` |
| Public API (no session) | `/api/webchat/<key>` (config + availability; also the install heartbeat), `/session`, `/messages` (GET / POST), `/files` (POST), `/typing` (POST), `/media/<messageId>/<index>` (the visitor's own photos, bearer token), `/brand/<assetId>` (logo, launcher icon, team photos) — `app/api/webchat/[key]` |
| Rules | `server/channels/webchat.ts`; shared validation, hours and file rules `packages/shared/src/webchat.ts` |
| Inbound | the web records a `ChannelInboundEvent` (`provider: "WEBCHAT"`, dedup `wc:<visitor>:<nonce>`); the worker's existing inbound processor turns it into the conversation and message |
| Outbound | the existing channel send queue; for WEBCHAT the worker marks the reply SENT on store (no provider); the widget polls every 3 s while open, 30 s while closed |
| Visitor files for agents | `/p/<slug>/api/channels/attachment/<messageId>/<index>` |
| Agent photos to a visitor | `/p/<slug>/api/channels/webchat-photo/<conversationId>` (composer button or paste) |
| Builder images | `/p/<slug>/api/webchat/brand/<connectionId>` (upload, `channels.manage`) |
| Visitor card | `server/channels/webchatVisitorCard.ts`, under the conversation header |
| Agent typing | `markAgentTyping` (`server/actions/webchatAgent.ts`), called by the composer |

## Files and photos

Visitors send JPEG / PNG / WebP photos (`allowAttachments`, on by default) by button, paste or drag and drop,
with a preview, a caption, progress and retry, up to 10 MB each and 10 per visitor per hour. **No video.**
PDFs only where `allowPdf` is on: a widget saved before V3 keeps its PDFs (`allowPdf` follows its old
`allowAttachments`), a new widget is photos-only. A repeated upload `nonce` is the same message.
- The type is read from the BYTES (`planVisitorAttachment`), never from the name or the browser's claim;
  anything else is refused.
- Stored at `webchat/<projectId>/<visitorId>/<random>.<ext>` on the media volume. Nothing new is written
  below `MEDIA_MIN_FREE_DISK_MB`, as for WhatsApp media.
- **There is no public address for a visitor's file.** Agents open it through the project's own route:
  session, `messages.view` + Omnichannel, the message read through the scoped client, and a key that
  `isWebchatStorageKey` confirms is this project's. Photos are served in a sandbox; a PDF opens in the
  browser's viewer.
- **The visitor sees photos inline** through `/media/<messageId>/<index>` with their bearer token (fetched into a
  `blob:` URL, never a public address): only their own conversation, and an agent's photo only once SENT.
- **Agents send photos** (JPEG / PNG / WebP only, type from the bytes, optional caption) as ONE queued
  `ChannelMessage` keyed by the composer's nonce, stored in that visitor's folder. Website chat only;
  WhatsApp's file sending is untouched.
- A message with a photo goes to a person, with or without a caption: the channel AI hands it over as
  `MEDIA_ONLY_MESSAGE` (the AI client is text-only).
- Visitor files are not covered by the media retention job yet (that job reads `MessageMedia` rows only).

## Builder images (logo, launcher icon, team photos)

Uploaded in the builder only (`addWidgetAsset`): JPEG / PNG / WebP from the bytes, 512 KB, never SVG, never a
remote URL; at most 12 images and 5 team members. A **team photo needs a name and the admin's ticked
confirmation that the person agreed** (`consentBy`, `consentAt`). Served publicly by `/brand/<assetId>` only
while listed; the public config carries relative addresses, never storage keys or consent records. A failed
image falls back to the icon. Team photos never claim anyone is online.

## Install check

The widget's config request records a heartbeat (`widgetSeenAt`, `widgetSeenOrigin`, `widgetSeenVersion`), at
most one write a minute; a refused origin is recorded too (`widgetRefusedAt`, `widgetRefusedOrigin`). Verify
installation shows where and when the widget last started, whether it is switched on, the allowed websites,
and "<site> tried to start the widget but is not listed". Nothing about the visitor is stored for this.

## Business hours

Off by default. With hours on (time zone + per-day opening and closing, Sunday-first in storage,
Saturday-first in the form), the widget shows the team as away outside them, says when it is back
("Back tomorrow 09:00") and can ask for an email. **Nothing is refused while away**: the visitor can always
write, and the conversation waits in the inbox like any other. The weekly hours stay on the server; the
widget receives only whether the team is in and when it is back. Overnight hours are not supported (the
closing time must be after the opening time).

## Typing and seen

- The visitor's widget pings `/typing` at most every 3 s while they type; the inbox shows "Typing…" for
  6 s after the last ping. Written at most every 2 s.
- An agent typing in the composer of a website chat conversation sets `agentTypingAt` (at most every 2 s);
  the widget shows "typing…" for 6 s.
- The widget asks with `seen=1` only while the panel is open and the page is visible; the team's sent
  replies so far are then marked READ ("Seen" in the inbox). A closed or hidden widget never marks anything.

## Visitor identity and customer context

- **Identity is never trusted from the browser.** A visitor is verified only when `hash = HMAC-SHA256(identity
  secret, user id)` checks out; otherwise a typed name and email are stored as typed.
- **A phone number needs its own signature**, `phoneHash = HMAC-SHA256(secret, "phone:<id>:<phone>")`: the
  user-id hash says who is signed in, not which number is theirs, and the number is what links them to a
  client and orders. An unsigned phone is not stored at all.
- The page the visitor was on is kept as origin + path only, and only for a listed website.
- **The visitor card** shows signed-in or not, email, signed phone, page, last seen, typing, and:
  - the client whose email / phone / WhatsApp channel matches (Client Management on + `clients.view`);
  - up to five orders by signed phone (normalised both sides, the commerce AI's rule) or email (Orders on +
    `orders.view`).
  - A match through a typed email is labelled a POSSIBLE match, to check before sharing anything.

## Rules worth not undoing

- **The widget key names the widget; the browser Origin must be listed** (`allowedOrigins`, https only except
  localhost). No list = refused (fails closed). Origin checking stops other sites embedding the widget; it is
  not authentication.
- **A visitor is a random id plus a bearer token stored only as a SHA-256 hash.** A visitor reads only their
  own conversation's messages that were sent (never a note, a queued / failed reply or another thread).
- **Limits:** 30 new visitors per network per hour, 12 messages per visitor per minute, 2,000 characters,
  16 KB request bodies (files: 10 MB, 10 an hour). A repeated nonce is the same message.
- The widget renders nothing when the key is unknown, the origin is not listed, the connection is
  disconnected, the project is not active or OMNICHANNEL is off. Switching the widget off keeps it visible
  with "Chat is not available right now."
- AI answers are labelled "AI assistant" in the widget. The Meta-only AI disclosure line does not apply here.
- **Mobile:** the open panel is full screen at 480 px and below (the launcher hides while it is open), inputs
  are 16 px (no iOS zoom), the page behind does not scroll, and safe-area insets are respected.
- **The host page is left alone:** a closed Shadow DOM, and the outer container is `all:initial!important` so a
  site's own rules (`div { outline }`, `* { font }`, `button { … !important }`) never reach it; the widget adds
  one element and no global style.
- **The browser receives `publicWidgetSettings`:** no weekly hours, storage keys or consent records. The form
  cannot add images or team members (only the upload route can) or change their consent.
- **Unread** counts only team messages newer than what this browser last had in front of it (`-read` in
  localStorage), so a reply read on one page is not "1 new" on the next.
- **Creating a widget never switches AI on**; it answers only with the connection's AI switch on, and any
  photo goes to a person.

## Not built yet

Real-time push (polling only); website chat photos in the media retention job (no job removes them yet;
they stay on the media volume); video and other file types (deliberately); overnight business hours; a WordPress test-site run (the
plugin is neither linted nor run against WordPress yet). The widget, builder and inbox were exercised in a
browser against a local build on 31 Oct 2026 (`docs/website-chat-v3/02-browser-e2e.md`), never against a
live site.
