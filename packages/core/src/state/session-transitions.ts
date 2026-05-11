/**
 * Session transition triggers - the single source of truth for what causes session changes.
 *
 * Adding a new trigger:
 * 1. Add to this type
 * 2. Add to TRIGGER_BEHAVIOR with appropriate category
 * 3. Update detectPlanToExecuteTransition() if it can be auto-detected
 * 4. Update getTriggerForCommand() if it maps to a command
 */
export type TransitionTrigger =
  | 'first-message' // No existing session
  | 'plan-to-execute' // Plan phase completed, starting execution
  | 'isolation-changed' // Working directory/worktree changed
  | 'reset-requested' // User requested /reset
  | 'worktree-removed' // Worktree manually removed
  | 'conversation-closed'; // Platform conversation closed (issue/PR closed)

/**
 * Behavior category for each trigger.
 * - 'creates': Deactivates current session AND immediately creates a new one
 * - 'deactivates': Only deactivates current session (next message creates new one)
 * - 'none': Neither (first-message has no existing session to deactivate)
 *
 * This Record type ensures compile-time exhaustiveness - adding a new trigger
 * without categorizing it will cause a TypeScript error.
 */
const TRIGGER_BEHAVIOR: Record<TransitionTrigger, 'creates' | 'deactivates' | 'none'> = {
  'first-message': 'none', // No existing session to deactivate
  'plan-to-execute': 'creates', // Only case where we deactivate AND immediately create
  'isolation-changed': 'deactivates',
  'reset-requested': 'deactivates',
  'worktree-removed': 'deactivates',
  'conversation-closed': 'deactivates',
};

/**
 * Determine if this trigger should create a new session immediately.
 */
export function shouldCreateNewSession(trigger: TransitionTrigger): boolean {
  return TRIGGER_BEHAVIOR[trigger] === 'creates';
}

/**
 * Determine if this trigger should deactivate the current session.
 */
export function shouldDeactivateSession(trigger: TransitionTrigger): boolean {
  return TRIGGER_BEHAVIOR[trigger] !== 'none';
}

/**
 * Detect plan→execute transition from command context.
 * Returns 'plan-to-execute' if transitioning, null otherwise.
 */
export function detectPlanToExecuteTransition(
  commandName: string | undefined | null,
  lastCommand: string | undefined | null
): TransitionTrigger | null {
  if (commandName === 'execute' && lastCommand === 'plan-feature') {
    return 'plan-to-execute';
  }
  if (commandName === 'execute-github' && lastCommand === 'plan-feature-github') {
    return 'plan-to-execute';
  }
  return null;
}

/**
 * Commands that have known trigger mappings.
 * Used for function overloads to return non-null for known commands.
 */
export type DeactivatingCommand = 'reset' | 'worktree-remove';

const COMMAND_TRIGGER_MAP: Record<DeactivatingCommand, TransitionTrigger> = {
  reset: 'reset-requested',
  'worktree-remove': 'worktree-removed',
};

/**
 * Map command names to their transition triggers.
 * Used by command handler to determine which trigger to use.
 *
 * Known commands (DeactivatingCommand) return TransitionTrigger (non-null).
 * Unknown commands return TransitionTrigger | null.
 */
export function getTriggerForCommand(commandName: DeactivatingCommand): TransitionTrigger;
export function getTriggerForCommand(commandName: string): TransitionTrigger | null;
export function getTriggerForCommand(commandName: string): TransitionTrigger | null {
  return (COMMAND_TRIGGER_MAP as Record<string, TransitionTrigger>)[commandName] ?? null;
}
