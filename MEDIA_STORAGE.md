# WhatsApp Message & Media Storage

Every WhatsApp message's text is stored, always. Its attachment is stored too: images, videos,
audio and voice notes, documents (any file type), stickers, GIFs and any other file. Each type has
its own switch, and all of them are on by default. Stored files are kept indefinitely unless a
retention period is set.

- **Settings:** Settings → WhatsApp → **Message & Media Storage** (`/settings/media-storage`).
- **Where attachments are shown:** the WhatsApp Chat thread.
- **Earlier draft:** `MEDIA_FOUNDATION_SCOPE.md` is superseded by this file (see the end).

## The path a message takes (audited before anything changed)

1. **Arrival.** `OpenWAProvider.onAnyMessage`. OpenWA waits for a media message's `clientUrl`
   before it emits the message, then hands over the serialized message. That message includes
   WhatsApp's raw media fields: `mediaKey`, `filehash`, `size`, `deprecatedMms3Url`, `directPath`,
   `mimetype`, `filename`, `width`/`height`/`duration`, `isGif`, and `body` (a small JPEG preview).
2. **Conversion.** `toRawIncomingMessage` converts the message.
   - The body becomes a label: `[Image]`, `[Video] caption`, `[Document] name`.
   - **New:** `toMediaDescriptor` also records the attachment's metadata and its fetch details as
     `raw.media`. This step does no I/O.
3. **Storage of the message row.** Two places write the `Message` row:
   - `persistIncomingMessage`, for incoming messages and catch-up messages;
   - `storeNonAutomatedMessage`, for outgoing messages, including what executives send from the
     business phone.

   In both, `Message @@unique([accountId, whatsappMessageId])` is the dedup guard. **New:** right
   after the insert, `registerMessageMedia` runs one settings read and one insert. It never throws.
4. **The rest of the pipeline** (rules, AI, escalation, support activity) runs exactly as before.
   It never waits on a file.
5. **The media worker** (`mediaDownloadProcessor`) fetches the file later, in the background.

The existing pipeline, the outbound queue, the AI fallback and Conversation Learning are unchanged.
The only line added to the message path is the insert in step 3.

## Data (`MessageMedia`, `MediaStorageSettings`, `MediaCleanupJob`)

- **No binary is ever stored in Postgres.** A `MessageMedia` row holds:
  - type and WhatsApp type, MIME type, file name;
  - announced and stored size, SHA-256, dimensions and duration;
  - storage key and thumbnail key;
  - status, with a reason code and the last error.
- **`messageId` is unique.** A WhatsApp message carries at most one file, so a redelivered event can
  never create a second row.
- **Fetch details** (media key, hashes, URL) live in `download` only until the row is settled, then
  they are cleared.
- **Statuses:**

  | Status | Meaning |
  |---|---|
  | `PENDING` | Waiting for the worker |
  | `DOWNLOADING` | Being fetched now |
  | `STORED` | The original file is in storage |
  | `NOT_STORED` | `SETTING_OFF`, `TOO_LARGE` |
  | `FAILED` | `EXPIRED`, `NO_DOWNLOAD_INFO`, `INTEGRITY`, `DOWNLOAD_FAILED` |
  | `DELETED` | `RETENTION`, `MANUAL_CLEANUP` |

- **Project isolation:** all three tables are project-scoped and carry Phase 7 triggers
  (`_same_project` on message, account and group, plus `projectId_immutable`).
- **Settings rows:** existing projects get theirs from the migration; new projects get one from
  `createProjectWithDefaults`.
- **Indexes:**
  - `(status, nextAttemptAt)`: the download queue;
  - `(projectId, status, createdAt)`: retention, cleanup preview and the cleanup scan;
  - `(projectId, status, mediaType)`: storage usage;
  - the unique `messageId`: the chat thread's lookup.
- **Migration:** `20261005090000_message_media_storage`. It only adds tables. **It must be deployed
  before the new code runs, and only with approval.**

