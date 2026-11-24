import type { FactoryDiscoveries } from '../../skills/factory';

/**
 * What the drains decided, in the shape `GET /api/factory/discoveries` answers: three
 * findings from two drains, the last one covered by item 30.
 */
export const DISCOVERIES: FactoryDiscoveries = {
  pack: 'Wirasm/archon-software-factory',
  shadow: true,
  unreadable: 1,
  held: 10,
  dropped: 16,
  findings: [
    {
      title: 'A dev:console server on a seeded copy starts, resumes and dispatches nothing',
      kind: 'defect',
      verified: 'Read scripts/dev-console.ts: the copy keeps every queued start.',
      from: { key: '58', title: 'Items window read takes ~1.1 s' },
      decidedAt: '2026-11-18T07:03:47.000Z',
      runId: 'd-58',
      coveredBy: null,
    },
    {
      title: 'Factory file errors name the file once',
      kind: 'cleanup',
      verified: null,
      from: { key: '31', title: null },
      decidedAt: '2026-11-17T19:09:47.000Z',
      runId: 'd-31',
      coveredBy: null,
    },
    {
      title: 'CI runs the packages/workflows and packages/core test suites',
      kind: 'defect',
      verified: 'Read .github/workflows/ci.yml.',
      from: { key: '31', title: null },
      decidedAt: '2026-11-17T19:09:47.000Z',
      runId: 'd-31',
      coveredBy: '30',
    },
  ],
};
