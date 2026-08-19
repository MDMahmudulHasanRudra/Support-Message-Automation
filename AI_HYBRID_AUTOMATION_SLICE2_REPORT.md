# Hybrid AI Automation — Slice 2 Final Report

Learning → Rule Conversion → AI Cost Reduction. Builds on Slice 1 (AI fallback core mechanism,
already committed) without rebuilding, replacing, or duplicating any of it.

## 1. Files changed

**Modified**:
- `apps/worker/src/learning/patternDetectionJob.ts` — `responseSource`/`wasResolved` wiring
- `packages/ai-client/src/resolveAiClient.ts`, `packages/ai-client/src/index.ts` — OpenAI-compatible
  provider branch
- `apps/web/src/server/actions/aiProviders.ts`, `.../aiSettings.ts`, `.../groups.ts` — provider-kind
  restriction + OPENAI test path, new threshold field, new per-group toggle
- `apps/web/src/app/(dashboard)/ai-learning/page.tsx` — cost-visibility stats + corrected copy
- `apps/web/src/app/(dashboard)/ai-learning/providers/AiProviderForm.tsx` — restricted kind dropdown
- `apps/web/src/app/(dashboard)/ai-learning/settings/AiSettingsForm.tsx`, `.../settings/page.tsx` —
  new threshold field + corrected copy
- `apps/web/src/app/(dashboard)/groups/GroupsTable.tsx`, `.../groups/page.tsx` — new AI Automation
  column
- `apps/web/src/app/(dashboard)/messages/[id]/page.tsx` — new AI Fallback trace card
- `apps/worker/src/__tests__/aiFallback.integration.test.ts`,
  `.../patternDetectionJob.integration.test.ts` — extended with new test cases

**New**:
- `packages/ai-client/src/OpenAiCompatibleClient.ts` + its unit test
  (`packages/ai-client/src/__tests__/OpenAiCompatibleClient.test.ts`)
- `apps/worker/src/__tests__/aiToRuleCostReduction.integration.test.ts` (end-to-end cost-reduction
  proof)
- `apps/worker/src/__tests__/resolveAiClient.integration.test.ts` (provider-kind resolution)

## 2. Database migration

**None.** Every column/table this slice touches (`PatternCandidateEvidence.responseSource`,
`AiFallbackDecision`, `WhatsAppGroup.aiAutomationEnabled`, `AiSettings.autoResponseConfidenceThreshold`)
was already migrated in Slice 1. Confirmed by running `prisma migrate deploy` against a fresh
isolated database: all 21 existing migrations applied cleanly, zero pending, zero new migration
generated.

## 3. Features implemented

- **Evidence-linking**: `patternDetectionJob.ts`'s `linkClosedSessionsToCandidates()` now looks up
  any `AiFallbackDecision` for the customer message and tags each new `PatternCandidateEvidence` row
  `responseSource: EXISTING_RULE | AI | HUMAN | UNRESOLVED` (priority order confirmed safe by direct
  code trace: `EXISTING_RULE` and `AI` are structurally mutually exclusive, since the AI fallback
  stage only ever runs on a genuine rule miss). `wasResolved` now also counts an `AI_REPLIED`
  outcome as resolved — without this, an AI-only-resolved pattern would score permanently
  "unresolved" on one of the six confidence signals and never graduate into a rule, working against
  this slice's own goal. `suggestedReplyMessage` now also falls back to the AI's response text when
  no human-authored reply exists (human text still wins if both are present).
- **OpenAI-compatible provider**: a new `OpenAiCompatibleClient`, covering OpenAI's real API, any
  self-hosted/local model runtime, and any custom internal proxy that speaks the same standard
  chat-completions protocol — one implementation, zero schema change (reuses the already-existing,
  previously-unused `AiProviderKind.OPENAI` value). `resolveAiClient()` now branches on kind;
  `testAiProviderConnection()` gained a real `GET /models` check for it.
