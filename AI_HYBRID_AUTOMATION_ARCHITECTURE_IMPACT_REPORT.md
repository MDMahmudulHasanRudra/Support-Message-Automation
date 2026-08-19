# AI Hybrid Automation — Architecture Impact Report

Produced per `AI Hybrid Automation.md` section 37, before any code was written. This report is
based on a full read of `ENGINEERING_STANDARDS.md`, `ARCHITECTURE.md`, `PROJECT_REFERENCE.md`,
`packages/db/prisma/schema.prisma` (in full), and five targeted audits of the AI client, rule
engine/pipeline, Conversation Learning, outbound/notification/escalation infrastructure, and
existing test conventions.

---

## 1. Current AI architecture

Two independent, deliberately unconnected AI surfaces exist today:

- **`packages/ai-client`** — thin, text-only completion wrapper. `AiClient.complete(request):
  Promise<AiCompletionResult>` is the entire interface (`{systemPrompt?, userPrompt, maxTokens?,
  temperature?}` → `{text, tokensUsed, providerId, modelId}`). No tool-use, no JSON mode, no
  retry/backoff — a thrown SDK error just propagates. `AnthropicClient` is the only
  implementation. `resolveAiClient(job: AiModelJob): Promise<AiClient | null>` is the sole factory:
  gates on `AiSettings.aiEngineEnabled && learningEnabled`, looks up `AiModelConfig` by `job`,
  decrypts the provider's key, returns `null` (never throws) for any gating failure. Its only
  current caller is the worker's Conversation Learning `aiAnalysisJob.ts`.
- **AI Admin Assistant** (`apps/web/src/server/aiAdmin/`) — a separate, deliberately
  not-`ai-client`-based, read-only tool-calling chatbot. Talks to the Anthropic SDK directly via
  `resolveAiAdminClient()` (gated only on `aiEngineEnabled`, using the `AiModelJob.ADMIN_ASSISTANT`
  slot). Fully out of scope for this feature — untouched.

**Encryption**: `encryptSecret`/`decryptSecret` live in `packages/db/src/index.ts` (no relative
imports rule), AES-256-GCM, key from `AI_CREDENTIALS_ENCRYPTION_KEY` env var. "Test Connection" is
server-only (`testAiProviderConnection`), never returns the plaintext key to the browser.

**Already-built, currently-inert pieces this feature will activate**:
- `AiModelJob.RESPONSE` — a model-config job slot that has existed since the schema's Phase 1,
  with the doc comment "reserved for a future customer-facing auto-response phase." **This is that
  phase.** No enum change needed — just a new `resolveAiClient("RESPONSE")` call site.
- `AiSettings.autoResponseEnabled` — a boolean toggle that exists today and is explicitly
  documented as inert ("all currently inert except AI Engine gating the Admin Assistant"). This
  becomes the feature's actual enable switch.
- `AiSettings` also already has `learningConfidenceThreshold` (default 90) and
  `autoApprovalThreshold` (default 95) — close in spirit to what section 5 wants, but both are
  ambiguously scoped to the not-yet-built AI Learning/Knowledge phases, not to a live auto-reply
  decision. Recommendation (see §7) is one small new field rather than overloading these.

## 2. Current rule engine architecture

`packages/engine`'s `evaluate(context: EvaluationContext): EvaluationResult` is pure, side-effect
free, imported by both apps. It sorts active rules by `priority` descending, returns the first
match, and always returns a full `DecisionTraceEntry[]`. Three possible outcomes matter here:

- A rule matches → `finalDecision` is one of `IGNORE/AUTO_REPLY/SUPPORT_REQUIRED/STOPPED/ACTIONED`.
- No rule matches but sender `isFromTeamMember` → synthetic `system:team-member-filter` decision,
  `finalDecision: "IGNORE"`. **AI must never fire here** — this is a team member's own message.
- No rule matches and sender is not a team member → synthetic `system:no-match` decision,
  `finalDecision: "NO_MATCH"`, `matchedRule: null`. **This is the exact, only hook point for AI
  fallback** — a real, deterministic rule-miss on a genuine customer message.

