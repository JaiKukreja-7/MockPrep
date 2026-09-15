import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads .env.local into process.env for the projects that need real
 * services, without overriding anything the shell or CI already set.
 * The unit project never calls this: it must pass with no environment.
 */
export function loadLocalEnv(): void {
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith("#")) continue;
    const [, key, raw] = match;
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

/**
 * Loud, not skipped: a missing variable fails the test with the name of the
 * secret to set. Silently skipping is how an invariant stops being checked.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Locally it comes from .env.local; in CI add it as ` +
        `a repository secret with the same name (Settings → Secrets → Actions).`,
    );
  }
  return value;
}
