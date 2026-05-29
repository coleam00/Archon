/**
 * Shared interactive-prompt helpers for the CLI.
 */
import { confirm, isCancel } from '@clack/prompts';

/**
 * Confirm a destructive action before proceeding.
 *
 * - `force` true → returns true immediately (skip the prompt).
 * - Non-interactive context (no stdin TTY) without `--force` → throws, so the
 *   command fails fast with guidance rather than hanging on a prompt no one can
 *   answer or silently destroying data.
 * - Otherwise prompts y/N and returns the user's choice (cancel = false).
 */
export async function confirmOrAbort(
  message: string,
  force: boolean | undefined
): Promise<boolean> {
  if (force) return true;
  if (!process.stdin.isTTY) {
    throw new Error(
      'Refusing to perform a destructive action without confirmation in a non-interactive context. Re-run with --force.'
    );
  }
  const answer = await confirm({ message });
  if (isCancel(answer)) return false;
  return answer;
}
