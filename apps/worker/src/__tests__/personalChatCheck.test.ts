import { describe, expect, it, vi } from "vitest";

/**
 * OpenWAProvider.verifyPersonalChat — the live check before a manual reply to a one-to-one chat.
 * Individual chat ids only, and only a chat WhatsApp actually has. Pure: a fake client, no browser.
 */

vi.mock("@open-wa/wa-automate", () => ({ create: vi.fn(), ev: { on: vi.fn() }, STATE: {}, MessageTypes: {} }));

async function providerWith(getChatById: (id: string) => unknown) {
  const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
  const provider = new OpenWAProvider("acc-personal", "personal-session", "/tmp/personal");
  (provider as unknown as { client: unknown }).client = { getChatById: vi.fn(async (id: string) => getChatById(id)) };
  return provider;
}

describe("verifyPersonalChat", () => {
  it("accepts an existing @c.us or @lid chat", async () => {
    const provider = await providerWith(() => ({ id: "x" }));
    expect(await provider.verifyPersonalChat("8801712345678@c.us")).toBe(true);
    expect(await provider.verifyPersonalChat("198497013887081@lid")).toBe(true);
  });

  it("never a group, the status broadcast, a channel or a malformed id — whatever WhatsApp would return", async () => {
    const provider = await providerWith(() => ({ id: "x" }));
    for (const id of ["120363000000000001@g.us", "status@broadcast", "1203630000@newsletter", "@c.us", "8801712345678@c.us.evil", "8801712345678"]) {
      expect(await provider.verifyPersonalChat(id), id).toBe(false);
    }
  });

  it("false when WhatsApp has no such chat, or the lookup throws, or there is no session", async () => {
    expect(await (await providerWith(() => null)).verifyPersonalChat("8801712345678@c.us")).toBe(false);
    expect(await (await providerWith(() => { throw new Error("no chat"); })).verifyPersonalChat("8801712345678@c.us")).toBe(false);
    const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
    expect(await new OpenWAProvider("a", "s", "/tmp/x").verifyPersonalChat("8801712345678@c.us")).toBe(false);
  });
});
