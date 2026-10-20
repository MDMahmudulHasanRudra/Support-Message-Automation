/**
 * AI enrichment — INTERFACES ONLY (06-algorithms §6). Nothing here is implemented in release 1, and the
 * contract is what a later implementation must keep:
 *
 *   - A suggestion is never counted in any `VERIFIED_LINK_TIERS` total and never changes an
 *     `AttributionOutcome` or a reply tier. It would be shown, if ever, under its own "AI-suggested (not
 *     verified)" label, with its source and model, apart from every verified figure.
 *   - Only replies the evidence rules left UNRESOLVED are ever offered, and what comes back is a suggestion,
 *     never a decision.
 *   - Any implementation goes through `packages/ai-client` (text-only, no tools): no tool calling, no new
 *     provider, and no message text sent anywhere it is not already sent for AI answers.
 */

export type EnrichmentConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface ReplyLinkSuggestion {
  replyKey: string;
  customerKey: string;
  confidence: EnrichmentConfidence;
  /** Always "AI": the literal keeps a suggestion from ever being mistaken for evidence. */
  source: "AI";
  /** Provider / model id for the audit trail, e.g. the AiModelConfig id. */
  modelRef: string;
}

export interface ReplyLinkEnricher {
  suggest(input: { groupKey: string; unresolvedReplyKeys: readonly string[] }): Promise<ReplyLinkSuggestion[]>;
}

export interface IdentityHintSuggestion {
  senderId: string;
  memberId: string;
  confidence: EnrichmentConfidence;
  source: "AI";
  modelRef: string;
}

export interface IdentityHintEnricher {
  suggestRosterMatches(input: { senderIds: readonly string[] }): Promise<IdentityHintSuggestion[]>;
}
