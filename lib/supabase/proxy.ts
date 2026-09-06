import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasSupabaseEnv, supabaseAnonKey, supabaseUrl } from "./env";
import type { Database } from "./types";

/** Routes reachable without a session. Everything else redirects to /sign-in. */
const PUBLIC_PATHS = ["/", "/sign-in", "/auth", "/test"];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Refreshes the auth cookies on every request and gates private routes.
 *
 * The response object must be the one the cookies were written onto — building
 * a fresh NextResponse here would silently drop the refreshed session, which
 * logs users out at random intervals.
 */
let warned = false;

export async function updateSession(request: NextRequest) {
  if (!hasSupabaseEnv()) {
    // In production a missing key means auth is quietly switched off and every
    // gated route becomes public, so refuse to serve at all.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Supabase environment variables are missing in production. Auth and " +
          "route gating cannot run. Set NEXT_PUBLIC_SUPABASE_URL and " +
          "NEXT_PUBLIC_SUPABASE_ANON_KEY.",
      );
    }
    // In development, pass through un-gated so the design routes (/test,
    // /session, /report) still run before anyone has wired up a project.
    // Pages that actually query Supabase still throw their own clear error.
    if (!warned) {
      warned = true;
      console.warn(
        "\n[mockprep] No Supabase env found — auth and route gating are OFF.\n" +
          "           Copy .env.local.example to .env.local to turn them on.\n",
      );
    }
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    supabaseUrl(),
    supabaseAnonKey(),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser(), not getSession(): it revalidates the JWT with Supabase rather
  // than trusting a cookie the client could have written.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic(request.nextUrl.pathname)) {
    // API callers get a status they can branch on. Redirecting them to the
    // sign-in HTML would surface as a JSON parse error at the fetch site.
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return response;
}
