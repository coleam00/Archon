import { dispatchForge, type ForgeDispatchResult } from '@archon/forge/dispatch';
import {
  temporaryErrorKinds,
  trustedActor,
  trustedTextDigest,
  type ForgeError,
  type ForgeRequest,
} from '@archon/forge';
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import type { Codebase } from '../schemas/codebase';
import type { IWorkflowHostStore } from './host-store';
import { trustedTextActor } from '@archon/workflows/trusted-text';
import type {
  TrustedTextEvidence,
  TrustedTextRunMetadata,
  WorkflowTrustedTextHost,
} from '@archon/workflows/trusted-text';
import * as acceptanceDb from '../db/item-text-acceptances';
import { isDeepStrictEqual } from 'node:util';

export function createTrustedTextRecords(): NonNullable<IWorkflowHostStore['trustedText']> {
  return {
    declareRequirement: acceptanceDb.declareItemTextRequirement,
    requirementForItem: acceptanceDb.readItemTextRequirement,
    readAcceptedItem: acceptanceDb.readItemTextAcceptanceByItemId,
    readAccepted: async (projectKey, itemKey, requirement) => {
      const snapshot = await acceptanceDb.readItemTextAcceptance(projectKey, itemKey);
      if (!snapshot) return null;
      if (!isDeepStrictEqual(snapshot.requirement, requirement))
        throw new TrustedTextRefusedError('acceptance_requirement_changed');
      return snapshot;
    },
    writeAccepted: acceptanceDb.writeItemTextAcceptance,
  };
}

type Dispatch = (request: ForgeRequest) => Promise<Pick<ForgeDispatchResult, 'response'>>;
type Requirement = TrustedTextRunMetadata['requirement'];
function metadata(evidence: TrustedTextEvidence, requirement: Requirement): TrustedTextRunMetadata {
  return {
    schemaVersion: 1,
    requirement,
    title: evidence.title,
    body: evidence.body,
    contentDigest: trustedTextDigest(evidence.title, evidence.body),
    policy: {
      head: evidence.policy.head,
      digest: evidence.policy.digest,
      maintainers: evidence.policy.maintainers,
    },
  };
}

function sameText(left: TrustedTextRunMetadata, right: TrustedTextEvidence): boolean {
  return (
    left.contentDigest === trustedTextDigest(right.title, right.body) &&
    left.title === right.title &&
    left.body === right.body
  );
}

export class TrustedTextRefusedError extends Error {
  constructor(
    readonly reason: string,
    readonly forgeKind?: ForgeError['kind']
  ) {
    super(reason);
  }

  get retryable(): boolean {
    return (
      this.reason === 'waiting_acceptance' ||
      this.reason === 'acceptance_requirement_changed' ||
      temporaryErrorKinds.some(kind => kind === this.forgeKind)
    );
  }
}

export class CoreTrustedTextHost implements WorkflowTrustedTextHost {
  constructor(
    private readonly records: Pick<IWorkflowHostStore, 'trustedText'> & {
      codebases: Pick<IWorkflowHostStore['codebases'], 'getCodebase'>;
    },
    private readonly dispatch: Dispatch = request => dispatchForge(request)
  ) {}

  async readEvidence(requirement: Requirement): Promise<TrustedTextEvidence> {
    const { response } = await this.dispatch({
      operationId: crypto.randomUUID(),
      op: 'workitem.trust',
      subject: requirement.subject,
      maintainersPath: requirement.maintainersPath,
    });
    if (!response.ok) throw new TrustedTextRefusedError('policy_unreadable', response.error.kind);
    if (response.result.op !== 'workitem.trust')
      throw new TrustedTextRefusedError('policy_unreadable');
    return response.result.value;
  }

  async declare(
    requirement: Requirement,
    project: { codebaseId: string; itemKey: string }
  ): Promise<void> {
    if (!this.records.trustedText)
      throw new TrustedTextRefusedError('trusted_text_store_unavailable');
    await this.records.trustedText.declareRequirement(
      project.codebaseId,
      project.itemKey,
      requirement
    );
  }

  async requirementForItem(itemId: string): Promise<Requirement | null> {
    if (!this.records.trustedText)
      throw new TrustedTextRefusedError('trusted_text_store_unavailable');
    return await this.records.trustedText.requirementForItem(itemId);
  }

  async requirementForStart(codebaseId: string, itemKey: string): Promise<Requirement | null> {
    const codebase = await this.records.codebases.getCodebase(codebaseId);
    if (!codebase) throw new TrustedTextRefusedError('trusted_text_project_not_found');
    return await acceptanceDb.readItemTextRequirementByKey(
      projectKeyForCodebase(codebase, codebase.default_cwd),
      itemKey
    );
  }

