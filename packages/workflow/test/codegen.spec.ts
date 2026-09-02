import { describe, expect, it } from 'vitest';

import { WorkflowTransitionSchema } from '@lj/domain';

import {
  allTransitionRows,
  defineMachine,
  parseTransitionsSql,
  renderTransitionsSql,
  transitionRows,
} from '../src/index.ts';

describe('transitionRows', () => {
  /**
   * A `from` list is shorthand for one row per state, and an actor list is
   * shorthand for one row per role, because the primary key of
   * workflow_transition is (machine, from_state, event, actor_role). Flattening
   * both is the whole job of the generator.
   */
  it('emits one row per (from, actor) pair', () => {
    const machine = defineMachine<'a' | 'b' | 'c', 'go', Record<string, never>>({
      id: 'application',
      initial: 'a',
      states: ['a', 'b', 'c'],
      transitions: [{ from: ['a', 'b'], event: 'go', to: 'c', actor: ['lender', 'admin'] }],
    });

    expect(transitionRows(machine)).toEqual([
      { machine: 'application', from_state: 'a', event: 'go', to_state: 'c', actor_role: 'admin' },
      { machine: 'application', from_state: 'a', event: 'go', to_state: 'c', actor_role: 'lender' },
      { machine: 'application', from_state: 'b', event: 'go', to_state: 'c', actor_role: 'admin' },
      { machine: 'application', from_state: 'b', event: 'go', to_state: 'c', actor_role: 'lender' },
    ]);
  });

  it('produces rows the domain schema accepts', () => {
    for (const row of allTransitionRows()) {
      expect(() => WorkflowTransitionSchema.parse(row)).not.toThrow();
    }
  });

  /**
   * A duplicate would be rejected by the primary key at apply time, which is
   * the wrong place to find out. defineMachine rejects it per machine; this
   * checks the flattened set as a whole.
   */
  it('emits no two rows sharing the generated primary key', () => {
    const keys = allTransitionRows().map((row) =>
      [row.machine, row.from_state, row.event, row.actor_role].join('|'),
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * Byte-stable output is what makes `workflow:check` a diff rather than a
   * guess, so the order is the primary key's order and never the definition's.
   */
  it('sorts by the primary key so regeneration is byte-stable', () => {
    const rows = allTransitionRows();
    // Code point order, not localeCompare: a collation that ignores '_'
    // would order the file differently on a different machine.
    const sorted = [...rows].sort((left, right) => {
      const leftKey = [left.machine, left.from_state, left.event, left.actor_role].join('|');
      const rightKey = [right.machine, right.from_state, right.event, right.actor_role].join('|');
      if (leftKey === rightKey) {
        return 0;
      }
      return leftKey < rightKey ? -1 : 1;
    });

    expect(rows).toEqual(sorted);
  });

  it('covers all three machines', () => {
    expect(new Set(allTransitionRows().map((row) => row.machine))).toEqual(
      new Set(['application', 'credit_release', 'document_slot']),
    );
  });
});

describe('renderTransitionsSql', () => {
  const sql = renderTransitionsSql(allTransitionRows());

  it('replaces the table rather than adding to it, so re-applying is safe', () => {
    expect(sql).toContain('delete from public.workflow_transition;');
    expect(sql).toContain(
      'insert into public.workflow_transition\n  (machine, from_state, event, to_state, actor_role)',
    );
  });

  it('says where it came from and that it must not be hand-edited', () => {
    expect(sql).toMatch(/generated/i);
    expect(sql).toMatch(/workflow:gen/);
  });

  /**
   * Nothing about the file may depend on when it was produced: `workflow:check`
   * compares content, and a generation timestamp would make it compare
   * something that always differs.
   */
  it('renders the same bytes every time', () => {
    expect(renderTransitionsSql(allTransitionRows())).toBe(sql);
    expect(sql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  /**
   * "Parameterised queries only. No string-built SQL" (CLAUDE.md section 10).
   * A generator has to build SQL, so the compensating control is that a value
   * which is not a bare lower-case identifier stops the build rather than being
   * escaped and hoped about.
   */
  it('refuses a value that is not a bare identifier', () => {
    expect(() =>
      renderTransitionsSql([
        {
          machine: 'application',
          from_state: "draft'); drop table workflow_transition; --",
          event: 'submit',
          to_state: 'submitted',
          actor_role: 'borrower',
        },
      ]),
    ).toThrow(/identifier/i);
  });

  it('ends with a single trailing newline', () => {
    expect(sql.endsWith(';\n')).toBe(true);
    expect(sql.endsWith(';\n\n')).toBe(false);
  });
});

describe('parseTransitionsSql', () => {
  it('reads back exactly what it wrote', () => {
    const rows = allTransitionRows();

    expect(parseTransitionsSql(renderTransitionsSql(rows))).toEqual(rows);
  });

  it('ignores tuples that appear inside comments', () => {
    const sql = [
      "-- ('application', 'draft', 'submit', 'submitted', 'borrower') is an example",
      'delete from public.workflow_transition;',
      'insert into public.workflow_transition',
      '  (machine, from_state, event, to_state, actor_role)',
      'values',
      "  ('application', 'draft', 'withdraw', 'withdrawn', 'borrower');",
      '',
    ].join('\n');

    expect(parseTransitionsSql(sql)).toEqual([
      {
        machine: 'application',
        from_state: 'draft',
        event: 'withdraw',
        to_state: 'withdrawn',
        actor_role: 'borrower',
      },
    ]);
  });

  it('refuses a file with no insert statement rather than reporting no rows', () => {
    expect(() => parseTransitionsSql('delete from public.workflow_transition;\n')).toThrow(
      /insert/i,
    );
  });
});
