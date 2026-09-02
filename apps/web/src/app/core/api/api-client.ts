import { inject, Injectable } from '@angular/core';
import type { RuleResult } from '@lj/domain';

import { SupabaseAuthService } from '../auth/auth.service.ts';

/**
 * The typed fetch wrapper over `/api`.
 *
 * `apps/api` answers every non-2xx with one shape (the handoff on issue #13),
 * and this file is where that shape stops being JSON and becomes a value the
 * rest of the app can hold. One parser, so one renderer: `blockers` is
 * `RuleResult[]`, which `<lj-rule-list>` from `@lj/ui` already draws, and a
 * refused transition therefore reads exactly like an unmet eligibility
 * criterion -- because to the user they are the same thing.
 *
 * Reads do not come through here. They go straight to Supabase under row-level
 * security, through the query helpers in `@lj/db` (issue #7). The API exists for
 * the writes that need a decision made server-side, and routing reads through it
 * as well would add a hop and a second authorisation story.
 */

/** The 4xx/5xx envelope, from the transition endpoint's contract. */
export interface ApiFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly reason: string;
  /** Present and empty rather than absent: an optional property does not survive JSON. */
  readonly blockers: readonly RuleResult[];
  readonly current: { readonly state: string; readonly revision: number } | null;
}

/**
 * A failure is thrown rather than returned.
 *
 * That looks like the opposite of the choice made in `AggregateStore.write()`,
 * and it is the same choice seen from the other side: the transport raises, the
 * store catches once and converts it into the outcome every caller must handle.
 * Threading a result type through every helper would put the same `if` at every
 * layer instead of at the one that can act on it.
 */
export function isApiFailure(value: unknown): value is ApiFailure {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { ok?: unknown; status?: unknown; code?: unknown };
  return candidate.ok === false && typeof candidate.status === 'number' && typeof candidate.code === 'string';
}

interface FailureBody {
  readonly code?: unknown;
  readonly reason?: unknown;
  readonly blockers?: unknown;
  readonly current?: unknown;
}

function readCurrent(value: unknown): ApiFailure['current'] {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { state?: unknown; revision?: unknown };
  return typeof candidate.state === 'string' && typeof candidate.revision === 'number'
    ? { state: candidate.state, revision: candidate.revision }
    : null;
}

/**
 * Build the one failure shape from whatever actually came back.
 *
 * "Whatever actually came back" is the point. A gateway timeout, a proxy error
 * page, a body that is HTML -- none of those follow the contract, and a parser
 * that assumed they did would throw a `SyntaxError` from inside an error path
 * and lose the status code, which is the only useful thing left. The status is
 * always real; everything else is defaulted.
 */
export function toApiFailure(status: number, body: unknown): ApiFailure {
  const parsed: FailureBody = typeof body === 'object' && body !== null ? (body as FailureBody) : {};
  return {
    ok: false,
    status,
    code: typeof parsed.code === 'string' ? parsed.code : 'unexpected_response',
    reason:
      typeof parsed.reason === 'string' && parsed.reason.length > 0
        ? parsed.reason
        : 'The server answered ' + String(status) + ' without explaining why.',
    blockers: Array.isArray(parsed.blockers) ? (parsed.blockers as readonly RuleResult[]) : [],
    current: readCurrent(parsed.current),
  };
}

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly auth = inject(SupabaseAuthService);

  /**
   * POST a JSON body and parse the answer, or throw an `ApiFailure`.
   *
   * The access token is read at call time rather than held: the Supabase client
   * refreshes it, so a copy kept in a field is a token that expires without
   * telling anyone. It is put in the Authorization header and nowhere else --
   * never a query parameter, which would land it in access logs.
   */
  async post<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const token = this.auth.accessToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token !== null) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    let response: Response;
    try {
      response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (cause) {
      // A network failure has no status. 0 is the conventional stand-in and it
      // is deliberately not a 4xx or 5xx: nothing about the request was refused.
      throw toApiFailure(0, {
        code: 'network_unreachable',
        reason: cause instanceof Error ? cause.message : 'The server could not be reached.',
      });
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw toApiFailure(response.status, payload);
    }
    return payload as TResponse;
  }
}
