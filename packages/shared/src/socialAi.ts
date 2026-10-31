import { SOCIAL_PLATFORMS, isSocialPlatform, type SocialPlatform } from "./socialPlatforms.js";

/**
 * Social Studio's AI Content Studio (SOCIAL_STUDIO.md §AI): the pure half. It describes a request, builds
 * the prompt and reads the answer. The worker sends it through Get Assist's existing AI path —
 * `resolveAiClient("RESPONSE")`, the project's own providers, credentials and usage — so there is no
 * second AI system.
 *
 * What comes back is only ever a SUGGESTION. It can fill a draft, which is then marked AI-assisted and
 * still needs a person's approval. Nothing here publishes, and the prompt forbids inventing a fact.
 */

export const SOCIAL_AI_KINDS = ["IDEAS", "CAPTION", "HASHTAGS", "REWRITE", "ADAPT", "CAMPAIGN_PLAN", "EVALUATE"] as const;
export type SocialAiKind = (typeof SOCIAL_AI_KINDS)[number];

export const SOCIAL_AI_KIND_LABELS: Record<SocialAiKind, string> = {
  IDEAS: "Post ideas",
  CAPTION: "Write a caption",
  HASHTAGS: "Suggest hashtags",
  REWRITE: "Rewrite text",
  ADAPT: "Adapt text for a platform",
  CAMPAIGN_PLAN: "Plan a campaign",
  EVALUATE: "Review a draft",
};

export const SOCIAL_AI_TONES = ["friendly", "professional", "playful", "informative", "urgent", "warm"] as const;
export type SocialAiTone = (typeof SOCIAL_AI_TONES)[number];

/** Kinds whose output is post text a person may put into a draft (EVALUATE is advice, never post text). */
export const SOCIAL_AI_TEXT_KINDS: readonly SocialAiKind[] = ["IDEAS", "CAPTION", "HASHTAGS", "REWRITE", "ADAPT", "CAMPAIGN_PLAN"];

export interface SocialAiProductFact {
  name: string;
  price: string | null;
  description: string | null;
}

export interface SocialAiInput {
  kind: SocialAiKind;
  brief: string;
  /** REWRITE / ADAPT / EVALUATE: the text to work on. */
  text: string;
  tone: SocialAiTone;
  /** A language name ("Bengali (Bangla)", "English") or "same" = the language of the brief/text. */
  language: string;
  platform: SocialPlatform | null;
  count: number;
  /** Catalogue product ids chosen by the person; the worker loads their facts. */
  productIds: string[];
}

