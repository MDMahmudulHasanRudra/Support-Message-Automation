import { describe, expect, it } from "vitest";
import {
  previewIdentityChange,
  type PreviewMessage,
  type PreviewRosterEntry,
} from "../index.js";

/** Identity-change preview, pure. Synthetic ids only; no text is part of the input or the output. */

const T0 = Date.UTC(2026, 9, 10, 6, 0, 0);
const LID = "100000000001";
const PHONE = "8801000000001";

const member = (id: string, phoneNumber: string, over: Partial<PreviewRosterEntry> = {}): PreviewRosterEntry => ({
  id,
  phoneNumber,
  whatsappId: null,
  userId: null,
  ...over,
});

let seq = 0;
function msg(over: Partial<PreviewMessage> & { sender?: string; jid?: string | null; fromTeam?: boolean } = {}): PreviewMessage {
  seq += 1;
  const sender = over.sender ?? LID;
  const jid = over.jid === undefined ? `${sender}@lid` : over.jid;
  return {
    logicalKey: over.logicalKey ?? `k${seq}`,
    conversationKind: over.conversationKind ?? "GROUP",
    conversationKey: over.conversationKey ?? "120000000000000001@g.us",
    ts: over.ts ?? T0 + seq * 1000,
    storedCopies: over.storedCopies ?? 1,
    keptCopy: over.keptCopy ?? {
      direction: "INCOMING",
      sender,
      senderJid: jid,
      fromTeam: over.fromTeam ?? false,
      obMatched: false,
      actionType: null,
      ruleId: null,
      createdById: null,
    },
    incomingCopies: over.incomingCopies ?? [{ senderPhone: sender, senderJid: jid, fromTeam: over.fromTeam ?? false }],
  };
}

const run = (input: Partial<Parameters<typeof previewIdentityChange>[0]> & Pick<Parameters<typeof previewIdentityChange>[0], "messages">) =>
  previewIdentityChange({
    rosterBefore: [member("rina", `+${PHONE}`)],
    rosterAfter: [member("rina", `+${PHONE}`, { whatsappId: LID })],
    ownIds: new Set(),
    window: { from: T0 - 1000, to: T0 + 10_000_000 },
    truncated: false,
    ...input,
  });

