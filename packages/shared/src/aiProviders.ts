/**
 * One description of every AI connection method the app supports, shared by the provider
 * form (apps/web) and the client resolver (packages/ai-client) so the endpoint the UI
 * suggests is always the endpoint the request actually goes to.
 *
 * `AiProviderKind` is mirrored from the Prisma schema by hand, the same convention the rest
 * of this package follows — see enums.ts.
 */

export const AI_PROVIDER_KIND = [
  "ANTHROPIC",
  "OPENAI",
  "OPENROUTER",
  "OLLAMA",
  "GOOGLE",
  "CUSTOM",
] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KIND)[number];

export interface AiProviderProfile {
  kind: AiProviderKind;
  /** How the connection method is named in the UI. */
  label: string;
  /** One line explaining when someone would pick this. */
  description: string;
  /** Endpoint used when the provider's own API URL field is left blank. */
  defaultApiUrl: string | null;
  /** False only for a keyless local runtime. */
  requiresApiKey: boolean;
  /** Whether a working client exists for this kind today. */
  implemented: boolean;
  /** A real model id for this provider, shown as the field's placeholder. */
  exampleModelId: string;
  /** Shown under the API URL field. */
  apiUrlHint: string;
}

/** One entry of a provider's live model catalogue, reduced to what the picker needs. */
export interface AiModelListEntry {
  id: string;
  label: string;
}

export const AI_PROVIDER_PROFILES: Record<AiProviderKind, AiProviderProfile> = {
  ANTHROPIC: {
    kind: "ANTHROPIC",
    label: "Anthropic",
    description: "Claude models direct from Anthropic. The only kind the AI Admin Assistant can use.",
    defaultApiUrl: null,
    requiresApiKey: true,
    implemented: true,
    exampleModelId: "claude-sonnet-4-5",
    apiUrlHint: "Leave blank unless you route Anthropic through a proxy.",
  },
  OPENAI: {
    kind: "OPENAI",
    label: "OpenAI",
    description: "GPT models direct from OpenAI, or any private endpoint that speaks the same protocol.",
    defaultApiUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    implemented: true,
    exampleModelId: "gpt-4o-mini",
    apiUrlHint: "Leave blank for OpenAI itself. Set it to reach a compatible proxy instead.",
  },
  OPENROUTER: {
    kind: "OPENROUTER",
    label: "OpenRouter",
    description: "One key, hundreds of models from many vendors. Good for trying models before committing.",
    defaultApiUrl: "https://openrouter.ai/api/v1",
    requiresApiKey: true,
    implemented: true,
    exampleModelId: "anthropic/claude-sonnet-4.5",
    apiUrlHint: "Prefilled. Model ids are vendor-prefixed, like anthropic/claude-sonnet-4.5.",
  },
  OLLAMA: {
    kind: "OLLAMA",
    label: "Ollama (self-hosted)",
    description: "A model running on your own machine or server. No API key, no per-message cost.",
    defaultApiUrl: "http://127.0.0.1:11434/v1",
    requiresApiKey: false,
    implemented: true,
    exampleModelId: "llama3.1",
    apiUrlHint:
      "Point this at your Ollama host. From inside Docker, localhost is the container — use host.docker.internal or the host IP.",
  },
  GOOGLE: {
    kind: "GOOGLE",
    label: "Google Gemini",
    description: "Not implemented yet — Gemini's API differs enough to need its own client.",
    defaultApiUrl: null,
    requiresApiKey: true,
    implemented: false,
    exampleModelId: "gemini-1.5-pro",
    apiUrlHint: "",
  },
  CUSTOM: {
    kind: "CUSTOM",
    label: "Custom",
    description: "Reserved. For anything OpenAI-compatible, use OpenAI and set the API URL instead.",
    defaultApiUrl: null,
    requiresApiKey: true,
    implemented: false,
    exampleModelId: "",
    apiUrlHint: "",
  },
};

/** The kinds the provider form offers — only those that actually work end to end. */
export const SELECTABLE_AI_PROVIDER_KINDS: AiProviderKind[] = AI_PROVIDER_KIND.filter(
  (kind) => AI_PROVIDER_PROFILES[kind].implemented,
);

/** Kinds served by the shared OpenAI-compatible chat-completions client. */
export const OPENAI_COMPATIBLE_KINDS: AiProviderKind[] = ["OPENAI", "OPENROUTER", "OLLAMA"];

export function isOpenAiCompatibleKind(kind: string): boolean {
  return (OPENAI_COMPATIBLE_KINDS as string[]).includes(kind);
}

export function aiProviderProfile(kind: string): AiProviderProfile | null {
  return (AI_PROVIDER_PROFILES as Record<string, AiProviderProfile>)[kind] ?? null;
}

