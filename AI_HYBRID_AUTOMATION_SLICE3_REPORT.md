# Hybrid AI Automation — Slice 3 Final Report

Production Readiness, Safety Hardening & Intelligent Automation. Builds on Slices 1-2 (uncommitted
in the working tree, verified) without rebuilding, replacing, or duplicating any of it.

## 1. Architecture Audit

Confirmed the repository matches the spec's description almost exactly — Slices 1-2's work is
present and unmodified going in (`AiFallbackDecision`, `EvidenceResponseSource`,
`WhatsAppGroup.aiAutomationEnabled`, `AiSettings.autoResponseConfidenceThreshold`, the Anthropic +
OpenAI-compatible providers, the AI fallback layer, its UI). No material discrepancy required
stopping.

Traced all 12 requested flows directly in code:
1. **Message processing**: `processIncomingMessage.ts` — empty-body drop → direction/loop guard →
   team-member check → group resolution → `Message` insert (P2002 = dedup) → escalation +
   support-activity fire-and-forget hooks → `evaluate()` → AI fallback stage (on `NO_MATCH` only) →
   action execution → `AutomationExecution` persistence → checkpoint upsert.
2. **Rule evaluation**: `packages/engine`'s `evaluate()` — priority-sorted, single-pass, unchanged.
3. **AI fallback**: `apps/worker/src/aiFallback/runAiFallback.ts` — eligibility → (new) cost-avoidance
   pre-check → `resolveAiClient` → parse → confidence gate → safety re-check → enqueue or
   human-fallback.
4. **Outbound queue**: atomic claim (`findFirst` + conditional `updateMany`), idempotency key,
   crash-recovery sweep — unchanged.
5. **Notification**: `enqueueNotification`/dispatcher — unchanged, reused for human fallback.
6. **Team-member detection**: `isActiveTeamMember(phoneNumber)` — exact match against
   `InternalTeamMember.phoneNumber`, unchanged.
7. **Conversation Learning**: segmentation → `patternDetectionJob.ts`'s evidence-linking (now
   `responseSource`-aware) → `PatternCandidate` scoring (untouched) → `RuleProposal`.
8. **Rule Proposal**: `createRuleProposalFromCandidate()`/`approveRuleProposalById()` — always
   DRAFT, unchanged.
9. **AI provider resolution**: `resolveAiClient()` — now branches on `ANTHROPIC`/`OPENAI`, `null` for
   anything else.
10. **Idempotency**: `Message(accountId, whatsappMessageId)` unique (the real dedup point, upstream
    of AI entirely), `AiFallbackDecision.messageId` unique, `OutboundMessage.idempotencyKey` unique
    — all pre-existing, now proven end-to-end by a new test.
11. **Cooldown/rate limits**: per-rule cooldown existed; **AI replies had no cooldown at all** — the
    one real gap this slice fixes.
12. **Group monitoring**: `isMonitored`/`aiAutomationEnabled` — unchanged, now joined by
    `aiSuppressedUntil` for human takeover.

## 2. Changes Implemented

**Schema** (`packages/db/prisma/schema.prisma`, migration
`20260819061943_ai_hybrid_automation_slice3_hardening`):
- `AiSettings.aiReplyCooldownSeconds Int @default(300)`
- `AiSettings.humanTakeoverCooldownMinutes Int @default(30)`
- `WhatsAppGroup.aiSuppressedUntil DateTime?`

**AI reply cooldown** (Phase 2 gap): `apps/worker/src/queue/cooldown.ts`'s `isCooldownActive()`
generalized to accept `ruleId: string | null` plus an explicit `actionType: "AUTO_REPLY"` filter;
`apps/worker/src/pipeline/safety.ts`'s cooldown guard now runs for a null rule too
(`ruleId: rule?.id ?? null`); `runAiFallback.ts` passes `aiSettings.aiReplyCooldownSeconds` and gained
a new pre-AI-call safety check (avoids spending a real API call when cooldown is already active),
alongside the existing post-call check.

**Human takeover** (Phase 3 gap, new mechanism): `apps/worker/src/aiFallback/humanTakeover.ts` (new)
— `recordHumanTakeover(groupId)`, called from `processIncomingMessage.ts`'s existing
`isFromTeamMember` branch (alongside, not replacing, `markHumanReplied()`) when the group has AI
enabled. `eligibility.ts` gained `aiSuppressedUntil`/`now` and a new silent gate.

**Provider timeout** (Phase 8 gap): `AnthropicClient.ts` (`timeout: 30_000, maxRetries: 0`) and
`OpenAiCompatibleClient.ts` (`AbortController` + `setTimeout`, clear message on abort).

**Observability** (Phase 12): one new `logSystemEvent("ERROR", "ai-fallback", ...)` call in
`processIncomingMessage.ts`'s AI-fallback catch block, for the one case (a true unexpected
exception) with no other structured trace.

