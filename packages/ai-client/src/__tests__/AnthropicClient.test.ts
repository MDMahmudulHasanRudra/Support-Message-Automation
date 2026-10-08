import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicClient } from "../AnthropicClient.js";
import { MAX_ATTEMPTS } from "../retry.js";

/**
 * Pure unit test — the Anthropic SDK is mocked, so there is no DB, no network call and no real
 * key. Verifies the request this client builds, that only text blocks reach a caller, and that
 * the retry policy it implements itself (the SDK is constructed with maxRetries: 0 on purpose)
 * distinguishes a blip from a configuration fact.
 */

const FAKE_API_KEY = "sk-ant-test-do-not-leak-1234567890";

const mocks = vi.hoisted(() => ({ create: vi.fn(), constructed: [] as Array<Record<string, unknown>> }));

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mocks.create };
    constructor(options: Record<string, unknown>) {
      mocks.constructed.push(options);
    }
  }
  return { default: MockAnthropic };
});

/** The shape @anthropic-ai/sdk's messages.create() resolves to, reduced to what this client reads. */
function reply(
  content: Array<Record<string, unknown>>,
  extra: { stop_reason?: string | null; input_tokens?: number; output_tokens?: number } = {},
) {
  return {
    content,
    usage: { input_tokens: extra.input_tokens ?? 7, output_tokens: extra.output_tokens ?? 3 },
    stop_reason: extra.stop_reason ?? "end_turn",
  };
}

/** Resolves with the thrown error, and fails the test if the call unexpectedly succeeded. */
function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected this call to fail, but it resolved");
    },
    (err: unknown) => err as Error,
  );
}

describe("AnthropicClient", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.constructed.length = 0;
    vi.useRealTimers();
  });

  it("sends the model, token ceiling, system prompt and temperature the caller asked for", async () => {
    mocks.create.mockResolvedValue(reply([{ type: "text", text: "Sure, which package?" }], { input_tokens: 10, output_tokens: 5 }));

    const client = new AnthropicClient("provider-1", "claude-test", FAKE_API_KEY, "https://example.invalid");
    const result = await client.complete({
      systemPrompt: "system text",
      userPrompt: "user text",
      maxTokens: 300,
      temperature: 0,
    });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const [params, options] = mocks.create.mock.calls[0]!;
    expect(params).toEqual({
      model: "claude-test",
      max_tokens: 300,
      temperature: 0,
      system: "system text",
      messages: [{ role: "user", content: "user text" }],
    });
    // A per-attempt timeout, so no single attempt can outlive the whole call's budget.
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(30_000);

    expect(result).toMatchObject({
      text: "Sure, which package?",
      tokensUsed: 15,
      providerId: "provider-1",
      modelId: "claude-test",
      finishReason: "end_turn",
      truncated: false,
    });
  });

  it("constructs the SDK with both a timeout and maxRetries: 0", () => {
    new AnthropicClient("provider-1", "claude-test", FAKE_API_KEY, null);

    // Together, not separately: the SDK retries a per-attempt timeout by default, which would let
    // one call block the pipeline for ~3x the intended ceiling.
    expect(mocks.constructed[0]).toMatchObject({ apiKey: FAKE_API_KEY, timeout: 30_000, maxRetries: 0 });
    // A blank API URL must mean "the provider's real default endpoint", not an empty string.
    expect(mocks.constructed[0]!.baseURL).toBeUndefined();
  });

  it("defaults max_tokens rather than sending none", async () => {
    mocks.create.mockResolvedValue(reply([{ type: "text", text: "hi" }]));

    await new AnthropicClient("provider-1", "claude-test", FAKE_API_KEY).complete({ userPrompt: "hello" });

    const [params] = mocks.create.mock.calls[0]!;
    expect(params.max_tokens).toBe(1024);
    expect(params.system).toBeUndefined();
  });

  it("returns only text blocks, dropping thinking and tool_use content", async () => {
    mocks.create.mockResolvedValue(
      reply([
        { type: "thinking", thinking: "internal deliberation the customer must never see" },
        { type: "text", text: "First line." },
        { type: "tool_use", id: "tu_1", name: "whatever", input: {} },
        { type: "text", text: "Second line." },
      ]),
    );

    const result = await new AnthropicClient("provider-1", "claude-test", FAKE_API_KEY).complete({
      userPrompt: "hello",
    });

    expect(result.text).toBe("First line.\nSecond line.");
  });

  it("flags a reply the token ceiling cut off", async () => {
    mocks.create.mockResolvedValue(reply([{ type: "text", text: "Your bill for this mo" }], { stop_reason: "max_tokens" }));

    const result = await new AnthropicClient("provider-1", "claude-test", FAKE_API_KEY).complete({
      userPrompt: "how much do I owe?",
    });

    expect(result.finishReason).toBe("max_tokens");
    expect(result.truncated).toBe(true);
  });

  it("retries a rate limit and returns what the next attempt produced", async () => {
    vi.useFakeTimers();
    mocks.create
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce(reply([{ type: "text", text: "second attempt" }]));

    const promise = new AnthropicClient("provider-1", "claude-test", FAKE_API_KEY).complete({ userPrompt: "hello" });
    // First backoff is 500ms; a single rate limit must not cost a customer their answer.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await promise).toMatchObject({ text: "second attempt" });
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_ATTEMPTS on a provider that stays rate limited", async () => {
    vi.useFakeTimers();
    mocks.create.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));

    const settled = failure(new AnthropicClient("provider-1", "claude-test", FAKE_API_KEY).complete({ userPrompt: "hello" }));
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await settled;

    expect(mocks.create).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(error.name).toBe("AiProviderCallError");
    expect(error.message).toMatch(/after 3 attempts/);
  });

  it("does not retry a rejected key, and never repeats it in the error", async () => {
    mocks.create.mockRejectedValue(
      Object.assign(new Error("invalid x-api-key"), { status: 401 }),
    );

    const error = await failure(new AnthropicClient("provider-1", "claude-test", FAKE_API_KEY).complete({ userPrompt: "hello" }));

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(error.message).toMatch(/401/);
    expect(error.message).not.toContain(FAKE_API_KEY);
  });

  it("reports each call's outcome to the health hook, with the transient flag it keys on", async () => {
    const outcomes: unknown[] = [];
    mocks.create
      .mockRejectedValueOnce(Object.assign(new Error("invalid x-api-key"), { status: 401 }))
      .mockResolvedValueOnce(reply([{ type: "text", text: "fine" }]));

    const client = new AnthropicClient("provider-1", "claude-test", FAKE_API_KEY, {
      baseURL: null,
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    await expect(client.complete({ userPrompt: "hello" })).rejects.toThrow();
    await client.complete({ userPrompt: "hello" });

    expect(outcomes[0]).toMatchObject({ ok: false, transient: false });
    expect(outcomes[1]).toEqual({ ok: true });
  });
});
