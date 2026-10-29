# Website live chat

A chat widget for the customer's own website, as a fourth channel beside Messenger, Instagram and Telegram
(`ChannelType.WEBCHAT`). Conversations land in All Conversations / Website Chat and get everything the
other channels have: replies, AI answers (the same channel AI path and gates), assignment, Team, notes,
tags, priority, Copilot. Behind the `OMNICHANNEL` feature. Migration `20261029120000_website_chat`.

## Setting it up

Settings → Messaging Channels → Website chat → Connect: a name and the website addresses it may run on.
The widget page then shows:
- the install line: `<script src="https://<app>/api/webchat/widget.js" data-key="<key>" async></script>`;
- widget settings: title, welcome message, reply-time note, colour, position, ask for name / email;
- an optional identity secret, shown once, for signed-in customers;
- last-7-days counts (visitors, messages, conversations).

WordPress / WooCommerce / Shopify: paste the line into the theme footer (or any "insert footer code"
plugin). Next.js / React: render the same `<script>` once in the root layout.

## How it works

| Piece | Where |
|---|---|
| Widget script (Shadow DOM, textContent only, no dependencies) | `server/channels/webchatWidgetScript.ts`, served at `/api/webchat/widget.js` |
| Public API (no session) | `/api/webchat/<key>` (config), `/session`, `/messages` (GET / POST) — `app/api/webchat/[key]` |
| Rules | `server/channels/webchat.ts`; shared validation `packages/shared/src/webchat.ts` |
| Inbound | the web records a `ChannelInboundEvent` (`provider: "WEBCHAT"`, dedup `wc:<visitor>:<nonce>`); the worker's existing inbound processor turns it into the conversation and message |
| Outbound | the existing channel send queue; for WEBCHAT the worker marks the reply SENT on store (no provider); the widget polls every 3 s while open, 30 s while closed |

## Rules worth not undoing

- **The widget key names the widget; the browser Origin must be listed** (`allowedOrigins`, https only except
  localhost). No list = refused (fails closed). Origin checking stops other sites embedding the widget; it is
  not authentication.
- **A visitor is a random id plus a bearer token stored only as a SHA-256 hash.** A visitor reads only their
  own conversation's messages that were sent (never a note, a queued / failed reply or another thread).
- **Identity is never trusted from the browser.** A visitor is verified only when `hash = HMAC-SHA256(identity
  secret, user id)` checks out; otherwise a typed name is stored as "Name (unverified)".
- **Limits:** 30 new visitors per network per hour, 12 messages per visitor per minute, 2,000 characters,
  16 KB request bodies. A repeated nonce is the same message.
- The widget renders nothing when the key is unknown, the origin is not listed, the connection is
  disconnected, the project is not active or OMNICHANNEL is off. Switching the widget off keeps it visible
  with "Chat is not available right now."
- AI answers are labelled "AI assistant" in the widget. The Meta-only AI disclosure line does not apply here.

## Not built yet

File uploads from visitors, business hours / offline routing, typing indicators and read receipts,
real-time push (polling only), a packaged WordPress plugin.
