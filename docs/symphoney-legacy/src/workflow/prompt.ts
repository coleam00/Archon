import { Liquid } from "liquidjs";
import { WorkflowError } from "./parse.js";
import type { Issue } from "../tracker/types.js";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  cache: false,
});

export interface PromptInputs {
  issue: Issue;
  attempt: number | null;
  turn_number?: number;
  max_turns?: number;
}

function issueToTemplateScope(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branch_name ?? "",
    url: issue.url ?? "",
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    created_at: issue.created_at ? issue.created_at.toISOString() : null,
    updated_at: issue.updated_at ? issue.updated_at.toISOString() : null,
  };
}

export async function renderPrompt(template: string, inputs: PromptInputs): Promise<string> {
  if (!template.trim()) {
    return defaultPrompt(inputs);
  }
  try {
    const out = await engine.parseAndRender(template, {
      issue: issueToTemplateScope(inputs.issue),
      attempt: inputs.attempt,
      turn_number: inputs.turn_number ?? null,
      max_turns: inputs.max_turns ?? null,
    });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // liquidjs throws ParseError vs RenderError; surface as render error for orchestration
    throw new WorkflowError("template_render_error", msg, e);
  }
}

function defaultPrompt(inputs: PromptInputs): string {
  const i = inputs.issue;
  const head = `${i.identifier}: ${i.title}`;
  const body = i.description ?? "";
  return `${head}\n\n${body}`.trim();
}
