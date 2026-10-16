import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The probe's whole reason to exist is that it can say "I don't know".
 *
 * `fetchMessagesSince` catches its own enumeration failure and returns `[]`, which is right for
 * catch-up — a sweep that cannot read history has recovered nothing — and catastrophically wrong
 * for the watchdog, which reads the same empty array as "WhatsApp holds nothing newer, so this
 * account really is just quiet". During the 18 Sep 2026 outage that is exactly what it logged:
 * "quiet for 195m and WhatsApp agrees", about a browser that could not be queried at all. The
 * watchdog's own try/catch never fired, because nothing ever threw.
 *
 * So these assert the three ways the answer is genuinely unknown, and the two ways it is not.
 * Pure — no database, no browser.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");

const SINCE = new Date("2026-09-18T07:00:00.000Z");
const afterSince = (offsetSeconds: number) => Math.floor(SINCE.getTime() / 1000) + offsetSeconds;

/** A chat whose last interaction is after `since`, so the probe will look inside it. */
function activeChat(id: string) {
  return { id, t: afterSince(60) };
}

function message(id: string, offsetSeconds: number) {
  return {
    id,
    body: "hello",
    timestamp: afterSince(offsetSeconds),
    from: "8801700000000@c.us",
    author: "8801700000000@c.us",
    chatId: "group@g.us",
    type: "chat",
    fromMe: false,
  };
}

let provider: InstanceType<typeof OpenWAProvider>;

beforeEach(() => {
  provider = new OpenWAProvider("acct-1", "session-1", "/tmp/nowhere");
});

/** The client is private and never built in these tests — there is no browser to build one from. */
function withClient(client: unknown): void {
  (provider as unknown as { client: unknown }).client = client;
}

describe("a probe that cannot see", () => {
  it("reports unknown when there is no session object at all", async () => {
    const result = await provider.probeCollection(SINCE, 5);

    expect(result.ok).toBe(false);
    // Without this, a provider holding no client reports the same empty array as a healthy quiet
    // account — which is the single most dangerous direction for this answer to be wrong in.
    if (!result.ok) expect(result.reason).toMatch(/no live whatsapp session/i);
  });

  it("reports unknown when the chat enumeration throws", async () => {
    withClient({
      getAllGroups: async () => {
        throw new Error("Protocol error: Target closed");
      },
    });

    const result = await provider.probeCollection(SINCE, 5);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Target closed");
  });

  it("reports unknown when WhatsApp returns no chats at all", async () => {
    // The subtle one, and the reason this is a branch rather than an assumption. An empty roster
    // looks like a perfectly successful read, so it would arrive at the watchdog as agreement —
    // but the watchdog only probes accounts it has already established are in monitored groups,
    // and such an account cannot truly be in none. An empty roster is a fact about the page's
    // state, not about the account.
    withClient({ getAllGroups: async () => [] });

    const result = await provider.probeCollection(SINCE, 5);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no chats/i);
  });
});

describe("a probe that can see", () => {
  it("reports an empty result as a real answer when chats exist and hold nothing newer", async () => {
    withClient({
      getAllGroups: async () => [{ id: "group@g.us", t: Math.floor(SINCE.getTime() / 1000) - 600 }],
      getAllChats: async () => [{ id: "8801700000009@c.us", t: Math.floor(SINCE.getTime() / 1000) - 600 }],
      getAllMessagesInChat: async () => [],
    });

    const result = await provider.probeCollection(SINCE, 5);

    // This is the reading the watchdog is entitled to trust: it asked, and the answer was nothing.
    // No `incomplete` either: both lists were read, so nothing went unchecked.
    expect(result).toEqual({ ok: true, messages: [] });
  });

  it("still answers when one chat's history cannot be read", async () => {
    // A single unreadable chat is not a failure of the probe — the others answered, and that is
    // what the question was. Treating it as unknown would alarm on a group that happens to be
    // large or mid-sync.
    withClient({
      getAllGroups: async () => [activeChat("bad@g.us"), activeChat("good@g.us")],
      getAllMessagesInChat: async (chatId: string) => {
        if (chatId === "bad@g.us") throw new Error("could not load");
        return [message("msg-1", 30)];
      },
    });

    const result = await provider.probeCollection(SINCE, 5);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messages).toHaveLength(1);
  });
});

describe("one-to-one chats are read back too (Phase 2)", () => {
  function personalMessage(id: string, chatId: string, offsetSeconds: number) {
    return { ...message(id, offsetSeconds), from: chatId, author: undefined, chatId, isGroupMsg: false };
  }

  it("recovers a personal message from inside the gap, and never reads status or channels", async () => {
    const read: string[] = [];
    withClient({
      getAllGroups: async () => [activeChat("group@g.us")],
      getAllChats: async () => [
        { id: "8801700000009@c.us", t: afterSince(120) },
        { id: "123456789012345@lid", t: afterSince(-600) }, // quiet since before the gap
        { id: "status@broadcast", t: afterSince(90) },
        { id: "120363000000000000@newsletter", t: afterSince(90) },
      ],
      getAllMessagesInChat: async (chatId: string) => {
        read.push(chatId);
        if (chatId === "8801700000009@c.us") return [personalMessage("p-1", chatId, 100)];
        if (chatId === "group@g.us") return [message("g-1", 30)];
        return [];
      },
    });

    const result = await provider.probeCollection(SINCE, 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incomplete).toBeUndefined();
    // Oldest first, groups and personal chats together.
    expect(result.messages.map((m) => [m.whatsappMessageId, m.chatId])).toEqual([
      ["g-1", "group@g.us"],
      ["p-1", "8801700000009@c.us"],
    ]);
    expect(result.messages[1]!.whatsappGroupId).toBeNull();
    expect(read.sort()).toEqual(["8801700000009@c.us", "group@g.us"]);
  });

  it("still answers from the groups when the personal list cannot be read, and says so", async () => {
    withClient({
      getAllGroups: async () => [activeChat("group@g.us")],
      getAllChats: async () => {
        throw new Error("Protocol error: Execution context was destroyed");
      },
      getAllMessagesInChat: async () => [message("g-1", 30)],
    });

    const result = await provider.probeCollection(SINCE, 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toHaveLength(1);
    expect(result.incomplete).toMatch(/one-to-one chats could not be listed/i);
  });

  it("says how many chats it could not read, so a sweep is never called complete", async () => {
    withClient({
      getAllGroups: async () => [activeChat("bad@g.us"), activeChat("good@g.us")],
      getAllChats: async () => [],
      getAllMessagesInChat: async (chatId: string) => {
        if (chatId === "bad@g.us") throw new Error("could not load");
        return [message("msg-1", 30)];
      },
    });

    const result = await provider.probeCollection(SINCE, 5);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.incomplete).toBe("The history of 1 chat(s) could not be read.");
  });
});

describe("fetchMessagesSince keeps its forgiving contract", () => {
  it("returns an empty array rather than throwing when the probe cannot see", async () => {
    // Catch-up runs immediately after a session comes up. A failure to fill a gap must never take
    // down the connection that just succeeded, so this half deliberately does NOT get stricter.
    withClient({
      getAllGroups: async () => {
        throw new Error("Protocol error: Target closed");
      },
    });

    await expect(provider.fetchMessagesSince(SINCE, 5)).resolves.toEqual([]);
  });
});
