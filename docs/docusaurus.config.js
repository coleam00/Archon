// @ts-check

/** @type {import('@docusaurus/types').Config} */
export default {
  title: 'Archon',
  tagline: 'Knowledge Engine for AI Coding Assistants',
  url: 'http://localhost:3838',
  baseUrl: '/',
  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',
  favicon: 'favicon.png',
  organizationName: 'archon',
  projectName: 'archon',
  
  markdown: {
    mermaid: true,
  },
  
  themes: ['@docusaurus/theme-mermaid'],
  
  // Client scripts to handle SVG rounded corners
  scripts: [
    {
      src: '/js/mermaid-rounded-corners.js',
      async: true,
    },
  ],
  
  presets: [
    [
      '@docusaurus/preset-classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.js', // Enable proper sidebar
          editUrl: 'https://github.com/coleam00/archon/edit/main/docs/',
          showLastUpdateTime: true,
          showLastUpdateAuthor: true,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],
  
  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      // Proper Mermaid configuration according to official docs
      mermaid: {
        theme: {
          light: 'base',
          dark: 'base'
        },
        options: {
          darkMode: true,
          themeVariables: {            
            // Primary colors - Aurora borealis theme
            primaryColor: '#0a0a0a',
            primaryTextColor: '#ffffff', 
            primaryBorderColor: '#6f55ff',
            
            // Secondary colors
            secondaryColor: '#111111',
            secondaryTextColor: '#ffffff',
            secondaryBorderColor: '#3fb1ff',
            
            // Tertiary colors  
            tertiaryColor: '#1a1a1a',
            tertiaryTextColor: '#ffffff',
            tertiaryBorderColor: '#00d38a',
            
            // Background and main colors
            background: '#0a0a0a',
            mainBkg: '#111111',
            secondBkg: '#1a1a1a',
            
            // Lines and text with aurora colors
            lineColor: '#3fb1ff',
            textColor: '#ffffff',
            
            // Font configuration - Force Inter family throughout
            fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: '14px',
            fontWeight: '400',
            
            // Flowchart specific variables
            nodeBorder: '#6f55ff',
            clusterBkg: 'rgba(17, 17, 17, 0.8)',
            clusterBorder: '#3fb1ff',
            defaultLinkColor: '#3fb1ff',
            edgeLabelBackground: '#0a0a0a',
            nodeTextColor: '#ffffff',
            
            // Color scales for different elements
            cScale0: '#00d38a',
            cScale1: '#0fcaa6', 
            cScale2: '#36b5ef',
            cScale3: '#3fb1ff',
            cScale4: '#fe6aff',
            cScale5: '#d964ff',
            cScale6: '#ab5dff',
            cScale7: '#8a59ff',
            cScale8: '#7656ff',
            cScale9: '#6f55ff',
            cScale10: '#9a3df8',
            cScale11: '#ed0fed',
            
            // Sequence diagram specific
            actorBkg: '#111111',
            actorBorder: '#6f55ff',
            actorTextColor: '#ffffff',
            
            // Class diagram
            classText: '#ffffff',
            
            // State diagram
            labelColor: '#ffffff',
          }
        },
      },
      colorMode: {
        defaultMode: 'dark',
        disableSwitch: true,
        respectPrefersColorScheme: false,
      },
      navbar: {
        title: 'Archon',
        logo: {
          alt: 'Archon Logo',
          src: 'logo-neon.png',
        },
        items: [
          {
            href: 'https://github.com/coleam00/archon',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },

      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 4,
      },
      
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Getting Started',
            items: [
              { label: 'Installation', to: '/getting-started' },
              { label: 'Quick Setup', to: '/getting-started#quick-start' },
              { label: 'Configuration', to: '/configuration' },
            ],
          },
          {
            title: 'API & Integration',
            items: [
              { label: 'API Reference', to: '/api-reference' },
              { label: 'MCP Integration', to: '/mcp-overview' },
              { label: 'Task Management', to: '/tasks' },
            ],
          },
          {
            title: 'User Interface',
            items: [
              { label: 'Web Interface', to: '/ui' },
              { label: 'Testing Guide', to: '/testing' },
              { label: 'Deployment', to: '/deployment' },
            ],
          },
          {
            title: 'Community',
            items: [
              { label: 'GitHub', href: 'https://github.com/coleam00/archon' },
              { label: 'Issues', href: 'https://github.com/coleam00/archon/issues' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Archon Project`,
      },
    }),
};
