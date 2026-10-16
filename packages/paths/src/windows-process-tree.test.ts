// @archon-test-isolated
import { describe, expect, it, spyOn } from 'bun:test';
import { testTimeout } from '@archon/paths/test-utils';
import {
  listWindowsProcesses,
  parseWindowsProcessListing,
  terminateWindowsProcessTree,
  windowsProcessCommands,
  WindowsProcessTree,
  type WindowsProcessListing,
  type WindowsProcessRow,
} from './windows-process-tree';

function row(pid: number, parentPid: number, created: number): WindowsProcessRow {
  return { pid, parentPid, created: BigInt(created) };
}

function listing(takenAt: number, rows: WindowsProcessRow[]): WindowsProcessListing {
  return { takenAt: BigInt(takenAt), rows };
}

function treeFrom(rootPid: number, first: WindowsProcessListing): WindowsProcessTree {
  const tree = WindowsProcessTree.fromRoot(rootPid, first);
  if (!tree) throw new Error('Expected the root to be listed');
  return tree;
}

describe('WindowsProcessTree', () => {
  it('is undefined when the root is not listed, since nothing pins its identity', () => {
    expect(WindowsProcessTree.fromRoot(10, listing(100, [row(11, 10, 50)]))).toBeUndefined();
  });

  it('tracks descendants at any depth and ignores unrelated processes', () => {
    const tree = treeFrom(
      10,
      listing(100, [row(10, 1, 10), row(11, 10, 20), row(12, 11, 30), row(99, 1, 5)])
    );
    expect(
      tree.observe(listing(200, [row(10, 1, 10), row(11, 10, 20), row(12, 11, 30), row(99, 1, 5)]))
    ).toEqual([10, 11, 12]);
  });

  it('finds a child spawned after the first listing whose parent has since exited', () => {
    // The case `taskkill /T` misses: the root spawned 13 during the kill, then died.
    // Windows keeps 13's ParentProcessId, so the tree still owns it.
    const tree = treeFrom(10, listing(100, [row(10, 1, 10), row(11, 10, 20)]));
    expect(tree.observe(listing(200, [row(13, 10, 150)]))).toEqual([13]);
  });

  it('keeps a member found through a parent that later exits', () => {
    const tree = treeFrom(10, listing(100, [row(10, 1, 10)]));
    expect(tree.observe(listing(200, [row(11, 10, 150), row(12, 11, 160)]))).toEqual([11, 12]);
    // 11 is killed; 14 was spawned by 11 before it died and is still found.
    expect(tree.observe(listing(300, [row(12, 11, 160), row(14, 11, 250)]))).toEqual([12, 14]);
    expect(tree.observe(listing(400, []))).toEqual([]);
  });

  it('does not adopt the child of a process that reused a member PID', () => {
    const tree = treeFrom(10, listing(100, [row(10, 1, 10), row(11, 10, 20)]));
    // 11 exits and is seen gone at 200. PID 11 is reused at 250 by an unrelated process,
    // whose child 30 appears at 260: created after 11 was seen gone, so not ours.
    expect(tree.observe(listing(200, [row(10, 1, 10)]))).toEqual([10]);
    expect(
      tree.observe(listing(300, [row(1, 0, 1), row(10, 1, 10), row(11, 1, 250), row(30, 11, 260)]))
    ).toEqual([10]);
  });

  it('does not adopt a process older than the parent PID it names', () => {
    // 20 names 10 as parent but predates this 10: its parent was an earlier holder of PID 10.
    const tree = treeFrom(10, listing(100, [row(10, 1, 50), row(20, 10, 40)]));
    expect(tree.observe(listing(200, [row(10, 1, 50), row(20, 10, 40)]))).toEqual([10]);
  });

  it('rejects an initial orphan that remains at confirmation', () => {
    const tree = treeFrom(10, listing(100, [row(10, 1, 10), row(12, 11, 50)]));
    expect(() => tree.observe(listing(200, [row(12, 11, 50)]))).toThrow('unproved ancestry');
  });

  it('ignores orphans born outside the owned lifetime', () => {
    const tree = treeFrom(10, listing(100, [row(10, 1, 10), row(20, 19, 5)]));
    expect(tree.observe(listing(200, []))).toEqual([]);
    expect(tree.observe(listing(300, [row(30, 29, 250)]))).toEqual([]);
  });

  it('rejects a missing parent hidden by a younger PID reuser', () => {
    const tree = treeFrom(10, listing(100, [row(10, 1, 10)]));
    expect(() => tree.observe(listing(200, [row(12, 11, 150), row(11, 1, 160)]))).toThrow(
      'unproved ancestry'
    );
  });

  it('treats a reused root PID as the root being gone', () => {
    const tree = treeFrom(10, listing(100, [row(10, 1, 10)]));
    expect(tree.observe(listing(200, [row(1, 0, 1), row(10, 1, 150)]))).toEqual([]);
  });
});

