# Website live chat

A chat widget for the customer's own website, as a fourth channel beside Messenger, Instagram and Telegram
(`ChannelType.WEBCHAT`). Conversations land in All Conversations / Website Chat and get everything the
other channels have: replies, AI answers (the same channel AI path and gates), assignment, Team, notes,
tags, priority, Copilot. Behind the `OMNICHANNEL` feature, so it is available to every project type that
has it. Migrations `20261029120000_website_chat` and `20261030110000_webchat_v2` (visitor phone, page and
typing columns, agent typing; nullable columns only).

## Setting it up

Settings → Messaging Channels → Website chat → Connect: a name and the website addresses it may run on.
The widget page then shows:
- the install line: `<script src="https://<app>/api/webchat/widget.js" data-key="<key>" async></script>`;
- **Download WordPress plugin** (`channels.manage`), see below;
- widget settings: title, welcome message, reply-time note, colour, position, button label, distance from
  the bottom, visitor files on/off, ask for name / email, business hours;
- an optional identity secret, shown once, for signed-in customers;
- last-7-days counts (visitors, messages, conversations).

Shopify or any other site: paste the line into the theme footer. Next.js / React: render the same
`<script>` once in the root layout.

### WordPress

`/p/<slug>/api/webchat/wordpress/<connectionId>` returns `getassist-chat.zip` (`server/channels/webchatWordpress.ts`,
zipped by `server/zip.ts`, no dependency). It holds one PHP file that prints the widget in `wp_footer`, with
the widget key and script address written in, and a settings page (Settings → Get Assist Chat) to hide the
chat, paste the identity secret and turn on "show logged-in customers as verified".
- **The identity secret is never in the zip.** The download can be passed around; only the site's own
  administrator types the secret into WordPress, and the signatures are computed by PHP on the server.
- With the secret set, a logged-in WordPress user is signed (`hash`), and their WooCommerce `billing_phone`
  too (`phoneHash`), so the conversation shows their client record and orders.

## How it works

| Piece | Where |
|---|---|
| Widget script (Shadow DOM, textContent only, no dependencies) | `server/channels/webchatWidgetScript.ts`, served at `/api/webchat/widget.js` |
| Public API (no session) | `/api/webchat/<key>` (config + availability), `/session`, `/messages` (GET / POST), `/files` (POST), `/typing` (POST) — `app/api/webchat/[key]` |
| Rules | `server/channels/webchat.ts`; shared validation, hours and file rules `packages/shared/src/webchat.ts` |
| Inbound | the web records a `ChannelInboundEvent` (`provider: "WEBCHAT"`, dedup `wc:<visitor>:<nonce>`); the worker's existing inbound processor turns it into the conversation and message |
| Outbound | the existing channel send queue; for WEBCHAT the worker marks the reply SENT on store (no provider); the widget polls every 3 s while open, 30 s while closed |
| Visitor files for agents | `/p/<slug>/api/channels/attachment/<messageId>/<index>` |
| Visitor card | `server/channels/webchatVisitorCard.ts`, under the conversation header |
| Agent typing | `markAgentTyping` (`server/actions/webchatAgent.ts`), called by the composer |

## Files

Visitors can send JPEG / PNG / WebP photos and PDFs (`allowAttachments`, on by default), up to 10 MB each
and 10 per visitor per hour.
- The type is read from the BYTES (`planVisitorAttachment`), never from the name or the browser's claim;
  anything else is refused.
- Stored at `webchat/<projectId>/<visitorId>/<random>.<ext>` on the media volume. Nothing new is written
  below `MEDIA_MIN_FREE_DISK_MB`, as for WhatsApp media.
- **There is no public address for a visitor's file.** Agents open it through the project's own route:
  session, `messages.view` + Omnichannel, the message read through the scoped client, and a key that
  `isWebchatStorageKey` confirms is this project's. Photos are served in a sandbox; a PDF opens in the
  browser's viewer. The visitor sees only the file's name in their own conversation.
- A file-only message goes to a person: the channel AI hands it over as `MEDIA_ONLY_MESSAGE`.
- Visitor files are not covered by the media retention job yet (that job reads `MessageMedia` rows only).

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
- **Mobile:** the open panel is full screen at 480 px and below, inputs are 16 px (no iOS zoom), the page behind
  does not scroll, and safe-area insets are respected.

## Not built yet

Real-time push (polling only); visitor files in the retention job; more file types; overnight business
hours. Nothing here has been tested in a real browser or against a live site yet.
