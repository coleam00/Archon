/**
 * Release smoke for the compiled provider plugins, driven through the same host code
 * `archon provider install` and a run use.
 *
 *   initialize <version> <plugin binary>...   each plugin answers with its id and version
 *   claude-code <missing|installed> <binary>  a one-turn Claude query reports, or does not
 *                                            report, the resolver's "Claude Code not found"
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { inspectProviderPlugin } from '../providers/inspect-provider-plugin';
import { processProviderRegistration } from '../providers/process-registration';

const CLAUDE_CODE_NOT_FOUND = 'Claude Code not found';

async function smokeInitialize(version: string, binaries: string[]): Promise<void> {
  if (binaries.length === 0) throw new Error('No provider plugin binaries to smoke');
  for (const binary of binaries) {
    const descriptor = await inspectProviderPlugin(resolve(binary));
    if (!basename(binary).startsWith(`archon-provider-${descriptor.id}-`)) {
      throw new Error(`${binary} answered initialize as provider '${descriptor.id}'`);
    }
    if (descriptor.version !== version) {
      throw new Error(`${binary} reports version ${descriptor.version}, expected ${version}`);
    }
    console.log(`${basename(binary)}: ${descriptor.id} ${descriptor.version}`);
  }
}

/** The text a one-turn query surfaced, whether the provider threw or reported a failed result. */
async function claudeQueryOutput(binary: string): Promise<string> {
  const path = resolve(binary);
  const descriptor = await inspectProviderPlugin(path);
  if (descriptor.id !== 'claude') throw new Error(`${binary} is provider '${descriptor.id}'`);
  const provider = processProviderRegistration(descriptor, [path]).factory();
  const cwd = await mkdtemp(join(tmpdir(), 'archon-claude-smoke-'));
  const output: string[] = [];
  try {
    for await (const chunk of provider.sendQuery('Reply with OK.', cwd)) {
      output.push(JSON.stringify(chunk));
    }
  } catch (error) {
    output.push(error instanceof Error ? error.message : String(error));
  } finally {
    await removeTempTree(cwd);
  }
  return output.join('\n');
}

async function smokeClaudeCode(expectation: string, binary: string): Promise<void> {
  if (expectation !== 'missing' && expectation !== 'installed') {
    throw new Error(`Expected 'missing' or 'installed', got '${expectation}'`);
  }
  const output = await claudeQueryOutput(binary);
  console.log(output);
  const notFound = output.includes(CLAUDE_CODE_NOT_FOUND);
  if (expectation === 'missing' && !notFound) {
    throw new Error(`Claude plugin without Claude Code did not report '${CLAUDE_CODE_NOT_FOUND}'`);
  }
  if (expectation === 'installed' && notFound) {
    throw new Error('Claude plugin did not find the installed Claude Code');
  }
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'initialize' && args[0]) await smokeInitialize(args[0], args.slice(1));
  else if (mode === 'claude-code' && args.length === 2) await smokeClaudeCode(args[0], args[1]);
  else {
    throw new Error(
      'Usage: provider-plugin-smoke.ts initialize <version> <binary>... | claude-code <missing|installed> <binary>'
    );
  }
}
