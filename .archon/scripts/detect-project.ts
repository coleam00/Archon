#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

interface DetectionResult {
  projectType: string;
  installCmd: string;
  validateCmd: string;
  typecheckCmd: string;
  lintCmd: string;
  testCmd: string;
  formatCmd: string;
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function packageHasScript(name: string): boolean {
  const raw = readText('package.json');
  if (raw === null) return false;

  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return typeof parsed.scripts?.[name] === 'string';
  } catch {
    return raw.includes(`"${name}"`);
  }
}

function makefileHasTarget(name: string): boolean {
  const raw = readText('Makefile');
  if (raw === null) return false;
  return new RegExp(`^${name}:`, 'm').test(raw);
}

function hasPythonTestSignal(): boolean {
  if (!fileExists('tests')) return false;

  try {
    return readdirSync('tests').some(entry => entry.startsWith('test_') && entry.endsWith('.py'));
  } catch {
    return false;
  }
}

function resolveSourceRepo(): string {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  if (result.status !== 0) return '';

  const gitCommon = result.stdout.trim();
  if (gitCommon.length === 0) return '';

  const absCommon = isAbsolute(gitCommon) ? gitCommon : join(process.cwd(), gitCommon);
  return dirname(absCommon);
}

function commandExists(command: string): boolean {
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

function detectProject(): DetectionResult {
  const result: DetectionResult = {
    projectType: 'unknown',
    installCmd: '',
    validateCmd: '',
    typecheckCmd: '',
    lintCmd: '',
    testCmd: '',
    formatCmd: '',
  };

  if (fileExists('bun.lock') || fileExists('bun.lockb')) {
    result.projectType = 'bun';
    result.installCmd = 'bun install --frozen-lockfile';
    if (packageHasScript('validate')) result.validateCmd = 'bun run validate';
    if (packageHasScript('type-check')) result.typecheckCmd = 'bun run type-check';
    if (packageHasScript('lint')) result.lintCmd = 'bun run lint';
    if (packageHasScript('test')) result.testCmd = 'bun run test';
    if (packageHasScript('format:check')) result.formatCmd = 'bun run format:check';
    return finalize(result);
  }

  if (
    fileExists('pyproject.toml') ||
    fileExists('requirements.txt') ||
    fileExists('setup.py') ||
    hasPythonTestSignal()
  ) {
    result.projectType = 'python';

    const sourceRepo = resolveSourceRepo();
    let venvBin = '';
    if (fileExists('.venv') && fileExists('.venv/bin/python')) {
      venvBin = '.venv/bin';
    } else if (sourceRepo && fileExists(join(sourceRepo, '.venv/bin/python'))) {
      venvBin = join(sourceRepo, '.venv/bin');
    }

    if (venvBin) {
      if (fileExists(join(venvBin, 'pytest'))) result.testCmd = `${venvBin}/pytest tests/`;
      if (fileExists(join(venvBin, 'ruff'))) {
        result.lintCmd = `${venvBin}/ruff check .`;
        result.formatCmd = `${venvBin}/ruff format --check .`;
      }
      if (fileExists(join(venvBin, 'mypy'))) result.typecheckCmd = `${venvBin}/mypy .`;
      if (fileExists(join(venvBin, 'pyright'))) {
        result.typecheckCmd = result.typecheckCmd
          ? `${result.typecheckCmd} && ${venvBin}/pyright`
          : `${venvBin}/pyright`;
      }
    }

    if (fileExists('pyproject.toml')) {
      if (fileExists('uv.lock')) {
        result.installCmd = 'uv sync';
      } else if (fileExists('poetry.lock')) {
        result.installCmd = 'poetry install';
      } else if (venvBin) {
        result.installCmd = `${venvBin}/python -m pip install -e .`;
      }
    } else if (fileExists('requirements.txt') && venvBin) {
      result.installCmd = `${venvBin}/python -m pip install -r requirements.txt`;
    }

    return finalize(result);
  }

  if (fileExists('package.json')) {
    result.projectType = 'node';
    let run = 'npm run';
    if (fileExists('pnpm-lock.yaml')) {
      run = 'pnpm';
      result.installCmd = 'pnpm install --frozen-lockfile';
    } else if (fileExists('yarn.lock')) {
      run = 'yarn';
      result.installCmd = 'yarn install --frozen-lockfile';
    } else {
      result.installCmd = 'npm ci';
    }

    if (packageHasScript('validate')) result.validateCmd = `${run} validate`;
    if (packageHasScript('type-check')) result.typecheckCmd = `${run} type-check`;
    if (packageHasScript('lint')) result.lintCmd = `${run} lint`;
    if (packageHasScript('test')) result.testCmd = `${run} test`;
    if (packageHasScript('format:check')) result.formatCmd = `${run} format:check`;
    return finalize(result);
  }

  if (fileExists('go.mod')) {
    result.projectType = 'go';
    result.installCmd = 'go mod download';
    result.testCmd = 'go test ./...';
    result.typecheckCmd = 'go vet ./...';
    if (commandExists('golangci-lint')) result.lintCmd = 'golangci-lint run';
    result.formatCmd = 'gofmt -l .';
    return finalize(result);
  }

  if (fileExists('Cargo.toml')) {
    result.projectType = 'rust';
    result.installCmd = 'cargo fetch';
    result.testCmd = 'cargo test';
    result.typecheckCmd = 'cargo check';
    result.lintCmd = 'cargo clippy -- -D warnings';
    result.formatCmd = 'cargo fmt -- --check';
    return finalize(result);
  }

  if (fileExists('Makefile')) {
    result.projectType = 'makefile';
    if (makefileHasTarget('test')) result.testCmd = 'make test';
    if (makefileHasTarget('lint')) result.lintCmd = 'make lint';
    if (makefileHasTarget('check')) result.validateCmd = 'make check';
  }

  return finalize(result);
}

function finalize(result: DetectionResult): DetectionResult {
  if (result.validateCmd.length === 0) {
    const parts = [
      result.typecheckCmd,
      result.lintCmd,
      result.testCmd,
      result.formatCmd,
    ].filter(part => part.length > 0);
    result.validateCmd = parts.join(' && ');
  }

  return result;
}

function emit(result: DetectionResult): void {
  console.log('=== PROJECT DETECTION ===');
  console.log(`PROJECT_TYPE=${result.projectType}`);
  console.log(`INSTALL_CMD=${result.installCmd}`);
  console.log(`VALIDATE_CMD=${result.validateCmd}`);
  console.log(`TYPECHECK_CMD=${result.typecheckCmd}`);
  console.log(`LINT_CMD=${result.lintCmd}`);
  console.log(`TEST_CMD=${result.testCmd}`);
  console.log(`FORMAT_CMD=${result.formatCmd}`);
  console.log('=== END DETECTION ===');

  if (
    result.validateCmd.length === 0 &&
    result.testCmd.length === 0 &&
    result.typecheckCmd.length === 0 &&
    result.lintCmd.length === 0
  ) {
    console.log('');
    console.log('NOTE: No automated validators detected in this project.');
    console.log('The implement loop will proceed without automated validation gates.');
    console.log('Human review is required before merging any changes.');
  }
}

emit(detectProject());
