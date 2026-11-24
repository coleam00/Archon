/**
 * A step's kind as the step page shows it: its word and its colour. Keyed by the generated kind
 * enum, so a kind the schema gains fails type-check here until it has both.
 */
import type { ToneColor } from '../document';
import { KINDS as OVERVIEW_KINDS } from '../overview/overview-kinds';
import { KINDS as DRILLDOWN_KINDS } from '../stage/drilldown-kinds';
import type { FactoryWorkflow } from '../../skills/factory';

export type FactoryStepKind = FactoryWorkflow['steps'][number]['kind'];

export const KIND_WORDS: Record<FactoryStepKind, string> = {
  agent: 'Agent',
  bash: 'Shell command',
  script: 'Script',
  loop: 'Loop',
  approval: 'Approval',
  wait: 'Wait',
  other: 'Other',
};

/**
 * Each kind's colour. An agent and a script take the stage drill-down's colours for the same
 * kinds, and an approval How it works' colour for a person, so a step reads in the colour its
 * stage's cards give it; the rest are node tokens of their own. None is purple or pink (owner
 * change 1 of 2026-11-19; `stage/drilldown-kinds.test.ts`).
 */
export const KIND_TONES: Record<FactoryStepKind, ToneColor> = {
  agent: DRILLDOWN_KINDS.agent.color,
  bash: DRILLDOWN_KINDS.script.color,
  script: DRILLDOWN_KINDS.script.color,
  loop: 'var(--node-loop)',
  approval: OVERVIEW_KINDS.person.color,
  wait: 'var(--node-command)',
  other: 'var(--node-opaque)',
};
