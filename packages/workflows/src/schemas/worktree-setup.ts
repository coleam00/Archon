import { z } from 'zod';

export const WORKTREE_SETUP_EVENT_TYPES = [
  'worktree_setup_started',
  'worktree_setup_completed',
  'worktree_setup_failed',
] as const;

export const worktreeSetupFailureKindSchema = z.enum(['exit', 'timeout', 'spawn', 'output_limit']);
export type WorktreeSetupFailureKind = z.infer<typeof worktreeSetupFailureKindSchema>;

const identity = z.object({
  attemptId: z.string().uuid(),
  commandIndex: z.number().int().nonnegative(),
  command: z.string(),
  workingPath: z.string(),
  message: z.string(),
  parentNodeId: z.string().optional(),
  childIndex: z.number().int().nonnegative().optional(),
});
const result = {
  durationMs: z.number().nonnegative(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
};

export const worktreeSetupEventSchema = z.discriminatedUnion('type', [
  identity.extend({ type: z.literal(WORKTREE_SETUP_EVENT_TYPES[0]) }),
  identity.extend({ type: z.literal(WORKTREE_SETUP_EVENT_TYPES[1]), ...result }),
  identity.extend({
    type: z.literal(WORKTREE_SETUP_EVENT_TYPES[2]),
    ...result,
    failureKind: worktreeSetupFailureKindSchema,
    exitCode: z.number().int().optional(),
    errno: z.string().optional(),
    signal: z.string().optional(),
  }),
]);
export type WorktreeSetupEvent = z.infer<typeof worktreeSetupEventSchema>;

export function isWorktreeSetupEventType(type: string): type is WorktreeSetupEvent['type'] {
  return WORKTREE_SETUP_EVENT_TYPES.some(eventType => eventType === type);
}
