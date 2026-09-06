import type { ReactNode } from "react";
import { AppNav } from "./nav";
import { signOut } from "@/app/auth/actions";
import { getNavCounts } from "@/lib/data/dashboard";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in shell: sidebar plus the column the pages fill.
 *
 * Each page renders its own 72px header, because the title and the primary
 * action are page-specific. The shell owns only the nav.
 *
 * The session and report screens sit outside this group on purpose — the
 * round flow has no navigation out of it.
 */
export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const counts = await getNavCounts();

  // Anonymous users have no email, so the account line names them as guests.
  const account = user?.email ?? (user ? "Signed in as guest" : null);

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      {/* Below lg the frame's column becomes a full-width strip so the nav
          is never hidden — same rules, rotated: bottom rule instead of right. */}
      <aside className="flex w-full shrink-0 flex-col border-b border-b-rule lg:w-[270px] lg:border-b-0 lg:border-r lg:border-r-rule">
        <div className="flex h-[72px] items-center px-8">
          <span className="display text-u-body">
            {/* <sup> gets its size and offset from preflight — no arbitrary
                value, so the type scale stays closed. */}
            MockPrep<sup>®</sup>
          </span>
        </div>

        <nav aria-label="Main" className="px-8 pb-6 lg:pt-8 lg:pb-0">
          <AppNav counts={counts} />
        </nav>

        {account ? (
          <div className="mt-auto hidden flex-col gap-3 px-8 pb-8 lg:flex">
            <p className="text-u-micro truncate">{account}</p>
            <form action={signOut}>
              <button type="submit" className="eyebrow">
                Sign out
              </button>
            </form>
          </div>
        ) : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
