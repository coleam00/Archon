import {
  slotMembershipSchema,
  hasReadableSlotMembership,
  slotSchema,
  requestSchema,
  queuedRequestSchema,
  requestEnvelopeSchema,
  receiptSchema,
  pathFor,
  type Request,
  type Slot,
  type Receipt,
  type Binding,
} from './admission-documents';
import { holdsWorkflowPath } from '../workflow-path-lock';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { createLogger } from '@archon/paths/logger';
import { isOwnerProvablyGone } from '@archon/paths/process-owner';
import { isTerminalRunStatus, type WorkflowRun } from '../schemas/workflow-run';
import {
  preparedWorkflowLaunchSchema,
  type ResourceStartIntent,
  type ResourceStartDisposition,
} from '../schemas/resource-start';
import {
  ResourceSlotCapacityConflictError,
  capacityWaiters,
  heldCheckouts,
  type ReusableCheckout,
  resourceResumeBlocker,
  resourceStartBlocker,
  type QueuedStart,
  type ResourceBlocker,
  type ResourceSlotOccupancy,
  compareCodeUnits,
} from '../resource-start-store';
import { WorkflowNotResumableError } from '../store';
import { isRunArchived, listRunSnapshots, readJson, readSnapshot } from './commit';
import { createTransactionView } from './transaction-view';

const log = createLogger('file-store.admission');

export async function documentPaths(root: string, kind: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, 'resource', kind));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(name => name.endsWith('.json')).map(name => `resource/${kind}/${name}`);
}

export function disposition(row: Request): ResourceStartDisposition {
  if (row.status === 'admitted') return { status: 'admitted', requestId: row.id, runId: row.id };
  if ((row.status === 'queued' || row.status === 'skipped') && row.blocker)
    return { status: row.status, requestId: row.id, blocker: row.blocker };
  throw new Error(`Resource start request '${row.id}' has no executable disposition`);
}

interface BindingIdentity {
  receiptId: string;
  bindingId: string;
}
type PreparationOwner = BindingIdentity & { ownerId: string };
export interface AdmissionTransaction {
  documents: Record<string, unknown>;
  changedDocuments(): Promise<Record<string, unknown>>;
  read<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S> | null>;
  request(id: string): Promise<Request | null>;
  receipt(id: string): Promise<Receipt | null>;
  slot(resource: string, capacity?: number): Promise<Slot>;
  occupancy(resource: string, launch?: Request['launch']): Promise<ResourceSlotOccupancy>;
  admit(
    intent: ResourceStartIntent,
    runs: Map<string, WorkflowRun>
  ): Promise<ResourceStartDisposition>;
  admitExisting(row: Request, runs: Map<string, WorkflowRun>): Promise<ResourceStartDisposition>;
  binding(input: BindingIdentity): Promise<Binding | undefined>;
  owned(input: PreparationOwner): Promise<Binding | undefined>;
  canClaim(id: string): Promise<boolean>;
  /** Take a slot for an admitted failed or paused run's resume, or say what blocks it. */
  resume(run: WorkflowRun): Promise<ResourceBlocker | null>;
  /** Remove the run holder of an admitted run; whether one was removed. */
  release(id: string): Promise<boolean>;
}

