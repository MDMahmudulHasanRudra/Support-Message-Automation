# Social Studio — feature inventory (research)

What a complete social media management product does, written as **independent functional
specifications** from public product documentation and official platform API documentation. Postiz
(https://github.com/gitroomhq/postiz-app) was studied as a product reference only: its documented
features and workflows, not its code. No source, UI, styling, asset or schema was taken (see
`03-licenses-and-provenance.md`).

For each capability:
- **Purpose**, **Workflow**, **Inputs** and **Outputs** are what the feature does for a user.
- **Permissions** are Get Assist's keys.
- **Dependencies** are other modules or platform features.
- **Errors** are the failure cases.
- **API** is what the official platform API requires.
- **Acceptance** is the test that proves it.

Platform facts come from Meta's Graph API and Instagram Content Publishing documentation. Every other
platform is listed with its requirements and is **not** claimed.

## 1. Channel connection and management

- **Purpose**: let a business publish to its own accounts without sharing passwords.
- **Workflow**: Connect → the network's consent dialog → choose Pages / accounts → the accounts are
  listed with their health → refresh, switch off, or disconnect.
- **Inputs**: the person's consent at the network.
- **Outputs**: accounts with status, permissions and token expiry.
- **Permissions**: `social.manage` (connect, refresh, switch, disconnect); `social.view` (see).
- **Dependencies**: the platform's Meta app (`META_*`), `META_ALLOWED_PROJECT_IDS`, a public https
  `NEXTAUTH_URL`.
- **Errors**:
  - the person declined;
  - a permission is missing;
  - the person's role on the Page does not allow posting;
  - the token expired or was revoked;
  - the account is not a Business / Creator account.
- **API**: Facebook Login (`/dialog/oauth`, code exchange, long-lived token), `/me/accounts` with tasks
  and `instagram_business_account`, `/me/permissions`.
- **Acceptance**:
  - A messaging-only grant never makes an account publishable.
  - An account without CREATE_CONTENT is listed as needing attention.
  - Disconnect wipes the tokens and keeps the history.
- **Status**: implemented (Meta), mock-tested.

## 2. Content composer and drafts

- **Purpose**: write once, adjust per channel.
- **Workflow**: text → choose accounts → per-account own text / settings (Facebook link, Instagram Story)
  → media → campaign → planned time → Save draft / Send for approval.
- **Inputs**: text, accounts, media, settings, time and zone.
- **Outputs**: a DRAFT post with targets.
- **Permissions**: `social.edit`.
- **Dependencies**: the media library, templates.
- **Errors**:
  - empty;
  - too long for a platform;
  - too many hashtags;
  - wrong media type for a platform (Instagram is JPEG only);
  - photos with a video on Facebook;
  - an account not usable.
- **API**: platform limits only (checked again by the platform).
- **Acceptance**: the preview shows each platform's problems; the server refuses an account from another
  project; editing an approved post returns it to DRAFT.
- **Status**: implemented, unit-tested.

## 3. Multi-platform scheduling

- **Purpose**: publish to several accounts at a chosen time, each independently.
- **Workflow**: Approved post → Schedule (time + zone) or Publish now → each account is a job → the
  engine publishes when due.
- **Inputs**: time, zone, mode.
- **Outputs**: jobs DUE → PUBLISHED / FAILED / UNKNOWN.
- **Permissions**: `social.publish`.
- **Dependencies**: the engine (app process).
- **Errors**:
  - the approval no longer matches;
  - a time in the past;
  - an account needs reconnection;
  - a rate or quota limit;
  - a platform refusal;
  - a lost answer.
- **API**:
  - Facebook: `/feed`, `/photos`, `/videos`.
  - Instagram: `/media` → `/media_publish`, `content_publishing_limit`.
- **Acceptance**:
  - Two engine instances never publish one job.
  - An unseen answer after the publish request is UNKNOWN, never retried.
  - A lost lease before sending is retried.
- **Status**: implemented; adapters mock-tested; NOT live-verified.

## 4. Content calendar

- **Purpose**: see and move what is planned.
- **Workflow**: month / week / day in a chosen zone → filter by account / campaign / drafts → drag a
  scheduled post to another day, or Move on the post.
- **Inputs**: view, date, zone, filters.
- **Outputs**: the grid.
- **Permissions**: `social.view`; moving needs `social.publish`.
- **Dependencies**: none.
- **Errors**: moving a post that started publishing; a time less than a minute ahead.
- **API**: none (scheduling is ours).
- **Acceptance**: a post appears on its local day in the chosen zone; a started post cannot be dragged.
- **Status**: implemented.

## 5. Per-platform content

- **Purpose**: different text or options per network.
- **Workflow**: an account's "own text"; Facebook link; Instagram Story.
- **Permissions**: `social.edit`.
- **Acceptance**: the approval covers each account's own text and settings.
- **Status**: implemented.

## 6. Recurring posts

- **Purpose**: repeat evergreen posts.
- **API**: none needed (our scheduling).
- **Status**: implemented. Scheduling can repeat daily / weekly / monthly up to 12 times; each occurrence
  is its own scheduled post with the same approved material.

## 7. Post sets, templates, signatures, hashtags

- **Purpose**: reuse wording.
- **Workflow**: Templates page (template / signature / hashtag set) → insert in the composer; "hashtags
  used" counted from the project's own posts.
- **Permissions**: `social.edit` to manage, `social.view` to see.
- **Status**: implemented.

## 8. Approval workflow and collaboration

- **Purpose**: nothing goes public without a responsible person.
- **Workflow**: Send for approval (optionally naming a reviewer) → Approve (note optional) or Send back
  (note required) → comments with @mentions on the post → full history.
- **Permissions**: `social.approve`; comments need `social.edit` or `social.approve`.
- **Errors**:
  - approving a post that breaks a platform's limits;
  - a stale page (another person changed it).
- **Acceptance**: approval is refused when the material changed; history is append-only (database
  trigger).
- **Status**: implemented. Not built: notifications to the named reviewer.

## 9. Media library

- **Purpose**: one place for the project's photos and videos.
- **Workflow**: upload (button or drop) → folder, tags, alt text → choose in the composer → delete when
  unused.
- **Permissions**: `social.edit` / `social.view`.
- **Errors**:
  - an unsupported type (decided from the bytes);
  - too large;
  - the project allowance is full;
  - the disk is nearly full;
  - in use by a waiting post.
- **API**: a public fetchable URL for Meta (signed, 2 hours).
- **Status**: implemented.

## 10. AI content assistance

- **Purpose**: ideas, captions, hashtags, rewrites, tones, languages, platform adaptation, product-aware
  drafts.
- **Dependencies**: Get Assist's AI engine and Response model (the same providers, credentials and
  usage), optional Product Catalog.