it.skipIf(process.platform !== 'win32')(
  'parses the real encoded PowerShell listing and finds this process',
  async () => {
    const listing = await listWindowsProcesses();
    expect(listing.takenAt).toBeGreaterThan(0n);
    const current = listing.rows.find(row => row.pid === process.pid);
    expect(current).toBeDefined();
    if (!current) throw new Error('Current process missing from Windows listing');
    expect(current.parentPid).toBe(process.ppid);
    expect(current.created).toBeGreaterThan(0n);
    expect(current.created).toBeLessThanOrEqual(listing.takenAt);
  },
  testTimeout(35_000)
);

describe('parseWindowsProcessListing', () => {
  it('reads the listing script output, keeping tick precision beyond 2^53', () => {
    const parsed = parseWindowsProcessListing(
      '{"takenAt":"639251234567890123","rows":[{"pid":10,"parentPid":4,"created":"639251234000000001"}]}'
    );
    expect(parsed.takenAt).toBe(639251234567890123n);
    expect(parsed.rows).toEqual([{ pid: 10, parentPid: 4, created: 639251234000000001n }]);
  });

  it('accepts an empty table', () => {
    expect(parseWindowsProcessListing('{"takenAt":"1","rows":[]}').rows).toEqual([]);
  });

  it.each([
    ['not an object', '"text"'],
    ['missing rows', '{"takenAt":"1"}'],
    ['a numeric takenAt', '{"takenAt":1,"rows":[]}'],
    ['a row without a creation time', '{"takenAt":"1","rows":[{"pid":1,"parentPid":0}]}'],
    ['a non-integer pid', '{"takenAt":"1","rows":[{"pid":"1","parentPid":0,"created":"1"}]}'],
    ['a signed creation time', '{"takenAt":"1","rows":[{"pid":1,"parentPid":0,"created":"-1"}]}'],
  ])('rejects %s', (_label, json) => {
    expect(() => parseWindowsProcessListing(json)).toThrow('unexpected shape');
  });
});

describe('Windows cleanup with unobserved ancestry', () => {
  it.each([false, true])(
    'rejects a surviving grandchild (root absent initially=%s)',
    async absent => {
      let listings = 0;
      const commands = spyOn(windowsProcessCommands, 'execFile').mockImplementation(
        async command => {
          if (command === 'taskkill') return { stdout: 'SUCCESS', stderr: '' };
          listings++;
          return {
            stdout: JSON.stringify({
              takenAt: String(listings * 100),
              rows:
                !absent && listings === 1
                  ? [{ pid: 10, parentPid: 1, created: '10' }]
                  : [{ pid: 12, parentPid: 11, created: '150' }],
            }),
            stderr: '',
          };
        }
      );
      const kill = spyOn(process, 'kill').mockReturnValue(true);
      try {
        await expect(terminateWindowsProcessTree(10, () => {})).rejects.toThrow(
          'Could not confirm process tree 10 exited'
        );
        expect(kill).not.toHaveBeenCalled();
      } finally {
        commands.mockRestore();
        kill.mockRestore();
      }
    }
  );
});

it('cannot confirm an absent root even when the listing is empty', async () => {
  const commands = spyOn(windowsProcessCommands, 'execFile').mockResolvedValue({
    stdout: '{"takenAt":"100","rows":[]}',
    stderr: '',
  });
  try {
    await expect(terminateWindowsProcessTree(10, () => {})).rejects.toThrow(
      'its root was already gone'
    );
    expect(commands).toHaveBeenCalledTimes(1);
  } finally {
    commands.mockRestore();
  }
});

it.each([false, true])(
  'attempts the owned root kill before rejecting initial ambiguity (kill fails=%s)',
  async fails => {
    let ownershipChecked = false;
    const commands = spyOn(windowsProcessCommands, 'execFile').mockImplementation(async command => {
      if (command === 'taskkill') {
        expect(ownershipChecked).toBe(true);
        if (fails) throw new Error('taskkill denied');
        return { stdout: 'SUCCESS', stderr: '' };
      }
      return {
        stdout:
          '{"takenAt":"100","rows":[{"pid":10,"parentPid":1,"created":"10"},{"pid":12,"parentPid":11,"created":"50"}]}',
        stderr: '',
      };
    });
    const kill = spyOn(process, 'kill').mockReturnValue(true);
    try {
      await expect(
        terminateWindowsProcessTree(10, () => {
          ownershipChecked = true;
        })
      ).rejects.toThrow(
        fails
          ? 'taskkill denied; Could not confirm process tree 10 exited: processes 12 have unproved ancestry'
          : 'processes 12 have unproved ancestry'
      );
      expect(commands.mock.calls.map(([command]) => command)).toEqual([
        'powershell.exe',
        'taskkill',
        'powershell.exe',
      ]);
      expect(commands.mock.calls[1]?.[1]).toEqual(['/PID', '10', '/T', '/F']);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      commands.mockRestore();
      kill.mockRestore();
    }
  }
);