**UI**: AI Settings gained the two new cooldown fields; Groups gained a "Human active until…" badge;
Message detail's Learning section now shows the resulting rule's actual status (DRAFT/ACTIVE),
answering "did this become a live deterministic rule."

## 3. Existing Functionality Reused

`checkAutoReplySafety()` (kill switch, mode, monitored-group check, rate limits, and now cooldown)
— the exact same function, generalized once, not duplicated. `isCooldownActive()` — same table
(`OutboundMessage`), same idempotency-key convention. `logSystemEvent()` — same convention
`patternDetectionJob.ts`/`aiAnalysisJob.ts` already use. `MockAiClient`, the isolated `postgres-test`
workflow, the `Card`/`Badge`/`Field`/`SwitchField` UI kit — all unchanged, all reused. No second
cooldown system, no second state machine, no second provider abstraction, no second message table.

## 4. Safety Improvements

- **Idempotency**: proven end-to-end (not just at the `packages/db` helper level) that a redelivered
  WhatsApp event never reaches AI fallback a second time — `Message`'s own dedup constraint is
  upstream of everything.
- **Cooldown**: AI replies now respect the same cooldown discipline as rule-based replies; a
  cost-avoidance pre-check skips the AI call entirely when cooldown is already active.
- **Human takeover**: a team member's message pauses the AI fallback layer for that group for a
  configurable window — silent, zero side effects, deterministic rules/escalation unaffected.
- **Provider security/timeout**: request timeout + zero retries bounds worst-case pipeline-blocking
  time to 30s (was unbounded); confirmed no credential ever reaches a thrown error, a log line, or
  the browser (existing discipline, now also covering the new timeout paths).
- **Confidence fail-closed**: verified at exact boundaries (100, 90, 89, 0, missing) — confidence
  below threshold, malformed, or absent always resolves to `HUMAN_FALLBACK`, never treated as high
  confidence.
- **Failure recovery**: AI unavailable/error/malformed/timeout all fail into `HUMAN_FALLBACK`, never
  an unhandled exception; the one true exception path now also gets a structured `SystemLog` entry.

## 5. Learning Loop

`processIncomingMessage.ts` → `evaluate()` returns `NO_MATCH` → `runAiFallback()` records an
`AiFallbackDecision` (AI_REPLIED or HUMAN_FALLBACK) → later, `patternDetectionJob.ts`'s
evidence-linking looks up that decision by `messageId` and tags the resulting
`PatternCandidateEvidence.responseSource` (`AI`/`HUMAN`/`EXISTING_RULE`/`UNRESOLVED`), also marking
`wasResolved` for an AI-answered message → `PatternCandidate`'s existing, untouched scoring formula
(`packages/engine`) accumulates confidence from real evidence → once the configured
occurrence/group/client floor and confidence threshold clear, `createRuleProposalFromCandidate()`
creates a `RuleProposal` (using the AI's own response text as the suggested reply, when no
human-authored one exists) → `approveRuleProposalById()` creates the resulting `AutomationRule` as
**DRAFT**, always, only via an explicit human action (or the pre-existing, still off-by-default
`autoApprovalEnabled` policy) → a human separately activates it on the Rules page → from then on,
`evaluate()` matches it directly and AI is never invoked for that pattern again. Nothing in this
chain was modified this slice — Slice 2 already built and tested it; this slice only proved the
`responseSource` link end to end at the exact boundaries the spec named.

## 6. Cost Reduction

Proven by Slice 2's existing `aiToRuleCostReduction.integration.test.ts` (re-verified green this
slice, twice): two AI-handled occurrences across distinct groups/clients → evidence clears the
floor → `RuleProposal` → approved (DRAFT) → a matching message during the DRAFT window **still**
reaches AI (`preActivationClient.requests` = 1, proving DRAFT truly never fires) → activated → the
same pattern now matches the rule and a fresh `MockAiClient` records **zero** requests
(`postActivationClient.requests` = 0). This slice's new cooldown/human-takeover tests add further,
narrower proof that AI calls are avoided (not just replies suppressed) whenever a cheap pre-check
already knows the answer will be blocked.

## 7. Tests

