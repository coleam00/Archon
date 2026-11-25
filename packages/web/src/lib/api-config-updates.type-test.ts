import type { components } from './api.generated';

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type Schemas = components['schemas'];
type UpdateEntries = {
  configTiers: Schemas['UpdateTiersBody']['tiers']['large'];
  userTiers: Schemas['UpdateUserTiersBody']['tiers']['large'];
  configAliases: Schemas['UpdateAliasesBody']['aliases'][string];
  userAliases: Schemas['UpdateUserAliasesBody']['aliases'][string];
};

type AcceptsNull = {
  [Key in keyof UpdateEntries]: null extends UpdateEntries[Key] ? true : false;
};
type AcceptsEntry = {
  [Key in keyof UpdateEntries]: {
    provider: 'claude';
    model: 'opus';
    effort: 'high';
  } extends UpdateEntries[Key]
    ? true
    : false;
};
type AcceptsScalar = {
  [Key in keyof UpdateEntries]: number extends UpdateEntries[Key] ? true : false;
};
type AcceptsInvalidEntry = {
  [Key in keyof UpdateEntries]: { model: 'opus' } extends UpdateEntries[Key] ? true : false;
};

export type NullUnsets = AssertTrue<AcceptsNull[keyof UpdateEntries]>;
export type ValidEntries = AssertTrue<AcceptsEntry[keyof UpdateEntries]>;
export type ScalarsRejected = AssertFalse<AcceptsScalar[keyof UpdateEntries]>;
export type InvalidEntriesRejected = AssertFalse<AcceptsInvalidEntry[keyof UpdateEntries]>;
export type TierEntryStaysNonnullable = AssertFalse<
  null extends Schemas['TierEntry'] ? true : false
>;
