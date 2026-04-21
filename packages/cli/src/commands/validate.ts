/**
 * CLI commands for `hlab validate workflows` and `hlab validate commands`.
 *
 * Thin layer over @harneeslab/workflows validator: discovers, validates, formats output.
 */

import { discoverWorkflowsWithConfig } from '@harneeslab/workflows/workflow-discovery';
import {
  validateWorkflowResources,
  validateCommand,
  validateScript,
  discoverAvailableCommands,
  discoverAvailableScripts,
  findSimilar,
  makeWorkflowResult,
} from '@harneeslab/workflows/validator';
import type {
  ValidationIssue,
  WorkflowValidationResult,
  ValidationConfig,
  ScriptValidationResult,
} from '@harneeslab/workflows/validator';
import { loadConfig, loadRepoConfig } from '@harneeslab/core';

/**
 * Build ValidationConfig from the repo's .archon/config.yaml
 */
async function buildValidationConfig(cwd: string): Promise<ValidationConfig> {
  try {
    const repoConfig = await loadRepoConfig(cwd);
    return {
      loadDefaultCommands: repoConfig?.defaults?.loadDefaultCommands,
      commandFolder: repoConfig?.commands?.folder,
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return {};
    console.error(`경고: .archon/config.yaml 로드 실패: ${(e as Error).message}`);
    console.error('기본값으로 검증을 계속합니다 (config 설정은 적용되지 않습니다)');
    return {};
  }
}

// =============================================================================
// Output formatting
// =============================================================================

function formatIssueMessage(message: string): string {
  const invalidCommand = /^Invalid command name '(.+)' — must not contain/.exec(message);
  if (invalidCommand) {
    return `Command 이름 '${invalidCommand[1]}'이(가) 올바르지 않습니다 - '/', '\\', '..'를 포함하거나 '.'로 시작할 수 없습니다`;
  }

  const commandNotFound = /^Command '(.+)' not found$/.exec(message);
  if (commandNotFound) {
    return `Command '${commandNotFound[1]}'을(를) 찾지 못했습니다`;
  }

  const commandFileEmpty = /^Command file '(.+)' is empty$/.exec(message);
  if (commandFileEmpty) {
    return `Command 파일 '${commandFileEmpty[1]}'이(가) 비어 있습니다`;
  }

  const commandReadError = /^Cannot read command file '(.+)': (.+)$/.exec(message);
  if (commandReadError) {
    return `Command 파일 '${commandReadError[1]}'을(를) 읽을 수 없습니다: ${commandReadError[2]}`;
  }

  const mcpMissing = /^MCP config file not found: '(.+)'$/.exec(message);
  if (mcpMissing) {
    return `MCP config 파일을 찾지 못했습니다: '${mcpMissing[1]}'`;
  }

  const mcpObject = /^MCP config file '(.+)' must be a JSON object/.exec(message);
  if (mcpObject) {
    return `MCP config 파일 '${mcpObject[1]}'은(는) JSON object여야 합니다 (Record<string, ServerConfig>)`;
  }

  const mcpInvalidJson = /^MCP config file '(.+)' contains invalid JSON: (.+)$/.exec(message);
  if (mcpInvalidJson) {
    return `MCP config 파일 '${mcpInvalidJson[1]}'에 올바르지 않은 JSON이 있습니다: ${mcpInvalidJson[2]}`;
  }

  const skillNotFound =
    /^Skill '(.+)' not found in \.claude\/skills\/ or ~\/\.claude\/skills\/$/.exec(message);
  if (skillNotFound) {
    return `Skill '${skillNotFound[1]}'을(를) .claude/skills/ 또는 ~/.claude/skills/에서 찾지 못했습니다`;
  }

  const namedScriptNotFound = /^Named script '(.+)' not found in \.archon\/scripts\/$/.exec(
    message
  );
  if (namedScriptNotFound) {
    return `Named script '${namedScriptNotFound[1]}'을(를) .archon/scripts/에서 찾지 못했습니다`;
  }

  const scriptNotFound = /^Script '(.+)' not found in \.archon\/scripts\/$/.exec(message);
  if (scriptNotFound) {
    return `Script '${scriptNotFound[1]}'을(를) .archon/scripts/에서 찾지 못했습니다`;
  }

  const runtimeUnavailable = /^Runtime '(.+)' is not available on PATH$/.exec(message);
  if (runtimeUnavailable) {
    return `Runtime '${runtimeUnavailable[1]}'을(를) PATH에서 찾을 수 없습니다`;
  }

  const providerUnsupported =
    /^(.+) are not supported by provider '(.+)' — this will be ignored$/.exec(message);
  if (providerUnsupported) {
    return `${providerUnsupported[1]}은(는) provider '${providerUnsupported[2]}'에서 지원되지 않아 무시됩니다`;
  }

  if (message === "'deps' is ignored for bun runtime (bun auto-installs packages at runtime)") {
    return "'deps'는 bun runtime에서 무시됩니다 (bun은 실행 시 package를 자동 설치합니다)";
  }

  return message;
}

function formatIssueHint(hint: string): string {
  const createCommand = /^Create \.archon\/commands\/(.+)\.md$/.exec(hint);
  if (createCommand) {
    return `.archon/commands/${createCommand[1]}.md 파일을 만드세요`;
  }

  const createCommandOrUseExisting =
    /^Create \.archon\/commands\/(.+)\.md or use an existing command name$/.exec(hint);
  if (createCommandOrUseExisting) {
    return `.archon/commands/${createCommandOrUseExisting[1]}.md 파일을 만들거나 기존 command 이름을 사용하세요`;
  }

  const didYouMeanOrCreate = /^Did you mean: (.+)\? Or create \.archon\/commands\/(.+)\.md$/.exec(
    hint
  );
  if (didYouMeanOrCreate) {
    return `다음 command를 찾으셨나요: ${didYouMeanOrCreate[1]}? 또는 .archon/commands/${didYouMeanOrCreate[2]}.md 파일을 만드세요`;
  }

  const didYouMean = /^Did you mean: (.+)\?$/.exec(hint);
  if (didYouMean) {
    return `다음 항목을 찾으셨나요: ${didYouMean[1]}?`;
  }

  if (
    hint === 'Use a simple name like "my-command" (without path separators or the .md extension)'
  ) {
    return '"my-command"처럼 단순한 이름을 사용하세요 (경로 구분자나 .md 확장자 제외)';
  }

  if (hint === 'Use a simple name like "my-command" (without path separators)') {
    return '"my-command"처럼 단순한 이름을 사용하세요 (경로 구분자 제외)';
  }

  const createMcpFile =
    /^Create the file at (.+) with MCP server definitions \(JSON format\)\. Example:\n([\s\S]+)$/.exec(
      hint
    );
  if (createMcpFile) {
    return `${createMcpFile[1]}에 MCP server 정의 파일을 만드세요 (JSON 형식). 예:\n${createMcpFile[2]}`;
  }

  if (hint === 'The file should contain a JSON object where each key is a server name') {
    return '파일은 각 key가 server 이름인 JSON object를 포함해야 합니다';
  }

  if (hint === 'Fix the JSON syntax in the MCP config file') {
    return 'MCP config 파일의 JSON 문법을 수정하세요';
  }

  const installSkill =
    /^Install with: npx skills add <repo> — or create manually at \.claude\/skills\/(.+)\/SKILL\.md$/.exec(
      hint
    );
  if (installSkill) {
    return `설치: npx skills add <repo> 또는 .claude/skills/${installSkill[1]}/SKILL.md 파일을 직접 만드세요`;
  }

  if (hint === 'Remove the mcp field or switch to a provider that supports MCP') {
    return 'mcp 필드를 제거하거나 MCP를 지원하는 provider로 바꾸세요';
  }

  if (hint === 'Remove the skills field or switch to a provider that supports skills') {
    return 'skills 필드를 제거하거나 skills를 지원하는 provider로 바꾸세요';
  }

  if (hint === 'Remove the hooks field or switch to a provider that supports hooks') {
    return 'hooks 필드를 제거하거나 hooks를 지원하는 provider로 바꾸세요';
  }

  if (
    hint ===
    'Remove the agents field or switch to a provider that supports inline agents (e.g. claude)'
  ) {
    return 'agents 필드를 제거하거나 inline agents를 지원하는 provider로 바꾸세요 (예: claude)';
  }

  if (hint === 'Remove tool restriction fields or switch to a provider that supports them') {
    return 'tool restriction 필드를 제거하거나 이를 지원하는 provider로 바꾸세요';
  }

  const createNamedScript = /^Create \.archon\/scripts\/(.+)\.(ts|py) with your script code$/.exec(
    hint
  );
  if (createNamedScript) {
    return `.archon/scripts/${createNamedScript[1]}.${createNamedScript[2]} 파일을 만들고 script 코드를 작성하세요`;
  }

  const createScript =
    /^Create \.archon\/scripts\/(.+)\.ts \(bun\) or \.archon\/scripts\/(.+)\.py \(uv\)$/.exec(hint);
  if (createScript) {
    return `.archon/scripts/${createScript[1]}.ts (bun) 또는 .archon/scripts/${createScript[2]}.py (uv) 파일을 만드세요`;
  }

  if (hint === 'Remove deps or switch to runtime: uv if you need explicit dependency management') {
    return 'deps를 제거하거나 명시적 dependency 관리가 필요하면 runtime: uv로 바꾸세요';
  }

  if (hint === 'Check file permissions') {
    return '파일 권한을 확인하세요';
  }

  return hint;
}

function formatIssue(issue: ValidationIssue, indent = '    '): string {
  const prefix = issue.level === 'error' ? '오류' : '경고';
  const nodeStr = issue.nodeId ? ` Node(노드) '${issue.nodeId}':` : '';
  const message = formatIssueMessage(issue.message);
  let line = `${indent}${prefix} [${issue.field}]${nodeStr} ${message}`;
  if (issue.hint) {
    line += `\n${indent}  ${formatIssueHint(issue.hint)}`;
  }
  return line;
}

function formatValidationResult(displayName: string, issues: ValidationIssue[]): string {
  const hasErrors = issues.some(i => i.level === 'error');
  const hasWarnings = issues.some(i => i.level === 'warning');
  const statusLabel = hasErrors ? '오류' : hasWarnings ? '경고' : '정상';

  let output = `  ${displayName.padEnd(40, ' ')} ${statusLabel}`;
  for (const issue of issues) {
    output += '\n' + formatIssue(issue);
  }
  return output;
}

function formatWorkflowResult(result: WorkflowValidationResult): string {
  return formatValidationResult(result.workflowName, result.issues);
}

// =============================================================================
// Workflow validation command
// =============================================================================

/**
 * Validate all workflows or a specific workflow.
 * Returns exit code: 0 = all valid, 1 = errors found.
 */
export async function validateWorkflowsCommand(
  cwd: string,
  name?: string,
  json?: boolean
): Promise<number> {
  const config = await buildValidationConfig(cwd);
  const mergedConfig = await loadConfig(cwd);
  const defaultProvider = mergedConfig.assistant;
  const { workflows: workflowEntries, errors: loadErrors } = await discoverWorkflowsWithConfig(
    cwd,
    loadConfig
  );

  // Build results from load errors (Level 1-2 failures)
  const results: WorkflowValidationResult[] = [];

  for (const loadError of loadErrors) {
    results.push(
      makeWorkflowResult(
        loadError.filename.replace(/\.ya?ml$/, ''),
        [{ level: 'error', field: loadError.errorType, message: loadError.error }],
        loadError.filename
      )
    );
  }

  // Validate successfully parsed workflows (Level 3)
  for (const { workflow } of workflowEntries) {
    const issues = await validateWorkflowResources(workflow, cwd, config, defaultProvider);
    results.push(makeWorkflowResult(workflow.name, issues));
  }

  // Filter to specific workflow if name provided
  let filteredResults = results;
  if (name) {
    filteredResults = results.filter(
      r => r.workflowName === name || r.workflowName.toLowerCase() === name.toLowerCase()
    );

    if (filteredResults.length === 0) {
      const allNames = results.map(r => r.workflowName);
      const similar = findSimilar(name, allNames);
      if (json) {
        console.log(
          JSON.stringify({
            error: `Workflow '${name}' not found`,
            suggestions: similar,
            available: allNames,
          })
        );
      } else {
        console.error(`Workflow '${name}'을(를) 찾지 못했습니다.`);
        if (similar.length > 0) {
          console.error(`다음 workflow를 찾으셨나요: ${similar.map(s => `'${s}'`).join(', ')}?`);
        }
        console.error(`사용 가능한 workflow: ${allNames.join(', ')}`);
      }
      return 1;
    }
  }

  // Sort: errors first, then warnings, then ok
  filteredResults.sort((a, b) => {
    const aErrors = a.issues.filter(i => i.level === 'error').length;
    const bErrors = b.issues.filter(i => i.level === 'error').length;
    if (aErrors !== bErrors) return bErrors - aErrors;
    return a.workflowName.localeCompare(b.workflowName);
  });

  // Output
  const totalErrors = filteredResults.filter(r => !r.valid).length;
  const totalWarnings = filteredResults.filter(r =>
    r.issues.some(i => i.level === 'warning')
  ).length;

  if (json) {
    console.log(
      JSON.stringify({
        results: filteredResults,
        summary: {
          total: filteredResults.length,
          valid: filteredResults.length - totalErrors,
          errors: totalErrors,
          warnings: totalWarnings,
        },
      })
    );
  } else {
    console.log(`\nworkflow 검증 중: ${cwd}\n`);
    for (const result of filteredResults) {
      console.log(formatWorkflowResult(result));
    }
    console.log(
      `\n결과: ${filteredResults.length - totalErrors}개 정상, ${totalErrors}개 오류${totalWarnings > 0 ? `, ${totalWarnings}개 경고` : ''}`
    );
  }

  return totalErrors > 0 ? 1 : 0;
}

// =============================================================================
// Command and script validation command
// =============================================================================

function formatScriptResult(result: ScriptValidationResult): string {
  return formatValidationResult(`[script] ${result.scriptName}`, result.issues);
}

/**
 * Validate all commands or a specific command.
 * Also validates scripts from .archon/scripts/ alongside commands.
 * Returns exit code: 0 = all valid, 1 = errors found.
 */
export async function validateCommandsCommand(
  cwd: string,
  name?: string,
  jsonOutput?: boolean
): Promise<number> {
  const config = await buildValidationConfig(cwd);

  if (name) {
    // Validate a single command
    const result = await validateCommand(name, cwd, config);

    if (jsonOutput) {
      console.log(JSON.stringify(result));
    } else {
      const statusLabel = result.valid ? '정상' : '오류';
      console.log(`\n  ${result.commandName.padEnd(40, ' ')} ${statusLabel}`);
      for (const issue of result.issues) {
        console.log(formatIssue(issue));
      }
    }

    return result.valid ? 0 : 1;
  }

  // Validate all commands
  const allCommands = await discoverAvailableCommands(cwd, config);
  const commandResults = await Promise.all(
    allCommands.map(cmd => validateCommand(cmd, cwd, config))
  );

  // Validate all scripts
  const allScripts = await discoverAvailableScripts(cwd);
  const scriptResults = await Promise.all(allScripts.map(s => validateScript(s.name, cwd)));

  const totalCommandErrors = commandResults.filter(r => !r.valid).length;
  const totalScriptErrors = scriptResults.filter(r => !r.valid).length;
  const totalErrors = totalCommandErrors + totalScriptErrors;

  if (jsonOutput) {
    console.log(
      JSON.stringify({
        results: commandResults,
        scripts: scriptResults,
        summary: {
          total: commandResults.length + scriptResults.length,
          valid: commandResults.length + scriptResults.length - totalErrors,
          errors: totalErrors,
        },
      })
    );
  } else {
    if (commandResults.length === 0 && scriptResults.length === 0) {
      console.log('\ncommand 또는 script를 찾지 못했습니다.');
      return 0;
    }

    console.log(`\ncommand/script 검증 중: ${cwd}\n`);
    for (const result of commandResults) {
      const statusLabel = result.valid ? '정상' : '오류';
      console.log(`  ${result.commandName.padEnd(40, ' ')} ${statusLabel}`);
      for (const issue of result.issues) {
        console.log(formatIssue(issue));
      }
    }
    for (const result of scriptResults) {
      console.log(formatScriptResult(result));
    }
    console.log(
      `\n결과: ${commandResults.length + scriptResults.length - totalErrors}개 정상, ${totalErrors}개 오류`
    );
  }

  return totalErrors > 0 ? 1 : 0;
}
