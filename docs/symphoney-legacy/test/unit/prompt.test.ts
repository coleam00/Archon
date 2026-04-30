import { describe, it, expect } from "vitest";
import { renderPrompt } from "../../src/workflow/prompt.js";
import { WorkflowError } from "../../src/workflow/parse.js";
import type { Issue } from "../../src/tracker/types.js";

function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "abc",
    identifier: "MT-1",
    title: "test issue",
    description: "do the thing",
    priority: 2,
    state: "Todo",
    branch_name: "feature/mt-1",
    url: "https://linear.app/x/mt-1",
    labels: ["bug", "urgent"],
    blocked_by: [],
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-02T00:00:00Z"),
    ...over,
  };
}

describe("renderPrompt", () => {
  it("renders normal liquid templates with issue/attempt", async () => {
    const out = await renderPrompt(
      "Hello {{ issue.identifier }} ({{ issue.title }}). attempt={{ attempt }}",
      { issue: makeIssue(), attempt: 3 },
    );
    expect(out).toBe("Hello MT-1 (test issue). attempt=3");
  });

  it("supports labels iteration", async () => {
    const out = await renderPrompt(
      "{% for l in issue.labels %}[{{ l }}]{% endfor %}",
      { issue: makeIssue({ labels: ["bug", "urgent"] }), attempt: null },
    );
    expect(out).toBe("[bug][urgent]");
  });

  it("fails on unknown variable (strict mode)", async () => {
    await expect(
      renderPrompt("hi {{ does_not_exist }}", { issue: makeIssue(), attempt: null }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it("fails on unknown filter (strict mode)", async () => {
    await expect(
      renderPrompt("{{ issue.title | nope }}", { issue: makeIssue(), attempt: null }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it("uses default prompt when template is empty", async () => {
    const out = await renderPrompt("", { issue: makeIssue(), attempt: null });
    expect(out).toContain("MT-1: test issue");
    expect(out).toContain("do the thing");
  });
});
