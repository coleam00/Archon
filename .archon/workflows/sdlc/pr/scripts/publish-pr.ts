/**
 * Push the branch, then publish the pull request and record its verified identity.
 *
 * The preceding nodes judged the target and the text and proved the merged tree; this
 * node owns publication, including the push and PR writes, and proves each landed,
 * through whichever source the run selected. When its caller allows it, it also
 * writes the description section the run prepared: between its own markers, keeping
 * every other byte of the description, and read back like every other write. The push comes first and refuses on any failure (./.shared/push.ts), so a
 * pull request is never created for a head the remote does not have.
 *
 * Whether this work already has a pull request is decided here, not in a prompt: an
 * open pull request for the recorded head IS the pull request, and a second one is
 * never opened for it. A run continuing a pull request pushes to that pull request's
 * own head as the forge reports it, not to the branch prepare declared, and only
 * while it is open. The push is by merge only — it never forces, so a head that is
 * not an ancestor of this commit refuses.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_REPO / INPUTS_HEAD_REPO: `{host, path}` of the base and head repositories.
 * - INPUTS_HEAD / INPUTS_BASE: the head and base branch names.
 * - INPUTS_BRANCH: the branch a new pull request opens from, as the caller resolved
 *   it; empty uses INPUTS_HEAD.
 * - INPUTS_EXISTING: the pull request prepare found for this work, or `null`. It is
 *   continued only when the caller named it or selected no branch.
 * - INPUTS_PULL_REQUEST: the number the caller resolved for it, or empty or `null`.
 * - INPUTS_TITLE: the title.
 * - INPUTS_BODY: the certified body pointer, or null; prepare writes none for a pull request it continues.
 * - INPUTS_DRAFT: `true` opens a draft.
 * - INPUTS_DESCRIPTION: the certified description-section pointer, or null.
 * - INPUTS_PUBLISH_DESCRIPTION: `true` lets the run write that section; anything else
 *   refuses a declared one before pushing.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PR_CREATE_RECORD, PR_CREATE_VERIFIED_RECORD, DESCRIPTION_SECTION, createPr, editPrBody, findOpenPrByHead, viewPr } from '../../.shared/pr.ts';
import {
  ForgeOperationError,
  forgeSource,
  record,
  type ForgeSource,
  type PrRecord,
  type QualifiedPr,
} from '../../.shared/forge.ts';
import { artifactsDir, emit, note, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { pushHead } from '../../.shared/push.ts';

type Repo = QualifiedPr['repo'];

const { start: SECTION_START, end: SECTION_END } = DESCRIPTION_SECTION;

async function descriptionMarkers(markdown: string): Promise<{ marker: string; at: number }[]> {
  const candidates: { marker: string; at: number; token: string }[] = [];
  const tagged = markdown.replace(
    new RegExp(Object.values(DESCRIPTION_SECTION).join('|'), 'g'),
    (marker: string, at: number) => {
      const token = ` archon-description-position-${at} `;
      candidates.push({ marker, at, token });
      // Legacy sections put the closing delimiter directly after a Markdown table.
      // Separate it for recognition only; raw HTML containers still own their comments.
      const separator = marker === SECTION_END && (at === 0 || markdown[at - 1] === '\n') ? '\n\n' : '';
      return `${separator}<!--${token}-->`;
    }
  );
  const comments = new Set<string>();
  const nested = new Set<string>();
  await new HTMLRewriter()
    .on('*', { comments: comment => { nested.add(comment.text); } })
    .onDocument({ comments: comment => { comments.add(comment.text); } })
    .transform(new Response(Bun.markdown.html(tagged)))
    .text();
  return candidates.filter(candidate => comments.has(candidate.token) && !nested.has(candidate.token));
}

function blockSeparator(value: string): string {
  return value === '' || value.endsWith('\n\n') ? '' : value.endsWith('\n') ? '\n' : '\n\n';
}

/**
 * The description with `section` between the delivery markers: replacing what lies
 * between an existing pair, or appended as a new pair. Text outside the markers is
 * never changed, and a marker that does not pair is refused rather than guessed at.
 */