describe("previewIdentityChange", () => {
  it("linking a LID moves that sender's group messages from CUSTOMER to MEMBER:x", () => {
    const r = run({ messages: [msg(), msg(), msg({ sender: "100000000099" })] });
    expect(r.affected.logicalMessages).toBe(2);
    expect(r.affected.groups).toBe(1);
    expect(r.transitions).toEqual([{ from: "CUSTOMER", to: "MEMBER:rina", count: 2 }]);
    expect(r.byMember).toEqual([{ memberId: "rina", gained: 2, lost: 0 }]);
    expect(r.examined.logicalMessages).toBe(3);
  });

  it("a copy naming another member yields STAFF_UNIDENTIFIED (conflict), not MEMBER", () => {
    // Another account stored the same message under the phone of a second member.
    const m = msg({
      incomingCopies: [
        { senderPhone: LID, senderJid: `${LID}@lid`, fromTeam: false },
        { senderPhone: "8801000000002", senderJid: null, fromTeam: false },
      ],
    });
    const r = run({
      rosterBefore: [member("rina", `+${PHONE}`), member("omar", "+8801000000002")],
      rosterAfter: [member("rina", `+${PHONE}`, { whatsappId: LID }), member("omar", "+8801000000002")],
      messages: [m],
    });
    // Before: only omar is named (his phone copy). After: rina and omar are named, a conflict.
    expect(r.transitions).toEqual([{ from: "MEMBER:omar", to: "STAFF_UNIDENTIFIED", count: 1 }]);
    expect(r.byMember).toEqual([{ memberId: "omar", gained: 0, lost: 1 }]);
  });

  it("attributeFrom later than a message keeps it CUSTOMER", () => {
    const r = run({
      rosterAfter: [member("rina", `+${PHONE}`, { whatsappId: LID, attributeFrom: T0 + 5_000_000 })],
      messages: [msg({ ts: T0 + 1000 })],
    });
    expect(r.affected.logicalMessages).toBe(0);
    expect(r.transitions).toEqual([]);
  });

  it("our own number's copy stays BUSINESS whatever the roster", () => {
    const own = "8801000000900";
    const m = msg({ sender: own, jid: `${own}@c.us` });
    const r = run({
      ownIds: new Set([own]),
      rosterBefore: [member("rina", `+${PHONE}`)],
      rosterAfter: [member("rina", `+${PHONE}`), member("zed", `+${own}`)],
      messages: [m],
    });
    expect(r.affected.logicalMessages).toBe(0);
  });

  it("linked-login OPERATOR reply follows the member, honours attributeFrom", () => {
    const operator = (ts: number) =>
      msg({
        ts,
        keptCopy: {
          direction: "OUTGOING",
          sender: "8801000000900",
          senderJid: null,
          fromTeam: false,
          obMatched: true,
          actionType: "MANUAL_REPLY",
          ruleId: null,
          createdById: "user-1",
        },
        incomingCopies: [],
      });
    const r = run({
      rosterBefore: [member("rina", `+${PHONE}`)],
      rosterAfter: [member("rina", `+${PHONE}`, { userId: "user-1", attributeFrom: T0 + 2500 })],
      messages: [operator(T0 + 1000), operator(T0 + 5000)],
    });
    // The earlier reply predates attributeFrom (stays BUSINESS); the later one is credited.
    expect(r.transitions).toEqual([{ from: "BUSINESS", to: "MEMBER:rina", count: 1 }]);
  });

  it("unchanged messages are examined but not affected", () => {
    const r = run({ messages: [msg({ sender: "100000000098" }), msg({ sender: "100000000099", storedCopies: 2 })] });
    expect(r.examined).toEqual({ logicalMessages: 2, storedMessages: 3 });
    expect(r.affected).toEqual({ logicalMessages: 0, storedMessages: 0, groups: 0, personalConversations: 0 });
  });

  it("personal and group conversations are counted separately", () => {
    const r = run({
      messages: [
        msg({ conversationKind: "GROUP", conversationKey: "120000000000000001@g.us" }),
        msg({ conversationKind: "GROUP", conversationKey: "120000000000000002@g.us" }),
        msg({ conversationKind: "PERSONAL", conversationKey: `acct-A|${LID}@lid`, storedCopies: 2 }),
      ],
    });
    expect(r.affected.groups).toBe(2);
    expect(r.affected.personalConversations).toBe(1);
    expect(r.affected.storedMessages).toBe(4);
    expect(r.samples.map((s) => s.conversationKind).sort()).toEqual(["GROUP", "GROUP", "PERSONAL"]);
  });

  it("output is deterministic (same input twice, deep-equal, stable ordering)", () => {
    const messages = [
      msg({ ts: T0 + 3000 }),
      msg({ ts: T0 + 1000 }),
      msg({ ts: T0 + 90 * 86_400_000 }),
      msg({ sender: "100000000050", ts: T0 + 2000 }),
    ];
    const a = run({ messages });
    const b = run({ messages: [...messages].reverse() });
    expect(b).toEqual(a);
    expect(a.impactedDays.map((d) => d.day)).toEqual([...a.impactedDays.map((d) => d.day)].sort());
    expect(a.impactedMonths.length).toBeGreaterThanOrEqual(2);
    expect(a.samples[0]!.ts).toBeGreaterThan(a.samples[1]!.ts);
  });

  it("scopes the KPI estimate to the latest impacted month, most-changed groups first", () => {
    const G1 = "120000000000000001@g.us";
    const G2 = "120000000000000002@g.us";
    const OLD = T0 - 60 * 86_400_000;
    const r = run({
      messages: [
        msg({ conversationKey: G1 }),
        msg({ conversationKey: G2 }),
        msg({ conversationKey: G2 }),
        msg({ conversationKey: "120000000000000003@g.us", ts: OLD }),
        msg({ conversationKind: "PERSONAL", conversationKey: `acct-B|${LID}@lid` }),
      ],
      window: { from: OLD - 1000, to: T0 + 10_000_000 },
    });
    expect(r.kpiScope.month).toBe("2026-10");
    expect(r.kpiScope.groupKeys).toEqual([G2, G1]);
    expect(r.kpiScope.personalAccountIds).toEqual(["acct-B"]);
    expect(r.impactedMonths.length).toBe(2);
  });

  it("carries no text and caps samples", () => {
    const messages = Array.from({ length: 30 }, () => msg());
    const r = run({ messages });
    expect(r.samples).toHaveLength(20);
    expect(Object.keys(r.samples[0]!).sort()).toEqual(["conversationKey", "conversationKind", "from", "to", "ts"]);
  });
});
