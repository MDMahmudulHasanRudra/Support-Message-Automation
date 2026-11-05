# 18 — Progress and decisions log

Newest first. A decision is recorded only when it was made, with who made it.

## 5 Nov 2026 — P1-1 CI: actions moved to Node 24

`.github/workflows/ci.yml`: only the `uses:` versions changed. No step, input, trigger or permission changed.

| Action | Was | Now | Why this version |
|---|---|---|---|
| `actions/checkout` | v4 | v7 | Node 24 from v5. v6 keeps the credential in a separate file; v7 is ESM and refuses fork checkouts for `pull_request_target` / `workflow_run`, which this workflow does not use. |
| `actions/setup-node` | v4 | v7 | v6 limits *automatic* caching to npm; this workflow sets `cache: pnpm` explicitly. v7 drops a dummy `NODE_AUTH_TOKEN`; nothing here publishes. |
| `actions/upload-artifact` | v4 | v7 | v5 still defaulted to Node 20; Node 24 from v6. v7 adds opt-in unzipped uploads (`archive: false`); the default is unchanged. |
| `pnpm/action-setup` | v4 | v5 | v5's only change is Node 24. v6 adds a pnpm 11 bootstrap and self-update (ten fix releases since April). It is a separate step, not taken here. |

Every major tag was confirmed with `git ls-remote`. Not yet run on GitHub: the next push is the test. If it fails,
revert this one file. The `git` exit 128 warning is unrelated to these versions as far as is known, and it may stay.

Read from the public Actions page (the API was rate-limited, and logs need sign-in, so no log was read):

- 52 runs of `CI` since 29 Oct. The first ~15 (29–30 Oct, `rudra`) failed while the workflow was being fixed.
  **Green since 30 Oct 15:02 UTC** on `rudra` and `main`, except one `main` failure (below).
- Latest: run #52 on `05da3e1` (`feature/project-delete`): typecheck/lint/unit 2m 40s, build 2m 26s,
  migrations + integration 8m 22s. All passed. JUnit results uploaded as artifacts (unit 955 KB, integration 287 KB).
- **Run #38** (`main`, merge of PR #38, 31 Oct): integration job exited 1. The same commit passed on
  `hotfix/worker-strip-types` (#37), and `main` passed afterwards (#44, #51). Cause unknown until someone signed in
  reads the log. Treated as a possible flaky test, not as resolved.
- `feature/smart-import-v5` had two failed runs on 31 Oct before going green. Normal branch work.
- Warnings on every job: the actions run on the deprecated Node 20 runtime (`checkout`, `setup-node`,
  `upload-artifact`, `pnpm/action-setup`, all `@v4`), and `/usr/bin/git` exits 128 in a step that does not fail the
  job. `ubuntu-latest` is migrating to Ubuntu 26 (from 19 Oct).
- Coverage check from source: the worker's `test:isolated` sets the throwaway encryption key; the web suites that
  need one set their own (`??= randomBytes(32)`). Only the three benchmark files are `skipIf`-gated, by design.
- Not verified: whether required status checks are on for `rudra`/`main` (repository admin setting).

## 5 Nov 2026 — Audit update for the 4 vCPU / 16 GB server

- Added `00b-audit-update-2026-11-05.md` (documentation only).
- The new blueprint and execution prompt restate this programme. Ten of their fifteen "new" modules already exist
  in code. Only Automation Studio, Customer Portal and a public Help Center are missing.
- Release 1 is unchanged since 29 Oct except MFA (done). No backup, headers, per-IP limits, structured logs,
  `SKIP LOCKED` claims or Playwright yet. The CI first run is still unverified.
- New: Postgres runs on stock memory settings; no container memory limits; three background processors now run in
  the web process.
- No decision was made. The top 10 in `00b` §7 is a recommendation.

## 29 Oct 2026 — P1-1 CI pipeline

- Added `.github/workflows/ci.yml` (fast / build / integration jobs, see `13`).
- `build:packages` no longer builds the removed `teams-client` (it had no source, so the script failed); it now
  builds forge-client and media-storage like the Dockerfiles do.
- `.gitattributes` keeps `*.sh` LF in Windows checkouts (the baseline script is copied to Linux).
- `.gitignore`: `test-results/`.
- Not yet run on GitHub; first-run results to be recorded here.

## 29 Oct 2026 — Owner decisions on Phase 0

Rudra approved Option A, conditionally approved the baseline script (review first, explicit go-ahead before any
production run), ruled that `noorvip.getassist.pro` is a customer workspace and not the canonical host, set Phase 1
to start with CI plus backup and security, and approved committing Phase 0 to `rudra`. Full text in
`16-implementation-roadmap.md` § Decisions.

The baseline script was hardened before commit (statement/lock timeouts, index-friendly UTC ranges, bounded docker
calls, `--sql-only` mode). Its isolated-DB validation was **not** run: Rudra asked that containers are not started
by the agent; he runs it (see `15` §2.1).

## 29 Oct 2026 — Phase 0 delivered (documentation only)

- Added: `00-current-system-audit.md`, `01-backend-architecture-decision.md`, `02-ui-ux-design-system.md`,
  `05-data-model-and-migrations.md`, `15-performance-benchmarks.md`, `16-implementation-roadmap.md`, this file,
  and `scripts/baseline-readonly.sh` (not run).
- No application code, schema, configuration or production system was changed.
- The master prompt arrived truncated at §26 ("First execution instructions"); anything after "2. Verify what is a…"
  was not received.
- **Recommended, not decided:** Option A (optimise the Node stack); ASP.NET Core deferred until a measured,
  unmet requirement exists.
- Documents 03, 04, 06–14 and 17 are produced at the start of the phase that needs them, so they describe what is
  being built rather than guesses made months earlier.
