import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dir, '..');
const CONSOLE = 'packages/web/src/experiments/console';
const THEME = 'packages/web/src/index.css';
const GUIDE = 'packages/docs-web/src/content/docs/brand/index.md';
const START = '<!-- console-tokens:start -->';
const END = '<!-- console-tokens:end -->';
const DIRECTIVE = 'console-token-exception';

function baseUtility(candidate: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] === '[') depth++;
    else if (candidate[i] === ']') depth--;
    else if (candidate[i] === ':' && depth === 0) start = i + 1;
  }
  return candidate.slice(start).replace(/^!?-?/, '').replace(/!$/, '');
}

export function needsToken(candidate: string): boolean {
  const base = baseUtility(candidate);
  const match =
    /^(text|rounded(?:-[a-z]+)?|tracking|[pm][xytbrlse]?|gap(?:-[xy])?|space-[xy]|(?:min-|max-)?[wh]|size|inset(?:-[xyse])?|top|bottom|left|right|start|end|grid-cols|grid-rows|translate(?:-[xyz])?)-\[(.*)\](?:\/[^\s]+)?$/.exec(
      base
    );
  if (!match || (match[1] === 'text' && match[2].startsWith('color:'))) return false;
  return /(?:\d*\.)?\d+(?:px|rem|em)(?![a-z])/i.test(match[2]);
}

interface Segment {
  text: string;
  offset: number;
}

function sourceParts(source: ts.SourceFile): { segments: Segment[]; comments: ts.CommentRange[] } {
  const text = source.text;
  const segments: Segment[] = [];
  const comments = new Map<number, ts.CommentRange>();
  function visit(node: ts.Node): void {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ])
      comments.set(range.pos, range);
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      const offset = node.getStart(source) + 1;
      const end =
        node.end -
        (node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle
          ? 2
          : 1);
      segments.push({ text: text.slice(offset, end), offset });
    }
    ts.forEachChild(node, visit);
  }
  if (source.fileName.endsWith('.css')) {
    for (const match of text.matchAll(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|@apply\s+([^;]+);/g
    )) {
      if (match[1] !== undefined) {
        segments.push({ text: match[1], offset: match.index + match[0].indexOf(match[1]) });
      } else if (match[0].startsWith('/*')) {
        comments.set(match.index, {
          pos: match.index,
          end: match.index + match[0].length,
          kind: ts.SyntaxKind.MultiLineCommentTrivia,
        });
      }
    }
  } else visit(source);
  return { segments, comments: [...comments.values()] };
}

interface TokenException {
  line: number;
  utility: string;
  used: boolean;
}

function readExceptions(
  file: string,
  text: string,
  comments: ts.CommentRange[],
  lineAt: (position: number) => number
): { exceptions: TokenException[]; failures: string[] } {
  const failures: string[] = [];
  const exceptions: TokenException[] = [];
  for (const range of comments) {
    const comment = text.slice(range.pos, range.end);
    if (!comment.includes(DIRECTIVE)) continue;
    const body = comment.replace(/^\/\/|^\/\*|\*\/$/g, '').trim();
    const match = /^console-token-exception (\S+) -- (\S[^\r\n]*)$/.exec(body);
    const line = lineAt(range.pos);
    if (!match || line !== lineAt(range.end - 1)) {
      failures.push(
        `${file}:${line}: malformed ${DIRECTIVE}; use a single-line comment with an exact utility and a reason`
      );
    } else exceptions.push({ line, utility: match[1], used: false });
  }
  return { exceptions, failures };
}

export function checkSource(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lineAt = (position: number): number =>
    source.getLineAndCharacterOfPosition(position).line + 1;
  const { segments, comments } = sourceParts(source);
  const { exceptions, failures } = readExceptions(file, text, comments, lineAt);
  for (const segment of segments) {
    for (const match of segment.text.matchAll(/\S+/g)) {
      const utility = match[0];
      if (!needsToken(utility)) continue;
      const line = lineAt(segment.offset + match.index);
      const exception = exceptions.find(
        entry => entry.line === line - 1 && entry.utility === utility
      );
      if (exception) exception.used = true;
      else
        failures.push(
          `${file}:${line}: ${utility}: use a design token, or put // ${DIRECTIVE} ${utility} -- <reason> immediately above this physical line (extract a local constant for multiline JSX)`
        );
    }
  }
  for (const entry of exceptions) {
    if (!entry.used)
      failures.push(
        `${file}:${entry.line}: unmatched ${DIRECTIVE} ${entry.utility}; the exact utility must occur on the next physical line`
      );
  }
  return failures;
}

export function renderTokenDocs(css: string): string {
  const theme = /@theme inline\s*\{([^}]+)\}/.exec(css)?.[1];
  if (!theme) throw new Error('Missing @theme inline in console token source');
  const rows = [
    ...theme.matchAll(
      /--((?:text-console|tracking-console|radius-console)-[\w-]+|radius(?:-[\w-]+)?):\s*([^;]+);/g
    ),
  ].map(([, name, value]) => {
    const utility = name.replace(/^radius/, 'rounded');
    return `| \`${utility}\` | \`${value.trim()}\` |`;
  });
  if (rows.length === 0) throw new Error('Missing console theme declarations');
  return [START, '', '| Utility | CSS value |', '| --- | --- |', ...rows, '', END].join('\n');
}

export function updateTokenDocs(guide: string, css: string): string {
  const start = guide.indexOf(START);
  const end = guide.indexOf(END);
  if (start < 0 || end < start) throw new Error('Missing console token documentation markers');
  return guide.slice(0, start) + renderTokenDocs(css) + guide.slice(end + END.length);
}

export function checkRepository(root = ROOT, writeDocs = false): string[] {
  const css = readFileSync(join(root, THEME), 'utf8');
  const guide = readFileSync(join(root, GUIDE), 'utf8');
  const expected = updateTokenDocs(guide, css);
  if (writeDocs) {
    writeFileSync(join(root, GUIDE), expected);
    return [];
  }
  const failures =
    guide === expected
      ? []
      : [
          `${GUIDE}: console scale is stale; run bun run scripts/check-console-tokens.ts --write-docs`,
        ];
  function walk(directory: string): void {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:tsx?|css)$/.test(file))
        failures.push(...checkSource(file, readFileSync(join(root, file), 'utf8')));
    }
  }
  walk(CONSOLE);
  return failures;
}

if (import.meta.main) {
  const failures = checkRepository(ROOT, process.argv.includes('--write-docs'));
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('Console design tokens check passed.');
}
