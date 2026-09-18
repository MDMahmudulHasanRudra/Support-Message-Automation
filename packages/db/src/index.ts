import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { AiFallbackOutcome, Prisma, WhatsAppServiceKey } from "@prisma/client";
import { derivePatternSignature, validateRegexSafety } from "@support-automation/engine";
import { knowledgeContentHash } from "@support-automation/shared";
import type { RuleAction } from "@support-automation/shared";

// Standard Next.js/Node singleton pattern: avoids exhausting Postgres
// connections from hot-reload creating a new PrismaClient per request in dev.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Every process that opens this client gets a BOUNDED pool, whatever the deployment's
 * `DATABASE_URL` happens to say.
 *
 * Prisma's default pool size is `num_cpus * 2 + 1` PER PROCESS, and nothing here ever set one:
 * `app` and `worker` each sized themselves from the host's core count against a stock
 * `postgres:16-alpine` whose `max_connections` is 100. On a multi-core VPS that is a large,
 * silently self-scaling share of the server's connection budget claimed by two processes that
 * spend most of their time idle — and the cost is not only the ceiling. Every Postgres connection
 * is a backend process with its own memory, so an oversized pool shows up as load and RSS long
 * before it shows up as "too many clients".
 *
 * The test harness has carried exactly these three parameters since the day an unbounded pool
 * started failing suites at random with "Can't reach database server" while Postgres itself sat
 * healthy and idle (see CLAUDE.md's testing section). That lesson was never applied to production;
 * this is it applied.
 *
 * A URL that already names a parameter keeps its own value, untouched — that is what leaves
 * `test:isolated`'s deliberately tighter pool exactly as it was, and what lets a deployment
 * override any of the three without a code change.
 */
function withPoolBounds(url: string | undefined): string | null {
  if (!url) return null;
  const defaults: Record<string, string> = {
    // Ten is comfortably above what either process runs concurrently — the worker's loops are
    // overlap-guarded and serial, and the dashboard renders a page at a time — while keeping both
    // processes together well inside a stock 100 even with migrations and a psql session open.
    connection_limit: process.env.DATABASE_POOL_SIZE || "10",
    // Wait for a pooled connection rather than failing instantly under a burst. The default is
    // already 10s; naming it keeps the three values in one place.
    pool_timeout: "20",
    connect_timeout: "30",
  };

  try {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(defaults)) {
      if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    // An unparseable URL is Prisma's problem to report, with its own far better message. Silently
    // rewriting it here would only replace that with something more confusing.
    return url;
  }
}

const boundedUrl = withPoolBounds(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    // Omitted entirely when there is no URL to bound, so an unset DATABASE_URL still produces
    // Prisma's own startup error rather than a confusing one from here.
    ...(boundedUrl ? { datasources: { db: { url: boundedUrl } } } : {}),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/** Used by both apps' health endpoints to confirm DB connectivity. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export { Prisma, PrismaClient } from "@prisma/client";

export interface ResolvedWhatsAppAccount {
  accountId: string;
  accountLabel: string;
  /** Why this account was picked — surfaced in logs/UI so multi-account behavior is never a mystery. */
  source: "CONFIGURED" | "PRIMARY_FALLBACK" | "PRIMARY_DEFAULT";
}

export interface WhatsAppAccountResolutionError {
  error: string;
}

export type WhatsAppAccountResolution = ResolvedWhatsAppAccount | WhatsAppAccountResolutionError;

export function isResolutionError(result: WhatsAppAccountResolution): result is WhatsAppAccountResolutionError {
  return "error" in result;
}

/**
 * The single centralized account resolver every WhatsApp-sending service must go through —
 * never scatter this decision across call sites. Implements the spec's exact decision tree:
 *
 *   service has a configured account?
 *     no  -> use Primary (PRIMARY_DEFAULT)
 *     yes -> is it connected?
 *              yes -> use it (CONFIGURED)
 *              no  -> follow fallbackPolicy:
 *                       STRICT_NO_FALLBACK -> clear error, never silently switch accounts
 *                       PRIMARY_FALLBACK   -> use Primary if connected (PRIMARY_FALLBACK), else error
 *
 * Never returns "some connected account" picked arbitrarily — every path either names a specific
 * account or returns an error. Callers must log the result (see the worker-side call sites) so
 * multi-account routing is traceable end to end.
 *
 * Deliberately kept in this same file rather than split out: packages/db ships as raw TypeScript
 * source (no build step — see this package's Dockerfile-consuming apps' own comments), so any
 * relative import between sibling files here is resolved differently by Node's native runtime
 * (worker, plain `node`) than by Next.js's Turbopack (web) — neither an extensionless nor a `.js`
 * specifier satisfies both at once. Zero relative imports sidesteps the incompatibility entirely.
 */
export async function resolveWhatsAppAccount(serviceKey: WhatsAppServiceKey): Promise<WhatsAppAccountResolution> {
  const [route, primary] = await Promise.all([
    prisma.whatsAppServiceRoute.findUnique({ where: { serviceKey } }),
    prisma.whatsAppAccount.findFirst({ where: { isPrimary: true } }),
  ]);

  const usePrimary = (source: "PRIMARY_DEFAULT" | "PRIMARY_FALLBACK"): WhatsAppAccountResolution => {
    if (!primary) {
      return { error: `No Primary WhatsApp account is configured, and ${serviceKey} has no specific account configured.` };
    }
    if (primary.status !== "CONNECTED") {
      return { error: `Primary WhatsApp account "${primary.label}" is not connected (status: ${primary.status}).` };
    }
    return { accountId: primary.id, accountLabel: primary.label, source };
  };

  if (!route || !route.enabled || !route.accountId) {
    return usePrimary("PRIMARY_DEFAULT");
  }

  const configured = await prisma.whatsAppAccount.findUnique({ where: { id: route.accountId } });
  if (configured && configured.status === "CONNECTED") {
    return { accountId: configured.id, accountLabel: configured.label, source: "CONFIGURED" };
  }

  if (route.fallbackPolicy === "STRICT_NO_FALLBACK") {
    return {
      error: `Configured WhatsApp account for ${serviceKey}${configured ? ` ("${configured.label}")` : ""} is unavailable, and this service is set to not fall back to Primary.`,
    };
  }

  return usePrimary("PRIMARY_FALLBACK");
}

const AI_SECRET_ALGORITHM = "aes-256-gcm";
const AI_SECRET_IV_LENGTH = 12;

/**
 * Which key encrypted a given secret, so the key can ever be changed.
 *
 * The stored envelope used to be `iv.tag.ciphertext` and named no key at all. With one key in one
 * environment variable that reads as simplicity, and it is not: it makes rotation IMPOSSIBLE.
 * Replace `AI_CREDENTIALS_ENCRYPTION_KEY` and every stored credential becomes permanently
 * undecryptable, with no way to tell which rows were written under which key and therefore no
 * migration to write. "We can rotate the key" was not true, and nothing in the system said so.
 *
 * The envelope is now `v2.<keyId>.<iv>.<tag>.<ciphertext>`. Rotation becomes an ordinary
 * operation:
 *
 *   1. Generate a new key. Move the current one into `AI_CREDENTIALS_ENCRYPTION_KEYS_OLD` as
 *      `{"<oldKeyId>":"<base64>"}`, keeping it available for DECRYPT only.
 *   2. Set `AI_CREDENTIALS_ENCRYPTION_KEY` to the new key and `AI_CREDENTIALS_ENCRYPTION_KEY_ID`
 *      to a new id.
 *   3. Everything written from then on uses the new key; everything already stored still reads.
 *   4. Re-encrypt at leisure with `reencryptSecret`, then — and only then — retire the old key.
 *
 * Step 4 is the one that must not be rushed: a key is not safe to destroy until every backup that
 * might be restored has been migrated too, not merely the live rows.
 */
const LEGACY_KEY_ID = "v1";
const ENVELOPE_PREFIX = "v2";

function parseKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes (generate with: openssl rand -base64 32).`);
  }
  return key;
}

/** The key new secrets are encrypted with. */
function getActiveKey(): { keyId: string; key: Buffer } {
  const secret = process.env.AI_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("AI_CREDENTIALS_ENCRYPTION_KEY is not configured.");
  return {
    // Defaults to the legacy id, so a deployment that has never rotated writes envelopes naming
    // the key it has always used rather than inventing a new identity for it.
    keyId: process.env.AI_CREDENTIALS_ENCRYPTION_KEY_ID?.trim() || LEGACY_KEY_ID,
    key: parseKey(secret, "AI_CREDENTIALS_ENCRYPTION_KEY"),
  };
}

/**
 * Retired keys, kept only so old ciphertext still reads. A JSON object of id → base64 key.
 *
 * Deliberately separate from the active key: a key that can still decrypt is not the same as a key
 * anything is allowed to encrypt with, and conflating the two is how a "rotation" silently keeps
 * writing under the key it was supposed to retire.
 */
function getRetiredKeys(): Map<string, Buffer> {
  const raw = process.env.AI_CREDENTIALS_ENCRYPTION_KEYS_OLD?.trim();
  if (!raw) return new Map();
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error('AI_CREDENTIALS_ENCRYPTION_KEYS_OLD must be JSON, e.g. {"v1":"<base64 key>"}.');
  }
  return new Map(
    Object.entries(parsed).map(([keyId, value]) => [keyId, parseKey(value, `AI_CREDENTIALS_ENCRYPTION_KEYS_OLD["${keyId}"]`)]),
  );
}

function keyForDecryption(keyId: string): Buffer {
  const active = getActiveKey();
  if (keyId === active.keyId) return active.key;
  const retired = getRetiredKeys().get(keyId);
  if (retired) return retired;
  throw new Error(
    `No key available for encryption key id "${keyId}". Add it to AI_CREDENTIALS_ENCRYPTION_KEYS_OLD to read secrets written under it.`,
  );
}

/**
 * Encrypts an AI provider API key for storage — never store the plaintext. Lives directly in this
 * file (not a sibling module under packages/db/src) for the same reason resolveWhatsAppAccount()
 * above does: packages/db ships as raw, uncompiled TypeScript with no build step, consumed
 * directly by both Turbopack (apps/web) and plain Node/tsx (apps/worker) — a relative import
 * between two files here has already caused a real outage from those two resolving it
 * differently. `packages/ai-client` (the only other consumer of these functions besides
 * apps/web) imports them via `@support-automation/db`, a normal cross-package import, which is
 * unaffected by that constraint.
 */
export function encryptSecret(plaintext: string): string {
  const { keyId, key } = getActiveKey();
  const iv = randomBytes(AI_SECRET_IV_LENGTH);
  const cipher = createCipheriv(AI_SECRET_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [ENVELOPE_PREFIX, keyId, ...[iv, authTag, ciphertext].map((buf) => buf.toString("base64"))].join(".");
}

/**
 * Reverses encryptSecret — only ever called server-side, right before an outbound API call.
 *
 * Reads BOTH envelopes. The legacy three-part form names no key, so it is decrypted with whatever
 * the active key is, which is exactly what it was encrypted with: it predates rotation being
 * possible at all. Keeping that path is not tidiness — every credential stored before this change
 * is in that form, and dropping it would lock the deployment out of its own providers on deploy.
 *
 * AES-256-GCM throughout, so a wrong key does not silently return rubbish: the authentication tag
 * fails and this throws. That property is what makes `reencryptSecret` safe to run in bulk.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split(".");

  const { keyId, iv, tag, ciphertext } =
    parts.length === 5
      ? { keyId: parts[1]!, iv: parts[2]!, tag: parts[3]!, ciphertext: parts[4]! }
      : { keyId: LEGACY_KEY_ID, iv: parts[0]!, tag: parts[1]!, ciphertext: parts[2]! };

  if (parts.length === 5 && parts[0] !== ENVELOPE_PREFIX) {
    throw new Error(`Unknown encrypted secret format "${parts[0]}".`);
  }
  if (parts.length !== 3 && parts.length !== 5) throw new Error("Malformed encrypted secret.");
  if (!iv || !tag || !ciphertext) throw new Error("Malformed encrypted secret.");

  if (parts.length === 5) {
    return openEnvelope(keyForDecryption(keyId), iv, tag, ciphertext);
  }

  // A LEGACY envelope names no key, so the only way to read it is to try the keys we hold — and
  // that is sound rather than a guess, because AES-256-GCM authenticates: a wrong key fails the
  // tag check and throws, it never returns plausible rubbish.
  //
  // Trying them matters on the FIRST rotation, which is the one a real deployment performs. Reading
  // a legacy secret with the active key alone works right up until the key is rotated, at which
  // point every credential written before key ids existed becomes unreadable — precisely the
  // failure this whole change exists to prevent, reintroduced at the one moment it would bite.
  const active = getActiveKey();
  const candidates = [active.key, ...getRetiredKeys().values()];
  for (const candidate of candidates) {
    try {
      return openEnvelope(candidate, iv, tag, ciphertext);
    } catch {
      // Wrong key for this secret. Keep going; the loop below reports it if none fit.
    }
  }
  throw new Error(
    "Could not decrypt a secret stored in the pre-key-id format with any configured key. Add the key it was written under to AI_CREDENTIALS_ENCRYPTION_KEYS_OLD.",
  );
}

function openEnvelope(key: Buffer, iv: string, tag: string, ciphertext: string): string {
  const decipher = createDecipheriv(AI_SECRET_ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Which key a stored secret was written under, without decrypting it. */
export function encryptionKeyIdOf(stored: string): string {
  const parts = stored.split(".");
  return parts.length === 5 && parts[0] === ENVELOPE_PREFIX ? parts[1]! : LEGACY_KEY_ID;
}

/**
 * Moves one stored secret onto the active key: decrypt with whichever key wrote it, re-encrypt with
 * the current one.
 *
 * The migration step of a rotation, and the reason rotation is now a real operation rather than a
 * claim. Returns the value unchanged when it is already on the active key, so running it across
 * every row repeatedly is safe and converges.
 *
 * Throws rather than returning the original if decryption fails — a secret that cannot be read is
 * something an operator must see, not something to quietly carry forward under a key that cannot
 * open it.
 */
export function reencryptSecret(stored: string): string {
  if (encryptionKeyIdOf(stored) === getActiveKey().keyId && stored.split(".").length === 5) return stored;
  return encryptSecret(decryptSecret(stored));
}

/** Never send the real key to the browser — show only enough to recognize which one it is. */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "••••••••";
  return `${plaintext.slice(0, 4)}••••••••${plaintext.slice(-4)}`;
}

/** One AUTO_REPLY action if the pattern has an observed reply to suggest, otherwise a safe SUPPORT_REQUIRED fallback. */
function deriveSuggestedActions(suggestedReplyMessage: string | null): RuleAction[] {
  return suggestedReplyMessage ? [{ type: "AUTO_REPLY" }] : [{ type: "SUPPORT_REQUIRED" }];
}

function deriveProposalName(keywords: string[]): string {
  const label = keywords.join(", ") || "unlabeled pattern";
  return `Pattern: ${label}`.slice(0, 120);
}

export type CreateRuleProposalResult = { id: string } | { error: string };

/**
 * Conversation Learning: creates a RuleProposal from a PatternCandidate's suggested fields.
 * Shared between apps/web's human-initiated "Create Proposal" button
 * (apps/web/src/server/actions/ruleProposals.ts) and apps/worker's auto-approval path
 * (apps/worker/src/learning/patternDetectionJob.ts's rescoreCandidate()) — lives here, not
 * duplicated in each, so both stay byte-for-byte identical in how a candidate becomes a proposal.
 * Same no-relative-imports reasoning as resolveWhatsAppAccount()/encryptSecret() above applies to
 * why this is in this file directly rather than a sibling module.
 */
export async function createRuleProposalFromCandidate(candidateId: string): Promise<CreateRuleProposalResult> {
  const candidate = await prisma.patternCandidate.findUnique({
    where: { id: candidateId },
    include: { proposal: true },
  });
  if (!candidate) return { error: "Pattern candidate not found." };
  if (candidate.proposal) return { error: "A proposal already exists for this pattern." };

  const proposal = await prisma.ruleProposal.create({
    data: {
      patternCandidateId: candidate.id,
      name: deriveProposalName(candidate.suggestedKeywords),
      description: `Auto-drafted from a recurring conversation pattern (${candidate.occurrenceCount} occurrences across ${candidate.distinctGroupCount} group(s), ${candidate.distinctClientCount} client(s)).`,
      type: candidate.suggestedReplyMessage ? "AUTO_REPLY" : "GENERIC",
      matchType: candidate.suggestedMatchType,
      matchValue: candidate.suggestedMatchValue,
      keywords: candidate.suggestedKeywords,
      actions: deriveSuggestedActions(candidate.suggestedReplyMessage) as unknown as Prisma.InputJsonValue,
      replyMessage: candidate.suggestedReplyMessage,
      confidenceScoreSnapshot: candidate.confidenceScore,
    },
  });

  return { id: proposal.id };
}

/**
 * A one-word signature would match half the inbox. Two distinctive tokens is the floor at
 * which a drafted rule is specific enough to be worth a reviewer's time.
 */
const MIN_SIGNATURE_KEYWORDS_FOR_DRAFT = 2;

export type DraftRuleFromAiReplyResult =
  | { created: true; proposalId: string }
  | { created: false; reason: string };

/**
 * Turns one message the AI answered well into a reusable AutomationRule draft, so the next
 * customer asking the same thing is served by the deterministic engine — instantly, free, and
 * identically every time — instead of another AI call.
 *
 * The draft always lands as a PENDING_REVIEW RuleProposal and is approved into a **DRAFT**
 * AutomationRule, never an active one. Two humans decisions still stand between an AI's answer
 * and a customer receiving it automatically: approving the proposal, and activating the rule.
 * That is deliberate — an AI answer that was right once is not yet a policy.
 *
 * Deduplicated on the message's keyword signature, which is unique across proposals: a question
 * asked fifty times produces one draft, not fifty. Lives here beside
 * createRuleProposalFromCandidate() for the same reason that one does — both mint the same kind
 * of row, and a second copy of that logic would drift.
 */
export async function createRuleProposalFromAiReply(params: {
  customerMessage: string;
  replyText: string;
  confidence: number;
  intent: string | null;
  sourceMessageId: string;
  groupName: string | null;
}): Promise<DraftRuleFromAiReplyResult> {
  const signature = derivePatternSignature(params.customerMessage);
  if (signature.keywords.length < MIN_SIGNATURE_KEYWORDS_FOR_DRAFT) {
    return { created: false, reason: "TOO_GENERIC" };
  }

  const label = params.intent?.trim() || signature.keywords.slice(0, 4).join(", ");

  try {
    const proposal = await prisma.ruleProposal.create({
      data: {
        source: "AI_REPLY",
        sourceSignature: signature.patternKey,
        sourceMessageId: params.sourceMessageId,
        name: `AI: ${label}`.slice(0, 120),
        description:
          `Drafted from a question the AI answered at ${params.confidence}% confidence` +
          `${params.groupName ? ` in ${params.groupName}` : ""}. Approving creates a DRAFT rule; ` +
          `review the reply text before activating it.`,
        type: "AUTO_REPLY",
        matchType: "KEYWORDS",
        keywords: signature.keywords,
        actions: [{ type: "AUTO_REPLY" }] as unknown as Prisma.InputJsonValue,
        replyMessage: params.replyText,
        confidenceScoreSnapshot: params.confidence,
      },
    });
    return { created: true, proposalId: proposal.id };
  } catch (err) {
    // P2002 on sourceSignature is the dedup working: this question already has a draft
    // waiting for review. Not an error, and not worth logging as one.
    if ((err as { code?: string }).code === "P2002") {
      return { created: false, reason: "ALREADY_DRAFTED" };
    }
    throw err;
  }
}

export type ApproveRuleProposalResult = { ruleId: string } | { error: string };

/**
 * Converts an existing, PENDING_REVIEW RuleProposal into a real AutomationRule — always created as
 * DRAFT, never ACTIVE, regardless of who/what approved it: a human still makes the separate "go
 * live" decision on the existing Rules page. `reviewedById` is null for an automatic
 * (LearningSettings.autoApprovalEnabled) approval — there is no human reviewer on that path.
 * Shared for the same reason createRuleProposalFromCandidate() above is.
 */
export async function approveRuleProposalById(params: {
  proposalId: string;
  reviewedById: string | null;
  autoApproved: boolean;
}): Promise<ApproveRuleProposalResult> {
  const proposal = await prisma.ruleProposal.findUnique({ where: { id: params.proposalId } });
  if (!proposal) return { error: "Rule proposal not found." };
  if (proposal.status !== "PENDING_REVIEW") {
    return { error: "This proposal has already been reviewed." };
  }

  // Same gate apps/web/src/server/actions/rules.ts applies at rule-save time — reused, never
  // duplicated. Pattern-derived proposals are always matchType KEYWORDS today, so this is
  // defense-in-depth for a future manually-edited proposal, not a path exercised by the current
  // generator.
  if (proposal.matchType === "REGEX" && proposal.matchValue) {
    const check = validateRegexSafety(proposal.matchValue);
    if (!check.safe) return { error: `Regex rejected: ${check.reason}` };
  }

  const createdRule = await prisma.$transaction(async (tx) => {
    const rule = await tx.automationRule.create({
      data: {
        name: proposal.name,
        description: proposal.description,
        type: proposal.type,
        matchType: proposal.matchType,
        matchValue: proposal.matchValue,
        keywords: proposal.keywords,
        conditions: proposal.conditions as Prisma.InputJsonValue,
        actions: proposal.actions as Prisma.InputJsonValue,
        priority: proposal.priority,
        // Always DRAFT, even here — a human must still make the separate "activate" decision on
        // the Rules page before this can execute against real messages.
        status: "DRAFT",
        cooldownSeconds: proposal.cooldownSeconds,
        replyMessage: proposal.replyMessage,
        replyDelayMinMs: proposal.replyDelayMinMs,
        replyDelayMaxMs: proposal.replyDelayMaxMs,
        createdById: params.reviewedById,
      },
    });
    await tx.ruleProposal.update({
      where: { id: params.proposalId },
      data: {
        status: "APPROVED",
        createdRuleId: rule.id,
        reviewedById: params.reviewedById,
        reviewedAt: new Date(),
        autoApproved: params.autoApproved,
      },
    });
    // Only a CONVERSATION_LEARNING proposal has a candidate to close out. An AI_REPLY
    // proposal is drafted straight from one answered message, so there is nothing upstream
    // to mark approved.
    if (proposal.patternCandidateId) {
      await tx.patternCandidate.update({
        where: { id: proposal.patternCandidateId },
        data: { status: "APPROVED" },
      });
    }
    return rule;
  });

  return { ruleId: createdRule.id };
}

export interface CreateAiFallbackDecisionInput {
  messageId: string;
  accountId: string;
  groupId?: string | null;
  aiProviderId?: string | null;
  modelId?: string | null;
  intent?: string | null;
  confidenceScore?: number | null;
  responseText?: string | null;
  outcome: AiFallbackOutcome;
  reason?: string | null;
  outboundMessageId?: string | null;
  notificationId?: string | null;
  tokensUsed?: number | null;
  /**
   * How the generation went, in the provider's own terms, plus which version of THIS SYSTEM
   * produced it. All optional: a decision recorded before a model was ever called — a media-only
   * message, an exhausted cooldown — legitimately has none of them.
   */
  latencyMs?: number | null;
  finishReason?: string | null;
  promptVersion?: string | null;
  retrievalVersion?: string | null;
  evidenceFingerprint?: string | null;
  correlationId?: string | null;
}

export type CreateAiFallbackDecisionResult = { id: string } | { error: string };

/**
 * Hybrid AI Automation's audit-trail write — one row per genuine NO_MATCH message that reached
 * the eligibility gate (apps/worker/src/aiFallback/). Idempotent on messageId, same pattern as
 * enqueueOutboundMessage()'s idempotencyKey: a P2002 (e.g. a redelivered WhatsApp event racing
 * this same code path twice) is a no-op, not an error. Lives here, not a sibling module, for the
 * same no-relative-imports reason as resolveWhatsAppAccount()/encryptSecret() above.
 */
export async function createAiFallbackDecision(
  input: CreateAiFallbackDecisionInput,
): Promise<CreateAiFallbackDecisionResult> {
  try {
    const created = await prisma.aiFallbackDecision.create({
      data: {
        messageId: input.messageId,
        accountId: input.accountId,
        groupId: input.groupId ?? null,
        aiProviderId: input.aiProviderId ?? null,
        modelId: input.modelId ?? null,
        intent: input.intent ?? null,
        confidenceScore: input.confidenceScore ?? null,
        responseText: input.responseText ?? null,
        outcome: input.outcome,
        reason: input.reason ?? null,
        // `|| null`, not `?? null`: these are foreign keys, and an empty string is not a valid id.
        // A caller that hands one over (a suppressed notification used to return "" here) would
        // otherwise produce a P2003 that this function does not catch, losing the whole decision
        // row rather than just the link.
        outboundMessageId: input.outboundMessageId || null,
        notificationId: input.notificationId || null,
        tokensUsed: input.tokensUsed ?? null,
        latencyMs: input.latencyMs ?? null,
        finishReason: input.finishReason ?? null,
        promptVersion: input.promptVersion ?? null,
        retrievalVersion: input.retrievalVersion ?? null,
        evidenceFingerprint: input.evidenceFingerprint ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
    return { id: created.id };
  } catch (err: any) {
    if (err?.code === "P2002") {
      return { error: "An AI fallback decision already exists for this message." };
    }
    throw err;
  }
}

/**
 * The one way a knowledge entry is created — used by every writer there is.
 *
 * Four places create knowledge: the dashboard form, an approved conversation candidate, the Forge
 * repository sync, and live deep-answer research. They agreed on almost nothing. Two of them wrote
 * no `AiKnowledgeVersion` row at all, so machine-written entries claimed `currentVersion: 1` with
 * no version behind it — versioning existed and half the system ignored it, which is worse than not
 * having it, because a snapshot pointing at version 1 of such an entry resolves to nothing.
 *
 * Centralising it also puts SCOPE in one place, and scope is the data-isolation boundary. Derived
 * from provenance rather than asked of each caller: an entry carrying a `sourceGroupId` was learned
 * from, or researched for, one particular group, so GROUP is what it is until a person decides
 * otherwise. Entries with no group — a manual entry, a document import, the repository sync — are
 * statements about the product and stay GLOBAL. "Unknown or ambiguous" resolves to the narrow
 * answer, which is the only safe direction for a rule that decides whose information can be told
 * to whom.
 *
 * Lives in this file rather than a sibling module for the reason the whole package does: zero
 * relative imports between files in packages/db (see resolveWhatsAppAccount's own note).
 */
export interface CreateKnowledgeItemInput {
  title: string;
  category: Prisma.AiKnowledgeItemCreateInput["category"];
  question?: string | null;
  answer: string;
  procedure?: string | null;
  module?: string | null;
  software?: string | null;
  softwareVersion?: string | null;
  source: string;
  sourceGroupId?: string | null;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
  importId?: string | null;
  confidence?: number | null;
  aiGenerated: boolean;
  humanVerified: boolean;
  createdById?: string | null;
  /** The person who approved it, when one did. Null for a machine-verified entry. */
  verifiedById?: string | null;
  /**
   * Overrides the provenance-derived scope. Only pass this where the caller genuinely knows
   * better than "it came from a group" — a person promoting an entry, or a source that is
   * definitionally product-wide.
   */
  scope?: "GLOBAL" | "GROUP" | "ACCOUNT";
  scopeAccountId?: string | null;
  changeSummary?: string | null;
}

/** Provenance decides scope unless a caller states otherwise. See the doc comment above. */
export function deriveKnowledgeScope(input: {
  scope?: "GLOBAL" | "GROUP" | "ACCOUNT";
  sourceGroupId?: string | null;
}): "GLOBAL" | "GROUP" | "ACCOUNT" {
  if (input.scope) return input.scope;
  return input.sourceGroupId ? "GROUP" : "GLOBAL";
}

export async function createKnowledgeItem(input: CreateKnowledgeItemInput): Promise<{ id: string }> {
  const scope = deriveKnowledgeScope(input);
  const contentHash = knowledgeContentHash({
    title: input.title,
    question: input.question ?? null,
    answer: input.answer,
    procedure: input.procedure ?? null,
    module: input.module ?? null,
  });

  const content = {
    title: input.title,
    category: input.category,
    question: input.question ?? null,
    answer: input.answer,
    procedure: input.procedure ?? null,
    software: input.software ?? null,
    module: input.module ?? null,
    softwareVersion: input.softwareVersion ?? null,
  };

  const created = await prisma.aiKnowledgeItem.create({
    data: {
      ...content,
      source: input.source,
      sourceGroupId: input.sourceGroupId ?? null,
      sourceLabel: input.sourceLabel ?? null,
      sourceUrl: input.sourceUrl ?? null,
      importId: input.importId ?? null,
      confidence: input.confidence ?? null,
      aiGenerated: input.aiGenerated,
      humanVerified: input.humanVerified,
      scope,
      scopeAccountId: scope === "ACCOUNT" ? (input.scopeAccountId ?? null) : null,
      contentHash,
      verifiedById: input.verifiedById ?? null,
      // Stamped only when it is actually verified. A machine-verified entry has a time and no
      // person, which is the truth about it rather than a gap.
      verifiedAt: input.humanVerified ? new Date() : null,
      currentVersion: 1,
      createdById: input.createdById ?? null,
      // ALWAYS written, by every path. An evidence snapshot records the version number it read,
      // and that only resolves to content if the version row exists.
      versions: {
        create: {
          version: 1,
          ...content,
          changeSummary: input.changeSummary ?? null,
          createdById: input.createdById ?? null,
        },
      },
    },
    select: { id: true },
  });

  return created;
}

/**
 * Entries whose content is byte-identical to this one, for a reviewer to look at.
 *
 * Reports, never merges. Two entries sharing a fingerprint may be a re-import of the same document
 * — or the same wording arrived at independently for two different groups, where merging would
 * destroy a distinct procedure and silently widen its scope. Similarity is a reason for a person
 * to look, not an instruction to the database.
 */
export async function findKnowledgeDuplicates(contentHash: string, excludeId?: string) {
  return prisma.aiKnowledgeItem.findMany({
    where: { contentHash, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, title: true, scope: true, sourceGroupId: true, humanVerified: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 10,
  });
}
