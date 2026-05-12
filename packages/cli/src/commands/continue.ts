/**
 * Continue command - run a workflow on an existing worktree with prior context auto-injected
 */
import { workflowRunCommand } from './workflow';
import * as isolationDb from '@archon/core/db/isolation-environments';
import * as codebaseDb from '@archon/core/db/codebases';
import * as workflowDb from '@archon/core/db/workflows';
import { execFileAsync } from '@archon/git';
import { createLogger, getRunArtifactsPath, parseOwnerRepo } from '@archon/paths';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.continue');
  return cachedLog;
}

export interface ContinueOptions {
  workflow?: string;
  noContext?: boolean;
}

const DEFAULT_WORKFLOW = 'archon-assist';

/**
 * Continue work on an existing worktree with prior run context injected.
 *
 * Resolves a branch name to its active worktree, finds the last run on that path,
 * builds a context preamble from live git state + artifact summaries, and delegates
 * to workflowRunCommand.
 */
export async function continueCommand(
  branch: string,
  userMessage: string,
  options: ContinueOptions = {}
): Promise<void> {
  const workflowName = options.workflow ?? DEFAULT_WORKFLOW;

  // 1. Resolve branch → isolation environment
  const env = await isolationDb.findActiveByBranchName(branch);
  if (!env) {
    throw new Error(
      `No active worktree found for branch '${branch}'.\n` +
        "Run 'archon isolation list' to see available worktrees."
    );
  }

  // 2. Find prior run on this worktree path
  const priorRun = await workflowDb.findLatestRunByWorkingPath(env.working_path);

  // 3. Build context preamble (unless --no-context)
  let contextPreamble = '';
  if (!options.noContext) {
    contextPreamble = await buildContextPreamble(env.working_path, env.codebase_id, priorRun);
  }

  // 4. Enrich message
  const enrichedMessage = contextPreamble
    ? `${contextPreamble}\n---\n\n## Your Instruction\n\n${userMessage}`
    : userMessage;

  // 5. Console output
  console.log(`Continuing on branch: ${branch}`);
  console.log(`Workflow: ${workflowName}`);
  console.log(`Path: ${env.working_path}`);
  if (priorRun) {
    console.log(`Prior run: ${priorRun.id} (${priorRun.workflow_name}, ${priorRun.status})`);
  }
  console.log('');

  // 6. Delegate to workflowRunCommand (fresh run, no resume)
  try {
    await workflowRunCommand(env.working_path, workflowName, enrichedMessage, {
      noWorktree: true,
      codebaseId: env.codebase_id,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, branch, workflowName }, 'cli.continue_run_failed');
    throw new Error(
      `Failed to run workflow '${workflowName}' on branch '${branch}': ${err.message}`
    );
  }
}

/**
 * Build a markdown context preamble from git state and prior run artifacts.
 * Each section is independently try/caught — failures produce empty strings, never throw.
 */
async function buildContextPreamble(
  workingPath: string,
  codebaseId: string,
  priorRun: WorkflowRun | null
): Promise<string> {
  const sections: string[] = [];

  // Header
  const branchLine = await safeExec('git', [
    '-C',
    workingPath,
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]);
  const header = priorRun
    ? `Branch: ${branchLine.trim() || '(unknown)'} | Last workflow: ${priorRun.workflow_name} (run ${priorRun.id}, ${priorRun.status})`
    : `Branch: ${branchLine.trim() || '(unknown)'}`;
  sections.push(`## Prior Context\n\n${header}`);

  // Recent commits
  const commits = await safeExec('git', ['-C', workingPath, 'log', '--oneline', '-15']);
  if (commits) {
    sections.push(`### Recent Commits\n\n\`\`\`\n${commits.trim()}\n\`\`\``);
  }

  // Changes from base (diff stats vs upstream)
  const diffStat = await safeExec('git', [
    '-C',
    workingPath,
    'diff',
    '--stat',
    'HEAD@{upstream}...HEAD',
  ]);
  if (diffStat) {
    sections.push(`### Changes from Base\n\n\`\`\`\n${diffStat.trim()}\n\`\`\``);
  }

  // PR info (gh CLI may not be installed — always optional)
  const prJson = await safeExec(
    'gh',
    ['pr', 'view', '--json', 'number,title,url,body'],
    workingPath
  );
  if (prJson) {
    try {
      const pr = JSON.parse(prJson) as { number: number; title: string; url: string; body: string };
      sections.push(
        `### PR\n\n**#${String(pr.number)}**: ${pr.title}\n${pr.url}\n\n${pr.body ? pr.body.slice(0, 500) : '(no description)'}`
      );
    } catch {
      // JSON parse failed — skip PR section
    }
  }

  // Artifacts from prior run
  if (priorRun) {
    const artifactSummary = await loadArtifactSummary(priorRun.id, codebaseId, workingPath);
    if (artifactSummary) {
      sections.push(`### Artifacts\n\n${artifactSummary}`);
    }
  }

  return sections.join('\n\n');
}

/**
 * Try to load .md artifact files from the prior run's artifacts directory.
 * Returns a summary string or empty string if no artifacts found.
 */
async function loadArtifactSummary(
  runId: string,
  codebaseId: string,
  workingPath: string
): Promise<string> {
  // Try project-scoped path first (via codebase name → owner/repo)
  const artifactsDir = await resolveArtifactsDir(runId, codebaseId, workingPath);
  if (!artifactsDir) return '';

  try {
    const dirStat = await stat(artifactsDir);
    if (!dirStat.isDirectory()) return '';
  } catch {
    return '';
  }

  try {
    const files = await readdir(artifactsDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    if (mdFiles.length === 0) return '';

    const summaries: string[] = [];
    for (const file of mdFiles.slice(0, 5)) {
      try {
        const content = await readFile(join(artifactsDir, file), 'utf-8');
        const lines = content.split('\n').slice(0, 50);
        summaries.push(`**${file}**:\n\`\`\`\n${lines.join('\n')}\n\`\`\``);
      } catch {
        // Skip unreadable files
      }
    }
    return summaries.join('\n\n');
  } catch {
    return '';
  }
}

/**
 * Resolve the artifacts directory for a prior run.
 * Tries project-scoped path first, falls back to cwd-based path.
 */
async function resolveArtifactsDir(
  runId: string,
  codebaseId: string,
  workingPath: string
): Promise<string | null> {
  // Try project-scoped path via codebase name
  try {
    const codebase = await codebaseDb.getCodebase(codebaseId);
    if (codebase) {
      const parsed = parseOwnerRepo(codebase.name);
      if (parsed) {
        const dir = getRunArtifactsPath(parsed.owner, parsed.repo, runId);
        try {
          await stat(dir);
          return dir;
        } catch {
          // Path doesn't exist, try fallback
        }
      }
    }
  } catch {
    // DB lookup failed, try fallback
  }

  // Fallback: cwd-based path
  const fallback = join(workingPath, '.archon', 'artifacts', 'runs', runId);
  try {
    await stat(fallback);
    return fallback;
  } catch {
    return null;
  }
}

/**
 * Execute a command and return stdout, or empty string on any failure.
 */
async function safeExec(cmd: string, args: string[], cwd?: string): Promise<string> {
  try {
    const opts = cwd ? { cwd } : undefined;
    const { stdout } = await execFileAsync(cmd, args, opts);
    return stdout;
  } catch {
    return '';
  }
}
