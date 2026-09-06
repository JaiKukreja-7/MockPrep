import { createClient } from "@/lib/supabase/server";

export interface AccountView {
  email: string | null;
  displayName: string | null;
  isGuest: boolean;
  /** Rounds: LLM requests. Voice: seconds. Both reset at UTC midnight. */
  requests: { used: number; cap: number; left: number };
  voice: { usedSeconds: number; capSeconds: number; leftSeconds: number };
}

export async function getAccount(): Promise<AccountView | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // consume_llm_quota keys on the database's current_date, which is UTC on
  // Supabase — so the lookup has to use the UTC date, not the server's local
  // one, or the row read here is not the row the cap is spent against.
  const today = new Date().toISOString().slice(0, 10);

  const [profileResult, usageResult] = await Promise.all([
    supabase
      .from("users")
      .select("email, display_name, is_guest, daily_request_cap, daily_voice_sec_cap")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("llm_usage")
      .select("requests, voice_seconds")
      .eq("day", today)
      .maybeSingle(),
  ]);

  if (profileResult.error) throw profileResult.error;
  if (usageResult.error) throw usageResult.error;

  const profile = profileResult.data;
  if (!profile) return null;

  const usedRequests = usageResult.data?.requests ?? 0;
  const usedVoice = usageResult.data?.voice_seconds ?? 0;

  return {
    email: profile.email,
    displayName: profile.display_name,
    isGuest: profile.is_guest,
    requests: {
      used: usedRequests,
      cap: profile.daily_request_cap,
      left: Math.max(0, profile.daily_request_cap - usedRequests),
    },
    voice: {
      usedSeconds: usedVoice,
      capSeconds: profile.daily_voice_sec_cap,
      leftSeconds: Math.max(0, profile.daily_voice_sec_cap - usedVoice),
    },
  };
}
