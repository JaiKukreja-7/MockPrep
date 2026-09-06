import "server-only";
import { createGeminiProvider } from "./providers/gemini";
import { createOpenAICompatibleProvider } from "./providers/openai-compatible";
import type { LLMProvider, ProviderId } from "./types";

/*
  Keys are read here and nowhere else, from non-NEXT_PUBLIC_ variables, so
  they exist only in the server bundle. The "server-only" import above turns
  any accidental client import of this module into a build error rather than
  a leaked key.
*/

const providers: Record<ProviderId, LLMProvider> = {
  gemini: createGeminiProvider(process.env.GEMINI_API_KEY),

  groq: createOpenAICompatibleProvider({
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY,
    // Groq does not train on API content, which is why it is the only
    // provider eligible for resume analysis.
    dataPolicy: "private",
  }),

  openrouter: createOpenAICompatibleProvider({
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    // OpenRouter's free tier requires opting into prompt logging, so it is
    // treated as training-eligible and barred from sensitive tasks.
    dataPolicy: "trains-on-free-tier",
    extraHeaders: {
      "HTTP-Referer": "https://mockprep.local",
      "X-Title": "MockPrep",
    },
  }),
};

export function getProvider(id: ProviderId): LLMProvider {
  return providers[id];
}

export function allProviders(): LLMProvider[] {
  return Object.values(providers);
}
