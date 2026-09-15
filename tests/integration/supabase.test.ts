import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * The user is deleted at the end through delete_own_guest() (migration
 * 20260916000000), which cascades through every table the guest touched.
 * If that function is missing the suite fails and says which migration to
 * apply, rather than quietly leaving a row behind on every run.
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

afterAll(async () => {
  if (!userId) return;
  const { data, error } = await supabase.rpc("delete_own_guest");
  if (error?.code === "PGRST202") {
    throw new Error(
      "delete_own_guest() is missing — apply supabase/migrations/20260916000000_delete_own_guest.sql. " +
        `The anonymous user ${userId} from this run was left behind.`,
    );
  }
  if (error) throw error;
  if (data !== true) throw new Error(`delete_own_guest() returned ${String(data)} for ${userId}`);

  // Gone means gone: the session's token no longer identifies anyone.
  const { data: rows } = await supabase.from("users").select("id").eq("id", userId);
  expect(rows ?? []).toEqual([]);
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

describe("refund_llm_quota", () => {
  it("gives back a charged request, floored at zero, and needs its migration", async () => {
    // This block runs after the quota suite above has spent the guest's 10.
    const { data, error } = await supabase.rpc("refund_llm_quota", { p_cost: 1 });
    if (error?.code === "PGRST202") {
      throw new Error(
        "refund_llm_quota() is missing — apply supabase/migrations/20260916010000_refund_llm_quota.sql.",
      );
    }
    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row).toEqual({ used: GUEST_CAP - 1, cap: GUEST_CAP });

    // The refunded unit can be spent again…
    expect((await consume(1)).allowed).toBe(true);
    // …and a refund never goes below zero.
    const { data: floor } = await supabase.rpc("refund_llm_quota", { p_cost: 999 });
    expect((Array.isArray(floor) ? floor[0] : floor)?.used).toBe(0);
  });
});
