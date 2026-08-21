/**
 * Dynamic route that generates markdown (.md) files for each documentation page.
 * This enables AI/LLM tools to fetch raw markdown via URLs like:
 *   https://archon.diy/getting-started/installation.md
 *
 * Note: Only emits .md sources. MDX files (which may contain JSX components)
 * are excluded — use llms-full.txt for rendered content from those pages.
 */
import type { APIRoute, GetStaticPaths, InferGetStaticPropsType } from 'astro';
import { getCollection } from 'astro:content';

export const prerender = true;

/**
 * Generate static paths for all pure-markdown documentation pages.
 * Excludes .mdx files since their JSX components can't be serialized to raw markdown.
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs', (doc) => {
    // Skip drafts
    if (doc.data.draft) return false;
    // Skip MDX files — they may contain JSX that can't be raw-dumped
    // (e.g., docs.mdx imports <Card> components)
    if (doc.id.endsWith('.mdx')) return false;
    return true;
  });

  return docs.map((doc) => ({
    params: { slug: doc.id },
    props: { entry: doc },
  }));
};

/**
 * Render the documentation entry to markdown.
 * Returns the raw source markdown with frontmatter stripped.
 */
export const GET: APIRoute<InferGetStaticPropsType<typeof getStaticPaths>> = async ({ props }) => {
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
