# Website Chat V3 — WP1 audit of the existing Website Chat (30 Oct 2026)

What exists on `rudra` before V3 (commits 486deb2 and 278afd9, WEBSITE_CHAT.md), checked against the code.

## Works today (reused, not rebuilt)

| Capability | Where |
|---|---|
| One-line script `<script src=".../api/webchat/widget.js" data-key="…" async>` | `server/channels/webchatWidgetScript.ts`, `app/api/webchat/widget.js` |
| Closed Shadow DOM, every message set with `textContent` | widget script |
| Public API: config, session, messages GET/POST, files POST, typing | `app/api/webchat/[key]/…` |
| Origin allowlist (fails closed), CORS per listed origin | `corsFor`, `originAllowed` |
| Visitor = random id + bearer token stored as SHA-256 | `startVisitor`, `visitorFromToken` |
| Signed identity (HMAC of user id; phone needs its own HMAC) | `startVisitor` |
| Text messages, nonce de-duplication, 12/min, 2,000 chars | `recordVisitorMessage` |
| Visitor JPEG/PNG/WebP/PDF uploads, type from the BYTES, 10 MB, 10/hour, disk floor | `recordVisitorFile`, `planVisitorAttachment` |
| Inbound → worker → `ChannelConversation` / `ChannelMessage` (the omnichannel pipeline) | worker `channels/inboundProcessor.ts` |
| Human replies (send queue, WEBCHAT = SENT on store) and channel AI (same gates as WhatsApp) | `server/channels/replies.ts`, worker `outboundProcessor.ts`, `aiReply.ts` |
| Agent views visitor files (session + `messages.view`, scoped client, key check) | `app/p/[project]/api/channels/attachment/[messageId]/[index]` |
| Typing both ways, seen/read, business hours, offline email | widget + `webchat.ts` |
| Visitor card with client / order context for signed visitors | `webchatVisitorCard.ts` |
| WordPress plugin zip (no secret inside; hide switch; WooCommerce phone signing) | `webchatWordpress.ts` |

## The two screenshots

- **"Visitors cannot send files yet"** is **stale copy still in the code**: the Website Chat entry of the shared
  channel catalogue (`packages/shared/src/channels.ts`, `limitations`) was not updated when 278afd9 (WP9) added
  visitor files. Not a disabled setting (`allowAttachments` defaults on) and not a defect in the upload path; the
  production build is also older than 278afd9 (not deployed), so production really cannot accept files today.
  Fixed in V3.
- **"Credentials are checked with the provider…"** is the shared connect-page header for every channel. For Website
  Chat it is wrong (there is no provider and no credential). **Real copy defect** — fixed in V3.
- **"Not a website address: getassist.pro"** — `normalizeOrigin` needs a full URL. **Real usability defect** — V3
  normalizes a bare domain to `https://…` and shows the result before saving.
- **"Website chat is not connected"** on the inbox is correct for a project with no widget; it appears only when
  the project has none. The fallback text there omitted Website — fixed.

## Missing (built in V3)

| Requirement | State before V3 |
|---|---|
| Visitor sees their own photos inline | names only ("📎 file") — no visitor-scoped image route |
| Agent replies with a photo | text only; the worker refuses an empty-text WEBCHAT reply |
| Image-only setting (no PDFs for new widgets) | photos and PDFs together; must keep PDFs for existing widgets |
| Paste / drag-drop / preview / progress / caption / retry | none (file picker, uploads at once, no caption) |
| Appearance beyond colour, position, label, offset | none (themes, header, bubbles, radius, size, shadow, font) |
| Launcher styles, logo, team avatars | one chat icon |
| Greeting teaser, delays, auto-open, frequency caps, page targeting | none |
| Emoji picker | none |
| Timestamps, date separators, read ticks, new-message indicator, keep scroll | re-renders the whole list and jumps to the bottom on every poll |
| Live builder preview | none |
| Install guides per platform, verification | one snippet; nothing records that the script ever ran |
| Domain normalization | refuses a bare domain |

## Constraints kept

No second chat platform, no new conversation tables, no WebSockets, no new AI path, no secrets in the browser or the
plugin, the public API and the embed line unchanged, WhatsApp untouched.
