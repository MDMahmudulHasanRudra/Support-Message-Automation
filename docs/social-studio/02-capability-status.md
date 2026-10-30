# Social Studio — capability status

The honest release boundary. The levels used:

- **Implemented**: the code exists, typechecks, and is reachable from the UI.
- **Unit-tested**: its pure rules are tested in packages/shared.
- **Mock-tested**: tested against a fake HTTP API (`apps/web/src/__tests__/socialMetaAdapter.test.ts`),
  with each safety test confirmed to fail against deliberately broken code.
- **Integration-tested**: run against a real PostgreSQL database (the isolated test DB, all migrations
  applied) with a fake Meta: `apps/web/src/__tests__/socialStudio.integration.test.ts` (20 tests, release
  hardening 30 Oct 2026), each safety test confirmed to fail against the code it protects.
- **Live-verified**: published to a real account. **None yet.**
- **Production-ready**: all of the above, plus Meta App Review, plus a deploy. **Nothing is.**

| Capability | Implemented | Tested | Live-verified | Blocker to real use |
|---|---|---|---|---|
| Connect Facebook Pages / Instagram for publishing | yes | unit (discovery, scopes) | no | Meta App Review of `pages_manage_posts`, `pages_read_engagement`, `instagram_content_publish`, `instagram_basic`; the callback added to the Meta app |
| Composer, per-account text and settings, preview | yes | unit (limits) | n/a | — |
| Approval workflow, comments, history | yes | unit (transitions) | n/a | — |
| Scheduling engine (claim, lease fence, renewal, recovery, retry, dead letter, UNKNOWN, late answer) | yes | unit + **integration** (racing runs and processors, lease lost during Instagram processing, crash before/after the request, ambiguous answer, reschedule/cancel races) | no | — |
| Facebook Page publishing (text, link, photo, several photos, video) | yes | mock | no | App Review |
| Instagram publishing (photo, Reel, Story, carousel) | yes | mock | no | App Review; a public https NEXTAUTH_URL for media |
| Reconciliation of unknown outcomes | yes | unit (matching) + mock (reading) | no | — |
| Delete a publication (Facebook only; Instagram's API has none) | yes | — | no | — |
| Calendar (month / week / day, zones, drag to move) | yes | unit (zones) | n/a | — |
| Media library (upload, folders, tags, quota, signed URLs) | yes | unit + **integration** (allowance under parallel uploads, signed-URL route) | no | media volume + backup |
| Campaigns (with optional sales lead) | yes | — | n/a | — |
| Templates, signatures, hashtag sets | yes | unit (hashtags) | n/a | — |
| Analytics (reactions / comments / shares; likes / comments) + CSV | yes | mock (reading) | no | App Review; reach / impressions need insights permissions not requested |
| AI Content Studio (ideas, captions, hashtags, rewrite, adapt, campaign plan, review; product-aware) | yes | unit (validation, prompt rules, parsing) | not run against a real AI provider | AI Engine on + a Response model configured |
| Threads, LinkedIn, YouTube, TikTok, Pinterest | **no** | — | — | each network's developer approval + an adapter |
| Recurring posts (daily / weekly / monthly, up to 12, DST-correct) | yes | unit (times) | n/a | — |
| RSS / Atom import into drafts | yes | unit + **integration** (exactly once after failures and concurrent runs; DNS-rebinding, redirect and size rules against a local server) | not run against a live feed | — |
| Failure alerts through the Notification Center | **no** (Overview and System Log only) | — | — | — |

| Meta deauthorize / data deletion reaching Social Studio | yes | **integration** | no (needs the live callbacks) | — |
| Connecting from a customer's own address (host routing on) | **no** — fails closed; start from `NEXTAUTH_URL` | — | — | the messaging flow's claim hand-over |

Staging release procedure, rollback and monitoring: `04-staging-release.md`.