`processIncomingMessage.ts` calls `evaluate()` once (~line 171-188), then dispatches
`result.actions` through a plain `switch` in `executeAction()`. The kill switch
(`AutomationSettings.automationEnabled`) and automation mode (`MANUAL_ONLY`/`SAFE_AUTO_REPLY`/
`FULL_RULE_AUTOMATION`) are enforced today **only** inside `checkAutoReplySafety()`
(`pipeline/safety.ts`), called from the `AUTO_REPLY` action case — not from a pre-check before
`evaluate()` runs, and not from `NOTIFY_TEAMS`/`SUPPORT_REQUIRED`/etc. Because `SAFE_AUTO_REPLY`
mode's eligibility check is keyed on `rule.type` (only `AUTO_REPLY`/`SUPPORT_ESCALATION` rule types
may fire), and an AI decision has no `AutomationRule` row at all, this function needs a small,
additive generalization (see §5) — not a duplicate safety path.

## 3. Current Conversation Learning architecture

Three independently-gated background jobs, all reused as-is:

1. **Session segmentation** (`sessionSegmentation.ts`, 5 min) — buckets `Message` rows
   (`direction: INCOMING` only, globally, no per-account filter — by design) into
   `ConversationSession` by chat + inactivity gap (`LearningSettings.sessionGapMinutes`).
2. **Pattern detection** (`patternDetectionJob.ts`, 15 min, AI-free) — for each closed session,
   derives a deterministic `patternKey` from the first customer message
   (`derivePatternSignature()` in `packages/engine`, already exported: normalize → tokenize → drop
   stopwords → top-5 by length → alphabetical join), upserts a `PatternCandidate` by that key
   (idempotent via `@unique`), and links a `PatternCandidateEvidence` row per session (idempotent
   via `@@unique([patternCandidateId, conversationSessionId])`). `unhandledCount` = evidence where
   `respondingRuleId IS NULL` — the existing Unknown Pattern signal. `computeConfidenceScore()`
   blends 6 weighted 0-100 signals; `aiConfidenceScore` substitutes `frequencyScore` when null, so
   the formula never degrades with AI off.
3. **AI-assisted analysis** (`aiAnalysisJob.ts`, 6h + on-demand `AI_ANALYSIS_BATCH` command,
   optional) — calls `resolveAiClient("LEARNING")`, asks for a strict `CONFIDENCE:`/`SUMMARY:`
   two-line text response (not JSON — `packages/ai-client` has no structured-output mode), parses
   it, writes `aiConfidenceScore`/`aiAnalysisSummary`, re-runs `rescoreCandidate()`.

**Rule proposal**: `createRuleProposalFromCandidate()` + `approveRuleProposalById()`
(`packages/db/src/index.ts`) are the single shared path for both the dashboard's manual "Create
Proposal" button and the worker's auto-approval path
(`LearningSettings.autoApprovalEnabled`/`autoApprovalMinConfidence`, checked in
`rescoreCandidate()`). Both always create the resulting `AutomationRule` as `DRAFT`, never
`ACTIVE` — confirmed at the `packages/db` layer, not just at the call sites, so this invariant
cannot be bypassed by any new caller either.

**Key implication for this feature**: a "human reply" in this architecture is not a special
concept — it's simply an ordinary `INCOMING` message from an `isFromTeamMember` sender inside the
same monitored chat (team members type directly into the shared WhatsApp group). Session
segmentation already includes these; pattern detection already treats a team-member reply
following an unmatched customer message as resolving evidence and as the source of
`suggestedReplyMessage`. **Section 7 of the spec (human reply → rule learning) is therefore
already ~90% implemented by the existing deterministic pipeline** — it just runs on a 5-15 minute
batch cadence rather than instantly, which is consistent with the spec's own section 13 ("do not
build a second learning system") and section 29 (respect the existing floor thresholds, don't
hardcode new ones).

