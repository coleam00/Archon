import { z } from '@hono/zod-openapi';
import { metricsReportSchema as engineMetricsReportSchema } from '@archon/workflows/schemas/metric';

/** The engine's report schema, served as is so the API cannot drift from `queryMetrics`. */
export const metricsReportSchema = engineMetricsReportSchema.meta({ id: 'MetricsReport' });

/** GET /api/metrics query. Window values share the CLI's syntax (`resolveMetricsWindow`). */
export const metricsQuerySchema = z.object({
  since: z.string().optional().openapi({
    description:
      'Window start: a duration before `until` (`24h`, `7d`, `2w`) or an ISO date or time. Defaults to 30 days.',
  }),
  until: z
    .string()
    .optional()
    .openapi({ description: 'Exclusive window end: an ISO date or time. Defaults to now.' }),
  name: z.string().optional().openapi({ description: 'Only this metric name.' }),
  subject: z.string().optional().openapi({ description: 'Only records about this subject.' }),
  codebaseId: z.string().optional().openapi({ description: 'Only records from this codebase.' }),
  compare: z.string().optional().openapi({
    description:
      'An ISO date or time. Each group also reports records whose producing runs started before it against those started at or after it.',
  }),
  byModel: z.string().optional().openapi({
    description:
      'A node id. Each group also reports its records split by the model label that ran this node in their producing runs and the runs below them. Not combined with `compare`; a node no producing run ran is a 400 listing the AI nodes they ran.',
  }),
});
