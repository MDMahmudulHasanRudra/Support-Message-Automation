# Website Chat V3 — browser pass (31 Oct 2026)

A local build against the isolated test database (`docker-compose.test.yml`, port 5433), never the live one.
The app ran as `next dev` on :8670 with the background processors off; a throwaway host site on :8671 served the
test pages; only the worker's two channel ticks (`runChannelInboundTick`, `runChannelOutboundTick`) ran, so
visitor messages became conversations and agent replies were sent. No WhatsApp session, no AI. Driven in the
desktop app's built-in browser; one check that browser cannot make was run in a real headless Chromium (below).

## What was exercised

| Area | Result |
|---|---|
| Connect form: `getassist.pro`, `www.example.com`, `ftp://bad.example`, `http://user:pw@x.com`, `http://localhost:8671` | Bare domains shown as "will be saved as https://…", the two bad ones refused with the reason, a "www" offer for `getassist.pro`. Widget created. |
| Plain HTML host with hostile CSS (`* { font !important }`, `button { … !important }`, `div { outline }`, `img { width !important }`) | Launcher at bottom right; page layout, body styles, stylesheet count and scroll width byte-identical before and after the widget loaded. |
| Visitor message: Bengali, emoji and `<b>not bold</b>` | Bengali rendered, the tag shown as text, stored ("✓" and time) once the inbound tick ran. Conversation kept across a reload (token). |
| Emoji picker | Opens with search and categories; "thumbs" → arrow down → Enter inserts 👍 at the cursor, typing continues after it. |
| Visitor photo with caption | Preview chip (name, size, remove), "Sending… n%", stored, shown inline in the widget through the token route (`blob:`), and in the agent thread through the project route. |
| Agent photo with caption from the inbox composer | Queued as one message, shown in the agent thread, delivered to the visitor's widget inline. |
| React SPA host (script added in `useEffect`) | One widget; `history.pushState` to `/checkout` hides it, back to Home shows it; the app's own state keeps working. |
| Phone viewport (375×812) | Full-screen panel, no horizontal scroll, launcher hidden while open. |
| Builder: Dark Premium preset → Save and apply | "Unsaved changes" → "All changes saved"; the public config served `preset: DARK_PREMIUM` with no images list or weekly hours. |
| Greeting bubble on (8 s) | Shown after the delay on a fresh visitor, in the preset's colours; not shown again in the same session. |
| Verify installation | "The widget started on http://localhost:8671 … (script 3.0.0)", switched on, allowed websites; after loading from `127.0.0.1:8671`: "http://127.0.0.1:8671 tried to start the widget … but is not listed", and no widget on that page. |

## Defects found and fixed in this pass

1. **"Visitors cannot send files yet" on the connect page.** The source was already right; the local
   `packages/shared/dist` was built before the copy change. Rebuilt. A production image builds it fresh.
2. **The active builder tab was unreadable** (dark text on the dark pill): it used `--color-primary-foreground`,
   which does not exist. Now `--color-on-primary`. The Social Studio calendar's "today" chip had the same token and
   is fixed too.
3. **"Telegram will now send its messages here"** after creating a website widget. Website-chat wording now.
4. **A host rule reached the widget's container** (`div { outline }` drew a dotted box around the launcher). The
   container is now `all:initial!important` and its display is set with `!important`.
5. **Emoji search found nothing for common words** ("thumbs") and said "Nothing here yet". More words, a match for a
   longer query ("thumbsup"), and "No emoji for that word". The grid also showed a sideways scrollbar; fixed.
6. **The thread opened above the newest message** when it held photos: they took their height after the scroll.
   A loaded photo now keeps a visitor who was at the newest message there.
7. **The launcher sat on top of Send** on a full-screen phone panel. Hidden while open.
8. **"1 new" for a reply already read**, on every page load: history counted as unread. The widget now remembers
   (per browser) the newest message the visitor had in front of them.
9. **The greeting bubble wrapped one word per line** (it shrank to the 56 px launcher box). It now sizes to its text.
10. **Builder preview: hydration mismatch** (the server rendered the preview's script address without the origin,
    the client with it). Not a functional break: a `srcdoc` document resolves a relative address against the page.
    The address is now relative on both sides.

Tests: `webchatWidgetScript.test.ts` gained two cases for 4, 7 and 8, confirmed to fail against the script before
the fix.

## What could not be checked here

- **WordPress.** No WordPress or PHP image was available locally and none was pulled; the plugin was neither
  linted (`php -l`) nor installed. Commands for doing it are in `03-release-report.md`.
- **The builder preview inside the desktop app's browser** stays blank: that browser refuses requests from a
  sandboxed (`null`-origin) frame, even a plain `fetch`. The same frame, built the same way, was loaded in real
  headless Chromium 1234 and the widget rendered (`root=true`), with both the absolute and the relative script
  address. An unsandboxed copy of the frame rendered the Dark Premium preset with the sample chat in the app's
  browser too.
- Drag-and-drop and paste of a visitor photo (the same `choose()` path as the button, which was exercised),
  auto-open, typing indicators and business hours were not driven in the browser; their rules are unit-tested.
- Safari / Firefox / real phones. Chromium only.
