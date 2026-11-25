/**
 * What a loaded source plugin declares it reads when it observes, checked once at load so
 * a malformed declaration fails the load. Split from `source-plugins.ts`.
 */
import { z } from '@hono/zod-openapi';
import {
  observedLabelsSchema,
  observedOpenedIssuesSchema,
  unservedBindingsSchema,
  type ObservedLabelRead,
  type ObservedOpenedIssueRead,
  type UnservedBinding,
  type WebhookSourcePlugin,
} from '@archon/workflows/webhook-source-plugin';

/** What is wrong with a source configuration, by field for a schema failure. */
export function configProblems(error: unknown): string {
  if (error instanceof z.ZodError)
    return error.issues
      .map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ');
  return error instanceof Error ? error.message : String(error);
}

/**
 * The label and opened-issue reads a plugin declares, and every binding it cannot observe,
 * of any kind.
 */
export function declaredReads(
  sourceInstanceId: string,
  plugin: WebhookSourcePlugin
): {
  labels: ObservedLabelRead[];
  openedIssues: ObservedOpenedIssueRead[];
  unservedBindings: UnservedBinding[];
} {
  const parse = <T>(
    what: string,
    schema: { safeParse(value: unknown): z.ZodSafeParseResult<T> },
    value: unknown
  ): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        `Webhook source '${sourceInstanceId}' declares invalid ${what}: ${configProblems(parsed.error)}`
      );
    return parsed.data;
  };
  const labels = parse('label reads', observedLabelsSchema, plugin.observedLabels ?? { reads: [] });
  const opened = parse(
    'opened-issue reads',
    observedOpenedIssuesSchema,
    plugin.observedOpenedIssues ?? { reads: [] }
  );
  const other = parse('unserved bindings', unservedBindingsSchema, plugin.unservedBindings ?? []);
  return {
    labels: labels.reads,
    openedIssues: opened.reads,
    unservedBindings: [...labels.unserved, ...opened.unserved, ...other],
  };
}
