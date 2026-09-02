/**
 * The trust boundary. Nothing in this API may read a request body except
 * through this file.
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
  DocumentUploadSchema,
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

/* -------------------------------------------------------------------------
 * The document routes
 * ---------------------------------------------------------------------- */

/**
 * A filename is a LABEL, and it is the only thing a caller contributes to an
 * upload.
 *
 * It never locates anything: the object key is minted by the server from the
 * slot it loaded (see lib/storage.ts), so a filename cannot choose a folder, an
 * extension or an existing object. What it does do is get stored and shown back
 * to two people, and -- for the stub extractor -- read for what it says about
 * the document.
 *
 * So it is validated as a leaf name and nothing more. A separator would make it
 * look like a path in a UI that displays it; a control character or a NUL would
 * make it something else again in a log; and 200 characters is more than any
 * real name and less than a body worth storing.
 */
const MAX_FILENAME_LENGTH = 200;

export function parseUploadFilename(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const filename = value.trim();
  if (filename === '' || filename.length > MAX_FILENAME_LENGTH) {
    return null;
  }
  if (filename === '.' || filename === '..') {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- rejecting them is the point
  if (/[/\\\u0000-\u001f\u007f]/.test(filename)) {
    return null;
  }
  return filename;
}

export interface UploadUrlRequest {
  readonly slotId: string;
  readonly filename: string;
  readonly mime: string;
  readonly bytes: number;
}

export type UploadUrlRequestParse =
  | { readonly ok: true; readonly request: UploadUrlRequest }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * What a browser must say to be given somewhere to put a file.
 *
 * `bytes` and `mime` describe the file the caller is about to send, and both
 * are checked against the policy by the route rather than here: a file that is
 * too large or of the wrong type is a refusal with its own status code, not a
 * malformed request. What this function decides is only whether the four fields
 * are the shape they claim to be.
 *
 * `bytes` takes its definition from the column that stores it, so the API and
 * the row cannot disagree about what a size is.
 */
const UploadBytesSchema = DocumentUploadSchema.shape.bytes;

export function parseUploadUrlRequest(body: unknown): UploadUrlRequestParse {
  if (!isRecord(body)) {
    return { ok: false, problems: ['the request body must be a JSON object'] };
  }

  const problems: string[] = [];

  const slot = UuidSchema.safeParse(body['slotId']);
  if (!slot.success) {
    problems.push('slotId must be a uuid');
  }

  const filename = parseUploadFilename(body['filename']);
  if (filename === null) {
    problems.push(
      'filename must be a leaf name: no separators, no control characters, at most ' +
        String(MAX_FILENAME_LENGTH) +
        ' characters',
    );
  }

  const mime = NonEmptyTextSchema.safeParse(body['mime']);
  if (!mime.success) {
    problems.push('mime must be a non-empty string');
  }

  const bytes = UploadBytesSchema.safeParse(body['bytes']);
  if (!bytes.success) {
    problems.push('bytes must be the positive integer size of the file');
  }

  if (!slot.success || filename === null || !mime.success || !bytes.success) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    request: {
      slotId: slot.data,
      filename,
      mime: mime.data,
      bytes: bytes.data,
    },
  };
}

export interface DownloadUrlRequest {
  readonly slotId: string;
  readonly uploadId: string;
}

export type DownloadUrlRequestParse =
  | { readonly ok: true; readonly request: DownloadUrlRequest }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Both ids, and no path.
 *
 * The caller names the record it wants to read and the server looks up where
 * that record's bytes are. Accepting a path instead would let a caller ask for
 * any object in the bucket and rely on this code to decide whether they may
 * have it -- which is the same mistake in the other direction.
 */
export function parseDownloadUrlRequest(body: unknown): DownloadUrlRequestParse {
  if (!isRecord(body)) {
    return { ok: false, problems: ['the request body must be a JSON object'] };
  }

  const problems: string[] = [];
  const slot = UuidSchema.safeParse(body['slotId']);
  if (!slot.success) {
    problems.push('slotId must be a uuid');
  }
  const upload = UuidSchema.safeParse(body['uploadId']);
  if (!upload.success) {
    problems.push('uploadId must be a uuid');
  }

  if (!slot.success || !upload.success) {
    return { ok: false, problems };
  }
  return { ok: true, request: { slotId: slot.data, uploadId: upload.data } };
}
