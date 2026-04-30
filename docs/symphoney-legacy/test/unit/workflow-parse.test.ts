import { describe, it, expect } from "vitest";
import { parseWorkflowContent, splitFrontMatter, WorkflowError } from "../../src/workflow/parse.js";

describe("splitFrontMatter", () => {
  it("returns null yaml when no leading ---", () => {
    const out = splitFrontMatter("hello\n");
    expect(out.yaml).toBeNull();
    expect(out.body).toBe("hello\n");
  });

  it("splits front matter and body", () => {
    const content = "---\nfoo: bar\n---\nbody text\n";
    const out = splitFrontMatter(content);
    expect(out.yaml).toBe("foo: bar");
    expect(out.body).toBe("body text\n");
  });

  it("handles CRLF line endings", () => {
    const content = "---\r\nfoo: bar\r\n---\r\nbody\r\n";
    const out = splitFrontMatter(content);
    expect(out.yaml).toContain("foo: bar");
    expect(out.body.trim()).toBe("body");
  });

  it("treats no closing fence as no front matter", () => {
    const content = "---\nfoo: bar\nno close\n";
    const out = splitFrontMatter(content);
    expect(out.yaml).toBeNull();
    expect(out.body).toBe(content);
  });
});

describe("parseWorkflowContent", () => {
  it("parses front matter and trims body", () => {
    const def = parseWorkflowContent("---\ntracker:\n  kind: linear\n---\n\nprompt body\n\n");
    expect(def.config).toMatchObject({ tracker: { kind: "linear" } });
    expect(def.prompt_template).toBe("prompt body");
  });

  it("returns empty config when there is no front matter", () => {
    const def = parseWorkflowContent("just a prompt\n");
    expect(def.config).toEqual({});
    expect(def.prompt_template).toBe("just a prompt");
  });

  it("rejects non-map front matter", () => {
    expect(() => parseWorkflowContent("---\n- 1\n- 2\n---\nbody\n")).toThrow(WorkflowError);
    try {
      parseWorkflowContent("---\n- 1\n---\nbody\n");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).code).toBe("workflow_front_matter_not_a_map");
    }
  });

  it("raises workflow_parse_error on invalid YAML", () => {
    try {
      parseWorkflowContent("---\nkey: : :\n---\nbody\n");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).code).toBe("workflow_parse_error");
    }
  });
});
