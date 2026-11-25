/** Which repository and pull request a value names, as the forge contract types them. */

import type { ForgeOperations } from 'archon:script';
import { nullableJson } from './inputs.ts';

/** The pull-request facts every later public action in a run depends on. */
export type PrRecord = NonNullable<ForgeOperations['pr.view']['result']>['pr'];

export interface QualifiedPr {
  readonly repo: { readonly host: string; readonly path: string };
  readonly number: number;
}

/**
 * Repository identity, compared the way a forge registers it.
 *
 * Host and owner/name are case-insensitive but case-preserving: a forge answers
 * with the case it has registered, whatever case this pack asked with. Comparing
 * exactly would read a pull request that is the requested one as a different one.
 */
export function sameRepo(left: QualifiedPr['repo'], right: QualifiedPr['repo']): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}

export function samePr(left: QualifiedPr, right: QualifiedPr): boolean {
  return left.number === right.number && sameRepo(left.repo, right.repo);
}

/** A bound item or pull request: a qualified repository and a positive number. */
export function parseQualifiedPr(bound: string | undefined): QualifiedPr {
  let pr: Partial<QualifiedPr> | null;
  try {
    pr = nullableJson(bound) as Partial<QualifiedPr> | null;
  } catch {
    throw new Error('the bound pull request is not valid JSON');
  }
  const { host, path } = pr?.repo ?? {};
  const number = pr?.number;
  if (
    typeof host !== 'string' ||
    host.trim() === '' ||
    typeof path !== 'string' ||
    path.trim() === '' ||
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    number <= 0
  ) {
    throw new Error('the bound pull request has no qualified repo and positive number');
  }
  return { repo: { host, path }, number };
}
