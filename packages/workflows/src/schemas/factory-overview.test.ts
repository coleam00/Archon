import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factoryOverviewSchema, type FactoryOverview } from './factory-overview';

type View = FactoryOverview['views'][string];
type Card = View['cards'][number];

const card = (id: string, col: number, row: number, extra: Partial<Card> = {}): Card => ({
  id,
  title: id,
  text: `The ${id} card.`,
  icon: 'hammer',
  kind: 'stage',
  col,
  row,
  ...extra,
});

/** A root of three cards in a row with a lane from the last back to the middle, and one drill-down. */
function valid(): FactoryOverview {
  return {
    version: 1,
    pack: 'acme/factory',
    title: 'How it works',
    caption: 'Work comes in, gets built, lands.',
    root: 'top',
    views: {
      top: {
        cards: [card('in', 1, 1), card('make', 2, 1, { opens: 'make' }), card('check', 3, 1)],
        edges: [
          { from: 'in', to: 'make', kind: 'feeds' },
          { from: 'make', to: 'check', kind: 'feeds' },
          { from: 'check', to: 'make', kind: 'loops-back', label: 'back' },
        ],
      },
      make: {
        cards: [card('write', 1, 1), card('test', 2, 1)],
        edges: [{ from: 'write', to: 'test', kind: 'feeds' }],
      },
    },
  };
}

/**
 * What `overview` is refused for: each issue's path, then the ids from the input it names (the
 * quoted values in its message), so a test pins the rule and the place, not the wording.
 */
