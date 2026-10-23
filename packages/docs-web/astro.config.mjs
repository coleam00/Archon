import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

// Preserve old entry bookmarks without claiming that an author republished their pack.
// The former listing redirects to the GitHub topic index.
const retiredRegistrySlugs = [
  'archon-piv-loop',
  'archon-fix-github-issue',
  'archon-comprehensive-pr-review',
  'archon-ralph-dag',
  'video-generic',
  'archon-idea-to-wo',
  'archon-smart-mr-review',
  'archon-resolve-mr-conflicts',
  'archon-comprehensive-mr-review',
  'piv-system-evolution',
  'harness-score',
  'pocock-skills-workflow-family',
  'token-max-site-factory',
  'image-node-factory',
];
const retiredRegistryRedirects = Object.fromEntries(
  retiredRegistrySlugs.map((slug) => [
    `/workflows/${slug}/`,
    '/guides/global-workflows/#installed-workflow-packs',
  ])
);

// Pages folded into the value-first path (#4622). Their URLs stay public through these redirects.
const foldedPageRedirects = {
  '/book/': '/getting-started/why-archon/',
  '/book/what-is-archon/': '/getting-started/why-archon/',
  '/book/first-five-minutes/': '/getting-started/quick-start/',
  '/book/how-it-works/': '/reference/sdlc-workflows/',
  '/book/essential-workflows/': '/reference/sdlc-workflows/',
  '/book/isolation/': '/guides/worktrees/',
  '/book/first-command/': '/getting-started/first-workflow/',
  '/book/first-workflow/': '/getting-started/first-workflow/',
  '/book/dag-workflows/': '/reference/workflow-language/',
  '/book/hooks-and-quality/': '/guides/hooks/',
  '/book/quick-reference/': '/reference/cli/',
  '/getting-started/what-archon-is-not/': '/getting-started/why-archon/',
  '/getting-started/concepts/': '/getting-started/why-archon/',
  '/getting-started/overview/': '/getting-started/quick-start/',
  '/guides/authoring-workflows/': '/reference/workflow-language/',
  '/guides/attention-queue/': '/getting-started/operate/',
};

export default defineConfig({
  site: 'https://archon.diy',
  // Keep the existing Markdown and llms.txt rendering across Astro's processor change.
  markdown: { processor: unified() },
  redirects: {
    ...retiredRegistryRedirects,
    ...foldedPageRedirects,
    '/workflows/': '/plugins/',
  },
  integrations: [
    starlight({
      title: 'Archon',
      favicon: '/favicon.png',
      logo: {
        src: './src/assets/logo.png',
        alt: 'Archon',
      },
      description: 'Archon is a factory builder: YAML workflows that agents, scripts and your decisions run, with you on the loop.',
      head: [
        {
          tag: 'script',
          content: `if(!localStorage.getItem('archon-theme-init')){localStorage.setItem('archon-theme-init','1');localStorage.setItem('starlight-theme','dark');document.documentElement.dataset.theme='dark';}`,
        },
        {
          tag: 'link',
          attrs: {
            rel: 'llms',
            type: 'text/plain',
            href: '/llms.txt',
            title: 'LLM-optimized documentation index',
          },
        },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/coleam00/Archon' }],
      editLink: {
        baseUrl: 'https://github.com/coleam00/Archon/edit/main/packages/docs-web/',
      },
      sidebar: [
        { label: '🗺️  Roadmap', link: '/roadmap/' },
        { label: '🎨  Brand', link: '/brand/' },
        { label: 'Plugins', link: '/plugins/' },
        {
          label: 'Getting Started',
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: 'Guides',
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Adapters',
          items: [{ autogenerate: { directory: 'adapters' } }],
        },
        {
          label: 'Deployment',
          items: [{ autogenerate: { directory: 'deployment' } }],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
        },
        {
          label: 'Contributing',
          items: [{ autogenerate: { directory: 'contributing' } }],
        },
      ],
      customCss: ['./src/styles/custom.css'],
      routeMiddleware: './src/starlightRouteData.ts',
      plugins: [
        starlightLlmsTxt({
          description:
            'Archon is a factory builder: YAML workflows run by AI agents, scripts and your decisions.',
          details: `Archon runs multi-step workflows written in YAML. Agents judge, code computes, and a run pauses as an attention item when it needs your decision. The bundled sdlc pack takes an issue to a merged pull request through intake, a build queue and a merge queue. Repository runs work in their own git worktree. Runs start from the CLI, the Web UI or a chat platform.`,

          // No exclusions - include all Starlight docs for maximum sitemap coverage
          exclude: [],

          // Topic-based subsets for selective ingestion - cover all major doc sections
          customSets: [
            {
              label: 'Getting started',
              description: 'Why Archon, the quickstart and a first workflow',
              paths: ['index', 'getting-started/**'],
            },
            {
              label: 'Guides',
              description: 'How-to guides for workflows, commands, and nodes',
              paths: ['guides/**'],
            },
            {
              label: 'Adapters',
              description: 'Platform integrations (GitHub, Slack, Discord, etc.)',
              paths: ['adapters/**'],
            },
            {
              label: 'Deployment',
              description: 'Deployment guides for Docker, cloud, and local setups',
              paths: ['deployment/**'],
            },
            {
              label: 'Reference',
              description: 'CLI commands, configuration, and API reference',
              paths: ['reference/**'],
            },
            {
              label: 'Contributing',
              description: 'Contributor guides for developers',
              paths: ['contributing/**'],
            },
          ],

          // Links to non-Starlight pages in the sitemap
          optionalLinks: [
            {
              label: 'Home',
              url: 'https://archon.diy/',
              description: 'Archon homepage',
            },
            {
              label: 'Roadmap',
              url: 'https://archon.diy/roadmap/',
              description: 'Project roadmap and planned features',
            },
          ],

          // Control ordering - essentials first
          promote: ['index', 'getting-started/**', 'reference/workflow-language'],
          demote: ['contributing/**'],

          // Aggressive minification for small version
          minify: {
            note: true,
            tip: true,
            caution: false, // Keep warnings
            danger: false, // Keep critical warnings
            details: true,
            whitespace: true,
          },
        }),
      ],
    }),
  ],
});
