import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider, ProviderId } from "@/lib/llm/types";

/**
 * The route table is validated when lib/llm/routing.ts is imported, so the
 * only way to test the validator is to import the module with a poisoned
 * registry and watch the import itself. `vi.resetModules()` between cases
 * gives each one a fresh import.
 */

function fakeProvider(id: ProviderId, dataPolicy: LLMProvider["dataPolicy"]): LLMProvider {
  return {
    id,
    label: id,
    dataPolicy,
    isConfigured: () => true,
    complete: async () => ({ text: "", provider: id, model: "" }),
  };
}

function registryWith(policies: Record<ProviderId, LLMProvider["dataPolicy"]>) {
  const providers = Object.fromEntries(
    (Object.keys(policies) as ProviderId[]).map((id) => [id, fakeProvider(id, policies[id])]),
  ) as Record<ProviderId, LLMProvider>;
  return {
    getProvider: (id: ProviderId) => providers[id],
    allProviders: () => Object.values(providers),
  };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/llm/registry");
});

describe("routing table data-policy assertion", () => {
  it("accepts the real table when every sensitive task routes only to private providers", async () => {
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "private", groq: "private", openrouter: "trains-on-free-tier" }),
    );
    const routing = await import("@/lib/llm/routing");
    expect(routing.TASKS.resume_analysis.sensitive).toBe(true);
    expect(routing.TASKS.resume_analysis.chain.map((s) => s.provider)).toEqual(["groq"]);
  });

  it("throws at import, naming the task and the provider, if a sensitive task's provider trains on content", async () => {
    // Same table; the provider it trusts has changed its policy underneath it.
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "private", groq: "trains-on-free-tier", openrouter: "trains-on-free-tier" }),
    );
    await expect(import("@/lib/llm/routing")).rejects.toThrow(
      /task "resume_analysis" is marked sensitive but routes to "groq"/,
    );
  });

  it("does not care about non-sensitive tasks routing to training-eligible providers", async () => {
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "trains-on-free-tier", groq: "private", openrouter: "trains-on-free-tier" }),
    );
    // question_generation routes to gemini; that is allowed because it is not sensitive.
    await expect(import("@/lib/llm/routing")).resolves.toBeDefined();
  });

  it("runTask refuses a sensitive request even if the table were bypassed", async () => {
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "private", groq: "private", openrouter: "trains-on-free-tier" }),
    );
    const { runTask } = await import("@/lib/llm/index");
    const { TASKS } = await import("@/lib/llm/routing");
    // Assemble the unsafe chain at runtime, after the import-time check passed,
    // with the bad step first so nothing else can answer before it is reached.
    TASKS.resume_analysis.chain.unshift({ provider: "openrouter", model: "x" });
    await expect(runTask("resume_analysis", { system: "", user: "" })).rejects.toThrow(
      /Refusing to send sensitive task "resume_analysis" to openrouter/,
    );
  });
});