- **AI Settings UI**: a new "Hybrid AI Automation Fallback" section with the live
  `autoResponseConfidenceThreshold` field, and corrected help copy — the page previously claimed
  everything was inert, which is no longer true for AI Engine/Auto Response.
- **Per-group AI control**: a new "AI Automation" column on the Groups page, toggling
  `WhatsAppGroup.aiAutomationEnabled` directly (no new field, no confirm dialog — lower stakes than
  monitoring, fails safe to nothing happening).
- **Message detail AI trace**: a new card, shown only when a message actually has an
  `AiFallbackDecision`, showing outcome/provider/model/intent/confidence/response/reason/outbound
  status, plus a real (not fabricated) Conversation Learning linkage — the pattern candidate and
  rule proposal it fed into, or an honest "not yet processed" state when evidence-linking hasn't run
  yet.
- **AI cost visibility**: a new stats row on the AI Learning Overview page — AI Requests, AI
  Replies, Human Fallbacks, Average Confidence, Tokens Used, and Rule Matches (the concrete
  "AI calls avoided" counter) — all computed live via Prisma aggregation, no new counter table, no
  invented cost-in-dollars figure.

## 4. Existing functionality reused (not duplicated)

`createRuleProposalFromCandidate()`, `approveRuleProposalById()`, `rescoreCandidate()`,
`computeConfidenceScore`/`scorePatternCandidate` (packages/engine, entirely untouched),
`derivePatternSignature`, the outbound queue, the notification system, `checkAutoReplySafety()`,
`MockAiClient`, and every existing UI primitive (`Card`, `SectionHeader`, `Badge`, `StatTile`,
`Field`). No second learning system, no second proposal system, no second provider abstraction, no
second outbound path.

## 5. Tests executed

- `packages/ai-client` (pure, no DB): 5 new `OpenAiCompatibleClient` tests — request shape,
  default-endpoint fallback, response parsing, error handling, no-key-in-error-message.
- `apps/worker` (isolated `postgres-test`): full suite, including:
  - 6 new `resolveAiClient` provider-kind-resolution tests (ANTHROPIC/OPENAI/GOOGLE/CUSTOM/missing
    config/no-key-leak).
  - 4 new `responseSource` tests in `patternDetectionJob.integration.test.ts` (HUMAN, AI,
    UNRESOLVED, EXISTING_RULE).
  - 2 new "AI Settings disabled" pipeline tests in `aiFallback.integration.test.ts`.
  - 1 new end-to-end test (`aiToRuleCostReduction.integration.test.ts`) proving the full loop: two
    AI-handled occurrences across distinct groups/clients → floor-clearing evidence →
    `createRuleProposalFromCandidate` → `approveRuleProposalById` → DRAFT rule inert against a
    matching message (AI still called) → activated → the same message pattern now matches the rule
    and the AI client records **zero** requests.
- `packages/engine`: full existing suite, unchanged, confirming zero regressions (nothing in this
  slice touches this package).

## 6. Test results

- `packages/ai-client`: **5/5 passed**.
- `apps/worker`: **153/153 passed** (17 files), run twice back-to-back to rule out flakiness — both
  runs clean.
- `packages/engine`: **74/74 passed**, unchanged.

## 7. Build/typecheck results

- `pnpm typecheck` (all 6 TS packages/apps): clean.
- `pnpm build` (all packages/apps, including `apps/web`'s full Next.js production build — 46
  routes generated): clean.

## 8. Security considerations

- No new secret storage; the OpenAI-compatible client uses the exact same
  `AiProvider.apiKeyCiphertext`/`encryptSecret`/`decryptSecret` path as Anthropic.
- The API key is passed only into the `Authorization` header of one outgoing request; it's never
  assigned to a logged/serializable field, never returned from any server action, and a thrown
  request error only ever includes the response status/body — verified by a unit test that
  deliberately triggers a failed request and asserts the key never appears in the resulting error
  message.
