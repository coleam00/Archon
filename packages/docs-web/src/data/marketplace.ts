export interface MarketplaceEntry {
  slug: string;
  name: string;
  author: string;
  description: string;
  sourceUrl: string; // GitHub blob/tree URL — file (.yaml) or directory containing workflow + commands/scripts
  sha: string; // Commit SHA pin
  tags: string[];
  archonVersionCompat: string;
  featured?: boolean;
}

export const tagConfig: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  development: {
    label: 'Development',
    color: '#3b82f6',
    bg: 'rgba(59,130,246,0.08)',
    border: 'rgba(59,130,246,0.25)',
  },
  review: {
    label: 'Review',
    color: '#22c55e',
    bg: 'rgba(34,197,94,0.08)',
    border: 'rgba(34,197,94,0.25)',
  },
  automation: {
    label: 'Automation',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.25)',
  },
  planning: {
    label: 'Planning',
    color: '#a855f7',
    bg: 'rgba(168,85,247,0.08)',
    border: 'rgba(168,85,247,0.25)',
  },
};

export const VALID_HOSTS = ['github.com'] as const;

const SHA = '69b2c8978b589a30e2b01ee77897a770d714d630';
const BASE = 'https://github.com/coleam00/Archon/blob/main';
const BASE_PATH = '.archon/workflows/defaults';

export const marketplaceEntries: MarketplaceEntry[] = [
  {
    slug: 'archon-piv-loop',
    name: 'Archon PIV Loop',
    author: 'coleam00',
    description:
      'Guided Plan-Implement-Validate development with human-in-the-loop checkpoints. Plan your feature, implement with AI, then validate before committing.',
    sourceUrl: `${BASE}/${BASE_PATH}/archon-piv-loop.yaml`,
    sha: SHA,
    tags: ['development', 'planning'],
    archonVersionCompat: '>=0.3.0',
    featured: true,
  },
  {
    slug: 'archon-fix-github-issue',
    name: 'Fix GitHub Issue',
    author: 'coleam00',
    description:
      'Automatically fix, resolve, or implement a solution for a GitHub issue. Syncs the issue, plans the fix, implements it, and opens a PR.',
    sourceUrl: `${BASE}/${BASE_PATH}/archon-fix-github-issue.yaml`,
    sha: SHA,
    tags: ['development', 'automation'],
    archonVersionCompat: '>=0.3.0',
    featured: true,
  },
  {
    slug: 'archon-comprehensive-pr-review',
    name: 'Comprehensive PR Review',
    author: 'coleam00',
    description:
      'Full code review of a pull request with automatic fixes. Runs 5 specialized review agents in parallel, synthesizes findings, and auto-fixes critical issues.',
    sourceUrl: `${BASE}/${BASE_PATH}/archon-comprehensive-pr-review.yaml`,
    sha: SHA,
    tags: ['review', 'automation'],
    archonVersionCompat: '>=0.3.0',
    featured: true,
  },
  {
    slug: 'archon-ralph-dag',
    name: 'Ralph DAG Loop',
    author: 'coleam00',
    description:
      'Ralph implementation loop — generate or load a PRD, break it into stories, then run Ralph iteratively until all stories are complete.',
    sourceUrl: `${BASE}/${BASE_PATH}/archon-ralph-dag.yaml`,
    sha: SHA,
    tags: ['development', 'planning'],
    archonVersionCompat: '>=0.3.0',
    featured: true,
  },
  {
    slug: 'video-generic',
    name: 'Video Generic',
    author: 'coleam00',
    description:
      'Turn a freeform prompt (URL, GitHub repo, release notes, topic) into a voiced + animated Remotion video. Three approval gates let you steer the spec, script, and live preview before render. Requires an ElevenLabs API key.',
    sourceUrl:
      'https://github.com/leex279/remotion-video-test/tree/4dac83c28d2e4a745b81520343101c402539b84f/.archon',
    sha: '4dac83c28d2e4a745b81520343101c402539b84f',
    tags: ['automation'],
    archonVersionCompat: '>=0.3.0',
  },
];
