import type { Codebase } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import { findWorkflow } from '@archon/workflows/router';
import { parseSlashCommand } from '../utils/command-args';
import { findCodebaseByName, type ProjectRegistration } from './chat-tools';
import { getLog } from './agent-log';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowInvocation {
  workflowName: string;
  projectName: string;
  remainingMessage: string;
  synthesizedPrompt?: string;
}

export interface OrchestratorCommands {
  workflowInvocation: WorkflowInvocation | null;
  projectRegistration: ProjectRegistration | null;
}

export const NO_COMMANDS: OrchestratorCommands = {
  workflowInvocation: null,
  projectRegistration: null,
};

// ─── Command Parsing ────────────────────────────────────────────────────────

export function parseProjectRegistration(message: string): ProjectRegistration | null {
  const { command, args } = parseSlashCommand(message);
  if (command !== 'register-project') return null;
  const folder = args[0] === '--folder';
  const [projectName, ...pathParts] = folder ? args.slice(1) : args;
  if (!projectName || pathParts.length === 0) return null;
  return {
    projectName,
    projectPath: pathParts.join(' '),
    ...(folder ? { folder: true } : {}),
  };
}

// One definition of a quoted command argument, shared by the streaming completeness
// checks and the --prompt extractor. When they disagreed, an escaped quote passed the
// check and truncated the extracted prompt.
const DQ_ARG_BODY = String.raw`(?:[^"\\]|\\.)`;
const SQ_ARG_BODY = String.raw`(?:[^'\\]|\\.)`;
const DQ_ARG_RE = new RegExp(`^"${DQ_ARG_BODY}*"`);
const SQ_ARG_RE = new RegExp(`^'${SQ_ARG_BODY}*'`);
const PROMPT_ARG_RE = new RegExp(
  String.raw`--prompt\s+(?:"(${DQ_ARG_BODY}+)"|'(${SQ_ARG_BODY}+)')`
);

// Prefix patterns: fire as soon as the command keyword is seen.
const INVOKE_WORKFLOW_PREFIX_RE = /^\/invoke-workflow\s/m;
const REGISTER_PROJECT_PREFIX_RE = /^\/register-project\s/m;

// Full-command patterns: fire once all required tokens are present.
// These determine when accumulation can stop — further chunks cannot add
// required parse tokens and could corrupt already-captured ones.
//
// INVOKE_WORKFLOW_FULL_RE uses a test() object because the stop condition must account
// for the optional --prompt parameter:
//   - If --prompt "..." is present with a closing quote → fully parsed.
//   - If --prompt is started but not closed → keep accumulating for the closing quote.
//   - If no --prompt and the line is terminated (\n) → fully parsed (no more params).
//   - If no --prompt and EOS (no \n yet) → keep accumulating in case --prompt follows.
// A plain regex would fire as soon as --project <token> matched, dropping a --prompt
// that arrives in a later chunk and causing synthesizedPrompt to be lost.
const INVOKE_WORKFLOW_FULL_RE = {
  test(text: string): boolean {
    // Match the invoke-workflow line up to and including its terminator (\n) or end of string.
    const lineMatch = /^\/invoke-workflow[^\r\n]*(\r?\n|$)/m.exec(text);
    if (!lineMatch) return false;
    const line = lineMatch[0].replace(/(\r?\n)?$/, '');
    // Must have workflow name and --project token before we consider stopping.
    if (!/--project[\s=]+\S+/.test(line)) return false;
    const isEos = !lineMatch[0].endsWith('\n');
    // Check for optional --prompt parameter (system prompt specifies it follows --project).
    const promptKeywordMatch = /--prompt\s+/.exec(line);
    if (promptKeywordMatch) {
      const afterPrompt = line.slice(promptKeywordMatch.index + promptKeywordMatch[0].length);
      if (afterPrompt.startsWith('"')) return DQ_ARG_RE.test(afterPrompt);
      if (afterPrompt.startsWith("'")) return SQ_ARG_RE.test(afterPrompt);
      // Unquoted --prompt value: require line terminator.
      return !isEos;
    }
    // No --prompt yet: require line terminator so a --prompt in a later chunk is not missed.
    return !isEos;
  },
};
// REGISTER_PROJECT_FULL_RE uses a test() object instead of a plain regex because the
// stop condition must be conservative:
//   - Unquoted paths: require the line to be terminated (\n or end of stream preceded
//     by a non-whitespace char) so a space-containing path like "/home/user/my project"
//     is not declared complete after "my" arrives.
//   - Quoted paths: require the closing quote so we don't stop mid-path.
const REGISTER_PROJECT_FULL_RE = {
  test(text: string): boolean {
    // Match the register-project line up to and including its terminator (\n) or end of string.
    const lineMatch = /^\/register-project[^\r\n]*(\r?\n|$)/m.exec(text);
    if (!lineMatch) return false;
    // Only treat end-of-string as a line terminator when at least one non-whitespace
    // character follows the project name — avoids matching a partial "/register-project "
    // line that was cut mid-word.
    const isEos = !lineMatch[0].endsWith('\n');
    const line = lineMatch[0].replace(/(\r?\n)?$/, '');
    const commandArgs = line.replace(/^\/register-project\s+/, '');
    const rest = commandArgs.replace(/^--folder\s+/, '');
    if (commandArgs === line) return false; // no whitespace after command keyword
    const nameEnd = rest.search(/\s/);
    if (nameEnd === -1) return false; // no path token yet
    const projectPath = rest.slice(nameEnd).trimStart();
    if (!projectPath) return false;
    // Quoted path: require the closing quote
    if (projectPath.startsWith('"')) return DQ_ARG_RE.test(projectPath);
    if (projectPath.startsWith("'")) return SQ_ARG_RE.test(projectPath);
    // Unquoted path: require line terminator so we don't freeze on a partial path with spaces
    return !isEos;
  },
};

