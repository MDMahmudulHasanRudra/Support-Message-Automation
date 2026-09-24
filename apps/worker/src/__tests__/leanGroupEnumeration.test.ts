import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The group sync reads the roster with one lean expression inside the page instead of
 * `client.getAllGroups()`, which serialises every chat on the account — one-to-one conversations
 * included, each with its contact, presence and full group membership — before discarding
 * everything that is not a group. See `listGroupChats()` in OpenWAProvider for the numbers.
 *
 * What this pins, since WhatsApp Web itself cannot run here:
 *   - the page function filters to groups BEFORE mapping, and returns only four fields;
 *   - those fields come from the same places `_serializeChatObj` reads them, so callers get the
 *     same data they got before (name and t from `toJSON()`, formattedTitle from the model);
 *   - every way the lean path can fail — no Store, a throw, an empty or malformed result — falls
 *     back to `getAllGroups()`, so the worst case is the old behaviour, never an emptied roster.
 *
 * The page function is executed for real against a fake `globalThis.Store`, exactly as Puppeteer
 * would execute it in the page, rather than being re-implemented in the test.
 *
 * Pure — no database, no browser.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

interface FakeChat {
  isGroup: boolean;
  id: { _serialized: string };
  formattedTitle?: string;
  toJSON: () => { name?: string; t?: number };
}

function chat(id: string, isGroup: boolean, json: { name?: string; t?: number }, formattedTitle?: string): FakeChat {
  return { isGroup, id: { _serialized: id }, formattedTitle, toJSON: () => json };
}

/** A WhatsApp Web `Store.Chat` collection is array-like with `filter`; a plain array is one. */
function installStore(chats: FakeChat[] | null) {
  (globalThis as unknown as { Store?: unknown }).Store = chats ? { Chat: chats } : undefined;
}

async function providerWith(client: Record<string, unknown>) {
  const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
  const provider = new OpenWAProvider("acc-lean", "lean-session", "/tmp/lean");
  (provider as unknown as { client: unknown }).client = client;
  return provider;
}

/** Runs the page function the way Puppeteer's `page.evaluate` would — in this process, for real. */
const evaluatingPage = { evaluate: <T>(fn: () => T) => Promise.resolve(fn()) };

afterEach(() => {
  delete (globalThis as unknown as { Store?: unknown }).Store;
});

describe("the lean path", () => {
  it("returns groups only, with the same field values getAllGroups would have given", async () => {
    installStore([
      chat("111-222@g.us", true, { name: "Billing Support", t: 1_790_000_000 }, "Billing Support"),
      // A one-to-one chat: getAllGroups serialised this in full and then threw it away.
      chat("8801700000000@c.us", false, { name: "A Customer", t: 1_790_000_100 }),
      chat("333-444@g.us", true, { t: 1_790_000_200 }, "Titled Only"),
    ]);
    const getAllGroups = vi.fn();
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    const groups = await provider.getGroups();

    expect(groups).toEqual([
      { whatsappGroupId: "111-222@g.us", name: "Billing Support" },
      // No name attribute: falls through to formattedTitle, exactly as the old mapping did.
      { whatsappGroupId: "333-444@g.us", name: "Titled Only" },
    ]);
    // The whole point: the expensive call never ran.
    expect(getAllGroups).not.toHaveBeenCalled();
  });

  it("carries `t`, which the collection probe needs to find recently active groups", async () => {
    installStore([chat("555-666@g.us", true, { name: "Ops", t: 1_790_000_300 })]);
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups: vi.fn() });

    const chats = await (provider as unknown as { listGroupChats: () => Promise<Array<{ id: string; t: number | null }>> }).listGroupChats();

    expect(chats).toEqual([{ id: "555-666@g.us", name: "Ops", formattedTitle: null, t: 1_790_000_300 }]);
  });

  it("falls back to the group id when a group has neither name nor title", async () => {
    installStore([chat("777-888@g.us", true, {})]);
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups: vi.fn() });

    expect(await provider.getGroups()).toEqual([{ whatsappGroupId: "777-888@g.us", name: "777-888@g.us" }]);
  });
});

