import { readFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

/**
 * The design audit, as a test. Every rule that has been checked by hand on
 * every screen, run in a real Chromium against the production build at three
 * widths. A violation fails the build with the element and the value.
 *
 *   grey text      any element with its own text whose colour has alpha < 1.
 *                  Placeholders are the one sanctioned exception and are
 *                  pseudo-elements, so they never appear here.
 *   radii          every corner is 0, 4px (surfaces) or 320px (pills).
 *   borders        every drawn border is 1px (structural) or 2px (interactive).
 *   shadows        none, anywhere.
 *   font sizes     every element with its own text renders at a value one of
 *                  the --text-* tokens resolves to at this viewport. The token
 *                  list is read from the stylesheet, so a new token is
 *                  honoured and an off-token size is not.
 *   numerics       every numeric readout — an element whose text is digits
 *                  and separators only — has tabular figures.
 *   motion         no transition or animation, on an element or its
 *                  pseudo-elements, runs longer than --motion-slow, and a
 *                  transition's duration plus delay stays under 500ms. The
 *                  speaker's state animations and the pending-state pulse
 *                  are status indicators, exempt by class. Under
 *                  prefers-reduced-motion every duration is 0s and every
 *                  reveal is at full opacity — checked on the landing page.
 *
 * Routes: the public ones signed out, then every signed-in route as a guest
 * (no credentials needed). Screens that only exist with data — a scored
 * report, a resume analysis, a live session — are audited only when
 * E2E_EMAIL / E2E_PASSWORD point at an account that has them; otherwise those
 * cases are skipped by name, not silently passed.
 */

const WIDTHS = [375, 768, 1440] as const;
const PUBLIC_ROUTES = ["/", "/sign-in", "/test", "/unavailable?from=%2Fdashboard"];
const GUEST_ROUTES = ["/dashboard", "/sessions", "/reports", "/questions", "/settings", "/resume"];

let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  baseUrl = inject("baseUrl");
  browser = await chromium.launch({
    // Locally, the Chrome already on the machine; in CI, the Chromium that
    // `playwright install chromium` fetched.
    channel: process.env.CI ? undefined : "chrome",
  });
});

afterAll(async () => {
  await browser?.close();
});

/* ---------------------------------------------------------------- audit */

interface Violation {
  rule: string;
  element: string;
  value: string;
}

