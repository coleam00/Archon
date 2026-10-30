/**
 * One route per non-workflow CLI command: map parsed argv onto the command
 * module and return the exit code. Command modules load lazily so CLI startup
 * stays cheap.
 */
import { resolve } from 'path';
import { BUNDLED_VERSION, getPluginsPath } from '@archon/paths';
import { attachmentUsage, isAttachmentVerb, publicAttachmentEntries } from '../attachment-commands';
import { type CliRouteContext, fail, printUsageFor } from './context';
import { loadRoute, usesDatabaseStore } from './route-loader';

export async function runForge({
  subcommand,
  values,
  forgeTrustedEnv,
}: CliRouteContext): Promise<number> {
  const { forgeCommand } = await loadRoute(() => import('../commands/forge'));
  return await forgeCommand(subcommand, {
    data: typeof values.data === 'string' ? values.data : undefined,
    dataFile: typeof values['data-file'] === 'string' ? values['data-file'] : undefined,
    trustedEnv: forgeTrustedEnv,
  });
}

// `archon continue` was removed (#2846). Routed before the git gate so stale
// invocations get the replacement pointer in any directory.
export async function runRemovedContinue({ json }: CliRouteContext): Promise<number> {
  return await fail(
    json,
    "Removed: 'archon continue' inferred a run from a branch name.\n" +
      'Use: archon workflow run <name> --adopt <run-id> <input>\n' +
      'Find a prior run id with: archon workflow runs --open (or workflow get <run-id>)'
  );
}

export async function runProvider({
  subcommand,
  positionals,
  cwd,
}: CliRouteContext): Promise<number> {
  const { providerCommand } = await loadRoute(() => import('../commands/provider'), {
    providers: false,
  });
  return await providerCommand(subcommand, positionals.slice(2), {
    pluginsDir: getPluginsPath(),
    archonVersion: BUNDLED_VERSION,
    projectDir: cwd,
  });
}

export async function runPlugin({
  subcommand,
  positionals,
  cwd,
}: CliRouteContext): Promise<number> {
  const { pluginCommand } = await loadRoute(() => import('../commands/plugin'), {
    providers: false,
  });
  const { getArchonVersion } = await loadRoute(() => import('../commands/version'), {
    providers: false,
  });
  return await pluginCommand(subcommand, positionals.slice(2), {
    // The trusted plugins directory forge and workflow-pack discovery read, so repo
    // env cannot redirect where an install lands.
    pluginsDir: getPluginsPath(),
    archonVersion: await getArchonVersion(),
    projectDir: cwd,
  });
}

export async function runState({
  subcommand,
  positionals,
  values,
  cwd,
}: CliRouteContext): Promise<number> {
  const database = await usesDatabaseStore();
  const { stateCommand } = await loadRoute(() => import('../commands/state'), { database });
  const { createCliWorkflowHost } = await import('../utils/workflow-host');
  const storeKind = database
    ? (await import('@archon/core/db/connection')).getDatabaseType()
    : 'files';
  return await stateCommand(
    await createCliWorkflowHost(),
    subcommand,
    positionals.slice(2),
    {
      cwd,
      ...(typeof values['if-revision'] === 'string' ? { ifRevision: values['if-revision'] } : {}),
      ...(typeof values.limit === 'string' ? { limit: values.limit } : {}),
      ...(typeof values.prefix === 'string' ? { prefix: values.prefix } : {}),
      ...(typeof values.project === 'string' ? { project: values.project } : {}),
      ...(values.install === true ? { install: true } : {}),
      ...(values.raw === true ? { raw: true } : {}),
      ...(values.values === true ? { values: true } : {}),
    },
    { storeKind }
  );
}

export async function runMetrics({ positionals, values }: CliRouteContext): Promise<number> {
  const { metricsCommand } = await loadRoute(() => import('../commands/metrics'), {
    database: await usesDatabaseStore(),
  });
  const { createCliWorkflowHost } = await import('../utils/workflow-host');
  if (positionals[2] !== undefined) {
    return await fail(
      values.json === true,
      'Usage: archon metrics [name] [--since <7d|24h|2w|ISO>] [--until <ISO>] [--subject <s>] [--project <id|name|key>] [--json]'
    );
  }
  const option = (key: string): string | undefined =>
    typeof values[key] === 'string' ? values[key] : undefined;
  return await metricsCommand(await createCliWorkflowHost(), positionals[1], {
    since: option('since'),
    until: option('until'),
    subject: option('subject'),
    project: option('project'),
    json: values.json === true,
  });
}

