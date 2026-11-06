import {
  accountPromptRules,
  clientPhoneMatchKeys,
  decimalToMinor,
  describeOutstandingDues,
  describeTermForCustomer,
  detectAccountIntent,
  dhakaToday,
  formatCalendarDay,
  narrowAiClientAnswerPolicy,
  resolveAiClientAnswerPolicy,
  resolveClientModuleSettings,
  termState,
  validateAnswerFigures,
  type AccountLookupStatus,
  type AiClientAnswerPolicy,
  type AiClientAnswerSwitches,
} from "@support-automation/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../db.js";
import { projectHasFeature } from "../project/features.js";
import type { KnowledgeSnippet } from "./knowledgeContext.js";

/**
 * Customer account answers for the AI (AI_CLIENT_ANSWERS.md): a VERIFIED customer's own package, its
 * state and expiry, and — separately switched — what they still owe, from the project's Client records.
 * The mirror of commerceContext.ts, with the same safety properties.
 *
 * Returns GROUNDING, never a reply: "Your account (client 0012)" / "Your outstanding dues (client 0012)"
 * entries the normal prompt answers from, plus the rules the prompt adds. Every gate after this point —
 * scope, confidence, the business-question guard, the price check, the send-time safety check — applies
 * unchanged.
 *
 * With the account switch off (the default) this returns nothing and touches NOTHING — not even the
 * feature cache — so the prompt is byte-identical to what it was before. Never throws: a lookup that
 * fails leaves the answer exactly as it would have been without account data.
 *
 * Who the customer is, and nothing else decides it:
 *   - a one-to-one WhatsApp chat only. A group has many people in it: never.
 *   - the sender's number WhatsApp itself delivered (`…@c.us`, never a LID), matched to a client whose
 *     PHONE / WHATSAPP channel holds exactly that number (`clientPhoneMatchKeys`); or an active
 *     ClientWhatsAppChatLink a person made for this chat.
 *   - more than one client matches: no account data, and an account question is handed over.
 *   - Messenger, Instagram, Telegram, website chat and the Sandbox carry no verified identity: never.
 */

export type AccountHandoverReason = "ACCOUNT_REQUEST" | "ACCOUNT_AMBIGUOUS";

export interface ClientAccountGrounding {
  snippets: KnowledgeSnippet[];
  rules: string[];
  /** A person handles this message: a request to pay / change / disconnect, or an account question we cannot attribute to one client. */
  handoverReason: AccountHandoverReason | null;
  policy: AiClientAnswerPolicy | null;
  status: AccountLookupStatus | null;
  /** The money amounts the dues entry states — the only account figures the price check accepts. */
  amounts: string[];
}

export type AccountCustomer =
  /** A WhatsApp conversation. `verifiedPhone` is read only when a lookup is actually needed. */
  | { kind: "WHATSAPP"; accountId: string; chatId: string; isGroup: boolean; verifiedPhone: () => Promise<string | null> }
  /** A channel, the Sandbox: no verifiable identity. */
  | { kind: "UNVERIFIABLE" };

export interface ClientAccountDeps {
  db: PrismaClient;
  hasClientCenter: () => Promise<boolean>;
}

const NONE: ClientAccountGrounding = { snippets: [], rules: [], handoverReason: null, policy: null, status: null, amounts: [] };
const MAX_MATCHES = 5;

const day = (d: Date) => d.toISOString().slice(0, 10);

function snippet(id: string, title: string, answer: string): KnowledgeSnippet {
  return { id, title, question: null, answer, procedure: null, module: "Client account", version: 0, scope: "GLOBAL", fromSameGroup: false };
}

/** True for an entry this module built (not a knowledge row). */
export function isClientAccountEntryId(id: string): boolean {
  return id.startsWith("client:");
}

/**
 * An entry built from ONE person's record: their account, their dues, their order. An answer that used one
 * must never become a rule. A rule is a standing answer for everybody, so an approved draft would tell the next
 * person who asks what this customer owes.
 */
