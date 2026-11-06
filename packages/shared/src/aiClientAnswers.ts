/**
 * Customer account answers (AI_CLIENT_ANSWERS.md). Pure rules shared by the worker's four answering
 * paths (WhatsApp AI fallback, channel AI, the Sandbox, the Copilot) and the AI Settings page.
 *
 * The mirror of commerce-aware AI (aiCommerce.ts): the AI may tell a VERIFIED customer their own
 * package, expiry and — separately switched — what they still owe, from the project's Client records.
 * Grounding, never a reply. Both switches are off by default, and with them off nothing is queried and
 * the prompt is byte-identical to what it was before this existed.
 */

import { validateCommerceFigures } from "./aiCommerce.js";
import { formatMinor, summarizeOutstanding } from "./clientPayments.js";
import { ISO_CURRENCY_CODES } from "./currencyCatalog.js";
import { type SubscriptionState } from "./clientSubscriptions.js";
import { normalizeClientPhone } from "./clients.js";

export const AI_CLIENT_ANSWER_CAPABILITIES = ["ACCOUNT", "DUES"] as const;
export type AiClientAnswerCapability = (typeof AI_CLIENT_ANSWER_CAPABILITIES)[number];

export const AI_CLIENT_ANSWER_CAPABILITY_LABELS: Record<AiClientAnswerCapability, string> = {
  ACCOUNT: "The customer's own package, its state and when it expires",
  DUES: "What the customer still owes, per currency",
};

export interface AiClientAnswerSwitches {
  clientAccountAnswers: boolean;
  clientDueAnswers: boolean;
}

/** The Client Management sub-modules these answers read (ClientModuleSettings; no row = both on). */
export interface ClientAnswerModules {
  subscriptions: boolean;
  billing: boolean;
}

export interface AiClientAnswerPolicy {
  /** Package, state and expiry. */
  account: boolean;
  /** Outstanding dues. */
  dues: boolean;
  /** Any capability at all: the account rules are added to the prompt only then. */
  active: boolean;
  /** Why a switched-on capability is not available, for the settings page. */
  blocked: Array<{ capability: AiClientAnswerCapability; reason: string }>;
}

/**
 * `enabled` is the set of the project's modules that are on (ProjectFeature keys); `modules` the Client
 * module's own sub-module switches. Dues need the account switch on as well: a person who may not hear
 * their package never hears what they owe for it.
 */
export function resolveAiClientAnswerPolicy(enabled: ReadonlySet<string>, modules: ClientAnswerModules, s: AiClientAnswerSwitches): AiClientAnswerPolicy {
  const blocked: AiClientAnswerPolicy["blocked"] = [];
  const clients = enabled.has("CLIENT_CENTER");
  const account = s.clientAccountAnswers && clients && modules.subscriptions;
  if (s.clientAccountAnswers && !account) {
    blocked.push({ capability: "ACCOUNT", reason: !clients ? "Client Management is off for this project." : "Subscriptions are switched off in Client Management (Settings → Clients)." });
  }
  const dues = s.clientDueAnswers && s.clientAccountAnswers && clients && modules.billing;
  if (s.clientDueAnswers && !dues) {
    blocked.push({
      capability: "DUES",
      reason: !s.clientAccountAnswers
        ? "Due answers need account answers on."
        : !clients
          ? "Client Management is off for this project."
          : "Billing is switched off in Client Management (Settings → Clients).",
    });
  }
  return { account, dues, active: account || dues, blocked };
}

/** Narrows a policy to what the person asking may see (the Copilot drafts for an agent). Never widens. */
export function narrowAiClientAnswerPolicy(policy: AiClientAnswerPolicy, viewer: { account: boolean; dues: boolean }): AiClientAnswerPolicy {
  const account = policy.account && viewer.account;
  // Dues name the client too, so they need both keys.
  const dues = policy.dues && viewer.dues && viewer.account;
  return { ...policy, account, dues, active: account || dues };
}

