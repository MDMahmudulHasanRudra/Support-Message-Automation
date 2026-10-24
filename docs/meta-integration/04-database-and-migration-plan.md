# 04 — Database and migration

Migration `20261025090000_meta_platform_oauth`. **Additive only**: no table, column, index or row that
exists today is changed or removed. Every existing connection reads `authMode = MANUAL` through the
column default, which is exactly how it behaved before.

## What it adds

| Object | Kind | Purpose |
|---|---|---|
| `ChannelAuthMode` (MANUAL, PLATFORM) | enum | How a connection was made. |
| `MetaOAuthPurpose` (CONNECT, RECONNECT) | enum | Why the dialog was opened. |
| `MetaOAuthStatus` (STARTED, AUTHORIZED, COMPLETED, CANCELLED, FAILED, EXPIRED) | enum | One attempt's life. |
| `ChannelConnection.authMode` | column, NOT NULL DEFAULT 'MANUAL' | |
| `ChannelConnection.metaOAuthSessionId` | column, FK SET NULL | The attempt it was last connected through. |
| `ChannelConnection.metaUserId` | column | Who authorised it (app-scoped Facebook id). Meta's revocation callbacks name it. |
| `ChannelConnection.grantedScopes`, `pageTasks` | text[] DEFAULT '{}' | What Meta reported at connect time. |
| `MetaOAuthSession` | table, project-owned | One "Connect with Facebook" attempt. |
| `MetaDataDeletionRequest` | table, platform-level (no project) | Meta's data-deletion requests: confirmation code, a SHA-256 of the user id, counts. |
| `ChannelConnection_platform_account_key` | partial UNIQUE index on (`type`, `externalAccountId`) WHERE `authMode` = 'PLATFORM' AND `status` <> 'DISCONNECTED' | One live one-click connection per Meta account across the **whole installation**. This is what makes routing by account id unambiguous. |

## `MetaOAuthSession` columns, and what is never stored

- **Hashes only:** `stateHash` (unique), `browserBindingHash`, `claimHash` (unique). The raw values
  exist only in Meta's redirect, the browser's cookie and the claim URL.
- **The user token:** `userTokenCiphertext`, an `encryptSecret` envelope. It is set when Meta answers
  and wiped (NULL) when the attempt ends: completed, cancelled, failed or expired. The worker expires
  abandoned attempts every 5 minutes.
- **Who and where:** `userId` (who pressed the button), `returnOrigin` and `returnPath` (where to send
  them back), `connectionId` (reconnect target), `metaUserId` and `metaUserName`, and the
  granted/declined scopes. `failureReason` holds plain words, never Meta's raw text.

## Tenant integrity (Phase 7 rules)

- `MetaOAuthSession` is in `PROJECT_SCOPED_MODELS`, so web and worker reads and writes are confined
  to the project. Its `projectId` defaults to `project_id_required()`.
- `MetaOAuthSession_projectId_immutable`: a session cannot move project.
- `ChannelConnection_metaOAuthSessionId_same_project`: a connection can only point at a session of
  its own project (`projectIntegrity.integration.test.ts` checks the catalogue).
- `MetaDataDeletionRequest` has no `projectId` by design. It is about a Facebook user, not a project,
  and holds no personal data beyond a hash.
- Raw SQL: none was added.

## Manual → one-click

When a person picks an account that is connected manually in the same project (`MANUAL_HERE`), the
**same row** is updated:

- `authMode` becomes PLATFORM;
- the token is replaced;
- the app secret and verify token are cleared;
- a new `webhookKey` is issued, so the old per-connection URL stops being accepted.

Its id, conversations and messages are untouched. Entering manual credentials on a one-click
connection does the reverse (MANUAL, with the Meta fields cleared).

## Deploy

```bash
docker compose build app worker migrate
docker compose run --rm migrate
docker compose up -d --no-deps --force-recreate app worker
```

The migration takes ordinary DDL locks:

- `ALTER TABLE "ChannelConnection" ADD COLUMN` with constant defaults is metadata-only on
  PostgreSQL 16.
- The partial index is built over `ChannelConnection`, which holds a handful of rows.

The undeployed `20261024120000_client_recorded_expiry` (Smart Import) is ordered before this one and
deploys with it.

## Rollback

- **Behaviour:** set `META_INTEGRATION_ENABLED=` (empty) and restart `app` and `worker`.
  - The buttons, the platform webhook (404) and the callbacks stop.
  - Existing one-click connections stop being able to send: no secret means no `appsecret_proof`.
  - Their conversations stay readable.
  - Manual connections are unaffected.
- **Schema:** possible while no PLATFORM row and no session exists:

  ```sql
  DROP INDEX "ChannelConnection_platform_account_key";
  ALTER TABLE "ChannelConnection" DROP CONSTRAINT "ChannelConnection_metaOAuthSessionId_fkey";
  DROP TRIGGER "ChannelConnection_metaOAuthSessionId_same_project" ON "ChannelConnection";
  ALTER TABLE "ChannelConnection" DROP COLUMN "authMode", DROP COLUMN "metaOAuthSessionId", DROP COLUMN "metaUserId", DROP COLUMN "grantedScopes", DROP COLUMN "pageTasks";
  DROP TABLE "MetaOAuthSession"; DROP TABLE "MetaDataDeletionRequest";
  DROP TYPE "ChannelAuthMode"; DROP TYPE "MetaOAuthPurpose"; DROP TYPE "MetaOAuthStatus";
  DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025090000_meta_platform_oauth';
  ```

  Once customers have connected with Facebook, roll **forward** instead. Those rows carry
  conversations.
