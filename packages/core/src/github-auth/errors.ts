/**
 * Typed errors for the GitHub App auth module.
 *
 * AppNotInstalledError carries owner/repo so adapter code can surface a clean
 * user message via classifyAndFormatError. AppPrivateKeyError messages never
 * repeat configured values, which may be key material.
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
  constructor(message: string) {
    super(message);
    this.name = 'AppPrivateKeyError';
  }
}
