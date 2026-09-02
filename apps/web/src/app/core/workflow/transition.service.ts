import { inject, Injectable } from '@angular/core';
import type { AppRole, WorkflowMachine } from '@lj/domain';

import { ApiClient } from '../api/api-client.ts';

/**
 * The only place a state machine is moved.
 *
 * `plan/07-frontend.md` puts this in `core/` and says "the only place
 * transitions are fired", and the reason is not tidiness. A transition is the
 * one operation in this application with a concurrency story (`revision`), an
 * authorisation story (the actor's role, re-checked server-side) and a refusal
 * story (`blockers`). A second call site is a second place all three have to be
 * got right, and the one that gets them wrong will be the one written under
 * time pressure.
 *
 * A feature never calls `fetch('/api/transition')`. It injects this and calls
 * `fire()`, and it renders `blockers` with `<lj-rule-list>`.
 *
 * The client may also *predict* the answer with `can()` from `@lj/workflow` --
 * the same pure function the server runs -- to grey out a button before the
 * round trip. Prediction is a courtesy; this call is the decision. If the two
 * disagree, the server is right, because it is the one holding the state.
 */

export interface TransitionRequest {
  readonly machine: WorkflowMachine;
  readonly subjectId: string;
  readonly event: string;
  /**
   * The revision the caller believes the subject is at.
   *
   * Required, not optional. Omitting it would make the write unconditional,
   * which is precisely the two-lender-tabs bug the revision exists to catch
   * (plan/03-workflow-engine.md section 4).
   */
  readonly expectedRevision: number;
}

/** The 200 body, as published on issue #13. */
export interface TransitionAck {
  readonly ok: true;
  readonly machine: WorkflowMachine;
  readonly subjectId: string;
  readonly event: string;
  readonly from: string;
  readonly to: string;
  readonly revision: number;
  readonly actorRole: AppRole;
  readonly effects: readonly string[];
  readonly events: readonly string[];
}

export const TRANSITION_ENDPOINT = '/api/transition';

@Injectable({ providedIn: 'root' })
export class TransitionService {
  private readonly api = inject(ApiClient);

  /**
   * Fire a transition.
   *
   * Rejects with an `ApiFailure` on any non-2xx, which `AggregateStore.write()`
   * already turns into a `WriteOutcome` -- refetching on a 409 rather than
   * keeping what the client predicted.
   */
  fire(request: TransitionRequest): Promise<TransitionAck> {
    return this.api.post<TransitionAck>(TRANSITION_ENDPOINT, request);
  }
}
