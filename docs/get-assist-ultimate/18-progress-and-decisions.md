# 18 — Progress and decisions log

Newest first. A decision is recorded only when it was made, with who made it.

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