- **Rule**: AI output only ever fills a draft; it is marked AI-assisted and needs approval.
- **Status**: implemented (`/social/ai`, worker loop `social-ai`); unit-tested; not run against a live AI
  provider.

## 11. Analytics and reports

- **Purpose**: what was published and how it did.
- **Workflow**: period, account, campaign → per-account totals, per-publication counts → CSV.
- **Permissions**: `social.view`.
- **API**:
  - Facebook: reactions / comments / shares summaries (`pages_read_engagement`).
  - Instagram: `like_count`, `comments_count` (`instagram_basic`).
  - Reach, impressions and saves need insights permissions that are not requested; they are shown as
    unavailable, never estimated.
- **Acceptance**: a metric the platform did not return is "—", not 0.
- **Status**: implemented for those counts.

## 12. Campaign planning

- **Purpose**: group posts and see results per campaign.
- **Workflow**: create (name, colour, dates, optional sales lead) → add posts → posts and published
  counts → analytics filtered by campaign.
- **Dependencies**: Sales Pipeline (optional, permission-aware).
- **Status**: implemented.

## 13. RSS and automation

- **Purpose**: draft posts from a feed; alerts.
- **Rule**: imported items are drafts needing approval.
- **Status**: RSS / Atom import implemented (`/social/automation`). Failure alerts through the Notification
  Center are NOT built: failures show on the Overview and in the System Log.

## 14. Other platforms

- **Threads**: `threads_basic`, `threads_content_publish`, container + publish (similar to Instagram).
- **LinkedIn**: Community Management API (`w_member_social`, `w_organization_social`), Posts API.
- **YouTube**: Data API `videos.insert`, resumable upload, a verified OAuth app.
- **TikTok**: Content Posting API, audit required (unaudited apps can only post privately).
- **Pinterest**: API v5 `pins` (`pins:write`, `boards:read`).

**Status**: NOT built. Each is listed in the catalogue with `implemented: false` and its requirement.
