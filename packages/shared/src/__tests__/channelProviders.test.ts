import { describe, expect, it } from "vitest";
import { CHANNEL_TYPES } from "../channels.js";
import { CHANNEL_PROVIDER_IDS, CHANNEL_PROVIDERS, classifyMetaWebhookObject, providerForChannelType, routeInboundEvent } from "../channelProviders.js";

/**
 * Meta expansion B1: explicit, exhaustive provider dispatch. What must hold:
 *   - every channel type has exactly one provider, and every implemented provider has a channel type;
 *   - WhatsApp (Official API) is its own channel, reached only through its per-number address;
 *   - a WhatsApp Cloud API webhook is never classified as a Page (Messenger) event;
 *   - a recorded event is processed only by its own connection's provider — any mismatch, a missing
 *     provider, or a WhatsApp Cloud event is REJECTED, never routed to Meta by default.
 */

describe("the provider catalogue", () => {
  it("maps each channel type to one provider", () => {
    expect(CHANNEL_TYPES.map(providerForChannelType)).toEqual(["META_MESSENGER", "META_INSTAGRAM", "TELEGRAM", "WEBCHAT", "WHATSAPP_CLOUD"]);
    const mapped = new Set(CHANNEL_TYPES.map(providerForChannelType));
    for (const id of CHANNEL_PROVIDER_IDS) expect(mapped.has(id), id).toBe(CHANNEL_PROVIDERS[id].implemented);
    expect(CHANNEL_PROVIDERS.WHATSAPP_CLOUD).toMatchObject({ implemented: true, label: "WhatsApp (Official API)" });
  });

  it("refuses an impossible channel type at run time", () => {
    expect(() => providerForChannelType("NOT_A_CHANNEL" as never)).toThrow(/Unhandled channel type/);
  });
});

describe("Meta webhook objects", () => {
  it("routes Page and Instagram messaging, refuses WhatsApp Cloud by name, and treats anything else as unknown", () => {
    expect(classifyMetaWebhookObject("page")).toMatchObject({ kind: "CHANNEL", type: "MESSENGER" });
    expect(classifyMetaWebhookObject("instagram")).toMatchObject({ kind: "CHANNEL", type: "INSTAGRAM" });
    expect(classifyMetaWebhookObject("whatsapp_business_account")).toMatchObject({ kind: "UNSUPPORTED", provider: "WHATSAPP_CLOUD" });
    for (const other of ["permissions", "user", "ad_account", "Page", ""]) expect(classifyMetaWebhookObject(other).kind).toBe("UNKNOWN");
  });
});

describe("recorded events", () => {
  it("processes an event only with its own connection's provider", () => {
    expect(routeInboundEvent({ provider: "META", type: "MESSENGER" }, "MESSENGER")).toEqual({ route: "META", type: "MESSENGER" });
    expect(routeInboundEvent({ provider: "META", type: "INSTAGRAM" }, "INSTAGRAM")).toEqual({ route: "META", type: "INSTAGRAM" });
    expect(routeInboundEvent({ provider: "TELEGRAM", type: "TELEGRAM" }, "TELEGRAM")).toEqual({ route: "TELEGRAM" });
    expect(routeInboundEvent({ provider: "WEBCHAT" }, "WEBCHAT")).toEqual({ route: "WEBCHAT" });
  });

  it("rejects — never routes to Meta by default — a WhatsApp Cloud event, a missing provider, or any mismatch", () => {
    const rejected: Array<[{ provider?: unknown; type?: unknown }, Parameters<typeof routeInboundEvent>[1]]> = [
      [{ provider: "WHATSAPP_CLOUD", type: "MESSENGER" }, "MESSENGER"],
      [{}, "MESSENGER"],
      [{ provider: "META" }, "MESSENGER"],
      [{ provider: "META", type: "INSTAGRAM" }, "MESSENGER"],
      [{ provider: "META", type: "MESSENGER" }, "TELEGRAM"],
      [{ provider: "META", type: "MESSENGER" }, "WEBCHAT"],
      [{ provider: "TELEGRAM" }, "MESSENGER"],
      [{ provider: "WEBCHAT" }, "INSTAGRAM"],
      [{ provider: 42 }, "WEBCHAT"],
    ];
    for (const [payload, type] of rejected) expect(routeInboundEvent(payload, type), JSON.stringify([payload, type])).toMatchObject({ route: "REJECT" });
  });
});
