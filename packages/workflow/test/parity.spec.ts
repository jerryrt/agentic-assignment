import { describe, expect, it } from 'vitest';

import { WorkflowTransitionSchema } from '@lj/domain';

import { allTransitionRows, parseTransitionsSql } from '../src/index.ts';

/**
 * Belt and braces, checked against each other.
 *
 * Legality is enforced twice -- by the machine definitions in TypeScript and by
 * the BEFORE UPDATE trigger reading `workflow_transition` -- and defined once.
 * This is the test that stops the two from drifting: it parses the committed
 * migration and compares the rows it declares with the rows the definitions
 * produce.
 *
 * It compares parsed rows rather than SQL text on purpose. A string comparison
 * passes for the wrong reason (identical formatting around a wrong row) and
 * fails for the wrong reason (a reflowed comment), and neither answer is about
 * legality.
 *
 * The glob rather than a fixed filename is what makes the check survive
 * regeneration: migrations are append-only, so a machine edit emits a new
 * numbered file and the newest one is the one in force.
 */

const MIGRATIONS = import.meta.glob('../../../supabase/migrations/*_workflow_transitions.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function newestGeneratedMigration(): { readonly name: string; readonly sql: string } {
  const paths = Object.keys(MIGRATIONS).sort();
  const path = paths[paths.length - 1];
  if (path === undefined) {
    throw new Error(
      'No generated transitions migration is committed. Run `pnpm workflow:gen`; until one ' +
        'exists the trigger refuses every state change.',
    );
  }
  const sql = MIGRATIONS[path];
  if (sql === undefined) {
    throw new Error('glob returned a path with no contents: ' + path);
  }
  return { name: path.slice(path.lastIndexOf('/') + 1), sql };
}

describe('the generated migration', () => {
  const migration = newestGeneratedMigration();

  it('is named so that it sorts after the schema it depends on', () => {
    expect(migration.name).toMatch(/^\d{4}_workflow_transitions\.sql$/);
    expect(migration.name > '0001_init.sql').toBe(true);
  });

  it('declares exactly the transitions the machine definitions declare', () => {
    expect(parseTransitionsSql(migration.sql)).toEqual(allTransitionRows());
  });

  it('declares rows the domain schema accepts', () => {
    for (const row of parseTransitionsSql(migration.sql)) {
      expect(() => WorkflowTransitionSchema.parse(row)).not.toThrow();
    }
  });

  /**
   * Without the delete the migration would be additive, and re-applying it -- or
   * applying it after an earlier generation -- would leave transitions the
   * machines no longer declare still legal in the database. Stale rows widen
   * what the trigger permits, which is the dangerous direction.
   */
  it('replaces the table, so an earlier generation cannot leave stale rows behind', () => {
    expect(migration.sql).toContain('delete from public.workflow_transition;');
    expect(migration.sql.indexOf('delete from public.workflow_transition;')).toBeLessThan(
      migration.sql.indexOf('insert into public.workflow_transition'),
    );
  });

  it('warns the next reader not to hand-edit it', () => {
    expect(migration.sql).toMatch(/do not edit/i);
  });
});
