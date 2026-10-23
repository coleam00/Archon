import type { paths } from './api.generated';

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type Content = paths['/api/conversations/{id}/message']['post']['requestBody']['content'];
type Json = Content['application/json'];
type Multipart = Content['multipart/form-data'];

export type ValidJson = AssertTrue<{ message: string } extends Json ? true : false>;
export type MissingMessage = AssertFalse<Record<string, never> extends Json ? true : false>;
export type NumericMessage = AssertFalse<{ message: number } extends Json ? true : false>;
export type ValidMultipart = AssertTrue<
  { message: string; files: string[] } extends Multipart ? true : false
>;
export type MultipartWithoutFiles = AssertTrue<
  { message: string } extends Multipart ? true : false
>;