it.each(['listing command', 'listing shape', 'ancestry', 'survivors'] as const)(
  'retains the taskkill failure when later confirmation fails: %s',
  async failure => {
    const taskkillError = new Error('taskkill denied');
    const listingError = new Error('process listing denied');
    let listings = 0;
    const commands = spyOn(windowsProcessCommands, 'execFile').mockImplementation(async command => {
      if (command === 'taskkill') throw taskkillError;
      listings++;
      if (listings > 2) {
        if (failure === 'listing command') throw listingError;
        if (failure === 'listing shape') return { stdout: '{}', stderr: '' };
      }
      return {
        stdout: JSON.stringify({
          takenAt: String(listings * 100),
          rows:
            listings > 2 && failure === 'ancestry'
              ? [{ pid: 12, parentPid: 11, created: '150' }]
              : [{ pid: 10, parentPid: 1, created: '10' }],
        }),
        stderr: '',
      };
    });
    const kill = spyOn(process, 'kill').mockReturnValue(true);
    const evidence = {
      'listing command': 'process listing denied',
      'listing shape': 'Windows process listing had an unexpected shape',
      ancestry: 'processes 12 have unproved ancestry',
      survivors: 'processes 10 are still running',
    }[failure];
    try {
      const error = await terminateWindowsProcessTree(10, () => {}).catch(
        (error: unknown) => error
      );
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected cleanup to fail');
      expect(error.message).toContain('taskkill denied; ');
      expect(error.message).toContain(evidence);
      expect(error.cause).toBeInstanceOf(Error);
      if (failure === 'listing command') expect(error.cause).toBe(listingError);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      commands.mockRestore();
      kill.mockRestore();
    }
  }
);

it('accepts independently confirmed absence after taskkill fails', async () => {
  let listings = 0;
  const commands = spyOn(windowsProcessCommands, 'execFile').mockImplementation(async command => {
    if (command === 'taskkill') throw new Error('taskkill denied');
    listings++;
    return {
      stdout: JSON.stringify({
        takenAt: String(listings * 100),
        rows: listings === 1 ? [{ pid: 10, parentPid: 1, created: '10' }] : [],
      }),
      stderr: '',
    };
  });
  try {
    await expect(terminateWindowsProcessTree(10, () => {})).resolves.toBeUndefined();
  } finally {
    commands.mockRestore();
  }
});

it.each([false, true])(
  'confirms cleanup after an initially ambiguous orphan exits (leaves child=%s)',
  async leavesChild => {
    let listings = 0;
    const commands = spyOn(windowsProcessCommands, 'execFile').mockImplementation(async command => {
      if (command === 'taskkill') return { stdout: 'SUCCESS', stderr: '' };
      listings++;
      return {
        stdout: JSON.stringify(
          {
            takenAt: String(listings * 100),
            rows:
              listings === 1
                ? [row(10, 1, 10), row(12, 11, 50)]
                : leavesChild
                  ? [row(13, 12, 150)]
                  : [],
          },
          (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value)
        ),
        stderr: '',
      };
    });
    try {
      const outcome = terminateWindowsProcessTree(10, () => {});
      if (leavesChild) {
        await expect(outcome).rejects.toThrow('processes 13 have unproved ancestry');
      } else {
        await expect(outcome).resolves.toBeUndefined();
      }
      expect(commands.mock.calls.map(([command]) => command)).toEqual([
        'powershell.exe',
        'taskkill',
        'powershell.exe',
      ]);
    } finally {
      commands.mockRestore();
    }
  }
);

it('does not kill an initially ambiguous tree after root ownership is lost', async () => {
  const commands = spyOn(windowsProcessCommands, 'execFile').mockResolvedValue({
    stdout:
      '{"takenAt":"100","rows":[{"pid":10,"parentPid":1,"created":"10"},{"pid":12,"parentPid":11,"created":"50"}]}',
    stderr: '',
  });
  try {
    await expect(
      terminateWindowsProcessTree(10, () => {
        throw new Error('root ownership lost');
      })
    ).rejects.toThrow('root ownership lost');
    expect(commands).toHaveBeenCalledTimes(1);
  } finally {
    commands.mockRestore();
  }
});

it('never signals survivors from a Windows process listing after taskkill', async () => {
  let listings = 0;
  const commands = spyOn(windowsProcessCommands, 'execFile').mockImplementation(async command => {
    if (command === 'taskkill') return { stdout: 'SUCCESS', stderr: '' };
    listings++;
    return {
      stdout: JSON.stringify({
        takenAt: String(listings * 100),
        rows:
          listings === 1
            ? [
                { pid: 10, parentPid: 1, created: '10' },
                { pid: 11, parentPid: 10, created: '20' },
              ]
            : [{ pid: 11, parentPid: 10, created: '20' }],
      }),
      stderr: '',
    };
  });
  const kill = spyOn(process, 'kill').mockReturnValue(true);
  try {
    await expect(terminateWindowsProcessTree(10, () => {})).rejects.toThrow(
      'processes 11 are still running'
    );
    expect(kill).not.toHaveBeenCalled();
    expect(commands.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(1);
  } finally {
    kill.mockRestore();
    commands.mockRestore();
  }
});
