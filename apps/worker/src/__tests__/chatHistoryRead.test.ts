import { describe, expect, it, vi } from "vitest";

/**
 * `readChatHistory` — the personal backfill's only way into WhatsApp. It must ask the phone for older
 * history only when what the session holds does not reach the start of the range, at most the
 * pages it is allowed, and say honestly whether it got there. Pure — no database, no browser.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");

const chatId = "8801700000009@c.us";
const NOW_S = 1_760_000_000;
const SINCE = new Date((NOW_S - 3 * 86_400) * 1000);
const msg = (id: string, secondsAgo: number, type = "chat") => ({
  id,
  type,
  body: type === "chat" ? "hello" : undefined,
  timestamp: NOW_S - secondsAgo,
  from: chatId,
  chatId,
  fromMe: false,
  isGroupMsg: false,
});

function providerWith(held: ReturnType<typeof msg>[], olderPages: ReturnType<typeof msg>[][]) {
  const provider = new OpenWAProvider("acct-1", "session-1", "/tmp/nowhere");
  const loadEarlier = vi.fn(async () => {
    const page = olderPages.shift() ?? [];
    held.unshift(...page);
    return page;
  });
  (provider as unknown as { client: unknown }).client = {
    getAllMessagesInChat: async () => [...held],
    loadEarlierMessages: loadEarlier,
  };
  return { provider, loadEarlier };
}

describe("readChatHistory", () => {
  it("does not touch the phone when the session already holds the whole range", async () => {
    const { provider, loadEarlier } = providerWith([msg("old", 4 * 86_400), msg("a", 3600)], [[msg("older", 5 * 86_400)]]);
    const read = await provider.readChatHistory(chatId, SINCE, { earlierPages: 2 });
    expect(read).toMatchObject({ ok: true, reachedSince: true, earlierPagesLoaded: 0, undecrypted: 0 });
    if (read.ok) expect(read.messages.map((m) => m.whatsappMessageId)).toEqual(["a"]);
    expect(loadEarlier).not.toHaveBeenCalled();
  });

  it("loads at most the pages it is allowed, and says when it did not get back far enough", async () => {
    const pages = [[msg("p1", 7200)], [msg("p2", 10_800)], [msg("p3", 14_400)]];
    const { provider, loadEarlier } = providerWith([msg("a", 3600)], pages);
    const read = await provider.readChatHistory(chatId, SINCE, { earlierPages: 2 });
    expect(loadEarlier).toHaveBeenCalledTimes(2);
    expect(read).toMatchObject({ ok: true, reachedSince: false, earlierPagesLoaded: 2 });
  });

  it("counts the start of the chat as complete coverage", async () => {
    const { provider } = providerWith([msg("a", 3600)], [[]]);
    const read = await provider.readChatHistory(chatId, SINCE, { earlierPages: 5 });
    expect(read).toMatchObject({ ok: true, reachedSince: true, earlierPagesLoaded: 1 });
  });

  it("counts a still-encrypted message instead of converting it", async () => {
    const { provider } = providerWith([msg("old", 4 * 86_400), msg("enc", 600, "ciphertext"), msg("a", 300)], []);
    const read = await provider.readChatHistory(chatId, SINCE, { earlierPages: 0 });
    expect(read).toMatchObject({ ok: true, undecrypted: 1 });
    if (read.ok) expect(read.messages.map((m) => m.whatsappMessageId)).toEqual(["a"]);
  });

  it("refuses without a session and never throws", async () => {
    const provider = new OpenWAProvider("acct-1", "session-1", "/tmp/nowhere");
    await expect(provider.readChatHistory(chatId, SINCE, { earlierPages: 1 })).resolves.toMatchObject({ ok: false });
    (provider as unknown as { client: unknown }).client = {
      getAllMessagesInChat: async () => {
        throw new Error("Protocol error: Target closed");
      },
    };
    await expect(provider.readChatHistory(chatId, SINCE, { earlierPages: 1 })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("Target closed") });
  });
});