export function isPersonalRecordEntry(id: string): boolean {
  return isClientAccountEntryId(id) || id.startsWith("commerce:order:");
}

/**
 * The price check for every answering path (`validateAnswerFigures`): with commerce or account answers on,
 * every money amount in the reply must be written in what this answer was given. True when neither is on.
 */
export function moneyFiguresGrounded(
  reply: string,
  commerce: { policy: { active: boolean } | null; groundingText: string },
  account: ClientAccountGrounding,
  knowledge: readonly KnowledgeSnippet[],
): boolean {
  return validateAnswerFigures({
    reply,
    commerceActive: Boolean(commerce.policy?.active),
    commerceGroundingText: commerce.groundingText,
    accountActive: Boolean(account.policy?.active),
    accountAmounts: account.amounts,
    // The team's verified entries only — never an entry built from a client or an order.
    knowledgeText: knowledge
      .filter((k) => !k.id.startsWith("commerce:") && !isClientAccountEntryId(k.id))
      .map((k) => [k.title, k.question ?? "", k.answer, k.procedure ?? ""].join("\n"))
      .join("\n"),
  });
}

export async function findClientAccountGrounding(
  input: {
    text: string;
    switches: AiClientAnswerSwitches;
    customer: AccountCustomer;
    /** The Copilot: what the agent who asked may see. Only ever narrows. */
    viewer?: { account: boolean; dues: boolean };
    /** False for the Copilot: an agent drafts, so a request is drafted rather than handed over. */
    handoverRequests?: boolean;
  },
  deps: ClientAccountDeps = { db: prisma, hasClientCenter: () => projectHasFeature("CLIENT_CENTER") },
): Promise<ClientAccountGrounding> {
  // Dues need the account switch too, so this one switch off means nothing at all happens.
  if (!input.switches.clientAccountAnswers) return NONE;
  try {
    const enabled = new Set<string>();
    let modules: { subscriptions: boolean; billing: boolean; renewalWindowDays?: number } = { subscriptions: false, billing: false };
    if (await deps.hasClientCenter()) {
      enabled.add("CLIENT_CENTER");
      modules = resolveClientModuleSettings(await deps.db.clientModuleSettings.findFirst());
    }
    let policy = resolveAiClientAnswerPolicy(enabled, modules, input.switches);
    if (input.viewer) policy = narrowAiClientAnswerPolicy(policy, input.viewer);
    if (!policy.active) return NONE;

    const handoverRequests = input.handoverRequests ?? true;
    const intent = detectAccountIntent(input.text);
    if (handoverRequests && intent.request) return { ...NONE, handoverReason: "ACCOUNT_REQUEST", policy };

    const settle = (status: AccountLookupStatus, extra: Partial<ClientAccountGrounding> = {}): ClientAccountGrounding => ({
      ...NONE,
      policy,
      status,
      rules: accountPromptRules(policy, status),
      ...extra,
    });

    const customer = input.customer;
    if (customer.kind !== "WHATSAPP") return settle("UNVERIFIED");
    if (customer.isGroup || customer.chatId.endsWith("@g.us")) return settle("GROUP");
    // Looked up only for a question about the account: no client data enters a prompt about a router.
    if (!intent.question) return settle("NOT_LOOKED_UP");

    const matched = await matchClients(deps.db, customer);
    if (matched.ids.length === 0) return settle(matched.verified ? "NOT_FOUND" : "UNVERIFIED");
    if (matched.ids.length > 1) return settle("AMBIGUOUS", handoverRequests ? { handoverReason: "ACCOUNT_AMBIGUOUS" } : {});

    const entries = await accountEntries(deps.db, matched.ids[0]!, policy, modules);
    if (!entries) return settle("NOT_FOUND");
    return settle("FOUND", entries);
  } catch (err) {
    console.error("[aiFallback] client account grounding failed; answering without it", (err as Error).name);
    return NONE;
  }
}

