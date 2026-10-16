# Third-party reference: rmyndharis/OpenWA

Used as a design reference for WhatsApp Chat v2 (`CHAT_UI_V2.md`).

| | |
|---|---|
| Repository | https://github.com/rmyndharis/OpenWA |
| Commit pinned | `078b8aa458584762b9dee6d6e83fc42680fa14e5` (2026-10-15, "Merge pull request #1879 …") |
| Licence | MIT — "Copyright (c) 2026 Yudhi Armyndharis and OpenWA Contributors" |
| How it was read | GitHub web pages and the REST API only. Not cloned, not installed, not executed. |
| Not the same project as | `@open-wa/wa-automate`, the library this application's worker uses. |

## What was taken

**No source file, style sheet, image, icon, font or other asset was copied.** Every v2 component was
written for this application (Next.js App Router, this design system, this data model). What came from
OpenWA is design and interaction patterns, which the table records so the provenance is plain:

| v2 piece | OpenWA reference | Relationship |
|---|---|---|
| `apps/web/src/lib/chatScroll.ts` — follow new messages only within 100 px of the bottom; page back only on a person's scroll, never on a programmatic one | `dashboard/src/utils/scrollDecision.ts` (`decideScroll`, `shouldFetchOlderMessages`) | Independently implemented; same thresholds and the user-scroll guard. Prepend arithmetic is our own. |
| `packages/shared/src/chatThreadCursor.ts` `mergeThreadPages` — one entry per id, later copy wins | `dashboard/src/utils/chatMessages.ts` (`mergeChatMessages`, keyed merge) | Independently implemented; our key is our row id, ordering `(timestampWa, id)`. |
| `packages/shared/src/chatMessageFormat.ts` — WhatsApp markers, safe http(s) links, mentions, no linkify past a size limit | `dashboard/src/components/chats/MessageBody.tsx` (`parseMessageBody`, linkify cutoff) | Independently implemented; tokens rendered as React elements, never HTML. |
| Quote only a message that has a WhatsApp id (never a queued/local one) | `dashboard/src/utils/composerSend.ts` | Same rule, enforced on the server here. |
| Reaction state: absent = unknown, newest decides | `chatMessages.ts` `mergeReactionSnapshot` | Same idea; ours is limited to this account's own reactions, from worker results. |
| LID never presented as a phone number | `src/engine/identity/wa-id.ts` (`chatKind`, neutral JIDs) | Already this application's rule (WHATSAPP_IDENTITY.md); OpenWA's `lid_mappings` approach was studied and **not** adopted — no mapping is learned or guessed. |

## Dependencies

None added. No package from OpenWA, and no new third-party package, is installed by v2. The emoji
picker is a hard-coded list of Unicode characters; icons are the `lucide-react` set already in use.

## If code is ever copied later

Keep the MIT notice above with the copied file (a header comment naming the upstream path and this
commit), add a row to the table marked "Adapted", and check the licence of any asset separately — a
repository's root licence does not automatically cover every file or image inside it.
