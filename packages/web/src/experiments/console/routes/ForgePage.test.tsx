import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { RailForgeCounts } from '../components/ProjectRail';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import type { ForgeOverview, ForgeProject } from '../lib/project-forge';
import { takeRerun } from '../lib/rerun';
import type { Project } from '../primitives/project';
import type { Workflow } from '../primitives/workflow';
import type { ProjectForge } from '../skills/forge';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { ForgePage } from './ForgePage';

const PROJECT: Project = {
  id: 'p1',
  name: 'Archon',
  path: '/work/archon',
  defaultBranch: 'dev',
  repositoryUrl: 'https://forge.example/acme/archon.git',
  lastSyncedAt: null,
  kind: 'repo',
};
const WEB = 'https://forge.example/acme/archon';

afterEach(() => {
  invalidate('project');
  invalidate('workflows');
});

const item = (kind: 'issue' | 'pr', number: number, facts: object = {}) => ({
  ref: { repo: { host: 'forge.example', path: 'acme/archon' }, number },
  kind,
  url: `${WEB}/${kind === 'pr' ? 'pull' : 'issues'}/${String(number)}`,
  state: 'open' as const,
  title: `Item ${String(number)}`,
  updatedAt: '2026-11-26T12:00:00Z',
  author: { host: 'forge.example', id: '7', login: 'octo' },
  labels: ['factory'],
  ...facts,
});

function overview(facts: Partial<ForgeOverview> = {}): ForgeOverview {
  return {
    repo: { host: 'forge.example', path: 'acme/archon' },
    since: '2026-11-20T12:00:00.000Z',
    url: WEB,
    name: 'acme/archon',
    description: 'A workflow engine',
    stars: 24019,
    forks: 3543,
    default_branch: 'dev',
    latest_release: { name: 'v0.16.1', url: `${WEB}/releases/v0.16.1` },
    actor: { login: 'octo' },
    stats: {
      issues_open: { count: 217, url: `${WEB}/issues?q=open` },
      issues_unlabeled: { count: 151, url: `${WEB}/issues?q=unlabeled` },
      issues_bugs: { count: 5, url: `${WEB}/issues?q=bugs` },
      issues_assigned_to_actor: { count: 1, url: `${WEB}/issues?q=assigned` },
      prs_open: { count: 30, url: `${WEB}/pulls?q=open` },
      prs_draft: { count: 14, url: `${WEB}/pulls?q=draft` },
      prs_review_requested_from_actor: { count: 0, url: `${WEB}/pulls?q=review` },
      prs_merged_since: { count: 193, url: `${WEB}/pulls?q=merged` },
      issues_closed_since: { count: 208, url: `${WEB}/issues?q=closed` },
    },
    pull_requests: [item('pr', 6438, { is_draft: true })],
    issues: [item('issue', 6447)],
    ...facts,
  };
}

function forge(name: string, value: ForgeOverview = overview()): ForgeProject {
  return {
    kind: 'forge',
    forge: { name },
    repo: { host: 'forge.example', path: 'acme/archon' },
    plugin: { name: name.toLowerCase(), version: '1' },
    overview: { status: 'ok', syncedAt: '2026-11-27T12:00:00.000Z', value },
  };
}

const workflow = (name: string, ...inputs: string[]): Workflow => ({
  name,
  description: null,
  source: 'bundled',
  parseWarnings: [],
  inputs: inputs.map(input => ({ name: input, required: false, default: null, description: null })),
});

