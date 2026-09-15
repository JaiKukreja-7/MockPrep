import { afterEach, describe, expect, it, vi } from "vitest";

// stt-tts installs a pagehide guard and touches speechSynthesis on import;
// give it a window with neither.
vi.stubGlobal("window", { addEventListener: () => {} });
vi.stubGlobal("navigator", {});
const { createSttTtsTransport } = await import("@/lib/voice/stt-tts");

afterEach(() => vi.unstubAllGlobals());

const blob = new Blob([new Uint8Array(4)], { type: "audio/webm" });
const turn = { roundId: "r1", offsetMs: 1000 };

async function send(response: Response | Error) {
  vi.stubGlobal("fetch", async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const handle = await createSttTtsTransport().connect("s1");
  return handle.sendUtterance(blob, turn);
}

describe("the voice transport's failures", () => {
  it("a dropped connection surfaces as the browser's own error, for the client to translate", async () => {
    await expect(send(new TypeError("Failed to fetch"))).rejects.toThrow("Failed to fetch");
  });

  it("a non-JSON 401 — the proxy answered, not the route — is 'Not signed in.'", async () => {
    await expect(send(new Response("<html>sign in</html>", { status: 401 }))).rejects.toThrow("Not signed in.");
  });

  it("any other non-JSON answer names the status instead of throwing a parse error", async () => {
    await expect(send(new Response("<html>bad gateway</html>", { status: 502 }))).rejects.toThrow(
      "The server did not answer properly (502).",
    );
  });

  it("a server sentence is thrown as-is", async () => {
    await expect(
      send(new Response(JSON.stringify({ error: "Could not transcribe that. The recording is still here — send it again in a moment." }), { status: 502 })),
    ).rejects.toThrow(/^Could not transcribe that\./);
  });

  it("a scoring failure on the last turn is returned, not thrown — the turn itself succeeded", async () => {
    const body = { lines: [], acknowledgement: null, nextQuestion: null, remainingSeconds: 0, done: false, scoringFailed: true, error: "Scoring did not go through: …" };
    const result = await send(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    expect(result.scoringFailed).toBe(true);
    expect(result.error).toMatch(/^Scoring did not go through/);
  });
});
