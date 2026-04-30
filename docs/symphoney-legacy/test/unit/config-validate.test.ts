import { describe, it, expect } from "vitest";
import { buildSnapshot } from "../../src/config/snapshot.js";
import { parseWorkflowContent } from "../../src/workflow/parse.js";
import { validateDispatchConfig } from "../../src/config/validate.js";

function snap(yaml: string, env: NodeJS.ProcessEnv = {}) {
  const def = parseWorkflowContent(`---\n${yaml}\n---\nbody\n`);
  return buildSnapshot("/a/WORKFLOW.md", def, env);
}

describe("validateDispatchConfig", () => {
  it("rejects unsupported tracker kind", () => {
    const r = validateDispatchConfig(snap("tracker:\n  kind: jira"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_tracker_kind");
  });

  it("rejects missing api_key", () => {
    const r = validateDispatchConfig(
      snap("tracker:\n  kind: linear\n  project_slug: x"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_tracker_api_key");
  });

  it("rejects missing project_slug", () => {
    const r = validateDispatchConfig(
      snap("tracker:\n  kind: linear\n  api_key: $K", { K: "tok" } as NodeJS.ProcessEnv),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_tracker_project_slug");
  });

  it("accepts a fully populated linear config", () => {
    const r = validateDispatchConfig(
      snap(
        "tracker:\n  kind: linear\n  api_key: $K\n  project_slug: proj",
        { K: "tok" } as NodeJS.ProcessEnv,
      ),
    );
    expect(r.ok).toBe(true);
  });

  // Note: an empty/missing codex.command in YAML falls back to the default
  // `codex app-server`, so validation does not fail on that input.

});