- `AiProviderForm.tsx`'s dropdown and `aiProviders.ts`'s server-side validator were both narrowed
  from four `AiProviderKind` values to the two with a real implementation — an admin can no longer
  create an inert `GOOGLE`/`CUSTOM` provider that looks configured but silently never does anything.
- No change to how AI output can affect the system: it still only ever becomes a plain-text
  `OutboundMessage.body`/`RuleProposal.replyMessage`, never executable, never a privileged action.

## 9. AI provider connection methods implemented

- **Anthropic** (unchanged, from Slice 1).
- **OpenAI-compatible** (new): covers OpenAI's real API (default endpoint), any self-hosted/local
  runtime, and any custom internal proxy speaking the same protocol — one client, selected by the
  already-existing `AiProviderKind.OPENAI` value.
- **Google / Custom**: explicitly deferred. The `AiProviderKind` enum values exist and are stored,
  but have no client implementation — the UI no longer offers them, per the "don't invent it,
  document it as a future extension" instruction. Building either would mean mapping a genuinely
  different request/response protocol (Gemini's API shape, or an undefined "custom" shape) — real,
  untested work, not something to fabricate now.

## 10. AI cost-reduction mechanism (demonstrated, not asserted)

Directly proven by `aiToRuleCostReduction.integration.test.ts`: the same message pattern is answered
by AI twice (building real, floor-clearing learning evidence), becomes a Rule Proposal, stays inert
as a human-reviewable DRAFT (a matching message during this window still reaches AI — the "human
approval remains required" guarantee), and only after an explicit activation step does the
deterministic rule engine take over — at which point a fresh `MockAiClient` records **zero**
requests for the same pattern. The AI Learning Overview page's new "Rule Matches" stat makes this
visible in production: it counts exactly the messages now handled without any AI cost.

## 11. Known limitations

- **No live browser click-through of the new UI.** The isolated test database Slice 1/2 both use for
  automated verification has no seeded login user (by design — `docker-compose.test.yml` deliberately
  skips `prisma/seed.ts` for a throwaway test DB), and the live/shared dev database is a real
  production system where these specific new controls (AI Settings' save button, the Groups AI
  toggle) write real, live-affecting rows — clicking them there would be a live configuration
  change, not a test. All new UI was verified by a clean `tsc`/Next.js production build (which
  compiles and statically analyzes every route, including the ones touched) and by following
  existing, already-proven component patterns exactly, but not by looking at the rendered pages in
  a browser. If you'd like, I can spin up the dev server against a freshly-seeded isolated database
  to click through this safely — flagging this explicitly rather than claiming a UI check that
  didn't happen.
- The `resolveAiClient()` quirk noted in the Slice 1 report still applies: an OpenAI-compatible
  `RESPONSE`-job provider also requires `AiSettings.learningEnabled` to be on (that function's own
  gating, unmodified) — an operational note, not a bug this slice needed to fix.
- "AI Requests" on the cost-visibility stats row undercounts by exactly the number of
  `AI_UNAVAILABLE` outcomes (deliberately — no API call was actually attempted in that case); this
  is documented in the code comment, not hidden.

## 12. Deferred items

Nothing from this slice's own scope was deferred — every Core Requirement item this slice was
scoped to cover (evidence-linking, AI/human-sourced learning, rule-proposal reuse, human-approval
preservation, rule-first execution guarantees, provider architecture, all four deferred UI areas,
and the full test list) is implemented and verified. Genuinely out of scope, by explicit
instruction, remain: Google/Custom provider clients (documented future extension, §9), and any
change to the rule engine, outbound queue, or notification system internals (none needed).

## 13. Commit hash

**Not yet committed** — I have not run `git commit`, since committing wasn't requested for this
round. `git status` shows exactly the file list in §1 as modified/new, with a clean working tree
otherwise (Slice 1's own work is already committed as `1bd59f2`). Let me know if you'd like this
committed now, and with what message.
