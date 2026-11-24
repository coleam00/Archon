import type { FactoryDrilldown } from '../drilldown-live';

/**
 * A synthetic Checks drill-down over a `deliver`-shaped workflow, as the project's view file
 * declared it on 2026-11-17 before the pack retired `deliver`: four phases, the first three
 * repeated by the `rounds` loop. It is kept for the loop frame and live-glow tests, which the
 * current view file (no loop) cannot exercise.
 */
export const checksDrilldown: FactoryDrilldown = {
  phases: [
    {
      label: 'Prepare',
      cards: [
        {
          title: 'Read the base',
          text: 'Reads the commit the change is checked against',
          icon: 'git-branch',
          kind: 'script',
          covers: [{ workflow: 'deliver', steps: ['rounds.base'] }],
        },
      ],
    },
    {
      label: 'Check',
      cards: [
        {
          title: 'Code review',
          text: "Reads the change for bugs and the project's rules",
          icon: 'search-code',
          kind: 'check',
          covers: [{ workflow: 'deliver', steps: ['rounds.review__review'] }],
        },
        {
          title: 'Test check',
          text: 'Runs and reads the tests the change needs',
          icon: 'flask-conical',
          kind: 'check',
          covers: [{ workflow: 'deliver', steps: ['rounds.tests__tests'] }],
        },
        {
          title: 'Product check',
          text: 'Checks the change does what the item asked',
          icon: 'monitor-check',
          kind: 'check',
          covers: [{ workflow: 'deliver', steps: ['rounds.product__product'] }],
        },
      ],
    },
    {
      label: 'Verdict',
      cards: [
        {
          title: 'Verdict',
          text: 'Approves the change or sends it back',
          icon: 'gavel',
          kind: 'check',
          covers: [{ workflow: 'deliver', steps: ['rounds.verdict__verdict'] }],
        },
        {
          title: 'Post the review',
          text: "Posts the checks' findings on the pull request",
          icon: 'message-square',
          kind: 'script',
          covers: [{ workflow: 'deliver', steps: ['rounds.shown'] }],
        },
      ],
    },
    {
      label: 'Out of rounds',
      cards: [
        {
          title: 'Rounds ran out',
          text: 'Says what is still wrong when every round is used',
          icon: 'circle-alert',
          kind: 'agent',
          covers: [{ workflow: 'deliver', steps: ['exhausted'] }],
        },
      ],
    },
  ],
  loop: { label: 'Up to 3 rounds', from: 1, to: 3, workflow: 'deliver', step: 'rounds' },
};