describe("a page with no WhatsApp in it is reported, not crashed into", () => {
  /**
   * Observed 24 Sep 2026: every sync against a logged-out session failed with "Cannot read
   * properties of undefined (reading 'map')", three times per press. The missing store used to
   * fall back to `getAllGroups()`, which is `Store.Chat.map(...)` on the same missing object — the
   * fallback only moved the crash. This case used to assert that fallback.
   */
  it("when WhatsApp Web's chat store is not there, it says so and never calls the slow path", async () => {
    installStore(null);
    const getAllGroups = vi.fn(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'map')");
    });
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    await expect(provider.getGroups()).rejects.toMatchObject({
      name: "SessionNotReadyError",
      message: expect.stringContaining("WhatsApp Web is not loaded"),
    });
    expect(getAllGroups).not.toHaveBeenCalled();
  });

  it("when the session was logged out on the phone, it refuses before touching the page", async () => {
    const evaluate = vi.fn();
    const provider = await providerWith({ getPage: () => ({ evaluate }), getAllGroups: vi.fn() });
    (provider as unknown as { state: string }).state = "AUTH_FAILED";

    await expect(provider.getGroups()).rejects.toMatchObject({
      name: "SessionNotReadyError",
      message: expect.stringContaining("logged out on the phone"),
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("but a session still coming up is let through, so the post-connect sync is not blocked", async () => {
    installStore([chat("121-212@g.us", true, { name: "Right after linking" })]);
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups: vi.fn() });
    // OpenWA reports SYNCING (recorded as RECONNECTING) for a while right after a successful connect.
    (provider as unknown as { state: string }).state = "RECONNECTING";

    expect(await provider.getGroups()).toEqual([{ whatsappGroupId: "121-212@g.us", name: "Right after linking" }]);
  });

  it("when the slow path returns something that is not a list, the error says so rather than 'map'", async () => {
    const provider = await providerWith({
      getPage: () => ({ evaluate: () => Promise.reject(new Error("Execution context was destroyed")) }),
      getAllGroups: vi.fn(async () => undefined),
    });

    await expect(provider.getGroups()).rejects.toThrow(/returned no group list \(got undefined\)/);
  });
});

describe("every failure takes the old path, never an emptied roster", () => {
  const slowPathResult = [{ id: "999-000@g.us", name: "From getAllGroups", formattedTitle: "", t: 1 }];

  it("when the chat store exists but has been reshaped", async () => {
    // The case the fallback is actually for: WhatsApp Web changed the collection, not lost it.
    (globalThis as unknown as { Store?: unknown }).Store = { Chat: { length: 1 } };
    const getAllGroups = vi.fn(async () => slowPathResult);
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    expect(await provider.getGroups()).toEqual([{ whatsappGroupId: "999-000@g.us", name: "From getAllGroups" }]);
    expect(getAllGroups).toHaveBeenCalledTimes(1);
  });

  it("when the page function throws", async () => {
    const getAllGroups = vi.fn(async () => slowPathResult);
    const provider = await providerWith({
      getPage: () => ({ evaluate: () => Promise.reject(new Error("Execution context was destroyed")) }),
      getAllGroups,
    });

    expect(await provider.getGroups()).toHaveLength(1);
    expect(getAllGroups).toHaveBeenCalledTimes(1);
  });

  it("when the lean result is empty — so zero groups only ever comes from the slow path agreeing", async () => {
    installStore([chat("8801700000000@c.us", false, { name: "Only a DM" })]);
    const getAllGroups = vi.fn(async () => slowPathResult);
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    await provider.getGroups();
    expect(getAllGroups).toHaveBeenCalledTimes(1);
  });

  it("when an id comes back malformed", async () => {
    installStore([{ isGroup: true, id: {} as { _serialized: string }, toJSON: () => ({ name: "Broken" }) }]);
    const getAllGroups = vi.fn(async () => slowPathResult);
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    await provider.getGroups();
    expect(getAllGroups).toHaveBeenCalledTimes(1);
  });
});
