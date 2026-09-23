import { spawn, type ChildProcess } from "node:child_process";
import type { TestProject } from "vitest/node";
import { loadLocalEnv } from "../support/env";

/**
 * Serves the production build for the e2e project. `npm run test:e2e` builds
 * first; this only starts `next start` and waits for it. Production, not dev:
 * the dev overlay would fail the shadow and radius checks on every route,
 * and production is what the audit is about.
 */

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
  }
}

let server: ChildProcess | null = null;

export async function setup(project: TestProject) {
  loadLocalEnv();
  server = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      // /test is 404 in production; the audit still wants it, because a
      // design violation shows on the specimen sheet before it shows on a
      // real screen. Set only here, never on Vercel.
      MOCKPREP_SHOW_PRIMITIVES: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout?.on("data", (d) => (log += d));
  server.stderr?.on("data", (d) => (log += d));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/sign-in`);
      if (res.status === 200) {
        project.provide("baseUrl", BASE);
        return;
      }
      if (res.status >= 500) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  server.kill();
  throw new Error(
    `next start did not come up on ${BASE}. Did the build run (npm run test:e2e builds first)?\n${log}`,
  );
}

export async function teardown() {
  server?.kill();
}