export async function runTrigger({
  subcommand,
  positionals,
  values,
}: CliRouteContext): Promise<number> {
  const { triggerCommand, spawnAdmitted } = await loadRoute(() => import('../commands/trigger'), {
    database: await usesDatabaseStore(),
  });
  const { createCliWorkflowHost } = await import('../utils/workflow-host');
  const host = await createCliWorkflowHost(true);
  await triggerCommand(
    host,
    subcommand,
    positionals.slice(2),
    {
      config: typeof values.config === 'string' ? values.config : undefined,
      host: typeof values.host === 'string' ? values.host : undefined,
      owner: typeof values.owner === 'string' ? values.owner : undefined,
      deliveryId: typeof values['delivery-id'] === 'string' ? values['delivery-id'] : undefined,
      inputs: typeof values.inputs === 'string' ? values.inputs : undefined,
      limit: typeof values.limit === 'string' ? values.limit : undefined,
      yes: values.yes === true,
    },
    (requestId, hostId) => spawnAdmitted(host, requestId, hostId)
  );
  return 0;
}

export async function runVersion(): Promise<number> {
  const { versionCommand } = await import('../commands/version');
  await versionCommand();
  return 0;
}

export async function runHelp({ positionals }: CliRouteContext): Promise<number> {
  // Mirror `archon <command> [--subcommand] --help`: bare `archon help`
  // is the global index; `archon help <cmd>` scopes to one command;
  // `archon help <cmd> <subcmd>` scopes further to one subcommand.
  await printUsageFor(positionals.slice(1));
  return 0;
}

export async function runChat({ positionals, json }: CliRouteContext): Promise<number> {
  const chatMessage = positionals.slice(1).join(' ');
  if (json) return await fail(json, 'Chat does not support --json. Use archon chat <message>.');
  if (!chatMessage) return await fail(json, 'Usage: archon chat <message>');
  const { chatCommand } = await loadRoute(() => import('../commands/chat'), {
    database: true,
  });
  await chatCommand(chatMessage);
  return 0;
}

export async function runSetup({
  values,
  cwd,
  json,
  inheritedEnv,
}: CliRouteContext): Promise<number> {
  const rawScope = values.scope as string | undefined;
  if (rawScope !== undefined && rawScope !== 'home' && rawScope !== 'project') {
    return await fail(json, `Error: Invalid --scope: "${rawScope}". Must be "home" or "project".`);
  }
  const scope: 'home' | 'project' = rawScope ?? 'home';
  const forceFlag = (values.force as boolean | undefined) ?? false;
  // For --scope project, resolve to the git repo root so running from a
  // subdirectory writes to <repo-root>/.archon/.env (what loadArchonEnv
  // reads at boot) — not <subdir>/.archon/.env.
  let repoPath = cwd;
  if (scope === 'project') {
    const git = await import('@archon/git');
    const repoRoot = await git.findRepoRoot(cwd);
    if (!repoRoot) {
      return await fail(
        json,
        [
          'Error: --scope project requires running from inside a git repository.',
          'Run from the repo root, pass --cwd <repo>, or use --scope home.',
        ].join('\n')
      );
    }
    repoPath = repoRoot;
  }
  const { setupCommand } = await loadRoute(() => import('../commands/setup'), {
    database: true,
  });
  const providers = (values.providers as string | undefined) ?? process.env.ARCHON_PROVIDERS;
  return await setupCommand({
    inheritedEnv,
    spawn: values.spawn as boolean | undefined,
    repoPath,
    scope,
    force: forceFlag,
    ...(providers !== undefined
      ? {
          providers: providers
            .split(',')
            .map(id => id.trim())
            .filter(Boolean),
        }
      : {}),
  });
}

export async function runProject({ positionals, json }: CliRouteContext): Promise<number> {
  const { projectCommand } = await loadRoute(() => import('../commands/project'), {
    providers: false,
    database: await usesDatabaseStore(),
  });
  return await projectCommand(positionals.slice(1), json);
}

export async function runUser({
  subcommand,
  positionals,
  values,
  json,
}: CliRouteContext): Promise<number> {
  const { userListCommand, userRoleCommand, userLinkCommand } = await loadRoute(
    () => import('../commands/user'),
    { database: true }
  );
  switch (subcommand) {
    case 'list':
      if (positionals.length !== 2) return await fail(json, 'Usage: archon user list');
      await userListCommand();
      return 0;
    case 'role':
      if (positionals.length !== 4) {
        const { userRoleSchema } = await import('@archon/core/schemas/user');
        return await fail(
          json,
          `Usage: archon user role <id> <${userRoleSchema.options.join('|')}>`
        );
      }
      await userRoleCommand(positionals[2] ?? '', positionals[3] ?? '');
      return 0;
    case 'link':
      if (positionals.length !== 4) {
        return await fail(
          json,
          'Usage: archon user link <user-id> <platform>:<platform-user-id> [--move]'
        );
      }
      await userLinkCommand(positionals[2] ?? '', positionals[3] ?? '', Boolean(values.move));
      return 0;
    default:
      return await fail(json, 'Usage: archon user <list|role|link>');
  }
}

