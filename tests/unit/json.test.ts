import { describe, expect, it } from "vitest";
import { parseJson } from "@/lib/llm/json";

describe("parseJson", () => {
  it("parses clean JSON", () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips <think> blocks, including multi-line and mixed-case ones", () => {
    const raw = "<THINK>\nlet me reason\nabout this {not json}\n</think>\n{\"ok\":true}";
    expect(parseJson<{ ok: boolean }>(raw)).toEqual({ ok: true });
  });

  it("strips ```json fences and bare ``` fences", () => {
    expect(parseJson<{ a: number }>("```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
    expect(parseJson<{ a: number }>("```\n{\"a\":3}\n```")).toEqual({ a: 3 });
  });

  it("finds the first balanced object after a sentence of preamble", () => {
    const raw = 'Sure! Here is the JSON you asked for: {"flags":[{"index":1,"flag":"filler"}]} Hope this helps.';
    expect(parseJson<{ flags: unknown[] }>(raw).flags).toHaveLength(1);
  });

  it("ignores braces inside strings when balancing", () => {
    const raw = 'preamble {"text":"a } brace and a \\" quote { here","n":1} trailing }';
    expect(parseJson<{ text: string; n: number }>(raw)).toEqual({
      text: 'a } brace and a " quote { here',
      n: 1,
    });
  });

  it("returns the first object only, not a later one", () => {
    expect(parseJson<{ a: number }>('{"a":1} {"a":2}')).toEqual({ a: 1 });
  });

  it("handles arrays as the top-level value", () => {
    expect(parseJson<number[]>("Result: [1,2,3].")).toEqual([1, 2, 3]);
  });

  it("throws, quoting the start of the response, when there is no JSON at all", () => {
    expect(() => parseJson("I cannot help with that.")).toThrow(
      /Model did not return JSON\. First 200 chars: I cannot help/,
    );
  });

  it("throws on an unbalanced object rather than guessing", () => {
    expect(() => parseJson('{"a": [1, 2')).toThrow();
  });
});
