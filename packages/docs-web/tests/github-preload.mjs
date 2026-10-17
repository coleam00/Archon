import { fixtureResponse } from './github-fixture.mjs';
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('https://api.github.com/')) return Response.json(fixtureResponse(url));
  return nativeFetch(input, init);
};