/** Runs inside the page. Serialisable in and out; no closures over test scope. */
function auditPage(): Violation[] {
  const out: Violation[] = [];
  const cs = (e: Element) => getComputedStyle(e);
  const describe = (e: Element) => {
    const tag = e.tagName.toLowerCase();
    const cls = e.getAttribute("class")?.split(/\s+/).slice(0, 3).join(".") ?? "";
    const text = (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${tag}${cls ? "." + cls : ""}${text ? ` "${text}"` : ""}`;
  };
  const alpha = (color: string) => {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  };

  // Text-bearing elements: those with at least one non-empty text node child.
  const everything = [...document.querySelectorAll("body *")].filter(
    (e) => !e.closest("nextjs-portal, svg, script, style, template"),
  );
  const textual = everything.filter(
    (e) =>
      !["OPTION", "SUP", "SUB"].includes(e.tagName) &&
      [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()),
  );

  // Font-size tokens, resolved at this viewport by asking the engine.
  const tokenNames = new Set<string>();
  const walk = (rules: CSSRuleList | undefined) => {
    for (const rule of rules ?? []) {
      if (rule instanceof CSSStyleRule) {
        for (const name of rule.style) if (name.startsWith("--text-")) tokenNames.add(name);
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) walk(nested);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // cross-origin sheet; there are none, but never fail the audit on one
    }
  }
  const probe = document.createElement("span");
  document.body.appendChild(probe);
  const allowedSizes = new Set<number>();
  for (const name of tokenNames) {
    probe.style.fontSize = `var(${name})`;
    allowedSizes.add(Math.round(parseFloat(cs(probe).fontSize) * 100) / 100);
  }
  probe.remove();

  for (const e of textual) {
    const s = cs(e);
    if (alpha(s.color) < 1) out.push({ rule: "grey text", element: describe(e), value: s.color });

    const size = Math.round(parseFloat(s.fontSize) * 100) / 100;
    if (![...allowedSizes].some((a) => Math.abs(a - size) < 0.02)) {
      out.push({ rule: "font size not a token", element: describe(e), value: `${size}px` });
    }

    const own = [...e.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join("")
      .trim();
    if (/\d/.test(own) && /^[\d.,:%/–—\-+\s]+$/.test(own) && !s.fontVariantNumeric.includes("tabular-nums")) {
      out.push({ rule: "numeric not tabular", element: describe(e), value: own });
    }
  }

  for (const e of everything) {
    const s = cs(e);
    for (const corner of ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"] as const) {
      const r = s[corner];
      if (!["0px", "4px", "320px"].includes(r)) {
        out.push({ rule: "radius", element: describe(e), value: r });
        break;
      }
    }
    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      const style = s[`border${side}Style` as keyof CSSStyleDeclaration] as string;
      const width = s[`border${side}Width` as keyof CSSStyleDeclaration] as string;
      if (style !== "none" && width !== "0px" && !["1px", "2px"].includes(width)) {
        out.push({ rule: "border width", element: describe(e), value: `${side.toLowerCase()} ${width}` });
        break;
      }
    }
    if (s.boxShadow !== "none") out.push({ rule: "shadow", element: describe(e), value: s.boxShadow });
  }

  // Motion: the longest token, read from the stylesheet, is the ceiling.
  const ms = (v: string) => (v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000);
  const slow = ms(cs(document.documentElement).getPropertyValue("--motion-slow").trim() || "0s");
  const exemptAnimation = (e: Element) =>
    e.classList.contains("animate-pulse") || [...e.classList].some((c) => c.startsWith("speaker-"));
  for (const e of everything) {
    for (const pseudo of [null, "::before", "::after"] as const) {
      const s = pseudo ? getComputedStyle(e, pseudo) : cs(e);
      if (pseudo && s.content === "none") continue;
      const durations = s.transitionDuration.split(",").map((d) => ms(d.trim()));
      const delays = s.transitionDelay.split(",").map((d) => ms(d.trim()));
      durations.forEach((d, i) => {
        const delay = delays[i] ?? delays[0] ?? 0;
        if (d > slow) out.push({ rule: "transition longer than a token", element: describe(e) + (pseudo ?? ""), value: s.transitionDuration });
        else if (d > 0 && d + delay > 500) out.push({ rule: "transition lands after 500ms", element: describe(e) + (pseudo ?? ""), value: `${d}ms + ${delay}ms` });
      });
      if (s.animationName !== "none" && !exemptAnimation(e)) {
        for (const d of s.animationDuration.split(",").map((d) => ms(d.trim()))) {
          if (d > slow) out.push({ rule: "animation longer than a token", element: describe(e) + (pseudo ?? ""), value: s.animationDuration });
        }
        if (s.animationIterationCount.includes("infinite")) {
          out.push({ rule: "animation loops", element: describe(e) + (pseudo ?? ""), value: s.animationIterationCount });
        }
      }
    }
  }

  // Dedupe identical findings (a list renders the same row many times).
  const seen = new Set<string>();
  return out.filter((v) => {
    const key = `${v.rule}|${v.element}|${v.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Runs inside the page under prefers-reduced-motion: everything must be off. */
function auditReducedMotion(): Violation[] {
  const out: Violation[] = [];
  const ms = (v: string) => (v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000);
  for (const e of document.querySelectorAll("body *")) {
    if (e.closest("nextjs-portal, svg, script, style, template")) continue;
    for (const pseudo of [null, "::before", "::after"] as const) {
      const s = pseudo ? getComputedStyle(e, pseudo) : getComputedStyle(e);
      if (pseudo && s.content === "none") continue;
      const tag = e.tagName.toLowerCase() + (pseudo ?? "");
      if (s.transitionDuration.split(",").some((d) => ms(d.trim()) > 0)) {
        out.push({ rule: "transition under reduced motion", element: tag, value: s.transitionDuration });
      }
      if (s.animationName !== "none" && s.animationDuration.split(",").some((d) => ms(d.trim()) > 0)) {
        out.push({ rule: "animation under reduced motion", element: tag, value: s.animationDuration });
      }
    }
  }
  for (const e of document.querySelectorAll("[data-reveal], [data-reveal-item]")) {
    const s = getComputedStyle(e);
    if (s.opacity !== "1" || (s.translate !== "none" && s.translate !== "0px")) {
      out.push({ rule: "reveal hidden under reduced motion", element: e.tagName.toLowerCase(), value: `opacity ${s.opacity}, translate ${s.translate}` });
    }
  }
  const seen = new Set<string>();
  return out.filter((v) => {
    const key = `${v.rule}|${v.element}|${v.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function audit(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
  const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
  expect(response?.status(), `${path} should render`).toBe(200);
  await page.evaluate(() => document.fonts.ready);
  const violations = await page.evaluate(auditPage);
  expect(
    violations,
    `${path} @${width}: ${violations.length} violation(s)\n` +
      violations.map((v) => `  [${v.rule}] ${v.element} → ${v.value}`).join("\n"),
  ).toEqual([]);
}

/* ----------------------------------------------------------- self-test
   An audit that never fails proves nothing. Plant one violation of each
   kind on a clean page and require the audit to report exactly those. */

describe("the audit itself", () => {
  it("catches a planted violation of every rule, and nothing else", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${baseUrl}/test`, { waitUntil: "networkidle" });
      await page.evaluate(() => {
        const add = (html: string) => document.body.insertAdjacentHTML("beforeend", html);
        add('<p id="v1" style="color: rgba(0,0,0,0.6)">grey</p>');
        add('<p id="v2" style="border-radius: 8px">radius</p>');
        add('<p id="v3" style="border: 3px solid black">border</p>');
        add('<p id="v4" style="box-shadow: 0 1px 2px black">shadow</p>');
        add('<p id="v5" style="font-size: 17px">size</p>');
        add('<p id="v6" style="font-variant-numeric: normal">1,234</p>');
        add('<p id="v7" style="transition: opacity 600ms">slow transition</p>');
        add('<p id="v8" style="transition: opacity 400ms 200ms">late transition</p>');
        add('<style>@keyframes planted { to { opacity: 0.5 } }</style><p id="v9" style="animation: planted 900ms infinite">animation</p>');
      });
      const violations = await page.evaluate(auditPage);
      const rules = violations.map((v) => `${v.rule}: ${v.element}`).sort();
      expect(rules).toEqual(
        [
          'border width: p "border"',
          'font size not a token: p "size"',
          'grey text: p "grey"',
          'numeric not tabular: p "1,234"',
          'radius: p "radius"',
          'shadow: p "shadow"',
          'transition longer than a token: p "slow transition"',
          'transition lands after 500ms: p "late transition"',
          'animation longer than a token: p "animation"',
          'animation loops: p "animation"',
        ].sort(),
      );
    } finally {
      await context.close();
    }
  });
});

/* --------------------------------------------------------------- motion */

describe("scroll reveal and reduced motion on the landing page", () => {
  it("nothing is hidden before the observer runs, and a section below the fold reveals once", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
      // No JS: every reveal target is at full opacity, in place.
      const hidden = await page.evaluate(() =>
        [...document.querySelectorAll("[data-reveal], [data-reveal-item]")].filter((e) => getComputedStyle(e).opacity !== "1").length,
      );
      expect(hidden).toBe(0);
    } finally {
      await context.close();
    }

    const live = await browser.newContext();
    const livePage = await live.newPage();
    try {
      await livePage.setViewportSize({ width: 1440, height: 900 });
      await livePage.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
      const states = await livePage.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("[data-reveal]")].map((e) => e.dataset.reveal),
      );
      // The observer has run: below-the-fold sections are pending, none is
      // hidden that the visitor can see.
      expect(states).toContain("pending");
      expect(states.every((s) => s === "pending" || s === "" || s === "in")).toBe(true);
      const last = livePage.locator("[data-reveal]").last();
      await last.scrollIntoViewIfNeeded();
      await expect.poll(() => last.getAttribute("data-reveal")).toBe("in");
      await expect.poll(() => last.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
      // Scroll back up and down again: it stays "in" — never replays.
      await livePage.evaluate(() => window.scrollTo(0, 0));
      await livePage.waitForTimeout(200);
      await last.scrollIntoViewIfNeeded();
      expect(await last.getAttribute("data-reveal")).toBe("in");
    } finally {
      await live.close();
    }
  });

  it("under prefers-reduced-motion every transition and animation is off and every reveal is visible", async () => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
        await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
        const states = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("[data-reveal]")].map((e) => e.dataset.reveal),
        );
        expect(states.every((s) => s === ""), "the observer must not mark anything").toBe(true);
        const violations = await page.evaluate(auditReducedMotion);
        expect(violations, `/ @${width} reduced motion:\n` + violations.map((v) => `  [${v.rule}] ${v.element} → ${v.value}`).join("\n")).toEqual([]);
      }
      // And on an app screen, where hover transitions are the only motion.
      await page.goto(`${baseUrl}/sign-in`, { waitUntil: "networkidle" });
      expect(await page.evaluate(auditReducedMotion)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

/* --------------------------------------------------------------- routes */

describe("signed out", () => {
  let context: BrowserContext;
  let page: Page;
  beforeAll(async () => {
    context = await browser.newContext();
    page = await context.newPage();
  });
  afterAll(async () => context.close());

  it.each(PUBLIC_ROUTES.flatMap((r) => WIDTHS.map((w) => [r, w] as const)))(
    "%s @%dpx",
    async (route, width) => audit(page, route, width),
  );
});

describe("as a guest", () => {
  let context: BrowserContext;
  let page: Page;
  beforeAll(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(`${baseUrl}/sign-in`);
    await page.getByRole("button", { name: "Try a round as a guest" }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  });
  afterAll(async () => context.close());

  it.each(GUEST_ROUTES.flatMap((r) => WIDTHS.map((w) => [r, w] as const)))(
    "%s @%dpx",
    async (route, width) => audit(page, route, width),
  );
});

/* Screens that need data. Skipped by name when no account is configured. */
const hasAccount = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);