async function withDescriptionSection(live: string, section: string): Promise<string> {
  const block = `${SECTION_START}\n${section}${blockSeparator(section)}${SECTION_END}`;
  const markers = await descriptionMarkers(live);
  let composed: string;
  let blockAt: number;
  const starts = markers.filter(entry => entry.marker === SECTION_START).map(entry => entry.at);
  const ends = markers.filter(entry => entry.marker === SECTION_END).map(entry => entry.at);
  if (starts.length === 0 && ends.length === 0) {
    const separator = blockSeparator(live);
    blockAt = live.length + separator.length;
    composed = `${live}${separator}${block}\n`;
  } else {
    const [start] = starts;
    const [end] = ends;
    if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end < start) {
      throw new Error(
        'the description has an unpaired or repeated archon-delivery-description marker; fix it by hand'
      );
    }
    blockAt = start;
    composed = live.slice(0, start) + block + live.slice(end + SECTION_END.length);
  }
  const pair = await descriptionMarkers(composed);
  if (
    pair.length !== 2 ||
    pair[0]?.marker !== SECTION_START || pair[0].at !== blockAt ||
    pair[1]?.marker !== SECTION_END || pair[1].at !== blockAt + block.length - SECTION_END.length
  ) {
    throw new Error('the composed description hides or adds delivery markers; close Markdown fences and HTML containers before publishing');
  }
  return composed;
}

/** The prepared section's content, or undefined when prepare declared none. */
async function preparedSection(artifacts: string): Promise<string | undefined> {
  const pointer = record(nullableJson(process.env.INPUTS_DESCRIPTION));
  if (pointer === undefined) return undefined;
  if (trimmed(process.env.INPUTS_PUBLISH_DESCRIPTION) !== 'true') {
    throw new Error('prepare declared a description section, but the caller did not allow publishing one');
  }
  if (
    pointer.type !== 'archon_artifact' ||
    pointer.run_id !== process.env.WORKFLOW_ID ||
    pointer.path !== 'pr-description.md'
  ) {
    throw new Error('prepare must declare the pr-description.md artifact from this run');
  }
  const section = readFileSync(join(artifacts, pointer.path), 'utf8');
  if (section.trim() === '') throw new Error('prepare declared an empty pr-description.md');
  if ((await descriptionMarkers(section)).length > 0) {
    throw new Error('pr-description.md contains reserved description markers; put literal examples in Markdown code');
  }
  return section;
}

async function applyDescription(pr: PrRecord, section: string, source: ForgeSource): Promise<void> {
  const ref = { repo: pr.repo, number: pr.number };
  const live = viewPr(ref, source).body;
  const body = await withDescriptionSection(live, section);
  if (body === live) {
    note(`publish-pr: ${pr.url}'s description section is already current.`);
    return;
  }
  editPrBody(ref, body, source);
}

/**
 * Read an existing pull request back until it reports the commit just pushed.
 * GitHub's pull request API can keep reporting the previous head for a while after
 * the remote branch has moved (pushHead already proved the branch with ls-remote).
 * Review compares that recorded head with its checkout, so recording a stale one
 * fails the round with a false head mismatch.
 */
function awaitHead(read: () => PrRecord, pushed: string, first: PrRecord = read()): PrRecord {
  let pr = first;
  for (let attempt = 0; pr.head_revision !== pushed && attempt < 12; attempt++) {
    Bun.sleepSync(5_000);
    pr = read();
  }
  if (pr.head_revision !== pushed) {
    throw new Error(
      `pushed ${pushed}, but pull request ${String(pr.number)} still reports head ${pr.head_revision ?? 'none'} after 60s`
    );
  }
  return pr;
}

function recordCreatedPr(claimPath: string, pr: PrRecord): void {
  try {
    writeFileSync(claimPath, JSON.stringify({ repo: pr.repo, headRepo: pr.head_repo, head: pr.head, pr }), { mode: 0o600 });
  } catch (error) {
    const recoveryPath = join(artifactsDir(), PR_CREATE_VERIFIED_RECORD);
    let recoveryError: unknown;
    try {
      writeFileSync(recoveryPath, JSON.stringify({ pr }), { mode: 0o600 });
    } catch (failure) {
      recoveryError = failure;
    }
    throw new Error(
      `created and verified ${pr.url}, but could not record its identity at ${claimPath}; continue this PR explicitly: ${error instanceof Error ? error.message : String(error)}` +
      (recoveryError === undefined ? '' : `; recovery record ${recoveryPath} also failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`),
      { cause: recoveryError === undefined ? error : new AggregateError([error, recoveryError]) }
    );
  }
}