function render(
  data: ProjectForge | undefined,
  element: ReactElement = <ForgePage />,
  workflows = [workflow('archon-review', 'scope'), workflow('archon-ship', 'target')]
): string {
  set(K.project(PROJECT.id), PROJECT);
  if (data === undefined) invalidate(K.projectForge(PROJECT.id));
  else set(K.projectForge(PROJECT.id), data);
  set(K.workflows(PROJECT.path), { workflows, recommended: [] });
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/console/p/${PROJECT.id}/forge`]}>
      <Routes>
        <Route path="console/p/:projectId/forge" element={element} />
      </Routes>
    </MemoryRouter>
  );
}

/** The value of the first `href` in `html` that contains `marker`, HTML-decoded. */
function hrefWith(html: string, marker: string): string {
  const href = [...html.matchAll(/href="([^"]*)"/g)]
    .map(match => (match[1] ?? '').replaceAll('&amp;', '&'))
    .find(value => value.includes(marker));
  if (href === undefined) throw new Error(`no link containing ${marker}`);
  return href;
}

describe('the forge tab', () => {
  test('the tab, the repository link and the button are named after the forge', () => {
    const github = render(forge('GitHub'));
    expect(github).toContain('href="/console/p/p1/forge"');
    expect(github).toContain('GitHub');
    expect(github).toContain('Open on GitHub');
    // The header link: repository name and default branch, to the repository's page.
    expect(github).toContain(`href="${WEB}"`);
    expect(github).toContain('· dev');
    // The pill counts open issues and open pull requests together.
    expect(github).toContain('>247<');
    expect(github).toContain('through the github plugin 1');

    const gitlab = render(forge('GitLab'));
    expect(gitlab).toContain('Open on GitLab');
    expect(gitlab).not.toContain('GitHub');
  });

  test('every reported stat is a tile linking to its list, and zero is still a tile', () => {
    const html = render(forge('GitHub'));
    expect(html).toContain(`<a href="${WEB}/issues?q=unlabeled"`);
    expect(html).toContain('Without a label');
    expect(html).toContain('Assigned to @octo');
    expect(html).toContain('Last 7 days');
    // Nobody asked @octo for a review: the tile shows 0 and still links to that list.
    expect(html).toMatch(
      new RegExp(
        `<a href="${WEB}/pulls\\?q=review"[^>]*>0</a><span[^>]*>Review requested from @octo`
      )
    );
  });

  test('a stat or fact the forge lacks is hidden, not shown as zero', () => {
    const { stars: _stars, latest_release: _release, stats, ...facts } = overview();
    const { prs_draft: _drafts, prs_review_requested_from_actor: _review, ...reported } = stats;
    const html = render(forge('Gitea', { ...facts, stats: reported }));
    for (const hidden of ['Drafts', 'Review requested', 'Stars', 'Latest release'])
      expect(html).not.toContain(hidden);
    expect(html).toContain('Forks');
    // The group still shows the stat the forge does report.
    expect(html).toContain('Pull/merge requests');

    const noRecent = render(
      forge('Gitea', {
        ...overview(),
        stats: { issues_open: { count: 2, url: `${WEB}/issues` } },
        pull_requests: undefined,
      })
    );
    expect(noRecent).not.toContain('Last 7 days');
    expect(noRecent).not.toContain('Newest open pull/merge requests');
    expect(noRecent).toContain('Newest open issues');
  });

  test('a project with no forge has no tab, no repository link and no rail counts', () => {
    const tabs = render({ kind: 'none' }, <ProjectViewTabs projectId="p1" active="runs" />);
    expect(tabs.match(/<a /g)).toHaveLength(3);
    expect(tabs).not.toContain('/forge');
    expect(render({ kind: 'none' }, <RailForgeCounts projectId="p1" />)).toBe('');
    // Following an old link to the tab leaves it rather than showing an error.
    expect(render({ kind: 'none' })).toBe('');
  });

  test('the rail counts link to the open issue and pull request lists', () => {
    const html = render(forge('GitHub'), <RailForgeCounts projectId="p1" />);
    expect(html).toContain(`href="${WEB}/issues?q=open"`);
    expect(html).toContain('217 issues');
    expect(html).toContain(`href="${WEB}/pulls?q=open"`);
    expect(html).toContain('30 PRs');
  });

  test('Review and Ship open the start-run flow pre-filled with the item', () => {
    const html = render(forge('GitHub'));
    expect(html).toContain('Draft');
    const linked = (workflowName: string) => {
      const [path = '', query = ''] = hrefWith(html, `workflow=${workflowName}`).split('?');
      return { path, rerun: takeRerun(new URLSearchParams(query))?.rerun };
    };
    // `takeRerun` is what the draft run card reads to expand and fill itself.
    expect(linked('archon-review')).toEqual({
      path: '/console/p/p1',
      rerun: { workflow: 'archon-review', message: null, inputs: { scope: `${WEB}/pull/6438` } },
    });
    expect(linked('archon-ship')).toEqual({
      path: '/console/p/p1',
      rerun: { workflow: 'archon-ship', message: null, inputs: { target: `${WEB}/issues/6447` } },
    });
  });

  test('an action is offered only for a workflow the project has', () => {
    const html = render(forge('GitHub'), <ForgePage />, [workflow('archon-ship', 'target')]);
    expect(html).not.toContain('workflow=archon-review');
    expect(html).toContain('workflow=archon-ship');
  });

  test('an action is not offered when the workflow no longer takes the item', () => {
    // The draft card drops an input the workflow does not declare, so the run would
    // start on something other than the row.
    const html = render(forge('GitHub'), <ForgePage />, [
      workflow('archon-review', 'pull_request'),
      workflow('archon-ship', 'target'),
    ]);
    expect(html).not.toContain('workflow=archon-review');
    expect(html).toContain('workflow=archon-ship');
  });

  test('the forge page shows its own tab while the forge is still being read', () => {
    expect(render(undefined)).toContain('href="/console/p/p1/forge"');
    const runs = render(undefined, <ProjectViewTabs projectId="p1" active="runs" />);
    expect(runs).not.toContain('/forge');
  });

  test('a failed read says why and how to fix it, with no tiles', () => {
    const failed: ProjectForge = {
      ...forge('GitHub'),
      overview: {
        status: 'failed',
        error: { kind: 'no_credential', message: 'No credential for github.com.' },
        remedy: 'Set GH_TOKEN.',
      },
    };
    const html = render(failed);
    expect(html).toContain('GitHub could not be read (no_credential)');
    expect(html).toContain('No credential for github.com.');
    expect(html).toContain('Set GH_TOKEN.');
    expect(html).not.toContain('Open on GitHub');
    expect(html).not.toContain('Issues');
    // The tab stays, without a count; the header names the repository without a link.
    expect(html).toContain('href="/console/p/p1/forge"');
    expect(html).toContain('forge.example/acme/archon');

    const unresolved = render({
      kind: 'unresolved',
      error: { kind: 'process_failed', message: 'The forge plugin could not be run.' },
    });
    expect(unresolved).toContain('could not tell which forge serves this project (process_failed)');
  });
});