export async function runIsolation({
  subcommand,
  positionals,
  values,
  json,
}: CliRouteContext): Promise<number> {
  const { isolationListCommand, isolationCleanupCommand, isolationCleanupMergedCommand } =
    await loadRoute(() => import('../commands/isolation'), { database: true });
  switch (subcommand) {
    case 'list':
      await isolationListCommand();
      return 0;

    case 'cleanup': {
      if (values.merged) {
        return await isolationCleanupMergedCommand({
          includeClosed: Boolean(values['include-closed']),
        });
      } else {
        const days = parseInt(positionals[2] ?? '7', 10);
        return await isolationCleanupCommand(days);
      }
    }

    default: {
      const problem =
        subcommand === undefined
          ? 'Missing isolation subcommand'
          : `Unknown isolation subcommand: ${subcommand}`;
      return await fail(json, `${problem}\nAvailable: list, cleanup`);
    }
  }
}

export async function runValidate({
  subcommand,
  positionals,
  effectiveCwd,
  json,
}: CliRouteContext): Promise<number> {
  const { validateWorkflowsCommand, validateCommandsCommand } = await loadRoute(
    () => import('../commands/validate')
  );
  switch (subcommand) {
    case 'workflows':
      return await validateWorkflowsCommand(effectiveCwd, positionals[2], json);

    case 'commands':
      return await validateCommandsCommand(effectiveCwd, positionals[2], json);

    default: {
      const problem =
        subcommand === undefined
          ? 'Missing validate target'
          : `Unknown validate target: ${subcommand}`;
      return await fail(json, `${problem}\nAvailable: workflows, commands`);
    }
  }
}

export async function runComplete({ positionals, values, json }: CliRouteContext): Promise<number> {
  const branches = positionals.slice(1);
  if (branches.length === 0) {
    return await fail(json, 'Usage: archon complete <branch-name> [branch2 ...]');
  }
  const forceFlag = Boolean(values.force);
  const { isolationCompleteCommand } = await loadRoute(() => import('../commands/isolation'), {
    database: true,
  });
  await isolationCompleteCommand(branches, { force: forceFlag, deleteRemote: true });
  return 0;
}

export async function runServe({ values }: CliRouteContext): Promise<number> {
  const servePort = values.port !== undefined ? Number(values.port) : undefined;
  const downloadOnly = Boolean(values['download-only']);
  const { serveCommand } = await import('../commands/serve');
  return await serveCommand({ port: servePort, downloadOnly });
}

export async function runDoctor(): Promise<number> {
  const { doctorCommand } = await loadRoute(() => import('../commands/doctor'), {
    database: true,
  });
  return await doctorCommand();
}

export async function runAuth({ subcommand, json }: CliRouteContext): Promise<number> {
  switch (subcommand) {
    case 'github': {
      const { authGithubCommand } = await loadRoute(() => import('../commands/auth'), {
        database: true,
      });
      return await authGithubCommand();
    }
    default: {
      const problem =
        subcommand === undefined
          ? 'Missing auth subcommand'
          : `Unknown auth subcommand: ${subcommand}`;
      return await fail(json, `${problem}\nAvailable: github`);
    }
  }
}

type AiCommands = typeof import('../commands/ai');

