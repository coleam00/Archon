import { describe, it, expect } from "vitest";
import { normalizeLinearIssue } from "../../src/tracker/normalize.js";

describe("normalizeLinearIssue", () => {
  it("lowercases labels and parses dates", () => {
    const issue = normalizeLinearIssue({
      id: "abc",
      identifier: "MT-1",
      title: "T",
      description: "D",
      priority: 1,
      branchName: "br",
      url: "u",
      state: { name: "In Progress" },
      labels: { nodes: [{ name: "Bug" }, { name: "URGENT" }, { name: null }] },
      inverseRelations: { nodes: [] },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    });
    expect(issue.labels).toEqual(["bug", "urgent"]);
    expect(issue.state).toBe("In Progress");
    expect(issue.priority).toBe(1);
    expect(issue.created_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(issue.updated_at?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("derives blocked_by only from `blocks` inverse relations", () => {
    const issue = normalizeLinearIssue({
      id: "abc",
      identifier: "MT-1",
      state: { name: "Todo" },
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { id: "x", identifier: "MT-X", state: { name: "Todo" } } },
          { type: "duplicate", issue: { id: "y", identifier: "MT-Y", state: { name: "Done" } } },
          { type: "blocks", issue: { id: "z", identifier: "MT-Z", state: { name: "Done" } } },
        ],
      },
    });
    expect(issue.blocked_by).toEqual([
      { id: "x", identifier: "MT-X", state: "Todo" },
      { id: "z", identifier: "MT-Z", state: "Done" },
    ]);
  });

  it("coerces non-integer priority to null", () => {
    expect(
      normalizeLinearIssue({
        id: "x",
        identifier: "MT-2",
        priority: 1.5 as unknown as number,
      }).priority,
    ).toBeNull();
    expect(
      normalizeLinearIssue({
        id: "x",
        identifier: "MT-3",
        priority: "2" as unknown as number,
      }).priority,
    ).toBeNull();
  });

  it("returns null dates when input is invalid or missing", () => {
    const issue = normalizeLinearIssue({
      id: "x",
      identifier: "MT-4",
      createdAt: "not-a-date",
    });
    expect(issue.created_at).toBeNull();
    expect(issue.updated_at).toBeNull();
  });
});
