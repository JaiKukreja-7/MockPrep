import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionView, ReportView } from "@/lib/data/session";

/**
 * The screens a failure lands on, rendered to markup. Not a browser: these
 * prove what is on the page — the affordance, the way back — not how it
 * looks, which the design audit covers.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => currentPath,
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/app/rounds/actions", () => ({
  submitAnswer: async () => ({}),
  scoreRound: async () => ({}),
}));
vi.mock("@/lib/data/session", () => ({ getReport: () => report }));

let currentPath = "/dashboard";
let report: ReportView | null = null;

const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

describe("app/error.tsx", () => {
  it("offers a way back into a round, and the dashboard, never a bare reload", async () => {
    currentPath = "/session/abc";
    const { default: ErrorPage } = await import("@/app/error");
    const html = renderToStaticMarkup(
      <ErrorPage error={Object.assign(new Error("boom"), { digest: "d1g3st" })} reset={() => {}} />,
    );
    const text = strip(html);
    expect(text).toMatch(/Something went wrong/);
    expect(text).toMatch(/That did not go through\./);
    expect(text).toMatch(/everything you had already submitted is saved/);
    expect(text).toMatch(/Back into the round/);
    expect(hrefs(html)).toContain("/dashboard");
    expect(text).toMatch(/Reference d1g3st/);
    expect(text).not.toMatch(/\bboom\b|\bstack\b/); // the error itself stays in the log
  });

  it("outside a round, the primary action is to try the page again", async () => {
    currentPath = "/reports";
    const { default: ErrorPage } = await import("@/app/error");
    const text = strip(renderToStaticMarkup(<ErrorPage error={new Error("x")} reset={() => {}} />));
    expect(text).toMatch(/Try again/);
    expect(text).toMatch(/Back to the dashboard/);
  });
});

describe("the session screen with every round answered and no score", () => {
  const view: SessionView = {
    session: { id: "s1", title: "Strategy analyst", track: "consulting", status: "live", started_at: null },
    rounds: [
      { id: "r1", ordinal: 1, question: "Q1", answered: true, mode: "text" },
      { id: "r2", ordinal: 2, question: "Q2", answered: true, mode: "text" },
      { id: "r3", ordinal: 3, question: "Q3", answered: true, mode: "text" },
    ],
    transcript: [{ id: "l1", at_seconds: 0, speaker: "interviewer", body: "Q1", flag: null }],
    current: null,
    elapsedSeconds: 90,
    isGuest: true,
  };

  it("shows the scoring affordance instead of a statement of fact", async () => {
    const { LiveRound } = await import("@/app/session/[id]/live-round");
    const html = renderToStaticMarkup(<LiveRound view={view} />);
    const text = strip(html);
    expect(text).toMatch(/Round complete/);
    expect(text).toMatch(/Every question is answered\./);
    expect(text).not.toMatch(/That is the last question/);
    expect(text).toMatch(/Score this round/);
    expect(text).toMatch(/Everything you said is saved/);
    expect(html).toMatch(/name="sessionId" value="s1"/);
    expect(hrefs(html)).toContain("/sessions");
    expect(html).not.toMatch(/<textarea/);
  });

  it("with a question still open it is the answer form, and the answer box is controlled", async () => {
    const { LiveRound } = await import("@/app/session/[id]/live-round");
    const open = { ...view, current: view.rounds[2], rounds: view.rounds.map((r, i) => ({ ...r, answered: i < 2 })) };
    const html = renderToStaticMarkup(<LiveRound view={open} />);
    expect(html).toMatch(/<textarea[^>]*name="answer"/);
    expect(strip(html)).toMatch(/Submit and finish/);
    expect(strip(html)).not.toMatch(/Score this round/);
  });
});

describe("the report for an unscored round", () => {
  const base = {
    session: { id: "s1", title: "Strategy analyst", track: "consulting" as const, status: "live" as const, started_at: null, duration_seconds: null },
    score: null,
    transcript: [],
  };

  it("live and unscored: the scoring affordance", async () => {
    report = base;
    const { default: ReportPage } = await import("@/app/report/[id]/page");
    const html = renderToStaticMarkup(await ReportPage({ params: Promise.resolve({ id: "s1" }), searchParams: Promise.resolve({}) }));
    const text = strip(html);
    expect(text).toMatch(/This round has not been scored yet\./);
    expect(text).toMatch(/Score this round/);
    expect(html).toMatch(/name="sessionId" value="s1"/);
  });

  it("abandoned: says why, and offers a new round rather than a scoring button", async () => {
    report = { ...base, session: { ...base.session, status: "abandoned" } };
    const { default: ReportPage } = await import("@/app/report/[id]/page");
    const html = renderToStaticMarkup(await ReportPage({ params: Promise.resolve({ id: "s1" }), searchParams: Promise.resolve({}) }));
    const text = strip(html);
    expect(text).toMatch(/timed out before it was scored/);
    expect(text).not.toMatch(/Score this round/);
    expect(hrefs(html)).toContain("/dashboard");
  });
});

describe("/unavailable", () => {
  it("names the problem, goes back to where the person was, and rejects an off-site 'from'", async () => {
    const { default: Unavailable } = await import("@/app/unavailable/page");
    const html = renderToStaticMarkup(await Unavailable({ searchParams: Promise.resolve({ from: "/sessions" }) }));
    expect(strip(html)).toMatch(/can.{1,7}t reach its database/); // entity-encoded apostrophe
    expect(hrefs(html)).toContain("/sessions");

    const evil = renderToStaticMarkup(await Unavailable({ searchParams: Promise.resolve({ from: "//evil.com" }) }));
    expect(hrefs(evil)).not.toContain("//evil.com");
    expect(hrefs(evil)).toContain("/dashboard");
  });
});
