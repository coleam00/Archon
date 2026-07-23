/**
 * Dynamic route that generates markdown (.md) files for each documentation page.
 * This enables AI/LLM tools to fetch raw markdown via URLs like:
 *   https://archon.diy/getting-started/installation.md
 *
 * Uses the same markdown generation pipeline as starlight-llms-txt for consistency.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';

export const prerender = true;

/**
 * Generate static paths for all documentation pages.
 * Each doc gets a .md endpoint at the same path as its HTML version.
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs', (doc) => !doc.data.draft);

  return docs.map((doc) => ({
    params: { slug: doc.id },
    props: { entry: doc },
  }));
};

/**
 * Render the documentation entry to markdown.
 * Returns the raw source markdown with frontmatter stripped.
 */
export const GET: APIRoute = async ({ props }) => {
  const { entry } = props;

  // Build markdown content with title and description as header
  const segments: string[] = [];

  // Add title as h1
  segments.push(`# ${entry.data.title}`);

  // Add description as blockquote if present (handle multiline)
  if (entry.data.description) {
    segments.push(
      entry.data.description
        .split(/\r?\n/)
        .map((line: string) => `> ${line}`)
        .join('\n'),
    );
  }

  // Add the raw markdown body (frontmatter already stripped by content collection)
  if (entry.body) {
    segments.push(entry.body);
  }

  const body = segments.join('\n\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  });
};