export function createAdmissionTransaction(
  root: string,
  listReusableCheckouts: () => Promise<readonly ReusableCheckout[]> = async () => []
): AdmissionTransaction {
  const documents: Record<string, unknown> = {};
  const slots = new Map<string, Slot>();
  const receipts = new Map<string, z.infer<typeof receiptSchema>>();
  async function read<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S> | null> {
    const raw = path in documents ? documents[path] : await readJson(join(root, path));
    return raw === undefined ? null : schema.parse(raw);
  }
  const request = (id: string): Promise<Request | null> =>
    read(pathFor('requests', id), requestSchema);
  async function receipt(id: string): Promise<Receipt | null> {
    const row = receipts.get(id) ?? (await read(pathFor('receipts', id), receiptSchema));
    if (row) receipts.set(id, row);
    return row;
  }
  async function slot(resource: string, capacity?: number): Promise<Slot> {
    const path = pathFor('slots', resource);
    const schema = slotSchema(join(root, path));
    const row =
      slots.get(resource) ??
      (await read(path, schema)) ??
      schema.parse({ capacity: capacity ?? 1, holders: [], queue: [] });
    if (capacity !== undefined && row.capacity !== capacity)
      throw new ResourceSlotCapacityConflictError(resource, row.capacity, capacity);
    documents[path] = row;
    slots.set(resource, row);
    return row;
  }
  async function live(resource: string): Promise<Slot> {
    const row = await slot(resource);
    const holders: typeof row.holders = [];
    for (const holder of row.holders) {
      if (holder.kind === 'attempt') {
        if (!isOwnerProvablyGone(holder.owner)) holders.push(holder);
      } else {
        const run = await readSnapshot(root, holder.id);
        if (run && !isTerminalRunStatus(run.status)) holders.push(holder);
      }
    }
    row.holders = holders;
    return row;
  }
  async function hasSlotMembership(
    id: string,
    resource?: string,
    associationKnown = false
  ): Promise<boolean> {
    for (const path of await documentPaths(root, 'slots')) {
      if (resource !== undefined && path === pathFor('slots', resource)) continue;
      let raw: unknown;
      try {
        raw = path in documents ? documents[path] : await readJson(join(root, path));
        const row = slotMembershipSchema.optional().parse(raw);
        if (hasReadableSlotMembership(row, id)) return true;
      } catch (error) {
        const damagedDocument = error instanceof SyntaxError || error instanceof z.ZodError;
        // A damaged component cannot erase contradictory membership in the other component.
        if (associationKnown && damagedDocument && !hasReadableSlotMembership(raw, id)) continue;
        throw new Error(`Invalid resource slot membership '${path}'`, { cause: error });
      }
    }
    return false;
  }
  async function occupancyRun(
    run: WorkflowRun,
    resource: string,
    local: boolean,
    checkouts: ReadonlyMap<string, string>,
    reusable: readonly ReusableCheckout[]
  ) {
    try {
      const path = pathFor('requests', run.id);
      const raw = path in documents ? documents[path] : await readJson(join(root, path));
      if (local)
        return {
          kind: 'local' as const,
          run: {
            ...run,
            launch: requestSchema
              .extend({ resource: z.literal(resource), status: z.literal('admitted') })
              .parse(raw).launch,
          },
        };
      return await nonlocalOccupancyRun(run, resource, raw, checkouts, reusable);
    } catch (error) {
      if (local || !(error instanceof z.ZodError || error instanceof SyntaxError)) throw error;
      return corruptForeignOccupancy(run, await hasSlotMembership(run.id, resource), error);
    }
  }
  function independentCheckout(
    run: WorkflowRun,
    resource: string,
    raw: unknown,
    envelope: z.infer<typeof requestEnvelopeSchema> | null,
    checkouts: ReadonlyMap<string, string>,
    reusable: readonly ReusableCheckout[]
  ): boolean {
    if (!envelope && run.working_path) {
      const held = heldCheckouts([run], reusable);
      if (![...held.keys()].some(key => checkouts.has(key))) return true;
    }
    if (envelope && (envelope.resource !== resource || capacityWaiters([run]).length === 0)) {
      const row = requestSchema.safeParse(raw);
      if (row.success && row.data.id === run.id && row.data.launch.run.id === run.id) {
        const held = heldCheckouts([{ ...run, launch: row.data.launch }], reusable);
        if (held.size > 0 && ![...held.keys()].some(key => checkouts.has(key))) return true;
      }
    }
    return false;
  }
  async function nonlocalOccupancyRun(
    run: WorkflowRun,
    resource: string,
    raw: unknown,
    checkouts: ReadonlyMap<string, string>,
    reusable: readonly ReusableCheckout[]
  ) {
    const envelope = raw === undefined ? null : requestEnvelopeSchema.parse(raw);
    if (independentCheckout(run, resource, raw, envelope, checkouts, reusable)) return null;
    const knownForeign = await hasSlotMembership(run.id, resource);
    if (!knownForeign && envelope?.resource === resource && capacityWaiters([run]).length > 0) {
      const row = requestSchema
        .refine(row => row.id === run.id && row.launch.run.id === run.id, {
          message: `Admitted resource request '${run.id}' does not identify the waiting run`,
        })
        .parse(raw);
      return { kind: 'local' as const, run: { ...run, launch: row.launch } };
    }
    // Without a capacity refusal, old released slots have no independent membership.
    // A readable envelope alone cannot establish capacity membership.
    if (!knownForeign && envelope)
      return {
        kind: 'unknown' as const,
        run: { ...run, launch: preparedWorkflowLaunchSchema.parse(envelope.launch) },
      };
    if (!holdsWorkflowPath(run)) return null;
    const launch = envelope ? preparedWorkflowLaunchSchema.parse(envelope.launch) : undefined;
    return {
      kind: 'foreign' as const,
      run: { ...run, launch },
      unknown: knownForeign && !launch && !run.working_path,
    };
  }
  function corruptForeignOccupancy(
    run: WorkflowRun,
    knownForeign: boolean,
    error: z.ZodError | SyntaxError
  ) {
    if (!holdsWorkflowPath(run)) return null;
    // A released paused run may still be local. Only proven foreign membership
    // permits the corruption fallback, which allows read-only concurrency.
    if (!knownForeign) throw error;
    // Corrupt foreign requests still hold their recorded path and registered aliases.
    // Without a path, guarded starts must wait for the holder to end.
    log.error(
      { runId: run.id },
      run.working_path
        ? 'foreign_request_invalid_using_working_path'
        : 'foreign_request_invalid_checkout_unknown'
    );
    return { kind: 'foreign' as const, run, unknown: !run.working_path };
  }

  async function queuedStarts(resource: string, ids: string[]) {
    const queue: QueuedStart[] = [];
    for (const id of ids) {
      try {
        queue.push(queuedRequestSchema(id, pathFor('slots', resource)).parse(await request(id)));
      } catch (error) {
        if (!(error instanceof z.ZodError || error instanceof SyntaxError)) throw error;
        const queueError = new Error(`Queued resource request '${id}' is invalid`, {
          cause: error,
        });
        log.error({ requestId: id, err: queueError }, 'queued_request_invalid_drain_prefix_only');
        return { queue, queueError };
      }
    }
    return { queue };
  }
  // Paused runs, and so waiters, live only on run rows: finding them scans every run, as
  // the due scan does.
  async function occupancy(
    resource: string,
    launch?: Request['launch']
  ): Promise<ResourceSlotOccupancy> {
    const row = await live(resource);
    const queued = await queuedStarts(resource, row.queue);
    const { queue } = queued;
    const reusable = await listReusableCheckouts();
    const checkouts = heldCheckouts(
      launch ? [...queue, { id: launch.run.id, launch }] : queue,
      reusable
    );
    const admittedRuns: (WorkflowRun & { launch: Request['launch'] })[] = [];
    const foreign: (WorkflowRun & { launch?: Request['launch'] })[] = [];
    const possiblyLocal: (WorkflowRun & { launch: Request['launch'] })[] = [];
    const runs = (await listRunSnapshots(root)).sort(
      (a, b) => a.started_at.getTime() - b.started_at.getTime() || compareCodeUnits(a.id, b.id)
    );
    let unknownForeignCheckoutHolder: string | undefined;
    for (const run of runs) {
      if (isTerminalRunStatus(run.status)) continue;
      const holder = await occupancyRun(
        run,
        resource,
        row.admitted.includes(run.id) ||
          row.holders.some(holder => holder.kind === 'run' && holder.id === run.id),
        checkouts,
        reusable
      );
      if (holder?.kind === 'local') {
        admittedRuns.push(holder.run);
        possiblyLocal.push(holder.run);
      } else if (holder?.kind === 'unknown') possiblyLocal.push(holder.run);
      else if (holder) {
        foreign.push(holder.run);
        if (holder.unknown) unknownForeignCheckoutHolder ??= run.id;
      }
    }
    return {
      capacity: row.capacity,
      reusableCheckouts: reusable,
      holders: row.holders,
      waiters: capacityWaiters(
        admittedRuns.filter(run => !row.holders.some(h => h.kind === 'run' && h.id === run.id))
      ),
      ...queued,
      heldCheckouts: heldCheckouts(possiblyLocal, reusable),
      foreignHeldCheckouts: heldCheckouts(foreign, reusable),
      unknownForeignCheckoutHolder,
    };
  }
  async function admitExisting(
    row: Request,
    runs: Map<string, WorkflowRun>
  ): Promise<ResourceStartDisposition> {
    // A deleted run's ID stays reserved, as in createWorkflowRun.
    if (
      runs.has(row.id) ||
      (await readSnapshot(root, row.id)) ||
      (await isRunArchived(root, row.id))
    )
      throw new Error(`Run already exists: ${row.id}`);
    await createTransactionView(runs, [], async () => null, new Map()).createWorkflowRun(
      row.launch.run
    );
    row.status = 'admitted';
    row.blocker = null;
    const resource = await slot(row.resource);
    resource.queue = resource.queue.filter(id => id !== row.id);
    resource.holders.push({ kind: 'run', id: row.id });
    if (!resource.admitted.includes(row.id)) resource.admitted.push(row.id);
    documents[pathFor('requests', row.id)] = row;
    return disposition(row);
  }
  async function admit(
    intent: ResourceStartIntent,
    runs: Map<string, WorkflowRun>
  ): Promise<ResourceStartDisposition> {
    const resource = await slot(intent.resource, intent.capacity);
    const previous = await request(intent.launch.run.id);
    if (previous) return disposition(previous);
    const launch = preparedWorkflowLaunchSchema.parse(intent.launch);
    const blocker = resourceStartBlocker(await occupancy(intent.resource, launch), launch);
    const head = z.object({ seq: z.number() }).parse(await readJson(join(root, 'head.json')));
    const row: Request = {
      id: intent.launch.run.id,
      resource: intent.resource,
      hostId: intent.hostId,
      overlap: intent.overlap,
      status: blocker && intent.overlap === 'skip' ? 'skipped' : 'queued',
      blocker,
      launch,
      position: head.seq + 1,
    };
    documents[pathFor('requests', row.id)] = row;
    if (intent.receipt) {
      const item = await binding(intent.receipt);
      if (!item) throw new Error('Resource start receipt binding missing');
      item.requestIds.push(row.id);
    }
    if (!blocker) return admitExisting(row, runs);
    if (row.status === 'queued') resource.queue.push(row.id);
    return disposition(row);
  }
  async function binding(input: BindingIdentity): Promise<Binding | undefined> {
    const row = await receipt(input.receiptId);
    const item = row?.bindings.find(item => item.bindingId === input.bindingId);
    if (row && item) documents[pathFor('receipts', row.id)] = row;
    return item;
  }
  async function owned(input: PreparationOwner): Promise<Binding | undefined> {
    const item = await binding(input);
    return item?.status === 'preparing' && item.ownerId === input.ownerId ? item : undefined;
  }
  async function canClaim(id: string): Promise<boolean> {
    const row = await request(id);
    if (!row) return true;
    return (
      row.status === 'admitted' &&
      (await slot(row.resource)).holders.some(h => h.kind === 'run' && h.id === id)
    );
  }
  async function resume(run: WorkflowRun): Promise<ResourceBlocker | null> {
    const row = await request(run.id);
    if (row?.status !== 'admitted') {
      if (await hasSlotMembership(run.id))
        throw new Error(`Run '${run.id}' has slot membership but no matching admitted request`);
      return null;
    }
    if (row.id !== run.id || row.launch.run.id !== run.id)
      throw new Error(`Admitted resource request '${run.id}' does not identify the resumed run`);
    const resource = await slot(row.resource);
    if (await hasSlotMembership(run.id, row.resource, true))
      throw new Error(`Admitted resource request '${run.id}' disagrees with its slot membership`);
    if (run.status !== 'failed' && run.status !== 'paused')
      throw new WorkflowNotResumableError(run.id, run.status);
    if (!resource.admitted.includes(run.id)) resource.admitted.push(run.id);
    const blocker = resourceResumeBlocker(await occupancy(row.resource, row.launch), {
      ...run,
      status: run.status,
    });
    if (blocker) return blocker;
    if (!resource.holders.some(h => h.kind === 'run' && h.id === run.id))
      resource.holders.push({ kind: 'run', id: run.id });
    return null;
  }
  async function release(id: string): Promise<boolean> {
    const row = await request(id);
    if (row?.status !== 'admitted') return false;
    const resource = await slot(row.resource);
    const holders = resource.holders.filter(h => h.kind !== 'run' || h.id !== id);
    if (holders.length === resource.holders.length) return false;
    if (!resource.admitted.includes(id)) resource.admitted.push(id);
    resource.holders = holders;
    return true;
  }
  async function changedDocuments(): Promise<Record<string, unknown>> {
    const changed: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(documents)) {
      if (!isDeepStrictEqual(await readJson(join(root, path)), JSON.parse(JSON.stringify(value))))
        changed[path] = value;
    }
    return changed;
  }
  return {
    documents,
    changedDocuments,
    read,
    request,
    receipt,
    slot,
    occupancy,
    admit,
    admitExisting,
    binding,
    owned,
    canClaim,
    resume,
    release,
  };
}
