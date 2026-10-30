# Social Studio — staging release runbook

Prepared 30 Oct 2026 for a **staging** release only. Production deployment is not authorised by this
document. Social Studio stays **off by default** (`SOCIAL_STUDIO` is `manualOnly`: no plan, project type or
template switches it on) and publishing is never enabled for a customer project automatically.

## 1. What is being released

| Piece | Where | Status |
|---|---|---|
| Social Studio module (posts, approval, calendar, media, campaigns, templates, analytics) | apps/web | implemented, mock-tested, DB-integration-tested |
| Publishing engine (claim, lease, fence, recovery, reconciliation) | apps/web `server/social/engine.ts`, `server/socialProcessor.ts` (app process) | DB-integration-tested against a fake Meta; **not live-verified** |
| Facebook Page + Instagram adapters | apps/web `server/social/adapters/meta.ts` | mock-tested; **not live-verified** |
| AI Content Studio | apps/worker loop `social-ai` | unit-tested; not run against a real AI provider |
| RSS / Atom import | apps/web `server/social/rss.ts` | DB-integration-tested with a local feed server; not run against a live feed |

## 2. Migrations — sequence

Three migrations, applied in name order by `prisma migrate deploy` (all additive: 12 new tables, one
trigger function and its triggers; **no existing table, column, enum or row is changed**):

1. `20261030120000_social_studio` — connections, accounts, posts, jobs (targets), attempts, history,
   media, campaigns, templates; same-project and project-immutability triggers; append-only history.
2. `20261030130000_social_ai` — `SocialAiRequest`.
3. `20261030140000_social_rss` — `SocialRssFeed`, `SocialRssItem`.

This hardening pass adds **no migration**. The staging database may also be behind on earlier migrations
(WP1–WP9, `20261029*` / `20261030*`): `migrate deploy` applies every pending one, oldest first, so read the
pending list before running it.

Verified on 30 Oct 2026: all 156 migrations applied in order to an empty PostgreSQL 16 database, `prisma
migrate status` reports "up to date", and `prisma migrate diff` (database → schema.prisma) shows no drift
for any Social table (the only drift is the Teams tables CLAUDE.md says were kept on purpose).

### Commands (staging host, per DEPLOY.md)

```bash
# 0. Record the state before touching anything
docker compose ps
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select migration_name, finished_at from _prisma_migrations order by migration_name desc limit 15;"

# 1. Back up (section 4) — do not continue without both backups

# 2. Build, then MIGRATE FIRST (up -d --no-deps skips the migrate service)
docker compose build app worker migrate
docker compose run --rm migrate

# 3. Start the new app and worker
docker compose up -d --no-deps app worker

# 4. Verify
docker compose run --rm migrate npx prisma migrate status
docker compose ps    # app, worker, postgres healthy
```

## 3. Environment variables

App container (`app`) unless noted. Nothing new is needed by the worker except what its AI loop already uses.

