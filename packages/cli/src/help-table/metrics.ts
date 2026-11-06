import type { HelpGroup } from './types';

export const metricsHelp: HelpGroup = {
  entries: [
    {
      command: 'metrics',
      spec: 'metrics [name]',
      description: 'Aggregate metric records by name, window and instrument',
      scopedFlags: [
        {
          spec: '--since <7d|24h|2w|ISO>',
          description: 'Window start: a duration before --until, or a date (default 30d)',
        },
        { spec: '--until <ISO>', description: 'Window end, exclusive (default now)' },
        { spec: '--subject <s>', description: 'Only records about this subject' },
        {
          spec: '--compare <ISO>',
          description: 'Compare records from runs started before and after this time',
        },
        {
          spec: '--by-model <node>',
          description: 'Split records by the model that ran this node (not with --compare)',
        },
        { spec: '--project <id|name|key>', description: 'Only records from this codebase' },
      ],
    },
  ],
};
