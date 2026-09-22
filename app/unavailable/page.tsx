import { Button } from "@/components/ui";

export const metadata = { title: "Temporarily unavailable — MockPrep" };
export const dynamic = "force-dynamic";

/**
 * Where the proxy sends a private page load while Supabase is unreachable.
 * Deliberately touches no data: this page exists because the data cannot be
 * reached. The empty-state idiom from the dashboard — eyebrow, one display
 * line, one paragraph, one action — and the action goes back to wherever
 * the person was, not to a bare reload.
 */
export default async function UnavailablePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = typeof params.from === "string" ? params.from : "/dashboard";
  // Same-origin paths only; "//evil.com" is protocol-relative.
  const from = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-[72px] shrink-0 items-center border-b border-b-rule px-8">
        <span className="display text-u-body">
          MockPrep<sup>®</sup>
        </span>
      </header>
      <main className="flex flex-1 flex-col gap-6 px-8 py-12">
        <p className="eyebrow">Temporarily unavailable</p>
        <h1 className="display text-u-display max-w-4xl">
          MockPrep can&apos;t reach its database.
        </h1>
        <p className="text-u-body max-w-2xl">
          Your account and your rounds are safe on the server; the app just
          cannot get to them right now. This usually clears in a minute.
        </p>
        <div className="flex flex-wrap gap-4">
          <Button href={from}>Try again</Button>
          <Button href="/" variant="outline" size="compact">Back to the front page</Button>
        </div>
      </main>
    </div>
  );
}
