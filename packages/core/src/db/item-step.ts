/**
 * The one place the stores read whether stored work is a step of its item. A run of a workflow
 * that declares `observes: true` records so when it is created (`observes_item`,
 * `observesItemMetadata`); it acts on the item without being one of its steps, so the stop,
 * end and refusal rules read past it. A start that has no run yet carries the same record in
 * the run its prepared launch will create.
 */
import {
  OBSERVES_ITEM_METADATA_KEY,
  observesItemRecorded,
} from '@archon/workflows/schemas/run-metadata';
import { getDialect } from './connection';

/** SQL true when run `alias` is a step of its item, not a run that observes it. */
export function stepRun(alias: string): string {
  return `${getDialect().jsonText(`${alias}.metadata`, OBSERVES_ITEM_METADATA_KEY)} IS NULL`;
}

/**
 * Whether a prepared launch, as a start request stores it, will run a step: the run it creates
 * does not record `observes_item`. The launch is stored as text, so it is read here rather than
 * in SQL. A launch that does not read counts as a step, as every start did before.
 */
export function launchRunsStep(launch: unknown): boolean {
  try {
    const parsed: unknown = typeof launch === 'string' ? JSON.parse(launch) : launch;
    const run = (parsed as { run?: { metadata?: unknown } } | null)?.run;
    return !observesItemRecorded(run?.metadata);
  } catch {
    return true;
  }
}
