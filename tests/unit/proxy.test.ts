import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTAGE_MESSAGE } from "@/lib/supabase/outage";

/**
 * The proxy's three answers to "who is this?": a user, nobody, and "could
 * not ask". The third used to look like the second.
 */

let getUser: () => Promise<{ data: { user: unknown }; error: unknown }>;
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: () => getUser() } }),
}));

// env.ts reads these once at import, so they must exist before the proxy loads.
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "k");
const { updateSession, OUTAGE_HEADER } = await import("@/lib/supabase/proxy");

const outage = { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 };
const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost:3000${path}`, { method: init.method ?? "GET", headers: init.headers });

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe("no session", () => {
  beforeEach(() => {
    getUser = async () => ({ data: { user: null }, error: null });
  });

  it("redirects a private page to sign-in with the path to come back to", async () => {
    const res = await updateSession(req("/sessions"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe(
      "/sign-in?next=%2Fsessions",
    );
  });

  it("answers an API call with a JSON 401", async () => {
    const res = await updateSession(req("/api/voice/turn", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });
  });

  it("lets public paths through", async () => {
    for (const p of ["/", "/sign-in", "/unavailable", "/test"]) {
      expect((await updateSession(req(p))).status).toBe(200);
    }
  });
});

describe("could not check — Supabase unreachable", () => {
  beforeEach(() => {
    getUser = async () => ({ data: { user: null }, error: outage });
  });

  it("does NOT bounce a private page to sign-in; it serves the unavailable page and marks the response", async () => {
    const res = await updateSession(req("/sessions"));
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
    // A rewrite: the URL stays, the content comes from /unavailable.
    const rewrite = res.headers.get("x-middleware-rewrite");
    expect(rewrite).toBeTruthy();
    const target = new URL(rewrite!);
    expect(target.pathname).toBe("/unavailable");
    expect(target.searchParams.get("from")).toBe("/sessions");
    expect(res.headers.get(OUTAGE_HEADER)).toBe("1");
  });

  it("answers an API call with a 503 and the sentence, not a 401", async () => {
    const res = await updateSession(req("/api/voice/turn", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: OUTAGE_MESSAGE });
  });

  it("lets a server action through so it can answer into its own form", async () => {
    const res = await updateSession(req("/session/abc", { method: "POST", headers: { "next-action": "deadbeef" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get(OUTAGE_HEADER)).toBe("1");
  });

  it("still serves public paths", async () => {
    const res = await updateSession(req("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("logs it server-side, once per request, naming the path", async () => {
    await updateSession(req("/dashboard"));
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toMatch(/Supabase unreachable while checking the session for GET \/dashboard: fetch failed/);
  });
});

describe("isSupabaseOutage", () => {
  it("recognises the shapes supabase-js produces, and nothing else", async () => {
    const { isSupabaseOutage } = await import("@/lib/supabase/outage");
    expect(isSupabaseOutage({ name: "AuthRetryableFetchError", message: "x", status: 0 })).toBe(true);
    expect(isSupabaseOutage({ message: "TypeError: fetch failed" })).toBe(true);
    expect(isSupabaseOutage({ message: "connect ECONNREFUSED 127.0.0.1:9" })).toBe(true);
    expect(isSupabaseOutage({ name: "AuthApiError", message: "Invalid login credentials", status: 400 })).toBe(false);
    expect(isSupabaseOutage({ message: "JWT expired", status: 401 })).toBe(false);
    expect(isSupabaseOutage(null)).toBe(false);
    expect(isSupabaseOutage("fetch failed")).toBe(false);
  });
});
