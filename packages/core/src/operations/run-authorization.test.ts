import { describe, expect, test } from 'bun:test';
import { authorizeRunAction, type RunActor } from './run-authorization';
import type { ChatActor } from '@archon/chat-contract';
import type { UserRole } from '../schemas/user';

describe('starter or admin run authorization', () => {
  const cases: { actor: RunActor; role: UserRole | undefined; owned: boolean; unowned: boolean }[] =
    [
      { actor: { kind: 'operator' }, role: undefined, owned: true, unowned: true },
      { actor: { kind: 'unidentified' }, role: undefined, owned: false, unowned: false },
      { actor: { kind: 'unidentified' }, role: 'admin', owned: false, unowned: false },
      { actor: { kind: 'user', userId: 'starter' }, role: 'member', owned: true, unowned: false },
      { actor: { kind: 'user', userId: 'starter' }, role: undefined, owned: true, unowned: false },
      { actor: { kind: 'user', userId: 'starter' }, role: 'admin', owned: true, unowned: true },
      { actor: { kind: 'user', userId: 'other' }, role: 'member', owned: false, unowned: false },
      { actor: { kind: 'user', userId: 'other' }, role: undefined, owned: false, unowned: false },
      { actor: { kind: 'user', userId: 'other' }, role: 'admin', owned: true, unowned: true },
    ];
  for (const { actor, role, owned, unowned } of cases) {
    test(`${JSON.stringify(actor)} / ${String(role)}`, () => {
      expect(authorizeRunAction(actor, 'starter', role)).toBe(owned);
      expect(authorizeRunAction(actor, null, role)).toBe(unowned);
    });
  }
});

type AssertNever<T extends never> = T;
export type ChatNeverOperator = AssertNever<Extract<ChatActor, { kind: 'operator' }>>;
export type ChatMatchesRunActor = AssertNever<
  | Exclude<ChatActor, RunActor>
  | Exclude<Extract<RunActor, { kind: 'user' } | { kind: 'unidentified' }>, ChatActor>
>;
