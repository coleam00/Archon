import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from '@hono/zod-openapi';
import {
  createForgeInputBindingSchema,
  createForgeBindingSchema,
  forgeEventSelectorSchema,
  mapForgeInputs,
  matchForgeEvent,
  normalizeGitHubWebhook,
} from '@archon/forge';
import { acceptStartReceipt } from '@archon/core/db/resource-starts';
import { getUserById } from '@archon/core/db/users';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import {
  resourceStartBindingIntentSchema,
  type ResourceStartBindingIntent,
  type SourceReceiptInput,
} from '@archon/workflows/schemas/resource-start';
import type { GitHubTriggerIngress, VerifiedGitHubDelivery } from './adapter';

const bindingSchema = resourceStartBindingIntentSchema.omit({ bindingRevision: true }).extend({
  selector: forgeEventSelectorSchema,
  inputMapping: z.record(z.string(), createForgeInputBindingSchema(jsonValueSchema)),
});

export const githubTriggerConfigSchema = z
  .object({
    version: z.literal(1),
    sourceInstanceId: z.string().min(1),
    host: z.literal('github.com'),
    bindings: z.array(bindingSchema),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    const mappingSchema = createForgeBindingSchema(jsonValueSchema);
    for (const [index, binding] of config.bindings.entries()) {
      if (seen.has(binding.bindingId))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'bindingId'],
          message: 'Duplicate binding ID',
        });
      seen.add(binding.bindingId);
      const mapping = mappingSchema.safeParse({
        selector: binding.selector,
        inputs: binding.inputMapping,
      });
      if (!mapping.success)
        for (const issue of mapping.error.issues)
          context.addIssue({
            code: 'custom',
            path: ['bindings', index, ...issue.path],
            message: issue.message,
          });
      if (!isAbsolute(binding.launch.cwd))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'launch', 'cwd'],
          message: 'Expected an absolute execution path',
        });
    }
  });
export type GitHubTriggerConfig = z.infer<typeof githubTriggerConfigSchema>;

type Intake = typeof acceptStartReceipt;
interface Evaluation {
  bindingId: string;
  bindingRevision: string;
  status: 'unmatched' | 'rejected';
  reason: string;
}

/** Local deployment configuration is the authority to select the execution user. */
export async function loadGitHubTriggerIngress(path: string): Promise<GitHubTriggerIngress> {
  const parsed = githubTriggerConfigSchema.safeParse(
    JSON.parse(await readFile(path, 'utf8')) as unknown
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid GitHub trigger configuration fields: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`
    );
  }
  for (const binding of parsed.data.bindings) {
    if (!(await getUserById(binding.runAsUserId))) {
      throw new Error(`Trigger binding '${binding.bindingId}' names an unknown run-as user.`);
    }
  }
  return createGitHubTriggerIngress(parsed.data, acceptStartReceipt);
}

export function createGitHubTriggerIngress(
  config: GitHubTriggerConfig,
  intake: Intake
): GitHubTriggerIngress {
  return {
    async receive(delivery: VerifiedGitHubDelivery): Promise<void> {
      const receipt: SourceReceiptInput = {
        id: randomUUID(),
        sourceInstanceId: config.sourceInstanceId,
        deliveryId: delivery.deliveryId,
        contentDigest: delivery.contentDigest,
        receivedAt: delivery.receivedAt,
        occurredAt: null,
        sourceActor: null,
      };
      if (!delivery.decoded) {
        await intake({ receipt, outcome: 'malformed', reason: 'invalid_json', bindings: [] });
        return;
      }
      const normalized = normalizeGitHubWebhook(delivery.payload, {
        sourceInstanceId: config.sourceInstanceId,
        deliveryId: delivery.deliveryId,
        contentDigest: delivery.contentDigest,
        receivedAt: delivery.receivedAt,
        host: config.host,
        eventName: delivery.eventName ?? '',
      });
      if (normalized.status !== 'normalized') {
        await intake({
          receipt,
          outcome: normalized.status,
          reason: normalized.reason,
          bindings: [],
        });
        return;
      }
      receipt.occurredAt = normalized.envelope.occurredAt;
      if (normalized.envelope.sourceActor) {
        receipt.sourceActor = {
          source: config.sourceInstanceId,
          id: normalized.envelope.sourceActor.id,
        };
      }
      const bindings: ResourceStartBindingIntent[] = [];
      const evaluatedBindings: Evaluation[] = [];
      for (const binding of config.bindings) {
        const bindingRevision = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
        if (!matchForgeEvent(binding.selector, normalized.envelope.event)) {
          evaluatedBindings.push({
            bindingId: binding.bindingId,
            bindingRevision,
            status: 'unmatched',
            reason: 'selector_did_not_match',
          });
          continue;
        }
        const mapped = mapForgeInputs(binding.inputMapping, normalized.envelope.event);
        if (!mapped.ok) {
          evaluatedBindings.push({
            bindingId: binding.bindingId,
            bindingRevision,
            status: 'rejected',
            reason: `Input '${mapped.input}': ${mapped.reason}`,
          });
          continue;
        }
        bindings.push(
          resourceStartBindingIntentSchema.parse({
            bindingId: binding.bindingId,
            bindingRevision,
            hostId: binding.hostId,
            runAsUserId: binding.runAsUserId,
            resource: binding.resource,
            overlap: binding.overlap,
            launch: { ...binding.launch, inputs: { ...binding.launch.inputs, ...mapped.inputs } },
          })
        );
      }
      await intake({
        receipt,
        outcome: bindings.length ? 'matched' : 'unmatched',
        bindings,
        evaluatedBindings,
      });
    },
  };
}
