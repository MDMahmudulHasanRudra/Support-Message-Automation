# 06 — Implementation work packages

Branch `feat/meta-oauth`, from `rudra` at `e9fb6a5` (= `github/main`'s tree). Nothing is pushed, merged
or deployed. Status words:

- **implemented:** in the code.
- **mock-tested:** tested against a fake Meta on the isolated database.
- **live-tested:** verified against real Meta.
- **production-approved:** approved by the owner for production.

| WP | Scope | Status |
|---|---|---|
| 1 Repository audit | `01-repository-audit.md` | done |
| 2 Platform Meta configuration | `readMetaPlatformConfig` (shared), env in `docker-compose.yml` (app + worker) and `.env.example`, diagnostics for a Main Admin, off unless `META_INTEGRATION_ENABLED=true` | implemented, mock-tested |
| 3 Official OAuth | start / callback / claim / choice / connect / cancel (`metaOAuth.ts` and three routes), FLfB `config_id` or `scope`, long-lived exchange, `/me/permissions`, reconnect (`auth_type=rerequest`) | implemented, mock-tested |
| 4 Database | migration `20261025090000_meta_platform_oauth` (`04-…`) | implemented, mock-tested |
| 5 Asset discovery | `/me/accounts` with cursor paging (≤ 500 Pages), `classifyMetaAssets`, choice screen | implemented, mock-tested |
| 6 Shared webhook | `/api/meta/webhook`, `ingestPlatformMetaWebhook` | implemented, mock-tested |
| 7 Token health and lifecycle | worker `meta-connection-health`, Test connection, deauthorize, data deletion, disconnect rule for shared Page subscriptions | implemented, mock-tested |
| 8 AI/RAG | No change needed. Verified that the existing channel AI path applies to one-click rows unchanged (it never reads `authMode`). | reviewed |
| 9 Capability matrix | `02-meta-capability-matrix.md` | done (research) |
| 10 Free-feature implementation | **Not started, waiting for an owner decision.** Every candidate needs App Review for other businesses' Pages (category B in practice). Nothing was enabled. | waiting |
| 11 UI | `OneClickPanel`, choice screen, connection page (reconnect, granted permissions, no webhook fields for one-click) | implemented; checked in a browser against a fake Meta (`07-…`) |
| 12 Security and regression | `05-…`, `07-…` | mock-tested |
| 13 Live Meta testing | `META_DEVELOPER_SETUP.md` §8 | **not done**: needs the platform Meta app, which does not exist yet |
| 14 Production readiness | after live testing and App Review | not done |

## Files

| Area | Files |
|---|---|
| Shared | `packages/shared/src/metaPlatform.ts` (+ test), `index.ts` export |
| Database | `schema.prisma`, migration `20261025090000_meta_platform_oauth`, `packages/db/src/index.ts` (`MetaOAuthSession` is project-scoped) |
| Web, server | `server/channels/metaOAuth.ts`, `metaRevocation.ts` (new); `providerApi.ts`, `webhookIngest.ts`, `connections.ts`, `actions/channelConnections.ts` (extended) |
| Web, routes | `app/p/[project]/api/meta/connect`, `…/claim`, `app/api/meta/oauth/callback`, `…/webhook`, `…/deauthorize`, `…/data-deletion` |
| Web, UI | `settings/channels/page.tsx`, `[id]/page.tsx`, `OneClickPanel.tsx`, `meta/[sessionId]/page.tsx` + `MetaChoiceForm.tsx`; `projectSections.ts` (the two project routes belong to `/settings/channels`) |
| Worker | `channels/metaHealth.ts` (new), `channels/providerApi.ts`, `outboundProcessor.ts`, `inboundProcessor.ts`, `index.ts` (loop registered) |
| Tests | web `metaOAuth.integration.test.ts`; worker `metaPlatform.integration.test.ts`; shared `metaPlatform.test.ts` |
| Config | `docker-compose.yml`, `.env.example` |
| Docs | `docs/meta-integration/*`, `OMNICHANNEL.md`, `CLAUDE.md` |

## Known limitations

- **Live Meta behaviour is unverified.** In particular:
  - which Pages `/me/accounts` returns for a Facebook Login for Business grant on Pages owned by a
    business portfolio. If it is too few, `business_management` may be needed; it is deliberately not
    requested.
  - the exact webhook field set Meta requires for Instagram on a Page subscription.
- **No Notification Center alert when a connection needs reconnecting.** It is visible on Settings →
  Messaging Channels and in the System Log. An alert needs a new `NotificationEvent` (an enum
  migration and a template), which is left for a decision.
- Instagram Login (accounts without a Page) is not built.
- Automated-reply disclosure (Meta policy, some jurisdictions) is not added to AI replies; this is
  an owner decision (`02-…`).
- More than 500 Pages for one person: only the first 500 are offered.
- A Page can be one-click connected in only one workspace at a time (by design, `01-…` §4).

## Rollback

See `04-…` §Rollback. In short: an empty `META_INTEGRATION_ENABLED` turns every part of it off
without touching data. The schema can be reverted only before anyone has connected.
