/** `archon trigger check`: what every binding this install can start would do, read only. */
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  getTriggersPath,
  readOnBindings,
  runEndedTriggerCheck,
  type OnBinding,
} from '@archon/core/workflows/run-ended';
import { runEndedStops } from '@archon/core/workflows/run-ended-stops';
import { asksSettledTriggerCheck } from '@archon/core/workflows/asks-settled';
import {
  registeredProjectForPath,
  registeredProjectKeyForPath,
} from '@archon/core/services/codebase-checkout-resolver';
import { loadConfig } from '@archon/core/config/config-loader';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import type { NativeScheduleOptions } from '../triggers/native-schedule';
import { checkFireBindings } from '../triggers/fire-binding-check';
import { writeJsonLine } from '../utils/stdout';

/**
 * List every trigger binding this install can start, reading only, and check that its
 * started workflow accepts its inputs as a start would. Bindings with `on`: for run-ended,
 * the ended workflow declares the outcome and every input the binding reads from it; for
 * asks-settled, the asking workflow declares `returns.asks` and every input the
 * binding reads. A run whose end or asks could fire such a binding is refused before it
 * starts, by the same check. It also reports what no run is refused for: a missing
 * `launch.cwd`, a run-ended binding that starts the workflow that ended, and two files that
 * start the same stage. Every other binding, including installed timers' config files
 * wherever they live, is listed under `bindings` (`checkFireBindings`); sources that observe,
 * under `observing` (`observingReport`). `stops` lists the outcomes after which an item would
 * stop (`runEndedStops`); like `observing`, it fails nothing.
 */
export async function checkTriggers(
  host: WorkflowHost,
  schedules: NativeScheduleOptions
): Promise<void> {
  const bindings = await readOnBindings(getTriggersPath());
  // The file store has no items, so a binding with `on` can never start anything there.
  if (host.deps.credentialStore === 'files' && bindings.length > 0)
    throw new FileStoreUnsupportedError(
      `Run-ended and asks-settled triggers (${bindings.map(entry => entry.file).join(', ')})`
    );
  const deps = {
    ...host.deps,
    // A check changes nothing: a missing global config.yaml stays missing.
    loadConfig: (cwd: string) => loadConfig(cwd, { readOnly: true }),
    projectKeyOf: (cwd: string) => registeredProjectKeyForPath(cwd, host.records.codebases),
    projectOf: (cwd: string) => registeredProjectForPath(cwd, host.records.codebases),
  };
  const runEnded = bindings.filter(entry => 'runEnded' in entry);
  const asksSettled = bindings.filter(entry => 'asksSettled' in entry);
  const runEndedProblems = await runEndedTriggerCheck(runEnded, deps);
  const asksSettledProblems = await asksSettledTriggerCheck(asksSettled, deps);
  const listed = (entry: OnBinding, problems: string[] | undefined) => ({
    file: entry.file,
    sourceInstanceId: entry.sourceInstanceId,
    bindingId: entry.binding.bindingId,
    hostId: entry.binding.hostId,
    ...('runEnded' in entry ? { runEnded: entry.runEnded } : { asksSettled: entry.asksSettled }),
    workflowName: entry.binding.launch.workflowName,
    cwd: entry.binding.launch.cwd,
    problems: problems ?? [],
  });
  const fire = await checkFireBindings(deps, schedules);
  const checked = {
    runEnded: runEnded.map((entry, index) => listed(entry, runEndedProblems[index])),
    asksSettled: asksSettled.map((entry, index) => listed(entry, asksSettledProblems[index])),
    bindings: fire.checked,
  };
  await writeJsonLine({
    directory: getTriggersPath(),
    // A standalone check has no item, so it cannot know an item's landing branch.
    definitions:
      "Each binding is checked against the definitions a start without an item reads: the binding's base, else its project's default branch, as fetched now, with the launch checkout's uncommitted changes on top. A run on an item checks the bindings it may fire against the definitions it captured, before it starts.",
    ...checked,
    // Not a problem: the exit status ignores it, and attention lists such an item.
    stopsExplained:
      'Outcomes of the workflows the bindings above name, started by any of them or ended or asking in an on binding, that do not end the item (returns.ends) and that no run-ended file without problems binds to a start on the item itself (a linked file starts on other items), of a workflow that is a step of its item (not observes: true). A run on an item that ends in one stops the item, and `archon workflow attention` lists it as stopped; `unless` names the asks or waits the workflow can leave instead, and then it stops only when the run leaves none.',
    stops: await runEndedStops([...bindings, ...fire.readable], deps),
    observing: await (await import('./wake-observation')).observingReport(host, schedules),
  });
  const broken = [...checked.runEnded, ...checked.asksSettled, ...checked.bindings].filter(
    entry => entry.problems.length > 0
  ).length;
  if (broken > 0)
    throw new Error(`${String(broken)} trigger binding(s) have problems; see "problems" above.`);
}
