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
    exampleModelId: "anthropic/claude-3.5-sonnet",
    apiUrlHint: "Prefilled. Model ids are vendor-prefixed, like anthropic/claude-3.5-sonnet.",
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
