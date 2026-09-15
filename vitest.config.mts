import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

/**
 * Three projects, three costs.
 *
 * unit         no environment, no network, runs inside `npm run build` so a
 *              red invariant fails the image build.
 * integration  the real Supabase project as an anonymous user: the quota
 *              function under concurrency and the column grants. Needs the
 *              two public Supabase variables.
 * e2e          the design audit over every route in a real Chromium against
 *              a production build. Needs the same two variables and a
 *              browser.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      "server-only": `${root}tests/support/server-only.ts`,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/support/setup-env.ts"],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/support/setup-env.ts"],
          globalSetup: ["tests/e2e/global-setup.ts"],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          // One browser, one server: parallel files would race the guest
          // session and the port.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      exclude: ["lib/supabase/types.ts", "lib/voice/**"],
      reporter: ["text", "text-summary"],
    },
  },
});
