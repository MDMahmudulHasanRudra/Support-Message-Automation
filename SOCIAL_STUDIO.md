# Social Studio

Get Assist's own social media publishing module: connect Facebook Pages and Instagram professional
accounts, write posts once and adjust them per account, review and approve them, schedule them on a
calendar, publish them through each platform's **official** API, follow every publication, and read
the counts the platforms report. Feature `SOCIAL_STUDIO`, **off by default and never switched on by a
plan** (`manualOnly`). Owned code end to end: no Postiz, no third-party publishing service, no new
runtime dependency (see `docs/social-studio/03-licenses-and-provenance.md`).

Research notes: `docs/social-studio/01-feature-inventory.md` (what a complete product does, per
capability) and `docs/social-studio/02-capability-status.md` (what is implemented, mock-tested,
live-verified).

## Architecture

| Piece | Where |
|---|---|
| Rules (workflow, jobs, drafts, time zones, reconciliation, media sniffing) | `packages/shared/src/socialStudio.ts` |
| Platform catalogue (limits, capabilities, required permissions, implemented flag) | `packages/shared/src/socialPlatforms.ts` |
| Meta specifics, pure (publishing scopes, account discovery, Graph error reading) | `packages/shared/src/socialMeta.ts` |
| Adapters (one per platform, HTTP only) | `apps/web/src/server/social/adapters/` (`meta.ts`: Facebook Page + Instagram) |
| Accounts and the only token decryption | `apps/web/src/server/social/accounts.ts` |
| Meta connection for publishing | `apps/web/src/server/social/metaConnect.ts`, `/p/<slug>/api/social/meta/connect`, `/api/social/meta/callback` |
| Posts, approval, job actions, comments | `apps/web/src/server/social/posts.ts` |
| Publishing engine | `apps/web/src/server/social/engine.ts`, run by `server/socialProcessor.ts` |
| Media library + signed addresses | `apps/web/src/server/social/media.ts`, `/p/<slug>/api/social/upload`, `/p/<slug>/api/social/assets/<id>`, `/api/social/media/<id>` |
| Campaigns, templates, hashtags | `apps/web/src/server/social/library.ts` |
| Analytics + CSV | `apps/web/src/server/social/analytics.ts`, `/p/<slug>/api/social/export` |
| Pages | `(dashboard)/social/*` (Overview, Calendar, Posts with Drafts/Approvals/Scheduled/Published/Failed tabs, Create, post detail, Media Library, Campaigns, Templates, Analytics, Accounts) and `/settings/social` |
| Tables | migration `20261030120000_social_studio` (9 project-owned tables, below) |

Tables: `SocialConnection` (one person's authorization at a network), `SocialAccount` (a Page or an
Instagram account; one row per account per project), `SocialPost`, `SocialPostTarget` (the post on one
account: its own text and settings, AND the durable publish job), `SocialPublishAttempt`,
`SocialPostEvent` (history and comments, append-only by trigger), `SocialMediaAsset`, `SocialCampaign`
(optional link to a `SalesLead`), `SocialTemplate` (templates, signatures, hashtag sets). Every table is
in `PROJECT_SCOPED_MODELS`, has the `projectId` immutable trigger, and every relation between them has its
`_same_project` trigger.

## Workflow

`DRAFT → IN_REVIEW → APPROVED → SCHEDULED → PUBLISHED | PARTIAL | FAILED | UNKNOWN`, or `CANCELLED`
(`decideSocialTransition`). Rules worth not undoing:

