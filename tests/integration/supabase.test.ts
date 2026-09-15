import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { requireEnv } from "../support/env";
import type { Database } from "@/lib/supabase/types";

/**
 * Against the real Supabase project, as a brand-new anonymous user — the
 * same path a guest takes, needing no credentials beyond the publishable
 * key. Two invariants that only the database can prove:
 *
 *   1. consume_llm_quota under concurrency: two simultaneous calls at the
 *      cap boundary, exactly one succeeds, and a rejected call never spends.
 *      This needs two real connections racing on the FOR UPDATE row, which
 *      an in-process fake could not exercise.
 *   2. Column grants: a guest may change display_name and nothing else about
 *      their own row. RLS gates rows, not columns; this is what stops a guest
 *      promoting themselves.
 *
 * Each run leaves one anonymous user behind. Clean them up occasionally:
 *   delete from auth.users where is_anonymous and created_at < now() - interval '1 day';
 */

const GUEST_CAP = 10; // handle_new_user() in 20260905010000_llm_quota.sql

let supabase: SupabaseClient<Database>;
let userId: string;

beforeAll(async () => {
  supabase = createClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false } },
  );
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) throw new Error(`anonymous sign-in failed: ${error?.message}`);
  userId = data.user.id;
});

async function consume(cost: number) {
  const { data, error } = await supabase.rpc("consume_llm_quota", { p_cost: cost });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as { allowed: boolean; used: number; cap: number };
}

describe("consume_llm_quota", () => {
  it("a new guest starts at 0 of the guest cap", async () => {
    // Cost 0 reads the counter without spending.
    const r = await consume(0);
    expect(r).toEqual({ allowed: true, used: 0, cap: GUEST_CAP });
  });

  it("spends up to one below the cap", async () => {
    const r = await consume(GUEST_CAP - 1);
    expect(r).toEqual({ allowed: true, used: GUEST_CAP - 1, cap: GUEST_CAP });
  });

  it("a request that would overshoot is rejected and spends nothing", async () => {
    const r = await consume(2);
    expect(r.allowed).toBe(false);
    expect(r.used).toBe(GUEST_CAP - 1); // unchanged — not partially spent
  });

  it("two simultaneous requests for the last unit: exactly one succeeds", async () => {
    const [a, b] = await Promise.all([consume(1), consume(1)]);
    const allowed = [a, b].filter((r) => r.allowed);
    expect(allowed).toHaveLength(1);
    // Both saw a consistent counter: the winner reports the cap, the loser
    // reports either the pre-race value or the cap, never more than the cap.
    for (const r of [a, b]) expect(r.used).toBeLessThanOrEqual(GUEST_CAP);
    expect(Math.max(a.used, b.used)).toBe(GUEST_CAP);
  });

  it("at the cap, everything is rejected and the counter holds", async () => {
    const r = await consume(1);
    expect(r).toEqual({ allowed: false, used: GUEST_CAP, cap: GUEST_CAP });
  });
});

describe("guest column grants on public.users", () => {
  it("rejects is_guest", async () => {
    const { error } = await supabase.from("users").update({ is_guest: false }).eq("id", userId);
    expect(error?.code).toBe("42501");
  });

  it("rejects daily_request_cap", async () => {
    const { error } = await supabase
      .from("users")
      .update({ daily_request_cap: 9999 })
      .eq("id", userId);
    expect(error?.code).toBe("42501");
  });

  it("rejects daily_voice_sec_cap", async () => {
    const { error } = await supabase
      .from("users")
      .update({ daily_voice_sec_cap: 999999 })
      .eq("id", userId);
    expect(error?.code).toBe("42501");
  });

  it("accepts display_name, and only for the caller's own row", async () => {
    const { error } = await supabase
      .from("users")
      .update({ display_name: "Integration test" })
      .eq("id", userId);
    expect(error).toBeNull();

    const { data } = await supabase
      .from("users")
      .select("display_name, is_guest, daily_request_cap")
      .eq("id", userId)
      .single();
    expect(data).toEqual({
      display_name: "Integration test",
      is_guest: true,
      daily_request_cap: GUEST_CAP,
    });
  });
});
