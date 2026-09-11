// Regenerates the product screenshots on the landing page.
//
//   node scripts/capture-landing.mjs
//
// Opens a visible Chrome window (fresh profile, nothing shared with your own
// Chrome) at /sign-in on the running dev server. Sign in there; the script
// waits, then captures the dashboard, a scored report, and a fresh voice
// round at 1440×900 @2x into public/landing/. No credentials or cookies pass
// through the script — the window is yours, the script only drives it after
// you are in. Starting the voice round costs one question-generation call
// and leaves a live round that the stale sweep abandons after an hour.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.MOCKPREP_URL ?? "http://localhost:3000";
const OUT = new URL("../public/landing/", import.meta.url).pathname;
const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTH = 1440;
const HEIGHT = 900;
const port = 9335;

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "mockprep-capture-"));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT + 90}`,
    "--no-first-run",
    "--no-default-browser-check",
    `${BASE}/sign-in`,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let id = 0;
const pending = new Map();
for (let i = 0; i < 50 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find((t) => t.type === "page");
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {
    await sleep(200);
  }
}
if (!ws) {
  console.error("Could not reach Chrome's debugging port. Is Chrome at", CHROME, "?");
  process.exit(1);
}
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))
    .result?.value;
const pathname = () => evaluate("location.pathname");
const waitFor = async (predicate, timeoutMs, what) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}.`);
};
const goto = async (path) => {
  await send("Page.navigate", { url: `${BASE}${path}` });
  await sleep(2500);
  await evaluate("document.fonts.ready");
  await sleep(500);
};
const capture = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`  ${name}.png ← ${await pathname()}`);
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 2,
  mobile: false,
});

console.log("Sign in in the Chrome window that just opened. Waiting up to five minutes…");
await waitFor(async () => (await pathname()).startsWith("/dashboard"), 5 * 60_000, "sign-in");
console.log("Signed in. Capturing:");

// 1. Dashboard, as landed on.
await sleep(1500);
await capture("dashboard");

// 2. The most recent scored report.
await goto("/sessions");
const report = await evaluate(`document.querySelector('a[href^="/report/"]')?.getAttribute("href") ?? null`);
if (report) {
  await goto(report);
  await capture("report");
} else {
  console.log("  report.png skipped — no scored round on this account yet.");
}

// 3. A fresh voice round, captured at its first question.
await goto("/dashboard");
await evaluate(`(() => {
  const form = document.querySelector('form input[name="role"]').form;
  form.querySelector('input[name="role"]').value = "Product manager, marketplace";
  form.querySelector('select[name="track"]').value = "product";
  form.querySelector('select[name="mode"]').value = "voice";
  form.querySelector('button[type="submit"]').click();
})()`);
await waitFor(async () => (await pathname()).startsWith("/session/"), 90_000, "the voice round to start");
await sleep(3000);
await evaluate("document.fonts.ready");
await capture("session");

console.log("Done. Files are in public/landing/.");
chrome.kill();
