#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN_ENV_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

interface GhAuthHostEntry {
  state?: string;
  active?: boolean;
  login?: string;
  tokenSource?: string;
}

interface GhAuthStatusPayload {
  hosts?: Record<string, GhAuthHostEntry[]>;
}

interface AuthDecision {
  env: NodeJS.ProcessEnv;
  host: string | null;
  chosenAuthSource: 'env' | 'stored' | 'ambient';
  activeLogin: string | null;
  storedLogin: string | null;
  actorSwitchDetected: boolean;
  envTokenNames: string[];
}

interface PrRequest {
  draft?: boolean;
  ready?: boolean;
  allowActorSwitch?: boolean;
}

interface PrInfo {
  number: number;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  title: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function readRequiredText(path: string, label: string): string {
  const value = readText(path);
  if (value === null || value.trim().length === 0) {
    fail(`${label} is missing or empty at ${path}`);
  }
  return value;
}

function writeText(path: string, content: string): void {
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  writeFileSync(path, normalized, 'utf8');
}

function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    fail(`${command} ${args.join(' ')} failed: ${result.error.message}`);
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = stderr.trim() || stdout.trim() || `exit status ${String(result.status)}`;
    fail(`${command} ${args.join(' ')} failed: ${detail}`);
  }

  return { stdout, stderr };
}

function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const sshLike = /^(?:ssh:\/\/)?git@([^/:]+)[:/]/i.exec(trimmed);
  if (sshLike?.[1]) return sshLike[1].toLowerCase();

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getEnvTokenNames(env: NodeJS.ProcessEnv): string[] {
  return TOKEN_ENV_NAMES.filter(name => {
    const value = env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function stripGithubCliTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GH_TOKEN: ghToken, GITHUB_TOKEN: githubToken, ...nextEnv } = env;
  void ghToken;
  void githubToken;
  return nextEnv;
}

function isEnvTokenSource(source: string | undefined): boolean {
  return source === 'GH_TOKEN' || source === 'GITHUB_TOKEN';
}

function isStoredTokenSource(source: string | undefined): boolean {
  return typeof source === 'string' && source.length > 0 && !isEnvTokenSource(source);
}

function firstSuccessfulEntry(entries: GhAuthHostEntry[]): GhAuthHostEntry | null {
  return (
    entries.find(entry => entry.state === 'success' && entry.active) ??
    entries.find(entry => entry.state === 'success') ??
    null
  );
}

function firstSuccessfulStoredEntry(entries: GhAuthHostEntry[]): GhAuthHostEntry | null {
  return (
    entries.find(
      entry =>
        entry.state === 'success' && entry.active && isStoredTokenSource(entry.tokenSource)
    ) ??
    entries.find(entry => entry.state === 'success' && isStoredTokenSource(entry.tokenSource)) ??
    null
  );
}

function getAuthEntriesForHost(host: string, env: NodeJS.ProcessEnv): GhAuthHostEntry[] | null {
  const result = runCommand(
    'gh',
    ['auth', 'status', '--hostname', host, '--json', 'hosts'],
    { env, allowFailure: true }
  );

  if (result.stderr.trim().length > 0 && result.stdout.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout) as GhAuthStatusPayload;
    const entries = parsed.hosts?.[host];
    return Array.isArray(entries) ? entries : [];
  } catch {
    return null;
  }
}

function resolveAuthDecision(host: string | null): AuthDecision {
  const baseEnv = { ...process.env };
  const envTokenNames = getEnvTokenNames(baseEnv);
  if (host === null || envTokenNames.length === 0) {
    return {
      env: baseEnv,
      host,
      chosenAuthSource: envTokenNames.length > 0 ? 'env' : 'ambient',
      activeLogin: null,
      storedLogin: null,
      actorSwitchDetected: false,
      envTokenNames,
    };
  }

  const entries = getAuthEntriesForHost(host, baseEnv);
  if (entries === null) {
    return {
      env: baseEnv,
      host,
      chosenAuthSource: 'env',
      activeLogin: null,
      storedLogin: null,
      actorSwitchDetected: false,
      envTokenNames,
    };
  }

  const activeEntry = firstSuccessfulEntry(entries);
  const storedEntry = firstSuccessfulStoredEntry(entries);
  if (!storedEntry) {
    return {
      env: baseEnv,
      host,
      chosenAuthSource: 'env',
      activeLogin: activeEntry?.login ?? null,
      storedLogin: null,
      actorSwitchDetected: false,
      envTokenNames,
    };
  }

  const activeLogin = activeEntry?.login ?? null;
  const storedLogin = storedEntry.login ?? null;
  return {
    env: stripGithubCliTokens(baseEnv),
    host,
    chosenAuthSource: 'stored',
    activeLogin,
    storedLogin,
    actorSwitchDetected:
      typeof activeLogin === 'string' &&
      activeLogin.length > 0 &&
      typeof storedLogin === 'string' &&
      storedLogin.length > 0 &&
      activeLogin !== storedLogin,
    envTokenNames,
  };
}

