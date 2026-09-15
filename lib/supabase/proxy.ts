import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasSupabaseEnv, supabaseAnonKey, supabaseUrl } from "./env";
import { isSupabaseOutage, OUTAGE_MESSAGE } from "./outage";
import type { Database } from "./types";

/** Routes reachable without a session. Everything else redirects to /sign-in. */
const PUBLIC_PATHS = ["/", "/sign-in", "/auth", "/test", "/unavailable"];

/** Set on every response served during an outage, so it can be seen from outside. */
export const OUTAGE_HEADER = "x-mockprep-outage";

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
    error,
  } = await supabase.auth.getUser();

  // "Could not ask" is not "no". When Supabase itself is unreachable, a
  // signed-in person must not be bounced to sign-in as if their session had
  // ended; they get told what is actually wrong, and so does the log.
  if (isSupabaseOutage(error)) {
    console.error(
      `[mockprep] Supabase unreachable while checking the session for ${request.method} ` +
        `${request.nextUrl.pathname}: ${error?.message ?? "unknown error"}`,
    );
    const pathname = request.nextUrl.pathname;
    if (isPublic(pathname)) {
      response.headers.set(OUTAGE_HEADER, "1");
      return response;
    }
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: OUTAGE_MESSAGE },
        { status: 503, headers: { [OUTAGE_HEADER]: "1" } },
      );
    }
    // A server action in flight: let it through. The action asks the same
    // question, gets the same answer, and returns the sentence into the form
    // it came from — where the person's typed answer still is.
    if (request.method === "POST" && request.headers.get("next-action")) {
      response.headers.set(OUTAGE_HEADER, "1");
      return response;
    }
    const url = request.nextUrl.clone();
    url.pathname = "/unavailable";
    url.search = `?from=${encodeURIComponent(pathname)}`;
    return NextResponse.rewrite(url, { headers: { [OUTAGE_HEADER]: "1" } });
  }

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
