import type { paths } from './api.generated';

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type Content = paths['/api/workflows/{name}/run']['post']['requestBody']['content'];
type Json = Content['application/json'];
type Multipart = Content['multipart/form-data'];
type Minimal = { conversationId: 'web-1'; message: 'Go' };

export type MinimalJson = AssertTrue<Minimal extends Json ? true : false>;
export type ConfiguredJson = AssertTrue<
  Minimal & {
    inputs: { diff: string };
    config: { defaultAssistant: 'pi'; docs: { path: string }; env: { TOKEN: string } };
  } extends Json
    ? true
    : false
>;
export type MissingMessage = AssertFalse<{ conversationId: string } extends Json ? true : false>;
export type NumericInput = AssertFalse<
  Minimal & { inputs: { diff: number } } extends Json ? true : false
>;
export type EncodedMultipart = AssertTrue<
  Minimal & { inputs: string; config: string } extends Multipart ? true : false
>;
export type ObjectMultipart = AssertFalse<
  Minimal & { inputs: { diff: string } } extends Multipart ? true : false
>;
