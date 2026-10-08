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
 *   - every way the lean path can fail — a throw, a reshaped store, a malformed id — falls back to
 *     `getAllGroups()`, so the worst case is the old behaviour, never an emptied roster;
 *   - an EMPTY list from a working store is the answer (8 Oct 2026): the slow path reads the same
 *     store, so it could only agree, after serialising every chat — what ran a freshly linked
 *     number's syncs past 150 s;
 *   - one read per session at a time: a read nobody is waiting for any more keeps running in the
 *     page, so the next caller joins it instead of queueing behind it.
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


  it("when an id comes back malformed", async () => {
    installStore([{ isGroup: true, id: {} as { _serialized: string }, toJSON: () => ({ name: "Broken" }) }]);
    const getAllGroups = vi.fn(async () => slowPathResult);
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    await provider.getGroups();
    expect(getAllGroups).toHaveBeenCalledTimes(1);
  });
});

describe("a newly linked number whose chats are still arriving (8 Oct 2026)", () => {
  it("no groups yet is an empty list, and the slow path — which reads the same store — is never run", async () => {
    // The phone has sent some one-to-one chats and no group yet. getAllGroups() would serialise
    // every one of them and then find no group either.
    installStore([chat("8801700000000@c.us", false, { name: "Only a DM" }), chat("8801700000001@c.us", false, { name: "Another DM" })]);
    const getAllGroups = vi.fn(async () => [{ id: "999-000@g.us", name: "never", formattedTitle: "", t: 1 }]);
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    expect(await provider.getGroups()).toEqual([]);
    expect(getAllGroups).not.toHaveBeenCalled();
  });

  it("a half-built chat whose toJSON throws is still listed by its id, and does not send the whole read to the slow path", async () => {
    installStore([
      chat("111-000@g.us", true, { name: "Complete" }),
      {
        isGroup: true,
        id: { _serialized: "222-000@g.us" },
        formattedTitle: "Still arriving",
        toJSON: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'name')");
        },
      },
    ]);
    const getAllGroups = vi.fn();
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    expect(await provider.getGroups()).toEqual([
      { whatsappGroupId: "111-000@g.us", name: "Complete" },
      { whatsappGroupId: "222-000@g.us", name: "Still arriving" },
    ]);
    expect(getAllGroups).not.toHaveBeenCalled();
  });

  it("a second read while one is still running in the page joins it — one page read, both callers answered", async () => {
    installStore([chat("333-000@g.us", true, { name: "Slow page" })]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const evaluate = vi.fn(async (fn: () => unknown) => {
      await gate;
      return fn();
    });
    const provider = await providerWith({ getPage: () => ({ evaluate }), getAllGroups: vi.fn() });

    const first = provider.getGroups();
    const second = provider.getGroups();
    release();

    expect(await first).toEqual([{ whatsappGroupId: "333-000@g.us", name: "Slow page" }]);
    expect(await second).toEqual(await first);
    expect(evaluate).toHaveBeenCalledTimes(1);
    // Finished reads are not cached: the next read asks the page again.
    await provider.getGroups();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("a read running on a page a reconnect has since replaced is never joined", async () => {
    installStore([chat("444-000@g.us", true, { name: "New page" })]);
    const oldEvaluate = vi.fn(() => new Promise<never>(() => undefined)); // the old page never answers
    const provider = await providerWith({ getPage: () => ({ evaluate: oldEvaluate }), getAllGroups: vi.fn() });
    void provider.getGroups();

    (provider as unknown as { client: unknown }).client = { getPage: () => evaluatingPage, getAllGroups: vi.fn() };
    expect(await provider.getGroups()).toEqual([{ whatsappGroupId: "444-000@g.us", name: "New page" }]);
  });
});

describe("empty is an answer only from a chat store that holds chats (8 Oct 2026)", () => {
  it("a recognisable chat store holding NO chats at all is 'not ready' — never an empty roster, never the slow path", async () => {
    installStore([]);
    const getAllGroups = vi.fn();
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    await expect(provider.getGroups()).rejects.toMatchObject({ name: "GroupListNotReadyError" });
    expect(getAllGroups).not.toHaveBeenCalled();
  });

  it("the same for a Backbone-style collection (models, no length) that is still empty", async () => {
    (globalThis as unknown as { Store?: unknown }).Store = { Chat: { models: [], filter: () => [] } };
    const getAllGroups = vi.fn();
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups });

    await expect(provider.getGroups()).rejects.toMatchObject({ name: "GroupListNotReadyError" });
    expect(getAllGroups).not.toHaveBeenCalled();
  });

  it("whereas chats present and none a group is a real, empty answer", async () => {
    installStore([chat("8801700000002@c.us", false, { name: "A DM" })]);
    const provider = await providerWith({ getPage: () => evaluatingPage, getAllGroups: vi.fn() });

    expect(await provider.getGroups()).toEqual([]);
  });
});

describe("a read that never answers (8 Oct 2026)", () => {
  it("is shared only up to its limit, then released — and the next read is a fresh one that answers", async () => {
    const { GROUP_READ_SETTINGS } = await import("../provider/openwa/OpenWAProvider.js");
    const saved = GROUP_READ_SETTINGS.maxMs;
    GROUP_READ_SETTINGS.maxMs = 150;
    try {
      installStore([chat("555-000@g.us", true, { name: "Answers the second time" })]);
      let calls = 0;
      const evaluate = vi.fn((fn: () => unknown) => {
        calls += 1;
        // The first read is wedged forever; every later one answers.
        return calls === 1 ? new Promise<never>(() => undefined) : Promise.resolve(fn());
      });
      const provider = await providerWith({ getPage: () => ({ evaluate }), getAllGroups: vi.fn() });

      const hung = provider.getGroups();
      const joined = provider.getGroups(); // while it is still within its limit: joins, no second read
      expect(evaluate).toHaveBeenCalledTimes(1);

      await expect(hung).rejects.toMatchObject({ name: "GroupListNotReadyError" });
      await expect(joined).rejects.toMatchObject({ name: "GroupListNotReadyError" });

      // Released: a fresh read, which answers.
      expect(await provider.getGroups()).toEqual([{ whatsappGroupId: "555-000@g.us", name: "Answers the second time" }]);
      expect(evaluate).toHaveBeenCalledTimes(2);
    } finally {
      GROUP_READ_SETTINGS.maxMs = saved;
    }
  });
});

