/**
 * Skill API — the single mutation surface for the console.
 *
 * Every UI action in the console calls exactly one of these verbs.
 * Internal orchestrators (CLI, Claude Code skill, future LLM driver) call
 * the same verbs via their own transport. If a UI interaction can't be
 * expressed as a skill verb, the verb set is wrong, not the UI.
 */

export * from './projects';
export * from './workflows';
export * from './worktrees';
export * from './runs';
export * from './startRun';
export * from './messages';
export * from './conversations';
export * from './envVars';
export * from './settings';
export * from './providers';
export * from './github';

export { HttpError } from '../lib/http';