## Storage (`packages/media-storage`)

- **Interface:** `MediaStorage` has `put` (atomic: write to a temporary file, then rename), `get`
  (with an optional byte range), `stat`, `exists`, `delete` (idempotent) and `freeBytes`.
- **Implementation today:** only `LocalMediaStorage`. In Docker it is the `support_automation_media`
  volume, mounted at `/app/media` in **both** the worker (which writes) and the dashboard (which
  reads).
- **Moving to S3, MinIO or R2:** add a second implementation behind the same interface and set
  `MEDIA_STORAGE_DRIVER`. The pipeline, the model and the chat never see a path. An unknown driver
  is refused, never quietly treated as local.
- **Keys:** `whatsapp/<projectId>/<accountId>/<groupId|direct>/<yyyy>/<mm>/<mediaId>`, plus
  `.thumb` for the preview. Keys contain ids only: never a phone number, a file name or customer
  text.
- **Path traversal:** keys are validated against a strict pattern (no `..`, no absolute paths, no
  backslashes), and the resolved path must stay inside the root.
- **`MEDIA_STORAGE_DIR`:** has no default outside Docker. Unset, attachments are still recorded and
  wait, saying `STORAGE_UNAVAILABLE`, and the Settings page warns about it.
- **Disk guard:** below `MEDIA_MIN_FREE_DISK_MB` (2048) of free space, nothing new is written
  (`DISK_LOW`, retried later). The disk is shared with Postgres, and a full disk stops the database.

## Downloading (`apps/worker/src/media/`)

- **Where the file comes from.** The file is fetched directly from WhatsApp's media CDN
  (`deprecatedMms3Url`, then `mmg.whatsapp.net` + `directPath`), with the headers OpenWA's own
  `@open-wa/wa-decrypt` sends. No browser and no live session is needed, so a download completes
  even if the account drops.
- **Decryption is our own streaming implementation of the same scheme**
  (`whatsappMediaCrypto.ts`): HKDF-SHA256 → AES-256-CBC + a 10-byte HMAC.
  - **Why not `wa-decrypt`:** it holds the whole file in memory and then converts it byte by byte
    into a JavaScript array, so a 100 MB video costs gigabytes of heap.
  - **Cross-check:** the test decrypts the same file with OpenWA's module and compares. The two
    agree on every byte of the file. `wa-decrypt` also returns one extra padding block when the
    size is a multiple of 16 (measured). Ours returns exactly the file.
  - **Integrity:** we verify the MAC and the padding. The stored file's SHA-256 must equal
    WhatsApp's `filehash`, otherwise the file is deleted and the download is retried.
- **Concurrency:** a pool of `MEDIA_DOWNLOAD_CONCURRENCY` downloads (2 by default). A row is claimed
  by the update that moves it out of `PENDING`, so no file is fetched twice.
- **Size limits** (`MEDIA_SIZE_LIMIT_BYTES`):

  | Type | Limit |
  |---|---|
  | Image | 32 MB |
  | Video | 256 MB |
  | Audio | 64 MB |
  | Document | 256 MB |
  | Sticker | 5 MB |
  | GIF | 64 MB |
  | Other | 256 MB |

  These are stricter than WhatsApp's 2 GB. A file is checked against the size WhatsApp announced
  before anything is fetched, and again while it streams.
- **Retries:** 4 attempts, waiting 1 min, 5 min, then 30 min.
  - A 404 or 410 means WhatsApp no longer has the file: `EXPIRED`, with no retry.
  - A message that arrived without fetch details (some history messages) asks the live session
    (`getMediaDownloadInfo`, which is OpenWA `getMessageById`).
- **Type switched off later:** the switch is re-read before each download. A type switched off after
  a file arrived but before it was fetched is not fetched.
- **Recovery:** a `DOWNLOADING` row left behind by a crashed process is put back. At boot this
  applies to all of them; afterwards, to any older than 45 minutes (`recoverStuckMediaDownloads`, in
  the five-minute recovery sweep).