/**
 * Strip markdown bold/italic decorators from slash-command lines.
 * Pi and other models occasionally emit **\/register-project ...** or
 * *\/invoke-workflow ...* instead of a bare slash command. The leading
 * asterisks cause both prefix and full-command regexes to miss the line.
 * Only lines whose first non-asterisk character is '/' are affected.
 */
export function normalizeCommandText(text: string): string {
  return text.replace(/^\s*\*+(\/[^\n]*?)\**\s*$/gm, '$1');
}

/** Returns true once accumulated text starts an orchestrator command line. */
export function hasCommandPrefix(accumulated: string): boolean {
  const normalized = normalizeCommandText(accumulated);
  return INVOKE_WORKFLOW_PREFIX_RE.test(normalized) || REGISTER_PROJECT_PREFIX_RE.test(normalized);
}

/** Returns true once accumulated text contains a complete orchestrator command. */
export function isCommandFullyParsed(accumulated: string): boolean {
  const normalized = normalizeCommandText(accumulated);
  return INVOKE_WORKFLOW_FULL_RE.test(normalized) || REGISTER_PROJECT_FULL_RE.test(normalized);
}

/**
 * Parse orchestrator commands from AI response text.
 * Scans for /invoke-workflow and /register-project patterns.
 */
export function parseOrchestratorCommands(
  response: string,
  codebases: readonly Codebase[],
  workflows: readonly Pick<WorkflowDefinition, 'name'>[]
): OrchestratorCommands {
  const result: OrchestratorCommands = {
    workflowInvocation: null,
    projectRegistration: null,
  };

  // Strip markdown bold/italic decorators from slash command lines before matching.
  // Pi models occasionally emit **\/register-project ...** or **\/invoke-workflow ...**.
  const normalizedResponse = normalizeCommandText(response);

  // Parse /invoke-workflow {name} --project {project-name}
  // Use (\S+) for project name to avoid capturing trailing text on the same line
  // (e.g., when AI appends tool call indicators or continues text after the command).
  // --project MUST appear before --prompt; this order is specified in the system prompt
  // template. Commands with --prompt before --project will not match.
  const invokePattern = /^\/invoke-workflow\s+(\S+)\s+--project[\s=]+(\S+)/m;
  const invokeMatch = invokePattern.exec(normalizedResponse);
  if (invokeMatch) {
    const workflowName = invokeMatch[1].trim();
    const projectName = invokeMatch[2].trim();

    // Validate workflow exists
    const workflow = findWorkflow(workflowName, [...workflows]);
    if (workflow) {
      // Validate project exists (case-insensitive, supports partial name matching)
      // e.g., "Archon" matches "coleam00/Archon"
      const matchedCodebase = findCodebaseByName(codebases, projectName);
      if (matchedCodebase) {
        // Extract message before the command
        const commandIndex = normalizedResponse.indexOf(invokeMatch[0]);
        const remainingMessage = normalizedResponse.slice(0, commandIndex).trim();

        // Extract optional --prompt "..." parameter (double or single quotes)
        const commandText = normalizedResponse.slice(commandIndex);
        const promptMatch = PROMPT_ARG_RE.exec(commandText);
        const rawPrompt = (promptMatch?.[1] ?? promptMatch?.[2])
          ?.replace(/\\(["'\\])/g, '$1')
          .trim();
        const synthesizedPrompt = rawPrompt || undefined;

        if (promptMatch && !synthesizedPrompt) {
          getLog().warn({ workflowName, projectName }, 'synthesized_prompt_empty_discarded');
        }

        result.workflowInvocation = {
          workflowName: workflow.name,
          projectName: matchedCodebase.name,
          remainingMessage,
          synthesizedPrompt,
        };
      }
    }
  }

  const registerMatch = /^\/register-project[^\S\r\n]+[^\r\n]+/m.exec(normalizedResponse);
  if (registerMatch) result.projectRegistration = parseProjectRegistration(registerMatch[0]);

  return result;
}