function ensureMutationAllowed(decision: AuthDecision, request: PrRequest): void {
  if (decision.actorSwitchDetected && request.allowActorSwitch !== true) {
    fail(
      `refusing GitHub mutation because fallback would switch actors (${decision.activeLogin ?? 'unknown-env-actor'} -> ${decision.storedLogin ?? 'unknown-stored-actor'}) on ${decision.host ?? 'unknown-host'}`
    );
  }
}

function runGit(args: string[], allowFailure = false): CommandResult {
  return runCommand('git', args, { allowFailure });
}

function runGh(args: string[], env: NodeJS.ProcessEnv): CommandResult {
  return runCommand('gh', args, { env });
}

function detectBaseBranch(): string {
  const configured =
    process.env.ARCHON_BASE_BRANCH?.trim() || process.env.BASE_BRANCH?.trim() || '';
  if (configured.length > 0) return configured;

  const symbolicRef = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], true);
  const ref = symbolicRef.stdout.trim();
  if (ref.includes('/')) {
    return ref.split('/').at(-1) ?? 'main';
  }

  return 'main';
}

function readPrRequest(path: string): PrRequest {
  const raw = readText(path);
  if (raw === null || raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw) as PrRequest;
  } catch (error) {
    fail(`invalid pr-request.json at ${path}: ${(error as Error).message}`);
  }
}

function getCurrentPr(env: NodeJS.ProcessEnv): PrInfo | null {
  const result = runCommand(
    'gh',
    ['pr', 'view', 'HEAD', '--json', 'number,url,isDraft,headRefName,baseRefName,title'],
    { env, allowFailure: true }
  );

  if (result.stdout.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(result.stdout) as PrInfo;
  } catch {
    return null;
  }
}

function replacePlaceholders(template: string, values: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(key, value);
  }
  return output;
}

function buildPrReadyMarkdown(pr: PrInfo, commitSha: string): string {
  const state = pr.isDraft ? 'Draft' : 'Ready for Review';
  return [
    '# PR Ready',
    '',
    `**Generated**: ${new Date().toISOString()}`,
    '',
    '## Pull Request',
    '',
    `- Number: #${String(pr.number)}`,
    `- URL: ${pr.url}`,
    `- Branch: \`${pr.headRefName}\` -> \`${pr.baseRefName}\``,
    `- State: ${state}`,
    `- Title: ${pr.title}`,
    '',
    '## Commit',
    '',
    `- HEAD: \`${commitSha}\``,
  ].join('\n');
}

function buildDefaultSummary(pr: PrInfo): string {
  const state = pr.isDraft ? 'Draft' : 'Ready for Review';
  return [
    '## PR Updated',
    '',
    `**URL**: ${pr.url}`,
    `**Branch**: ${pr.headRefName} -> ${pr.baseRefName}`,
    `**State**: ${state}`,
    `**Title**: ${pr.title}`,
  ].join('\n');
}

function getStatusLines(): string[] {
  return runGit(['status', '--porcelain'])
    .stdout.split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0);
}