export async function runAi(ctx: CliRouteContext): Promise<number> {
  const { subcommand, positionals, values, json } = ctx;
  const ai = await loadRoute(() => import('../commands/ai'), { database: true });
  switch (subcommand) {
    case 'key': {
      if (positionals[2] !== 'set') {
        return await fail(json, 'Usage: archon ai key set <provider>');
      }
      return await ai.aiKeySetCommand(positionals[3]);
    }
    case 'list':
      return await ai.aiListCommand();
    case 'logout':
      return await ai.aiLogoutCommand(positionals[2]);
    case 'login':
      return await ai.aiLoginCommand(positionals[2]);
    case 'tier':
      return await runAiTier(ctx, ai);
    case 'alias':
      return await runAiAlias(ctx, ai);
    case 'capacity': {
      const action = positionals[2];
      if (action === undefined || action === 'list') return await ai.aiCapacityListCommand(json);
      if (action === 'release') return await ai.aiCapacityReleaseCommand(positionals[3]);
      return await fail(
        json,
        'Usage: archon ai capacity [list] [--json] | capacity release <attempt-id>'
      );
    }
    case 'default':
      return await ai.aiDefaultCommand(
        positionals[2],
        positionals[3],
        values.scope as string | undefined
      );
    default: {
      const problem =
        subcommand === undefined ? 'Missing ai subcommand' : `Unknown ai subcommand: ${subcommand}`;
      return await fail(
        json,
        `${problem}\nAvailable: key set <provider>, login <provider>, list, logout <provider>, tier set|list|unset, alias set|list|unset, capacity [list]|release <attempt-id>, default <provider> [<model>]`
      );
    }
  }
}

async function runAiTier(
  { positionals, values, json }: CliRouteContext,
  ai: AiCommands
): Promise<number> {
  const scopeFlag = values.scope as string | undefined;
  switch (positionals[2]) {
    case 'set':
      return await ai.aiTierSetCommand(
        positionals[3],
        positionals[4],
        positionals[5],
        values.effort as string | undefined,
        scopeFlag
      );
    case 'list':
      return await ai.aiTierListCommand(json);
    case 'unset':
      return await ai.aiTierUnsetCommand(positionals[3], scopeFlag);
    default:
      return await fail(
        json,
        'Usage: archon ai tier set <small|medium|large> <provider> <model> [--effort <e>] [--scope user|install] | tier list [--json] | tier unset <tier> [--scope user|install]'
      );
  }
}

async function runAiAlias(
  { positionals, values, json }: CliRouteContext,
  ai: AiCommands
): Promise<number> {
  const scopeFlag = values.scope as string | undefined;
  switch (positionals[2]) {
    case 'set':
      return await ai.aiAliasSetCommand(
        positionals[3],
        positionals[4],
        positionals[5],
        values.effort as string | undefined,
        scopeFlag
      );
    case 'list':
      return await ai.aiAliasListCommand(json);
    case 'unset':
      return await ai.aiAliasUnsetCommand(positionals[3], scopeFlag);
    default:
      return await fail(
        json,
        'Usage: archon ai alias set <@name> <provider> <model> [--effort <e>] [--scope user|install] | alias list [--json] | alias unset <@name> [--scope user|install]'
      );
  }
}

export async function runTelemetry({ subcommand, json }: CliRouteContext): Promise<number> {
  const { telemetryStatusCommand, telemetryResetCommand, telemetryWorkflowNoMatchCommand } =
    await loadRoute(() => import('../commands/telemetry'), { providers: false });
  switch (subcommand) {
    case 'status':
      return telemetryStatusCommand();
    case 'reset':
      return telemetryResetCommand();
    case 'no-match':
      return telemetryWorkflowNoMatchCommand();
    default: {
      const problem =
        subcommand === undefined
          ? 'Missing telemetry subcommand'
          : `Unknown telemetry subcommand: ${subcommand}`;
      return await fail(json, `${problem}\nAvailable: status, reset, no-match`);
    }
  }
}

export async function runSkill({
  subcommand,
  positionals,
  cwd,
  json,
}: CliRouteContext): Promise<number> {
  if (!isAttachmentVerb('skill', subcommand)) {
    const problem =
      subcommand === undefined
        ? 'Missing skill subcommand'
        : `Unknown skill subcommand: ${subcommand}`;
    const available = publicAttachmentEntries('skill')
      .map(([verb]) => verb)
      .join(', ');
    return await fail(json, `${problem}\nAvailable: ${available}`);
  }
  if (positionals.length > 3) {
    return await fail(json, attachmentUsage('skill'));
  }
  if (subcommand === 'install') {
    console.warn('Warning: archon skill install is deprecated. Use archon skill add instead.');
  }
  const targetArg = positionals[2];
  const targetPath = targetArg ? resolve(targetArg) : cwd;
  const { skillInstallCommand } = await loadRoute(() => import('../commands/skill'), {
    providers: false,
  });
  return await skillInstallCommand(targetPath);
}

export async function runUnknownCommand({ command, json }: CliRouteContext): Promise<number> {
  const problem = command === undefined ? 'Missing command' : `Unknown command: ${command}`;
  // Help text goes to stdout, which would corrupt the
  // machine-readable payload under --json.
  if (json) {
    return await fail(true, problem);
  }
  console.error(problem);
  await printUsageFor();
  return 1;
}
