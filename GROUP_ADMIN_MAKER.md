# WhatsApp Groups Admin Maker

Make ONE person who is already a member an admin in every group where the selected WhatsApp account
is itself an admin. Sidebar: **WhatsApp → Groups Admin Maker**, right after Add Number to Groups
(route `/group-admin-maker`, job page `/group-admin-maker/jobs/<id>`).

**It never adds anybody to a group.** If the number is not a member, that group's result is
"Not a member" and nothing is attempted. Add Number to Groups is a separate module and was not
changed.

## Flow

1. **Select account**: only CONNECTED accounts can be chosen; each option shows how many groups it
   has synced. The default is the first connected account that has groups.
2. **Target number**: `+8801XXXXXXXXX`, `8801XXXXXXXXX` and `01XXXXXXXXX` all work.
   `normalizeAdminTargetNumber` (`packages/shared/src/groupAdminPromotion.ts`) wraps the existing
   `normalizePhoneNumber` (digits only, 8–15). Its one addition is the Bangladeshi local mobile
   form: 11 digits starting `01` get `88` in front. Without that, a local number would match nobody
   in any group, because WhatsApp only knows the international form.
3. **Check groups** creates the job and opens its page. Everything after that runs in the worker,
   so leaving the page, refreshing it or closing the browser changes nothing. Coming back shows the
   same job.

## The job (`apps/worker/src/queue/groupAdminPromotionProcessor.ts`)

`startGroupAdminPromotionProcessor` polls every 3s and does at most ONE thing per tick:

- check one new job; or
- process one group of a running job.

It is overlap-guarded with `trackTick`, `registerLoop` and `recordLoopTick`, like the Add-to-Groups
loops. Rows are claimed globally and only for operating projects, then run inside the row's own
project, and the account must belong to that project.

**Checking** (`CHECKING` → `RUNNING`):

- One `getAdminGroupIds()` call (OpenWA `iAmAdmin()`) says where this account is an admin.
- Groups that are no longer active → **Group unavailable**.
- Groups where the account is not an admin → **Skipped — account is not an admin**.
- If WhatsApp will not say where the account is an admin, the job **fails** with that reason. It
  never guesses.

**Each remaining group** (`processItem`):

| What WhatsApp shows | Result |
|---|---|
| The number is not in the member list | **Not a member** — not added |
| It is in the list and already an admin | **Already admin** — nothing changed |
| The list identifies some members by LID, and the number is not found | **Could not verify membership** — nothing attempted |
| It is a member and not an admin | promote → read the admin list back → **Promoted** |
| WhatsApp refuses with a documented code | the matching result (not an admin / not a member / group unavailable) |
| Anything else (timeout, dropped page, unconfirmed promotion) | retried once after 60s, then **Failed** with WhatsApp's reason |

Notes on these results:

- **Promoted means confirmed.** OpenWA's `promoteParticipant` returns `true` or an error code. A
  promotion counts only after the group's admin list (`getGroupAdmins`) shows the number.
- **LIDs.** WhatsApp increasingly lists group members by an opaque LID rather than their number.
  The number can only be matched through a `…@c.us` id. When it is not found and the list holds
  LIDs, membership can be proven neither way. Calling that "not a member" would be a guess
  presented as a fact. OpenWA's promote also only accepts an id present in the member list, so
  there is nothing safe to try.
- An empty member list, or an admin list that cannot be read, is a failed read and is retried. It is
  never treated as "nobody is here" or "not an admin".

**Pacing**:

- 8–20s between two promotions on one account: at least 8s, plus a random 0–12s.
- Measured from the last attempt stored in the database, so a restart cannot burst.
- Groups that need no promotion (already admin, not a member) are settled without waiting.

**Crash-safe**:

- Each attempt is counted before the call.
- A re-run that finds the number already an admin after an attempt was made records **Promoted**,
  not "Already admin", and never promotes twice.

**Pauses, visibly**:

- Account not connected → `PAUSED_DISCONNECTED`. The page reads "Connection lost … Processed X / Y".
- Automation kill switch off → `STOPPED_KILL_SWITCH`.
- Both keep every result. **Resume** carries on from where the job stopped; it needs the account
  connected and automation on. **Cancel** closes the job.
- The worker never resumes a job by itself.

**Completes**: when no group is left waiting, the job becomes `COMPLETED` and the summary stays on
the page and in Recent jobs.

## One job per account + number

`startGroupAdminPromotion` takes `pg_advisory_xact_lock` on `(account, number)` and then looks for
an active job: `CHECKING`, `RUNNING`, `PAUSED_DISCONNECTED` or `STOPPED_KILL_SWITCH`.

- If there is one, it opens that job, with a toast saying so.
- Two people pressing at once get the same job.
- The number is compared after normalization, so `01…` and `+8801…` are the same job.
- After a job completes, fails or is cancelled, a new one may be started. It is idempotent: groups
  where the number is already an admin are reported as such.

## Data

Migration `20261004120000_group_admin_maker`. **It must be deployed before the page is used**, with
approval, since it touches the live DB.

- **Enums**: `GroupAdminPromotionJobStatus`, `GroupAdminPromotionItemStatus`.
- **`GroupAdminPromotionJob`**: account, creator, phone, status, totals, `statusReason`, timestamps.
- **`GroupAdminPromotionItem`**: one per group, `@@unique([jobId, groupId])`. Holds status, reason,
  WhatsApp's failure code, attempt and retry counts, `scheduledAt` and `lastAttemptAt`.
- Both tables are project-scoped (`PROJECT_SCOPED_MODELS`). They carry the Phase 7 `_same_project`
  triggers (account, job, group) and `projectId_immutable` triggers.

## Permissions and feature

- **No new permission keys.** It reuses Add Number to Groups' own: `bulk_messaging.view` sees jobs;
  `bulk_messaging.manage` starts, resumes and cancels.
- It belongs to the `BULK_MESSAGING` project feature. A project with that feature off has no page
  and cannot start a job.

## Tests

| Suite | File | Count | Covers |
|---|---|---|---|
| shared | `packages/shared/src/__tests__/groupAdminPromotion.test.ts` | 10 | normalization, decisions, failure classes |
| worker | `apps/worker/src/__tests__/groupAdminPromotion.integration.test.ts` | 8 | which groups are touched (never adds), unknown admin set, refusal and retry, unconfirmed promotion, crash re-run, pacing, disconnect pause and resume, kill switch |
| web | `apps/web/src/__tests__/groupAdminPromotion.integration.test.ts` | 7 | duplicate protection including a held lock, refusals, project isolation, resume and cancel |

Each was confirmed to fail against the code it protects.
