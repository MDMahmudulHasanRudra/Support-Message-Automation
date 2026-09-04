/**
 * Learns HOW this support team writes, from the replies its executives actually sent.
 *
 * Deliberately separate from the group knowledge builder next door, which learns WHAT the team
 * knows. The two must not be conflated: knowledge is a claim about the product and is checked
 * against reality, whereas style is a claim about manner and is checked against taste. Mixing them
 * would let "our team says refunds take 3 days" arrive dressed as a tone note and skip the
 * verification a product fact is supposed to get.
 *
 * So this prompt is under standing orders to produce guidance about *form* only, and the parser
 * below drops anything that reads like a fact.
 */

export interface StylePromptInput {
  /** Real support replies, already stripped of names and numbers by the caller. */
  replies: string[];
  /** What the AI is told to write in by default, so the guidance does not contradict it. */
  defaultReplyLanguage: string;
}

export interface StylePrompt {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

/** Enough replies to see a habit rather than one person's afternoon. */
export const MIN_REPLIES_FOR_A_PROFILE = 25;
/** Ceiling on what is sent in one call — a sample, not the archive. */
export const MAX_REPLIES_PER_BUILD = 300;
export const MAX_SAMPLE_CHARS = 20_000;

export function buildStyleProfilePrompt(input: StylePromptInput): StylePrompt {
  const systemPrompt = [
    "You are studying how a customer support team writes to its customers on WhatsApp, so that an",
    "automated assistant can answer in the same voice rather than in a generic one.",
    "",
    "You are given real replies those support staff sent. Describe the HABITS you can see in them:",
    "- How they open a reply, and whether they greet at all.",
    "- How formal or familiar they are, and how they address the customer.",
    "- Typical length — a sentence, a short paragraph, a numbered list.",
    "- How they acknowledge a problem, an apology, or a delay before answering it.",
    "- How they ask for more information when they need it.",
    "- How they close, and whether they sign off.",
    "- Recurring phrases or courtesies that clearly belong to this team.",
    "",
    "You are describing MANNER, never CONTENT. This is the whole point of the exercise:",
    "- Never state anything about the product, its prices, its features, its timelines or its",
    "  policies. Not even a claim you saw made repeatedly in the replies.",
    "- Never repeat a specific answer, instruction or number from the replies.",
    "- Never mention a customer, a colleague, a company, an invoice or an account.",
    "- If a habit can only be described by quoting a product fact, leave that habit out.",
    "",
    "Write the guidance as short instructions addressed to the assistant, one per line, each",
    "starting with \"- \". Between three and eight lines. No preamble, no heading, no closing",
    "summary. If the replies are too few or too varied to show a real habit, reply with exactly:",
    "NOT ENOUGH EVIDENCE",
  ].join("\n");

  const sample = input.replies.join("\n---\n").slice(0, MAX_SAMPLE_CHARS);

  const userPrompt = [
    `The assistant writes in ${input.defaultReplyLanguage} unless the customer clearly used another`,
    "language. Describe habits that hold regardless of language — do not tell it which language to",
    "use, that is decided elsewhere.",
    "",
    `Here are ${input.replies.length} real replies this team sent:`,
    "",
    sample,
  ].join("\n");

  return { systemPrompt, userPrompt, maxTokens: 700, temperature: 0.2 };
}

/**
 * Turns the model's answer into guidance worth storing, or null.
 *
 * The filtering here is the second half of the manner-not-content rule. The prompt asks for form;
 * this drops the lines that came back as fact anyway, because a single sentence like "tell them
 * refunds take 3 days" would otherwise be injected into every customer reply as though a human had
 * approved it — and the reviewer, reading a list of plausible tone notes, would very likely wave
 * it through.
 */
export function parseStyleGuidance(text: string): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed || /^NOT ENOUGH EVIDENCE/i.test(trimmed)) return null;

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length >= 8 && !looksLikeAProductClaim(line));

  if (lines.length === 0) return null;
  // Eight was the ceiling asked for; anything beyond it is the model padding.
  return lines.slice(0, 8).map((line) => `- ${line}`).join("\n");
}

/**
 * True for a line that asserts something about the business rather than about how to write.
 *
 * Kept narrow and readable rather than clever: every pattern here is a shape that has no business
 * in a tone note, so a false positive costs one dropped line out of eight, while a false negative
 * puts an unverified product claim in front of every customer.
 */
function looksLikeAProductClaim(line: string): boolean {
  return (
    // A concrete quantity or duration — "within 24 hours", "costs 500 taka", "3 working days".
    // Plurals matter: without them "Refunds take 3 days" read as pure manner and was kept.
    /\b\d+\s*(hours?|days?|weeks?|months?|minutes?|taka|tk|৳|%|percent|gb|mb|mbps)\b/i.test(line) ||
    // Naming what the product does or charges.
    /\b(prices?|pricing|costs?|fees?|charges?|refunds?|invoices?|bills?|packages?|plans?|tariffs?|discounts?|offers?)\b/i.test(line) ||
    // Telling the assistant to assert a capability or a policy.
    /\b(tell (them|customers?)|say that|inform (them|customers?)|promise|guarantee|assure)\b.*\b(will|can|does|is|are|has)\b/i.test(line) ||
    // Availability is policy, not manner. Deliberately narrow: an earlier version matched a bare
    // "open", which killed "Open with a short greeting" — the most obviously legitimate style note
    // there is. A rule that eats the good lines is worse than the leak it prevents.
    /\b(working hours?|office hours?|business hours?|24\s*\/\s*7|round the clock|available (24|any ?time|always))\b/i.test(line)
  );

}
