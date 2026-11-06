import { describe, expect, it } from "vitest";
import {
  countIneligible,
  decideRoutingEligibility,
  DEFAULT_ROUTING_SETTINGS,
  dhakaMinuteOfDay,
  dutyNow,
  isAutoRoutingContext,
  pickRoutingAgent,
  routingCovers,
  routingReplyKey,
  sanitizeRoutingSettings,
  type RoutingCandidateFacts,
} from "../autoRouting.js";

const NOW = new Date("2026-11-07T06:00:00.000Z"); // 12:00 in Dhaka

const facts = (over: Partial<RoutingCandidateFacts> = {}): RoutingCandidateFacts => ({
  userId: "u1",
  name: "A",
  activeLogin: true,
  projectAccess: true,
  canReply: true,
  teamMemberLinked: true,
  duty: "ON_DUTY",
  lastSeenAt: NOW,
  openCount: 0,
  ...over,
});
const settings = { ...DEFAULT_ROUTING_SETTINGS, maxOpenPerAgent: 3 };

describe("pickRoutingAgent", () => {
  const three = [
    { userId: "c", openCount: 0 },
    { userId: "a", openCount: 0 },
    { userId: "b", openCount: 0 },
  ];
  it("round robin takes turns in id order, wrapping, starting at the first", () => {
    expect(pickRoutingAgent(three, "ROUND_ROBIN", null)).toBe("a");
    expect(pickRoutingAgent(three, "ROUND_ROBIN", "a")).toBe("b");
    expect(pickRoutingAgent(three, "ROUND_ROBIN", "b")).toBe("c");
    expect(pickRoutingAgent(three, "ROUND_ROBIN", "c")).toBe("a");
  });
  it("round robin continues after a last pick who is no longer eligible", () => {
    expect(pickRoutingAgent([{ userId: "a", openCount: 0 }, { userId: "c", openCount: 0 }], "ROUND_ROBIN", "b")).toBe("c");
    expect(pickRoutingAgent([{ userId: "a", openCount: 0 }], "ROUND_ROBIN", "a")).toBe("a");
  });
  it("least open picks the fewest, and ties take turns from the last pick", () => {
    expect(pickRoutingAgent([{ userId: "a", openCount: 4 }, { userId: "b", openCount: 1 }, { userId: "c", openCount: 2 }], "LEAST_OPEN", null)).toBe("b");
    expect(pickRoutingAgent(three, "LEAST_OPEN", "a")).toBe("b");
    expect(pickRoutingAgent(three, "LEAST_OPEN", "c")).toBe("a");
  });
  it("nobody eligible is null — never a fallback", () => {
    expect(pickRoutingAgent([], "ROUND_ROBIN", "a")).toBeNull();
  });
});

describe("decideRoutingEligibility", () => {
  it("is eligible with every fact in order", () => {
    expect(decideRoutingEligibility(facts(), settings, NOW)).toEqual({ eligible: true });
  });
  it("names the first failing reason", () => {
    expect(decideRoutingEligibility(facts({ activeLogin: false }), settings, NOW)).toEqual({ eligible: false, reason: "INACTIVE_LOGIN" });
    expect(decideRoutingEligibility(facts({ projectAccess: false }), settings, NOW)).toEqual({ eligible: false, reason: "NO_PROJECT_ACCESS" });
    expect(decideRoutingEligibility(facts({ canReply: false }), settings, NOW)).toEqual({ eligible: false, reason: "NO_PERMISSION" });
    expect(decideRoutingEligibility(facts({ openCount: 3 }), settings, NOW)).toEqual({ eligible: false, reason: "AT_CAPACITY" });
  });
  it("leave always excludes; the roster only when asked", () => {
    expect(decideRoutingEligibility(facts({ duty: "ON_LEAVE" }), settings, NOW)).toEqual({ eligible: false, reason: "ON_LEAVE" });
    expect(decideRoutingEligibility(facts({ duty: "OFF_SHIFT" }), settings, NOW)).toEqual({ eligible: true });
    const onDuty = { ...settings, onlyOnDuty: true };
    expect(decideRoutingEligibility(facts({ duty: "OFF_SHIFT" }), onDuty, NOW)).toEqual({ eligible: false, reason: "NOT_ON_DUTY" });
    expect(decideRoutingEligibility(facts({ duty: "NOT_SCHEDULED" }), onDuty, NOW)).toEqual({ eligible: false, reason: "NOT_ON_DUTY" });
    expect(decideRoutingEligibility(facts({ teamMemberLinked: false, duty: null }), onDuty, NOW)).toEqual({ eligible: false, reason: "NOT_ON_ROSTER" });
  });
  it("seen recently only when asked", () => {
    const seen = { ...settings, requireRecentlySeen: true, recentlySeenMinutes: 15 };
    expect(decideRoutingEligibility(facts({ lastSeenAt: new Date(NOW.getTime() - 16 * 60_000) }), settings, NOW).eligible).toBe(true);
    expect(decideRoutingEligibility(facts({ lastSeenAt: new Date(NOW.getTime() - 16 * 60_000) }), seen, NOW)).toEqual({ eligible: false, reason: "NOT_SEEN_RECENTLY" });
    expect(decideRoutingEligibility(facts({ lastSeenAt: null }), seen, NOW)).toEqual({ eligible: false, reason: "NOT_SEEN_RECENTLY" });
    expect(decideRoutingEligibility(facts({ lastSeenAt: new Date(NOW.getTime() - 14 * 60_000) }), seen, NOW).eligible).toBe(true);
  });
  it("counts reasons only", () => {
    const r = [decideRoutingEligibility(facts({ openCount: 9 }), settings, NOW), decideRoutingEligibility(facts({ openCount: 9 }), settings, NOW), decideRoutingEligibility(facts(), settings, NOW)];
    expect(countIneligible(r)).toEqual({ AT_CAPACITY: 2 });
  });
});

