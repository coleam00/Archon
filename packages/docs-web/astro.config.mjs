import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://archon.diy',
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
        { label: '✦  Marketplace', link: '/workflows/' },
        { label: '🗺️  Roadmap', link: '/roadmap/' },
        { label: '🎨  Brand', link: '/brand/' },
        {
          label: 'The Book of Archon',
          autogenerate: { directory: 'book' },
        },
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Guides',
          autogenerate: { directory: 'guides' },
        },
        {
          label: 'Adapters',
          autogenerate: { directory: 'adapters' },
        },
        {
          label: 'Deployment',
          autogenerate: { directory: 'deployment' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
        {
          label: 'Contributing',
          autogenerate: { directory: 'contributing' },
        },
      ],
      customCss: ['./src/styles/custom.css'],
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
            {
              label: 'Workflow Marketplace',
              url: 'https://archon.diy/workflows/',
              description: 'Browse and discover community workflows',
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
