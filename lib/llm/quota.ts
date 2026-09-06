import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface QuotaResult {
  allowed: boolean;
  used: number;
  cap: number;
}

/** PostgREST's code for "that function isn't in the schema cache". */
const FUNCTION_MISSING = "PGRST202";

let warnedMissing = false;

/**
 * Spends `cost` requests against the signed-in user's daily cap.
 *
 * The check and the increment happen inside one locked statement in Postgres
 * (see the migration) — doing it in two round-trips here would let two
 * concurrent rounds both pass the check.
 */
export async function consumeQuota(cost = 1): Promise<QuotaResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("consume_llm_quota", {
    p_cost: cost,
  });

  if (error) {
    if (error.code === FUNCTION_MISSING) {
      // Caps are a spend control, so a missing function must never quietly
      // mean "unlimited" in production.
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "consume_llm_quota is missing. Apply " +
            "supabase/migrations/20260905010000_llm_quota.sql before serving " +
            "traffic — without it there is no daily cap.",
        );
      }
      if (!warnedMissing) {
        warnedMissing = true;
        console.warn(
          "\n[mockprep] consume_llm_quota not found — daily caps are OFF.\n" +
            "           Apply supabase/migrations/20260905010000_llm_quota.sql.\n",
        );
      }
      return { allowed: true, used: 0, cap: 0 };
    }
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { allowed: false, used: 0, cap: 0 };

  return { allowed: row.allowed, used: row.used, cap: row.cap };
}

export class QuotaExceededError extends Error {
  constructor(readonly used: number, readonly cap: number) {
    super(
      `Daily limit reached — ${used} of ${cap} rounds used. ` +
        `It resets at midnight.`,
    );
    this.name = "QuotaExceededError";
  }
}
