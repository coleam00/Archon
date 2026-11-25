import type { paths } from '@/lib/api.generated';

export type ApiPath = keyof paths;
export type ApiMethod<P extends ApiPath> = {
  [M in keyof paths[P]]: [NonNullable<paths[P][M]>] extends [never]
    ? never
    : NonNullable<paths[P][M]> extends { responses: object }
      ? M
      : never;
}[keyof paths[P]] &
  string;
type Operation<P extends ApiPath, M extends ApiMethod<P>> = NonNullable<
  paths[P][M & keyof paths[P]]
>;
type Field<T, K extends PropertyKey> = K extends keyof T ? T[K] : never;
type PathParams<P extends ApiPath, M extends ApiMethod<P>> = NonNullable<
  Field<Field<Operation<P, M>, 'parameters'>, 'path'>
>;
export type QueryParams<P extends ApiPath, M extends ApiMethod<P>> = NonNullable<
  Field<Field<Operation<P, M>, 'parameters'>, 'query'>
>;
type RequestContent<P extends ApiPath, M extends ApiMethod<P>> = Field<
  NonNullable<Field<Operation<P, M>, 'requestBody'>>,
  'content'
>;
type Responses<P extends ApiPath, M extends ApiMethod<P>> = Field<Operation<P, M>, 'responses'>;
type Success<R> = {
  [S in keyof R]: `${S & (string | number)}` extends `2${string}`
    ? Field<Field<R[S], 'content'>, 'application/json'>
    : never;
}[keyof R];
export type JsonResponse<P extends ApiPath, M extends ApiMethod<P>> = Success<Responses<P, M>>;
export type JsonMethod<P extends ApiPath> = {
  [M in ApiMethod<P>]: [JsonResponse<P, M>] extends [never] ? never : M;
}[ApiMethod<P>];
type Body<P extends ApiPath, M extends ApiMethod<P>> = [RequestContent<P, M>] extends [never]
  ? never
  :
      | Field<RequestContent<P, M>, 'application/json'>
      | ('multipart/form-data' extends keyof RequestContent<P, M> ? FormData : never);
type Slot<K extends string, T> = [T] extends [never]
  ? { [Key in K]?: never }
  : Record<string, never> extends T
    ? { [Key in K]?: T }
    : { [Key in K]: T };
type UrlOptions<P extends ApiPath, M extends ApiMethod<P>> = Slot<'params', PathParams<P, M>> &
  Slot<'query', QueryParams<P, M>>;
type ApiRequestOptions<P extends ApiPath, M extends ApiMethod<P>> = UrlOptions<P, M> &
  (Operation<P, M> extends { requestBody: unknown }
    ? { body: Body<P, M> }
    : { body?: Body<P, M> }) & { signal?: AbortSignal; headers?: HeadersInit };
type OptionArgs<T> = Record<string, never> extends T ? [options?: T] : [options: T];

export type UrlArgs<P extends ApiPath, M extends ApiMethod<P>> = OptionArgs<UrlOptions<P, M>>;
export type RequestArgs<P extends ApiPath, M extends ApiMethod<P>> = OptionArgs<
  ApiRequestOptions<P, M>
>;
