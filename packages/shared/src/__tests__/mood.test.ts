import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOOD_POLICIES,
  actionsForPolicy,
  describeMoodTrend,
  moodAtTime,
  applyMoodTrend,
  decideMoodTrigger,
  detectMood,
  groupMood,
  hasMoodSignal,
  mergeAiReading,
  moodThreshold,
  parseMoodAiAnswer,
  parseMoodPolicies,
  type MoodInput,
} from "../mood.js";

const NOW = Date.UTC(2026, 9, 5, 6, 0, 0);
const ALL = { text: true, emoji: true, stickers: true };
const read = (text: string, extra: Partial<MoodInput> = {}) => detectMood({ text, isSticker: false, sources: ALL, now: NOW, ...extra });
const BALANCED = moodThreshold("BALANCED", 80);

describe("detectMood — the deterministic pre-filter", () => {
  it.each([
    "Hello, my bill for this month?",
    "please check",
    "I am waiting",
    "Why is this happening?",
    "ok",
    "My customer id is 4471",
  ])("ordinary support language carries no mood signal: %s", (text) => {
    const r = read(text);
    expect(hasMoodSignal(r)).toBe(false);
    expect(r.mood).toBe("NEUTRAL");
    expect(decideMoodTrigger(r, DEFAULT_MOOD_POLICIES, BALANCED).triggered).toBe(false);
  });

  it("a polite question about a fault is concerned at most, never angry", () => {
    const r = read("internet still not working, when will it be fixed?");
    expect(r.mood).toBe("CONCERNED");
    expect(decideMoodTrigger(r, DEFAULT_MOOD_POLICIES, BALANCED).triggered).toBe(false);
  });

  it("clear anger crosses the default threshold", () => {
    const r = read("Worst service ever 😡");
    expect(r.mood).toBe("ANGRY");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.signals).toEqual(expect.arrayContaining(["STRONG_NEGATIVE_LANGUAGE", "ANGRY_EMOJI"]));
    expect(decideMoodTrigger(r, DEFAULT_MOOD_POLICIES, BALANCED).triggered).toBe(true);
  });

  it("several independent kinds of anger read as very angry", () => {
    const r = read("I am very angry, this is the worst service, I will complain to your manager 😡");
    expect(r.mood).toBe("VERY_ANGRY");
    expect(decideMoodTrigger(r, DEFAULT_MOOD_POLICIES, BALANCED).policy?.conversation).toBe("REQUIRE_HUMAN");
  });

  it.each([
    ["Bangla", "আপনাদের সার্ভিস খুবই বাজে, মেজাজ খারাপ"],
    ["Banglish", "baje service, mejaj kharap hoye gese"],
  ])("reads %s anger", (_lang, text) => {
    const r = read(text);
    expect(r.mood).toBe("ANGRY");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("a Bangla repeated complaint is frustration", () => {
    const r = read("বারবার একই সমস্যা");
    expect(r.mood).toBe("FRUSTRATED");
    expect(r.signals).toContain("REPEATED_COMPLAINT");
  });

  it("an emoji alone is enough evidence when it is unambiguous", () => {
    const r = read("😡😡");
    expect(r.mood).toBe("ANGRY");
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("a positive emoji is recorded and never acted on", () => {
    const r = read("👍");
    expect(r.mood).toBe("POSITIVE");
    const d = decideMoodTrigger(r, DEFAULT_MOOD_POLICIES, 50);
    expect(d.triggered).toBe(false);
    expect(d.policy).toBeNull();
  });

  it("a sticker is an unknown signal — never a guessed emotion", () => {
    const r = detectMood({ text: "[Sticker]", isSticker: true, sources: ALL, now: NOW });
    expect(r.signals).toEqual(["UNKNOWN_STICKER_SIGNAL"]);
    expect(r.mood).toBe("NEUTRAL");
    expect(decideMoodTrigger(r, DEFAULT_MOOD_POLICIES, 50).triggered).toBe(false);
  });

  it("switched-off sources contribute nothing", () => {
    const none = { text: false, emoji: false, stickers: false };
    expect(hasMoodSignal(detectMood({ text: "worst service 😡", isSticker: false, sources: none, now: NOW }))).toBe(false);
    expect(detectMood({ text: "worst service 😡", isSticker: false, sources: { ...none, emoji: true }, now: NOW }).signals).toEqual(["ANGRY_EMOJI"]);
    expect(detectMood({ text: "[Sticker]", isSticker: true, sources: { ...none, text: true }, now: NOW }).signals).toEqual([]);
  });

  it("sarcasm-shaped mixed messages are softened and sent to AI, not trusted", () => {
    const r = read("wow amazing service 😡");
    expect(r.signals).toContain("MIXED_SIGNALS");
    expect(r.needsAi).toBe(true);
    expect(r.confidence).toBeLessThan(0.8);
    expect(decideMoodTrigger(r, DEFAULT_MOOD_POLICIES, BALANCED).triggered).toBe(false);
  });

  it("the same complaint across this customer's recent messages is a repeated complaint", () => {
    const recent = [
      { text: "net nai", at: NOW - 40 * 60_000 },
      { text: "still not working", at: NOW - 20 * 60_000 },
    ];
    const r = read("internet still not working", { recent });
    expect(r.signals).toContain("REPEATED_COMPLAINT");
    expect(r.mood).toBe("FRUSTRATED");
  });

  it("a burst only strengthens a reading that is already negative", () => {
    const recent = [
      { text: "hello", at: NOW - 30_000 },
      { text: "hello??", at: NOW - 15_000 },
    ];
    expect(hasMoodSignal(read("hello", { recent }))).toBe(false);
    const angry = read("worst service", { recent });
    expect(angry.signals).toContain("MESSAGE_BURST");
    expect(angry.confidence).toBeGreaterThan(read("worst service").confidence);
  });

  it("reactions are supporting evidence and sit below the default threshold alone", () => {
    const r = read("", { reaction: "😡" });
    expect(r.signals).toEqual(["ANGRY_REACTION"]);
    expect(decideMoodTrigger(r, DEFAULT_MOOD_POLICIES, BALANCED).triggered).toBe(false);
  });
});

describe("decideMoodTrigger — detection never acts by itself", () => {
  const angry = { mood: "ANGRY" as const, confidence: 0.82 };

  it("respects the confidence threshold", () => {
    expect(decideMoodTrigger(angry, DEFAULT_MOOD_POLICIES, 80).triggered).toBe(true);
    const below = decideMoodTrigger(angry, DEFAULT_MOOD_POLICIES, 90);
    expect(below.triggered).toBe(false);
    expect(below.because).toMatch(/below the 90% threshold/);
  });

  it("respects an emotion switched off as a trigger", () => {
    const policies = parseMoodPolicies({ ANGRY: { trigger: false } });
    const d = decideMoodTrigger(angry, policies, 50);
    expect(d.triggered).toBe(false);
    expect(d.because).toMatch(/not a trigger/);
  });

  it("concerned and confused are off by default", () => {
    expect(decideMoodTrigger({ mood: "CONCERNED", confidence: 0.95 }, DEFAULT_MOOD_POLICIES, 50).triggered).toBe(false);
    expect(decideMoodTrigger({ mood: "CONFUSED", confidence: 0.95 }, DEFAULT_MOOD_POLICIES, 50).triggered).toBe(false);
  });
});

describe("moodThreshold — sensitivity presets", () => {
  it("maps presets and clamps a custom value", () => {
    expect(moodThreshold("LOW", 10)).toBe(90);
    expect(moodThreshold("BALANCED", 10)).toBe(80);
    expect(moodThreshold("HIGH", 10)).toBe(65);
    expect(moodThreshold("CUSTOM", 72)).toBe(72);
    expect(moodThreshold("CUSTOM", 5)).toBe(50);
    expect(moodThreshold("CUSTOM", 140)).toBe(99);
  });
});

describe("parseMoodPolicies — stored settings read safely", () => {
  it("fills missing and malformed values from the defaults", () => {
    const p = parseMoodPolicies({ ANGRY: { notifyTeam: "yes", priority: "NOPE", conversation: "REQUIRE_HUMAN" }, BOGUS: {} });
    expect(p.ANGRY.notifyTeam).toBe(DEFAULT_MOOD_POLICIES.ANGRY.notifyTeam);
    expect(p.ANGRY.priority).toBe("HIGH");
    expect(p.ANGRY.conversation).toBe("REQUIRE_HUMAN");
    expect(parseMoodPolicies(null)).toEqual(DEFAULT_MOOD_POLICIES);
    expect(Object.keys(p)).not.toContain("BOGUS");
  });

  it("a mention without an internal alert has nowhere to go and is dropped", () => {
    expect(parseMoodPolicies({ ANGRY: { internalAlert: false, mentionMember: true } }).ANGRY.mentionMember).toBe(false);
  });

  it("defaults: angry pauses AI at HIGH, very angry requires a person at CRITICAL, nobody customer-messaged", () => {
    expect(DEFAULT_MOOD_POLICIES.ANGRY).toMatchObject({ conversation: "PAUSE_AI", priority: "HIGH" });
    expect(DEFAULT_MOOD_POLICIES.VERY_ANGRY).toMatchObject({ conversation: "REQUIRE_HUMAN", priority: "CRITICAL" });
    expect(Object.values(DEFAULT_MOOD_POLICIES).some((p) => p.customerMessage)).toBe(false);
  });
});

describe("applyMoodTrend — escalation over the conversation", () => {
  it("NEUTRAL → CONCERNED → FRUSTRATED → ANGRY becomes very angry with an escalating pattern", () => {
    const previous = [
      { mood: "CONCERNED" as const, at: NOW - 30 * 60_000 },
      { mood: "FRUSTRATED" as const, at: NOW - 10 * 60_000 },
    ];
    const { reading, previousMood } = applyMoodTrend(read("worst service 😡"), previous, NOW);
    expect(previousMood).toBe("FRUSTRATED");
    expect(reading.mood).toBe("VERY_ANGRY");
    expect(reading.signals).toEqual(expect.arrayContaining(["MOOD_ROSE", "ESCALATING_PATTERN"]));
  });

  it("moods older than the window do not count", () => {
    const previous = [
      { mood: "CONCERNED" as const, at: NOW - 30 * 3_600_000 },
      { mood: "FRUSTRATED" as const, at: NOW - 29 * 3_600_000 },
    ];
    const { reading, previousMood } = applyMoodTrend(read("worst service 😡"), previous, NOW);
    expect(previousMood).toBe("NEUTRAL");
    expect(reading.mood).toBe("ANGRY");
    expect(reading.signals).not.toContain("ESCALATING_PATTERN");
  });

  it("a calm customer staying calm gains nothing", () => {
    const { reading } = applyMoodTrend(read("please check"), [{ mood: "NEUTRAL", at: NOW - 60_000 }], NOW);
    expect(reading.mood).toBe("NEUTRAL");
    expect(reading.signals).toEqual([]);
  });
});

describe("groupMood — an aggregate, never a replacement", () => {
  it("one angry customer alone makes the group angry", () => {
    expect(groupMood(["ANGRY"])).toBe("ANGRY");
    expect(groupMood(["ANGRY", "NEUTRAL"])).toBe("ANGRY");
  });
  it("one angry customer among several calm ones softens the group a step", () => {
    expect(groupMood(["ANGRY", "NEUTRAL", "NEUTRAL"])).toBe("FRUSTRATED");
    expect(groupMood(["ANGRY", "ANGRY", "NEUTRAL"])).toBe("ANGRY");
  });
  it("is neutral with nobody, satisfied when everyone is", () => {
    expect(groupMood([])).toBe("NEUTRAL");
    expect(groupMood(["POSITIVE", "NEUTRAL"])).toBe("POSITIVE");
  });
});

describe("AI classification — fail closed", () => {
  it("parses a well-formed answer", () => {
    expect(parseMoodAiAnswer("MOOD: FRUSTRATED\nCONFIDENCE: 84\nSIGNALS: REPEATED_COMPLAINT, made_up")).toEqual({
      mood: "FRUSTRATED",
      confidence: 0.84,
      signals: ["REPEATED_COMPLAINT"],
    });
  });
  it.each(["", "The customer seems angry.", "MOOD: FURIOUS\nCONFIDENCE: 90", "MOOD: ANGRY\nCONFIDENCE: 900", "MOOD: ANGRY"])("rejects %j", (text) => {
    expect(parseMoodAiAnswer(text)).toBeNull();
  });
  it("the AI decides the mood; the deterministic signals stay", () => {
    const merged = mergeAiReading(read("wow amazing service 😡"), { mood: "ANGRY", confidence: 0.88, signals: [] });
    expect(merged.mood).toBe("ANGRY");
    expect(merged.signals).toEqual(expect.arrayContaining(["MIXED_SIGNALS", "AI_CLASSIFIED", "ANGRY_EMOJI"]));
  });
});

describe("moodAtTime — mood at the time of a response", () => {
  const readings = [
    { mood: "CONCERNED" as const, at: NOW - 50 * 60_000 },
    { mood: "ANGRY" as const, at: NOW - 10 * 60_000 },
  ];
  it("is the latest reading at or before the moment", () => {
    expect(moodAtTime(readings, NOW)).toBe("ANGRY");
    expect(moodAtTime(readings, NOW - 20 * 60_000)).toBe("CONCERNED");
  });
  it("is null before any reading or once the window has passed — never assumed calm", () => {
    expect(moodAtTime(readings, NOW - 60 * 60_000)).toBeNull();
    expect(moodAtTime(readings, NOW + 7 * 3_600_000)).toBeNull();
  });
});

describe("describeMoodTrend and actionsForPolicy", () => {
  it("names a rising trend and nothing else", () => {
    expect(describeMoodTrend(["NEUTRAL", "CONCERNED", "FRUSTRATED"], "ANGRY")).toBe("Neutral → Concerned → Frustrated → Angry");
    expect(describeMoodTrend([], "ANGRY")).toBe("");
    expect(describeMoodTrend(["ANGRY"], "ANGRY")).toBe("");
  });
  it("lists only the switched-on actions, pause first", () => {
    expect(actionsForPolicy(DEFAULT_MOOD_POLICIES.ANGRY)).toEqual(["CONVERSATION", "NEEDS_ATTENTION", "NOTIFY_TEAM", "INTERNAL_ALERT"]);
    expect(actionsForPolicy(DEFAULT_MOOD_POLICIES.FRUSTRATED)).toEqual(["NEEDS_ATTENTION"]);
  });
});
