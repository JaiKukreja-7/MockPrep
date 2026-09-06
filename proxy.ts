import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next 16 renamed Middleware to Proxy; the file must sit at the project root
// alongside app/, and only one is allowed per project.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
