# Media Foundation — frozen scope (SUPERSEDED)

**Superseded by `MEDIA_STORAGE.md` (5 Oct 2026), which is what was built.** That build followed a
later, explicit specification, so it differs from this draft in these ways:

- **Types:** every type has its own switch, all on by default (including video). Stickers, GIFs and
  other files are stored.
- **Retention:** indefinite by default.
- **Outbound media and forwarding:** not part of it.

This document is kept for its reasoning — the disk arithmetic below is why the size limits and the
low-disk guard exist.

**Original status:** scope agreed, nothing implemented. No code, no schema and no migration existed
for any of this. The document was written so the first implementation pass would have a decided
boundary rather than an open-ended one.

**Sequencing: Phase B first.** The Support Activity / Team Management audit is currently verifying
the baseline integrity of those two modules. Introducing media at the same time changes that
baseline, and a regression afterwards would be much harder to attribute. Media Foundation begins
only once Phase B's 53 leads have been reproduced.

---

## The design rule this scope is built on

> **A setting whose backend behaviour is not actually implemented does not appear in the UI.**

This is the `countingMode` lesson stated as a rule. That column was saved, validated, offered in the
form and reported by the AI assistant, while **nothing read it** — every number on every page stayed
identical whichever value was chosen. Seven speculative "AI media" toggles would be the same mistake
seven times over.

The capability ships first. The toggle ships with it, never before it.

---

## Why media is its own entity

Media does not live on `Message` as a column. A `MediaAsset` is referenced by a message but owned by
nothing in particular, because the same asset is eventually wanted by the chat thread, search, a
ticket, the knowledge base and — later — an AI consumer. A column on `Message` would make every one
of those a join through a table that has no business being in the middle.

```
Message ──> mediaId ──> MediaAsset ──> storage key ──> object on disk
                            │
                            └──> metadata (type, size, checksum, dimensions, duration, status)
```

`MediaService` is the only thing that knows where bytes live. The UI asks for a media id and gets an
authorised, short-lived URL; it never learns a storage path. That indirection is the whole reason a
later move to S3/R2 is a configuration change rather than a rewrite.

---

## v1 — what gets built

| # | Item | Notes |
|---|---|---|
| 1 | `MediaAsset` entity | mediaId, messageId, accountId, chatId, type, mime, size, checksum, storageKey, dimensions/duration, status, timestamps |
| 2 | `MediaService` abstraction | upload / get / stream / signedUrl / delete |
| 3 | **Local persistent volume** | not MinIO — see *Storage* below |
| 4 | Inbound capture | image + voice, default on |
| 5 | Inbound video + document | size-capped, **video default OFF** — see *Disk* below |
| 6 | Chat display | image preview, audio player, document download |
| 7 | Outbound media | composer attach, through the **existing `OutboundMessage` queue** |
| 8 | Retention + cleanup | **v1, not later** — see *Disk* |
| 9 | MIME / size validation | |
| 10 | Authorised private access | no public URL, ever |
| 11 | Permissions | the existing `PermissionModule` |
| 12 | Audit | the existing `SystemLog` |

### Two things that must not be re-invented

`SystemLog` already carries `actorUserId`, `targetType`, `targetId` and `correlationId`, with
`@@index([targetType, targetId])`. A media audit is `targetType: "MediaAsset"` and nothing more. A
second audit table would mean two places each holding a partial history, with nothing to say which
is complete.

`PermissionModule` / `PermissionModulePermission` already exist. Media permissions are entries in
that system, not a parallel one.

### One outbound mechanism

Outbound media extends `OutboundMessage`. It does **not** get its own send path. The queue is where
the kill switch, rate limits, membership verification, idempotency and deferral all live, and a
second path would bypass every one of them.

---

## Phase 2

Inline video player · conversation media gallery · media search and filtering · **forwarding** ·
thumbnail generation · checksum deduplication · S3/R2 migration.

Forwarding is Phase 2 because there is nothing to forward until the media layer exists.

Thumbnails are Phase 2 because their only consumer is the gallery. Generating them in v1 would be
processing work with nothing reading the output.

---

## Not building, and why

| Item | Why not |
|---|---|
| Separate `MediaAudit` table | `SystemLog` already has the columns and the index |
| Separate media permission system | `PermissionModule` exists |
| Virus-scanning subsystem | Wrong threat model. Customers send screenshots to a support team; this would be a whole subsystem defending against something that is not happening |
| Tags, notes, favourites, internal labels, media timeline | That is a digital-asset-management product. This is a support CRM |
| Storage analytics dashboard (growth charts, largest files, per-customer/per-group breakdown) | "No decorative dashboards." One number — GB used — answers the question anybody actually asks |
| Sticker / GIF / contact card / location as stored media types | Not support evidence |
| AI media settings now | The design rule above. No capability, no toggle |

---

## Settings — six, not sixty

```
Settings
└── Media
    ├── Store incoming media        ON
    ├── Store video                 OFF
    ├── Max file size (MB)          16
    ├── Retention (days)            90
    ├── Allow outbound media        ON
    └── Allow media forwarding      OFF
```

Everything else is a decision in code. "Store images" and "store audio" as separate switches invites
the question of who turns one off and keeps the other, and there is no answer — the real control is
the size cap and the retention window.

`Allow media forwarding` appears in v1 as OFF and does nothing until Phase 2 builds forwarding —
**which means, by the rule above, it does not ship in v1 either.** It is listed here so the Phase 2
scope is already decided, not so it appears greyed out in the UI.

---

## Storage: local volume first

There is no object storage in this deployment — no MinIO, no S3, no `aws-sdk` anywhere in the
compose file or any `package.json`. Production runs four services: `postgres`, `migrate`, `app`,
`worker`.

The VPS is shared with an unrelated `block-profile` stack and mail services. Adding a stateful
storage service there means a new failure mode and a new backup responsibility, for a benefit that
`MediaService` already provides in the abstraction. Local Docker volume is the honest v1; the
abstraction is what makes S3 or R2 a later configuration change.

---

## Disk: why video is off and retention is v1

Against ~1,848 groups, assuming a fifth of them send one item on a given day:

| Type | Per file | Per day | Per year |
|---|---|---|---|
| Image | ~100 KB | ~37 MB | ~13 GB |
| Voice | ~25 KB | ~9 MB | ~3 GB |
| **Video** | **1–16 MB** | **~370 MB – 6 GB** | **unbounded in practice** |

Images and voice are cheap and are what support conversations actually carry. Video is what fills a
disk, and this disk is shared with other services — when it fills, Postgres stops too. That is why
video defaults to off and why retention is not deferrable: without it this feature degrades the
server it runs on, on a timeline of months.

---

## Open before implementation begins

- Retention default of 90 days is a guess, not a policy. Whether support screenshots need to be kept
  longer for dispute or billing reasons is a business decision, not an engineering one.
- Customer media frequently contains invoices, national ID photos and account numbers. Private
  access and retention are in v1 for that reason; whether anything further is required is a question
  for whoever owns that risk.