  async authorize(
    requirement: Requirement,
    project: { codebase: Codebase; itemKey: string }
  ): Promise<TrustedTextRunMetadata> {
    const store = this.records.trustedText;
    if (!store) throw new TrustedTextRefusedError('trusted_text_store_unavailable');
    const evidence = await this.readEvidence(requirement);
    if (trustedTextActor(evidence, evidence.policy)) return metadata(evidence, requirement);
    const accepted = await store.readAccepted(
      projectKeyForCodebase(project.codebase, project.codebase.default_cwd),
      project.itemKey,
      requirement
    );
    return await this.authorizeSnapshot(requirement, accepted, evidence);
  }

  async authorizeItem(requirement: Requirement, itemId: string): Promise<TrustedTextRunMetadata> {
    const store = this.records.trustedText;
    if (!store) throw new TrustedTextRefusedError('trusted_text_store_unavailable');
    const evidence = await this.readEvidence(requirement);
    return await this.authorizeSnapshot(
      requirement,
      await store.readAcceptedItem(itemId),
      evidence
    );
  }

  private async authorizeSnapshot(
    requirement: Requirement,
    accepted: TrustedTextRunMetadata | null,
    evidence?: TrustedTextEvidence
  ): Promise<TrustedTextRunMetadata> {
    const current = evidence ?? (await this.readEvidence(requirement));
    if (trustedTextActor(current, current.policy)) return metadata(current, requirement);
    if (accepted && !isDeepStrictEqual(accepted.requirement, requirement))
      throw new TrustedTextRefusedError('acceptance_requirement_changed');
    if (!accepted || !sameText(accepted, current))
      throw new TrustedTextRefusedError('waiting_acceptance');
    if (!accepted.acceptedBy || !trustedActor(accepted.acceptedBy, current.policy))
      throw new TrustedTextRefusedError('waiting_acceptance');
    return accepted;
  }

  async recheck(snapshot: TrustedTextRunMetadata): Promise<void> {
    const current = await this.readEvidence(snapshot.requirement);
    if (!sameText(snapshot, current)) throw new TrustedTextRefusedError('waiting_acceptance');
    if (snapshot.acceptedBy && !trustedActor(snapshot.acceptedBy, current.policy))
      throw new TrustedTextRefusedError('maintainer_removed');
    if (!snapshot.acceptedBy && !trustedTextActor(current, current.policy))
      throw new TrustedTextRefusedError('author_no_longer_trusted');
  }

  async accept(
    request: Extract<ForgeRequest, { op: 'workitem.accept' }>,
    dispatched?: Pick<ForgeDispatchResult, 'response'>
  ): Promise<TrustedTextRunMetadata> {
    const store = this.records.trustedText;
    if (!store) throw new TrustedTextRefusedError('trusted_text_store_unavailable');
    const { response } = dispatched ?? (await this.dispatch(request));
    if (!response.ok || response.result.op !== 'workitem.accept') {
      if (response.ok) throw new TrustedTextRefusedError('acceptance_evidence_invalid');
      throw new TrustedTextRefusedError(
        response.error.kind === 'conflict'
          ? 'content_changed_before_acceptance'
          : 'untrusted_accept_refused'
      );
    }
    const acceptance = response.result.value;
    if (!trustedActor(acceptance.acceptedBy, acceptance.policy))
      throw new TrustedTextRefusedError('untrusted_accept_refused');
    if (trustedTextDigest(acceptance.title, acceptance.body) !== request.expectedContentDigest)
      throw new TrustedTextRefusedError('content_changed_before_acceptance');
    if (
      acceptance.subject.kind !== request.subject.kind ||
      acceptance.subject.ref.number !== request.subject.ref.number ||
      acceptance.subject.ref.repo.host !== request.subject.ref.repo.host ||
      acceptance.subject.ref.repo.path !== request.subject.ref.repo.path ||
      acceptance.subject.ref.repo.hostClaim !== request.subject.ref.repo.hostClaim ||
      acceptance.policy.maintainersPath !== request.maintainersPath ||
      acceptance.scope.codebaseId !== request.scope.codebaseId ||
      acceptance.scope.itemKey !== request.scope.itemKey ||
      acceptance.scope.input !== request.scope.input
    )
      throw new TrustedTextRefusedError('acceptance_evidence_mismatch');
    const requirement: Requirement = {
      subject: acceptance.subject,
      maintainersPath: acceptance.policy.maintainersPath,
      input: acceptance.scope.input ?? 'trusted_item',
    };
    const snapshot = { ...metadata(acceptance, requirement), acceptedBy: acceptance.acceptedBy };
    const codebase = await this.records.codebases.getCodebase(acceptance.scope.codebaseId);
    if (!codebase) throw new TrustedTextRefusedError('acceptance_project_not_found');
    await store.writeAccepted(
      projectKeyForCodebase(codebase, codebase.default_cwd),
      acceptance.scope.itemKey,
      snapshot
    );
    return snapshot;
  }
}
