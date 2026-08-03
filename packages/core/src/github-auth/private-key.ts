/**
 * Resolve the GitHub App private key from environment variables.
 *
 * Order of preference:
 *   1. GITHUB_APP_PRIVATE_KEY — PEM contents inline. Supports the .env
 *      convention of representing newlines as the literal two-char `\n`.
 *   2. GITHUB_APP_PRIVATE_KEY_PATH — absolute path to a `.pem` file.
 *
 * Throws AppPrivateKeyError on missing config or unparseable PEM. We don't
 * crypto-validate the key here — that happens at the first JWT signing inside
 * `@octokit/auth-app`; this layer only catches obviously-bad shapes (missing
 * BEGIN/END markers) so the failure mode is "fail at bootstrap" rather than
 * "fail at first webhook".
 */
import { readFileSync } from 'node:fs';
import { AppPrivateKeyError } from './errors';

export function loadAppPrivateKey(env: NodeJS.ProcessEnv = process.env): string {
  const inline = env.GITHUB_APP_PRIVATE_KEY;
  if (inline?.trim()) {
    // Allow `KEY="...\n..."` style .env values where newlines are escape-
    // encoded. Both `\\n` (two-char escape from a quoted .env value) and
    // `\\r\\n` (Windows-edited .env) collapse to real `\n`.
    const normalized = inline.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n');
    assertLooksLikePem(normalized);
    return normalized;
  }
  const path = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path?.trim()) {
    try {
      const raw = readFileSync(path, 'utf8');
      // Windows-edited .pem files arrive with CRLF; OpenSSL tolerates it but
      // some SSH-style key parsers don't. Normalise so downstream JWT signing
      // never has to care.
      const contents = raw.replace(/\r\n/g, '\n');
      assertLooksLikePem(contents);
      return contents;
    } catch (err) {
      if (err instanceof AppPrivateKeyError) throw err;
      throw new AppPrivateKeyError(
        `Failed to read GITHUB_APP_PRIVATE_KEY_PATH (${path}): ${(err as Error).message}`,
        err
      );
    }
  }
  throw new AppPrivateKeyError(
    'GITHUB_APP_ID is set but no private key was provided. ' +
      'Set GITHUB_APP_PRIVATE_KEY (inline PEM) or GITHUB_APP_PRIVATE_KEY_PATH (path to .pem).'
  );
}

function assertLooksLikePem(s: string): void {
  if (!s.includes('BEGIN') || !s.includes('PRIVATE KEY') || !s.includes('END')) {
    throw new AppPrivateKeyError(
      'Provided value is not a valid PEM-encoded private key (missing BEGIN/END markers).'
    );
  }
}
