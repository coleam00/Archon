/**
 * Scaffold template for new agents.
 *
 * The template is a single editable file that every "New agent" creation
 * seeds from. It lives at:
 *   - `<cwd>/.claude/agents/_templates/default.md`  (project, preferred)
 *   - `~/.claude/agents/_templates/default.md`      (global, fallback)
 *
 * If neither exists when first read, we write the bundled default to the
 * project location and return its content. This means a freshly cloned repo
 * with no template gets a sane starting point on the first /agents visit
 * without surprising the user.
 *
 * The template is plain text the user is expected to edit — no separate
 * "New agent" UI for picking template style. They edit one file; every
 * subsequent agent starts from it.
 */

import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

function getHome(): string {
  return process.env.HOME ?? homedir();
}

const TEMPLATE_FILE = '_templates/default.md';

const BUNDLED_DEFAULT = `---
name: TEMPLATE_AGENT_NAME
description: One-line description shown in the registry list and used by the parent agent to decide when to delegate.
status: draft
model: sonnet
tools:
  - Read
  - Grep
  - Glob
skills: []
identity:
  responseLength: balanced
  tone: friendly
  emoji: none
  showSource: false
  feedbackButtons: false
---

You are a helpful agent. Replace this body with the agent's full system prompt.

## What you do

Describe the agent's role in 1-2 sentences. Be specific — the parent model uses this to decide when to delegate to you.

## How you behave

- Lead with the answer.
- Cite sources when you have them.
- Ask one clarifying question only when the task is genuinely ambiguous.

## What you never do

- Take destructive actions without confirmation.
- Speculate beyond your tool access.
`;

export interface TemplateLocation {
  /** Absolute path to the template file. */
  path: string;
  /** 'project' or 'global' depending on which copy resolved. */
  source: 'project' | 'global';
  /** True when the file existed; false when we just bootstrapped it. */
  preExisting: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Resolve the template path that should be used for `cwd`. */
export function getProjectTemplatePath(cwd: string): string {
  return join(cwd, '.claude', 'agents', TEMPLATE_FILE);
}

/** Resolve the user-global template path. */
export function getGlobalTemplatePath(): string {
  return join(getHome(), '.claude', 'agents', TEMPLATE_FILE);
}

/**
 * Read the scaffold template, bootstrapping if necessary.
 *
 * Resolution order:
 *   1. `<cwd>/.claude/agents/_templates/default.md` — preferred, returned as-is
 *   2. `~/.claude/agents/_templates/default.md` — fallback if project copy missing
 *   3. Bundled default — written to the project path on first call
 */
export async function readScaffoldTemplate(
  cwd: string
): Promise<{ content: string; location: TemplateLocation }> {
  const projectPath = getProjectTemplatePath(cwd);
  if (await pathExists(projectPath)) {
    const content = await readFile(projectPath, 'utf8');
    return {
      content,
      location: { path: projectPath, source: 'project', preExisting: true },
    };
  }

  const globalPath = getGlobalTemplatePath();
  if (await pathExists(globalPath)) {
    const content = await readFile(globalPath, 'utf8');
    return {
      content,
      location: { path: globalPath, source: 'global', preExisting: true },
    };
  }

  // Bootstrap: write the bundled default to the project location so the user
  // can edit it from the UI.
  await mkdir(dirname(projectPath), { recursive: true });
  await writeFile(projectPath, BUNDLED_DEFAULT, 'utf8');
  return {
    content: BUNDLED_DEFAULT,
    location: { path: projectPath, source: 'project', preExisting: false },
  };
}

/**
 * Save a new template body. Always writes to the project location — global
 * editing happens out-of-band by editing `~/.claude/agents/_templates/default.md`
 * directly, since project users may not own the global directory.
 */
export async function writeScaffoldTemplate(
  cwd: string,
  content: string
): Promise<TemplateLocation> {
  const projectPath = getProjectTemplatePath(cwd);
  await mkdir(dirname(projectPath), { recursive: true });
  await writeFile(projectPath, content, 'utf8');
  return { path: projectPath, source: 'project', preExisting: true };
}

/**
 * Render a template body as the seed for a new agent. Replaces
 * `TEMPLATE_AGENT_NAME` and an empty `description:` placeholder with the
 * supplied values. Other content passes through verbatim.
 */
export function renderScaffold(
  template: string,
  params: { name: string; description: string }
): string {
  let out = template.replace(/TEMPLATE_AGENT_NAME/g, params.name);
  // If the user left description blank in the template, replace it with the
  // user-supplied description. We match the line exactly to avoid mangling
  // multi-line description blocks.
  out = out.replace(
    /^description:\s*One-line description shown in the registry list.*$/m,
    `description: ${params.description}`
  );
  return out;
}
