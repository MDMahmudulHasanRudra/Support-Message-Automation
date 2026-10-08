import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three things that let production lose three quarters of its inbox on 24 Sep 2026, each
 * pinned. The account was linked at 3:11 PM; a sync two minutes later read 498 of its 1,952 groups;
 * the other 1,454 stayed inactive, and the inbox lists active groups only. Later the browser's
 * WhatsApp Web lost its chat store while the account went on reading CONNECTED, so nothing arrived
 * for hours and nothing reported it.
 *
 * No database, no browser: Prisma, the state writer and the page are all stand-ins.
 */

// ---------------------------------------------------------------------------------------------
// Stand-ins. Declared before the modules under test are imported.

const groupRows = new Map<string, { id: string; name: string; isActive: boolean }>();
const prismaStub = {
  whatsAppGroup: {
    findUnique: vi.fn(async ({ where }: { where: { accountId_whatsappGroupId: { whatsappGroupId: string } } }) =>
      groupRows.get(where.accountId_whatsappGroupId.whatsappGroupId) ?? null,
    ),
    update: vi.fn(
      async ({ where, data }: { where: { accountId_whatsappGroupId: { whatsappGroupId: string } }; data: { isActive: boolean } }) => {
        const row = groupRows.get(where.accountId_whatsappGroupId.whatsappGroupId)!;
        Object.assign(row, data);
        return row;
      },
    ),
    create: vi.fn(async ({ data }: { data: { whatsappGroupId: string; name: string } }) => {
      const row = { id: `g-${data.whatsappGroupId}`, name: data.name, isActive: true };
      groupRows.set(data.whatsappGroupId, row);
      return row;
    }),
  },
};
vi.mock("@support-automation/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@support-automation/db")>()),
  prisma: prismaStub,
}));
// The worker's own client (src/db.ts) is what the modules under test read; with no database the
// project is taken as given rather than looked up from the account row.
vi.mock("../db.js", () => ({ prisma: prismaStub, platformPrisma: prismaStub }));
vi.mock("../project/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../project/context.js")>()),
  withAccountProject: async <T,>(_accountId: string, fn: () => Promise<T>) => fn(),
}));

const recordedStates: string[] = [];
vi.mock("../provider/openwa/connectionState.js", () => ({
  recordConnectionState: vi.fn(async (_accountId: string, state: string) => {
    recordedStates.push(state);
  }),
  recordLinkWindow: vi.fn(async () => undefined),
  recordAccountMetadata: vi.fn(async () => undefined),
  readPairingPreference: vi.fn(async () => ({ method: "QR_CODE" })),
  readProxyConfig: vi.fn(async () => null),
}));

vi.mock("@open-wa/wa-automate", () => ({ create: vi.fn(), ev: { on: vi.fn() }, STATE: {}, MessageTypes: {} }));

