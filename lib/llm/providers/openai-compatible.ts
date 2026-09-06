import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type DataPolicy,
  type LLMProvider,
  type ProviderId,
} from "../types";

interface Config {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey: string | undefined;
  dataPolicy: DataPolicy;
  /** OpenRouter asks for attribution headers; Groq ignores them. */
  extraHeaders?: Record<string, string>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; reasoning?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}

/**
 * Groq and OpenRouter both speak the OpenAI chat-completions shape, so they
 * share one implementation and differ only by config. Gemini does not, and
 * has its own provider.
 */
export function createOpenAICompatibleProvider(config: Config): LLMProvider {
  return {
    id: config.id,
    label: config.label,
    dataPolicy: config.dataPolicy,

    isConfigured() {
      return Boolean(config.apiKey);
    },

    async complete(request: CompletionRequest, signal?: AbortSignal) {
      if (!config.apiKey) {
        throw new ProviderError(
          `${config.label} API key is not set`,
          config.id,
          undefined,
          false,
        );
      }

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          ...config.extraHeaders,
        },
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          temperature: request.temperature ?? 0.4,
          max_tokens: request.maxOutputTokens ?? 4000,
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
        }),
      });

      if (!response.ok) {
        throw await toProviderError(response, config.id, config.label);
      }

      const body = (await response.json()) as ChatCompletionResponse;
      const choice = body.choices?.[0];
      const text = choice?.message?.content ?? "";

      if (!text.trim()) {
        // A reasoning model that spends its whole budget thinking returns an
        // empty content with finish_reason "length" and HTTP 200. Treat that
        // as retryable rather than letting an empty string reach the parser.
        throw new ProviderError(
          `${config.label} returned no content (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
          config.id,
          undefined,
          choice?.finish_reason === "length",
        );
      }

      return {
        text,
        provider: config.id,
        model: request.model,
      } satisfies CompletionResult;
    },
  };
}

async function toProviderError(
  response: Response,
  id: ProviderId,
  label: string,
): Promise<ProviderError> {
  const raw = await response.text().catch(() => "");
  let message = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as ChatCompletionResponse;
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // keep the raw text
  }

  const retryAfter = response.headers.get("retry-after");
  return new ProviderError(
    `${label} ${response.status}: ${message}`,
    id,
    response.status,
    response.status === 429 || response.status >= 500,
    retryAfter ? Number(retryAfter) * 1000 : undefined,
  );
}
