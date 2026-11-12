import { resourceCapacitySchema } from '@archon/workflows/schemas/resource';
import {
  resourceStartBindingIntentSchema,
  type PreparedWorkflowLaunch,
} from '@archon/workflows/schemas/resource-start';
import {
  capturedResourceDeclaration,
  type ResourceCapacityPolicy,
} from '@archon/workflows/resource-start-store';
import type { TransactionQuery } from './resource-slots';

export async function requestDeclaredCapacity(
  query: TransactionQuery,
  row: { declared_capacity?: unknown; receipt_id?: unknown; binding_id?: unknown },
  resource: string,
  launch: PreparedWorkflowLaunch,
  policy: ResourceCapacityPolicy
): Promise<number | undefined> {
  if (row.declared_capacity != null) return resourceCapacitySchema.parse(row.declared_capacity);
  if (row.receipt_id && row.binding_id) {
    const bindings = await query<{ intent: unknown }>(
      'SELECT intent FROM remote_agent_start_receipt_bindings WHERE receipt_id = $1 AND binding_id = $2',
      [row.receipt_id, row.binding_id]
    );
    const raw = bindings.rows[0]?.intent;
    if (raw != null) {
      const intent = resourceStartBindingIntentSchema.parse(
        typeof raw === 'string' ? JSON.parse(raw) : raw
      );
      if (intent.resource === resource && intent.capacity !== undefined) return intent.capacity;
    }
  }
  return capturedResourceDeclaration(policy, launch, resource);
}
