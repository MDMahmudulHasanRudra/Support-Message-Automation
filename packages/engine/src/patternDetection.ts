import { normalizeText } from "./normalize.js";

/**
 * Pure, side-effect-free deterministic pattern-detection logic for Conversation Learning / Pattern
 * Discovery — mirrors evaluate.ts's own pure/IO split. The worker-side reader/writer
 * (apps/worker/src/learning/patternDetectionJob.ts) is the only caller; nothing here touches
 * Prisma, an AI provider, or any conversation content beyond what's passed in as arguments. No
 * function in this file ever calls an AI provider — every score is computable with zero AI calls,
 * which is what lets pattern detection stay fully functional with AI completely off.
 */

const MAX_SIGNATURE_KEYWORDS = 5;
const MIN_TOKEN_LENGTH = 2;

/**
 * A small, curated starting list of tokens common across nearly every support conversation
 * regardless of intent (greetings, pronouns, politeness markers, a few high-frequency Bangla/
 * Banglish function words) — deliberately not linguistically exhaustive. Its only job is to keep
 * these from crowding out the actually distinctive tokens in a pattern's signature; refining it
 * further is expected as real conversation data accumulates.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "and", "or", "in", "on", "for",
  "please", "hi", "hello", "hey", "thanks", "thank", "you", "your", "i", "we", "my", "me", "it",
  "this", "that", "ok", "okay",
  "না", "কি", "এই", "ওকে", "ভাই", "আমি", "আমার", "আছে", "করি", "করছে",
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function tokenize(normalizedBody: string): string[] {
  return normalizedBody.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export interface PatternSignature {
  /** Deterministic, order-independent signature — the same recurring intent always produces the same key. */
  patternKey: string;
  keywords: string[];
}

/**
 * Derives a pattern's deterministic keyword-set signature from one message's (already-normalized)
 * text. Distinctive tokens are preferred over generic ones by favoring longer tokens first (a
 * simple, corpus-free proxy for specificity — this function sees only one message at a time, so
 * it has no corpus-wide frequency statistics to draw on); the final set is sorted alphabetically
 * so two occurrences of the same intent always hash to the same key regardless of word order.
 */
export function derivePatternSignature(rawBody: string): PatternSignature {
  const normalized = normalizeText(rawBody);
  const distinctive = [...new Set(tokenize(normalized))].filter(
    (token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token),
  );

  const top = [...distinctive]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, MAX_SIGNATURE_KEYWORDS)
    .sort();

  return { patternKey: top.join("|"), keywords: top };
}

export interface CandidateFloorInputs {
  occurrenceCount: number;
  distinctGroupCount: number;
  distinctClientCount: number;
}

export interface CandidateFloorThresholds {
  minOccurrenceForCandidate: number;
  minDistinctGroupsForCandidate: number;
  minDistinctClientsForCandidate: number;
}

/**
 * The hard gate that keeps a single isolated conversation (or a pattern confined to one group/
 * client) from ever becoming a visible PatternCandidate — not just a policy statement, an actual
 * boolean the detection job checks before upserting a row.
 */
export function meetsCandidateFloor(inputs: CandidateFloorInputs, thresholds: CandidateFloorThresholds): boolean {
  return (
    inputs.occurrenceCount >= thresholds.minOccurrenceForCandidate &&
    inputs.distinctGroupCount >= thresholds.minDistinctGroupsForCandidate &&
    inputs.distinctClientCount >= thresholds.minDistinctClientsForCandidate
  );
}

/** Saturates toward 100 well past the floor rather than growing linearly/unbounded. */
export function scoreFrequency(occurrenceCount: number, minOccurrenceForCandidate: number): number {
  if (minOccurrenceForCandidate <= 0) return 100;
  const ratio = occurrenceCount / minOccurrenceForCandidate;
  return clamp(Math.round(50 * Math.log2(1 + ratio)), 0, 100);
}

/**
 * A pattern seen across many groups but only one client (or vice versa) should not score as
 * diverse — takes the weaker of the two ratios rather than averaging them.
 */
