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

- **First run not yet observed.** The workflow was written and its YAML parsed locally; it has not run on GitHub.
  Whatever the first run reports is recorded in `18-progress-and-decisions.md`, failing tests included. No test is
  skipped or removed to make it green.
- `next build` may need build-time env the Dockerfile does not set either; if it fails, the fix goes in the
  workflow `env`, never by weakening a check.
- No E2E (Playwright) yet — P1-10.
- `packages/db` has no test suite (unchanged).
- Required status checks on `rudra`/`main` are a GitHub repository setting, not code — Rudra enables them once the
  first runs are green.

## 3. Branch rule

CI never deploys and never merges. Merging to `main` stays Rudra's manual step.
