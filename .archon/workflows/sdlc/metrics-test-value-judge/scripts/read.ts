/**
 * Inline one pull request for the test-value judge, which runs with no tools: the
 * project's test-value criteria, every changed file's patch, and the full text of each
 * changed file that holds test code at the pull request's head, so a changed test's
 * enclosing `describe` blocks are visible. Test code includes test cases defined
 * outside test files, such as a shared conformance suite that test files run.
 */

import { invokeForge } from '../../.shared/forge.ts';
import { refuse, report, trimmed } from '../../.shared/io.ts';
import { prFromUrl } from '../../.shared/merge.ts';
import { readCriteria } from '../../.shared/test-value.ts';
import { holdsTestCode } from './test-code.ts';

/** A file holding test code is inlined in full up to this size; beyond it the patch alone stands. */
const MAX_FULL_TEXT = 120_000;

interface ChangedFile {
  readonly path: string;
  readonly status: string;
  readonly patch: string | null;
}

function changedFiles(value: Record<string, unknown> | null): { head: string; files: ChangedFile[] } {
  const head = value?.head_revision;
  if (typeof head !== 'string' || !Array.isArray(value?.files)) throw new Error('forge pr.files returned no file list');
  const files = value.files.map(row => {
    const file = row as Record<string, unknown>;
    if (typeof file.path !== 'string' || typeof file.status !== 'string') throw new Error('forge pr.files returned an invalid file');
    return { path: file.path, status: file.status, patch: typeof file.patch === 'string' ? file.patch : null };
  });
  return { head, files };
}

const url = trimmed(process.env.INPUTS_PR);

try {
  const pr = prFromUrl(url);
  // Text is read at the head the file list was read at, so it matches the patches.
  const { head, files } = changedFiles(invokeForge('pr.files', { ref: { repo: pr.repo, number: pr.number } }));

  const sections = files.map(file => {
    const parts = [`<patch>\n${file.patch ?? '(no patch: binary or too large)'}\n</patch>`];
    if (holdsTestCode(file.path, file.patch) && file.status !== 'removed') {
      // repo.file refuses a file over 1 MB or not UTF-8 with the same error kind as a
      // transient failure, so this pull request's judge refuses rather than inlining a
      // placeholder: the run reports it as skipped instead of judging it on a guess.
      const text = invokeForge('repo.file', { repo: pr.repo, path: file.path, revision: head })?.text;
      if (typeof text !== 'string') throw new Error(`forge repo.file returned no text for ${file.path}`);
      parts.push(text.length <= MAX_FULL_TEXT ? `<full_text>\n${text}\n</full_text>` : '<full_text>(too large to inline)</full_text>');
    }
    return `<file path="${file.path}" status="${file.status}">\n${parts.join('\n')}\n</file>`;
  });
  report(
    `<criteria>\n${readCriteria()}\n</criteria>\n\n<pull_request url="${url}">\n${sections.join('\n\n')}\n</pull_request>`
  );
} catch (error) {
  refuse(`read: ${error instanceof Error ? error.message : String(error)}`);
}
