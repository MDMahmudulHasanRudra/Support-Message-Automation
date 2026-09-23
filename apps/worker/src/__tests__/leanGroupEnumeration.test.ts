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

describe("every failure takes the old path, never an emptied roster", () => {
  const slowPathResult = [{ id: "999-000@g.us", name: "From getAllGroups", formattedTitle: "", t: 1 }];

  it("when WhatsApp Web's Store is not there", async () => {
    installStore(null);
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