function issues(overview: unknown): string[] {
  const parsed = factoryOverviewSchema.safeParse(overview);
  return (parsed.error?.issues ?? []).map(issue => {
    const named = [...issue.message.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    return [issue.path.join('.'), ...named].join(' ');
  });
}

/** `valid()` changed by `edit`. */
function edited(edit: (overview: FactoryOverview) => void): FactoryOverview {
  const overview = valid();
  edit(overview);
  return overview;
}

const top = (overview: FactoryOverview): View => overview.views.top as View;

describe('factoryOverviewSchema', () => {
  test('accepts a valid overview', () => {
    expect(issues(valid())).toEqual([]);
  });

  test('accepts the overview this repository ships', () => {
    const file = join(
      import.meta.dir,
      '../../../../.archon/packs/Wirasm.archon-software-factory.factory-overview.json'
    );
    const overview = JSON.parse(readFileSync(file, 'utf8')) as FactoryOverview;
    expect(issues(overview)).toEqual([]);
    // The Settings page says what changes when a shadow goes live; this file gives every one.
    const unexplained = Object.entries(overview.settings ?? {})
      .filter(([, setting]) => setting.shadow === true && setting.when_live === undefined)
      .map(([name]) => name);
    expect(unexplained).toEqual([]);
  });

  test('rejects an unknown key, so a misspelled field is not silently dropped', () => {
    const parsed = factoryOverviewSchema.safeParse({ ...valid(), captions: 'x' });
    expect(parsed.error?.issues.map(issue => [issue.code, issue.path])).toEqual([
      ['unrecognized_keys', []],
    ]);
  });

  test('accepts a settings map, and rejects a second checks file or a key that is no setting name', () => {
    const settings = {
      plan_policy: { points_to: 'policy' as const },
      checks_file: { points_to: 'checks' as const, shadow: true },
    };
    expect(issues({ ...valid(), settings })).toEqual([]);
    expect(
      issues({ ...valid(), settings: { ...settings, more_checks: { points_to: 'checks' } } })
    ).toEqual(['settings.more_checks.points_to more_checks checks_file']);
    expect(issues({ ...valid(), settings: { '1st': { shadow: true } } })).toEqual(['settings.1st']);
  });

  test('accepts setting sections, and rejects a twice-listed section, an unknown one, or when_live off a shadow', () => {
    const setting_sections = [
      {
        id: 'held',
        eyebrow: 'Policies',
        title: 'What work is held to',
        kind: 'stage' as const,
        icon: 'scale' as const,
      },
      {
        id: 'proven',
        eyebrow: 'Checks',
        title: 'How a change is proven',
        kind: 'check' as const,
        icon: 'flask' as const,
      },
    ];
    const settings = {
      plan_policy: { points_to: 'policy' as const, section: 'held' },
      checks_file: {
        points_to: 'checks' as const,
        shadow: true,
        section: 'proven',
        when_live: 'Would send a change back',
      },
      validate_command: {},
    };
    expect(issues({ ...valid(), setting_sections, settings })).toEqual([]);
    expect(
      issues({ ...valid(), setting_sections: [...setting_sections, setting_sections[0]], settings })
    ).toEqual(['setting_sections.2.id held']);
    expect(
      issues({
        ...valid(),
        setting_sections,
        settings: { ...settings, plan_policy: { section: 'gone' } },
      })
    ).toEqual(['settings.plan_policy.section gone']);
    expect(
      issues({
        ...valid(),
        setting_sections,
        settings: { ...settings, plan_policy: { when_live: 'Would act' } },
      })
    ).toEqual(['settings.plan_policy.when_live']);
  });

  test('rejects a root that names no view', () => {
    expect(issues({ ...valid(), root: 'nope' })).toEqual(['root nope']);
  });

  test('rejects an id used twice across views', () => {
    const overview = edited(o => {
      (o.views.make as View).cards.push(card('in', 3, 1));
    });
    expect(issues(overview)).toEqual(['views.make.cards.2.id in']);
  });

  test('rejects opens that names a missing view, its own view, or a view opened twice', () => {
    expect(
      issues(
        edited(o => {
          (top(o).cards[0] as Card).opens = 'gone';
        })
      )
    ).toEqual(['views.top.cards.0.opens gone']);
    expect(
      issues(
        edited(o => {
          (top(o).cards[0] as Card).opens = 'top';
        })
      )
    ).toEqual(['views.top.cards.0.opens top']);
    expect(
      issues(
        edited(o => {
          (top(o).cards[2] as Card).opens = 'make';
        })
      )
    ).toEqual(['views.top.cards.2.opens make make']);
  });

  test('rejects a view no card opens', () => {
    const overview = edited(o => {
      delete (top(o).cards[1] as Card).opens;
    });
    expect(issues(overview)).toEqual(['views.make']);
  });

  test('rejects a caption on the root view, whose line is the top-level caption', () => {
    const overview = edited(o => {
      top(o).caption = 'Never shown.';
    });
    expect(issues(overview)).toEqual(['views.top.caption']);
  });

  test('rejects a root without a loops-back edge', () => {
    expect(issues(edited(o => void top(o).edges.pop()))).toEqual(['views.top.edges']);
  });

  test('accepts several loops-back lines whose spans nest, each on its own track', () => {
    // `check` and `ship` both send work back to `make`; the longer line runs under the shorter.
    const overview = edited(o => {
      top(o).cards.push(card('ship', 4, 1));
      top(o).edges.push(
        { from: 'check', to: 'ship', kind: 'feeds' },
        { from: 'ship', to: 'make', kind: 'loops-back', label: 'again' },
        { from: 'make', to: 'in', kind: 'loops-back', shadow: true }
      );
    });
    expect(issues(overview)).toEqual([]);
  });

  test('rejects two loops-back lines whose spans interleave: one lane cannot hold both', () => {
    // Columns 1 to 3 and 2 to 4 overlap without one holding the other, so they must cross.
    const overview = edited(o => {
      top(o).cards.push(card('ship', 4, 1));
      top(o).edges[2] = { from: 'check', to: 'in', kind: 'loops-back' };
      top(o).edges.push({ from: 'ship', to: 'make', kind: 'loops-back' });
    });
    expect(issues(overview)).toEqual(['views.top.edges.2 ship make']);
  });

  test('rejects a loops-back line between two cards in one column', () => {
    const overview = edited(o => {
      const make = o.views.make as View;
      make.cards.push(card('below', 3, 2), card('above', 3, 1));
      make.edges.push({ from: 'below', to: 'above', kind: 'loops-back' });
    });
    expect(issues(overview)).toEqual(['views.make.edges.1']);
  });

  test('accepts a reply to an ask, drawn beside it, and the same pair joined again refused', () => {
    const asked = (o: FactoryOverview): View => {
      const make = o.views.make as View;
      make.cards.push(card('you', 1, 2));
      make.edges.push(
        { from: 'write', to: 'you', kind: 'calls', label: 'asks' },
        { from: 'you', to: 'write', kind: 'loops-back', label: 'restarts it' }
      );
      return make;
    };
    expect(issues(edited(asked))).toEqual([]);
    const twice = edited(o => {
      asked(o).edges.push({ from: 'you', to: 'write', kind: 'loops-back' });
    });
    expect(issues(twice)).toEqual(['views.make.edges.3 you write']);
  });

  test('rejects a reply whose ask runs through a card, as the ask is', () => {
    const overview = edited(o => {
      const make = o.views.make as View;
      make.cards.push(card('mid', 1, 2), card('you', 1, 3));
      make.edges.push(
        { from: 'write', to: 'you', kind: 'calls' },
        { from: 'you', to: 'write', kind: 'loops-back' }
      );
    });
    expect(issues(overview)).toEqual(['views.make.edges.1 mid', 'views.make.edges.2 mid']);
  });

  test('rejects two cards in one cell', () => {
    const overview = edited(o => {
      (o.views.make as View).cards[1] = card('test', 1, 1);
    });
    expect(issues(overview)).toContain('views.make.cards.1 write');
  });

  test('rejects a card naming an undeclared group, an empty group, and a group holding a stranger', () => {
    expect(
      issues(
        edited(o => {
          (top(o).cards[0] as Card).group = 'nope';
        })
      )
    ).toEqual(['views.top.cards.0.group nope']);
    expect(
      issues(
        edited(o => {
          top(o).groups = [{ id: 'empty', label: 'Empty' }];
        })
      )
    ).toEqual(['views.top.groups.0 empty']);
    // A group of `in` and `check` spans column 2, where `make` sits outside it.
    const stranger = edited(o => {
      top(o).groups = [{ id: 'ends', label: 'Ends' }];
      (top(o).cards[0] as Card).group = 'ends';
      (top(o).cards[2] as Card).group = 'ends';
    });
    expect(issues(stranger)).toContain('views.top.groups.0 ends make');
  });

  test('rejects an edge naming nothing, joining a card to itself, or repeating a pair', () => {
    expect(
      issues(
        edited(o => {
          (o.views.make as View).edges.push({ from: 'write', to: 'gone', kind: 'calls' });
        })
      )
    ).toEqual(['views.make.edges.1.to gone']);
    expect(
      issues(
        edited(o => {
          (o.views.make as View).edges.push({ from: 'test', to: 'test', kind: 'calls' });
        })
      )
    ).toEqual(['views.make.edges.1']);
    expect(
      issues(
        edited(o => {
          (o.views.make as View).edges.push({ from: 'test', to: 'write', kind: 'calls' });
        })
      )
    ).toEqual(['views.make.edges.1 test write']);
  });

  test('rejects an edge whose ends share no row or column', () => {
    const overview = edited(o => {
      const make = o.views.make as View;
      make.cards.push(card('far', 3, 2));
      make.edges.push({ from: 'write', to: 'far', kind: 'calls' });
    });
    expect(issues(overview)).toEqual(['views.make.edges.1']);
  });

  test('rejects an edge that runs through a card', () => {
    const overview = edited(o => {
      top(o).edges.push({ from: 'in', to: 'check', kind: 'calls' });
    });
    expect(issues(overview)).toContain('views.top.edges.3 make');
  });

  test('rejects an edge that runs through a group holding neither end', () => {
    // `mid` sits in a group in row 1; an edge in row 1 between cards either side of it crosses it.
    const overview = edited(o => {
      const make = o.views.make as View;
      make.groups = [{ id: 'mid', label: 'Mid' }];
      make.cards = [card('write', 1, 1), card('test', 2, 2, { group: 'mid' }), card('ship', 3, 2)];
      make.cards.push(card('top-left', 1, 2));
      make.edges = [{ from: 'top-left', to: 'ship', kind: 'feeds' }];
    });
    expect(issues(overview)).toEqual(
      expect.arrayContaining(['views.make.edges.0 test', 'views.make.edges.0 mid'])
    );
  });

  test('rejects two lines that cross in an empty cell', () => {
    // A row-2 line from (1,2) to (3,2) and a column-2 line from (2,1) to (2,3) meet at (2,2).
    const overview = edited(o => {
      const make = o.views.make as View;
      make.cards = [card('w', 1, 2), card('e', 3, 2), card('n', 2, 1), card('s', 2, 3)];
      make.edges = [
        { from: 'w', to: 'e', kind: 'feeds' },
        { from: 'n', to: 's', kind: 'calls' },
      ];
    });
    expect(issues(overview)).toEqual(['views.make.edges.0 n s']);
  });

  test('rejects a loops-back lane that would drop through a card under its source', () => {
    const overview = edited(o => {
      top(o).cards.push(card('under', 3, 2));
    });
    expect(issues(overview)).toContain('views.top.edges.2 under');
  });

  test('rejects a loops-back edge from a group', () => {
    const overview = edited(o => {
      top(o).groups = [{ id: 'g', label: 'G' }];
      (top(o).cards[2] as Card).group = 'g';
      top(o).edges[2] = { from: 'g', to: 'make', kind: 'loops-back' };
    });
    expect(issues(overview)).toEqual(['views.top.edges.2']);
  });
});