- **Suspended projects:** their media is still collected, as their messages are.
- **Not implemented — stickers:** OpenWA gates sticker decryption behind its Insiders licence.
  Stickers are fetched like any other file when WhatsApp's message carries the key. When it does
  not, the sticker is recorded `FAILED / NO_DOWNLOAD_INFO`, which is honest rather than invented.
- **Not implemented — thumbnails:** no thumbnails are generated. WhatsApp's own small JPEG preview
  is stored beside the original (`thumbnailKey`), and it is the image and video placeholder and
  poster. The original is never replaced. Generating real thumbnails would need an image library
  (sharp) or ffmpeg in the image, which was judged not worth adding now.

## Viewing (`/p/<slug>/api/whatsapp/media/<mediaId>`)

**Checks, in order:**

1. A session (401 without one).
2. Project access, then `messages.view` (the key that opens the WhatsApp Chat), then the
   WHATSAPP_CHAT feature. Failing any of these is a 403.
3. The media row, read through the **project-scoped** client. Another project's id reads as not
   found. The row must be `STORED` and must still match its message's account and group, or the
   response is a 404.

**How the file is served:**

- **Streaming:** the file is streamed from storage. HTTP `Range` requests get a 206, so a video can
  seek. An `ETag` gives a 304 on the chat's refresh.
- **Inline types:** only image, video, audio and PDF MIME types are inline. Everything else is
  `application/octet-stream` and downloads as an attachment.
