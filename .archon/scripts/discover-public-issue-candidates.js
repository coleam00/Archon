import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  buildCandidateSelectionArtifact,
  selectBestEligibleCandidate,
} from '../../packages/core/src/utils/public-issue-selection';

const DEFAULT_REPO = 'traefik/traefik';
const DEFAULT_PER_PAGE = 20;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_FETCH_RETRIES = 2;

function getArtifactsDir() {
  return process.env.ARTIFACTS_DIR ?? process.cwd();
}

function toMetadata(issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    labels: (issue.labels ?? []).flatMap(label => (label.name ? [label.name] : [])),
    hasLinkedPr: false,
    commentCount: issue.comments ?? 0,
  };
}

async function fetchIssuesPage(url, headers) {
  for (let attempt = 0; attempt <= DEFAULT_FETCH_RETRIES; attempt += 1) {
    const response = await fetch(url, { headers });
    if (response.ok) {
      return response.json();
    }

    if (response.status >= 500 && attempt < DEFAULT_FETCH_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }

    const body = await response.text();
    throw new Error(`GitHub issue fetch failed (${response.status}): ${body.slice(0, 200)}`);
  }

  throw new Error('GitHub issue fetch failed after retries');
}

async function fetchOpenIssues(repo, token, maxPages) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'archon-auto-fix-public-issue',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const issues = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await fetchIssuesPage(
      `https://api.github.com/repos/${repo}/issues?state=open&per_page=${DEFAULT_PER_PAGE}&page=${page}`,
      headers
    );
    issues.push(...data.filter(issue => issue.pull_request === undefined).map(toMetadata));
    if (data.length < DEFAULT_PER_PAGE) {
      break;
    }
  }

  return issues;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.PUBLIC_ISSUE_REPO ?? DEFAULT_REPO;
  const maxPages = Number(process.env.PUBLIC_ISSUE_MAX_PAGES ?? DEFAULT_MAX_PAGES);
  const runId = process.env.WORKFLOW_ID ?? `manual-${Date.now()}`;
  const artifactsDir = getArtifactsDir();

  const issues = await fetchOpenIssues(repo, token, maxPages);
  const artifact = buildCandidateSelectionArtifact({ runId, repo, issues });
  const outputPath = join(artifactsDir, 'candidate-score.json');

  await mkdir(artifactsDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  const best = selectBestEligibleCandidate(artifact.candidates);
  if (!best) {
    throw new Error(
      `No eligible public issue candidates found for ${repo}. See ${outputPath} for scored rejects.`
    );
  }

  console.log(
    JSON.stringify(
      {
        repo,
        scannedIssueCount: issues.length,
        candidateCount: artifact.candidates.length,
        selectedIssue: best
          ? {
              issue_number: best.issue_number,
              score: best.score,
              eligible: best.eligible,
              title: best.title,
            }
          : null,
        artifact: outputPath,
      },
      null,
      2
    )
  );
}

await main();
