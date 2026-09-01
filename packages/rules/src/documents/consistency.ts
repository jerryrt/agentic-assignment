import type { RuleResult } from '@lj/domain';

import { type Tolerance, numericAgreement } from '../engine/agreement.js';
import { exactAgreement } from '../engine/exact.js';
import {
  type Reading,
  awaiting,
  known,
  missingInput,
  readNumber,
  readText,
} from '../engine/reading.js';
import { type Rule, evaluate } from '../engine/rule.js';
import { type DocumentSlotView, isReadable } from './context.js';
import { normaliseEntityName } from './entity-name.js';

/**
 * "Inconsistent", defined in code (plan 04).
 *
 * Inconsistency is cross-document: a value extracted from one document against
 * the same value elsewhere -- another document, or what the borrower typed into
 * the application. Anything narrower is field validation wearing a different
 * name.
 *
 * `severity` is where the credit policy actually lives. An acreage that
 * disagrees with the title, or a different legal entity, blocks; net income
 * that disagrees between a tax return and a management-prepared statement is
 * common, explicable and advisory. Deciding which is which is the judgment the
 * brief asks for, so it is declared here and asserted in the tests rather than
 * left implicit.
 */

/** Slot codes as `supabase/seed.sql` writes them, named once. */
export const LAND_TITLE_SLOT = 'land_title';
export const TAX_RETURN_SLOT = 'tax_return_2024';
export const FINANCIAL_STATEMENTS_SLOT = 'financial_statements';

export interface ApplicationFacts {
  readonly totalAcres: number | null;
  readonly legalName: string | null;
}

export interface ConsistencyContext {
  readonly slots: readonly DocumentSlotView[];
  readonly application: ApplicationFacts;
}

function slotField(
  context: ConsistencyContext,
  code: string,
  field: string,
): unknown | undefined {
  const slot = context.slots.find((candidate) => candidate.code === code);
  if (slot === undefined) {
    return undefined;
  }
  const extracted = slot.extracted[field];
  // A value the extractor is not confident about is not a value. Comparing it
  // would raise a cross-check failure that is really an extraction failure, and
  // send the borrower to fix the wrong thing.
  return isReadable(extracted) ? extracted.value : undefined;
}

/** An extracted figure, or the reason it cannot be compared yet. */
export function extractedNumber(
  context: ConsistencyContext,
  code: string,
  field: string,
  label: string,
): Reading<number> {
  const value = slotField(context, code, field);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return awaiting([missingInput(code + '.' + field, label)]);
  }
  return known(value);
}

export function extractedText(
  context: ConsistencyContext,
  code: string,
  field: string,
  label: string,
): Reading<string> {
  const value = slotField(context, code, field);
  return readText(typeof value === 'string' ? value : null, code + '.' + field, label);
}

const TWO_PERCENT: Tolerance = { kind: 'percent', basisPoints: 200 };
const FIVE_PERCENT: Tolerance = { kind: 'percent', basisPoints: 500 };

export const consistencyRules: readonly Rule<ConsistencyContext>[] = [
  numericAgreement<ConsistencyContext>({
    id: 'acreage_matches_application',
    label: 'Acreage on the land title matches the application',
    figure: 'acres',
    severity: 'error',
    tolerance: TWO_PERCENT,
    left: {
      name: 'The land title',
      read: (context) =>
        extractedNumber(context, LAND_TITLE_SLOT, 'total_acres', 'the acreage on the land title'),
    },
    right: {
      name: 'your application',
      read: (context) =>
        readNumber(
          context.application.totalAcres,
          'farm.total_acres',
          'the acreage on your application',
        ),
    },
  }),
  numericAgreement<ConsistencyContext>({
    id: 'income_matches_financials',
    label: 'Net farm income agrees across the tax return and the financial statements',
    figure: 'money',
    severity: 'warning',
    tolerance: FIVE_PERCENT,
    left: {
      name: 'The 2024 tax return',
      read: (context) =>
        extractedNumber(
          context,
          TAX_RETURN_SLOT,
          'net_farm_income',
          'net farm income on the 2024 tax return',
        ),
    },
    right: {
      name: 'the financial statements',
      read: (context) =>
        extractedNumber(
          context,
          FINANCIAL_STATEMENTS_SLOT,
          'net_income',
          'net income on the financial statements',
        ),
    },
  }),
  exactAgreement<ConsistencyContext>({
    id: 'entity_name_matches',
    label: 'The legal entity is the same on every document',
    severity: 'error',
    normalise: normaliseEntityName,
    sources: [
      {
        name: 'The land title',
        read: (context) =>
          extractedText(context, LAND_TITLE_SLOT, 'owner_name', 'the owner name on the land title'),
      },
      {
        name: 'the 2024 tax return',
        read: (context) =>
          extractedText(
            context,
            TAX_RETURN_SLOT,
            'taxpayer_name',
            'the name on the 2024 tax return',
          ),
      },
      {
        name: 'your application',
        read: (context) =>
          readText(
            context.application.legalName,
            'borrower.legal_name',
            'the legal name on your application',
          ),
      },
    ],
  }),
];

export function evaluateConsistency(context: ConsistencyContext): RuleResult[] {
  return evaluate(context, consistencyRules);
}
