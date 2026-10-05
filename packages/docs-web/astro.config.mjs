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

export default defineConfig({
  site: 'https://archon.diy',
  // Keep the existing Markdown and llms.txt rendering across Astro's processor change.
  markdown: { processor: unified() },
  redirects: { ...retiredRegistryRedirects, '/workflows/': '/plugins/' },
  integrations: [
    starlight({
      title: 'Archon',
      favicon: '/favicon.png',
      logo: {
        src: './src/assets/logo.png',
        alt: 'Archon',
      },
      description: 'AI workflow engine — package your coding workflows as YAML, run them anywhere.',
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
          label: 'The Book of Archon',
          items: [{ autogenerate: { directory: 'book' } }],
        },
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
            'AI workflow engine -- package your coding workflows as YAML, run them anywhere.',
          details: `Archon lets you define multi-step AI coding workflows (code review, bug fixes, features) in YAML and run them from CLI, Web UI, Slack, Telegram, GitHub, or Discord. Each workflow runs in an isolated git worktree.`,

          // No exclusions - include all Starlight docs for maximum sitemap coverage
          exclude: [],

          // Topic-based subsets for selective ingestion - cover all major doc sections
          customSets: [
            {
              label: 'Quick Start',
              description: 'Essential docs to get running with Archon',
              paths: ['index', 'getting-started/**'],
            },
            {
              label: 'The Book',
              description: 'Tutorials and conceptual guides',
              paths: ['book/**'],
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
          promote: ['index', 'getting-started/**', 'guides/authoring-workflows'],
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
