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

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", FAKE_API_KEY, "https://example.invalid/v1");
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
    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", FAKE_API_KEY, null);

    await client.complete({ userPrompt: "hello" });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("omits the system message entirely when no systemPrompt is given", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }));
    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", FAKE_API_KEY, "https://example.invalid/v1");

    await client.complete({ userPrompt: "hello" });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("throws on a non-ok response, without leaking the API key in the error message", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", FAKE_API_KEY, "https://example.invalid/v1");

    await expect(client.complete({ userPrompt: "hello" })).rejects.toThrow(/401/);
    try {
      await client.complete({ userPrompt: "hello" });
    } catch (err) {
      expect((err as Error).message).not.toContain(FAKE_API_KEY);
    }
  });

  it("returns empty text rather than throwing when the response has no choices", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", FAKE_API_KEY, "https://example.invalid/v1");

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

    const client = new OpenAiCompatibleClient("provider-1", "gpt-test", FAKE_API_KEY, "https://example.invalid/v1");
    const promise = client.complete({ userPrompt: "hello" });
    const assertion = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});
