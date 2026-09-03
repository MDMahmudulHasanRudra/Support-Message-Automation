import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleClient } from "../OpenAiCompatibleClient.js";
import { MAX_ATTEMPTS, MAX_RETRY_WAIT_MS } from "../retry.js";
import type { AiCallOutcome } from "../types.js";

/**
 * Pure unit test — mocks global fetch, no DB, no real network call. Verifies the request shape
 * sent to an OpenAI-compatible endpoint, response parsing, error handling, and that the API key
 * never ends up anywhere a caller could observe except the Authorization header of the outgoing
 * request itself.
 */

const FAKE_API_KEY = "sk-test-do-not-leak-1234567890";

/** Resolves with the thrown error, and fails the test if the call unexpectedly succeeded. */
function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected this call to fail, but it resolved");
    },
    (err: unknown) => err as Error,
  );
}

describe("OpenAiCompatibleClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends the standard chat-completions request shape with the API key only in the Authorization header", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Sure, which package?" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        { status: 200 },
      ),
    );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", { apiKey: FAKE_API_KEY, baseURL: "https://example.invalid/v1" });
    const result = await client.complete({ systemPrompt: "system text", userPrompt: "user text", maxTokens: 300, temperature: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.invalid/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_API_KEY}`);

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-test");
    expect(body.max_tokens).toBe(300);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: "system", content: "system text" },
      { role: "user", content: "user text" },
    ]);

    expect(result.text).toBe("Sure, which package?");
    expect(result.tokensUsed).toBe(15);
    expect(result.providerId).toBe("provider-1");
    expect(result.modelId).toBe("gpt-test");
  });

  it("defaults to the real OpenAI API base URL when apiUrl is blank", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }));
    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", { apiKey: FAKE_API_KEY, baseURL: null });

    await client.complete({ userPrompt: "hello" });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("omits the system message entirely when no systemPrompt is given", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }));
    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", { apiKey: FAKE_API_KEY, baseURL: "https://example.invalid/v1" });

    await client.complete({ userPrompt: "hello" });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("throws on a non-ok response, without leaking the API key in the error message", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", { apiKey: FAKE_API_KEY, baseURL: "https://example.invalid/v1" });

    await expect(client.complete({ userPrompt: "hello" })).rejects.toThrow(/401/);
    try {
      await client.complete({ userPrompt: "hello" });
    } catch (err) {
      expect((err as Error).message).not.toContain(FAKE_API_KEY);
    }
  });

  it("returns empty text rather than throwing when the response has no choices", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", { apiKey: FAKE_API_KEY, baseURL: "https://example.invalid/v1" });

    const result = await client.complete({ userPrompt: "hello" });
    expect(result.text).toBe("");
    expect(result.tokensUsed).toBe(0);
  });

  it("times out a hung request rather than blocking indefinitely (Slice 3)", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const abortError = new Error("The operation was aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      }),
    );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", { apiKey: FAKE_API_KEY, baseURL: "https://example.invalid/v1" });
    const promise = client.complete({ userPrompt: "hello" });
    const assertion = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
  it("omits the Authorization header entirely when there is no API key (a local Ollama)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "local answer" } }] }), { status: 200 }),
    );

    const client = new OpenAiCompatibleClient("provider-local", "llama3", {
      apiKey: null,
      baseURL: "http://127.0.0.1:11434/v1",
    });
    const result = await client.complete({ userPrompt: "hello" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    // Not "Bearer null", and not an empty Authorization — absent.
    expect(Object.keys(init.headers)).not.toContain("Authorization");
    expect(result.text).toBe("local answer");
  });

  it("sends any extra headers a gateway requires alongside the key", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "routed" } }] }), { status: 200 }),
    );

    const client = new OpenAiCompatibleClient("provider-or", "anthropic/claude-3.5-sonnet", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      extraHeaders: { "HTTP-Referer": "https://example.invalid", "X-Title": "Support Automation" },
    });
    await client.complete({ userPrompt: "hello" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_API_KEY}`);
    expect(init.headers["X-Title"]).toBe("Support Automation");
  });

  it("treats a 200 response carrying an error envelope as a failure, not an empty reply", async () => {
    // OpenRouter and some proxies report upstream failures this way. Parsed as an empty
    // reply it would look like the model declining, which is a different outcome entirely.
    // A fresh Response per attempt, because a body can only be read once and this envelope is
    // classified transient — so the client retries, exactly as it would against a real upstream
    // that is briefly overloaded. Reusing one instance would fail the second read and report a
    // connection problem instead of the provider's own words.
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: "upstream model is overloaded" } }), { status: 200 }),
    );

    const client = new OpenAiCompatibleClient("provider-or", "some/model", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });

    const settled = failure(client.complete({ userPrompt: "hello" }));
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await settled;

    // The upstream's own wording survives the retries — the point of the check.
    expect(error.message).toMatch(/overloaded/i);
  });

  it("reads a reasoning model's answer out of message.reasoning when content is empty", async () => {
    // DeepSeek-R1 and the ":thinking" routes answer this way. Reading content alone recorded a
    // model that had in fact answered as having produced nothing.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: "", reasoning: "Power-cycle the router, then retest." }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 6 },
        }),
        { status: 200 },
      ),
    );

    const client = new OpenAiCompatibleClient("provider-or", "deepseek/r1", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });
    const result = await client.complete({ userPrompt: "internet down" });

    expect(result.text).toBe("Power-cycle the router, then retest.");
    expect(result.tokensUsed).toBe(10);
    expect(result.truncated).toBe(false);
  });

  it("falls back to reasoning_content when content is null", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: null, reasoning_content: "Yes, that plan includes static IP." } }],
        }),
        { status: 200 },
      ),
    );

    const client = new OpenAiCompatibleClient("provider-or", "some/reasoner", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });
    const result = await client.complete({ userPrompt: "static ip?" });

    expect(result.text).toBe("Yes, that plan includes static IP.");
  });

  it("joins content delivered as an array of parts rather than a bare string", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: ["Line one.", { type: "text", text: " Line two." }, { type: "image_url", image_url: {} }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://example.invalid/v1",
    });
    const result = await client.complete({ userPrompt: "hello" });

    // A non-string reaching a caller's text.match() threw a TypeError nowhere near the cause.
    expect(result.text).toBe("Line one. Line two.");
  });

  it("reports a reply the token ceiling cut off as truncated rather than as a malformed one", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Your bill for this mo" }, finish_reason: "length" }] }),
        { status: 200 },
      ),
    );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://example.invalid/v1",
    });
    const result = await client.complete({ userPrompt: "how much do I owe?" });

    expect(result.text).toBe("Your bill for this mo");
    expect(result.finishReason).toBe("length");
    expect(result.truncated).toBe(true);
  });

  it("blames the token limit, not the model, when the whole budget went to hidden reasoning", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), {
        status: 200,
      }),
    );

    const client = new OpenAiCompatibleClient("provider-or", "deepseek/r1", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });

    await expect(client.complete({ userPrompt: "hello" })).rejects.toThrow(/output token limit/i);
    // A ceiling that is too small is a configuration fact, so it must not be retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns a gateway's HTML error page into actionable prose, not a raw SyntaxError", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      new Response("<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://example.invalid/v1",
    });
    const settled = failure(client.complete({ userPrompt: "hello" }));
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await settled;

    expect(error.name).toBe("AiProviderCallError");
    expect(error.message).toMatch(/not JSON/i);
    expect(error.message).not.toMatch(/Unexpected token|JSON\.parse/i);
  });

  it("retries a 429 and returns what the next attempt produced", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "second attempt" } }] }), { status: 200 }),
      );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://example.invalid/v1",
    });
    const promise = client.complete({ userPrompt: "hello" });
    // First backoff is 500ms; a single rate limit must not cost a customer their answer.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await promise).toMatchObject({ text: "second attempt" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 502 from the provider's own infrastructure and returns the recovered answer", async () => {
    // 429 is not the only transient status that matters in practice: an OpenRouter upstream going
    // briefly unavailable answers 502/503, and losing a customer's message to that would be the
    // same defect as losing it to a rate limit.
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "recovered" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200 },
        ),
      );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://example.test/v1",
    });
    const pending = client.complete({ userPrompt: "hello" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect((await pending).text).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits as long as Retry-After asks rather than its own shorter backoff", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "Retry-After": "3" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok now" } }] }), { status: 200 }),
      );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://example.invalid/v1",
    });
    const promise = client.complete({ userPrompt: "hello" });

    await vi.advanceTimersByTimeAsync(1_000);
    // Its own backoff would already have retried by now; the provider asked for longer.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(await promise).toMatchObject({ text: "ok now" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clamps an absurd Retry-After and gives up after MAX_ATTEMPTS", async () => {
    vi.useFakeTimers();
    // Ten minutes, which is far longer than a message's pipeline pass may block for.
    fetchMock.mockResolvedValue(new Response("slow down", { status: 429, headers: { "Retry-After": "600" } }));

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://example.invalid/v1",
    });
    const settled = failure(client.complete({ userPrompt: "hello" }));

    await vi.advanceTimersByTimeAsync(MAX_RETRY_WAIT_MS + 100);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(120_000);
    const error = await settled;

    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(error.message).toMatch(/after 3 attempts/);
  });

  it("does not retry a rejected key or a wrong model id — both are equally true a second later", async () => {
    for (const status of [401, 404]) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "nope" } }), { status }),
      );

      const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
        apiKey: FAKE_API_KEY,
        baseURL: "https://example.invalid/v1",
      });

      await expect(client.complete({ userPrompt: "hello" })).rejects.toThrow(new RegExp(String(status)));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("reports each call's outcome, with the transient flag provider health keys on", async () => {
    const outcomes: AiCallOutcome[] = [];
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "fine" } }] }), { status: 200 }),
      );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://example.invalid/v1",
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    await expect(client.complete({ userPrompt: "hello" })).rejects.toThrow();
    await client.complete({ userPrompt: "hello" });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ ok: false, transient: false });
    expect(outcomes[1]).toEqual({ ok: true });
  });

  it("never lets health bookkeeping change the outcome of the call it describes", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "answered" } }] }), { status: 200 }),
    );

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://example.invalid/v1",
      onOutcome: () => {
        throw new Error("health write failed");
      },
    });

    expect(await client.complete({ userPrompt: "hello" })).toMatchObject({ text: "answered" });
  });
});
