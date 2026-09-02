import { describe, expect, it } from 'vitest';

import { parseTransitionRequest } from '../lib/request.ts';

/**
 * The trust boundary, probed on its own.
 *
 * These cases need no database, no environment and no network, which is the
 * property under test as much as the parse itself: a request this file rejects
 * is a request that never reached Postgres. `test/transition.spec.ts` asserts
 * the same thing end to end, with the environment deliberately unset, so that
 * the two halves of the claim cannot drift apart.
 */

const SUBJECT = '00000000-0000-4000-8000-0000000000d1';

function wellFormed(): Record<string, unknown> {
  return {
    machine: 'application',
    subjectId: SUBJECT,
    event: 'submit',
    expectedRevision: 7,
  };
}

function problems(body: unknown): readonly string[] {
  const parsed = parseTransitionRequest(body);
  if (parsed.ok) {
    throw new Error('expected a refusal, but the body parsed');
  }
  return parsed.problems;
}

describe('parseTransitionRequest', () => {
  it('accepts a well-formed body', () => {
    const parsed = parseTransitionRequest(wellFormed());

    expect(parsed).toMatchObject({
      ok: true,
      request: {
        machine: 'application',
        subjectId: SUBJECT,
        event: 'submit',
        expectedRevision: 7,
      },
    });
  });

  it('resolves the machine definition, so the handler never looks it up twice', () => {
    const parsed = parseTransitionRequest(wellFormed());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.machine.id).toBe('application');
  });

  it('accepts revision zero, which is where every subject starts', () => {
    const parsed = parseTransitionRequest({ ...wellFormed(), expectedRevision: 0 });

    expect(parsed.ok).toBe(true);
  });

  /**
   * The security property this whole file exists for. A client-supplied role is
   * the first thing an attacker forges, and the parse must not carry one
   * forward under any name -- not to be checked and rejected later, but to be
   * absent from the value the handler goes on to use.
   */
  it('carries no identity or authority the caller supplied', () => {
    const parsed = parseTransitionRequest({
      ...wellFormed(),
      role: 'lender',
      actorId: '00000000-0000-4000-8000-0000000000c1',
      actorRole: 'admin',
      to: 'funded',
      state: 'funded',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(Object.keys(parsed.request).sort()).toEqual([
      'event',
      'expectedRevision',
      'machine',
      'subjectId',
    ]);
  });

  it('rejects a body that is not an object', () => {
    expect(problems(null).join(' ')).toContain('object');
    expect(problems('submit').join(' ')).toContain('object');
    expect(problems([wellFormed()]).join(' ')).toContain('object');
  });

  it('rejects a machine no definition declares', () => {
    expect(problems({ ...wellFormed(), machine: 'loan' }).join(' ')).toContain('machine');
  });

  it('rejects an event the named machine does not declare', () => {
    // 'disburse' is a real event -- of credit_release, not of application. A
    // parse that only checked the event was a known string would let it
    // through to an engine that would then refuse it for the wrong reason.
    const reported = problems({ ...wellFormed(), event: 'disburse' }).join(' ');

    expect(reported).toContain('disburse');
    expect(reported).toContain('application');
  });

  it('rejects a subject id that is not a uuid', () => {
    expect(problems({ ...wellFormed(), subjectId: 'not-a-uuid' }).join(' ')).toContain(
      'subjectId',
    );
  });

  it('rejects a revision that is absent, fractional, negative or textual', () => {
    for (const expectedRevision of [undefined, 1.5, -1, '7', null]) {
      expect(problems({ ...wellFormed(), expectedRevision }).join(' ')).toContain(
        'expectedRevision',
      );
    }
  });

  it('reports every problem at once rather than only the first', () => {
    const reported = problems({
      machine: 'loan',
      subjectId: 'not-a-uuid',
      event: '',
      expectedRevision: -3,
    });

    expect(reported.length).toBeGreaterThanOrEqual(3);
  });
});
