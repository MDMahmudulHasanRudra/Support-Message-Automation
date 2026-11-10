import type { ChannelType, MetaChannelType } from "./channels.js";

/**
 * Which PROVIDER carries each messaging channel, and how every event and every send is routed to it
 * (Meta expansion B1, docs/meta-expansion/03 §3). The one place that answers "whose code handles this?".
 *
 * Why it exists: the inbox's dispatch was written as "Telegram, website chat, otherwise Meta". That was
 * true for the four channels it was written for and silently wrong for the next one — an official
 * WhatsApp (Cloud API) event or send would have fallen into the Messenger path. Every decision is now an
 * exhaustive `switch` over these ids with a `never` check, so a new provider fails to COMPILE until each
 * place has decided what it does with it, and an event or send no provider accepts is refused, never
 * treated as processed.
 *
 * WhatsApp (Official API) is listed and NOT implemented: no channel type maps to it yet (B2 adds one), its
 * webhook object is recognised only to be refused, and nothing can send through it. The OpenWA "WhatsApp
 * (Legacy)" channel is not a provider here at all — it is the separate WhatsApp module and never passes
 * through any of this.
 */

export const CHANNEL_PROVIDER_IDS = ["META_MESSENGER", "META_INSTAGRAM", "TELEGRAM", "WEBCHAT", "WHATSAPP_CLOUD"] as const;
export type ChannelProviderId = (typeof CHANNEL_PROVIDER_IDS)[number];

export interface ChannelProviderDefinition {
  label: string;
  /** Whether events and sends for it are handled by this release. */
  implemented: boolean;
  /** The `provider` value the web records on a `ChannelInboundEvent` payload for it. */
  payloadProvider: InboundPayloadProvider;
}

/** The `provider` field of a recorded event's payload. "WHATSAPP_CLOUD" is reserved and never recorded yet. */
export type InboundPayloadProvider = "META" | "TELEGRAM" | "WEBCHAT" | "WHATSAPP_CLOUD";

export const CHANNEL_PROVIDERS: Record<ChannelProviderId, ChannelProviderDefinition> = {
  META_MESSENGER: { label: "Facebook Messenger (Meta)", implemented: true, payloadProvider: "META" },
  META_INSTAGRAM: { label: "Instagram DM (Meta)", implemented: true, payloadProvider: "META" },
  TELEGRAM: { label: "Telegram Bot API", implemented: true, payloadProvider: "TELEGRAM" },
  WEBCHAT: { label: "Website chat (Get Assist)", implemented: true, payloadProvider: "WEBCHAT" },
  WHATSAPP_CLOUD: { label: "WhatsApp (Official API)", implemented: true, payloadProvider: "WHATSAPP_CLOUD" },
};

/** Fails to compile when a case is missing; throws if an impossible value arrives at run time. */
export function assertNeverProvider(value: never, what: string): never {
  throw new Error(`Unhandled ${what}: ${String(value)}`);
}

/** The provider of a channel type. Exhaustive: a new ChannelType must be mapped here before anything builds. */
export function providerForChannelType(type: ChannelType): ChannelProviderId {
  switch (type) {
    case "MESSENGER":
      return "META_MESSENGER";
    case "INSTAGRAM":
      return "META_INSTAGRAM";
    case "TELEGRAM":
      return "TELEGRAM";
    case "WEBCHAT":
      return "WEBCHAT";
    case "WHATSAPP_CLOUD":
      return "WHATSAPP_CLOUD";
    default:
      return assertNeverProvider(type, "channel type");
  }
}

// ─── Meta webhooks ───────────────────────────────────────────────────────────────────────────────

/**
 * What a Meta webhook body's `object` means here. `page` and `instagram` carry Messenger and Instagram
 * messaging. `whatsapp_business_account` is the WhatsApp Cloud API, recognised so it is refused by name —
 * it must never be read as a Page event. Anything else is a product this server has not subscribed to.
 */
export type MetaWebhookObjectRoute =
  | { kind: "CHANNEL"; type: MetaChannelType; provider: "META_MESSENGER" | "META_INSTAGRAM" }
  | { kind: "UNSUPPORTED"; provider: "WHATSAPP_CLOUD"; reason: string }
  | { kind: "UNKNOWN"; reason: string };

export function classifyMetaWebhookObject(object: string): MetaWebhookObjectRoute {
  switch (object) {
    case "page":
      return { kind: "CHANNEL", type: "MESSENGER", provider: "META_MESSENGER" };
    case "instagram":
      return { kind: "CHANNEL", type: "INSTAGRAM", provider: "META_INSTAGRAM" };
    case "whatsapp_business_account":
      return { kind: "UNSUPPORTED", provider: "WHATSAPP_CLOUD", reason: "WhatsApp (Official API) is connected per number at its own callback address, not through the platform app; its events are not recorded." };
    default:
      return { kind: "UNKNOWN", reason: `Meta object "${object.slice(0, 64)}" is not handled by this server.` };
  }
}

// ─── Recorded events ────────────────────────────────────────────────────────────────────────────

export type InboundRoute = { route: "META"; type: MetaChannelType } | { route: "TELEGRAM" } | { route: "WEBCHAT" } | { route: "WHATSAPP_CLOUD" } | { route: "REJECT"; reason: string };

/**
 * How the worker processes one recorded event on one connection. The payload's provider must be the
 * provider of the connection it was recorded for — and for Meta, the same channel type — otherwise the
 * event is REJECTED: kept, marked failed with the reason, never normalised by another provider's code
 * and never counted as processed. Before this, any event without "TELEGRAM" or "WEBCHAT" went to the Meta
 * normaliser.
 */
export function routeInboundEvent(payload: { provider?: unknown; type?: unknown }, connectionType: ChannelType): InboundRoute {
  const provider = providerForChannelType(connectionType);
  const recorded = payload.provider;
  const mismatch = (): InboundRoute => ({
    route: "REJECT",
    reason: `Recorded as a ${typeof recorded === "string" ? recorded.slice(0, 32) : "unknown"} event on a ${CHANNEL_PROVIDERS[provider].label} connection; not processed.`,
  });
  switch (provider) {
    case "META_MESSENGER":
    case "META_INSTAGRAM":
      return recorded === "META" && payload.type === connectionType ? { route: "META", type: connectionType as MetaChannelType } : mismatch();
    case "TELEGRAM":
      return recorded === "TELEGRAM" ? { route: "TELEGRAM" } : mismatch();
    case "WEBCHAT":
      return recorded === "WEBCHAT" ? { route: "WEBCHAT" } : mismatch();
    case "WHATSAPP_CLOUD":
      return recorded === "WHATSAPP_CLOUD" ? { route: "WHATSAPP_CLOUD" } : mismatch();
    default:
      return assertNeverProvider(provider, "channel provider");
  }
}