What's genuinely missing for sections 7-9: a way to distinguish *why* a candidate got resolved
(human reply vs. an AI-authored reply vs. an existing rule) and to feed an AI's own generated reply
text in as evidence, since an AI reply is sent by the business account itself (an `OUTGOING`
message from the WhatsApp account's perspective, which segmentation deliberately excludes) rather
than typed by a team member inline. See §7 for the minimal additive fix.

## 4. Current outbound/notification architecture

- **Outbound queue** (`outboundQueueProcessor.ts`): atomic claim via `findFirst` +
  conditional `updateMany` (`status: "PENDING"` in the `where`, i.e. count-checked CAS). Gates, in
  order: kill switch → (broadcast-only) job-cancelled/per-minute-cap → global/per-client rate
  limits → rule cooldown → (broadcast-only) live membership re-verification → `sendMessage`.
  **The kill switch is re-checked here too**, independent of the pipeline-time check — genuine
  defense in depth an AI-authored send benefits from for free.
- **Enqueue helper**: `enqueueOutboundMessage(params)` (`pipeline/enqueueOutbound.ts`) — idempotency
  key is `[accountId, chatId, incomingMessageId, ruleId ?? "system", actionType].join(":")`. This
  already tolerates `ruleId: null` (produces `"system"` in the key) — **no schema or idempotency
  change needed** to enqueue a rule-less, AI-authored `AUTO_REPLY`.
- **Notification dispatcher** (`dispatcher.ts`, `enqueueNotification()`): `TEAMS` posts a webhook;
  `WHATSAPP` resolves a provider from `notification.accountId` and calls `sendMessage` **directly**
  — a second, separate send path from the outbound queue (no idempotency key, no rate limit, by
  design, since it's for internal admin alerts, not customer-facing sends). This is exactly the
  path the human-fallback "AI Assistance Required" alert should reuse, mirroring how the existing
  rule engine's own `NOTIFY_TEAMS`/`NOTIFY_WHATSAPP` actions and the escalation system already work.
- **Escalation** (`escalationQueue.ts`, `fireEscalationEvent()`): the reference implementation for
  "insert an idempotency-guaranteeing event row + a Notification, in one transaction" — the pattern
  a new `AiFallbackDecision` write should follow for its own audit-trail insert.
- **`resolveWhatsAppAccount(serviceKey)`**: not applicable to AI replies — an AI reply must go back
  out through the *same* account/chat the customer messaged (never routed elsewhere), so no new
  `WhatsAppServiceKey` value or migration is needed here.

## 5. Proposed design (how the new layer plugs in)

**Trigger point**: inside `processIncomingMessage.ts`, immediately after the existing `evaluate()`
call, add one new conditional stage — *only* when `result.finalDecision === "NO_MATCH"` (never on
the team-member-filter IGNORE, never when any rule matched). This preserves every existing stage
exactly as CLAUDE.md's pipeline-stage list requires; it is a new stage inserted between "action
decision" and "action execution," not a rewrite of either.

**Eligibility gate** (all must pass, short-circuit on first failure, each independently logged so
"why didn't AI reply" is answerable without server logs, per Engineering Standard §17):
`AutomationSettings.automationEnabled` (kill switch) → `AutomationSettings.mode !== "MANUAL_ONLY"`
→ `group.isMonitored` → new `group.aiAutomationEnabled` → `AiSettings.aiEngineEnabled` →
`AiSettings.autoResponseEnabled` → `resolveAiClient("RESPONSE")` returns non-null.

**Decision call**: build a text prompt (system prompt states the AI classifies/drafts only, never
acts — matching `aiAnalysisJob.ts`'s existing prompt philosophy almost verbatim), request a strict
multi-line format (`INTENT:` / `CONFIDENCE:` / `SHOULD_REPLY:` / `RESPONSE:` — the same
regex-parseable-text convention already used by `aiAnalysisJob.ts`'s `CONFIDENCE:`/`SUMMARY:`
parser, since `packages/ai-client` has no JSON/tool mode to build on). Validate: confidence is an
integer 0-100, response is non-empty when `shouldReply`, and independently re-check every safety
condition above (a stale prompt can't be trusted to have re-validated eligibility).

**On confidence ≥ threshold (default 90) and safety conditions pass**: call
`enqueueOutboundMessage({..., ruleId: null, actionType: "AUTO_REPLY"})` — reusing the *existing*
`AUTO_REPLY` action type and the *existing* outbound queue unchanged. Persist a new
`AiFallbackDecision` row (`outcome: "AI_REPLIED"`) linked to the created `OutboundMessage`.

**On confidence < threshold, AI unavailable/error/timeout/malformed response, or any safety-gate
failure**: persist `AiFallbackDecision` (`outcome: "HUMAN_FALLBACK"`, `reason: <short code>`), then
call `enqueueNotification()` exactly as the rule engine's own `NOTIFY_TEAMS`/`NOTIFY_WHATSAPP`
actions already do, with a new `alertKind: "AI_ASSISTANCE_REQUIRED"` payload branch in
`formatSupportAlert()` (mirroring the existing `"UNKNOWN_PATTERN"` branch) containing group/
sender/message/confidence/intent/reason — the exact fields section 6 asks for.

**Mode-gating generalization**: `checkAutoReplySafety()`'s `SAFE_AUTO_REPLY` check currently keys
on `rule.type ∈ {AUTO_REPLY, SUPPORT_ESCALATION}`. Recommendation: generalize it to accept
`rule: AutomationRule | null`, treating `null` (an AI decision) as equivalent to `AUTO_REPLY` for
eligibility purposes — so AI fallback works under both `SAFE_AUTO_REPLY` and
`FULL_RULE_AUTOMATION`, and is blocked under `MANUAL_ONLY` exactly like every other auto-reply
path. This is a values judgment about risk tolerance, not a purely technical one — flagged for your
confirmation below rather than decided silently.

**Learning integration** (satisfies §7-9, §13, §28, §29 without a second learning system): add one
new nullable-with-default enum column, `PatternCandidateEvidence.responseSource` (`EXISTING_RULE |
HUMAN | AI | UNRESOLVED`), populated in `patternDetectionJob.ts`'s existing evidence-linking query
with a 3-line addition: look up `AiFallbackDecision` by `messageId`; `AI_REPLIED` → `"AI"`,
else existing `respondingRuleId != null` → `"EXISTING_RULE"`, else existing `wasResolved` logic →
`"HUMAN"`, else `"UNRESOLVED"`. `suggestedReplyMessage` derivation gains one additional candidate
source (an AI's `responseText`) when no human-authored reply text is available. Everything
downstream — floor thresholds, confidence scoring, `RuleProposal` creation/approval, duplicate
prevention via `patternKey` uniqueness — is completely unchanged.

## 6. Database changes required

All additive, zero-data-loss, reversible (new columns are nullable-or-defaulted, new tables have
no inbound FKs from existing tables):

| Change | Model | Notes |
|---|---|---|
| New table | `AiFallbackDecision` | `id, messageId (unique FK Message), accountId, groupId?, aiProviderId?, modelId?, intent?, confidenceScore?, responseText?, outcome (AiFallbackOutcome), reason?, outboundMessageId? (FK), notificationId? (FK), tokensUsed?, createdAt`. The audit trail for §23-24. |
| New enum | `AiFallbackOutcome` | `AI_REPLIED \| HUMAN_FALLBACK` |
| New column | `PatternCandidateEvidence.responseSource` | new enum `EvidenceResponseSource { EXISTING_RULE, HUMAN, AI, UNRESOLVED }`, `@default(UNRESOLVED)` |
| New column | `WhatsAppGroup.aiAutomationEnabled` | `Boolean @default(false)` — per-group opt-in, same shape as the existing `escalationMonitoringEnabled` |
| New column | `AiSettings.autoResponseConfidenceThreshold` | `Int @default(90)` — see §7 decision point |

No existing column is renamed, retyped, or dropped. No existing enum value is removed. `ActionType`
is **not** extended (AI replies reuse `AUTO_REPLY`); `WhatsAppServiceKey` is **not** extended (no
new routable service); `WorkerCommandType` is **not** extended (AI decisions run inline per
message, not as a background job/command); `NotificationType`/`Notification` model is **not**
changed at all (existing `relatedMessageId` is sufficient to join back to `AiFallbackDecision`).

## 7. Decisions (confirmed)

1. **Automation Mode gating for AI replies** — confirmed: eligible under both `SAFE_AUTO_REPLY` and
   `FULL_RULE_AUTOMATION`, blocked only under `MANUAL_ONLY`. `checkAutoReplySafety()`'s rule-type
   check is generalized to treat a `null` rule (an AI decision) as `AUTO_REPLY`-equivalent.
2. **Config scope** — confirmed: global (`AiSettings`) + per-group
   (`WhatsAppGroup.aiAutomationEnabled`) only. No per-account toggle.

## 8. UI changes required

- **AI Learning → AI Settings** (`(dashboard)/ai-learning/settings`): activate the existing
  `autoResponseEnabled` field (update its now-inaccurate "currently inert" copy) and add
  `autoResponseConfidenceThreshold` (a new number input, 0-100, default 90) to the existing form —
  no new page.
- **Groups** (`(dashboard)/groups`): add an "AI Automation" toggle to the existing per-group
  Configure dialog, next to the existing Priority Support tier control — reuses the existing
  `Switch`/`SwitchField` component per CLAUDE.md's UI-kit convention.
- **Message detail** (`(dashboard)/messages/[id]`): extend the existing rule-trace section to also
  render the AI decision (intent/confidence/response/outcome) when an `AiFallbackDecision` row
  exists — additive section on an existing page, satisfying §24's decision-history requirement.
- **AI Learning → Overview**: add 3-4 small stat tiles (AI Requests Today, AI Replies, Human
  Fallbacks, AI Calls Avoided) computed live from `AiFallbackDecision` +
  existing `AutomationExecution` rows (a rule-matched execution *is* an avoided AI call — no new
  counter table needed, consistent with how Support Activity's counts are always computed live,
  never pre-aggregated).
- No new sidebar pages. No new wizards. Matches Engineering Standard §2 ("no unnecessary features,
  no decorative dashboards").

## 9. Worker changes required

- `apps/worker/src/pipeline/processIncomingMessage.ts` — one new conditional stage inserted after
  `evaluate()`, before the existing action-execution loop; every existing stage untouched.
- `apps/worker/src/pipeline/safety.ts` — generalize `checkAutoReplySafety()`'s rule-type check to
  accept `rule: AutomationRule | null` (see §5, §7 decision #1).
- New directory `apps/worker/src/aiFallback/` — eligibility check, prompt-build +
  parse (following `aiAnalysisJob.ts`'s existing text-format convention), and persistence
  (`AiFallbackDecision` creation + `enqueueOutboundMessage`/`enqueueNotification` calls). No new
  background loop/`setInterval` — this runs inline, synchronously, once per `NO_MATCH` message.
- `apps/worker/src/learning/patternDetectionJob.ts` — small additive change to the existing
  evidence-linking query (see §5, learning integration).
- `apps/worker/src/notifications/formatMessage.ts` — one new `alertKind` branch
  (`"AI_ASSISTANCE_REQUIRED"`), mirroring the existing `"UNKNOWN_PATTERN"` branch.
- `packages/db/src/index.ts` — add `createAiFallbackDecision(...)`-style helper(s), consistent with
  where every other cross-cutting helper (`resolveWhatsAppAccount`, `encryptSecret`,
  `createRuleProposalFromCandidate`) already lives, per the package's no-relative-imports rule.
- **Not touched**: `packages/ai-client` (reused as-is, no interface change),
  `apps/worker/src/provider/*`, `apps/worker/src/queue/outboundQueueProcessor.ts`,
  `apps/worker/src/notifications/dispatcher.ts`/`enqueueNotification.ts`, `apps/worker/src/
  escalation/*`, `apps/worker/src/supportActivity/*`, `apps/worker/src/learning/
  sessionSegmentation.ts`, `apps/worker/src/learning/aiAnalysisJob.ts`, the `WorkerCommand`
  processor, `apps/web/src/server/aiAdmin/*`.

## 10. Security implications

- No new secret storage — reuses the existing `AiProvider.apiKeyCiphertext` +
  `encryptSecret`/`decryptSecret` for the `RESPONSE` model slot exactly as `LEARNING` and
  `ADMIN_ASSISTANT` already work. No key ever reaches the browser or a log line (following the same
  discipline already audited in `resolveAiClient`/`resolveAiAdminClient`).
- AI never touches the database, never calls the WhatsApp provider directly, and never bypasses
  `enqueueOutboundMessage`/the outbound queue — its only two possible effects are "insert one
  `OutboundMessage` row" or "insert one `Notification` row," both of which go through every
  existing safety gate (kill switch checked twice, rate limits, membership — for broadcast rows —
  cooldowns) unchanged.
- `AiFallbackDecision.responseText`/`intent` store the AI's own generated text, not the customer's
  raw message body a second time (already captured on `Message`) — no new sensitive-data surface
  beyond what `AiKnowledgeItem`/`PatternCandidate.aiAnalysisSummary` already establish as
  acceptable to store.
- No API secrets, tokens, or raw provider payloads are persisted — only `tokensUsed` (an integer),
  matching §23's "do not store unnecessary sensitive provider payloads."

## 11. Cost-control architecture

Directly implements the spec's priority list (§20): rule match (no AI) → learned/proposed rule
(still no AI, once approved+activated) → AI (only on a genuine `NO_MATCH`) → human. Concretely:
- AI is invoked from exactly one call site, gated by the full eligibility chain in §5 — never
  retried for a message the pipeline has already decided is `NO_MATCH`-ineligible.
- Because `evaluate()` already runs before this stage on *every* message regardless, a pattern that
  graduates from `PatternCandidate` → `RuleProposal` → approved `DRAFT` → manually activated
  `AutomationRule` will, from that point on, produce a rule match and never reach the AI stage
  again for that intent — this is the existing rule engine's own behavior, entirely unmodified,
  which is exactly the "cost-saving mechanism" §10/§21 describe.
- "AI calls avoided" (§32/33) is computed live as a count of matched (non-`NO_MATCH`)
  `AutomationExecution` rows in the period — no new counter, no risk of drift between a stored
  counter and reality.

## 12. Testing strategy

Following the exact conventions the test-conventions audit confirmed (Vitest, `packages/engine`
pure unit tests with local `rule()`/`context()` factories; `apps/worker` integration tests against
either the isolated `postgres-test` DB or, for pipeline-level tests, the existing per-test-fixture
discipline; a reusable `MockAiClient` in `apps/worker/src/__tests__/mockAiClient.ts` that already
supports queuing canned responses and is exactly what `processOneAiAnalysisBatch` already injects
via a `clientOverride` parameter for tests — the new AI-fallback code should accept the same kind
of override so **no test ever makes a real Anthropic API call**):

- `packages/engine` (if any pure logic is extracted there, e.g. prompt-response parsing) — plain
  unit tests, no DB.
- New `apps/worker/src/__tests__/aiFallback.integration.test.ts` — covering exactly the scenarios
  §36 lists: rule match ⇒ AI not called; no rule ⇒ AI called; confidence ≥90 ⇒ eligible; confidence
  <90 ⇒ human fallback; AI unavailable/throws ⇒ human fallback, worker stays healthy; AI reply ⇒
  `AiFallbackDecision` + `OutboundMessage` created; human reply after fallback ⇒ (via existing
  segmentation+pattern-detection, run inline in the test like `unknownPatternDetection.integration
  .test.ts` already does) evidence recorded with `responseSource: "HUMAN"`; existing rule after
  learning ⇒ AI not called again; duplicate-proposal prevented (existing `patternKey` uniqueness,
  already covered by existing tests — just needs one new assertion that AI-sourced evidence doesn't
  create a second candidate); AI disabled / group AI disabled ⇒ AI not called (each eligibility gate
  gets its own test case, mirroring `commandSafety.integration.test.ts`'s style of one gate per
  test).
- Minimal real-world verification (§36): `Support Team Internal Discussion ( ISP Digital )` only,
  after automated tests pass — reusing whatever `AiProvider`/model is already configured for the
  Admin Assistant (it appears to already be live per the audit), not a new credential.

## 13. Migration plan

One additive Prisma migration covering all of §6's changes at once (new table, two new enums, three
new/changed columns) — no data backfill needed since every new column is nullable or defaulted and
the new table starts empty. Per CLAUDE.md's live-DB convention: generate and commit the migration,
verify it against the isolated test DB, but **do not run `pnpm db:migrate:deploy` against the live
database without your explicit go-ahead** at the point implementation is ready to ship, exactly as
the existing convention requires.

## 14. Risks

- **Prompt-injection via customer message content** — the customer's message body becomes part of
  the AI's user prompt. Mitigated the same way `aiAnalysisJob.ts` already handles this: the AI's
  only possible outputs are constrained to the parsed `INTENT/CONFIDENCE/SHOULD_REPLY/RESPONSE`
  fields, which only ever become plain text in an `OutboundMessage.body` or a proposal's
  `replyMessage` (itself never auto-activated) — there is no path from AI output back into
  executable code, a rule's `matchType`/regex, or a privileged action.
- **A confidently-wrong AI reply still sends** — the 90% threshold is a heuristic, not a guarantee.
  Mitigated by: human fallback always available below threshold, `Reject`/`Edit`/human override on
  any resulting rule proposal, and the existing kill switch/mode controls providing an immediate
  full stop if a bad pattern is noticed.
- **AI provider disabled/removed mid-flight** — `resolveAiClient` already returns `null` (not
  throw) for that case, so this fails closed into human fallback automatically, matching the
  existing `LEARNING`-slot behavior.
- **Double-charging /combinatorial cost** if a message could somehow both match a rule and reach AI
  — structurally prevented, since the new stage is gated on `finalDecision === "NO_MATCH"`
  specifically, mutually exclusive with a rule match by construction of `evaluate()`.
- **Mode-gating ambiguity** (§7 decision #1) — implementing the wrong default here is the one place
  a wrong call meaningfully changes production risk exposure; flagged for explicit confirmation
  rather than assumed.
