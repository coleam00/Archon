import { createLogger } from '@archon/paths';
import type { ArtifactExchange } from '@archon/workflows/container-context';
import type { DockerRunner } from './docker-exec';
import {
  buildArtifactTransferProgram,
  type TransferDirection,
} from './artifact-exchange-filesystem';

const log = createLogger('isolation.artifact-exchange');

export interface ArtifactExchangeTarget {
  container: string;
  helper: string;
  volume: string;
  root: string;
  image: string;
}

interface ContainerDescription {
  name: string;
  id: string;
  state: string;
}

export class ContainerArtifactExchange implements ArtifactExchange {
  private admissionFailure: Error | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly docker: DockerRunner,
    private readonly target: ArtifactExchangeTarget
  ) {}

  /** Lifecycle operations use this same queue so teardown cannot race a helper. */
  serialize<T>(operation: (collect: () => Promise<void>) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const containers = await this.containers();
      const producer = containers.find(
        entry => entry.name === this.target.container || entry.id === this.target.container
      );
      if (
        containers.some(entry => entry.name === this.target.helper) ||
        (producer && !['running', 'exited', 'dead', 'created'].includes(producer.state))
      ) {
        throw new Error(
          `Cannot change artifact environment '${this.target.container}': helper '${this.target.helper}' or producer ownership is ambiguous; inspect before explicit recovery`
        );
      }
      return operation(() => this.transfer('collect'));
    });
  }

  failAdmission(error: Error): void {
    this.admissionFailure = error;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const checked = (): Promise<T> => {
      if (this.admissionFailure) throw this.admissionFailure;
      return run();
    };
    const next = this.tail.then(checked, checked);
    this.tail = next;
    return next;
  }

  publish(): Promise<void> {
    return this.enqueue(() => this.transfer('publish'));
  }

  collect(): Promise<void> {
    return this.enqueue(() => this.transfer('collect'));
  }

  private async containers(): Promise<ContainerDescription[]> {
    const { stdout } = await this.docker([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--format',
      '{{json .}}',
    ]);
    return stdout
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => {
        const entry: unknown = JSON.parse(line);
        if (
          typeof entry !== 'object' ||
          entry === null ||
          !('Names' in entry) ||
          typeof entry.Names !== 'string' ||
          !('ID' in entry) ||
          typeof entry.ID !== 'string' ||
          !('State' in entry) ||
          typeof entry.State !== 'string'
        ) {
          throw new Error(
            'Cannot determine artifact transfer ownership: invalid Docker inspection'
          );
        }
        return { name: entry.Names, id: entry.ID, state: entry.State };
      });
  }

  private async runHelper(helperId: string): Promise<void> {
    await this.docker(['start', helperId]);
    const completed = await this.docker(['wait', helperId]);
    if (completed.stdout.trim() !== '0') {
      const logs = await this.docker(['logs', helperId]);
      throw new Error(
        `Artifact helper '${this.target.helper}' failed: ${logs.stderr || logs.stdout}`
      );
    }
  }

  private async transfer(direction: TransferDirection): Promise<void> {
    const { container, helper, root, volume, image } = this.target;
    const failures: unknown[] = [];
    let pausedId: string | undefined;
    let helperId: string | undefined;
    let helperAbsent = false;
    const restoreProducer = async (): Promise<void> => {
      if (helperId) {
        try {
          await this.docker(['rm', '-f', helperId]);
          helperAbsent = true;
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (!helperAbsent) {
        try {
          helperAbsent = !(await this.containers()).some(entry => entry.name === helper);
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (pausedId && helperAbsent) {
        try {
          await this.docker(['unpause', pausedId]);
        } catch (cause) {
          failures.push(cause);
        }
      } else if (pausedId) {
        failures.push(
          new Error(
            `Producer '${container}' left paused: helper '${helper}' completion is unknown. ` +
              'Inspect both containers before explicit recovery; the output volume is preserved.'
          )
        );
      }
    };
    try {
      const containers = await this.containers();
      if (containers.some(entry => entry.name === helper)) {
        throw new Error(
          `Artifact helper '${helper}' already exists; inspect it before explicit recovery`
        );
      }
      helperAbsent = true;
      const producer = containers.find(entry => entry.name === container || entry.id === container);
      if (producer?.state === 'running') {
        await this.docker(['pause', producer.id]);
        pausedId = producer.id;
      } else if (producer && !['exited', 'dead', 'created'].includes(producer.state)) {
        throw new Error(
          `Artifact producer '${container}' is ${producer.state}; inspect ownership before explicit recovery`
        );
      } else if (direction === 'publish') {
        return;
      }
      const volumes = await this.docker(['volume', 'ls', '--format', '{{.Name}}']);
      if (!volumes.stdout.split('\n').includes(volume)) {
        throw new Error(
          `Artifact output volume '${volume}' is missing; refusing to create empty output`
        );
      }
      const program = buildArtifactTransferProgram(direction, '/canonical', '/output', root);
      // A failed create can have reached the daemon even when its reply was lost.
      helperAbsent = false;
      const created = await this.docker([
        'create',
        '--name',
        helper,
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'DAC_OVERRIDE',
        ...(direction === 'collect' ? ['--cap-add', 'CHOWN'] : []),
        '--security-opt',
        'no-new-privileges',
        '--restart',
        'no',
        '--entrypoint',
        'bun',
        '-v',
        `${root}:/canonical${direction === 'publish' ? ':ro' : ''}`,
        '-v',
        `${volume}:/output${direction === 'collect' ? ':ro' : ''}`,
        image,
        '--no-env-file',
        '-e',
        program,
      ]);
      helperId = created.stdout.trim();
      if (!helperId) throw new Error(`Docker did not identify artifact helper '${helper}'`);
      await this.runHelper(helperId);
    } catch (cause) {
      failures.push(cause);
    } finally {
      await restoreProducer();
    }
    if (failures.length) {
      log.error(
        { container, helper, direction, err: failures[0] },
        'isolation.artifact_exchange_failed'
      );
      throw new AggregateError(failures, `Artifact ${direction} failed for '${container}'`);
    }
  }
}
