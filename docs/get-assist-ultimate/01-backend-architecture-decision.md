# 01 — Backend architecture decision (Node.js vs ASP.NET Core)

**Status:** recommendation, pending measurements (§3) and Rudra's decision. Nothing here has been implemented.

## 1. Current topology

```
Browser ──HTTPS──> Caddy (host) ──> app  (Next.js 16, server actions, polling UI)
                                     │
                                     ▼
                                 PostgreSQL 16  <── the only coordination channel
                                     ▲
                                     │
                                  worker (one Node 22 process)
                                   ├─ N × OpenWA / Chromium sessions (one per WhatsApp account)
                                   ├─ 38 interval loops (queues, recovery, AI, learning, channels, billing…)
                                   └─ loopback /health, /metrics
```

## 2. Where the real constraints are

From the audit (`00` §5), the binding constraints are **not** the language runtime:

1. **Chromium memory per WhatsApp account.** Each linked number is a full browser. This dominates RAM on the VPS and
   is identical whatever language the business API is written in.
2. **One worker owns every session.** Queue claims assume a single worker; group-sync state is in memory; an uncaught
   exception restarts every session. Scaling beyond one box needs *session sharding with single ownership*, which
   is a design problem in the worker, not a runtime choice.
3. **Polling.** ~18 pages `router.refresh()` every 4 s; each refresh re-runs server components and their queries.
   Under many concurrent agents this is the likely first database pressure point.
4. **Reporting queries** read raw `Message` rows live (by design — no pre-aggregation). The 92-day cap bounds them,
   but heavy months on large rosters are the second likely pressure point.
5. **No CI / no load tests / no telemetry**, so none of the above is measured yet.

None of these is solved by adding ASP.NET Core. Points 3 and 4 are solved by realtime push and query/index work;
point 2 by a lease-based session ownership model; point 5 by tooling.

## 3. Measurements still required (no numbers are claimed here)

Collected by the read-only procedure in `15-performance-benchmarks.md`:

| Metric | Source |
|---|---|
| Chromium RSS per account, worker RSS, event-loop delay | `docker stats`, worker `/metrics` (`getProcessStats`), `perf_hooks.monitorEventLoopDelay` (needs a small additive metric) |
| Postgres connections, slow queries, table sizes | `pg_stat_activity`, `pg_stat_statements` (if enabled), `pg_total_relation_size` |
| Queue delay (outbound, commands, notifications) | `createdAt → sentAt/startedAt` from existing rows |
| Inbound latency | `Message.timestampWa → createdAt` from existing rows |
| API latency of top pages | Caddy access log, or a small timing wrapper (additive) |
| Recovery time after restart | `CollectionGap` rows (already recorded) |

## 4. Options

| | A. Optimise current stack | B. Hybrid Node + ASP.NET Core | C. Full .NET migration |
|---|---|---|---|
| Solves Chromium memory | No (nothing does — only fewer/sharded sessions) | No | No — OpenWA is Node-only, so the worker stays Node anyway |
| Solves single-worker ownership | Yes, with leases (§6) | Same work still needed in the Node worker | Same |
| Realtime | SSE route in Next, or a small Node SSE hub | SignalR | SignalR |
| New domains (commerce, CRM, workflow, public API) | In the existing scoped-Prisma + server-action pattern | In a .NET service — **but** project isolation (scoped client, 96 triggers, raw-SQL test), permissions (`resolveRoleKeys`, page roles, access levels), tenancy (`customerId`), branding and audit logging would have to be **re-implemented in C# and kept in lockstep** | Everything re-implemented |
| Type-sharing | One TypeScript `packages/shared` used by web + worker | TS ⇄ C# contracts via OpenAPI; drift risk | Single language again, after a rewrite |
| Team skills / ops | Current | Two runtimes, two build chains, two test stacks, two deploy units on a small VPS | New stack |
| Risk to production | Lowest | Medium–high (two writers to one DB) | Highest |

## 5. Decision matrix (weights from the prompt's priority list)

Scored 1–5, higher is better.

| Criterion (weight) | A | B | C |
|---|---|---|---|
| Production stability (5) | 5 | 3 | 1 |
| Feature preservation (5) | 5 | 3 | 1 |
| Tenant isolation integrity (5) | 5 | 2 | 3 |
| Performance headroom (3) | 3 | 4 | 4 |
| Maintainability (3) | 4 | 2 | 3 |
| Operating cost on current VPS (2) | 5 | 2 | 3 |
| Extensibility (2) | 4 | 4 | 4 |
| **Weighted total** (max 125) | **114** | **70** | **60** |

The scores are judgement, not measurement; the gap is large enough that reasonable re-weighting does not change the
order.

## 6. Recommendation

**Option A now; keep B as a documented, evidence-gated option for one capability later.**

Revisit ASP.NET Core only if, after A's improvements, a measured requirement is unmet — e.g. a public API whose p95
cannot be held under a target with Node, or a reporting workload that saturates Node CPU while Postgres is idle. If
that happens, introduce it via Strangler Fig for exactly one capability that owns its own tables (the public API
gateway is the best candidate: read-mostly, versioned contracts, no shared aggregates).

Incremental sequence for A (each is its own work package, see `16`):

1. **CI** running typecheck, lint, unit tests and the isolated integration suites on every push.
2. **Observability**: pino structured logs with correlation ids carried from inbound message → outbound row →
   notification; Prometheus text on the existing `/metrics`; event-loop delay metric; liveness for the untracked
   loops; clear billing's stray timer.
3. **Realtime**: one SSE endpoint per project in Next.js, fed by Postgres `LISTEN/NOTIFY` (triggers on the
   tables the inbox already polls). Postgres stays the source of truth; SSE only says "something changed since
   cursor X" and the client re-reads. Polling remains the fallback.
4. **Queue claims with `FOR UPDATE SKIP LOCKED`** — removes the single-worker assumption from the queues first,
   without touching sessions.
5. **Session ownership leases** (`WhatsAppAccount.ownerWorkerId` + `leaseExpiresAt`, renewed by heartbeat) so a
   second worker host can own a disjoint set of accounts. Only after 4, and only when one VPS's RAM is the limit.
6. **Split heavy non-session loops** (learning, knowledge, Forge, reports precompute if ever needed) into a second
   Node process that holds no browser, so an AI or learning job can never stall WhatsApp.

## 7. Scale model (to be filled with measured numbers)

| Load | Deployment |
|---|---|
| Current + 10 workspaces | One VPS, current compose. RAM sized as `base + accounts × measured Chromium RSS`. |
| 50 workspaces | Step 6 (non-session worker split) + bigger VPS or managed Postgres. |
| 100+ workspaces | Steps 4–5: several session hosts, each owning leased accounts; web horizontally behind Caddy; Postgres on its own host with PgBouncer. |

Hundreds of Chromium sessions on the current small VPS is **not** a supported configuration and will not be
presented as one.

## 8. Rollback

Every step in §6 is additive and flag- or env-guarded: SSE falls back to polling; `SKIP LOCKED` claims are a
query change with identical single-worker behaviour; leases default to "this worker owns everything" when only
one worker exists.
