import "server-only";
import { withBackoff } from "../queue";
import { ProviderError } from "../types";

/**
 * Speech-to-text via Groq Whisper.
 *
 * This does NOT go through LLMProvider: that interface is chat-shaped
 * (system + user -> text) and STT is multipart audio in, timestamped
 * segments out. Forcing it through would mean a `complete()` that ignores
 * most of its arguments. It still shares the queue and the backoff ladder,
 * so it obeys the same concurrency and 429 rules as everything else.
 *
 * Groq is also the only provider here with a "private" data policy, which is
 * what makes it safe for raw candidate audio.
 */
const MODEL = "whisper-large-v3-turbo";

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4") || mimeType.includes("aac")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

export interface Transcription {
  text: string;
  /** Whisper's own measure of the clip, in ms. */
  durationMs: number;
  provider: string;
}

export async function transcribe(audio: Blob): Promise<Transcription> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set; voice needs it for STT.");

  return withBackoff(async () => {
    const form = new FormData();
    // Whisper keys its decoder off the extension. The browser already named
    // the upload from its real MIME type, so carry that through; iOS sends
    // MP4/AAC, and calling it .webm makes the decode fail.
    const name = audio instanceof File && audio.name ? audio.name : `utterance.${extensionFor(audio.type)}`;
    form.append("file", audio, name);
    form.append("model", MODEL);
    form.append("response_format", "verbose_json");

    const response = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form },
    );

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      const retryAfter = response.headers.get("retry-after");
      throw new ProviderError(
        `Groq Whisper ${response.status}: ${raw.slice(0, 200)}`,
        "groq",
        response.status,
        response.status === 429 || response.status >= 500,
        retryAfter ? Number(retryAfter) * 1000 : undefined,
      );
    }

    const body = (await response.json()) as { text?: string; duration?: number };
    return {
      text: (body.text ?? "").trim(),
      durationMs: Math.round((body.duration ?? 0) * 1000),
      provider: `groq/${MODEL}`,
    };
  });
}
