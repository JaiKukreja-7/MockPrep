import { describe, expect, it } from "vitest";
import { describeSubmitFailure } from "@/lib/client-errors";

/**
 * What a failed submit says on screen. Every branch promises the work is
 * still there, because the components that call this keep it there.
 */
describe("describeSubmitFailure", () => {
  it.each([
    ["Chrome", new TypeError("Failed to fetch")],
    ["Firefox", new TypeError("NetworkError when attempting to fetch resource.")],
    ["Safari", new TypeError("Load failed")],
  ])("a dropped connection (%s) says so and keeps the work", (_browser, error) => {
    const out = describeSubmitFailure(error, "answer");
    expect(out.message).toBe(
      "Lost the connection before that was sent. Your answer is still here — check your network and send it again.",
    );
    expect(out.signIn).toBe(false);
  });

  it("an action answered by the proxy's redirect — the session expired — offers sign-in and keeps the work", () => {
    const out = describeSubmitFailure(new Error("An unexpected response was received from the server."), "answer");
    expect(out.message).toMatch(/sign-in expired.*Sign in again in a new tab.*your answer is still here/);
    expect(out.signIn).toBe(true);
  });

  it("the voice route's 401 is the same case, with the recording kept", () => {
    const out = describeSubmitFailure(new Error("Not signed in."), "recording");
    expect(out.signIn).toBe(true);
    expect(out.message).toMatch(/your recording is still here/);
  });

  it("a server sentence passes through with the work kept", () => {
    const out = describeSubmitFailure(new Error("Could not transcribe that. The recording is still here — send it again in a moment."), "recording");
    expect(out.message).toMatch(/^Could not transcribe that\./);
    expect(out.signIn).toBe(false);
  });

  it("an empty error still says something useful", () => {
    expect(describeSubmitFailure(undefined, "answer").message).toBe(
      "That did not go through. Your answer is still here — try again.",
    );
  });
});