| Variable | Required | Default | Purpose / notes |
|---|---|---|---|
| `SOCIAL_PROCESSOR_DISABLED` | recommended at first start | unset (processor on) | `true` keeps the publishing worker off. Start staging with `true`, switch on after the checks in §6. |
| `NEXTAUTH_URL` | yes | — | Must be the **public https** address. Media URLs Meta fetches and the OAuth callback are built from it. The connect flow must be started from this address (§7). |
| `NEXTAUTH_SECRET` or `SOCIAL_MEDIA_URL_SECRET` | yes | — | Signs the 2-hour media URLs. `SOCIAL_MEDIA_URL_SECRET` (≥32 chars) is used when set; changing it invalidates links already handed to Meta. |
| `AI_CREDENTIALS_ENCRYPTION_KEY` | yes (already set) | — | Encrypts every stored token. **Never change it** on a database that holds tokens. |
| `META_INTEGRATION_ENABLED` | yes for Meta | — | `true`. The platform Meta app is shared with Messenger / Instagram DM. |
| `META_APP_ID`, `META_APP_SECRET` | yes for Meta | — | The platform app. The secret is env-only, never stored. |
| `META_WEBHOOK_VERIFY_TOKEN` | yes for Meta | — | Required by the shared Meta configuration check even though publishing uses no webhook. |
| `META_GRAPH_API_VERSION` | no | `v25.0` | Keep identical to the messaging integration. |
| `META_ALLOWED_PROJECT_IDS` | yes for Meta | empty = no project | Fails closed. On staging list **only the staging project id(s)**. |
| `META_SOCIAL_LOGIN_CONFIG_ID` | no | — | A Facebook Login for Business configuration made for the publishing permissions. |
| `MEDIA_STORAGE_DIR` | yes (already set) | — | The media volume, mounted in app and worker. |
| `SOCIAL_MEDIA_PROJECT_MB` | no | `5120` | Per-project media allowance. |
| `MEDIA_MIN_FREE_DISK_MB` | no | `2048` | Uploads stop below this free space (the disk is Postgres's too). |
| `SOCIAL_DEFAULT_TIMEZONE` | no | `Asia/Dhaka` | Default for RSS drafts. |
| `COOKIE_SECURE` | no | secure in production | Leave unset in production-like staging. |

In the Meta app (developers.facebook.com → the platform app → Facebook Login → Settings), add
`<NEXTAUTH_URL>/api/social/meta/callback` to **Valid OAuth Redirect URIs**. Leave the messaging callback
`/api/meta/oauth/callback` as it is.

## 4. Backups (before migrating)

```bash
# Database: a custom-format dump, then prove it restores
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backup-$(date +%Y%m%d-%H%M).dump
docker run --rm -v "$PWD":/b postgres:16-alpine pg_restore --list /b/backup-*.dump | head

# Media volume (database dumps do not include media — MEDIA_STORAGE.md)
docker run --rm -v support_automation_media:/m -v "$PWD":/b alpine tar czf /b/media-$(date +%Y%m%d-%H%M).tgz -C /m .
```

Keep both until staging has run at least 7 days without a rollback.

## 5. Rollback and restore

Prisma has no down-migrations. In order of preference:

1. **Switch it off (no data change).** `SOCIAL_PROCESSOR_DISABLED=true` and restart `app`, and/or switch the
   Social Studio module off for the project (Main Admin → project → Modules). Nothing is published; every
   row is kept; switching back on resumes where it stopped (UNKNOWN jobs stay UNKNOWN).
2. **Roll the code back, keep the tables.** Redeploy the previous image (`git checkout <previous sha>`, build,
   `docker compose up -d --no-deps app worker`). Older code never reads the Social tables, so leaving them
   is safe. Do not run `migrate` for the older build.
3. **Remove the tables (staging only, after a backup).** Only if the release is abandoned:

   ```sql
   BEGIN;
   DROP TABLE IF EXISTS "SocialRssItem", "SocialRssFeed", "SocialAiRequest", "SocialPublishAttempt",
     "SocialPostEvent", "SocialPostTarget", "SocialPost", "SocialTemplate", "SocialCampaign",
     "SocialMediaAsset", "SocialAccount", "SocialConnection" CASCADE;
   DROP FUNCTION IF EXISTS social_event_append_only();
   DELETE FROM "_prisma_migrations" WHERE migration_name IN
     ('20261030120000_social_studio', '20261030130000_social_ai', '20261030140000_social_rss');
   COMMIT;
   ```

   Then delete `social/` under the media volume. `ProjectFeature` rows with key `SOCIAL_STUDIO` and the
   `social.*` permission keys may stay (unused without the code).
4. **Full restore** from the §4 dump — loses every write made since the backup; staging only.

## 6. Switching it on in staging — checklist

1. Migrations applied and `migrate status` up to date; app and worker healthy.
2. `SOCIAL_PROCESSOR_DISABLED=true` for the first start.
3. Main Admin switches **Social Studio** on for the staging project only. Confirm in the database that no
   other project has it:
   `select "projectId" from "ProjectFeature" where key = 'SOCIAL_STUDIO' and enabled;`
4. `META_ALLOWED_PROJECT_IDS` = the staging project id only.
5. Connect a **test** Facebook Page and its Instagram business account (Social Studio → Accounts), starting
   from the `NEXTAUTH_URL` address.
6. Remove `SOCIAL_PROCESSOR_DISABLED`, restart `app`, then run the live checks in §8.

## 7. Known limits that affect staging

- **The connect flow must start from the `NEXTAUTH_URL` address.** The state cookie and session belong to the
  address the person is on; on another address (host routing on, a customer's own domain) the callback
  fails closed with "expired". Same limit as the Google Sheets connection. Fix = the messaging flow's claim
  hand-over; not built.
- **Shared Meta app.** Publishing and Messenger / Instagram DM use the same app. If Meta's Page picker
  replaces the app's Page grants with the latest selection, connecting publishing for fewer Pages could
  withdraw Messenger's access to the others. Not verifiable without a live app — test it (§8, step 9).
- **No liveness signal for the app-process publishing loop.** The worker's per-loop liveness does not cover
  it; use the queries in §9.
- **Exactly-once is not claimed.** A request whose answer is lost is UNKNOWN until reconciliation (one
  matching post on the account) or a person settles it.

## 8. Live verification on staging (not yet done — real-provider blockers)

Use a test Page and a test Instagram professional account owned by the team.

1. Connect; the Page and the Instagram account appear ACTIVE with the publishing permissions granted.
2. Publish now: Facebook text, link, one photo, several photos, one video; Instagram photo, Reel, carousel.
3. Schedule for +5 minutes, reschedule by dragging on the calendar, confirm it publishes at the new time only.
4. Two accounts on one post, one of them broken (e.g. Instagram with no media) → PARTIAL, the other published.
5. Revoke the Page's permission in Facebook settings, publish → FAILED with "reconnect", nothing retried.
6. UNKNOWN: block outbound traffic to graph.facebook.com for a few seconds during `media_publish` (staging
   firewall) → UNKNOWN, never re-sent; reconciliation matches it within ~3 minutes if it went out.
7. Statistics appear on Analytics after the 6-hour refresh (or trigger by setting `metricsAt` to null).
8. Meta deauthorize: remove the app at facebook.com/settings → the Social connection shows NEEDS_RECONNECT.
9. **Messenger protection:** with Messenger connected for Pages A and B, connect publishing for Page A only;
   confirm Messenger still receives webhooks for Page B and its connection stays CONNECTED.
10. RSS: add the company's real feed, wait for the run, confirm drafts appear once each.
11. AI Content Studio against the project's real provider: captions in Bengali and English.

## 9. Logs and monitoring

- **System Log**, scope `social`: connections and disconnections, approvals, scheduling, cancelling, every
  FAILED and UNKNOWN publication, sending again, marking published, deleting from a platform, Meta
  deauthorize / data-deletion effects.
- **App container stdout**: `[social] tick failed`, `[social] publishing failed`, `[social] lease recovery
  failed`, `[social] RSS import failed`.
- **Queries to watch** (run every few minutes on staging; any non-zero result needs a look):

  ```sql
  -- Due jobs not picked up: the processor is off, failing, or the project is held
  select count(*) from "SocialPostTarget" where status = 'DUE' and "dueAt" < now() - interval '5 minutes'
    and ("nextAttemptAt" is null or "nextAttemptAt" < now() - interval '5 minutes');
  -- Jobs stuck publishing past their lease (recovery should clear these within one tick)
  select count(*) from "SocialPostTarget" where status = 'PUBLISHING' and "leaseExpiresAt" < now() - interval '1 minute';
  -- Outcomes waiting for a person
  select count(*) from "SocialPostTarget" where status = 'UNKNOWN';
  -- Failures in the last day
  select count(*) from "SocialPostTarget" where status = 'FAILED' and "updatedAt" > now() - interval '1 day';
  -- Attempts that lost their claim (expected to be rare; many = lease too short or a stalled instance)
  select count(*) from "SocialPublishAttempt" where outcome = 'CLAIM_LOST' and "startedAt" > now() - interval '1 day';
  -- Feeds failing
  select name, "lastError", "lastFetchedAt" from "SocialRssFeed" where "lastError" is not null;
  -- AI requests not answered within 5 minutes (worker loop social-ai)
  select count(*) from "SocialAiRequest" where status = 'PENDING' and "createdAt" < now() - interval '5 minutes';
  ```

## 10. Meta App Review (needed before any customer can publish)

- **Permissions to request** on the platform app: `pages_show_list`, `pages_read_engagement`,
  `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` (plus `business_management` if a
  Login for Business configuration needs it). Advanced Access is required for Pages the app's own team
  does not administer.
- **Screencasts**: connect, choose Pages, write → approve → schedule → published post on the Page and on
  Instagram; disconnect.
- **Policy pages**: privacy policy describing what is stored (encrypted Page tokens, post content, media)
  and the data-deletion callback (`/api/meta/data-deletion`, now covering Social Studio).
- **Business verification** of the platform's Meta Business account.
- Until approved, only people with a role on the Meta app can connect (Standard Access).
