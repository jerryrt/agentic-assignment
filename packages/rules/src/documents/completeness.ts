import { type RuleResult, ratioBasisPoints, ruleFailed, rulePassed, ruleUnknown, moneyFromMinorUnits } from '@lj/domain';

import { joinWords } from '../engine/figures.js';
import { type Rule, type RuleDecision, decide, evaluate } from '../engine/rule.js';
import {
  type DocumentContext,
  type DocumentSlotView,
  assertIsoDate,
  humaniseFieldName,
  isExpired,
  isReadable,
} from './context.js';

/**
 * "Complete", defined in code rather than in prose (plan 04).
 *
 * A required slot is complete when it is accepted, is not derived-expired, and
 * every field it declares as required was read. Three separate ways to be
 * incomplete, kept separate on purpose: the borrower's next action differs in
 * each case -- upload something, upload a newer one, upload a clearer scan --
 * and collapsing them into one red dot is the lazy version.
 *
 * The status split is just as deliberate. A slot nobody has uploaded is
 * `unknown`, not `fail`: nothing has gone wrong, the file is simply not there
 * yet, and a checklist that opens entirely in red teaches the borrower to
 * ignore it. A slot that was uploaded and rejected, or that expired, or that
 * could not be read, is a genuine failure with a named next action.
 */

export const DOCUMENT_SLOT_RULE_PREFIX = 'document_slot.';

export function documentSlotRuleId(code: string): string {
  return DOCUMENT_SLOT_RULE_PREFIX + code;
}

function unreadableFields(slot: DocumentSlotView): string[] {
  return slot.extractRequired.filter((field) => !isReadable(slot.extracted[field]));
}

export function documentSlotRule(slot: DocumentSlotView): Rule<DocumentContext> {
  const id = documentSlotRuleId(slot.code);
  // An optional slot still renders and still explains itself; it just does not
  // hold the pack up. Which documents are optional is the lender's policy, and
  // it arrives as data on the slot.
  const severity = slot.required ? 'error' : 'warning';

  return {
    id,
    label: slot.label,
    severity,
    evaluate: (context) => {
      // Validated even when this slot has no expiry: a malformed clock would
      // otherwise pass unnoticed until the first slot that does have one.
      const today = assertIsoDate(context.today, 'today');
      const inputs: Record<string, unknown> = { state: slot.state, valid_until: slot.validUntil };

      if (slot.state === 'required') {
        return ruleUnknown({
          id,
          label: slot.label,
          severity,
          explain: 'Not uploaded yet -- upload the ' + slot.label.toLowerCase() + '.',
          inputs,
          missing: [slot.code],
        });
      }

      if (slot.state === 'uploaded' || slot.state === 'extracted') {
        return ruleUnknown({
          id,
          label: slot.label,
          severity,
          explain: 'Uploaded -- waiting for your lender to accept it.',
          inputs,
          // The outstanding input is a decision, and it is not the borrower's
          // to make. Naming it keeps the lender queue and the borrower
          // checklist reading off one list.
          missing: [slot.code + '.accepted'],
        });
      }

      if (slot.state === 'rejected') {
        return ruleFailed({
          id,
          label: slot.label,
          severity,
          explain: 'Rejected by your lender -- upload a replacement.',
          inputs,
        });
      }

      if (isExpired(slot.validUntil, today)) {
        return ruleFailed({
          id,
          label: slot.label,
          severity,
          explain: 'Expired ' + String(slot.validUntil) + ' -- upload a current one.',
          inputs,
        });
      }

      const unreadable = unreadableFields(slot);
      if (unreadable.length > 0) {
        return ruleFailed({
          id,
          label: slot.label,
          severity,
          explain:
            'Could not read ' +
            joinWords(unreadable.map(humaniseFieldName)) +
            ' -- upload a clearer scan, or type the value in.',
          inputs: { ...inputs, unreadable },
        });
      }

      return rulePassed({
        id,
        label: slot.label,
        severity,
        explain:
          slot.validUntil === null ? 'Accepted.' : 'Accepted -- valid until ' + slot.validUntil + '.',
        inputs,
      });
    },
  };
}

export function completenessRules(context: DocumentContext): Rule<DocumentContext>[] {
  return context.slots.map(documentSlotRule);
}

export function evaluateCompleteness(context: DocumentContext): RuleResult[] {
  return evaluate(context, completenessRules(context));
}

/** The guard on `application: docs_pending -> under_review` (plan 03). */
export function documentPackComplete(context: DocumentContext): RuleDecision {
  return decide(evaluateCompleteness(context));
}

export interface DocumentPackProgress {
  readonly accepted: number;
  readonly total: number;
  readonly basisPoints: number;
}

/**
 * The bar on the documents screen.
 *
 * It counts finished slots, never uploaded ones, and it is computed from the
 * same results the checklist renders -- so the bar cannot disagree with the
 * rows beneath it. A document that is uploaded and then rejected must not move
 * the bar forward and then back; that is the dishonest version plan 04 names.
 */
export function documentPackProgress(results: readonly RuleResult[]): DocumentPackProgress {
  const blocking = results.filter((result) => result.severity === 'error');
  const accepted = blocking.filter((result) => result.status === 'pass').length;
  const total = blocking.length;
  if (total === 0) {
    return { accepted, total, basisPoints: 10_000 };
  }
  const ratio = ratioBasisPoints(moneyFromMinorUnits(accepted), moneyFromMinorUnits(total));
  return { accepted, total, basisPoints: ratio ?? 10_000 };
}
