/** Docs path of the deprecated-providers section; the capability matrix links it too. */
export const DEPRECATED_PROVIDERS_DOCS_PATH =
  '/getting-started/ai-assistants/#deprecated-providers';

/**
 * Notice for a bundled provider or chat adapter that no maintainer owns and that is
 * removed in the next minor release. It warns; the feature keeps working until removal.
 */
export function deprecatedForRemovalNotice(name: string): string {
  return (
    `${name} is deprecated and will be removed in the next minor release: no Archon maintainer ` +
    'owns it. It keeps working until then. If you need it, build your own plugin: ' +
    'https://archon.diy/guides/publishing-plugins/'
  );
}

/** Chat providers without native tools use the detached CLI until removal. */
export function deprecatedChatProviderNotice(name: string): string {
  return (
    deprecatedForRemovalNotice(name) +
    ' Chat workflow launches use the detached CLI and are headless: they use CLI identity, ' +
    'return a run ID for inspection, and do not deliver progress or results to the originating chat.'
  );
}