export function scoreDiversity(
  distinctGroupCount: number,
  distinctClientCount: number,
  minDistinctGroupsForCandidate: number,
  minDistinctClientsForCandidate: number,
): number {
  const groupRatio = minDistinctGroupsForCandidate > 0 ? distinctGroupCount / minDistinctGroupsForCandidate : 1;
  const clientRatio = minDistinctClientsForCandidate > 0 ? distinctClientCount / minDistinctClientsForCandidate : 1;
  const weaker = Math.min(groupRatio, clientRatio);
  return clamp(Math.round(50 * Math.log2(1 + weaker)), 0, 100);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersectionSize = [...setA].filter((token) => setB.has(token)).length;
  const unionSize = new Set([...setA, ...setB]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Average pairwise Jaccard similarity across every matched message's keyword set — low if
 * "matches" under the same patternKey only superficially share it. A fresh pattern with fewer
 * than two pieces of evidence has nothing to compare yet, so it isn't penalized.
 */
export function scoreConsistency(keywordSets: string[][]): number {
  if (keywordSets.length < 2) return 100;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < keywordSets.length; i++) {
    for (let j = i + 1; j < keywordSets.length; j++) {
      total += jaccardSimilarity(keywordSets[i]!, keywordSets[j]!);
      pairs++;
    }
  }
  return clamp(Math.round((total / pairs) * 100), 0, 100);
}

/** 0 when unavailable (e.g. no team-member reply ever observed) — the confidence formula's weight for this signal accounts for that, it is never treated as "confirmed unsuccessful." */
export function scoreResolution(resolvedCount: number, totalCount: number): number {
  if (totalCount === 0) return 0;
  return clamp(Math.round((resolvedCount / totalCount) * 100), 0, 100);
}

const RECENCY_HALF_LIFE_DAYS = 14;

/** Decays on a 14-day half-life since the pattern was last actually seen — still-recurring patterns stay near 100, patterns that stopped occurring weeks ago fade toward 0. */
export function scoreRecency(lastSeenAt: Date, now: Date): number {
  const daysSinceLastSeen = Math.max(0, (now.getTime() - lastSeenAt.getTime()) / (24 * 60 * 60_000));
  const score = 100 * Math.pow(0.5, daysSinceLastSeen / RECENCY_HALF_LIFE_DAYS);
  return clamp(Math.round(score), 0, 100);
}

export interface ConfidenceWeights {
  weightFrequency: number;
  weightDiversity: number;
  weightConsistency: number;
  weightResolution: number;
  weightRecency: number;
  weightAiConfidence: number;
}

export interface ConfidenceInputs {
  frequencyScore: number;
  diversityScore: number;
  consistencyScore: number;
  resolutionScore: number;
  recencyScore: number;
  /** Null until an AI batch analyzes this candidate — see the fallback below. */
  aiConfidenceScore: number | null;
  /** Only ever incremented via an explicit reviewer action; capped implicitly by the final clamp. */
  humanVerifiedBoost: number;
}

/**
 * Blends the six signals into one 0-100 score. AI-off fallback: when aiConfidenceScore is null,
 * its weighted slot reuses frequencyScore rather than being dropped or treated as zero — this is
 * what keeps the formula non-degenerate with AI fully off (a hard requirement), while still
 * rewarding a candidate once independent AI analysis does run and agrees.
 */
export function computeConfidenceScore(inputs: ConfidenceInputs, weights: ConfidenceWeights): number {
  const totalWeight =
    weights.weightFrequency +
    weights.weightDiversity +
    weights.weightConsistency +
    weights.weightResolution +
    weights.weightRecency +
    weights.weightAiConfidence;
  if (totalWeight <= 0) return 0;

  const aiComponent = inputs.aiConfidenceScore ?? inputs.frequencyScore;
  const weighted =
    inputs.frequencyScore * weights.weightFrequency +
    inputs.diversityScore * weights.weightDiversity +
    inputs.consistencyScore * weights.weightConsistency +
    inputs.resolutionScore * weights.weightResolution +
    inputs.recencyScore * weights.weightRecency +
    aiComponent * weights.weightAiConfidence;

  return clamp(Math.round(weighted / totalWeight + inputs.humanVerifiedBoost), 0, 100);
}

export interface PatternEvidenceSummary {
  occurrenceCount: number;
  distinctGroupCount: number;
  distinctClientCount: number;
  resolvedCount: number;
  keywordSets: string[][];
  lastSeenAt: Date;
  aiConfidenceScore: number | null;
  humanVerifiedBoost: number;
}

export interface PatternDetectionThresholds extends CandidateFloorThresholds, ConfidenceWeights {}

export interface PatternScores {
  frequencyScore: number;
  diversityScore: number;
  consistencyScore: number;
  resolutionScore: number;
  recencyScore: number;
  confidenceScore: number;
}

/** Convenience wrapper — computes every sub-score and the final blended confidence in one call. */
export function scorePatternCandidate(
  evidence: PatternEvidenceSummary,
  thresholds: PatternDetectionThresholds,
  now: Date,
): PatternScores {
  const frequencyScore = scoreFrequency(evidence.occurrenceCount, thresholds.minOccurrenceForCandidate);
  const diversityScore = scoreDiversity(
    evidence.distinctGroupCount,
    evidence.distinctClientCount,
    thresholds.minDistinctGroupsForCandidate,
    thresholds.minDistinctClientsForCandidate,
  );
  const consistencyScore = scoreConsistency(evidence.keywordSets);
  const resolutionScore = scoreResolution(evidence.resolvedCount, evidence.occurrenceCount);
  const recencyScore = scoreRecency(evidence.lastSeenAt, now);

  const confidenceScore = computeConfidenceScore(
    {
      frequencyScore,
      diversityScore,
      consistencyScore,
      resolutionScore,
      recencyScore,
      aiConfidenceScore: evidence.aiConfidenceScore,
      humanVerifiedBoost: evidence.humanVerifiedBoost,
    },
    thresholds,
  );

  return { frequencyScore, diversityScore, consistencyScore, resolutionScore, recencyScore, confidenceScore };
}
