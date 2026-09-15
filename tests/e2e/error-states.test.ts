import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

/**
 * The two failures that used to lose a typed answer, in a real browser
 * against the production build. Both start a real text round as a guest —
 * one question-generation call per run — because the thing being tested is
 * the live form in the live round.
 */

let browser: Browser;
let baseUrl: string;
let context: BrowserContext;
let page: Page;
const ANSWER = "My answer, typed over two minutes, which must not be lost.";
const box = () => page.getByPlaceholder("Talk through it the way you would out loud.");

beforeAll(async () => {
  baseUrl = inject("baseUrl");
  browser = await chromium.launch({ channel: process.env.CI ? undefined : "chrome" });
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(`${baseUrl}/sign-in`);
  await page.getByRole("button", { name: "Try a round as a guest" }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  await page.getByLabel("Role you are interviewing for").fill("Strategy analyst");
  await page.getByRole("button", { name: "Start a round" }).click();
  await page.waitForURL(/\/session\//, { timeout: 90_000 });
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

describe("a submit that never reaches the server", () => {
  it("network gone: the answer stays in the box and the message says so", async () => {
    await box().fill(ANSWER);
    await page.route("**/*", (route) =>
      route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue(),
    );
    await page.getByRole("button", { name: /Submit/ }).click();

    // Next's route announcer is also role="alert"; the form's message is the <p>.
    const alert = page.locator("form p[role=alert]");
    await expect.poll(() => alert.textContent(), { timeout: 15_000 }).toMatch(
      /Lost the connection before that was sent\. Your answer is still here/,
    );
    expect(await box().inputValue()).toBe(ANSWER);
    // Not Next's error page.
    expect(await page.locator("body").innerText()).not.toMatch(/This page couldn.t load/);
    await page.unroute("**/*");
  });

  it("session expired: the answer stays, the message says sign in, and there is a sign-in link", async () => {
    await box().fill(ANSWER);
    await context.clearCookies();
    await page.getByRole("button", { name: /Submit/ }).click();

    const alert = page.locator("form p[role=alert]");
    await expect.poll(() => alert.textContent(), { timeout: 15_000 }).toMatch(
      /sign-in expired.*your answer is still here/,
    );
    expect(await box().inputValue()).toBe(ANSWER);
    const link = alert.getByRole("link", { name: /Sign in in a new tab/ });
    expect(await link.getAttribute("href")).toBe("/sign-in");
    expect(await link.getAttribute("target")).toBe("_blank");
    expect(await page.locator("body").innerText()).not.toMatch(/This page couldn.t load/);
  });
});
