/**
 * Doctor command - Verifies the local Archon setup.
 *
 * Also invoked from the end of `archon setup`; the setup wizard discards the
 * return value so a doctor failure does not abort setup (the env file was
 * already written successfully).
 */
import { providerRegistry } from '@archon/providers';
import { doctorLog, type CheckResult } from './doctor-check';
import { checkConfigFiles, checkProviderDeprecation } from './doctor-config';
import { checkInstalledProviders, checkProviderDiagnostics } from './doctor-providers';
import { checkAssistantLogin } from './doctor-assistant-login';
import { checkDatabase } from './doctor-database';
import { checkFolderProject } from './doctor-folder-project';
import { checkConnectedProviders } from './doctor-connected-providers';
import { checkWorkspaceWritable, checkBundledDefaults, checkTelemetry } from './doctor-install';
import { checkArchonSkill } from './doctor-skill';
import { checkGitHubApp, checkSlack, checkTelegram } from './doctor-platforms';

type CheckOutcome = Promise<CheckResult | CheckResult[]>;

function runDefaultChecks(env: NodeJS.ProcessEnv): CheckOutcome[] {
  return [
    checkConfigFiles(),
    checkInstalledProviders(),
    ...providerRegistry.list().map(provider => checkProviderDiagnostics(provider.id)),
    checkGitHubApp(env),
    checkAssistantLogin(env),
    checkProviderDeprecation(),
    checkDatabase(),
    checkFolderProject(),
    checkConnectedProviders(env),
    checkWorkspaceWritable(),
    checkBundledDefaults(),
    checkArchonSkill(),
    checkTelemetry(),
    checkSlack(env),
    checkTelegram(env),
  ];
}

function renderResult(r: CheckResult): string {
  const icon =
    r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'warn' ? '!' : '○';
  return `${icon} ${r.label}: ${r.message}`;
}

/** Print one settled check and return the statuses it reported; a rejected check is a failure. */
function reportSettled(
  settled: PromiseSettledResult<CheckResult | CheckResult[]>
): CheckResult['status'][] {
  if (settled.status === 'rejected') {
    const msg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    console.log(`✗ unknown: check threw: ${msg}`);
    doctorLog().error({ reason: settled.reason }, 'doctor.check_threw_unexpectedly');
    return ['fail'];
  }
  const results = Array.isArray(settled.value) ? settled.value : [settled.value];
  for (const result of results) console.log(renderResult(result));
  return results.map(result => result.status);
}

export async function doctorCommand(
  // Injected so tests can drive the exit-code contract and the
  // Promise.allSettled rejection branch with synthetic checks.
  checks?: (() => CheckOutcome)[]
): Promise<number> {
  console.log('archon doctor — verifying your setup\n');
  doctorLog().info('doctor.run_started');

  const promises = checks ? checks.map(fn => fn()) : runDefaultChecks(process.env);
  // Promise.allSettled so one unexpected rejection doesn't skip remaining checks.
  const statuses = (await Promise.allSettled(promises)).flatMap(reportSettled);
  const failures = statuses.filter(status => status === 'fail').length;
  const warnings = statuses.filter(status => status === 'warn').length;

  console.log('');
  if (failures === 0) {
    console.log(
      warnings === 0 ? 'All checks passed.' : `No check failed; ${warnings} warning(s) above.`
    );
    doctorLog().info('doctor.run_completed');
    return 0;
  }
  console.log(`${failures} check(s) failed. Run \`archon setup\` to reconfigure.`);
  doctorLog().warn({ failures }, 'doctor.run_failed');
  return 1;
}
