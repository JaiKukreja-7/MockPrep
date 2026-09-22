import Image from "next/image";
import Link from "next/link";
import { Reveal } from "./reveal";
import { redirect } from "next/navigation";
import { Button, PillTag, RuledRow, RuledRowList } from "@/components/ui";
import { signInAsGuest } from "@/app/auth/actions";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

// The redirect below reads the session cookie, but only when Supabase env is
// present. An image is built with no env at all, and on that path the page
// touches no request data — so Next would prerender it as static HTML and
// serve signed-in users the landing page forever. Force it dynamic.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "MockPrep — mock interviews that talk back",
  description:
    "Mock interviews out loud: questions written for the role you name, answers scored on structure, specificity and pace.",
};

/**
 * The landing page, from the frames: top bar, hero, strip, three feature
 * sections, the ruled index, the black statement, the two-panel footer.
 *
 * Everything is the display scale (--d-*) on the landing gutter (5vw); the
 * app's UI scale and 32px gutter stop at the sign-in door. The one shared
 * element is the wordmark, kept at the size every other screen uses so it
 * reads as the same mark and not a bigger one.
 */

const tracks = ["Consulting", "Engineering", "Product", "General"];

const features = [
  {
    eyebrow: "Voice rounds",
    title: "It asks. You answer.",
    body: "Three questions written for the role you name, asked out loud. It listens, acknowledges what you said, and moves on — no typing, no pausing to find the perfect phrasing. Interrupt it and it stops.",
    image: "/landing/session.png",
    alt: "A live voice round: the question set large, the speaker dot, and the record control beneath.",
  },
  {
    eyebrow: "Scored, not graded",
    title: "Numbers, not stars.",
    body: "Structure, specificity and pace, each out of a hundred, and an overall that follows from them rather than a feeling. The moments that cost you are marked in the transcript with a timestamp.",
    image: "/landing/report.png",
    alt: "A scored report: the round score, three sub-score meters, and a flagged transcript.",
  },
  {
    eyebrow: "The record",
    title: "It all adds up.",
    body: "Every round lands on one page: the last score, a year of practice as a grid, what to work on next, and the next round ready to start. Scores compare you with yourself, not with anyone else.",
    image: "/landing/dashboard.png",
    alt: "The dashboard: last score with meters, a twelve-month practice grid, and recent sessions.",
  },
];

const roundTypes = [
  { title: "Consulting", tag: "Text and voice" },
  { title: "Engineering", tag: "Text and voice" },
  { title: "Product", tag: "Text and voice" },
  { title: "General", tag: "Text and voice" },
  { title: "Resume check", tag: "Account" },
];

const facts = [
  {
    title: "Three questions a round",
    meta: "Written for the role you name, not pulled from a list",
  },
  {
    title: "Ten minutes of speech",
    meta: "The voice cap per round — enough to answer, not enough to ramble",
  },
  {
    title: "Every flag has a timestamp",
    meta: "Filler, hedging, missing structure: marked where it happened",
  },
  {
    title: "An hour of quiet ends it",
    meta: "A round left open is abandoned, not resumed at a wall-clock time",
  },
];

const whereNext = [
  { label: "Start a round", href: "/sign-in" },
  { label: "Sign in", href: "/sign-in" },
  { label: "Question bank", href: "/questions" },
  { label: "Resume check", href: "/resume" },
];

