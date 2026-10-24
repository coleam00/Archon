// Which files only a human may change is a fact the project declares once, so scripts read it and
// gates enforce it. Patterns are anchored at the repository root: `*` and `?` stay inside one path
// segment, `**` spans segments, and a trailing `/` covers everything under that directory.

/** The declared patterns: [] when none, 'invalid' when the declaration cannot be read. */
export function declared(raw: string): string[] | 'invalid' {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'none') return [];
  const patterns = value.split(',').map(pattern => pattern.trim());
  if (patterns.some(pattern => pattern === '' || pattern === '/' || /\p{Cc}/u.test(pattern))) {
    return 'invalid';
  }
  return [...new Set(patterns)];
}

export function patternRegex(pattern: string): RegExp {
  let glob = pattern.replace(/^\/+/, '');
  if (glob.endsWith('/')) glob += '**';
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      const slashAfter = glob[index + 2] === '/';
      source += slashAfter ? '(?:.*/)?' : '.*';
      index += slashAfter ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** The files among `files` that a declaration protects; 'invalid' when the declaration cannot be read. */
export function protectedFiles(raw: string, files: string[]): string[] | 'invalid' {
  const patterns = declared(raw);
  if (patterns === 'invalid') return 'invalid';
  const regexes = patterns.map(patternRegex);
  return files.filter(file => regexes.some(regex => regex.test(file.replace(/\\/g, '/').replace(/^\.\//, ''))));
}
