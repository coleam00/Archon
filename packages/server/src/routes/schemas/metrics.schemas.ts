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
});