export default async function Home() {
  // Anyone with a session — email or guest — has a dashboard to go to. The
  // landing page is for people who do not.
  if (hasSupabaseEnv()) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect("/dashboard");
  }

  return (
    <>
      {/* ------------------------------------------------------- Top bar
          Wordmark and the one action. No nav, no counts — the counts belong
          to the signed-in shell. */}
      <header className="mx-auto flex h-[72px] w-full max-w-page items-center justify-between gap-6 px-(--gutter)">
        <span className="display text-u-body">
          MockPrep<sup>®</sup>
        </span>
        <div className="flex items-center gap-8">
          <Link href="/sign-in" className="link eyebrow hidden py-3 sm:block">
            Sign in
          </Link>
          <Link href="/sign-in">
            <Button>Start a round</Button>
          </Link>
        </div>
      </header>

      <main>
        {/* ---------------------------------------------------------- Hero */}
        <section className="mx-auto w-full max-w-page px-(--gutter) pt-16 pb-20 md:pt-24">
          <p className="max-w-2xl text-d-body-lg">
            MockPrep<sup>®</sup> runs mock interviews out loud. It writes the
            questions for the role you name, listens to your answers, and scores
            them on structure, specificity and pace.
          </p>
          {/* One sentence per line at every width, so a phone never breaks
              "Say it out / loud." across the fold of a line. */}
          <h1 className="display mt-12 text-d-hero">
            <span className="block">
              Say it <span className="whitespace-nowrap">out loud.</span>
            </span>
            <span className="block">Get marked.</span>
            <span className="block text-accent">Go again.</span>
          </h1>
        </section>

        {/* --------------------------------------------------------- Strip
            The frame's logo row. There are no client logos to show, so the
            strip carries the four tracks in the display face — each one a
            wordmark of sorts. Static: no marquee. */}
        <section
          aria-label="Tracks"
          className="mx-auto flex w-full max-w-page flex-col gap-x-12 gap-y-4 border-y border-y-rule px-(--gutter) py-8 sm:flex-row sm:flex-wrap sm:items-center"
        >
          <p className="eyebrow">Four tracks</p>
          <ul className="flex flex-col gap-x-8 gap-y-2 sm:flex-row sm:flex-wrap sm:items-center">
            {tracks.map((track) => (
              <li key={track} className="display text-d-mid">
                {track}
              </li>
            ))}
          </ul>
        </section>

        {/* ------------------------------------------------------ Features
            Eyebrow, display headline, one paragraph, one screenshot. Centred,
            as in the frame; the screenshot sits in a 1px rule at 4px, the
            surface radius — it is a surface, not a control. */}
        {features.map((feature) => (
          <section
            key={feature.title}
            data-reveal=""
            className="mx-auto w-full max-w-page px-(--gutter) py-24 text-center md:py-36"
          >
            <p className="eyebrow" data-reveal-item="">{feature.eyebrow}</p>
            <h2 className="display mt-4 text-d-hero" data-reveal-item="">{feature.title}</h2>
            <p className="mx-auto mt-10 max-w-3xl text-d-body-lg" data-reveal-item="">
              {feature.body}
            </p>
            <figure className="mt-16 overflow-hidden rounded-surface border border-rule" data-reveal-item="">
              <Image
                src={feature.image}
                alt={feature.alt}
                width={2880}
                height={1800}
                sizes="(min-width: 1440px) 1296px, 90vw"
                className="h-auto w-full"
              />
            </figure>
          </section>
        ))}

        {/* ---------------------------------------------------------- Index
            The ruled index from the frame: --d-mid titles, a pill each, an
            outline pill beneath. Stacked on a phone for every row, not just
            the ones whose title happens to be long — one behaviour per list. */}
        <section data-reveal="" className="mx-auto w-full max-w-page px-(--gutter) py-24 md:py-36">
          <p className="eyebrow">Round types</p>
          <RuledRowList className="mt-12">
            {roundTypes.map((round) => (
              <RuledRow
                key={round.title}
                data-reveal-item=""
                title={round.title}
                stackTrailing
                trailing={<PillTag>{round.tag}</PillTag>}
              />
            ))}
          </RuledRowList>
          <form action={signInAsGuest} className="mt-16 flex justify-center">
            <input type="hidden" name="next" value="/dashboard" />
            <Button type="submit" variant="outline">
              Try a text round as a guest
            </Button>
          </form>
        </section>

        {/* ------------------------------------------------------ Statement
            The black section. Headline and paragraph on the left, the facts
            as ruled rows on the right — the rows invert themselves. */}
        <section data-reveal="" className="surface-dark">
          <div className="mx-auto grid w-full max-w-page gap-16 px-(--gutter) py-24 md:py-36 lg:grid-cols-2">
            <div>
              <h2 className="display text-d-hero">No small talk.</h2>
              <p className="mt-10 max-w-md text-d-body-lg">
                It does not warm you up, does not hint, and does not round up.
                It asks the question, waits, and tells you what the answer was
                missing. The real interview will be kinder than this. That is
                the point.
              </p>
            </div>
            <RuledRowList className="self-end">
              {facts.map((fact) => (
                <RuledRow key={fact.title} title={fact.title} meta={fact.meta} />
              ))}
            </RuledRowList>
          </div>
        </section>
      </main>

      {/* ---------------------------------------------------------- Footer
          Two panels. Black: the mark, how it runs, the small print. Accent:
          the set-piece and where to next. */}
      <footer>
        {/* Black on black after the statement: the 1px rule is the seam. */}
        <div className="surface-dark border-t border-t-rule">
          <div className="mx-auto flex w-full max-w-page flex-col gap-16 px-(--gutter) py-20 md:py-24">
            <div className="flex flex-wrap items-center justify-between gap-6">
              <span className="display text-u-body">
                MockPrep<sup>®</sup>
              </span>
              <nav aria-label="Footer" className="flex gap-8">
                <Link href="/sign-in" className="link inline-block py-2 text-d-body">
                  Sign in
                </Link>
                <Link href="/sign-in" className="link inline-block py-2 text-d-body">
                  Start a round
                </Link>
              </nav>
            </div>

            <div>
              <h2 className="text-d-body-lg font-medium">How it runs</h2>
              <ul className="mt-4 flex flex-col gap-1 text-d-body">
                <li>Questions and scoring on free-tier models. No card, no plan.</li>
                <li>
                  A resume is read by one provider that does not train on it,
                  then dropped. Only the analysis is kept.
                </li>
                <li>Guests get text rounds. Voice and resume checks need an account.</li>
              </ul>
            </div>

            <div className="flex flex-wrap items-end justify-between gap-6">
              <p className="max-w-md text-u-eyebrow">
                MockPrep is practice, not a prediction. A score compares you with
                your own earlier rounds and with nothing else.
              </p>
              <p className="eyebrow">© 2026 MockPrep®</p>
            </div>
          </div>
        </div>

        <div data-reveal="" className="bg-accent text-accent-text">
          <div className="mx-auto w-full max-w-page px-(--gutter) py-20 md:py-24">
            <p className="display text-d-setpiece">Out</p>
            <div className="mt-10 flex flex-col gap-12 lg:grid lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <p className="display text-d-setpiece text-right lg:order-2">
                Loud
              </p>
              <nav aria-label="Where to next" className="lg:order-1">
                <p className="eyebrow">Where to next?</p>
                <ul className="mt-4 grid grid-cols-1 gap-x-12 gap-y-4 text-d-body-lg font-medium sm:grid-cols-2">
                  {whereNext.map((item) => (
                    <li key={item.label}>
                      <Link href={item.href} className="link inline-block py-1">
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </div>
        </div>
      </footer>
      <Reveal />
    </>
  );
}
