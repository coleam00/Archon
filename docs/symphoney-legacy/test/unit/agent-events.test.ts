import { describe, it, expect } from "vitest";
import { extractAbsoluteTokenUsage } from "../../src/agent/events.js";

describe("extractAbsoluteTokenUsage", () => {
  it("returns null on non-objects", () => {
    expect(extractAbsoluteTokenUsage(null)).toBeNull();
    expect(extractAbsoluteTokenUsage(undefined)).toBeNull();
    expect(extractAbsoluteTokenUsage(42)).toBeNull();
    expect(extractAbsoluteTokenUsage("foo")).toBeNull();
  });

  it("ignores delta-style payloads (last_token_usage)", () => {
    expect(
      extractAbsoluteTokenUsage({
        type: "thread/last_token_usage",
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
    ).toBeNull();
  });

  it("recognizes thread/tokenUsage/updated", () => {
    const u = extractAbsoluteTokenUsage({
      type: "thread/tokenUsage/updated",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
    expect(u).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  });

  it("recognizes total_token_usage shape with input/output", () => {
    const u = extractAbsoluteTokenUsage({
      total_token_usage: { input: 10, output: 20 },
    });
    expect(u).toEqual({ input_tokens: 10, output_tokens: 20, total_tokens: 30 });
  });

  it("recognizes prompt_tokens / completion_tokens", () => {
    const u = extractAbsoluteTokenUsage({
      type: "thread/tokenUsage/updated",
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    });
    expect(u).toEqual({ input_tokens: 5, output_tokens: 7, total_tokens: 12 });
  });

  it("returns null when payload has no recognized usage fields", () => {
    expect(extractAbsoluteTokenUsage({ message: "hi" })).toBeNull();
  });
});