function getStagedFiles(): string[] {
  return runGit(['diff', '--cached', '--name-only'])
    .stdout.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

function assertNoSensitiveStagedFiles(files: string[]): void {
  const sensitiveFiles = files.filter(file =>
    /(^|\/)\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$/i.test(file)
  );
  if (sensitiveFiles.length > 0) {
    fail(`refusing to commit sensitive-looking files: ${sensitiveFiles.join(', ')}`);
  }
}

const artifactsDir =
  process.env.ARCHON_ARTIFACTS_DIR?.trim() || process.env.ARTIFACTS_DIR?.trim() || '';
if (artifactsDir.length === 0) {
  fail('ARCHON_ARTIFACTS_DIR is required');
}

const titlePath = join(artifactsDir, 'pr-title.txt');
const bodyPath = join(artifactsDir, 'pr-body.md');
const commitMessagePath = join(artifactsDir, 'commit-message.txt');
const requestPath = join(artifactsDir, 'pr-request.json');
const summaryPath = join(artifactsDir, 'pr-summary.md');
const prResultPath = join(artifactsDir, 'pr-result.json');
const prNumberPath = join(artifactsDir, '.pr-number');
const prUrlPath = join(artifactsDir, '.pr-url');
const prReadyPath = join(artifactsDir, 'pr-ready.md');

const title = readRequiredText(titlePath, 'PR title').trim().split('\n')[0]?.trim();
if (!title) {
  fail(`PR title is empty in ${titlePath}`);
}
readRequiredText(bodyPath, 'PR body');

const request = readPrRequest(requestPath);
const baseBranch = detectBaseBranch();
const branch = runGit(['branch', '--show-current']).stdout.trim();
if (branch.length === 0) {
  fail('could not determine current branch');
}

if (getStatusLines().length > 0) {
  readRequiredText(commitMessagePath, 'commit message');
  runGit(['add', '-A']);
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    fail('git status reported changes, but nothing became staged after git add -A');
  }
  assertNoSensitiveStagedFiles(stagedFiles);
  runGit(['commit', '-F', commitMessagePath]);
}

runGit(['push', '-u', 'origin', 'HEAD']);

const remoteUrl = runGit(['remote', 'get-url', 'origin']).stdout.trim();
const remoteHost = parseRemoteHost(remoteUrl);
const authDecision = resolveAuthDecision(remoteHost);
if (authDecision.chosenAuthSource === 'stored' && authDecision.envTokenNames.length > 0) {
  console.error(
    `Using stored gh auth for ${authDecision.host ?? 'default host'} after stripping env token(s): ${authDecision.envTokenNames.join(', ')}`
  );
}

let pr = getCurrentPr(authDecision.env);
if (pr) {
  ensureMutationAllowed(authDecision, request);
  runGh(['pr', 'edit', String(pr.number), '--title', title, '--body-file', bodyPath], authDecision.env);
} else {
  ensureMutationAllowed(authDecision, request);
  const createArgs = ['pr', 'create', '--title', title, '--body-file', bodyPath, '--base', baseBranch];
  if (request.draft === true) {
    createArgs.push('--draft');
  }
  runGh(createArgs, authDecision.env);
}

pr = getCurrentPr(authDecision.env);
if (!pr) {
  fail('gh pr view could not resolve the current branch PR after create/edit');
}

const shouldEnsureReady = request.ready === true || request.draft === false;
if (shouldEnsureReady && pr.isDraft) {
  ensureMutationAllowed(authDecision, request);
  runGh(['pr', 'ready', String(pr.number)], authDecision.env);
  pr = getCurrentPr(authDecision.env);
  if (!pr) {
    fail('gh pr view could not resolve the PR after gh pr ready');
  }
}

writeText(prNumberPath, String(pr.number));
writeText(prUrlPath, pr.url);

const commitSha = runGit(['rev-parse', 'HEAD']).stdout.trim();
const state = pr.isDraft ? 'Draft' : 'Ready for Review';
writeText(prReadyPath, buildPrReadyMarkdown(pr, commitSha));
writeText(
  prResultPath,
  JSON.stringify(
    {
      number: pr.number,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      title: pr.title,
      branch,
      baseBranch,
      commitSha,
      auth: {
        host: authDecision.host,
        source: authDecision.chosenAuthSource,
        actorSwitchDetected: authDecision.actorSwitchDetected,
      },
    },
    null,
    2
  )
);

const summaryTemplate = readText(summaryPath);
const summary = summaryTemplate
  ? replacePlaceholders(summaryTemplate, {
      '__PR_NUMBER__': String(pr.number),
      '__PR_URL__': pr.url,
      '__PR_STATE__': state,
      '__PR_BRANCH__': pr.headRefName,
      '__PR_BASE__': pr.baseRefName,
      '__PR_TITLE__': pr.title,
      '__COMMIT_SHA__': commitSha,
    })
  : buildDefaultSummary(pr);

console.log(summary.trim());