/** True when a provider of this kind must be saved with an API key. */
export function providerRequiresApiKey(kind: string): boolean {
  return aiProviderProfile(kind)?.requiresApiKey ?? true;
}

/**
 * OpenRouter attributes traffic — and ranks apps on its public leaderboard — by this header pair.
 * The value used to be a hardcoded github.com URL that does not exist, which is worse than useless:
 * it attributes this deployment's usage to a dead link. Deployments differ, so it is env-driven,
 * defaulting to wherever the dashboard itself is configured to live. Read lazily rather than at
 * module load because this file is also bundled into the provider form (a Client Component).
 */
export function openRouterAttributionHeaders(): Record<string, string> {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const siteUrl = env?.OPENROUTER_SITE_URL || env?.NEXTAUTH_URL || "http://localhost:3000";
  return {
    "HTTP-Referer": siteUrl,
    "X-Title": env?.OPENROUTER_APP_TITLE || "Support Message Automation",
  };
}

export interface AiFailureDescription {
  /** Actionable prose for an admin — never a raw response body. */
  message: string;
  /** True when retrying the identical request could plausibly succeed (rate limit, outage). */
  transient: boolean;
}

/**
 * Turns a provider's HTTP failure into something an admin can act on. Both the Test Connection
 * button and the live completion clients classify through here, so "invalid key" reads the same
 * whether it surfaced from a test or from a customer message that went unanswered.
 *
 * The response body is parsed for a provider-supplied `error.message` and otherwise DISCARDED —
 * a Cloudflare/proxy error page is HTML, and pasting a page of markup into the dashboard tells an
 * operator nothing while burying the status code that does.
 */
export function describeAiHttpFailure(status: number, body?: string): AiFailureDescription {
  const detail = extractProviderErrorMessage(body);
  const withDetail = (text: string) => (detail ? `${text} Provider said: ${detail}` : text);

  if (status === 401) {
    return {
      message: withDetail("The API key was rejected (401). Check the key on this provider, and that it has not been revoked."),
      transient: false,
    };
  }
  if (status === 403) {
    return {
      message: withDetail("Access denied (403). The key works but is not allowed to use this model or endpoint."),
      transient: false,
    };
  }
  if (status === 402) {
    return {
      message: withDetail("The provider account is out of credit (402). Top it up, then test again."),
      transient: false,
    };
  }
  if (status === 404) {
    return {
      message: withDetail("Not found (404). Either the model id does not exist on this provider or the API URL is wrong."),
      transient: false,
    };
  }
  if (status === 400) {
    const looksLikeModel = /model/i.test(detail ?? "");
    return {
      message: withDetail(
        looksLikeModel
          ? "The provider rejected the model id (400). Pick a model from its list rather than typing one."
          : "The provider rejected the request (400).",
      ),
      transient: false,
    };
  }
  if (status === 429) {
    return { message: withDetail("Rate limited by the provider (429). This usually clears on its own."), transient: true };
  }
  if (status >= 500) {
    return { message: withDetail(`The provider returned a server error (${status}). This is on their side.`), transient: true };
  }
  return { message: withDetail(`The provider rejected the request (${status}).`), transient: false };
}

/** Classifies a thrown fetch/network error (no HTTP status ever arrived). */
export function describeAiNetworkFailure(error: unknown, endpoint?: string): AiFailureDescription {
  const name = (error as { name?: string } | null)?.name;
  const raw = (error as { message?: string } | null)?.message ?? "";
  const where = endpoint ? ` at ${safeHost(endpoint)}` : "";

  if (name === "AbortError" || /timed out|timeout/i.test(raw)) {
    return { message: `The provider${where} timed out before it answered.`, transient: true };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return { message: `The API URL's host${where} could not be resolved. Check the address for a typo.`, transient: false };
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return {
      message: `Nothing accepted the connection${where}. If this is a local runtime, confirm it is running and reachable from this container.`,
      transient: false,
    };
  }
  if (/certificate|self.signed|SSL|TLS/i.test(raw)) {
    return { message: `The TLS certificate${where} was rejected.`, transient: false };
  }
  return { message: `Could not reach the provider${where}.`, transient: true };
}

/** Pulls a provider's own error text out of a JSON body; returns null for HTML or anything unparseable. */
function extractProviderErrorMessage(body?: string): string | null {
  if (!body) return null;
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string } | string; message?: string };
    const raw =
      typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message ?? null);
    if (!raw) return null;
    const collapsed = raw.replace(/\s+/g, " ").trim();
    return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
  } catch {
    return null;
  }
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
