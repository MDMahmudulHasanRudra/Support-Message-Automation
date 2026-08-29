import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleClient } from "../OpenAiCompatibleClient.js";

/**
 * Pure unit test — mocks global fetch, no DB, no real network call. Verifies the request shape
 * sent to an OpenAI-compatible endpoint, response parsing, error handling, and that the API key
 * never ends up anywhere a caller could observe except the Authorization header of the outgoing
 * request itself.
 */

const FAKE_API_KEY = "sk-test-do-not-leak-1234567890";

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
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "upstream model is overloaded" } }), { status: 200 }),
    );

    const client = new OpenAiCompatibleClient("provider-or", "some/model", {
      apiKey: FAKE_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });

    await expect(client.complete({ userPrompt: "hello" })).rejects.toThrow(/overloaded/i);
  });
});
