# 10 - Security, permissions and privacy (as built)

What a viewer can and cannot see through the unified reporting additions, and the guards that enforce it. All
of it is behind the `UNIFIED_REPORTING` project feature (off by default). No permission key was added.

## Gates, in order

| Surface | Gate |
|---|---|
| Team Report page, exports, drill-down (all scopes) | `support_activity.view` (unchanged) |
| `scope=personal` and `scope=combined`, on the page and both exports | the feature on **and** `messages.view` (`resolvePageScope`, one function for the page and the export routes) |
| Personal table exports (`/api/team-report/table-export`) | the same gate; a viewer without it gets 403, never a spreadsheet |
| Run information, Collection detail lines, Customer-specific replies | the feature on; they add counts beside figures and change none |
| Identity preview (`previewTeamMemberIdentityChange`) | `whatsapp.manage` (the key of the actions it previews), then the feature on, then the project |
| Preview button on the add form, edit form, and WhatsApp Chat link panel | rendered only when the feature is on and the viewer may manage team members (for the link panel, may link) |

A request for `scope=personal` from a viewer without `messages.view` is not an error: it renders the group
report with the note "Personal chat reporting needs the View Messages permission." With the feature off the
scope parameter is ignored silently, so a flag-off page is identical to the old one.

Project access levels and project-role page selections still apply inside `checkPermission` / `hasPermission`;
nothing here grants anything because of a level.

## What never leaves the server

- **No message text** in any unified-reporting export, table or response. Run information, data quality and
  reply attribution are counts and codes. The human-only wait still reads short, pre-filtered text fragments
  inside the server, exactly as Support Intelligence always did; they are not returned.
- **No phone number is derived from a LID.** A LID is an opaque id: the reply attribution compares ids exactly,
  and nothing converts or prints a LID as a number (`describeSenderId` keeps masking it).
- **The identity preview prints counts, labels and times.** Its samples carry a conversation key, a time and two
  labels. For a personal conversation the key is replaced with the word `personal` before it reaches the
  browser, because a personal chat's id is a number or a LID. Group keys are WhatsApp group ids the Groups page
  already shows. Member names come from the roster the Team Members page already lists.
- **The digest and counts a save carries** (`previewDigest`, `previewAffected`, ...) are numbers and a hash.
  They are stored in the System Log entry only. They are what the browser reported, not recomputed by the
  server and not used for any decision.

## The preview is read-only

It reads `Message`, `OutboundMessage`, the roster and the report loaders, all through the project-scoped
client. It writes no row, queues no `IdentityReattribution`, and does not call the save actions. The integration
test counts `Message`, `IdentityReattribution`, `SystemLog` rows and the roster rows before and after three
different previews. Approval is the existing Save.

Without `messages.view` the viewer learns nothing about personal chats: personal messages are not read into any
count (totals, transitions, months and the estimate), not only hidden from one field.

## Project isolation

- Every new raw query names `"projectId" = ${projectId}` (`rawSqlProjectFilter.test.ts` fails the build
  otherwise): the personal loader, both preview queries, the data-quality counts and the reply-evidence join.
- The loaders import `prisma` from `@/server/db` only (the scoped client) and read the project from the URL.
- A personal chat of one project never appears in another's report; the personal and preview integration tests
  hold two projects with the same ids and the same window.

## Known exposure to keep in mind

- A holder of `messages.view` can see aggregate counts of personal conversations in the Team Report. That is the
  same population WhatsApp Chat already shows them; the report adds no content.
- The preview reveals, to a member manager, how many messages a sender id has written in the window. Anyone who
  can add a team member already sees the Identity check and the sender's own stored history on WhatsApp Chat.
