# 13 — Test and quality plan

## 1. CI (P1-1) — `.github/workflows/ci.yml`

Runs on every push and pull request to GitHub. It **checks only**: no deploy step, no secrets, no production
database. `permissions: contents: read`.

| Job | Needs | What it runs | Database |
|---|---|---|---|
| `fast` | — | install (frozen lockfile, pnpm cache) → `db:generate` → `build:packages` → `typecheck` → `lint` → unit tests of every package, then web and worker with `*.integration.test.ts` excluded; JUnit artifact | none (a dummy URL that points nowhere) |
| `build` | fast | `build:packages` → worker `tsc` build → web `next build` | none |
| `integration` | fast | throwaway `postgres:16-alpine` service on `localhost:5433` (same credentials as `docker-compose.test.yml`) → `db:migrate:deploy` on the empty DB → `prisma migrate status` → web `test:isolated` → worker `test:isolated` (each runs even if the other failed); JUnit artifact | the service container, destroyed with the job |

Safety rails that already exist and CI relies on:
- Integration files import `helpers/requireTestDatabase.ts`, which refuses any non-local database host.
- Both vitest configs set `fileParallelism: false`.
- `test:isolated` bounds the Prisma pool and sets a test-only encryption key.

Migration verification is "every migration applies cleanly from zero, and none is left pending or failed". A
schema-drift diff (`prisma migrate diff --exit-code`) is deliberately **not** a gate: the database intentionally
keeps the removed Teams tables and Postgres objects Prisma does not model (partial indexes, the 96 integrity
triggers), so the diff is never empty by design.

## 2. Known gaps (not hidden)

- **CI runs on GitHub and is green** (checked 5 Nov 2026, run #52 on `05da3e1`: all three jobs passed). Run
  history and the open items are in `18-progress-and-decisions.md`. No test is skipped or removed to make it green.
- One failure on `main` (run #38, integration job, 31 Oct) is unexplained. The same commit passed on its branch
  (#37), and every later `main` run passed. Logs need a signed-in viewer; until someone reads them it is treated
  as a possible flaky test.
- Actions moved off the deprecated Node 20 runtime on 5 Nov (`checkout`, `setup-node`, `upload-artifact` → v7,
  `pnpm/action-setup` → v5). Not yet confirmed by a run on GitHub. `ubuntu-latest` moved to Ubuntu 26 from 19 Oct.
- `next build` may need build-time env the Dockerfile does not set either; if it fails, the fix goes in the
  workflow `env`, never by weakening a check.
- No E2E (Playwright) yet — P1-10.
- `packages/db` has no test suite (unchanged).
- Required status checks on `rudra`/`main` are a GitHub repository setting, not code. Runs are green, so Rudra can
  enable them now. Whether they are on could not be checked: the setting is visible only to a repository admin.

## 3. Branch rule

CI never deploys and never merges. Merging to `main` stays Rudra's manual step.
