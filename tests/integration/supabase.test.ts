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

describe("consume_llm_quota refuses a non-positive cost", () => {
  it("cannot be used to walk the counter back down", async () => {
    // The bug this guards: at the cap, `p_cost => -10` passed the check
    // (`used + cost > cap` is false for a negative cost) and the update then
    // subtracted, resetting the day. Ten spends, one negative call, repeat.
    //
    // A cost of ZERO is not the bug and stays a read — see the first case in
    // this file, which uses it to check a new guest starts at 0 of the cap.
    const { data } = await supabase.rpc("consume_llm_quota", { p_cost: -5 });
    const row = Array.isArray(data) ? data[0] : data;
    expect(
      row?.allowed,
      "a negative cost was accepted — apply supabase/migrations/20260924000000_quota_negative_cost.sql " +
        "and 20260924010000_quota_zero_cost_read.sql",
    ).toBe(false);

    // And the counter did not move. This block runs after the suite above
    // has spent the guest's ten, so it is still at the cap.
    const after = await consume(1);
    expect(after.allowed).toBe(false);
    expect(after.used).toBe(GUEST_CAP);
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

describe("a resume-tailored round requires an account (sessions_resume_requires_account)", () => {
  it("a guest's session may carry job details but not tailored_from_resume", async () => {
    // The job is the user's target, not their history: a guest may store it.
    const withJob = await supabase
      .from("sessions")
      .insert({ user_id: userId, title: "x", job_title: "Backend engineer", company: "Acme", job_description: "Go, Postgres." })
      .select("id, tailored_from_resume")
      .single();
    if (withJob.error?.code === "PGRST204") {
      throw new Error(
        "sessions.job_title is missing — apply supabase/migrations/20260922000000_tailored_rounds.sql.",
      );
    }
    expect(withJob.error).toBeNull();
    expect(withJob.data?.tailored_from_resume).toBe(false);

    // The resume flag is what the restrictive policy gates, on insert…
    const { error: insertError } = await supabase
      .from("sessions")
      .insert({ user_id: userId, title: "x", tailored_from_resume: true });
    expect(insertError?.code).toBe("42501");

    // …and on update of an existing row, so a guest cannot flip it after.
    const { data: flipped, error: updateError } = await supabase
      .from("sessions")
      .update({ tailored_from_resume: true })
      .eq("id", withJob.data!.id)
      .select("tailored_from_resume");
    expect(updateError?.code).toBe("42501");
    expect(flipped ?? []).toEqual([]);
  });
});

describe("rounds.model_answer", () => {
  it("stores a model answer alongside the score, and needs its migration", async () => {
    const { data: session } = await supabase
      .from("sessions")
      .insert({ user_id: userId, title: "x" })
      .select("id")
      .single();
    const { error } = await supabase.from("rounds").insert({
      session_id: session!.id,
      ordinal: 1,
      question: "Two-sum?",
      score: 62,
      score_detail: { approach: 80, complexity: 50, edge_cases: 56 },
      model_answer: "I'd use two pointers from both ends: O(n) time, O(1) space.",
    });
    if (error?.code === "PGRST204") {
      throw new Error(
        "rounds.model_answer is missing — apply supabase/migrations/20260923000000_model_answers.sql.",
      );
    }
    expect(error).toBeNull();

    const { data: row } = await supabase
      .from("rounds")
      .select("score, model_answer")
      .eq("session_id", session!.id)
      .single();
    expect(row).toEqual({
      score: 62,
      model_answer: "I'd use two pointers from both ends: O(n) time, O(1) space.",
    });
  });
});
