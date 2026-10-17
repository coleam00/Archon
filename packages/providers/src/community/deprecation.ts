/** Docs path of the deprecated-providers section; the capability matrix links it too. */
export const DEPRECATED_PROVIDERS_DOCS_PATH =
  '/getting-started/ai-assistants/#deprecated-providers';

/**
 * Notice for a bundled community provider that no maintainer owns. It promises no
 * removal date: the provider stays until a community owner publishes it as a plugin.
 */
export function unownedProviderNotice(name: string): string {
  return (
    `${name} is deprecated: no Archon maintainer owns it. It keeps working and stays bundled ` +
    'until a community owner publishes it as a plugin. To publish a community provider plugin, see ' +
    'https://archon.diy/contributing/adding-a-community-provider/'
  );
}
