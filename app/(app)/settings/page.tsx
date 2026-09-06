import { redirect } from "next/navigation";
import { Button, PillTag, RuledRow, RuledRowList } from "@/components/ui";
import { signOut } from "@/app/auth/actions";
import { getAccount } from "@/lib/data/account";

export const metadata = { title: "Settings — MockPrep" };

/**
 * Ceil, not floor, and used everywhere on this screen.
 *
 * Flooring both ends makes them disagree: 39 seconds of a 1800 second cap
 * floors to "0 used" and "29 left" out of 30, which does not add up on
 * screen. Ceiling counts any started minute, so used + left always equals
 * the cap and the figure never understates spend.
 */
function minutes(seconds: number) {
  return Math.ceil(seconds / 60);
}

export default async function SettingsPage() {
  const account = await getAccount();
  if (!account) redirect("/sign-in?next=/settings");

  const { requests, voice } = account;
  // A zero cap (guests, for voice) would divide by zero; it also reads more
  // honestly as an empty meter than as a full one.
  const requestPct = requests.cap > 0 ? (requests.used / requests.cap) * 100 : 0;
  const voicePct =
    voice.capSeconds > 0 ? (voice.usedSeconds / voice.capSeconds) * 100 : 0;

  return (
    <>
      <header className="flex h-[72px] shrink-0 items-center border-b border-b-rule px-8">
        <h1 className="text-u-lg font-medium">Settings</h1>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-12 px-8 py-12 xl:grid-cols-[400px_minmax(0,1fr)]">
        {/* ------------------------------------------------------- Account */}
        <section aria-labelledby="account-heading" className="flex flex-col">
          <h2 id="account-heading" className="eyebrow">
            Account
          </h2>

          <p className="mt-4 text-u-lg break-words">
            {account.email ?? "Signed in as a guest"}
          </p>

          <p className="mt-4">
            <PillTag>{account.isGuest ? "Guest" : "Email account"}</PillTag>
          </p>

          {account.isGuest ? (
            <p className="text-u-body mt-6 max-w-sm">
              Guest rounds are saved to this browser. Add an email to keep them
              and to unlock voice rounds.
            </p>
          ) : null}

          <form action={signOut} className="mt-10">
            <Button type="submit" variant="outline" size="compact">
              Sign out
            </Button>
          </form>
        </section>

        {/* -------------------------------------------------------- Limits
            Read-only. Caps are enforced in the database by
            consume_llm_quota / consume_voice_seconds, so nothing here is a
            control — it is a window onto what those functions will allow. */}
        <section aria-labelledby="limits-heading" className="min-w-0">
          <div className="mb-4 flex items-baseline justify-between gap-6">
            <h2 id="limits-heading" className="eyebrow">
              Daily limits
            </h2>
            <p className="eyebrow">Resets at midnight UTC</p>
          </div>

          <ul>
            <RuledRow
              className="py-4"
              progress={requestPct}
              title={<span className="eyebrow">Rounds</span>}
              trailing={
                <span className="numeric text-u-body font-medium">
                  {requests.used} / {requests.cap}
                </span>
              }
            />
            <RuledRow
              className="py-4"
              progress={voicePct}
              title={<span className="eyebrow">Voice minutes</span>}
              trailing={
                <span className="numeric text-u-body font-medium">
                  {minutes(voice.usedSeconds)} /{" "}
                  {Math.floor(voice.capSeconds / 60)}
                </span>
              }
            />
          </ul>

          <RuledRowList className="mt-12">
            <RuledRow
              className="py-8"
              scale="ui"
              title={
                <>
                  <span className="numeric">{requests.left}</span>{" "}
                  {requests.left === 1 ? "round" : "rounds"} left today
                </>
              }
              meta="One round spends two: generating the questions, then scoring"
            />
            <RuledRow
              className="py-8"
              scale="ui"
              title={
                voice.capSeconds === 0 ? (
                  "Voice is not available on a guest account"
                ) : (
                  <>
                    <span className="numeric">
                      {Math.max(
                        0,
                        Math.floor(voice.capSeconds / 60) -
                          minutes(voice.usedSeconds),
                      )}
                    </span>{" "}
                    voice minutes left today
                  </>
                )
              }
              meta="A single round is capped at ten minutes of speech"
            />
          </RuledRowList>
        </section>
      </main>
    </>
  );
}
