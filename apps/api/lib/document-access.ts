/**
 * Everything the two document routes have to establish before they may say
 * anything about a slot: who is asking, which slot, whose application it is on,
 * and whether that caller is in its audience.
 *
 * Written once because it is one question asked twice, and getting it wrong in
 * either route is the same failure -- one person's loan documents handed to
 * another. `POST /api/transition` asks the same question in its own flow, where
 * authentication happens before the machine is chosen and the service client is
 * shared with the application path; the answer there comes from the same two
 * functions this calls, `applicationReadableBy` and `loadDocumentSlot`, rather
 * than from a third statement of the rule.
 */

import type { DatabaseClient } from '@lj/db';
import { createServiceRoleClient } from '@lj/db/service-role';

import { authenticateActor, bearerToken, type Actor } from './actor.ts';
import {
  applicationReadableBy,
  loadApplication,
  type ApplicationSubject,
} from './application-subject.ts';
import { loadDocumentSlot, type DocumentSlotSubject } from './document-slot-subject.ts';
import { readApiEnvironment } from './environment.ts';
import { failure } from './http.ts';

export interface SlotAccess {
  readonly actor: Actor;
  /** Bypasses row-level security. Every check the policies would have made is
   * made above before this is handed over. */
  readonly service: DatabaseClient;
  readonly slot: DocumentSlotSubject;
  readonly application: ApplicationSubject;
}

export type SlotAccessResult =
  | { readonly ok: true; readonly access: SlotAccess }
  | { readonly ok: false; readonly response: Response };

/**
 * Authenticate, load, and re-make the read policy's decision.
 *
 * A caller outside the audience is answered exactly as one asking about a slot
 * that does not exist. Distinguishing the two hands out the existence of other
 * people's loan files, which is what `document_slot_read_visible_application`
 * refuses to do and what this has to go on refusing with the policies switched
 * off.
 */
export async function authoriseSlotRequest(
  request: Request,
  slotId: string,
): Promise<SlotAccessResult> {
  const token = bearerToken(request.headers);
  if (token === null) {
    return {
      ok: false,
      response: failure(401, 'unauthenticated', 'a bearer access token is required'),
    };
  }

  const environment = readApiEnvironment(process.env);
  const authenticated = await authenticateActor(environment, token);
  if (!authenticated.ok) {
    return {
      ok: false,
      response: failure(authenticated.status, authenticated.code, authenticated.reason),
    };
  }

  const service = createServiceRoleClient(environment.serviceRole);
  const slot = await loadDocumentSlot(service, slotId);
  if (slot === null) {
    return {
      ok: false,
      response: failure(404, 'subject_not_found', 'no such document slot'),
    };
  }

  const application = await loadApplication(service, slot.applicationId);
  if (application === null || !applicationReadableBy(application, authenticated.actor)) {
    return {
      ok: false,
      response: failure(404, 'subject_not_found', 'no such document slot'),
    };
  }

  return {
    ok: true,
    access: { actor: authenticated.actor, service, slot, application },
  };
}
