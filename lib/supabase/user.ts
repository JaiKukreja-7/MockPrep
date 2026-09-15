import type { SupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { isSupabaseOutage } from "./outage";

/**
 * Who is signed in, and whether that could be determined at all.
 *
 * `user` null with `outage` false is a real "not signed in". `outage` true
 * means the question could not be asked — callers say so instead of telling
 * a signed-in person to sign in.
 */
export async function currentUser(
  supabase: Pick<SupabaseClient, "auth">,
): Promise<{ user: User | null; outage: boolean }> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  return { user, outage: isSupabaseOutage(error) };
}
