/**
 * Mood Detection (MOOD_DETECTION.md): how a CUSTOMER's emotional state is read from what they send,
 * and what the configured policy says to do about it.
 *
 * Detection and action are separate, on purpose:
 *   detectMood()        — "this customer is probably angry, 0.91", from text, emoji and stickers;
 *   applyMoodTrend()    — the same reading in the light of their previous moods in this group;
 *   decideMoodTrigger() — whether the configured threshold and emotion triggers make it actionable;
 *   the policy          — which actions that mood's level is allowed to take, each one switchable.
 *
 * The deterministic reading here is the cheap pre-filter: a message with no emotional signal never
 * reaches the AI at all, and a clear one ("😡", "worst service") does not need it. Only an
 * ambiguous or contextual reading (`needsAi`) is worth an AI classification, and the worker decides
 * whether to spend one.
 *
 * Every conclusion is an INFERENCE with a confidence and structured signal codes — never a raw model
 * explanation. Pure: no database, no clock except the one passed in.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary

export const MOODS = ["NEUTRAL", "POSITIVE", "CONFUSED", "CONCERNED", "FRUSTRATED", "ANGRY", "VERY_ANGRY", "URGENT"] as const;
export type Mood = (typeof MOODS)[number];

export const MOOD_LABELS: Record<Mood, string> = {
  NEUTRAL: "Neutral",
  POSITIVE: "Satisfied",
  CONFUSED: "Confused",
  CONCERNED: "Concerned",
  FRUSTRATED: "Frustrated",
  ANGRY: "Angry",
  VERY_ANGRY: "Very angry",
  URGENT: "Urgent / distressed",
};

export const MOOD_EMOJI: Record<Mood, string> = {
  NEUTRAL: "😐",
  POSITIVE: "🙂",
  CONFUSED: "😕",
  CONCERNED: "😟",
  FRUSTRATED: "😤",
  ANGRY: "😡",
  VERY_ANGRY: "🤬",
  URGENT: "🚨",
};

/**
 * The escalation level a mood sits at: 0 normal, 1 concerned, 2 frustrated, 3 angry, 4 very angry.
 * Urgent sits with angry — it needs a person just as soon, for a different reason. A new mood is one
 * entry here and one in MOODS; nothing else in the engine assumes the list is closed.
 */
export const MOOD_LEVEL: Record<Mood, 0 | 1 | 2 | 3 | 4> = {
  NEUTRAL: 0,
  POSITIVE: 0,
  CONFUSED: 1,
  CONCERNED: 1,
  FRUSTRATED: 2,
  ANGRY: 3,
  VERY_ANGRY: 4,
  URGENT: 3,
};

export const isMood = (value: string | null | undefined): value is Mood => (MOODS as readonly string[]).includes(value ?? "");

/** Moods a policy can act on. Neutral and satisfied are stored for analysis, never acted on. */
export const TRIGGERABLE_MOODS = ["CONCERNED", "CONFUSED", "FRUSTRATED", "ANGRY", "VERY_ANGRY", "URGENT"] as const;
export type TriggerableMood = (typeof TRIGGERABLE_MOODS)[number];

/** Structured reasons — what a person may be shown about why, instead of any model reasoning. */
export const MOOD_SIGNALS = [
  "NEGATIVE_LANGUAGE",
  "STRONG_NEGATIVE_LANGUAGE",
  "ANGER_STATEMENT",
  "ESCALATION_REQUEST",
  "REPEATED_COMPLAINT",
  "URGENCY",
  "CONFUSION",
  "CONCERN",
  "ANGRY_EMOJI",
  "NEGATIVE_EMOJI",
  "SAD_EMOJI",
  "POSITIVE_EMOJI",
  "POSITIVE_LANGUAGE",
  "ANGRY_REACTION",
  "NEGATIVE_REACTION",
  "POSITIVE_REACTION",
  "SHOUTING",
  "EXCESSIVE_PUNCTUATION",
  "MESSAGE_BURST",
  "MIXED_SIGNALS",
  "UNKNOWN_STICKER_SIGNAL",
  "MOOD_ROSE",
  "ESCALATING_PATTERN",
  "AI_CLASSIFIED",
] as const;
export type MoodSignal = (typeof MOOD_SIGNALS)[number];