beforeEach(() => {
  groupRows.clear();
  recordedStates.length = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe("a short group list cannot switch off most of the roster", () => {
  it("holds the sweep for the observed read: 498 returned of 1,952 active", async () => {
    const { shouldHoldDeactivationSweep } = await import("../commands/groupSyncGuard.js");
    expect(shouldHoldDeactivationSweep(1_952, 1_454)).toBe(true);
  });

  it("and syncGroups actually consults it before deactivating anything", async () => {
    // The rule above is only as good as its one call site; this is the part a DB-free test can
    // otherwise not see. The count must be taken, the guard asked, and only then the sweep run.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(__dirname, "../commands/commandProcessor.ts"), "utf8");
    const sync = source.slice(source.indexOf("export async function syncGroups("), source.indexOf("const GROUP_SYNC_TIMEOUT_MS"));
    const guard = sync.indexOf("shouldHoldDeactivationSweep(activeBefore, wouldDeactivate)");
    const sweep = sync.indexOf("data: { isActive: false }");
    expect(guard).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(guard);
    expect(sync.match(/data: \{ isActive: false \}/g)).toHaveLength(1);
  });

  it("still lets ordinary departures through", async () => {
    const { shouldHoldDeactivationSweep } = await import("../commands/groupSyncGuard.js");
    expect(shouldHoldDeactivationSweep(1_952, 3)).toBe(false); // left three groups
    expect(shouldHoldDeactivationSweep(1_952, 150)).toBe(false); // 7.7% — a big tidy-up, still real
    expect(shouldHoldDeactivationSweep(12, 12)).toBe(false); // a small account can still empty out
  });
});

describe("a message from a group is proof the account is in it", () => {
  const raw = (whatsappGroupId: string, groupName?: string) => ({
    accountId: "acc-1",
    whatsappMessageId: "m1",
    chatId: whatsappGroupId,
    whatsappGroupId,
    groupName,
    senderPhone: "8801700000000",
    direction: "INCOMING" as const,
    body: "hello",
    timestampWa: new Date(),
  });

  it("reactivates an inactive group instead of storing its message where the inbox cannot see it", async () => {
    groupRows.set("111@g.us", { id: "g-111", name: "Billing", isActive: false });
    const { resolveGroup } = await import("../pipeline/processIncomingMessage.js");

    const group = await resolveGroup(raw("111@g.us"));

    expect(group?.isActive).toBe(true);
    expect(groupRows.get("111@g.us")!.isActive).toBe(true);
  });

  it("registers a group the sync has never seen, named as WhatsApp names it", async () => {
    const { resolveGroup } = await import("../pipeline/processIncomingMessage.js");

    const group = await resolveGroup(raw("222@g.us", "New Customer Ltd"));

    expect(group?.id).toBe("g-222@g.us");
    expect(prismaStub.whatsAppGroup.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { accountId: "acc-1", whatsappGroupId: "222@g.us", name: "New Customer Ltd" } }),
    );
    // Only identity is written: monitoring, AI and priority stay at their defaults (off), so a
    // group nobody has looked at can never start receiving automated replies by speaking.
    const written = prismaStub.whatsAppGroup.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(["accountId", "name", "whatsappGroupId"]);
  });

  it("leaves a known active group untouched — one read, no write", async () => {
    groupRows.set("333@g.us", { id: "g-333", name: "Ops", isActive: true });
    const { resolveGroup } = await import("../pipeline/processIncomingMessage.js");

    await resolveGroup(raw("333@g.us"));

    expect(prismaStub.whatsAppGroup.update).not.toHaveBeenCalled();
    expect(prismaStub.whatsAppGroup.create).not.toHaveBeenCalled();
  });
});

describe("a CONNECTED session with no WhatsApp in its page is noticed", () => {
  async function connectedProvider(pageHasStore: () => boolean) {
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    const provider = new OpenWAProvider("acc-health", "health-session", "/tmp/health");
    const page = {
      isClosed: () => false,
      evaluate: (fn: () => boolean) => {
        (globalThis as unknown as { Store?: unknown }).Store = pageHasStore() ? { Chat: [] } : undefined;
        return Promise.resolve(fn());
      },
    };
    Object.assign(provider as unknown as Record<string, unknown>, { client: { getPage: () => page }, state: "CONNECTED" });
    return provider;
  }

  it("hands it to recovery after two failed checks, as DISCONNECTED", async () => {
    const provider = await connectedProvider(() => false);

    await provider.checkSessionHealth();
    expect(provider.getConnectionStatus()).toBe("CONNECTED"); // one failure is not enough
    await provider.checkSessionHealth();

    expect(provider.getConnectionStatus()).toBe("DISCONNECTED");
    expect(recordedStates).toEqual(["DISCONNECTED"]);
  });

  it("forgives a single blip", async () => {
    let calls = 0;
    const provider = await connectedProvider(() => ++calls !== 1); // missing once, then back

    await provider.checkSessionHealth();
    await provider.checkSessionHealth();
    await provider.checkSessionHealth();

    expect(provider.getConnectionStatus()).toBe("CONNECTED");
    expect(recordedStates).toEqual([]);
  });

  it("never touches a session that is mid-connect", async () => {
    const provider = await connectedProvider(() => false);
    (provider as unknown as { connecting: Promise<void> }).connecting = new Promise(() => undefined);

    await provider.checkSessionHealth();
    await provider.checkSessionHealth();

    expect(recordedStates).toEqual([]);
  });
});
