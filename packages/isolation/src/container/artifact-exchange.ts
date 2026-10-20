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

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
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

  // No producer freeze: canonical storage is never mounted into the producer, so a
  // concurrent writer can only change what this collect reads, never where it writes.
  // Collect is write-safe; its snapshot of a still-running producer is best-effort.
  private async transfer(direction: TransferDirection): Promise<void> {
    const { container, helper, root, volume, image } = this.target;
    const failures: unknown[] = [];
    let helperId: string | undefined;
    try {
      const containers = await this.containers();
      if (containers.some(entry => entry.name === helper)) {
        throw new Error(
          `Artifact helper '${helper}' already exists; inspect it before explicit recovery`
        );
      }
      const producer = containers.find(entry => entry.name === container || entry.id === container);
      if (producer && !['running', 'exited', 'dead', 'created'].includes(producer.state)) {
        throw new Error(
          `Artifact producer '${container}' is ${producer.state}; inspect ownership before explicit recovery`
        );
      }
      if (producer?.state !== 'running' && direction === 'publish') return;
      const volumes = await this.docker(['volume', 'ls', '--format', '{{.Name}}']);
      if (!volumes.stdout.split('\n').includes(volume)) {
        throw new Error(
          `Artifact output volume '${volume}' is missing; refusing to create empty output`
        );
      }
      const program = buildArtifactTransferProgram(direction, '/canonical', '/output', root);
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
      if (helperId) await this.docker(['rm', '-f', helperId]).catch(cause => failures.push(cause));
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