export const MOOD_SIGNAL_LABELS: Record<MoodSignal, string> = {
  NEGATIVE_LANGUAGE: "Negative language",
  STRONG_NEGATIVE_LANGUAGE: "Strongly negative language",
  ANGER_STATEMENT: "Said they are angry or fed up",
  ESCALATION_REQUEST: "Asked for a manager or to complain",
  REPEATED_COMPLAINT: "Repeated complaint",
  URGENCY: "Urgent request",
  CONFUSION: "Did not understand",
  CONCERN: "Problem not solved yet",
  ANGRY_EMOJI: "Angry emoji",
  NEGATIVE_EMOJI: "Negative emoji",
  SAD_EMOJI: "Sad emoji",
  POSITIVE_EMOJI: "Positive emoji",
  POSITIVE_LANGUAGE: "Positive language",
  ANGRY_REACTION: "Angry reaction",
  NEGATIVE_REACTION: "Negative reaction",
  POSITIVE_REACTION: "Positive reaction",
  SHOUTING: "Written in capitals",
  EXCESSIVE_PUNCTUATION: "Repeated !!! or ???",
  MESSAGE_BURST: "Several messages in a row",
  MIXED_SIGNALS: "Mixed signals — classified with care",
  UNKNOWN_STICKER_SIGNAL: "Sticker (meaning not identifiable)",
  MOOD_ROSE: "Mood rose since their last message",
  ESCALATING_PATTERN: "Mood has been escalating",
  AI_CLASSIFIED: "Classified by AI in context",
};

export const isMoodSignal = (value: string): value is MoodSignal => (MOOD_SIGNALS as readonly string[]).includes(value);

// ---------------------------------------------------------------------------------------------
// Settings shape (the MoodDetectionSettings row's typed reading)

export type ConversationBehaviour = "CONTINUE" | "PAUSE_AI" | "REQUIRE_HUMAN";
export const CONVERSATION_BEHAVIOURS: readonly ConversationBehaviour[] = ["CONTINUE", "PAUSE_AI", "REQUIRE_HUMAN"];
export const CONVERSATION_BEHAVIOUR_LABELS: Record<ConversationBehaviour, string> = {
  CONTINUE: "Continue automation",
  PAUSE_AI: "Pause AI replies (rules continue)",
  REQUIRE_HUMAN: "Require human takeover",
};

