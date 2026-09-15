import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
} from "../types";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

/**
 * Gemini is the odd one out: different endpoint shape, different auth header,
 * system prompt in its own field, and JSON requested via responseMimeType
 * rather than response_format. All of that is contained here so the task
 * layer never has to know which provider it landed on.
 *
 * Data policy is `trains-on-free-tier`: Google's free-tier terms permit
 * training on submitted content, which is why the routing table refuses to
 * send anything marked sensitive here.
 */
export function createGeminiProvider(apiKey: string | undefined): LLMProvider {
  return {
    id: "gemini",
    label: "Gemini",
    dataPolicy: "trains-on-free-tier",

    isConfigured() {
      return Boolean(apiKey);
    },

    async complete(request: CompletionRequest, signal?: AbortSignal) {
      if (!apiKey) {
        throw new ProviderError(
          "Gemini API key is not set",
          "gemini",
          undefined,
          false,
        );
      }

      const response = await fetch(
        `${BASE}/${encodeURIComponent(request.model)}:generateContent`,
        {
          method: "POST",
          signal,
          headers: {
            // Header rather than a query param, so the key stays out of URLs
            // and anything that logs them.
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: "user", parts: [{ text: request.user }] }],
            generationConfig: {
              temperature: request.temperature ?? 0.4,
              // Gemini 3.x thinking tokens are drawn from this budget, so it
              // has to be generous or the response comes back empty.
              maxOutputTokens: request.maxOutputTokens ?? 4000,
              ...(request.json
                ? { responseMimeType: "application/json" }
                : {}),
            },
          }),
        },
      );

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        let message = raw.slice(0, 300);
        try {
          const parsed = JSON.parse(raw) as GeminiResponse;
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          // keep raw
        }
        const retryAfter = response.headers.get("retry-after");
        throw new ProviderError(
          `Gemini ${response.status}: ${message}`,
          "gemini",
          response.status,
          response.status === 429 || response.status >= 500,
          retryAfter ? Number(retryAfter) * 1000 : undefined,
        );
      }

      const body = (await response.json()) as GeminiResponse;
      const candidate = body.candidates?.[0];
      // Parts can include thought signatures alongside text; join the text.
      const text = (candidate?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("");

      if (!text.trim()) {
        throw new ProviderError(
          `Gemini returned no content (finishReason: ${candidate?.finishReason ?? "unknown"})`,
          "gemini",
          undefined,
          // Same two shapes as the OpenAI-compatible provider: budget spent
          // is fully retryable, an otherwise-clean empty answer gets one go.
          candidate?.finishReason === "MAX_TOKENS" ? true : "once",
        );
      }

      return { text, provider: "gemini", model: request.model } satisfies CompletionResult;
    },
  };
}