- **Headers on every response:** `X-Content-Type-Options: nosniff`, a sandboxed CSP (except PDF,
  which the browser's viewer renders), `Cache-Control: private`, and
  `Cross-Origin-Resource-Policy: same-origin`.

**Permission keys.** The specification named `whatsapp_group_chat.view` / `.send`. Those keys do not
exist here. The WhatsApp Chat is gated by `messages.view` (read) and `messages.reply` (send), so
those are what the endpoint uses. Adding parallel keys would have created a second permission
model. Sending media is not part of this phase.

**The chat** (`MessageAttachment.tsx`):

- **Data:** `getChatThread` selects attachment **metadata** only, through one lookup on the unique
  `messageId`.
- **Images and stickers:** load lazily, with WhatsApp's preview as the placeholder. Clicking one
  opens a full-size viewer.
- **Video and audio:** use `preload="none"`, so nothing loads until somebody presses play.
- **Documents and other files:** shown as a card with the name, type and size. Open is offered only
  for types the browser renders; Download is always offered.
- **Every other state says what happened:**
  - "Media is being stored…";
  - "Media was not stored" (switched off, or too large, with the limit);
  - "Media unavailable" (WhatsApp no longer has it, or every retry failed);
  - "Media removed by retention on <date>".
- **Older messages:** a message from before this feature shows "Image not archived — this arrived
  before media storage was switched on".

## Settings, retention and cleanup

- **Switches** (`settings.edit`): one per type. Each affects only media arriving **from now on**.
  - Turning one off deletes nothing.
  - Turning one on recovers nothing.
  - Messages show as "Always stored", with a lock and no control.
- **Retention:** keep everything (the default), 3, 6 or 12 months, or a custom number of days
  (7–3650).
  - **Scheduling:** the worker schedules a `RETENTION` cleanup at most every 6 hours per project,
    and only when there is something to remove.
  - **Changing the setting:** the web action cancels any active retention cleanup immediately. The
    worker also cancels one whose snapshot `retentionDays` no longer matches the setting.
  - **Keep everything** therefore stops deleting at once.
- **Manual cleanup:**
  1. Choose "older than 3/6/12 months or N days".
  2. **Preview** shows the real file count and recorded size from the media rows.
  3. Confirm by typing `DELETE`. The server checks the word too.
  4. One active cleanup per project, decided under an advisory lock.
  5. The web only writes the job row; the worker does the deleting.
- **The cleanup job (worker):**
  - **Batching:** 200 rows per batch, keyset-paginated on `(createdAt, id)`. The cursor is saved
    after every batch, so a restart continues where it stopped.
  - **Order:** the file is deleted first, then its row is marked `DELETED`.
  - **Failures:** a file that cannot be deleted stays `STORED`, is counted, and is retried by the
    next run.
  - **What it never touches:** `Message` rows.
  - **Progress:** reported as processed / candidates / removed / freed.
- **Usage:** total, per type and file count, from `SUM(sizeBytes)` over `STORED` rows. That is the
  size measured when each file was written, not an estimate and not a disk scan. Free space on the
  media disk comes from `statfs`.

## Backups

A database backup does **not** contain media files. They live on the `support_automation_media`
volume, which must be backed up separately. Restoring only the database brings back every message
and its file metadata, but not the files. The Settings page says the same.

## Not built in this phase

- **Sending media.** Planned as an extension of `OutboundMessage`; no second send path.
- **Backfilling history.** Media that was never archived is not recovered. WhatsApp's CDN URLs
  expire, and a speculative backfill was explicitly out of scope.
- **The S3/MinIO driver.** Only the interface is in place.
- **Content-addressable deduplication.** The SHA-256 is recorded so it is possible later.

## Tests

| Suite | File | Tests | Covers |
|---|---|---|---|
| media-storage | `localMediaStorage.test.ts` | 14 | put/get/range/delete, atomic writes, size limit, traversal, keys, range parsing |
| shared | `messageMedia.test.ts` | 13 | classification, per-type switches, size limit, retention parsing and cutoff, inline-type safety, captions |
| worker | `whatsappMediaCrypto.test.ts` | 12 | decryption, the cross-check against OpenWA's `wa-decrypt`, MAC and padding tamper, truncation, expiry, size, checksum |
| worker | `messageMedia.integration.test.ts` | 22 | the pipeline records and never fetches; every type on and off; idempotency; a broken attachment does not cost the message; store, expire, retry then fail, switched off later, no storage, low disk, live-session fallback, single claim, crash recovery |
| worker | `mediaCleanup.integration.test.ts` | 9 | batches, messages untouched, failed delete kept and retried, restart from cursor, retention scheduling and cancellation, project isolation |
| web | `messageMedia.integration.test.ts` | 13 | endpoint auth (401/403/404, project access through the real header path), range/304, inline safety, thumbnail, settings, retention cancel, preview, typed confirmation, one cleanup at a time, usage |

## Measured (throwaway test database, 4 Oct 2026)

Volume:

- one group with 5,000 messages, 2,000 of them with media;
- about 200,000 further media rows in the same project;
- a 120 MB video.

All figures were measured on a development machine with Postgres in Docker. Use them for relative
comparison, not as production numbers.

| What | Result |
|---|---|
| Chat thread window (81 messages), with media metadata vs without | median 8.1 ms vs 4.6 ms (p95 9.9 vs 6.8) |
| Message processing, text vs a 100 MB video message (registration only) | median 41 ms vs 50 ms |
| 50 concurrent incoming messages, half with media | 0.9 s total; 25 media rows, no duplicates |
| Settings page: storage usage over ~202,000 rows | median 84 ms (p95 147) |
| Cleanup preview over the same rows | median 118 ms (p95 160) |
| 120 MB video: download, decrypt, verify and store, streamed | 4.7 s; about 62 MB extra RSS while streaming (the file is never held in memory) |
| Range read: 1 MB at offset 100 MB | 12 ms |
| Cleanup: 2,000 real files in batches of 200 | 11 batches, median 215 ms per batch; all 5,290 messages untouched |

**Browser check: 37 of 37 passed.** It ran against the real pipeline and the real media loops, with
a fake WhatsApp CDN serving genuinely encrypted files: a JPEG, a WebM video, a WAV voice note, a
PDF, a ZIP, an HTML file and a WebP sticker.
