import { z } from 'zod';
import type { Socket } from 'node:net';
import type { ProcessGroupStop } from '@archon/paths/plugin-process';
import { TERMINATION_CONFIRM_MS, TERMINATION_GRACE_MS } from './run-stop-bounds';

export interface RunOwnerPreparedStop {
  groups: ProcessGroupStop[];
  warnings: string[];
}

export interface RunOwnerTerminationPreparation {
  groups: ProcessGroupStop[];
  ready: Promise<string[]>;
  release(): void;
}

export type PrepareRunOwnerTermination = () => RunOwnerTerminationPreparation;

export const TERMINATE_READY = 'ready\n';
export const PREPARATION_HEADER = 'preparing\n';
export const PREPARATION_TIMEOUT_MS = TERMINATION_GRACE_MS + TERMINATION_CONFIRM_MS;

export async function writeOwnerPreparation(
  socket: Socket,
  preparation: RunOwnerTerminationPreparation
): Promise<void> {
  socket.write(PREPARATION_HEADER);
  for (const group of preparation.groups) socket.write(`${JSON.stringify({ group })}\n`);
  for (const warning of await preparation.ready) {
    socket.write(`${JSON.stringify({ warning })}\n`);
  }
  socket.write(TERMINATE_READY);
}

export const processGroupStopSchema = z.discriminatedUnion('leaderReaped', [
  z.strictObject({
    pgid: z.number().int().positive(),
    leaderReaped: z.literal(true),
  }),
  z.strictObject({
    pgid: z.number().int().positive(),
    leaderReaped: z.literal(false),
    signalError: z.string().optional(),
  }),
]);
const preparationFrame = z.union([
  z.strictObject({ warning: z.string() }),
  z.strictObject({ group: processGroupStopSchema }),
]);

export function readPreparationFrame(frame: string, report: RunOwnerPreparedStop): void {
  const value = preparationFrame.parse(JSON.parse(frame));
  if ('warning' in value) report.warnings.push(value.warning);
  else report.groups.push(value.group);
}