function publish(): PrRecord {
  const source = forgeSource();
  const repo = JSON.parse(text(process.env.INPUTS_REPO)) as Repo;
  const headRepo = JSON.parse(text(process.env.INPUTS_HEAD_REPO)) as Repo;
  const existing = nullableJson(process.env.INPUTS_EXISTING) as number | null;
  const artifacts = artifactsDir();

  const named = nullableJson(process.env.INPUTS_PULL_REQUEST) as number | null;
  if (named !== null && existing !== named) {
    throw new Error(
      `the caller named pull request ${String(named)} to continue, but prepare declared ${String(existing ?? 'none')}`
    );
  }

  // A branch the caller selected decides the pull request over one prepare found
  // unnamed, which may sit on the checkout's other branch: only an open pull request
  // with that head is reused below.
  const branch = trimmed(process.env.INPUTS_BRANCH);
  if (existing !== null && named === null && branch) {
    note(`publish-pr: the caller selected ${branch}; pull request ${String(existing)} is reused only if it has that head.`);
  } else if (existing !== null) {
    const view = viewPr({ repo, number: existing }, source);
    const prHeadRepo = view.pr.head_repo;
    if (view.pr.state !== 'open') {
      throw new Error(`pull request ${String(existing)} is ${view.pr.state}; nothing is pushed`);
    }
    if (prHeadRepo === null) {
      throw new Error(`pull request ${String(existing)}'s head repository is gone; nothing is pushed`);
    }
    const pushed = pushHead({ repo, head_repo: prHeadRepo, head: view.pr.head });
    // The run continues a named pull request: its draft state belongs to its author,
    // and its description changes only by the section publish() applies when allowed.
    return awaitHead(() => viewPr({ repo, number: existing }, source).pr, pushed);
  }

  const head = branch || text(process.env.INPUTS_HEAD);
  const headRevision = pushHead({ repo, head_repo: headRepo, head });

  const open = findOpenPrByHead(repo, headRepo, head, source);
  if (open) {
    note(`publish-pr: ${open.pr.url} already has this head, so no pull request was opened.`);
    return awaitHead(() => viewPr({ repo, number: open.pr.number }, source).pr, headRevision, open.pr);
  }

  const body = record(nullableJson(process.env.INPUTS_BODY));
  if (body === undefined) {
    throw new Error(`no open pull request has ${headRepo.path}:${head}, and prepare wrote no body to open one with`);
  }
  if (
    body.type !== 'archon_artifact' ||
    body.run_id !== process.env.WORKFLOW_ID ||
    body.path !== 'pr-body.md'
  ) {
    throw new Error('prepare must declare the pr-body.md artifact from this run');
  }
  const bodyPath = join(artifacts, body.path);
  // A local read failure sent no create; it must not leave a claim blocking retry.
  readFileSync(bodyPath, 'utf8');

  // Killing the script cannot cancel a submitted forge write. Keep this claim even
  // after success: a retry may only reconcile it.
  const claimPath = join(artifacts, PR_CREATE_RECORD);
  try {
    writeFileSync(claimPath, JSON.stringify({ repo, headRepo, head }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `a previous PR create is unresolved; no open PR was found for ${headRepo.path}:${head}. Reconcile the write recorded at ${claimPath} before creating another PR`
      );
    }
    throw error;
  }
  try {
    const pr = createPr(
      {
        repo,
        headRepo,
        head,
        headRevision,
        base: text(process.env.INPUTS_BASE),
        title: text(process.env.INPUTS_TITLE),
        bodyPath,
        draft: trimmed(process.env.INPUTS_DRAFT) === 'true',
      },
      source
    );
    recordCreatedPr(claimPath, pr);
    return pr;
  } catch (error) {
    // A forge refusal is definite: no write was sent, so the claim would only block
    // a retry. Every other failure may have left a pull request behind.
    if (error instanceof ForgeOperationError && error.mutation?.outcome === 'refused') {
      unlinkSync(claimPath);
    }
    throw error;
  }
}

// Validate the artifact before pushing; check composition against the live body before editing.
async function publishWithDescription(): Promise<PrRecord> {
  const section = await preparedSection(artifactsDir());
  const pr = publish();
  // The edit does not move the head, so the head-verified record stays the output.
  if (section !== undefined) await applyDescription(pr, section, forgeSource());
  return pr;
}

try {
  emit(await publishWithDescription());
} catch (error) {
  refuse(`publish-pr: ${error instanceof Error ? error.message : String(error)}`);
}
