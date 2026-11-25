/**
 * The one place the SQL knows which runs are steps of their item. A run of a workflow that
 * declares `observes: true` is recorded so when it is created (`observes_item`); it acts on
 * the item without being one of its steps, so the stop and end rules read past it.
 */
import { OBSERVES_ITEM_METADATA_KEY } from '@archon/workflows/schemas/run-metadata';
import { getDialect } from './connection';

/** SQL true when run `alias` is a step of its item, not a run that observes it. */
export function stepRun(alias: string): string {
  return `${getDialect().jsonText(`${alias}.metadata`, OBSERVES_ITEM_METADATA_KEY)} IS NULL`;
}