- **Writing, approving and publishing are three keys**: `social.edit`, `social.approve`, `social.publish`;
  `social.manage` connects accounts; `social.view` reads. A person holding two of them may do both steps
  (the history records an approval of one's own post).
- **An approval covers exact material.** `approvalHash` is SHA-256 of `socialApprovalMaterial`: the main
  text, each account's own text and settings, and the media in order. Any edit returns the post to DRAFT
  and clears it. The engine checks the hash again at the moment of publishing. The scheduled time is
  not part of it: moving a post is the publisher's decision.
- **Each platform's documented limits** (`validateForPlatform`) are shown while writing, refuse approval
  and scheduling, and are checked again by the engine.
- **Accounts and media are loaded through the scoped client**; `planPublishAccounts` refuses the whole
  post if one account is not this project's, removed, waiting for reconnection, or switched off.
- **AI-assisted text** (`SocialPost.aiAssisted`) goes through exactly the same approval; nothing an AI
  writes is ever published by itself.

## Engine (`engine.ts`, `socialProcessor.ts`)

Runs in the APP process every 15 s (never in the WhatsApp worker; `SOCIAL_PROCESSOR_DISABLED=true` turns
it off). Several app instances may run it at once. Guarantees:

- **Claim**: a due job moves `DUE → PUBLISHING` by a conditional update with a random claim token and a
  5-minute lease. Only one instance wins.
- **Attempt record before anything is sent**: `SocialPublishAttempt` is written first. Steps that publish
  nothing come first (an Instagram container, an unpublished Facebook photo).
- **The fence** (`markSent`, release hardening 30 Oct 2026): immediately before the request that makes the
  post public, ONE transaction on the job's row checks that this run still holds the claim token AND its
  lease has not run out, renews the lease, and stamps `requestSentAt`. A run that lost the job gets
  `SocialClaimLostError` and sends nothing (the attempt is closed `CLAIM_LOST`). `saveContainers` is fenced
  the same way, and `renewLease()` runs on every Instagram processing poll and before each upload, so a slow
  but healthy run keeps its job and a run that lost it stops at once.
- **Lease recovery** takes the job's row first (same claim, lease still expired) and only then reads the
  attempt's `requestSentAt`. Because the stamp commits with the fence, the two cannot both win: a job is
  re-queued only when no request of that claim can ever leave; otherwise it becomes UNKNOWN.
- **Never blind**:
  - A refusal that is safe to repeat (a rate or quota limit, or a request that never left) waits
    `socialRetryDelayMs` and retries. After `SOCIAL_MAX_ATTEMPTS` (8) it is dead-lettered to FAILED.
  - An answer not seen after `markSent` (network loss, timeout, a 5xx) is **UNKNOWN**, and the engine
    never sends it again.
  - The answer arriving after the run's lease ran out (recovery already made it UNKNOWN) still settles it
    PUBLISHED, but only while it is UNKNOWN and no later attempt started (`settleLatePublication`).
- **What this is not**: exactly-once delivery. Meta's publishing endpoints take no idempotency key, so a
  request whose answer is lost cannot be proven either way by the app; it stays UNKNOWN until
  reconciliation or a person settles it. The guarantee is that the application never sends a post again
  on its own once it may have been published.
- **Rescheduling and cancelling a running job**: a calendar move re-checks, inside its own transaction and
  after locking the jobs, that none started publishing — so a publisher's claim and a reschedule cannot
  both win. Cancel only ever touches jobs still waiting.
- **Reconciliation of UNKNOWN**: every 3 minutes for 2 days, the account's recent publications are read.
  Exactly one with the same text (`matchRecentPublication`) settles it PUBLISHED. None or several leave it
  for a person, who either marks it published / not published, or **sends it again only after ticking
  "I checked the account and it is not there"**.
- **Instagram**:
  - The account's own 24-hour publishing quota is read first.
  - A container still processing is saved and re-used by the next attempt.
  - A container Meta could not process is refused with Meta's words.
- **Statistics**: published posts of the last 14 days are re-read every 6 hours (only the counts the
  adapter supports; a missing metric is absent, never 0).
- A suspended, archived or billing-held project, or one with the feature off, is skipped: its jobs wait.

## Meta (Facebook Pages, Instagram)

- **Reuses the platform's Meta app** (`META_INTEGRATION_ENABLED`, `META_APP_ID`, `META_APP_SECRET`,
  `META_GRAPH_API_VERSION`) and the `META_ALLOWED_PROJECT_IDS` gate (fails closed). Also reuses its token
  helpers (`providerApi.ts`).
