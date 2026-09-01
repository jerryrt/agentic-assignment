import { WorkflowTransitionSchema } from '@lj/domain';
import type { WorkflowTransition } from '@lj/domain';

/**
 * The migration body, and the parser that reads one back.
 *
 * Both directions live here because the parity test needs the second one: it
 * compares the committed migration with the machine definitions as *rows*, not
 * as text. Comparing text passes for the wrong reason -- identical formatting
 * around a wrong row -- and fails for the wrong reason, when a comment is
 * reflowed. Neither answer is about legality.
 */

/**
 * Every value written into this file is a state, event or role name, and all
 * three are bare lower-case identifiers. "Parameterised queries only. No
 * string-built SQL" (CLAUDE.md section 10) cannot be honoured by a generator,
 * which has no parameters to bind, so the compensating control is that anything
 * needing an escape stops the build instead of being escaped and hoped about.
 */
const BARE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

const HEADER = [
  '-- GENERATED FILE -- DO NOT EDIT.',
  '--',
  '-- Emitted by `pnpm workflow:gen` from the machine definitions in',
  '-- packages/workflow/src/machines. Legality is enforced twice -- by those',
  '-- definitions in TypeScript and by the assert_legal_transition trigger',
  '-- reading this table -- and defined once, here being the once. Edit a',
  '-- machine and regenerate; the parity test in packages/workflow compares the',
  '-- two on every run.',
  '--',
  '-- The table is replaced rather than added to. These rows have exactly one',
  '-- source, so a regeneration is a replacement, and delete-then-insert makes',
  '-- the migration safe to apply a second time. Migrations are append-only, so',
  '-- a later machine edit emits a new numbered file rather than editing this',
  '-- one; applied in order, the newest wins.',
  '--',
  '-- No BEGIN/COMMIT: the Supabase CLI already runs each migration in one',
  '-- transaction, and a nested explicit block would only make that harder to',
  '-- reason about.',
].join('\n');

function literal(value: string, column: string): string {
  if (!BARE_IDENTIFIER.test(value)) {
    throw new Error(
      "workflow_transition." +
        column +
        " value '" +
        value +
        "' is not a bare identifier, and this generator does not escape SQL literals",
    );
  }
  return "'" + value + "'";
}

export function renderTransitionsSql(rows: readonly WorkflowTransition[]): string {
  if (rows.length === 0) {
    throw new Error(
      'refusing to generate an empty transitions migration: an empty ' +
        'workflow_transition table makes every state change illegal',
    );
  }

  const values = rows.map((row) =>
    '  (' +
    [
      literal(row.machine, 'machine'),
      literal(row.from_state, 'from_state'),
      literal(row.event, 'event'),
      literal(row.to_state, 'to_state'),
      literal(row.actor_role, 'actor_role'),
    ].join(', ') +
    ')',
  );

  return (
    HEADER +
    '\n\n' +
    'delete from public.workflow_transition;\n' +
    '\n' +
    'insert into public.workflow_transition\n' +
    '  (machine, from_state, event, to_state, actor_role)\n' +
    'values\n' +
    values.join(',\n') +
    ';\n'
  );
}

/**
 * Strip `--` comments so that an example tuple written in prose is not read as a
 * row. Safe without a real SQL lexer only because the generator refuses any
 * value that is not a bare identifier, so no string literal in this file can
 * contain a `--`.
 */
function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

const TUPLE =
  /\(\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'\s*\)/g;

export function parseTransitionsSql(sql: string): readonly WorkflowTransition[] {
  const body = withoutComments(sql);
  const insertAt = body.indexOf('insert into public.workflow_transition');
  if (insertAt < 0) {
    throw new Error(
      'no `insert into public.workflow_transition` in the migration: refusing to report ' +
        'zero transitions, which would look like agreement with an empty machine',
    );
  }

  const statement = body.slice(insertAt);
  const rows: WorkflowTransition[] = [];
  TUPLE.lastIndex = 0;
  let match = TUPLE.exec(statement);
  while (match !== null) {
    rows.push(
      WorkflowTransitionSchema.parse({
        machine: match[1],
        from_state: match[2],
        event: match[3],
        to_state: match[4],
        actor_role: match[5],
      }),
    );
    match = TUPLE.exec(statement);
  }

  return rows;
}