describe.skipIf(!hasAccount)("signed in with data (E2E_EMAIL / E2E_PASSWORD)", () => {
  let context: BrowserContext;
  let page: Page;
  const found: Record<string, string | null> = { report: null, resume: null, session: null };

  beforeAll(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(`${baseUrl}/sign-in`);
    await page.getByLabel("Email").first().fill(process.env.E2E_EMAIL!);
    await page.getByLabel("Password").fill(process.env.E2E_PASSWORD!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

    await page.goto(`${baseUrl}/sessions`);
    found.report = await page.locator('a[href^="/report/"]').first().getAttribute("href").catch(() => null);
    found.session = await page.locator('a[href^="/session/"]').first().getAttribute("href").catch(() => null);
    await page.goto(`${baseUrl}/resume`);
    found.resume = await page.locator('a[href^="/resume/"]').first().getAttribute("href").catch(() => null);
  });
  afterAll(async () => context?.close());

  for (const key of ["report", "resume", "session"] as const) {
    it.each(WIDTHS)(`/${key}/[id] @%dpx`, async (width) => {
      const path = found[key];
      expect(path, `the account has no ${key} to audit — add one or drop the credentials`).toBeTruthy();
      await audit(page, path!, width);
    });
  }
});

/* ------------------------------------------------------- production gates */

describe("routes that must not exist in production", () => {
  it("/test is only reachable because this server sets MOCKPREP_SHOW_PRIMITIVES", async () => {
    // The audit's own server sets it (see tests/e2e/global-setup.ts), which
    // is why every case above could audit /test. Without it a production
    // build 404s — asserted here so the gate cannot be deleted silently.
    const source = await readFile(new URL("../../app/test/page.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/process\.env\.NODE_ENV === "production" && !process\.env\["MOCKPREP_SHOW_PRIMITIVES"\]/);
    expect(source).toMatch(/notFound\(\)/);
  });
});
