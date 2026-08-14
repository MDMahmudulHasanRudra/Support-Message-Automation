import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Prisma, WhatsAppServiceKey } from "@prisma/client";
import { validateRegexSafety } from "@support-automation/engine";
import type { RuleAction } from "@support-automation/shared";

// Standard Next.js/Node singleton pattern: avoids exhausting Postgres
// connections from hot-reload creating a new PrismaClient per request in dev.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
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

export { PrismaClient } from "@prisma/client";

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

function getAiSecretKey(): Buffer {
  const secret = process.env.AI_CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("AI_CREDENTIALS_ENCRYPTION_KEY is not configured.");
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) {
    throw new Error("AI_CREDENTIALS_ENCRYPTION_KEY must decode to 32 bytes (generate with: openssl rand -base64 32).");
  }
  return key;
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
  const iv = randomBytes(AI_SECRET_IV_LENGTH);
  const cipher = createCipheriv(AI_SECRET_ALGORITHM, getAiSecretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString("base64")).join(".");
}

/** Reverses encryptSecret — only ever called server-side, right before an outbound API call. */
export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, ciphertextB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !ciphertextB64) throw new Error("Malformed encrypted secret.");
  const decipher = createDecipheriv(AI_SECRET_ALGORITHM, getAiSecretKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
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
    await tx.patternCandidate.update({
      where: { id: proposal.patternCandidateId },
      data: { status: "APPROVED" },
    });
    return rule;
  });

  return { ruleId: createdRule.id };
}
