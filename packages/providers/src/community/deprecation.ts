/** Docs path of the deprecated-providers section; the capability matrix links it too. */
export const DEPRECATED_PROVIDERS_DOCS_PATH =
  '/getting-started/ai-assistants/#deprecated-providers';

/**
 * Notice for a bundled provider or chat adapter that no maintainer owns. It warns;
 * the feature keeps working, and no removal is scheduled.
 */
export function deprecatedNotice(name: string): string {
  return (
    `${name} is deprecated: no Archon maintainer owns it. It keeps working, but fixes are not ` +
    'guaranteed. For a version you control, build your own plugin: ' +
    'https://archon.diy/guides/publishing-plugins/'
  );
}

/** Chat providers without native tools launch through the detached CLI. */
export function deprecatedChatProviderNotice(name: string): string {
  return (
    deprecatedNotice(name) +
    ' Chat workflow launches use the detached CLI and are headless: they use CLI identity, ' +
    'return a run ID for inspection, and do not deliver progress or results to the originating chat.'
  );
}
