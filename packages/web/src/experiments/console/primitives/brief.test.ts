import { describe, expect, test } from 'bun:test';
import {
  BRIEF_PARTS,
  EMPTY_BRIEF,
  filledParts,
  isBriefEmpty,
  parseBrief,
  serializeBrief,
} from './brief';

describe('parseBrief', () => {
  test('absent summaries read as null, not as an empty one', () => {
    expect(parseBrief(null)).toBeNull();
    expect(parseBrief(undefined)).toBeNull();
    expect(parseBrief('')).toBeNull();
    expect(parseBrief('   \n ')).toBeNull();
  });

  test('reads the three parts out of stored JSON', () => {
    const b = parseBrief('{"doing":"Rail","where":"Half","left":"Deploy"}');
    expect(b).toEqual({ doing: 'Rail', where: 'Half', left: 'Deploy' });
  });

  test('a missing part is empty rather than undefined', () => {
    expect(parseBrief('{"doing":"Rail"}')).toEqual({ doing: 'Rail', where: '', left: '' });
  });

  test('free text written before the three-part shape lands in the first part', () => {
    expect(parseBrief('We are building the rail.')).toEqual({
      ...EMPTY_BRIEF,
      doing: 'We are building the rail.',
    });
  });

  test('text that merely looks like JSON is still readable', () => {
    expect(parseBrief('{not json')).toEqual({ ...EMPTY_BRIEF, doing: '{not json' });
  });

  test('a JSON object with none of our keys is shown, not silently dropped', () => {
    const raw = '{"summary":"the old shape"}';
    expect(parseBrief(raw)).toEqual({ ...EMPTY_BRIEF, doing: raw });
  });

  test('arrays and scalars are free text, not parts', () => {
    expect(parseBrief('["a"]')).toEqual({ ...EMPTY_BRIEF, doing: '["a"]' });
    expect(parseBrief('42')).toEqual({ ...EMPTY_BRIEF, doing: '42' });
  });

  test('non-string parts are ignored rather than rendered as [object Object]', () => {
    expect(parseBrief('{"doing":"Rail","where":{"a":1},"left":7}')).toEqual({
      doing: 'Rail',
      where: '',
      left: '',
    });
  });

  test('parts are trimmed', () => {
    expect(parseBrief('{"doing":"  Rail  "}')?.doing).toBe('Rail');
  });
});

describe('serializeBrief', () => {
  test('a brief with nothing in it clears the summary', () => {
    expect(serializeBrief(EMPTY_BRIEF)).toBeNull();
    expect(serializeBrief({ doing: ' ', where: '\n', left: '' })).toBeNull();
  });

  test('round-trips', () => {
    const b = { doing: 'Rail', where: 'Half', left: 'Deploy' };
    expect(parseBrief(serializeBrief(b))).toEqual(b);
  });

  test('round-trips a partly-filled brief', () => {
    const b = { doing: 'Rail', where: '', left: '' };
    expect(parseBrief(serializeBrief(b))).toEqual(b);
  });

  test('trims before storing', () => {
    expect(serializeBrief({ doing: '  Rail ', where: '', left: '' })).toBe(
      '{"doing":"Rail","where":"","left":""}'
    );
  });
});

describe('filledParts', () => {
  test('skips the parts nobody wrote', () => {
    const parts = filledParts({ doing: 'Rail', where: '', left: 'Deploy' });
    expect(parts.map(p => p.key)).toEqual(['doing', 'left']);
  });

  test('keeps the declared reading order', () => {
    const parts = filledParts({ doing: 'a', where: 'b', left: 'c' });
    expect(parts.map(p => p.key)).toEqual(BRIEF_PARTS.map(p => p.key));
  });

  test('an empty brief has no parts to read', () => {
    expect(filledParts(EMPTY_BRIEF)).toEqual([]);
    expect(isBriefEmpty(EMPTY_BRIEF)).toBe(true);
  });
});
