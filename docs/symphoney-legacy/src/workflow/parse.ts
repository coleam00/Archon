import { parse as parseYaml, YAMLParseError } from "yaml";

export type WorkflowConfig = Record<string, unknown>;

export interface WorkflowDefinition {
  config: WorkflowConfig;
  prompt_template: string;
}

export class WorkflowError extends Error {
  constructor(
    public readonly code:
      | "missing_workflow_file"
      | "workflow_parse_error"
      | "workflow_front_matter_not_a_map"
      | "template_parse_error"
      | "template_render_error",
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

const FENCE = "---";

export function splitFrontMatter(content: string): {
  yaml: string | null;
  body: string;
} {
  const trimmedStart = content.replace(/^﻿/, "");
  if (!trimmedStart.startsWith(FENCE)) {
    return { yaml: null, body: trimmedStart };
  }

  const afterFirst = trimmedStart.slice(FENCE.length);
  if (!/^\r?\n/.test(afterFirst)) {
    return { yaml: null, body: trimmedStart };
  }

  const rest = afterFirst.replace(/^\r?\n/, "");
  const closeMatch = rest.match(/(?:^|\r?\n)---(\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { yaml: null, body: trimmedStart };
  }

  const yaml = rest.slice(0, closeMatch.index);
  const tail = rest.slice(closeMatch.index + closeMatch[0].length);
  return { yaml, body: tail };
}

export function parseWorkflowContent(content: string): WorkflowDefinition {
  const { yaml, body } = splitFrontMatter(content);

  if (yaml === null) {
    return { config: {}, prompt_template: body.trim() };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (e) {
    if (e instanceof YAMLParseError) {
      throw new WorkflowError(
        "workflow_parse_error",
        `Failed to parse YAML front matter: ${e.message}`,
        e,
      );
    }
    throw new WorkflowError(
      "workflow_parse_error",
      `Failed to parse YAML front matter`,
      e,
    );
  }

  if (parsed === null || parsed === undefined) {
    return { config: {}, prompt_template: body.trim() };
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "YAML front matter must decode to a map/object",
    );
  }

  return {
    config: parsed as WorkflowConfig,
    prompt_template: body.trim(),
  };
}
