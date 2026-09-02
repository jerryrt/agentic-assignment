import { describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../src/client.ts';
import { DatabaseQueryError } from '../src/errors.ts';
import { listOrganisations } from '../src/queries/organisations.ts';

/**
 * What a five-line query helper can actually get wrong.
 *
 * Not the policy -- rls.spec.ts probes that against a live stack with a real
 * JWT, which is the only thing a policy has to survive. What is left here is
 * the shape of the call: the relation it reads, the order it asks for, and
 * whether a refusal is raised or silently returned as an empty list. That last
 * one is the reason `unwrapList` exists at all: from the client side a
 * row-level security refusal and "no such row" are the same answer, so a
 * helper that dropped the error would make the security boundary invisible.
 */
interface RecordedQuery {
  from: string;
  select: string;
  orderedBy: string;
}

function clientAnswering(
  outcome: { data: unknown; error: unknown },
  recorded: RecordedQuery,
): DatabaseClient {
  const builder = {
    select(columns: string) {
      recorded.select = columns;
      return this;
    },
    order(column: string) {
      recorded.orderedBy = column;
      return Promise.resolve(outcome);
    },
  };
  return {
    from(relation: string) {
      recorded.from = relation;
      return builder;
    },
  } as unknown as DatabaseClient;
}

describe('listOrganisations', () => {
  it('reads the organisation table, ordered by name', async () => {
    const recorded: RecordedQuery = { from: '', select: '', orderedBy: '' };
    const rows = [{ id: 'a', name: 'Meadowbank Agricultural Credit', created_at: 'now' }];

    const listed = await listOrganisations(
      clientAnswering({ data: rows, error: null }, recorded),
    );

    expect(recorded.from).toBe('organisation');
    expect(recorded.orderedBy).toBe('name');
    expect(listed).toEqual(rows);
  });

  it('reads no rows as an empty list rather than null', async () => {
    const recorded: RecordedQuery = { from: '', select: '', orderedBy: '' };
    expect(
      await listOrganisations(clientAnswering({ data: null, error: null }, recorded)),
    ).toEqual([]);
  });

  // A refusal that came back as [] would be indistinguishable from an empty
  // database, and the chooser would render "no lenders" instead of an error.
  it('raises a refusal rather than returning it as an empty list', async () => {
    const recorded: RecordedQuery = { from: '', select: '', orderedBy: '' };
    const client = clientAnswering(
      { data: null, error: { message: 'permission denied', code: '42501' } },
      recorded,
    );

    await expect(listOrganisations(client)).rejects.toBeInstanceOf(DatabaseQueryError);
  });
});
