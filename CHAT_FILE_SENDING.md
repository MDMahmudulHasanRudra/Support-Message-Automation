# Sending files from WhatsApp Chat

Status (23 Oct 2026): built on `rudra`, not deployed. Part of WhatsApp Chat v2, so it works only where the
`CHAT_UI_V2` project feature is on, and only for someone with `messages.reply`.

## 1. What it does

In a conversation, the attach button (📎) offers:

| Menu entry | Sends | Shown on WhatsApp as |
|---|---|---|
| **Photos & videos** | JPEG, PNG, WebP; MP4, 3GP (MOV goes as a document) | a photo or video with preview |
| **Document** | PDF, Word, Excel, PowerPoint (old and new), TXT, CSV, RTF, ZIP — and any photo, video or audio | a file, full quality, no preview |
| **Audio** | MP3, M4A, OGG/Opus, WAV | an audio file; an Opus `.ogg` can be sent as a **voice note** |

Also:
- Paste an image into the message box, or drop files anywhere on the conversation: the same dialog opens.
  Nothing is sent until **Send** is pressed.
- Up to 10 files per batch. Each is uploaded and queued on its own, with a progress bar. A refused file
  says why before anything is uploaded.
- An optional caption goes with the first file, as on a phone. Voice notes have no caption.
- "Send as a document" keeps photos and videos at full quality.
- Limits: photos 10 MB, everything else 16 MB.

## 2. How it flows

1. The browser posts the file to `/p/<slug>/api/whatsapp/send-file`. That route checks, in order:
   - the session;
   - `messages.reply` with WHATSAPP_CHAT;
   - `CHAT_UI_V2` is on;
   - the conversation, re-derived on the server (`resolveConversation`);
   - `sendTarget` (shared with polls/locations/stickers): the account is CONNECTED, the group is still
     joined, and a personal chat already exists (a reply, never a first message);
   - the file's size;
   - the file's type, read from its bytes (`planOutgoingFile`);
   - free disk space (`MEDIA_MIN_FREE_DISK_MB`).
2. The file is written to media storage at `outbound/<projectId>/<accountId>/<yyyy>/<mm>/<uuid>`, a key
   made of ids only.
3. **One** `OutboundMessage` is queued: `MANUAL_REPLY`, `contentType = MEDIA`, the `content` holding the
   key, name, type, size, kind and caption. Its idempotency key is `manual-file:<conversation>:<uploadId>`,
   so a request retried after a dropped response can never queue the file twice. When a duplicate is
   refused, its stored copy is deleted.
4. The worker's outbound queue sends it like any manual reply: the same rate limits, the same
   kill-switch rule (a person's send is not cancelled), and the same membership check. Before sending,
   `sendRichContent` re-checks the row (`validateOutgoingFileContent`, which requires the key to be under
   THIS project) and reads the stored bytes again (`planOutgoingFile`). Bytes that no longer match what
   was checked are refused.
5. `OpenWAProvider.sendFile` uploads the file inside WhatsApp Web exactly as if it had been attached by
   hand:
   - it always passes a `data:` URL built from bytes in memory, never a URL or path (given a URL, the
     library would fetch it);
   - nothing goes to a third party;
   - nothing licensed (Insiders) is used.
6. Once sent, the upload is deleted. WhatsApp's echo is stored as an ordinary message and its media is
   downloaded by the normal media path, so the chat shows the file like any other. Because the upload is
   gone, a row that is recovered later cannot send the file a second time.

## 3. What is never sent

- Programs and scripts, whatever their name: an `MZ`/ELF header, `#!`, or the extensions
  `.exe .msi .bat .cmd .ps1 .sh .js .vbs .apk .jar .dll .scr .lnk .reg .iso .img`.
- Web pages and SVG (`.html .htm .svg`).
- Any type the byte check does not recognise.
- A name is never trusted: a JPEG named `.pdf` goes as a JPEG named `….pdf.jpg`.

## 4. Switches and rollback

- Off wherever `CHAT_UI_V2` is off (the default). There is no separate switch.
- Migration `20261023150000_chat_file_send` adds one enum value (`OutboundContentType.MEDIA`). It is
  additive and nothing reads it with the code rolled back.
- `proxyClientMaxBodySize: 17mb` in `next.config.ts`, so a 16 MB file passes the proxy.
- Files that failed to send stay in `outbound/` on the media volume (small, and kept for a retry). They
  can be removed by hand.

## 5. Tests

- `packages/shared/src/__tests__/chatFileSend.test.ts`: byte sniffing, names that lie, programs, limits,
  voice-note rule, the worker re-check, keys.
- `apps/web/src/__tests__/chatFileSend.integration.test.ts`: the route stores and queues one row; a
  repeated upload id queues nothing more and leaves one file; every refusal stores and queues nothing.
- `apps/worker/src/__tests__/richMessaging.integration.test.ts`:
  - a file goes once, as stored, and its upload is removed after sending;
  - it is refused for another project's key, changed bytes, a size mismatch, a bad name, or a non-manual
    row;
  - voice notes and photos go in their own form.

Each protection was removed in turn and its test went red.

## 6. Needs a live check (lab or test number)

The mock provider proves what is handed to OpenWA. It cannot prove how WhatsApp Web renders each kind.
Before relying on it, send one of each kind from a test group to a phone:
- a photo;
- a video;
- a PDF;
- an Excel file;
- an MP3;
- an Opus voice note;
- a photo sent as a document.
