import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Completes a magic-link sign-in.
 *
 * Supabase sends one of two shapes depending on how the project's email
 * template is configured, so both are handled:
 *   ?code=…                     PKCE, the default for @supabase/ssr
 *   ?token_hash=…&type=magiclink   templates using {{ .TokenHash }}
 * Handling both means the link works without anyone having to remember to
 * edit the email template first.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const nextParam = searchParams.get("next") ?? "/dashboard";
  const next =
    nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : "/dashboard";

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return NextResponse.redirect(
      `${origin}/sign-in?error=${encodeURIComponent(error.message)}`,
    );
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return NextResponse.redirect(
      `${origin}/sign-in?error=${encodeURIComponent(error.message)}`,
    );
  }

  return NextResponse.redirect(
    `${origin}/sign-in?error=${encodeURIComponent("That link is missing its sign-in token. Request a new one.")}`,
  );
}
