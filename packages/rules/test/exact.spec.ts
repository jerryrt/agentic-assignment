import { describe, expect, it } from 'vitest';

import { RuleResultSchema } from '@lj/domain';

import {
  awaiting,
  exactAgreement,
  known,
  missingInput,
  normaliseEntityName,
  oneOf,
  readText,
  type Reading,
} from '../src/index.js';

type Ctx = Reading<string>;

const eligibleCommodity = oneOf<Ctx>({
  id: 'eligible_commodity',
  label: 'Eligible commodity',
  allowed: ['grain', 'oilseed'],
  read: (context) => context,
});

describe('oneOf', () => {
  it('passes a value on the list', () => {
    const result = eligibleCommodity.evaluate(known('grain'));
    expect(result.status).toBe('pass');
    expect(result.explain).toBe('Accepted: grain and oilseed -- you entered grain.');
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('fails a value off the list, with no delta: a category has no distance', () => {
    const result = eligibleCommodity.evaluate(known('livestock'));
    expect(result.status).toBe('fail');
    expect(result.delta).toBeNull();
    expect(result.explain).toBe('Accepted: grain and oilseed -- you entered livestock.');
  });

  it('is unknown before the applicant has chosen', () => {
    const result = eligibleCommodity.evaluate(
      awaiting([missingInput('primary_commodity', 'your main commodity')]),
    );
    expect(result.status).toBe('unknown');
    expect(result.missing).toEqual(['primary_commodity']);
    expect(result.explain).toBe('Accepted: grain and oilseed -- enter your main commodity.');
  });

  it('records the list and the value it read', () => {
    expect(eligibleCommodity.evaluate(known('grain')).inputs).toEqual({
      actual: 'grain',
      allowed: ['grain', 'oilseed'],
    });
  });
});

describe('normaliseEntityName', () => {
  it.each([
    ['Smith Farms Ltd.', 'smith farms'],
    ['SMITH FARMS LTD', 'smith farms'],
    ['Smith  Farms,  Ltd.', 'smith farms'],
    ['Smith Farms Co. Ltd.', 'smith farms'],
    ['Smith Farms Incorporated', 'smith farms'],
    ['Smith & Sons', 'smith and sons'],
    ['Smith and Sons', 'smith and sons'],
    ['  The Smith Farm  ', 'smith farm'],
    ['Fenwick Grain Co.', 'fenwick grain'],
  ])('normalises %s to %s', (raw, expected) => {
    expect(normaliseEntityName(raw)).toBe(expected);
  });

  // Stripping a suffix down to nothing would make every such name compare equal
  // to every other, which is the opposite of what a cross-check is for.
  it('never normalises a name away entirely', () => {
    expect(normaliseEntityName('Ltd.')).toBe('ltd');
  });
});

interface NameCtx {
  readonly onTitle: string | null;
  readonly onReturn: string | null;
}

const entityNameMatches = exactAgreement<NameCtx>({
  id: 'entity_name_matches',
  label: 'Legal entity name is the same on every document',
  normalise: normaliseEntityName,
  sources: [
    {
      name: 'The land title',
      read: (context) => readText(context.onTitle, 'land_title.owner_name', 'the owner name on the land title'),
    },
    {
      name: 'the 2024 tax return',
      read: (context) =>
        readText(context.onReturn, 'tax_return_2024.taxpayer_name', 'the name on the 2024 tax return'),
    },
  ],
});

describe('exactAgreement', () => {
  it('passes when the values agree once normalised', () => {
    const result = entityNameMatches.evaluate({
      onTitle: 'Smith Farms Ltd.',
      onReturn: 'SMITH FARMS',
    });
    expect(result.status).toBe('pass');
    expect(result.explain).toBe(
      'The land title and the 2024 tax return agree: Smith Farms Ltd.',
    );
    expect(RuleResultSchema.safeParse(result).success).toBe(true);
  });

  it('fails when they differ, quoting both sides', () => {
    const result = entityNameMatches.evaluate({
      onTitle: 'Smith Farms Ltd.',
      onReturn: 'Fenwick Grain Co.',
    });
    expect(result.status).toBe('fail');
    expect(result.explain).toBe(
      'The land title: "Smith Farms Ltd."; the 2024 tax return: "Fenwick Grain Co." ' +
        '-- these must match.',
    );
  });

  it('is unknown while a document is still missing, naming that document', () => {
    const result = entityNameMatches.evaluate({ onTitle: 'Smith Farms Ltd.', onReturn: null });
    expect(result.status).toBe('unknown');
    expect(result.missing).toEqual(['tax_return_2024.taxpayer_name']);
    expect(result.explain).toBe(
      'Cannot compare until we have the name on the 2024 tax return.',
    );
  });

  it('collects every missing side, not just the first', () => {
    const result = entityNameMatches.evaluate({ onTitle: null, onReturn: null });
    expect(result.missing).toEqual([
      'land_title.owner_name',
      'tax_return_2024.taxpayer_name',
    ]);
  });

  it('compares raw values when no normaliser is given', () => {
    const strict = exactAgreement<NameCtx>({
      id: 'entity_name_matches',
      label: 'Legal entity name is the same on every document',
      sources: [
        { name: 'The land title', read: (c) => readText(c.onTitle, 'a', 'a') },
        { name: 'the 2024 tax return', read: (c) => readText(c.onReturn, 'b', 'b') },
      ],
    });
    expect(strict.evaluate({ onTitle: 'Smith Farms Ltd.', onReturn: 'SMITH FARMS' }).status).toBe(
      'fail',
    );
  });
});

describe('readText', () => {
  it('reads a present value', () => {
    expect(readText('grain', 'primary_commodity', 'your main commodity')).toEqual({
      known: true,
      value: 'grain',
      inputs: {},
    });
  });

  // Postgres will store '' in a not-null text column, so emptiness is the
  // constraint that actually matters here, not nullability.
  it.each([null, '', '   '])('treats %j as not yet entered', (value) => {
    expect(readText(value, 'primary_commodity', 'your main commodity').known).toBe(false);
  });
});
