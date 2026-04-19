import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const githubRepository = process.env.GITHUB_REPOSITORY ?? 'NewTurn2017/Archon';
const [repoOwner = 'NewTurn2017', repoName = 'Archon'] = githubRepository.split('/');
const site = process.env.DOCS_SITE_URL ?? `https://${repoOwner}.github.io`;
const base = process.env.DOCS_BASE_PATH ?? (process.env.DOCS_SITE_URL ? '/' : `/${repoName}`);

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: 'Archon 한국어 포크',
      favicon: '/favicon.png',
      logo: {
        src: './src/assets/logo.png',
        alt: 'Archon 한국어 포크',
      },
      description: 'AI 코딩 워크플로 엔진 Archon을 한국어 학습, 운영, 연구용으로 재구성하는 포크입니다.',
      head: [
        {
          tag: 'script',
          content: `if(!localStorage.getItem('starlight-theme')){localStorage.setItem('starlight-theme','dark');document.documentElement.dataset.theme='dark';}`,
        },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: `https://github.com/${githubRepository}` }],
      editLink: {
        baseUrl: `https://github.com/${githubRepository}/edit/main/packages/docs-web/`,
      },
      sidebar: [
        {
          label: 'The Book of Archon',
          autogenerate: { directory: 'book' },
        },
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: '한국어 포크',
          autogenerate: { directory: 'korean-fork' },
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
    }),
  ],
});
