/**
 * The trust boundary. Nothing in this endpoint may read the request body
 * except through this file.
 *
 * CLAUDE.md section 10: every input is parsed with a schema from packages/domain
 * before anything else, and a client-supplied state, role or amount is never
 * trusted. The strongest form of "never trusted" is "never carried": the value
 * this function returns holds exactly four fields, so a `role` in the body is
 * not checked and rejected downstream -- it is simply not there to be read.
 *
 * The parse is hand-written narrowing over `unknown` that delegates each field
 * to the schema in packages/domain that owns it, rather than one `z.object`.
 * The reason is the one packages/rules gives for the same choice in
 * `eligibility/criteria.ts`: zod is a dependency of @lj/domain alone, pnpm's
 * isolated node_modules does not hoist it, and adding it to this manifest would
 * put a lockfile entry behind a grammar of four fields. The fields themselves
 * are still validated by @lj/domain's schemas, which is the part that matters.
 *
 * Every problem is reported, not only the first. A caller fixing one field at a
 * time against a 400 is the same wall the RuleResult vocabulary exists to avoid.
 */

import {
  ApplicationSchema,
  NonEmptyTextSchema,
  UuidSchema,
  WorkflowMachineSchema,
  type WorkflowMachine,
} from '@lj/domain';
import type { MachineShape } from '@lj/workflow';

import { eventNamesOf, machineShapeFor } from './machines.ts';

/**
 * The optimistic-concurrency counter, taken from the column that defines it
 * rather than restated here. Every machine's subject carries the same counter
 * with the same meaning, and `application` is the one with a table today, so
 * its schema is the single definition available (CLAUDE.md section 9).
 */
const RevisionSchema = ApplicationSchema.shape.revision;

export interface TransitionRequest {
  readonly machine: WorkflowMachine;
  readonly subjectId: string;
  readonly event: string;
  readonly expectedRevision: number;
}

export type TransitionRequestParse =
  | {
      readonly ok: true;
      readonly request: TransitionRequest;
      /** Resolved here so the handler never has to look the machine up again. */
      readonly machine: MachineShape;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTransitionRequest(body: unknown): TransitionRequestParse {
  if (!isRecord(body)) {
    return { ok: false, problems: ['the request body must be a JSON object'] };
  }

  const problems: string[] = [];

  const machineParse = WorkflowMachineSchema.safeParse(body['machine']);
  const machine = machineParse.success ? machineShapeFor(machineParse.data) : null;
  if (!machineParse.success) {
    problems.push(
      "machine must be one of the machines packages/workflow defines; received '" +
        String(body['machine']) +
        "'",
    );
  } else if (machine === null) {
    // The domain declares the id and no definition claims it. That is a drift
    // between packages/domain and packages/workflow, not a client mistake, but
    // it fails closed here rather than reaching an engine that cannot help.
    problems.push(
      "machine '" + machineParse.data + "' is declared but no definition provides it",
    );
  }

  const subjectParse = UuidSchema.safeParse(body['subjectId']);
  if (!subjectParse.success) {
    problems.push('subjectId must be a uuid');
  }

  const eventParse = NonEmptyTextSchema.safeParse(body['event']);
  if (!eventParse.success) {
    problems.push('event must be a non-empty string');
  } else if (machine !== null) {
    const declared = eventNamesOf(machine);
    if (!declared.includes(eventParse.data)) {
      // Named against the machine on purpose. 'disburse' is a real event -- of
      // credit_release -- and a message that only said "unknown event" would
      // send the caller looking for a typo that is not there.
      problems.push(
        "event '" +
          eventParse.data +
          "' is not declared by machine '" +
          machine.id +
          "'; it declares " +
          declared.join(', '),
      );
    }
  }

  const revisionParse = RevisionSchema.safeParse(body['expectedRevision']);
  if (!revisionParse.success) {
    problems.push(
      'expectedRevision must be the non-negative integer revision the caller last read',
    );
  }

  if (
    problems.length > 0 ||
    machine === null ||
    !machineParse.success ||
    !subjectParse.success ||
    !eventParse.success ||
    !revisionParse.success
  ) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    machine,
    request: {
      machine: machineParse.data,
      subjectId: subjectParse.data,
      event: eventParse.data,
      expectedRevision: revisionParse.data,
    },
  };
}
