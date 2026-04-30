import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseWorkflowContent, WorkflowError, type WorkflowDefinition } from "./parse.js";

export async function loadWorkflowFromPath(filePath: string): Promise<{
  definition: WorkflowDefinition;
  absolutePath: string;
}> {
  const absolutePath = resolve(filePath);
  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch (e) {
    throw new WorkflowError(
      "missing_workflow_file",
      `Could not read workflow file at ${absolutePath}: ${(e as Error).message}`,
      e,
    );
  }
  const definition = parseWorkflowContent(content);
  return { definition, absolutePath };
}

export { WorkflowError };
export type { WorkflowDefinition };
