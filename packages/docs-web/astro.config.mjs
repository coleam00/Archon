import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const githubRepository = process.env.GITHUB_REPOSITORY ?? 'NewTurn2017/HarneesLab';
const [repoOwner = 'NewTurn2017', repoName = 'HarneesLab'] = githubRepository.split('/');
const site = process.env.DOCS_SITE_URL ?? `https://${repoOwner}.github.io`;
const base = process.env.DOCS_BASE_PATH ?? (process.env.DOCS_SITE_URL ? '/' : `/${repoName}`);

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: 'HarneesLab',
      favicon: '/favicon.png',
      logo: {
        src: './src/assets/logo.png',
        alt: 'HarneesLab',
      },
      description: 'HarneesLab is an Archon fork for studying, teaching, and building repeatable AI coding workflows.',
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
          label: 'HarneesLab 북',
          autogenerate: { directory: 'book' },
        },
        {
          label: '시작하기',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'HarneesLab',
          autogenerate: { directory: 'harneeslab' },
        },
        {
          label: '가이드',
          autogenerate: { directory: 'guides' },
        },
        {
          label: '어댑터',
          autogenerate: { directory: 'adapters' },
        },
        {
          label: '배포',
          autogenerate: { directory: 'deployment' },
        },
        {
          label: '레퍼런스',
          autogenerate: { directory: 'reference' },
        },
        {
          label: '기여',
          autogenerate: { directory: 'contributing' },
        },
      ],
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
