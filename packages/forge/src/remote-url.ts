/** Preserve remote identity before WHATWG URL normalization drops default ports and dot segments. */
export function parseRemoteUrl(value: string): { url: URL; host: string; pathname: string } {
  const url = new URL(value);
  const parts = /^[a-z][a-z\d+.-]*:\/\/([^/\\?#]*)([^?#]*)/i.exec(value);
  if (!parts) throw new TypeError('Remote URL must contain an authority');
  const port = /:(\d+)$/.exec(parts[1]);
  const host = port ? `${url.hostname}:${Number(port[1])}` : url.host;
  return { url, host: host.toLowerCase(), pathname: parts[2] };
}
