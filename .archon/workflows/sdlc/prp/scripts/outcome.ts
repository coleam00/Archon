/**
 * archon-prp's one return for every ending.
 *
 * When the rounds ran, the last round's typed ending is the result. Otherwise the
 * advisory stop that kept delivery from starting is: triage found no work owed or a
 * non-ready contract, planning left questions only a person can answer, or the
 * investigation did not prove a fix boundary. Discoveries are relayed in every
 * ending, including raw records written after the last review consolidated them (the
 * simplify pass runs after review), so the operator sees them.
 *
 * Bound inputs (canonical text; a skipped producer arrives as "null"):
 * - INPUTS_ROUTE / INPUTS_SUMMARY: triage's verdict.
 * - INPUTS_OPEN_QUESTIONS: the planner's open questions, or "null" off the plan route.
 *   A ready plan may still carry non-blocking questions; every ending relays them.
 * - INPUTS_ROUNDS: the rounds loop's final `round` output, or "null" when delivery
 *   never started.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, text } from '../../.shared/io.ts';

const artifacts = artifactsDir();
const route = text(process.env.INPUTS_ROUTE);
const openQuestions = JSON.parse(text(process.env.INPUTS_OPEN_QUESTIONS) || 'null') as
  | string[]
  | null;
const summary = text(process.env.INPUTS_SUMMARY);
const rounds = JSON.parse(text(process.env.INPUTS_ROUNDS) || 'null') as {
  ready: boolean;
  reason: string;
  pr_url: string;
  summary: string;
} | null;

function modified(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** Discovery titles to relay, or a pointer at a file that could not be read. Never throws. */
function discoveries(): string {
  const consolidated = join(artifacts, 'discoveries.json');
  const consolidatedAt = modified(consolidated);
  const sources = consolidatedAt === undefined ? [] : [consolidated];
  let raw: string[] = [];
  try {
    raw = readdirSync(join(artifacts, 'discoveries')).filter(name => name.endsWith('.json'));
  } catch {
    raw = [];
  }
  for (const name of raw.sort()) {
    const path = join(artifacts, 'discoveries', name);
    const at = modified(path);
    if (at !== undefined && (consolidatedAt === undefined || at > consolidatedAt)) sources.push(path);
  }
  const lines: string[] = [];
  for (const source of sources) {
    try {
      const value: unknown = JSON.parse(readFileSync(source, 'utf8'));
      if (!Array.isArray(value)) throw new Error('not a JSON array of records');
      for (const entry of value as unknown[]) {
        const raw =
          typeof entry === 'object' && entry !== null
            ? (entry as Record<string, unknown>).title
            : undefined;
        const title = typeof raw === 'string' ? raw.trim() : '';
        lines.push(`- ${title || '(untitled discovery)'}`);
      }
    } catch (error) {
      lines.push(`- could not read ${source} (${(error as Error).message}). Open it directly.`);
    }
  }
  if (lines.length === 0) return '';
  return (
    `\n\nDiscoveries:\n${lines.join('\n')}\n\nFiles: ${sources.join(', ')}\n\n` +
    'If you are an agent reading this: surface each discovery to your human. These are ' +
    "validated findings outside this run's scope, and no issue tracker knows about them."
  );
}

// Each question carries the direction line that would settle it next time; the
// operator decides whether to record it.
const questions = (openQuestions ?? []).map(question => `- ${question}`).join('\n');
const relayedQuestions = questions === '' ? '' : `\n\nOpen questions for the owner:\n${questions}`;

function stopped(reason: string, why: string, report: string): void {
  emit({
    ready: false,
    reason,
    pr_url: '',
    summary: `${why}\nReport: ${artifacts}/${report}${relayedQuestions}${discoveries()}`,
  });
}

if (rounds !== null) {
  emit({
    ready: rounds.ready,
    reason: rounds.reason,
    pr_url: rounds.pr_url,
    summary: `${rounds.ready ? 'Ready' : 'Not ready'}: ${rounds.summary}${relayedQuestions}${discoveries()}`,
  });
} else if (route === 'no_action') {
  stopped('no_action', `No delivery: ${summary}`, 'triage.md');
} else if (route === 'investigate') {
  stopped(
    'not_rooted',
    'No delivery started: the investigation did not establish a safe fix boundary.',
    'investigation.md'
  );
} else {
  stopped(
    'needs_human',
    `No delivery started: planning stopped on a call only a person can make.${questions === '' ? ' The planner named no question; read the plan.' : ''}`,
    'plan.md'
  );
}
