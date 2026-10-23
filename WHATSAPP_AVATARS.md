# WhatsApp profile pictures and phone identity

Status (23 Oct 2026): built on `rudra`, **off by default**, not deployed. Passive pictures only. Active
profile-picture lookups (`getProfilePicFromServer`) are **not** part of this release; they need their own
approval after the lab test (§5).

## 1. What it does

- **Pictures**: WhatsApp Chat shows the profile picture of a person and the icon of a group, where WhatsApp
  already attached one to an incoming message. Everywhere else, and whenever a picture is missing or fails
  to load, the coloured initials show exactly as before.
- **Phone numbers**: the contact panel shows a number only with evidence, and says where it came from:
  - **Provided by WhatsApp** — the sender's id is a phone id (`…@c.us`);
  - **From the Team Members record** — the sender is a team member whose record holds a typed number
    (only to a viewer who may see the roster);
  - **From the linked client record** — the personal chat is linked to a client with a phone/WhatsApp
    channel (only to a viewer with `clients.view`, Client Management on).
  
  Otherwise it says **"Phone number unavailable"**. A LID (`…@lid`) is never read as a number
  (`resolveContactPhone`, `packages/shared/src/whatsappPictures.ts`).

On production (22 Oct 2026) every personal chat and every group sender is a LID: WhatsApp is not giving
phone numbers for these people. That is WhatsApp's privacy design, not a bug, and no setting changes it.

## 2. Where pictures come from — passively

OpenWA serialises the sender's contact onto every incoming message (`message.sender`) and, in a group, the
group's own contact (`message.chat.contact`). Both carry `profilePicThumbObj` (`img`, `eurl`, `tag`) from
WhatsApp Web's own local store. `toRawIncomingMessage` reads those two objects into `raw.pictures` —
reading them asks WhatsApp nothing.

1. **Record** (`recordMessagePictures`, worker `avatars/whatsappPictures.ts`): right after the message is
   stored, in `persistIncomingMessage`. Never throws. Kill switch first, then the project's feature (cached),
   then one write only when a picture is new or its version (`tag`) changed. Keyed by
   `(projectId, accountId, jid)` — per WhatsApp account, because what WhatsApp shows depends on who looks.
2. **Fetch** (`startPictureProcessor`, 10 s, one picture per tick for the whole server = at most 360/hour):
   only rows recorded from events, only for projects with the feature on, once per version. The address is
   the one on the event. There is **no** refresh timer, scan, bulk lookup or fetch on opening a chat.
3. **Serve** (`/p/<slug>/api/whatsapp/avatar/<id>`): session → project access → `messages.view` +
   WHATSAPP_CHAT → feature + kill switch → the project-scoped client (another project's id is a 404).
   `nosniff`, sandbox CSP, private 5-minute cache. WhatsApp's own address never reaches a browser.

The one network request this adds is the download of the thumbnail from the address WhatsApp put on the
event — the same CDN WhatsApp Web loads it from. It is not a profile lookup.

## 3. Safety checks on every picture

- **Address** (`isAllowedPictureUrl`): HTTPS only, a `*.whatsapp.net` host, default port, no credentials,
  ≤ 2,048 characters. Checked when recorded AND again right before fetching. Redirects are not followed
  (`redirect: "manual"`; anything but 200 is a failure). No IP, localhost or metadata address can pass (SSRF).
- **Size**: ≤ 100 KB, refused from `Content-Length` and again while reading.
- **Type**: read from the bytes (`prepareClientPhoto`): JPEG/PNG/WebP, 16–1024 px, metadata stripped.
  A CHECK constraint repeats the type and size limits in the database.
- **Failures**: 3 attempts (5 min, 30 min), then FAILED and the address is cleared. A failed picture is
  retried only when a later event brings it, at most once a day.

## 4. Switches

| Switch | Where | Effect |
|---|---|---|
| `WHATSAPP_AVATARS` project feature | Main Admin → project → features | Off (default): nothing recorded, fetched or served for that project. **Never switched by a plan**, not even All Access (`manualOnly`). |
| `WHATSAPP_AVATARS_DISABLED=true` | server `.env`, passed to app and worker | Emergency stop for the whole server: nothing recorded, no fetch claimed, nothing served. Recreate app and worker after changing it. |

Stored data: `WhatsAppPicture` (one table, migration `20261023090000_whatsapp_pictures`, additive). Deleting
an account deletes its pictures. Rollback: switch off; the table can be dropped.

## 5. Lab test (separate number only)

`openwa-avatar-lab.cjs` (kept outside the repository) links a **separate, non-production** number on a PC,
with no database, and reports field names and id kinds only (never a number or a picture):
- passive: whether `sender.profilePicThumbObj` / `chat.contact.profilePicThumbObj` are filled on real
  events, for LID senders, phone senders and groups, and which identity fields a sender carries;
- active, lab only: `getProfilePicFromServer` for up to 4 personal chats and 4 groups, 4 s apart — result
  type, host, content type, size, errors, and behaviour for a contact whose photo privacy is restricted.

Results decide whether active fetching is worth proposing. It stays out of the release until approved.

## 6. Tests

- `packages/shared/src/__tests__/whatsappPictures.test.ts` — SSRF cases, event parsing, kill switch, and
  phone evidence (a LID never becomes a number).
- `apps/worker/src/__tests__/whatsappPictures.integration.test.ts` — recording, one write per version,
  feature off, kill switch, never a group as a person, the message is stored whatever happens, fetch
  validation (redirect, HTML, fake image, oversize, foreign address), give-up.
- `apps/web/src/__tests__/whatsappPictures.integration.test.ts` — another project's picture is never
  returned; nothing with the feature off or the kill switch on.

Each protection was removed in turn and its test went red.

## 7. Group descriptions (23 Oct 2026)

WhatsApp Web keeps each group's description in its local chat model (`groupMetadata.desc`). The group sync
already reads every group in ONE in-page pass; it now takes the description from the same pass
(`readGroupChats`, trimmed, at most 2,000 characters). No request goes to WhatsApp, so there is no added
risk. Saved like a rename — only when the read carried a description and it differs; a read that did not
include one never clears a stored one, so a description removed on WhatsApp stays until a new one is set.
Shown in WhatsApp Chat → Group info. Column `WhatsAppGroup.description`, migration
`20261023120000_whatsapp_group_description` (additive, nullable). No feature switch: it is the group's own
public information, read the same way as its name.

**Not built, on purpose:** a person's "About" text (`getStatus`) and any other per-contact data. Each needs
one request to WhatsApp's servers per contact, often blocked by the person's privacy settings — the same
risk class as active profile-picture lookups.

## 8. Field result (23 Oct 2026, production, passive pictures switched on)

First 4 incoming messages after switching on (3 group, 1 personal, Test): none carried a picture, no
errors. WhatsApp Web running without a screen does not appear to load profile thumbnails by itself, so
passive pictures may stay empty. To be re-checked after more traffic.