- **New this slice**: 13 tests — 5 confidence-boundary (100/90/89/0/missing), 3 AI-cooldown
  (blocks-same-client, doesn't-block-different-client, disabled-at-zero), 2 human-takeover
  (suppresses-same-group, doesn't-suppress-different-group), 1 full-pipeline duplicate-delivery
  idempotency, 2 pure eligibility unit tests (suppressed/elapsed) — all in
  `aiFallback.integration.test.ts`. Plus 1 provider-timeout unit test
  (`packages/ai-client/src/__tests__/OpenAiCompatibleClient.test.ts`, fake timers, 23ms wall-clock).
- **`apps/worker`**: **166/166 passed** (17 files), run twice back-to-back — both clean, no flakes.
- **`packages/engine`**: **74/74 passed**, unchanged (nothing here was touched).
- **`packages/ai-client`**: **6/6 passed** (5 from Slice 2 + 1 new timeout test).
- **Typecheck**: all 6 packages/apps clean.
- **Build**: full workspace build (including `apps/web`'s 46-route Next.js production build) clean.

## 8. Database

**Migration required and generated**: `20260819061943_ai_hybrid_automation_slice3_hardening` — two
new `AiSettings` columns, one new nullable `WhatsAppGroup` column. Purely additive; no existing
column renamed, retyped, or dropped; no existing enum value changed. Verified by
`prisma migrate deploy` against a fresh isolated `postgres-test` instance (all 22 migrations applied
cleanly, including this one) — **the live/production database was never touched, and
`pnpm db:migrate:deploy` was never run against it.** The command to run later, once you're ready:
```
pnpm db:migrate:deploy
```
(against whichever `DATABASE_URL` actually points at the live database — not run by me.)

## 9. Security

No new secret-handling surface: the two AI provider clients' credential discipline is unchanged
(server-side only, encrypted at rest, never logged, never in a thrown error, never returned to the
browser) — the new timeout logic in both clients only touches request *timing*, not credentials.
`AbortController`'s abort path is caught and re-thrown with a generic "timed out" message, never
exposing internal fetch/SDK error details that could otherwise leak header content. `humanTakeover.ts`
and the cooldown generalization touch no credential path at all — pure scheduling/state logic.

## 10. Known Limitations

- **No live browser click-through of the new UI** (same honest caveat as Slice 2's report) — the two
  new AI Settings fields, the Groups "Human active" badge, and the message-detail rule-status line
  were verified by a clean build/typecheck and by following existing, already-proven component
  patterns exactly, not by rendering them in a browser. Happy to set up a seeded isolated-DB browser
  check if you want that before considering the UI side fully verified.
- **Human takeover is per-group, not per-individual-customer** within a busy multi-customer group —
  a deliberate, stated design choice (see plan/§2), not an oversight. A future slice could add finer
  attribution (e.g. via quoted-reply/mention signals) if real usage shows this granularity is too
  coarse.
- **The cost-avoidance pre-check duplicates one function call** (`checkAutoReplySafety` now runs up
  to twice per AI-eligible message) — cheap (a few indexed queries), but worth knowing it's not
  free; done deliberately to avoid spending a real, paid AI request when cooldown already guarantees
  the reply would be blocked.
- **`resolveAiClient()`'s pre-existing quirk** (an OpenAI-compatible `RESPONSE`-job provider also
  needs `AiSettings.learningEnabled` on, not just `aiEngineEnabled`) still applies — inherited from
  Slice 1, not something this slice changed or was asked to fix.

## 11. Deferred Work

Exactly what the spec named as deferred and nothing more: `GOOGLE`/`CUSTOM` `AiProviderKind` client
implementations remain unbuilt (no safe, concrete request/response shape exists for either without
new, untested work); autonomous production-rule activation beyond the existing, still-off-by-default
`autoApprovalEnabled` policy; any form of AI-initiated command execution, direct WhatsApp access, or
browser-exposed credentials — none of these were built, and none should be.

## 12. Git Status

Modified: `apps/web/src/app/(dashboard)/ai-learning/page.tsx`, `.../providers/AiProviderForm.tsx`,
`.../settings/AiSettingsForm.tsx`, `.../settings/page.tsx`, `.../groups/GroupsTable.tsx`,
`.../groups/page.tsx`, `.../messages/[id]/page.tsx`, `apps/web/src/server/actions/aiProviders.ts`,
`.../aiSettings.ts`, `.../groups.ts`, `apps/worker/src/__tests__/aiFallback.integration.test.ts`,
`.../patternDetectionJob.integration.test.ts`, `apps/worker/src/aiFallback/eligibility.ts`,
`.../runAiFallback.ts`, `apps/worker/src/learning/patternDetectionJob.ts`,
`apps/worker/src/pipeline/processIncomingMessage.ts`, `.../safety.ts`, `.../queue/cooldown.ts`,
`packages/ai-client/src/AnthropicClient.ts`, `.../index.ts`, `.../resolveAiClient.ts`,
`packages/db/prisma/schema.prisma`.

New: `apps/worker/src/__tests__/aiToRuleCostReduction.integration.test.ts` (Slice 2),
`.../resolveAiClient.integration.test.ts` (Slice 2), `apps/worker/src/aiFallback/humanTakeover.ts`,
`packages/ai-client/src/OpenAiCompatibleClient.ts` (Slice 2), `.../src/__tests__/` (Slice 2),
`packages/db/prisma/migrations/20260819061943_ai_hybrid_automation_slice3_hardening/`,
`AI_HYBRID_AUTOMATION_SLICE2_REPORT.md`.

**No commit was created this round** — committing wasn't requested. `HEAD` remains `1bd59f2`
(Slice 1's own commit); Slices 2 and 3 both sit uncommitted in the working tree. Let me know if
you'd like this committed now, and with what message.