// ── What the customer is asking ─────────────────────────────────────────────────────────────────

// First-person requests only, in English, Banglish and Bengali script. "How can I pay my bill?" is a
// question the AI may answer from verified knowledge (the payment methods); "I want to pay" or "change
// my package" is something a person does — payment cannot be taken here and nothing here changes a
// package or a line.
const REQUEST_PATTERNS: RegExp[] = [
  /\b(i want to|i wanna|i'd like to|i would like to|i need to|please|plz|pls)\s+(pay|make (a |the )?payment|upgrade|downgrade|disconnect|renew|(change|switch)\s+(my |the |our )?(package|plan|line|connection|speed)|(cancel|close|stop|terminate)\s+(my |the |our )?(line|connection|subscription|package|internet|account|service))\b/i,
  /\b(upgrade|downgrade|change|switch)\s+(my|our)\s+(package|plan|line|connection|speed|subscription)\b/i,
  /\b(disconnect|cancel|close|terminate|stop)\s+(my|our)\s+(line|connection|subscription|package|internet|account|service)\b/i,
  /\b(take|accept|receive)\s+(my\s+)?payment\b/i,
  /\b(bill dibo|bill debo|bill dite chai|payment korbo|payment korte chai|taka dibo|taka debo|taka dite chai|pay korbo|pay korte chai|package change korbo|package change korte chai|package bodlate chai|package bodlabo|upgrade korbo|upgrade korte chai|downgrade korbo|downgrade korte chai|line (bondho|off) korbo|line (bondho|off) korte chai|line kete dite chai|connection (bondho|off|cancel) korbo|connection (bondho|off|cancel) korte chai|renew korbo|renew korte chai)\b/i,
  /(বিল দিব|বিল দেব|বিল দিতে চাই|পেমেন্ট করব|পেমেন্ট করতে চাই|টাকা দিব|টাকা দেব|টাকা দিতে চাই|প্যাকেজ পরিবর্তন করতে চাই|প্যাকেজ পরিবর্তন করব|প্যাকেজ বদলাতে চাই|প্যাকেজ বদলাব|আপগ্রেড করতে চাই|আপগ্রেড করব|ডাউনগ্রেড করতে চাই|ডাউনগ্রেড করব|লাইন বন্ধ করতে চাই|লাইন বন্ধ করব|লাইন কেটে দিন|সংযোগ বিচ্ছিন্ন করতে চাই|সংযোগ বন্ধ করতে চাই|রিনিউ করতে চাই|রিনিউ করব)/,
];

// Questions about the customer's own account: a lookup is made only for these. Broad on purpose — a
// false positive costs one lookup for a verified customer; a miss leaves the AI with the rule "no account
// details were looked up", so it hands over rather than guessing.
const QUESTION_PATTERNS: RegExp[] = [
  /\b(my|our)\s+(bill|bills|due|dues|balance|payment|package|plan|line|connection|subscription|account|internet|expiry|validity|renewal)\b/i,
  /\b(how much do i owe|how much (is|do i have) (left|to pay)|outstanding|owe|expir(e|es|y|ed|ing)|validity)\b/i,
  /\b(bill koto|baki koto|due koto|bokeya koto|koto taka baki|meyad|mead|expire kobe|kobe expire|kobe sesh|package ki|amar package|amar bill|amar line|line kobe)\b/i,
  /(আমার বিল|বিল কত|বকেয়া|বাকি কত|কত টাকা বাকি|মেয়াদ|আমার প্যাকেজ|প্যাকেজ কী|প্যাকেজ কি|আমার লাইন|আমার সংযোগ|কবে শেষ|কবে বন্ধ)/,
];

export interface AccountIntent {
  /** Wants something done: pay, change package, renew, disconnect. A person handles these. */
  request: boolean;
  /** Asks about their own account, package, expiry or dues. */
  question: boolean;
}

export function detectAccountIntent(text: string): AccountIntent {
  return { request: REQUEST_PATTERNS.some((p) => p.test(text)), question: QUESTION_PATTERNS.some((p) => p.test(text)) };
}

// ── Who the customer is ─────────────────────────────────────────────────────────────────────────

/**
 * The stored forms a client's PHONE / WHATSAPP channel can hold for this WhatsApp-delivered number:
 * the normalised form every client form and import writes (`normalizeClientPhone`, E.164 digits when
 * valid), plus a Bangladeshi number's local digits ("01…"), the form a record entered before the
 * country code was added still carries. Exact forms of the SAME number only — never a suffix match.
 */
export function clientPhoneMatchKeys(phone: string): string[] {
  const normalised = normalizeClientPhone(phone);
  if (!normalised) return [];
  const keys = new Set([normalised]);
  if (/^8801\d{9}$/.test(normalised)) keys.add(normalised.slice(2));
  return [...keys];
}

/** How the customer was (or was not) matched to one client. */
export type AccountLookupStatus = "FOUND" | "NOT_FOUND" | "UNVERIFIED" | "AMBIGUOUS" | "GROUP" | "NOT_LOOKED_UP";

/** The lines added to the prompt when account answers are on. Never present otherwise. */
export function accountPromptRules(policy: AiClientAnswerPolicy, status: AccountLookupStatus): string[] {
  if (!policy.active) return [];
  const can = [policy.account ? "their package, its state and when it expires" : null, policy.dues ? "what they still owe" : null].filter(Boolean).join(", and ");
  const situation: Record<AccountLookupStatus, string> = {
    FOUND: "These details belong to this customer alone, matched to their verified WhatsApp number or to a chat a person linked to their record. Never discuss any other client's account, even when the customer names it or gives its number.",
    NOT_FOUND: "No client account matches this customer's verified number. If they ask about their account, dues, package or expiry, answer SHOULD_REPLY: NO.",
    UNVERIFIED: "This customer's identity could not be verified, so no account details can be given. If they ask about their account, dues, package or expiry, answer SHOULD_REPLY: NO.",
    AMBIGUOUS: "This customer's number matches more than one client account, so no account details can be given. If they ask about their account, dues, package or expiry, answer SHOULD_REPLY: NO.",
    GROUP: "This is a group conversation: never discuss anybody's account, dues, package or expiry here. If asked, answer SHOULD_REPLY: NO.",
    NOT_LOOKED_UP: "No account details were looked up for this message. If the customer asks about their account, dues, package or expiry, answer SHOULD_REPLY: NO.",
  };
  return [
    "",
    `CUSTOMER ACCOUNT. This business keeps its customers' accounts in this system. You may tell the customer only about their OWN account: ${can}.`,
    "Package names, states, dates and amounts owed may be stated ONLY exactly as they are written in reference entries titled \"Your account\" or \"Your outstanding dues\". Never state, round, estimate, convert, add up or predict any of them.",
    "Payment cannot be taken here, and nothing here can renew, change or disconnect a package or line. If the customer wants to pay, renew, change their package or disconnect, answer SHOULD_REPLY: NO so a person helps.",
    policy.dues ? "" : "What the customer owes is not available here. If they ask what they owe, answer SHOULD_REPLY: NO.",
    policy.account ? "" : "Package and expiry details are not available here. If they ask about them, answer SHOULD_REPLY: NO.",
    situation[status],
  ].filter((line) => line !== "");
}

// ── What the entries say ────────────────────────────────────────────────────────────────────────

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** "2026-11-15" (a Dhaka calendar day, as Client Management stores it) → "15 Nov 2026". */
export function formatCalendarDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return DAY_FORMAT.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

/** One sentence on the current term, as of its derived state (`termState`). */
export function describeTermForCustomer(term: { service: string; state: SubscriptionState; startDate: string; endDate: string }): string {
  const end = formatCalendarDay(term.endDate);
  const what = `package ${term.service}`;
  switch (term.state) {
    case "ACTIVE":
      return `${what} — active, expires on ${end}.`;
    case "EXPIRING":
      return `${what} — active, expires soon, on ${end}.`;
    case "TRIAL":
      return `${what} — a trial, which ends on ${end}.`;
    case "SCHEDULED":
      return `${what} — starts on ${formatCalendarDay(term.startDate)} and expires on ${end}.`;
    case "EXPIRED":
      return `${what} — expired on ${end}.`;
    case "PAUSED":
      return `${what} — paused (it was set to expire on ${end}).`;
    case "CANCELLED":
      return `${what} — cancelled.`;
    default:
      return "no package is recorded.";
  }
}

export interface OpenDueInput {
  status: string;
  /** Minor units; null = the due carries no amount. */
  amount: bigint | null;
  /** Minor units already paid. */
  paid: bigint;
  currency: string | null;
  /** `YYYY-MM-DD`. */
  dueDate: string;
}

/**
 * The dues entry's sentence and the amounts it states — the only figures the price check accepts from it.
 * The figures are the Billing List's own (`summarizeOutstanding`): per currency, never summed across
 * currencies, from BigInt minor units. An open due with no amount (or no currency) is counted apart: it is
 * owed, but nobody wrote down how much, so the AI must not answer as if nothing were owed.
 */
export function describeOutstandingDues(dues: readonly OpenDueInput[], today: string): { text: string; amounts: string[] } {
  const lines = summarizeOutstanding(dues, today).filter((l) => l.remaining > 0n);
  const unpricedOpen = dues.filter((d) => (d.status === "UNPAID" || d.status === "PARTIALLY_PAID") && (d.amount === null || !d.currency)).length;
  const amounts = lines.map((l) => formatMinor(l.remaining, l.currency));
  const parts = lines.map((l, i) => {
    const count = l.openCount === 1 ? "1 open invoice" : `${l.openCount} open invoices`;
    const overdue = l.overdueCount ? `, ${l.overdueCount === l.openCount ? (l.openCount === 1 ? "overdue" : "all overdue") : `${l.overdueCount} overdue`}` : "";
    return `${amounts[i]} (${count}${overdue})`;
  });
  const unpriced = unpricedOpen
    ? `${unpricedOpen === 1 ? "1 open due has" : `${unpricedOpen} open dues have`} no amount recorded; a person must confirm ${unpricedOpen === 1 ? "it" : "them"}.`
    : "";
  if (parts.length === 0) return { text: unpriced || "nothing is outstanding.", amounts };
  return { text: `${parts.join("; ")}.${unpriced ? ` ${unpriced}` : ""}`, amounts };
}

// ── The price check ─────────────────────────────────────────────────────────────────────────────

/**
 * "Never invent a price or a due", checked mechanically across commerce AND account answers: every money
 * amount in a reply must be written in the grounding it was given. Off (true) when neither is active.
 *
 * - Commerce on: exactly commerce's own rule (catalogue and order entries), plus any account amounts that
 *   were given — so turning account answers on never loosens the commerce check.
 * - Account answers only: the account amounts given, plus the team's verified knowledge entries given to
 *   this answer (an ISP's package prices live there; refusing them would stop every price answer the
 *   moment account answers were switched on).
 *
 * An account amount counts only when it was actually given: `accountAmounts` is the dues entry's figures
 * and nothing else (never its dates or the client code). With account answers on, every ISO currency code
 * is read as a currency marker, because a due can be in any of them.
 */
export function validateAnswerFigures(input: {
  reply: string;
  commerceActive: boolean;
  commerceGroundingText: string;
  accountActive: boolean;
  accountAmounts: readonly string[];
  knowledgeText: string;
}): boolean {
  if (!input.commerceActive && !input.accountActive) return true;
  const allowed = [input.commerceGroundingText, ...input.accountAmounts];
  if (!input.commerceActive) allowed.push(input.knowledgeText);
  return validateCommerceFigures(input.reply, allowed.join("\n"), input.accountActive ? { currencyCodes: ISO_CURRENCY_CODES } : {}).ok;
}
