import type { FactoryWords, StageWords } from './graph-view';

/** A pack's words as tests write them: a stage needs only its label, every list may be left out. */
export function wordsOf(
  partial: Omit<Partial<FactoryWords>, 'stages'> & {
    stages?: Record<string, Partial<StageWords> & { label: string }>;
  } = {}
): FactoryWords {
  return {
    outcomes: {},
    answers: {},
    words: {},
    retired: [],
    rounds: [],
    returns: [],
    approves: [],
    change: [],
    ...partial,
    stages: Object.fromEntries(
      Object.entries(partial.stages ?? {}).map(([workflow, stage]) => [
        workflow,
        { steps: {}, ...stage },
      ])
    ),
  };
}
