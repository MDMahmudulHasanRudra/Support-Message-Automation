# Product Knowledge via Softify Forge

How this support system learns about **ISPDIGITAL** — the product its customers are asking about —
and, just as importantly, what it will never say to them.

## Why this exists

Before this, the assistant could only answer from knowledge someone had typed in or that had been
distilled from past WhatsApp chats. A brand-new deployment knew nothing about the product at all.
Meanwhile the product's own repository holds a 21,000-word Monthly Billing manual, a product
overview, and the source of twenty-two modules.

Softify Forge grants read access to that repository through a REST API, so this system can learn
from it directly.

## Configuration

Two environment variables. Both apps read them; the worker does the work.

```bash
FORGE_API_KEY=sfy_...                                  # from Forge; treat it like a password
FORGE_API_URL=https://forge.softifybd.com/api/v1
```

Then, in the dashboard, open **AI Learning → Product Knowledge**:

1. **Test connection** — confirms the key works and lists the projects it can see.
2. Pick the project to learn from. If the key can see exactly one, the worker selects it on boot;
   with several, an admin chooses, because learning from the wrong product's repository would be
   silent and completely wrong.
3. Turn on **Learn from this product's repository** and choose the tiers below.
4. **Sync now**, or wait for the six-hourly pass.

Nothing happens until both variables are set *and* an admin enables it. An install with no Forge
credentials behaves exactly as it did before this existed.

## The three tiers

They differ in one thing: how much authority the source has.

| Tier | Source | Reaches customers |
|---|---|---|
| 1. User guides | `docs/user-guides/**`, product overviews — documents your team wrote **for customers** | Immediately, if "Publish guide answers without review" is on |
| 2. Module guides | For areas nobody documented, the AI reads the source behind them and writes a user guide | **Only after human review, always** |
| 3. Research | A customer asked something nothing covered; that question is looked up in the code afterwards | **Only after human review, always** |

Tier 1 is authoritative because a person wrote it for this audience. Tiers 2 and 3 are a model's
reading of source code — evidence, not fact — so they land in
`/ai-learning/knowledge-base/review` regardless of any setting. There is no switch that
auto-publishes them, deliberately.

### Tier 3 is the "if the docs don't answer it, read the code" path

When a customer asks something and no verified knowledge covers it, the conversation goes to a
human **immediately** — that is unchanged. The question is *also* queued, researched against the
code in the background, and filed for review, so the next person to ask gets an answer.

It runs after the handoff rather than in front of the customer for three reasons, in increasing
order of importance:

1. Reading source takes several API round trips and many seconds; a customer waiting on WhatsApp
   does not.
2. It would spend a model call on every unanswerable message, including the ones that are not
   really questions.
3. It would put raw source code into the same prompt that drafts a customer-facing reply. That is
   precisely the arrangement the disclosure rule exists to prevent.

Questions are deduplicated by keyword signature, so a thing fifty customers ask is one research
task with `askedCount` at fifty — which is also the order gaps get closed in.

## The disclosure gate

**The customer-facing assistant has no access to the repository. None.** It answers only from
verified knowledge-base entries, exactly as it did before. Everything Forge contributes has already
passed through the gate below and, for code-derived content, a human.

Two layers, because one is not enough:

1. **The prompt** names what must never appear — code, class and file names, tables, columns,
   schema, SQL, endpoints, queues, job names, infrastructure, servers, IPs, ports, connection
   strings, credentials, keys, tokens, exception types, stack traces — and instructs the model to
   restate technical behaviour the way a user experiences it.
2. **`checkKnowledgeSafety()`** (`packages/forge-client/src/knowledgeSafety.ts`) re-checks every
   generated entry mechanically. A prompt is a request; a regex is a guarantee. An entry that trips
   any rule is **dropped and logged, never stored** — not even as an unverified draft, because a
   draft is one careless click from being verified.

The gate is not theoretical. On the first live run against the real manual, two entries were
generated, stored and auto-verified before the rules caught them:

> "The key terms are: **BillPeriod**, which is a calendar month; **MonthlyInvoice**, which is the
> invoice issued for that month; and **CustomerCredit**…"

> "This will create a **CustomerBillMaster** for each customer…"

Both are internal record names, and both came from faithfully summarising a document written *for
customers* — the manual itself introduces them. That is why the `internal-identifier` rule exists,
and why the gate runs over generated output rather than trusting the source. It is tested against
those exact strings.

Balancing that, the gate must not fire on legitimate answers — a check that blocks real support
English gets ignored, and an ignored check protects nothing. Product and vendor names customers
already see (`MikroTik`, `PPPoE`, `bKash`, `BanglaQR`, `WhatsApp`) are allowlisted, and the test
suite pins a corpus of realistic answers that must pass.

## What Forge is *not* used for

Forge also exposes tasks, comments, daily logs and kudos. `packages/forge-client` implements none
of them. A customer-support system that can silently write to the engineering team's board is a
liability, and leaving those methods unwritten is a stronger guarantee than a policy saying not to
call them.

## Measured behaviour

From the first real runs against the live repository:

- 3 hand-written documents → 74 entries, 1:08, 2 blocked by the gate, **0 leaks** on a full re-audit.
- 18 of 22 modules have readable source. Forge's module map had stale paths for 8; a name-based
  fallback over the controller directories recovered 4 of those.
- The 4 that remain unreadable produce **nothing**. That matters: given a module name and no
  source, the model cheerfully invents a plausible guide — "Support & Tickets" produced five
  confident answers from zero bytes. The job skips a module with no sources for exactly this reason.

## Files

```
packages/forge-client/          REST client (read-only) + the disclosure gate
apps/worker/src/forge/
  forgePrompts.ts               the three prompts + module router
  forgeKnowledgeJob.ts          tiers 1 and 2
  forgeResearchJob.ts           tier 3
  forgeProcessor.ts             the two background loops + boot-time project discovery
apps/web/src/app/(dashboard)/integrations/forge/    settings and status
apps/web/src/server/actions/forge.ts                settings, connection test, sync now
```
