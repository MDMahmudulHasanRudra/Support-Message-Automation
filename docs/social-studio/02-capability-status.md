# Social Studio — capability status

The honest release boundary. The levels used:

- **Implemented**: the code exists, typechecks, and is reachable from the UI.
- **Unit-tested**: its pure rules are tested in packages/shared.
- **Mock-tested**: tested against a fake HTTP API (`apps/web/src/__tests__/socialMetaAdapter.test.ts`),
  with each safety test confirmed to fail against deliberately broken code.
- **Integration-tested**: run against a real database. **None yet**: the database integration suite was
  not run for this module.
- **Live-verified**: published to a real account. **None yet.**
- **Production-ready**: all of the above, plus Meta App Review, plus a deploy. **Nothing is.**

| Capability | Implemented | Tested | Live-verified | Blocker to real use |
|---|---|---|---|---|
| Connect Facebook Pages / Instagram for publishing | yes | unit (discovery, scopes) | no | Meta App Review of `pages_manage_posts`, `pages_read_engagement`, `instagram_content_publish`, `instagram_basic`; the callback added to the Meta app |
| Composer, per-account text and settings, preview | yes | unit (limits) | n/a | — |
| Approval workflow, comments, history | yes | unit (transitions) | n/a | — |
| Scheduling engine (claim, lease, attempts, retry, dead letter, UNKNOWN) | yes | unit (rules); the DB paths are not integration-tested | no | an isolated-DB integration run |
| Facebook Page publishing (text, link, photo, several photos, video) | yes | mock | no | App Review |
| Instagram publishing (photo, Reel, Story, carousel) | yes | mock | no | App Review; a public https NEXTAUTH_URL for media |
| Reconciliation of unknown outcomes | yes | unit (matching) + mock (reading) | no | — |
| Delete a publication (Facebook only; Instagram's API has none) | yes | — | no | — |
| Calendar (month / week / day, zones, drag to move) | yes | unit (zones) | n/a | — |
| Media library (upload, folders, tags, quota, signed URLs) | yes | unit (sniffing) | no | media volume + backup |
| Campaigns (with optional sales lead) | yes | — | n/a | — |
| Templates, signatures, hashtag sets | yes | unit (hashtags) | n/a | — |
| Analytics (reactions / comments / shares; likes / comments) + CSV | yes | mock (reading) | no | App Review; reach / impressions need insights permissions not requested |
| AI Content Studio (ideas, captions, hashtags, rewrite, adapt, campaign plan, review; product-aware) | yes | unit (validation, prompt rules, parsing) | not run against a real AI provider | AI Engine on + a Response model configured |
| Threads, LinkedIn, YouTube, TikTok, Pinterest | **no** | — | — | each network's developer approval + an adapter |
| Recurring posts (daily / weekly / monthly, up to 12, DST-correct) | yes | unit (times) | n/a | — |
| RSS / Atom import into drafts | yes | unit (parsing, address rules) | not run against a live feed | — |
| Failure alerts through the Notification Center | **no** (Overview and System Log only) | — | — | — |
