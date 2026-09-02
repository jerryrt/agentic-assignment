import { isApiFailure, toApiFailure } from './api-client.ts';

/**
 * The parser is the whole of the risk here. A failure that arrives malformed is
 * the case a hand-written `error.blockers.map(...)` throws on -- inside an error
 * handler, which then loses the status code, which was the only fact worth
 * keeping.
 */
describe('toApiFailure', () => {
  it('carries the contract through unchanged', () => {
    const failure = toApiFailure(422, {
      ok: false,
      code: 'guard_refused',
      reason: 'no product is eligible yet',
      blockers: [{ id: 'dscr_floor' }],
      current: { state: 'draft', revision: 4 },
    });

    expect(failure.status).toBe(422);
    expect(failure.code).toBe('guard_refused');
    expect(failure.reason).toBe('no product is eligible yet');
    expect(failure.blockers).toHaveLength(1);
    expect(failure.current).toEqual({ state: 'draft', revision: 4 });
  });

  // A proxy answering with an HTML error page is not a hypothetical: it is what
  // a cold start or a bad gateway looks like from the browser.
  it('produces the same shape from a body that follows no contract', () => {
    const failure = toApiFailure(502, null);

    expect(failure.ok).toBe(false);
    expect(failure.status).toBe(502);
    expect(failure.code).toBe('unexpected_response');
    expect(failure.reason).toContain('502');
    // Present and empty, so a renderer never has to test for absence.
    expect(failure.blockers).toEqual([]);
    expect(failure.current).toBeNull();
  });

  it('ignores a "current" that is not the pair the store needs', () => {
    const failure = toApiFailure(409, { code: 'revision_conflict', current: { state: 'draft' } });

    expect(failure.current).toBeNull();
  });

  it('is recognisable as a failure after it has crossed a boundary', () => {
    const failure = toApiFailure(409, { code: 'revision_conflict', reason: 'moved' });
    const roundTripped: unknown = JSON.parse(JSON.stringify(failure));

    expect(isApiFailure(roundTripped)).toBe(true);
  });

  it('does not mistake an ordinary object for a failure', () => {
    expect(isApiFailure({ ok: true, revision: 3 })).toBe(false);
    expect(isApiFailure(null)).toBe(false);
    expect(isApiFailure('conflict')).toBe(false);
  });
});