/** The distinct, non-archived clients this conversation proves it is. */
async function matchClients(db: PrismaClient, customer: Extract<AccountCustomer, { kind: "WHATSAPP" }>): Promise<{ ids: string[]; verified: boolean }> {
  const ids = new Set<string>();
  const live = { archivedAt: null, status: { not: "ARCHIVED" as const } };

  const phone = await customer.verifiedPhone();
  const keys = phone ? clientPhoneMatchKeys(phone) : [];
  if (keys.length) {
    const rows = await db.clientChannel.findMany({
      where: { kind: { in: ["PHONE", "WHATSAPP"] }, normalizedValue: { in: keys }, client: live },
      select: { clientId: true },
      distinct: ["clientId"],
      take: MAX_MATCHES,
    });
    for (const r of rows) ids.add(r.clientId);
  }

  // A link a person made on purpose for this one chat (never a number match). The database allows one
  // active link per (account, chat).
  const link = await db.clientWhatsAppChatLink.findFirst({
    where: { accountId: customer.accountId, chatId: customer.chatId, unlinkedAt: null, client: live },
    select: { clientId: true },
  });
  if (link) ids.add(link.clientId);

  return { ids: [...ids], verified: keys.length > 0 || Boolean(link) };
}

async function accountEntries(
  db: PrismaClient,
  clientId: string,
  policy: AiClientAnswerPolicy,
  modules: { renewalWindowDays?: number },
): Promise<Pick<ClientAccountGrounding, "snippets" | "amounts"> | null> {
  const client = await db.client.findFirst({
    where: { id: clientId, archivedAt: null },
    select: {
      id: true,
      code: true,
      recordedExpiryDate: true,
      recordedExpiryService: true,
      currentSubscription: { select: { id: true, service: true, kind: true, startDate: true, endDate: true, pausedAt: true, cancelledAt: true, isRenewal: true } },
    },
  });
  if (!client) return null;
  const today = dhakaToday(new Date());
  const snippets: KnowledgeSnippet[] = [];
  let amounts: string[] = [];

  if (policy.account) {
    const term = client.currentSubscription;
    let text: string;
    if (term) {
      const state = termState(
        { id: term.id, kind: term.kind, startDate: day(term.startDate), endDate: day(term.endDate), pausedAt: term.pausedAt, cancelledAt: term.cancelledAt, isRenewal: term.isRenewal },
        today,
        modules.renewalWindowDays,
      );
      text = describeTermForCustomer({ service: term.service, state, startDate: day(term.startDate), endDate: day(term.endDate) });
    } else if (client.recordedExpiryDate) {
      // An expiry a file gave with no start date: a fact on record, never a subscription term.
      text = `the expiry date on record is ${formatCalendarDay(day(client.recordedExpiryDate))}${client.recordedExpiryService ? ` (${client.recordedExpiryService})` : ""}. No subscription term is recorded.`;
    } else {
      text = "no package or subscription is recorded.";
    }
    snippets.push(snippet(`client:account:${client.id}`, `Your account (client ${client.code})`, `Your account (client ${client.code}): ${text}`));
  }

  if (policy.dues) {
    const dues = await db.clientDue.findMany({
      where: { clientId: client.id, status: { in: ["UNPAID", "PARTIALLY_PAID"] } },
      select: { status: true, amount: true, paidAmount: true, currency: true, dueDate: true },
      take: 500,
    });
    const described = describeOutstandingDues(
      dues.map((d) => ({ status: d.status, amount: decimalToMinor(d.amount), paid: decimalToMinor(d.paidAmount) ?? 0n, currency: d.currency, dueDate: day(d.dueDate) })),
      today,
    );
    amounts = described.amounts;
    snippets.push(snippet(`client:dues:${client.id}`, `Your outstanding dues (client ${client.code})`, `Your outstanding dues (client ${client.code}): ${described.text}`));
  }
  return { snippets, amounts };
}
