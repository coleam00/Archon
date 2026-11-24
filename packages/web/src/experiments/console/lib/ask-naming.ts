/**
 * How an ask card names what it is about: the item (linked to its factory page when a view
 * applies, else to the run) and the stage or workflow it came from.
 */
import type { AskSubject } from '../components/ask-card/AskCard';
import { stageOfWorkflow } from '../factory/lib/placement';
import { TONES, type Tone } from '../factory/tones';
import { membershipOf, type MemberSource } from '../factory/lib/work-orders';
import { answerStarts } from '../factory/lib/answer-starts';
import { factoryPath, type FactoryViewListed } from '../factory/lib/views';
import { shortWorkflow } from './ask-card';
import { askRunId, askWorkflow, type NeedsYouItem } from './needs-you';

export interface AskNaming {
  subject: (ask: NeedsYouItem) => AskSubject;
  where: (ask: NeedsYouItem) => string | undefined;
  /** The group of the stage the ask came from, its colour and icon; undefined without a view or a stage. */
  tone: (ask: NeedsYouItem) => Tone | undefined;
  /** What choosing `optionId` on the ask starts, in the view's words (`answers`); undefined without a view or a sentence. */
  starts: AskStarts;
}

export type AskStarts = (ask: NeedsYouItem, optionId: string) => string | undefined;

/**
 * The naming for one project. `view` is its factory view, when one applies; `names` what its
 * items read says of each item, by key.
 */
export function askNaming(
  projectId: string,
  view: Pick<FactoryViewListed, 'declaration'> | undefined,
  names: ReadonlyMap<string, ItemName> = new Map()
): AskNaming {
  const runHref = (ask: NeedsYouItem): string | undefined => {
    const runId = askRunId(ask);
    return runId === undefined ? undefined : `/console/p/${projectId}/r/${runId}`;
  };
  return {
    subject: ask => {
      const href = runHref(ask);
      // A wait no item holds is on a run: named as that run, so the workflow (`where`) is
      // named once, and a run never reads as an item.
      if (ask.item === undefined) {
        const runId = askRunId(ask);
        return {
          key: runId === undefined ? 'A run' : `Run ${runId.slice(0, 8)}`,
          partOf: null,
          ...(href === undefined ? {} : { href }),
        };
      }
      const key = ask.item.key;
      const name = names.get(key);
      const title = name?.title ?? undefined;
      const itemHref =
        view === undefined ? href : factoryPath(projectId, `/items/${encodeURIComponent(key)}`);
      return {
        key,
        partOf: name?.partOf ?? null,
        ...(title === undefined || title === key ? {} : { title }),
        ...(itemHref === undefined ? {} : { href: itemHref }),
      };
    },
    where: ask => {
      const workflow = askWorkflow(ask);
      if (workflow === undefined) return undefined;
      const name = shortWorkflow(workflow);
      if (view === undefined) return name;
      return stageOfWorkflow(view.declaration, name, null)?.label ?? name;
    },
    tone: ask => {
      const workflow = askWorkflow(ask);
      if (view === undefined || workflow === undefined) return undefined;
      const stage = stageOfWorkflow(view.declaration, shortWorkflow(workflow), null);
      return stage === undefined ? undefined : TONES[stage.group];
    },
    starts: (ask, optionId) => answerStarts(view?.declaration, askWorkflow(ask), optionId),
  };
}

/** What an ask names an item by: the title the board's progress gives it, and its work order. */
export interface ItemName {
  title: string | null;
  partOf: string | null;
}

/**
 * What the items read says of each item, by key, for `askNaming`. The engine's item read
 * carries the links, so an item's work order is known without a view; the title needs one.
 */
export function itemNames(items: readonly MemberSource[] | undefined): Map<string, ItemName> {
  return new Map(
    (items ?? []).map(item => [
      item.item.key,
      { title: item.progress?.title ?? null, partOf: membershipOf(item)?.order ?? null },
    ])
  );
}