- **Its own flow, callback, permissions and tables.**
  - Callback: `/api/social/meta/callback`, which must be added to the app's Valid OAuth Redirect URIs.
  - Permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`,
    `instagram_content_publish`; optional `META_SOCIAL_LOGIN_CONFIG_ID`.
  - Rows: `SocialConnection` / `SocialAccount`.
- **The messaging flow is not touched**: its callback, webhooks, `ChannelConnection` rows and
  `META_REQUESTED_SCOPES`. A messaging grant never makes an account publishable (a test pins it).
- **Callback checks**: the state travels in an encrypted HTTP-only cookie scoped to the callback path.
  The callback checks the state, the same signed-in person, project access and `social.manage`, then
  redeems the code server-side. The user token is made long-lived and kept encrypted.
- **Page tokens** (used for both the Page and its Instagram account) are encrypted and decrypted only in
  `accounts.ts`.
- **Account rules**: one row per account per project. Found again through another person's authorization,
  it moves to the newest one. An account whose role or permissions do not allow posting is listed as
  needing attention, with the reason.
- **Meta taking access back**: the platform's deauthorize and data-deletion callbacks
  (`metaRevocation.ts`) also reach Social Studio: that person's connections and every account they gave
  are marked NEEDS_RECONNECT and their tokens wiped (a scheduled post then fails with "reconnect", never
  sent with a dead token); a data-deletion request also replaces their Facebook id with an anonymous
  marker and removes their name. Messenger / Instagram DM handling is unchanged.
- **Which address the flow must start from**: the callback is built from `NEXTAUTH_URL`, and the state
  cookie and the session belong to the address the person is on. Connecting therefore works only from the
  `NEXTAUTH_URL` address (the same limit as the Google Sheets connection). With host routing on and a
  customer on its own address, it fails closed ("expired"), it does not misroute. Supporting customer
  addresses needs the messaging flow's claim hand-over; not built.
- **Media URLs**: Meta fetches media by URL. `signedAssetUrl` gives a 2-hour HMAC-signed address on
  `NEXTAUTH_URL` (which must be public https), served by `/api/social/media/<id>`. Unsigned, expired,
  altered and deleted all give the same 404.
- **Endpoints**:
  - Facebook: `/{page}/feed`, `/{page}/photos`, `/{page}/videos`, `DELETE /{post}`,
    `/{page}/published_posts`, reactions / comments / shares counts.
  - Instagram: `/{ig}/media`, `/{ig}/media_publish`, `/{ig}/content_publishing_limit`, `/{ig}/media`,
    `like_count` / `comments_count`.
  - Instagram has no delete in its API, so it is not offered.

**Live status: mock-tested only.** Nothing has been published to a real Page or Instagram account from
this code. Real use needs Meta App Review approval of the publishing permissions on the platform app.

## AI Content Studio

`/social/ai`, `social.edit` to ask, `social.view` to read.

- **Request kinds**: post ideas, captions, hashtags, rewrite, adapt for a platform, campaign plan, and
  review a draft.
- **Request inputs**: a tone, a language ("same" keeps Bengali as Bengali and Banglish as Banglish), a
  platform, and an optional choice of catalogue products.
- **How it is answered**: requests are `SocialAiRequest` rows, answered by the worker loop `social-ai`.
  - It uses Get Assist's existing AI path: `resolveAiClient("RESPONSE")`, the project's own provider,
    model, credentials and usage. There is no second AI system and no new credential.
  - It is gated on Social Studio and the AI Engine switch. AI Copilot is NOT required.
  - The prompt forbids any price, offer, date, statistic, link or claim not in the brief or in the chosen
    products' catalogue facts. Facts come only from products the person picked, only while the catalogue
    is on and they hold `commerce.view`.
- **Using an answer**: answers are suggestions. "Start a post with this" opens the composer with the text
  and marks the post `aiAssisted`; it then needs approval like any other post.
- **Status**: implemented and unit-tested (prompt and parsing). It has not been run against a real AI
  provider in this build.

## Recurring posts

Scheduling an approved post can repeat it daily, weekly or monthly, up to 12 more times
(`repeatTimes`).

- **Wall clock**: times are computed on the post's own wall clock, so 09:00 stays 09:00 across a
  daylight-saving change. A month without the day uses its last day.
- **Copies**: each occurrence is its own SCHEDULED post with the identical approved material, so the
  approval covers it. It is on the calendar and cancellable on its own. Nothing repeats out of sight.

## Automation: RSS import

`/social/automation`, `social.manage`. An RSS or Atom feed's NEW items become DRAFTS for chosen accounts.
They are drafts only: each still needs approval and scheduling.

- **Only new items**: only items published after the feed was added (`importFrom`), at most five per run.
- **One draft per item**: the item row (`@@unique([feedId, guid])`) and its draft are written in ONE
  transaction. A failure anywhere (the draft refused, the database failing after the draft was made)
  leaves nothing, and the item is tried again on the next run. The row is locked while its draft is made,
  so a second run at the same moment waits and then finds it done. An item an older build left recorded
  without a draft is picked up the same way.
- **The fetch** (`server/social/rss.ts`):
  - the name is resolved once per connection, INSIDE the connection (a custom `lookup`), every address is
    checked (`isPrivateAddress`: private, loopback, link-local, shared, documentation, multicast, and IPv6
    forms carrying such an IPv4 address), and the socket goes to exactly that address — no second
    resolution a DNS answer could change (rebinding). An address written as a literal is checked without
    resolving. No connection pool, no proxy;
  - http(s) on standard ports only; every redirect checked again as a new address, at most three;
  - 15-second deadline, 2 MB cap after decompression (gzip / deflate / br), feed content types only.
- **Parsing**: a bounded scanner without an XML library (`packages/shared/src/socialRss.ts`); markup and
  scripts are stripped, and only http(s) links are kept.
- **Schedule**: each feed has its own interval (1–24 h), checked by the Social Studio worker.
- **Status**: implemented; integration-tested against a real database and a local feed server (exactly once
  after a failure, concurrent runs, rebinding, redirects, size caps). Not run against a live public feed.
  Migration `20261030140000_social_rss`.

## Media library

- **What is accepted**: JPEG, PNG, WebP, GIF photos up to 8 MB, and MP4 / MOV videos up to 200 MB. The
  type is read from the bytes (`sniffSocialMedia`).
- **Storage**: files go to the media volume (`social/<projectId>/<random>.<ext>`). Uploads stop below
  `MEDIA_MIN_FREE_DISK_MB`. Each project has an allowance of `SOCIAL_MEDIA_PROJECT_MB` (5 GB by default).
- **The allowance under parallel uploads**: the first check is only a quick refusal. The decision is made
  when the file is recorded, under a per-project advisory lock that counts every recorded file, so
  uploads at the same moment are counted one after another; a file refused there is deleted.
- **Organising**: folders, tags, alt text, and search by name or tag.
- **Deleting** is refused while a post that is not yet published uses the file.
- **Backups**: the volume needs its own backup (MEDIA_STORAGE.md).

## Security and isolation

- Every page and action checks its own key, with the feature (`checkPermission`, `pageAccess`).
- Account actions are bound to the Accounts page (`sections`).
- Every query goes through the project-scoped client, and the database triggers refuse cross-project rows.
- Tokens are encrypted at rest (`encryptSecret`) and never sent to a browser. Graph calls carry
  `appsecret_proof`; error text is stripped of anything that looks like a token.
- The CSV export neutralises formula-leading cells.
- System Log records:
  - connections and disconnections;
  - approvals, scheduling and cancelling;
  - sending again, marking published and deleting from a platform;
  - every failed and unknown publication.

## Not built (see 02-capability-status.md)

- **Other platforms**: Threads, LinkedIn, YouTube, TikTok and Pinterest adapters. Each needs its own
  developer approval.
- **Notifications**: failure alerts through the Notification Center (failures are on the Overview and in
  the System Log).
- **Live testing**: real-provider verification of everything Meta.
