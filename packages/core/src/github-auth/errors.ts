/**
 * Typed errors for the GitHub App auth module.
 *
 * Both classes carry enough context (owner/repo or cause) for adapter code to
 * surface a clean user message via classifyAndFormatError without losing the
 * underlying detail in logs.
 */

export class AppNotInstalledError extends Error {
  constructor(
    public readonly owner: string,
    public readonly repo: string,
    public readonly appSlug?: string
  ) {
    const installLink = appSlug ? ` (https://github.com/apps/${appSlug}/installations/new)` : '';
    super(
      `The Archon GitHub App is not installed on "${owner}". ` +
        `Install it on the ${owner} account${installLink} ` +
        `to grant Archon access to ${owner}/${repo}.`
    );
    this.name = 'AppNotInstalledError';
  }
}

export class AppPrivateKeyError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AppPrivateKeyError';
  }
}
