/**
 * Voice transport boundary.
 *
 * =========================================================================
 * WHY THE NATIVE-AUDIO PATH IS NOT WIRED  (verified 2026-09-05)
 * =========================================================================
 *
 * The intended primary was Gemini native audio Live, speech-to-speech:
 *   model: gemini-2.5-flash-native-audio-preview-12-2025
 *
 * The model IS available on the free tier. Connecting to
 *   wss://generativelanguage.googleapis.com/ws/
 *     google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<API_KEY>
 * returns setupComplete and ~27KB of PCM audio for a one-word prompt.
 *
 * What does NOT work is the auth mechanism that would let a browser hold
 * that socket safely. Ephemeral tokens mint successfully:
 *   POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens
 *   -> 200 {"name": "auth_tokens/<hash>"}
 * but every attempt to authenticate the Live socket with one is rejected.
 * Tried, all failing:
 *   - v1alpha and v1beta endpoints
 *   - ?access_token=<token>   -> 1008 "Method doesn't allow unregistered
 *                                callers (callers without established identity)"
 *   - ?key=<token>            -> 1007 "API key not valid"
 *   - token name full ("auth_tokens/x") and stripped ("x")
 *   - minted with and without bidi_generate_content_setup model constraints
 * Twelve combinations. The same socket with a real API key works, so this is
 * the token mechanism, not the model or the endpoint. Most likely ephemeral
 * tokens need a paid tier or per-project enablement.
 *
 * Putting the real key in the browser to work around that is not an option:
 * it is extractable by anyone who opens devtools, and it is the same key the
 * server uses for every other task.
 *
 * THE PLAN: a small Node relay on Cloud Run, holding GEMINI_API_KEY, with the
 * browser connecting to it instead of to Google. That relay is a SEPARATE
 * SERVICE, not a custom server for this Next app — Next stays serverless.
 * `RelayVoiceTransport` below is the seam it plugs into: give it the relay's
 * URL and implement connect(); nothing in the session UI changes, because the
 * mic, the level meter and barge-in all talk to VoiceSessionHandle.
 *
 * Until then `SttTtsVoiceTransport` is the live path: Groq Whisper for STT,
 * Gemini Flash for the brain, Web Speech API for TTS. It is turn-based rather
 * than duplex, and it needs no ephemeral token at all, because the browser
 * never talks to a provider — it talks to our own /api/voice/turn.
 * =========================================================================
 */

export type VoiceTransportId = "stt-tts" | "relay";

export interface VoiceTranscriptLine {
  speaker: "interviewer" | "candidate";
  text: string;
  startMs: number;
  endMs: number;
}

export interface VoiceTurnResult {
  /** Lines persisted by the server this turn. */
  lines: VoiceTranscriptLine[];
  /**
   * One-sentence bridge from the interviewer. Never contains a question —
   * see interviewer-turn.ts for why that separation matters.
   */
  acknowledgement: string | null;
  /**
   * The next question, verbatim. The SAME string the heading will show and
   * the transcript will log, so spoken/displayed/logged cannot drift apart.
   */
  nextQuestion: string | null;
  /** Whole-round voice budget left, in seconds. Zero means hard stop. */
  remainingSeconds: number;
  /** True when the round is over and scoring has been kicked off. */
  done: boolean;
}

export interface VoiceTurnContext {
  roundId: string;
  /** Milliseconds since the round started, when this utterance began. */
  offsetMs: number;
}

export interface VoiceSessionHandle {
  /**
   * Hands over one captured utterance.
   *
   * Turn-based today. A duplex relay would stream chunks through the same
   * method and resolve when the model yields its turn, so callers do not
   * need to know which transport they are on. Turn context is an argument
   * rather than handle state, so one handle can serve a whole round without
   * anything mutable sitting between turns.
   */
  sendUtterance(
    audio: Blob,
    turn: VoiceTurnContext,
  ): Promise<VoiceTurnResult>;
  /** Barge-in. Must be safe to call when nothing is playing. */
  interrupt(): void;
  close(): void;
}

export interface VoiceTransport {
  readonly id: VoiceTransportId;
  readonly label: string;
  /** False when the transport's dependencies are missing in this browser. */
  isAvailable(): boolean;
  connect(sessionId: string): Promise<VoiceSessionHandle>;
}
