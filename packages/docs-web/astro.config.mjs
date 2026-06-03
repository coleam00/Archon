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

          // Make llms-small.txt actually small - core concepts only
          exclude: [
            'adapters/community/**', // Community adapters are reference material
            'deployment/**', // Deployment is advanced
            'contributing/**', // Not needed for using Archon
            'reference/security', // Deep reference
            'book/**', // Long-form content
          ],

          // Topic-based subsets for selective ingestion
          customSets: [
            {
              label: 'Quick Start',
              description: 'Essential docs to get running with Archon',
              paths: ['index', 'getting-started/**'],
            },
            {
              label: 'Adapters',
              description: 'Platform integrations (GitHub, Slack, Discord, etc.)',
              paths: ['adapters/**'],
            },
            {
              label: 'Reference',
              description: 'CLI commands, configuration, and API reference',
              paths: ['reference/**'],
            },
          ],

          // Control ordering - essentials first
          promote: ['index', 'getting-started/**', 'guides/first-workflow'],
          demote: ['reference/changelog', 'contributing/**'],

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
