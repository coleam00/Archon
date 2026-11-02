/**
 * Inline one pull request for the test-value judge, which runs with no tools: the
 * project's test-value criteria, every changed file's patch, and the full text of each
 * changed file that holds test code at the pull request's head, so a changed test's
 * enclosing `describe` blocks are visible. Test code includes test cases defined
 * outside test files, such as a shared conformance suite that test files run.
 */

import { forgeSource, ghApi, record } from '../../.shared/forge.ts';
import { refuse, report, trimmed } from '../../.shared/io.ts';
import { prFromUrl } from '../../.shared/merge.ts';
import { holdsTestCode, readCriteria } from '../../.shared/test-value.ts';

/** A test file's full text is inlined up to this size; beyond it the patch alone stands. */
const MAX_FULL_TEXT = 120_000;

const url = trimmed(process.env.INPUTS_PR);

try {
  if (forgeSource() === 'forge') {
    throw new Error('the test-value judge reads pull request files through the GitHub CLI; run it with ARCHON_SDLC_FORGE=gh');
  }
  const pr = prFromUrl(url);
  const base = `repos/${pr.repo.path}/pulls/${String(pr.number)}`;
  const host = ['--hostname', pr.repo.host];
  const head = record(record(JSON.parse(ghApi('read the pull request', [...host, base])))?.head)?.sha;
  if (typeof head !== 'string') throw new Error(`GitHub reported no head for ${url}`);

  const files: { path: string; status: string; patch: string }[] = [];
  for (let page = 1; ; page++) {
    const rows: unknown = JSON.parse(ghApi('list the pull request files', [...host, `${base}/files?per_page=100&page=${String(page)}`]));
    if (!Array.isArray(rows)) throw new Error('GitHub did not report a file list');
    for (const row of rows.map(record)) {
      if (typeof row?.filename !== 'string') continue;
      files.push({
        path: row.filename,
        status: typeof row.status === 'string' ? row.status : '',
        patch: typeof row.patch === 'string' ? row.patch : '(no patch: binary or too large)',
      });
    }
    if (rows.length < 100) break;
  }

  const sections = files.map(file => {
    const parts = [`<patch>\n${file.patch}\n</patch>`];
    if (holdsTestCode(file.path, file.patch) && file.status !== 'removed') {
      const text = ghApi('read a test file', [
        ...host,
        '-H',
        'Accept: application/vnd.github.raw',
        `repos/${pr.repo.path}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${head}`,
      ]);
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
