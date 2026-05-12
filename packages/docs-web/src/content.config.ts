import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { z } from 'astro/zod';

/**
 * Extended docs schema for Archon documentation.
 *
 * Custom fields mirror the GitHub label taxonomy used in the repo:
 * - `category` → sidebar section / directory (like label prefixes)
 * - `area` → package/domain (like `area:*` labels)
 * - `audience` → who the doc targets
 * - `status` → doc lifecycle state
 *
 * All custom fields are optional so existing/stub pages don't break.
 * Starlight's built-in fields (title, description, sidebar, template,
 * hero, draft, etc.) are inherited from docsSchema().
 */
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        /**
         * Primary content category — determines which sidebar section
         * and directory this doc belongs to.
         *
         * - getting-started: Onboarding, installation, first steps
         * - guides: How-to guides for users (workflows, commands, node features)
         * - adapters: Platform adapter setup (Slack, Telegram, GitHub, Discord, Web)
         * - deployment: Running in production (Docker, cloud, Windows)
         * - reference: Technical reference (architecture, CLI, commands, database, API)
         * - contributing: Developer guides (internals, DX, releasing, testing)
         */
        category: z
          .enum([
            'getting-started',
            'guides',
            'adapters',
            'deployment',
            'reference',
            'contributing',
            'book',
          ])
          .optional(),

        /**
         * Book of Archon part — groups chapters into narrative sections.
         * Only used for pages in the `book/` directory.
         */
        part: z
          .enum(['orientation', 'core-workflows', 'customization', 'advanced'])
          .optional(),

        /**
         * Package or domain area — mirrors the `area:*` GitHub labels.
         * Useful for cross-referencing docs with code and issues.
         */
        area: z
          .enum([
            'adapters',
            'cli',
            'clients',
            'config',
            'database',
            'handlers',
            'infra',
            'isolation',
            'orchestrator',
            'server',
            'services',
            'web',
            'workflows',
          ])
          .optional(),

        /**
         * Target audience for this doc. A doc can target multiple audiences.
         *
         * - user: End users running Archon workflows
         * - developer: People building on or contributing to Archon
         * - operator: People deploying and maintaining Archon
         */
        audience: z.array(z.enum(['user', 'developer', 'operator'])).optional(),

        /**
         * Documentation lifecycle status.
         *
         * - current: Up to date and authoritative
         * - deprecated: Superseded, kept for reference
         * - research: Exploratory / not authoritative
         *
         * Note: For work-in-progress docs, use Starlight's built-in
         * `draft: true` frontmatter instead.
         */
        status: z.enum(['current', 'deprecated', 'research']).default('current'),
      }),
    }),
  }),
};
