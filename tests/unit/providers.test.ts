import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "@/lib/llm/providers/openai-compatible";
import { createGeminiProvider } from "@/lib/llm/providers/gemini";
import { ProviderError } from "@/lib/llm/types";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const groq = () =>
  createOpenAICompatibleProvider({
    id: "groq",
    label: "Groq",
    baseUrl: "https://groq.test/v1",
    apiKey: "k",
    dataPolicy: "private",
  });

const request = { system: "s", user: "u", model: "m" };

afterEach(() => vi.unstubAllGlobals());

async function providerError(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProviderError) return e;
    throw new Error(`expected ProviderError, got ${String(e)}`);
  }
  throw new Error("expected a rejection");
}

describe("OpenAI-compatible provider error classification", () => {
  it("429 is retryable and carries Retry-After in ms", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "3" }),
    );
    const err = await providerError(groq().complete(request));
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.message).toBe("Groq 429: slow down");
  });

  it("5xx is retryable", async () => {
    vi.stubGlobal("fetch", async () => new Response("bad gateway", { status: 502 }));
    const err = await providerError(groq().complete(request));
    expect(err.retryable).toBe(true);
  });

  it("401 and 400 are not retryable", async () => {
    for (const status of [401, 400, 404]) {
      vi.stubGlobal("fetch", async () => jsonResponse(status, { error: { message: "no" } }));
      const err = await providerError(groq().complete(request));
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(false);
    }
  });

  it("a 200 with empty content and finish_reason 'length' is retryable — the model spent its budget thinking", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] }),
    );
    const err = await providerError(groq().complete(request));
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/returned no content \(finish_reason: length\)/);
  });

  it("a 200 with empty content and a clean finish_reason is retryable once — a hiccup, not a budget problem", async () => {
    // Why once: free tiers intermittently return a clean 200 with nothing in
    // it. One more try usually lands, so a hard fail would kill a round for
    // nothing; but if the second answer is empty too the provider is empty
    // today, and spending 2/4/8s more on it only delays the failover.
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, { choices: [{ message: { content: "  \n" }, finish_reason: "stop" }] }),
    );
    const err = await providerError(groq().complete(request));
    expect(err.retryable).toBe("once");
    expect(err.message).toMatch(/finish_reason: stop/);
  });

  it("a 200 with no choices at all is the same once-retryable empty", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, {}));
    const err = await providerError(groq().complete(request));
    expect(err.retryable).toBe("once");
    expect(err.message).toMatch(/finish_reason: unknown/);
  });

  it("an unconfigured provider throws without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const p = createOpenAICompatibleProvider({
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://x",
      apiKey: undefined,
      dataPolicy: "trains-on-free-tier",
    });
    expect(p.isConfigured()).toBe(false);
    await providerError(p.complete(request));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the key as a bearer token and asks for JSON when requested", async () => {
    let seen: { headers: Headers; body: string } | null = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen = { headers: new Headers(init.headers), body: String(init.body) };
      return jsonResponse(200, { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
    });
    await groq().complete({ ...request, json: true });
    expect(seen!.headers.get("authorization")).toBe("Bearer k");
    expect(JSON.parse(seen!.body).response_format).toEqual({ type: "json_object" });
  });
});

describe("Gemini provider", () => {
  it("empty content with finishReason MAX_TOKENS is retryable", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }),
    );
    const err = await providerError(createGeminiProvider("k").complete(request));
    expect(err.retryable).toBe(true);
  });

  it("empty content with any other finishReason is retryable once", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] }),
    );
    const err = await providerError(createGeminiProvider("k").complete(request));
    expect(err.retryable).toBe("once");
  });

  it("joins text parts and ignores thought-signature parts without text", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ thoughtSignature: "x" }, { text: "{\"a\":" }, { text: "1}" }] } }],
      }),
    );
    const result = await createGeminiProvider("k").complete(request);
    expect(result.text).toBe('{"a":1}');
    expect(result.provider).toBe("gemini");
  });
});