export function validateSocialAiInput(raw: unknown): { ok: true; value: SocialAiInput } | { ok: false; reason: string } {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const kind = v.kind;
  if (typeof kind !== "string" || !(SOCIAL_AI_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: "Choose what the AI should do." };
  const brief = typeof v.brief === "string" ? v.brief.trim().slice(0, 2000) : "";
  const text = typeof v.text === "string" ? v.text.trim().slice(0, 8000) : "";
  const needsText = kind === "REWRITE" || kind === "ADAPT" || kind === "EVALUATE";
  if (needsText && !text) return { ok: false, reason: "Paste the text to work on." };
  if (!needsText && !brief && !(Array.isArray(v.productIds) && v.productIds.length)) return { ok: false, reason: "Describe what the post is about, or choose a product." };
  const tone = typeof v.tone === "string" && (SOCIAL_AI_TONES as readonly string[]).includes(v.tone) ? (v.tone as SocialAiTone) : "friendly";
  const language = typeof v.language === "string" && v.language.trim() ? v.language.trim().slice(0, 60) : "same";
  const platform = isSocialPlatform(v.platform) ? v.platform : null;
  if (kind === "ADAPT" && !platform) return { ok: false, reason: "Choose the platform to adapt for." };
  const count = Math.min(5, Math.max(1, Math.round(Number(v.count) || 3)));
  const productIds = Array.isArray(v.productIds) ? [...new Set(v.productIds.filter((x): x is string => typeof x === "string" && /^[a-z0-9]{10,40}$/.test(x)))].slice(0, 5) : [];
  return { ok: true, value: { kind: kind as SocialAiKind, brief, text, tone, language, platform, count: kind === "EVALUATE" || kind === "CAMPAIGN_PLAN" ? 1 : count, productIds } };
}

export const SOCIAL_AI_SEPARATOR = "===";

/** The prompt for the RESPONSE model. Facts are only the products the person chose; nothing else is a fact. */
export function buildSocialAiPrompt(input: SocialAiInput, products: readonly SocialAiProductFact[], businessName: string | null): { systemPrompt: string; userPrompt: string; maxTokens: number; temperature: number } {
  const rules = input.platform ? SOCIAL_PLATFORMS[input.platform] : null;
  const language = input.language === "same" ? "the same language as the brief or text (Bengali stays Bengali, Banglish stays Banglish)" : input.language;
  const system: string[] = [
    "You help a business's team write social media posts. Your answer is a suggestion a person will review and approve; it is never published by itself.",
    `Write in ${language}. Tone: ${input.tone}.`,
    "NEVER invent a fact: no price, discount, offer, date, deadline, stock level, guarantee, award, statistic, link, phone number or address that is not in PRODUCT FACTS or the brief. If something is unknown, leave it out.",
    "No medical, legal or financial promises. No content about other brands. No hateful, sexual or misleading content.",
  ];
  if (rules) {
    system.push(`Platform: ${rules.label}. Keep each option under ${Math.min(rules.maxText, 2000)} characters${rules.maxHashtags !== null ? ` and at most ${rules.maxHashtags} hashtags` : ""}.`);
    if (rules.requiresMedia) system.push("This platform shows the text as a caption under a photo or video.");
  }
  const kindRule: Record<SocialAiKind, string> = {
    IDEAS: `Give ${input.count} different post ideas, each a short ready-to-use draft post (2-4 sentences).`,
    CAPTION: `Write ${input.count} different captions for the post described.`,
    HASHTAGS: `Give ${input.count} different sets of relevant hashtags (5-15 each), one set per option, hashtags only.`,
    REWRITE: `Rewrite the TEXT ${input.count} different ways in the requested tone. Keep every fact exactly; add none.`,
    ADAPT: `Adapt the TEXT for the platform ${input.count} different ways: fit its length and style. Keep every fact exactly; add none.`,
    CAMPAIGN_PLAN: "Plan a short campaign: a numbered list of 4-8 posts, each with a one-line theme and a draft text, in posting order. No dates unless the brief gives them.",
    EVALUATE:
      "Review the TEXT as a careful editor. List: (1) what works, (2) problems — unclear wording, missing call to action, claims that need checking, anything that could break the platform's limits or rules, (3) a short improved version. Do not invent facts.",
  };
  system.push(kindRule[input.kind]);
  system.push(
    input.count > 1 && input.kind !== "EVALUATE" && input.kind !== "CAMPAIGN_PLAN"
      ? `Output ONLY the options, separated by a line containing exactly ${SOCIAL_AI_SEPARATOR}. No numbering, no titles, no preamble, no notes.`
      : "Output ONLY the answer, with no preamble.",
  );
  const user: string[] = [];
  if (businessName) user.push(`BUSINESS: ${businessName.slice(0, 120)}`);
  if (input.brief) user.push(`BRIEF:\n${input.brief}`);
  if (input.text) user.push(`TEXT:\n${input.text}`);
  if (products.length) {
    user.push(
      "PRODUCT FACTS (the only facts you may state about products):\n" +
        products.map((p) => `- ${p.name}${p.price ? ` — price ${p.price}` : ""}${p.description ? ` — ${p.description.replace(/\s+/g, " ").slice(0, 400)}` : ""}`).join("\n"),
    );
  }
  return {
    systemPrompt: system.join("\n"),
    userPrompt: user.join("\n\n") || "Suggest a general post for the business.",
    maxTokens: input.kind === "CAMPAIGN_PLAN" || input.kind === "EVALUATE" ? 1500 : 1000,
    temperature: input.kind === "EVALUATE" || input.kind === "REWRITE" || input.kind === "ADAPT" ? 0.4 : 0.8,
  };
}

/** The model's answer as options: split on the separator, preambles and wrapping quotes removed. */
export function parseSocialAiOptions(text: string, kind: SocialAiKind, count: number): string[] {
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return [];
  if (kind === "EVALUATE" || kind === "CAMPAIGN_PLAN") return [cleaned.slice(0, 8000)];
  const parts = cleaned
    .split(new RegExp(`^\\s*${SOCIAL_AI_SEPARATOR}+\\s*$`, "m"))
    .map((p) =>
      p
        .trim()
        .replace(/^(option|caption|idea|version)\s*\d+\s*[:.)-]\s*/i, "")
        .replace(/^["“](.*)["”]$/s, "$1")
        .trim(),
    )
    .filter(Boolean);
  return parts.slice(0, Math.max(1, count)).map((p) => p.slice(0, 5000));
}
