import { Button, Input } from "@/components/ui";
import {
  signInAsGuest,
  signInWithEmail,
  signInWithPassword,
} from "@/app/auth/actions";

export const metadata = {
  title: "Sign in — MockPrep",
};

export default async function SignInPage({
  searchParams,
}: PageProps<"/sign-in">) {
  const params = await searchParams;
  const read = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : null;
  };

  const sent = read("sent");
  const error = read("error");
  const next = read("next") ?? "/dashboard";

  return (
    <main className="grid flex-1 grid-cols-1 lg:grid-cols-2">
      {/* ------------------------------------------------------------ Form */}
      <div className="flex flex-col justify-between gap-16 px-8 py-12">
        <span className="display text-u-body">
          MockPrep<sup>®</sup>
        </span>

        <div className="max-w-md">
          <p className="eyebrow">Sign in</p>
          <h1 className="display text-u-display mt-2">Back to it</h1>

          {sent ? (
            <div className="mt-10 flex flex-col gap-4">
              <p className="text-u-lg">Check your inbox.</p>
              <p className="text-u-body">
                We sent a one-time link to {sent}. It expires in an hour.
              </p>
              <p className="mt-2">
                <a href="/sign-in" className="eyebrow">
                  Use a different address
                </a>
              </p>
            </div>
          ) : (
            <>
              {/* One form, two actions. The email field is shared rather than
                  duplicated, so whichever button you press sends the address
                  you actually typed. */}
              <form className="mt-10 flex flex-col gap-6">
                <input type="hidden" name="next" value={next} />
                <Input
                  label="School email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@unimelb.edu.au"
                  error={error ?? undefined}
                />
                <div>
                  <Button type="submit" formAction={signInWithEmail}>
                    Send me a link
                  </Button>
                </div>

                <p className="text-u-eyebrow">
                  No password. We email you a one-time link.
                </p>

                <div className="mt-6 flex flex-col gap-6 border-t border-t-rule pt-6">
                  <p className="eyebrow">Or use a password</p>
                  <Input
                    label="Password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                  />
                  <div>
                    <Button
                      type="submit"
                      variant="outline"
                      size="compact"
                      formAction={signInWithPassword}
                    >
                      Sign in
                    </Button>
                  </div>
                </div>
              </form>

              <form action={signInAsGuest} className="mt-10">
                <input type="hidden" name="next" value={next} />
                <Button type="submit" variant="outline" size="compact">
                  Try a round as a guest
                </Button>
              </form>
              <p className="text-u-eyebrow mt-4">
                Guest rounds are saved to this browser. Add an email later to
                keep them.
              </p>
            </>
          )}
        </div>

        <p className="eyebrow">© 2026 MockPrep®</p>
      </div>

      {/* ----------------------------------------------------------- Panel */}
      <div className="hidden bg-accent text-accent-text rounded-surface m-8 flex-col justify-end p-12 lg:flex">
        <p className="display text-u-display">One round free</p>
        <p className="text-u-lg mt-6 max-w-sm">
          Then a score, a transcript, and the three things to fix before
          Thursday.
        </p>
      </div>
    </main>
  );
}
