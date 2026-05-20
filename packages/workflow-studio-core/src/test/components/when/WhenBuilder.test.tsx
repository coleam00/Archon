import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DnfAst } from '../../../lib/grammar';
import { WhenBuilder } from '../../../components/when/WhenBuilder';

afterEach(cleanup);

function setup(initial: DnfAst, upstreamIds: string[] = ['a', 'b']) {
  const calls: DnfAst[] = [];
  const onChange = (next: DnfAst) => calls.push(next);
  const utils = render(
    <WhenBuilder
      dnf={initial}
      upstreamIds={upstreamIds}
      outputFormatLookup={() => null}
      onChange={onChange}
    />
  );
  return { ...utils, calls };
}

const oneAtomDnf: DnfAst = {
  kind: 'or',
  children: [
    {
      kind: 'and',
      children: [
        {
          kind: 'atom',
          ref: { nodeId: 'a', path: ['output'] },
          op: '==',
          value: 'x',
        },
      ],
    },
  ],
};

describe('WhenBuilder', () => {
  it('renders one AtomRow per atom in the DNF', () => {
    setup(oneAtomDnf);
    expect(screen.getAllByTestId('atom-row').length).toBe(1);
  });

  it('"+ AND row" adds a row to the same group', () => {
    const { calls } = setup(oneAtomDnf);
    fireEvent.click(screen.getByText(/\+ AND row/i));
    expect(calls.length).toBe(1);
    expect(calls[0]!.children.length).toBe(1);
    expect(calls[0]!.children[0]!.children.length).toBe(2);
  });

  it('"+ OR group" adds a new group with one empty atom', () => {
    const { calls } = setup(oneAtomDnf);
    fireEvent.click(screen.getByText(/\+ OR group/i));
    expect(calls.length).toBe(1);
    expect(calls[0]!.children.length).toBe(2);
    expect(calls[0]!.children[1]!.children.length).toBe(1);
  });

  it('removing the last atom in a group drops the group entirely', () => {
    const { calls } = setup(oneAtomDnf);
    fireEvent.click(screen.getByLabelText(/remove atom/i));
    expect(calls.length).toBe(1);
    expect(calls[0]!.children.length).toBe(0);
  });

  it('starts with no AtomRows when DNF is empty', () => {
    setup({ kind: 'or', children: [] });
    expect(screen.queryAllByTestId('atom-row').length).toBe(0);
    expect(screen.getByText(/\+ OR group/i)).toBeTruthy();
  });
});