describe("dutyNow", () => {
  const day = (status: "DUTY" | "OFF" | "LEAVE" | "HOLIDAY" | "UNASSIGNED", start: number | null = 600, end: number | null = 1140) => ({ status, shiftStartMinute: start, shiftEndMinute: end });
  const base = { today: null, yesterday: null, onApprovedLeave: false, override: null, minuteOfDay: 720 } as const;
  it("reads the Dhaka clock", () => {
    expect(dhakaMinuteOfDay(NOW)).toBe(720);
    expect(dhakaMinuteOfDay(new Date("2026-11-06T18:30:00.000Z"))).toBe(30);
  });
  it("inside, outside and without shift times", () => {
    expect(dutyNow({ ...base, today: day("DUTY") })).toBe("ON_DUTY");
    expect(dutyNow({ ...base, today: day("DUTY"), minuteOfDay: 1140 })).toBe("OFF_SHIFT");
    expect(dutyNow({ ...base, today: day("DUTY", null, null), minuteOfDay: 5 })).toBe("ON_DUTY");
  });
  it("a shift past midnight counts on both sides of it", () => {
    expect(dutyNow({ ...base, today: day("DUTY", 1320, 360), minuteOfDay: 1400 })).toBe("ON_DUTY");
    expect(dutyNow({ ...base, yesterday: day("DUTY", 1320, 360), today: day("OFF"), minuteOfDay: 120 })).toBe("ON_DUTY");
    expect(dutyNow({ ...base, yesterday: day("DUTY", 1320, 360), today: day("OFF"), minuteOfDay: 400 })).toBe("OFF");
  });
  it("leave, a manager's verdict, days off and an undecided date", () => {
    expect(dutyNow({ ...base, today: day("DUTY"), onApprovedLeave: true })).toBe("ON_LEAVE");
    expect(dutyNow({ ...base, today: day("LEAVE") })).toBe("ON_LEAVE");
    expect(dutyNow({ ...base, today: day("DUTY"), override: "ABSENT" })).toBe("MARKED_ABSENT");
    expect(dutyNow({ ...base, today: day("HOLIDAY") })).toBe("OFF");
    expect(dutyNow({ ...base, today: day("UNASSIGNED") })).toBe("NOT_SCHEDULED");
    expect(dutyNow(base)).toBe("NOT_SCHEDULED");
  });
});

describe("settings", () => {
  const good = { enabled: true, channels: ["TELEGRAM", "NOPE", "TELEGRAM"], method: "LEAST_OPEN", maxOpenPerAgent: "10", poolTeamIds: ["t1", "bad id!"], poolUserIds: [], recentlySeenMinutes: 15 };
  it("keeps known values and drops the rest", () => {
    const r = sanitizeRoutingSettings(good);
    expect(r).toMatchObject({ ok: true, value: { channels: ["TELEGRAM"], method: "LEAST_OPEN", maxOpenPerAgent: 10, poolTeamIds: ["t1"], includeWhatsAppGroups: false } });
  });
  it("refuses out-of-range numbers, an unknown method, and switching on with nothing to route or nobody to route to", () => {
    expect(sanitizeRoutingSettings({ ...good, maxOpenPerAgent: 0 }).ok).toBe(false);
    expect(sanitizeRoutingSettings({ ...good, recentlySeenMinutes: 5 }).ok).toBe(false);
    expect(sanitizeRoutingSettings({ ...good, method: "RANDOM" }).ok).toBe(false);
    expect(sanitizeRoutingSettings({ ...good, channels: [] }).ok).toBe(false);
    expect(sanitizeRoutingSettings({ ...good, poolTeamIds: [] }).ok).toBe(false);
    expect(sanitizeRoutingSettings({ ...good, enabled: false, poolTeamIds: [] }).ok).toBe(true);
  });
  it("groups are offered separately; WhatsApp needs messages.reply, channels conversations.reply", () => {
    expect(routingCovers({ channels: ["WHATSAPP_PERSONAL"], includeWhatsAppGroups: false }, "WHATSAPP_GROUP")).toBe(false);
    expect(routingCovers({ channels: [], includeWhatsAppGroups: true }, "WHATSAPP_GROUP")).toBe(true);
    expect(routingReplyKey("WHATSAPP_PERSONAL")).toBe("messages.reply");
    expect(routingReplyKey("WEBCHAT")).toBe("conversations.reply");
  });
  it("recognises its own event context", () => {
    expect(isAutoRoutingContext({ reason: "AUTO_ROUTING", method: "ROUND_ROBIN", via: "AUTOMATIC" })).toBe(true);
    expect(isAutoRoutingContext({ reason: "CUSTOMER_MESSAGE" })).toBe(false);
    expect(isAutoRoutingContext(null)).toBe(false);
  });
});