export type AlertPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export const ALERT_PRIORITIES: readonly AlertPriority[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** What one mood is allowed to do. Every action is its own switch. */
export interface MoodPolicy {
  /** Whether this mood triggers anything at all. */
  trigger: boolean;
  /** The Notification Center's routing for the Mood alert event (its groups, Teams, personal DMs). */
  notifyTeam: boolean;
  /** A WhatsApp alert to the chosen internal escalation group(s). */
  internalAlert: boolean;
  /** @-mention the responsible member in that internal alert (needs the internal alert). */
  mentionMember: boolean;
  /** A professional holding message in the customer's own group. */
  customerMessage: boolean;
  /** Put the conversation back in WhatsApp Chat's Waiting list. */
  needsAttention: boolean;
  conversation: ConversationBehaviour;
  priority: AlertPriority;
}

export type MoodPolicies = Record<TriggerableMood, MoodPolicy>;

const OFF: MoodPolicy = {
  trigger: false,
  notifyTeam: false,
  internalAlert: false,
  mentionMember: false,
  customerMessage: false,
  needsAttention: false,
  conversation: "CONTINUE",
  priority: "LOW",
};

/** The recommended starting point: angry pauses AI, very angry needs a person, nobody is messaged unasked. */
export const DEFAULT_MOOD_POLICIES: MoodPolicies = {
  CONCERNED: { ...OFF },
  CONFUSED: { ...OFF },
  FRUSTRATED: { ...OFF, trigger: true, needsAttention: true, priority: "MEDIUM" },
  ANGRY: { trigger: true, notifyTeam: true, internalAlert: true, mentionMember: true, customerMessage: false, needsAttention: true, conversation: "PAUSE_AI", priority: "HIGH" },
  VERY_ANGRY: { trigger: true, notifyTeam: true, internalAlert: true, mentionMember: true, customerMessage: false, needsAttention: true, conversation: "REQUIRE_HUMAN", priority: "CRITICAL" },
  URGENT: { trigger: true, notifyTeam: true, internalAlert: true, mentionMember: true, customerMessage: false, needsAttention: true, conversation: "PAUSE_AI", priority: "HIGH" },
};

/** Reads stored policies safely: anything missing or malformed takes the default for that field. */
export function parseMoodPolicies(raw: unknown): MoodPolicies {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as MoodPolicies;
  for (const mood of TRIGGERABLE_MOODS) {
    const base = DEFAULT_MOOD_POLICIES[mood];
    const given = source[mood] && typeof source[mood] === "object" ? (source[mood] as Record<string, unknown>) : {};
    const flag = (key: keyof MoodPolicy) => (typeof given[key] === "boolean" ? (given[key] as boolean) : (base[key] as boolean));
    const policy: MoodPolicy = {
      trigger: flag("trigger"),
      notifyTeam: flag("notifyTeam"),
      internalAlert: flag("internalAlert"),
      mentionMember: flag("mentionMember"),
      customerMessage: flag("customerMessage"),
      needsAttention: flag("needsAttention"),
      conversation: CONVERSATION_BEHAVIOURS.includes(given.conversation as ConversationBehaviour) ? (given.conversation as ConversationBehaviour) : base.conversation,
      priority: ALERT_PRIORITIES.includes(given.priority as AlertPriority) ? (given.priority as AlertPriority) : base.priority,
    };
    // A mention is part of the internal alert; on its own it would have nowhere to go.
    if (!policy.internalAlert) policy.mentionMember = false;
    out[mood] = policy;
  }
  return out;
}

export type MoodSensitivity = "LOW" | "BALANCED" | "HIGH" | "CUSTOM";
export const MOOD_SENSITIVITIES: readonly MoodSensitivity[] = ["LOW", "BALANCED", "HIGH", "CUSTOM"];
export const SENSITIVITY_THRESHOLDS: Record<Exclude<MoodSensitivity, "CUSTOM">, number> = { LOW: 90, BALANCED: 80, HIGH: 65 };

/** The minimum confidence (0–100) a reading needs before anything is done about it. */
export function moodThreshold(sensitivity: string, customMinConfidence: number): number {
  if (sensitivity === "LOW" || sensitivity === "BALANCED" || sensitivity === "HIGH") return SENSITIVITY_THRESHOLDS[sensitivity];
  return Math.min(99, Math.max(50, Math.round(customMinConfidence)));
}

export interface MoodSources {
  text: boolean;
  emoji: boolean;
  stickers: boolean;
}

// ---------------------------------------------------------------------------------------------
// Detection

const L = "[\\p{L}\\p{M}\\p{N}]";
function phrases(...alternatives: string[]): RegExp {
  return new RegExp(`(?<!${L})(?:${alternatives.join("|")})(?!${L})`, "iu");
}
const norm = (text: string) => text.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

const STRONG_NEGATIVE = phrases(
  "terrible", "horrible", "useless", "worst", "pathetic", "disgusting", "rubbish", "nonsense", "fraud", "scam", "cheat(?:ers?|ing)?", "shameless",
  "very bad service", "worst service", "bad service", "third class", "3rd class",
  "বাজে", "ফালতু", "জঘন্য", "খুবই খারাপ", "ধান্দাবাজ", "প্রতারক", "baje service", "faltu", "jogonno", "dhandabaj",
);
const NEGATIVE = phrases(
  "very bad", "so bad", "not good", "disappointed", "disappointing", "poor service", "not satisfied", "unacceptable", "annoying", "irritating",
  "খারাপ", "বিরক্ত", "হতাশ", "kharap", "birokto", "hotash",
);
const ANGER_STATEMENT = phrases(
  "i am (?:very |so |really )?angry", "i'm (?:very |so |really )?angry", "very angry", "so angry", "fed up", "enough", "had enough", "i am furious", "furious",
  "রাগ", "মেজাজ খারাপ", "অসহ্য", "আর পারছি না", "rag lagche", "rag hocche", "mejaj kharap", "osojho",
);
const ESCALATION_REQUEST = phrases(
  "manager", "supervisor", "higher authority", "complain", "complaint", "legal action", "consumer rights", "cancel (?:my )?connection", "change (?:the )?provider", "disconnect my line",
  "অভিযোগ", "ম্যানেজার", "লাইন কেটে দিন", "অন্য কোম্পানি", "complain korbo", "line kete din",
);
const REPEATED = phrases(
  "how many times", "again and again", "every time", "always the same", "same problem again", "told you (?:many|so many) times", "every day the same",
  "সবসময় একই", "বারবার", "কতবার", "আবারও", "আবার একই", "প্রতিদিন একই", "barbar", "bar bar", "kotobar", "abaro", "always eki", "sobsomoy eki",
);
const URGENCY = phrases(
  "urgent", "urgently", "asap", "immediately", "right now", "emergency", "fix (?:this|it) now", "do it now",
  "জরুরি", "এখনই", "এক্ষুনি", "তাড়াতাড়ি", "joruri", "ekhoni", "ekkhuni", "taratari",
);
const CONFUSION = phrases(
  "don'?t understand", "do not understand", "not clear", "confused", "what do you mean", "makes no sense",
  "বুঝতে পারছি না", "বুঝলাম না", "বুঝিনি", "bujhte parchi na", "bujhlam na", "bujhi nai",
);
const CONCERN = phrases(
  "still not working", "not working", "still not", "no internet", "how long", "when will", "still waiting", "no response", "no reply",
  "কাজ করছে না", "নেট নেই", "কতক্ষণ", "কখন ঠিক হবে", "এখনো", "kaj korche na", "net nai", "kotokhon", "kokhon thik hobe", "ekhono",
);
const POSITIVE = phrases(
  "thanks?", "thank you", "great", "amazing", "excellent", "perfect", "awesome", "good job", "well done", "solved", "working now", "satisfied",
  "ধন্যবাদ", "ভালো", "চমৎকার", "দারুণ", "ঠিক আছে এখন", "dhonnobad", "valo", "darun", "thik ache ekhon",
);

const ANGRY_EMOJI = /[😡🤬😠👿💢🖕]/u;
const NEGATIVE_EMOJI = /[👎😤😒🙄😑💩]/u;
const SAD_EMOJI = /[😢😭😞😔😩😫🥺]/u;
const POSITIVE_EMOJI = /[👍🙏❤️😊😀😁🥰😍✅👌🎉💯]|❤/u;

const ANGRY_REACTIONS = new Set(["😡", "😠", "🤬", "👿"]);
const NEGATIVE_REACTIONS = new Set(["👎", "😢", "😭", "😤", "🙄"]);
const POSITIVE_REACTIONS = new Set(["👍", "❤️", "❤", "🙏", "😊", "👌", "😂", "🥰"]);

export interface MoodInput {
  /** The message text (a provider placeholder such as "[Sticker]" counts as no text). */
  text: string;
  isSticker: boolean;
  /** A reaction emoji, when the provider reports one. */
  reaction?: string | null;
  sources: MoodSources;
  /** This same customer's earlier messages in this group, oldest first, for burst/repeat context. */
  recent?: Array<{ text: string; at: number }>;
  now: number;
}

export interface MoodReading {
  mood: Mood;
  /** 0–1. */
  confidence: number;
  /** The candidate moods with their scores (0–1). */
  scores: Partial<Record<Mood, number>>;
  signals: MoodSignal[];
  /** Ambiguous or contextual — worth an AI classification if one is allowed. */
  needsAi: boolean;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The cheap, deterministic reading. Returns NEUTRAL with no signals for a message with no emotional content. */
export function detectMood(input: MoodInput): MoodReading {
  const contributions: Partial<Record<Mood, number[]>> = {};
  const signals = new Set<MoodSignal>();
  const add = (mood: Mood, score: number, signal: MoodSignal) => {
    (contributions[mood] ??= []).push(score);
    signals.add(signal);
  };

  const rawText = input.text ?? "";
  const placeholder = /^\[(sticker|image|video|audio|voice|document|gif)[^\]]*\]$/i.test(rawText.trim());
  const text = placeholder ? "" : norm(rawText);

  if (input.isSticker && input.sources.stickers) signals.add("UNKNOWN_STICKER_SIGNAL");

  if (input.sources.text && text) {
    if (STRONG_NEGATIVE.test(text)) add("ANGRY", 0.75, "STRONG_NEGATIVE_LANGUAGE");
    if (NEGATIVE.test(text)) add("FRUSTRATED", 0.7, "NEGATIVE_LANGUAGE");
    if (ANGER_STATEMENT.test(text)) add("ANGRY", 0.85, "ANGER_STATEMENT");
    if (ESCALATION_REQUEST.test(text)) add("ANGRY", 0.6, "ESCALATION_REQUEST");
    if (REPEATED.test(text)) add("FRUSTRATED", 0.75, "REPEATED_COMPLAINT");
    if (URGENCY.test(text)) add("URGENT", 0.7, "URGENCY");
    if (CONFUSION.test(text)) add("CONFUSED", 0.7, "CONFUSION");
    if (CONCERN.test(text)) add("CONCERNED", 0.55, "CONCERN");
    if (POSITIVE.test(text)) add("POSITIVE", 0.6, "POSITIVE_LANGUAGE");
    // Shouting: three or more capitalised Latin words of four letters or more.
    if ((rawText.match(/\b[A-Z]{4,}\b/g) ?? []).length >= 3) signals.add("SHOUTING");
    if (/[!?]{3,}|\?!|!\?/.test(rawText)) signals.add("EXCESSIVE_PUNCTUATION");
  }
  if (input.sources.emoji && rawText) {
    const angryCount = [...rawText].filter((ch) => ANGRY_EMOJI.test(ch)).length;
    if (angryCount > 0) add("ANGRY", angryCount > 1 ? 0.9 : 0.85, "ANGRY_EMOJI");
    if (NEGATIVE_EMOJI.test(rawText)) add("FRUSTRATED", 0.6, "NEGATIVE_EMOJI");
    if (SAD_EMOJI.test(rawText)) add("CONCERNED", 0.5, "SAD_EMOJI");
    if (POSITIVE_EMOJI.test(rawText)) add("POSITIVE", 0.6, "POSITIVE_EMOJI");
  }
  if (input.reaction) {
    // Reactions count only as a supporting signal — a lone reaction rarely carries enough weight
    // to cross a threshold by itself, which is the point.
    if (ANGRY_REACTIONS.has(input.reaction)) add("ANGRY", 0.7, "ANGRY_REACTION");
    else if (NEGATIVE_REACTIONS.has(input.reaction)) add("FRUSTRATED", 0.5, "NEGATIVE_REACTION");
    else if (POSITIVE_REACTIONS.has(input.reaction)) add("POSITIVE", 0.55, "POSITIVE_REACTION");
  }

  // Combine: the strongest contribution, plus a little for every independent one beside it.
  const scores: Partial<Record<Mood, number>> = {};
  for (const [mood, list] of Object.entries(contributions) as Array<[Mood, number[]]>) {
    const sorted = [...list].sort((a, b) => b - a);
    scores[mood] = Math.min(0.97, sorted[0]! + 0.05 * (sorted.length - 1));
  }

  // Anger built from several independent kinds of evidence is worse than any one of them.
  const angerKinds = (["ANGRY_EMOJI", "STRONG_NEGATIVE_LANGUAGE", "ANGER_STATEMENT", "ESCALATION_REQUEST"] as const).filter((s) => signals.has(s)).length;
  if (scores.ANGRY !== undefined) {
    if (signals.has("NEGATIVE_LANGUAGE") || signals.has("REPEATED_COMPLAINT")) scores.ANGRY = Math.min(0.97, scores.ANGRY + 0.04);
    if (angerKinds >= 3 || (angerKinds >= 2 && signals.has("REPEATED_COMPLAINT"))) scores.VERY_ANGRY = scores.ANGRY; // equal score, higher level — the tie goes to the worse mood
  }

  const negativeTop = Math.max(scores.FRUSTRATED ?? 0, scores.ANGRY ?? 0, scores.VERY_ANGRY ?? 0, scores.URGENT ?? 0);
  if (negativeTop > 0) {
    const boost = (signals.has("SHOUTING") ? 0.04 : 0) + (signals.has("EXCESSIVE_PUNCTUATION") ? 0.03 : 0);
    // A burst only matters when there is already something negative in it.
    const recent = (input.recent ?? []).filter((m) => input.now - m.at <= 2 * 60_000);
    if (recent.length >= 2) signals.add("MESSAGE_BURST");
    const burst = signals.has("MESSAGE_BURST") ? 0.03 : 0;
    for (const mood of ["FRUSTRATED", "ANGRY", "VERY_ANGRY", "URGENT"] as const) {
      if (scores[mood] !== undefined) scores[mood] = Math.min(0.97, scores[mood]! + boost + burst);
    }
  }

  // A complaint repeated across this customer's own recent messages is a repeated complaint even
  // when this message does not say "again".
  const priorNegatives = (input.recent ?? []).filter((m) => {
    const t = norm(m.text);
    return CONCERN.test(t) || NEGATIVE.test(t) || REPEATED.test(t);
  }).length;
  if (priorNegatives >= 2 && (scores.CONCERNED !== undefined || scores.FRUSTRATED !== undefined)) {
    signals.add("REPEATED_COMPLAINT");
    scores.FRUSTRATED = Math.min(0.97, Math.max(scores.FRUSTRATED ?? 0, 0.7) + 0.05);
  }

  // Mixed: praise beside anger ("wow that's amazing 😡") is not safe to read either way.
  let needsAi = false;
  if ((scores.POSITIVE ?? 0) > 0 && negativeTop > 0) {
    signals.add("MIXED_SIGNALS");
    for (const mood of Object.keys(scores) as Mood[]) scores[mood] = scores[mood]! * 0.75;
    needsAi = true;
  }

  const ranked = (Object.entries(scores) as Array<[Mood, number]>).sort((a, b) => b[1] - a[1] || MOOD_LEVEL[b[0]] - MOOD_LEVEL[a[0]]);
  const [mood, confidence] = ranked[0] ?? (["NEUTRAL", 0] as [Mood, number]);
  if (MOOD_LEVEL[mood] >= 2 && confidence >= 0.5 && confidence < 0.85) needsAi = true;
  if (MOOD_LEVEL[mood] >= 1 && text.length > 120) needsAi = true;

  const rounded: Partial<Record<Mood, number>> = {};
  for (const [m, s] of Object.entries(scores) as Array<[Mood, number]>) rounded[m] = round(s);
  return { mood, confidence: round(confidence), scores: rounded, signals: MOOD_SIGNALS.filter((s) => signals.has(s)), needsAi };
}

/** Whether a reading carries anything worth recording at all — the pre-filter for the whole feature. */
export const hasMoodSignal = (reading: MoodReading) => reading.signals.length > 0;

// ---------------------------------------------------------------------------------------------
// Trend

export interface PreviousMood {
  mood: Mood;
  at: number;
}

/** How far back a customer's earlier moods in a group still shape this one. */
export const MOOD_TREND_WINDOW_MS = 6 * 3_600_000;

/**
 * The reading in the light of this customer's earlier moods in this group (oldest first). A rise
 * since their last reading adds a little confidence; a sustained climb into anger — neutral or
 * concerned, then frustrated, then angry — is an escalating pattern and reads as very angry.
 */
export function applyMoodTrend(reading: MoodReading, previous: readonly PreviousMood[], now: number): { reading: MoodReading; previousMood: Mood } {
  const recent = previous.filter((p) => now - p.at <= MOOD_TREND_WINDOW_MS);
  const previousMood = recent.at(-1)?.mood ?? "NEUTRAL";
  const signals = new Set(reading.signals);
  let { mood, confidence } = reading;
  const scores = { ...reading.scores };

  const level = MOOD_LEVEL[mood];
  if (level >= 2 && level > MOOD_LEVEL[previousMood] && MOOD_LEVEL[previousMood] >= 1) {
    signals.add("MOOD_ROSE");
    confidence = round(Math.min(0.97, confidence + 0.05));
  }
  const levels = [...recent.map((p) => MOOD_LEVEL[p.mood]), level];
  const lastThree = levels.slice(-3);
  const climbing = lastThree.length === 3 && lastThree[0]! < lastThree[1]! && lastThree[1]! < lastThree[2]!;
  if (climbing && level >= 3) {
    signals.add("ESCALATING_PATTERN");
    if (mood === "ANGRY") {
      mood = "VERY_ANGRY";
      scores.VERY_ANGRY = confidence;
    }
  }
  scores[mood] = Math.max(scores[mood] ?? 0, confidence);
  return { reading: { ...reading, mood, confidence, scores, signals: MOOD_SIGNALS.filter((s) => signals.has(s)) }, previousMood };
}

// ---------------------------------------------------------------------------------------------
// Decision

export interface MoodDecision {
  triggered: boolean;
  level: number;
  policy: MoodPolicy | null;
  /** Why it did or did not trigger, in words. */
  because: string;
}

/** Detection → threshold → the mood's policy. Detection never acts by itself. */
export function decideMoodTrigger(reading: Pick<MoodReading, "mood" | "confidence">, policies: MoodPolicies, thresholdPercent: number): MoodDecision {
  const level = MOOD_LEVEL[reading.mood];
  const policy = (TRIGGERABLE_MOODS as readonly string[]).includes(reading.mood) ? policies[reading.mood as TriggerableMood] : null;
  if (!policy) return { triggered: false, level, policy: null, because: `${MOOD_LABELS[reading.mood]} is recorded, never acted on.` };
  if (!policy.trigger) return { triggered: false, level, policy, because: `${MOOD_LABELS[reading.mood]} is not a trigger in Mood Detection settings.` };
  const percent = Math.round(reading.confidence * 100);
  if (percent < thresholdPercent) return { triggered: false, level, policy, because: `Confidence ${percent}% is below the ${thresholdPercent}% threshold.` };
  return { triggered: true, level, policy, because: `${MOOD_LABELS[reading.mood]} at ${percent}%, at or above the ${thresholdPercent}% threshold.` };
}

// ---------------------------------------------------------------------------------------------
// Group mood

/**
 * The conversation's overall mood from each customer's latest mood in it — an aggregate, never a
 * replacement for the per-customer readings. The worst customer sets it, one step softer when they
 * are the only unhappy one among several: one angry customer beside two calm ones makes the group
 * frustrated, not angry.
 */
export function groupMood(latestPerCustomer: readonly Mood[]): Mood {
  if (latestPerCustomer.length === 0) return "NEUTRAL";
  const worst = [...latestPerCustomer].sort((a, b) => MOOD_LEVEL[b] - MOOD_LEVEL[a])[0]!;
  const level = MOOD_LEVEL[worst];
  if (level === 0) return latestPerCustomer.includes("POSITIVE") && latestPerCustomer.every((m) => MOOD_LEVEL[m] === 0) ? "POSITIVE" : "NEUTRAL";
  const atWorst = latestPerCustomer.filter((m) => MOOD_LEVEL[m] >= level).length;
  if (latestPerCustomer.length >= 3 && atWorst * 2 < latestPerCustomer.length) {
    const softer: Record<number, Mood> = { 1: "NEUTRAL", 2: "CONCERNED", 3: "FRUSTRATED", 4: "ANGRY" };
    return softer[level] ?? worst;
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------
// AI classification (text-only prompt and a fail-closed parser)

export const MOOD_AI_SYSTEM_PROMPT = [
  "You classify the emotional state of ONE customer in a WhatsApp support group.",
  "Read the conversation and judge only the customer marked [CUSTOMER]; [SUPPORT] is the company and [OTHER] is someone else.",
  "Messages may be in English, Bangla or Banglish (Bangla in Latin letters).",
  "Ordinary support language — \"please check\", \"I am waiting\", \"why is this happening?\" — is NEUTRAL or CONCERNED, not angry.",
  "Sarcasm and mixed messages need care; if you are unsure, give a lower confidence.",
  "",
  "Answer in exactly this format and nothing else:",
  `MOOD: one of ${MOODS.join(", ")}`,
  "CONFIDENCE: a number from 0 to 100",
  `SIGNALS: zero or more of ${MOOD_SIGNALS.filter((s) => !["AI_CLASSIFIED", "MOOD_ROSE", "ESCALATING_PATTERN", "UNKNOWN_STICKER_SIGNAL"].includes(s)).join(", ")}, comma separated`,
].join("\n");

/** Parses the model's answer. Anything unrecognisable returns null, and the deterministic reading stands. */
export function parseMoodAiAnswer(text: string): { mood: Mood; confidence: number; signals: MoodSignal[] } | null {
  const mood = /MOOD:\s*([A-Z_]+)/i.exec(text)?.[1]?.toUpperCase();
  const confidence = Number(/CONFIDENCE:\s*(\d{1,3}(?:\.\d+)?)/i.exec(text)?.[1]);
  if (!isMood(mood) || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
  const signalText = /SIGNALS:\s*([^\n]*)/i.exec(text)?.[1] ?? "";
  const signals = signalText
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(isMoodSignal);
  return { mood, confidence: round(confidence / 100), signals };
}

/** The AI's reading, merged onto the deterministic one: the AI decides the mood, the signals are both. */
export function mergeAiReading(base: MoodReading, ai: { mood: Mood; confidence: number; signals: MoodSignal[] }): MoodReading {
  const signals = new Set<MoodSignal>([...base.signals, ...ai.signals, "AI_CLASSIFIED"]);
  return {
    mood: ai.mood,
    confidence: ai.confidence,
    scores: { ...base.scores, [ai.mood]: ai.confidence },
    signals: MOOD_SIGNALS.filter((s) => signals.has(s)),
    needsAi: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Actions

/** The actions an alert can carry. One MoodAlertAction row each, retried independently. */
export const MOOD_ACTIONS = ["CONVERSATION", "NEEDS_ATTENTION", "NOTIFY_TEAM", "INTERNAL_ALERT", "CUSTOMER_MESSAGE"] as const;
export type MoodAction = (typeof MOOD_ACTIONS)[number];

export const MOOD_ACTION_LABELS: Record<MoodAction, string> = {
  CONVERSATION: "Conversation behaviour",
  NEEDS_ATTENTION: "Marked as needing attention",
  NOTIFY_TEAM: "Team notified (Notification Center)",
  INTERNAL_ALERT: "Internal escalation group alerted",
  CUSTOMER_MESSAGE: "Message sent to the customer",
};

/** The actions a policy switches on, in the order they should run — the pause first. */
export function actionsForPolicy(policy: MoodPolicy): MoodAction[] {
  const out: MoodAction[] = [];
  if (policy.conversation !== "CONTINUE") out.push("CONVERSATION");
  if (policy.needsAttention) out.push("NEEDS_ATTENTION");
  if (policy.notifyTeam) out.push("NOTIFY_TEAM");
  if (policy.internalAlert) out.push("INTERNAL_ALERT");
  if (policy.customerMessage) out.push("CUSTOMER_MESSAGE");
  return out;
}

const BEHAVIOUR_RANK: Record<ConversationBehaviour, number> = { CONTINUE: 0, PAUSE_AI: 1, REQUIRE_HUMAN: 2 };
export const strongerBehaviour = (a: ConversationBehaviour, b: ConversationBehaviour): boolean => BEHAVIOUR_RANK[a] > BEHAVIOUR_RANK[b];

/**
 * The outbound idempotency variant of the customer-facing mood message. Like the handover mention
 * and the holding reply, it is sent BECAUSE nobody has answered, so the AI reply cooldown neither
 * counts it nor holds it back.
 */
export const MOOD_CUSTOMER_MESSAGE_VARIANT = "mood-escalation";

/** The customer-facing template for a mood, when there is one. */
export function moodCustomerTemplateKey(mood: Mood): string | null {
  if (mood === "FRUSTRATED" || mood === "ANGRY" || mood === "VERY_ANGRY" || mood === "URGENT") return `MOOD_CUSTOMER_${mood}`;
  return null;
}

/** "Concerned → Frustrated → Angry", from the previous moods and the current one; empty when it did not rise. */
export function describeMoodTrend(previous: readonly Mood[], current: Mood): string {
  const chain = [...previous, current].filter((m, i, all) => i === 0 || m !== all[i - 1]);
  const rising = chain.filter((m, i) => i === 0 || MOOD_LEVEL[m] > MOOD_LEVEL[chain[i - 1]!]);
  return rising.length >= 2 ? rising.map((m) => MOOD_LABELS[m]).join(" → ") : "";
}

/**
 * The customer's mood at a given moment — the foundation for "mood at the time of the response" in
 * Response Time reporting: the latest reading at or before that moment, inside the trend window.
 * Null when nothing was read, which means "no signal recorded", never "calm".
 */
export function moodAtTime(readings: readonly PreviousMood[], at: number): Mood | null {
  let found: PreviousMood | null = null;
  for (const r of readings) {
    if (r.at <= at && at - r.at <= MOOD_TREND_WINDOW_MS && (!found || r.at > found.at)) found = r;
  }
  return found?.mood ?? null;
}
