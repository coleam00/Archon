/**
 * Notice for a bundled community provider that no maintainer owns. It promises no
 * removal date: the provider stays until a community owner publishes it as a plugin.
 */
export function unownedProviderNotice(name: string): string {
  return (
    `${name} is deprecated: no Archon maintainer owns it. It keeps working and stays bundled ` +
    'until a community owner publishes it as a plugin. To take it on or follow the plan, see ' +
    'https://archon.diy/getting-started/ai-assistants/#deprecated-providers'
  );
}
