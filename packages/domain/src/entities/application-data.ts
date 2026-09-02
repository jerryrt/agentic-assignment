import { z } from 'zod';

import {
  type BasisPoints,
  currentRatioBasisPoints,
  debtServiceCoverageRatioBasisPoints,
  loanToValueBasisPoints,
} from '../finance.ts';
import { MoneyMinorUnitsSchema, type Money, subtractMoney } from '../money.ts';

/**
 * `application.data`: the multi-step form payload, and the figures derived from
 * it.
 *
 * The column is `jsonb` and its shape was left PROVISIONAL through phases 1 to
 * 4 -- `supabase/migrations/0004_demo_data.sql`, `apps/api/lib/application-data.ts`
 * and the empty `completeness` bucket in `apps/api/lib/application-subject.ts`
 * all say so and defer here. This file is that deferral being paid.
 *
 * Four decisions in it are load-bearing.
 *
 * **Every leaf is nullable and every section is filled in.** A draft is partial
 * by definition: the demo data seeds one stopped part way through step three,
 * and the form autosaves from the first keystroke. A schema that refused a half
 * filled form could not parse a single real draft. Sections, by contrast, are
 * always present after a parse, so no consumer writes `data.borrower?.x` -- one
 * `?.` here would become one in every template and every rule.
 *
 * **Blank text is not an answer.** '' is what an emptied input produces and it
 * means exactly what never having typed means. Normalising it to null here is
 * what lets every completeness check ask one question instead of two.
 *
 * **Total acreage is derived from the parcels, not stored.** The seeded payload
 * carries a `farm.total_acres` that happens to agree with its parcels today;
 * keeping both would be two answers to one question the first time a parcel was
 * edited (CLAUDE.md section 9). Zod strips the stale key on the way through, so
 * the applied migration stays untouched and the derivation is the only source.
 *
 * **No threshold appears here.** This package says what a field is, never what
 * it must be. A threshold is a policy and belongs to the rule that applies it;
 * `loan_product.criteria` holds those, parsed by packages/rules.
 *
 * What is deliberately NOT validated here is FORMAT: an email that is not an
 * email, a postal code in the wrong shape. A draft holds what was typed, and
 * refusing to parse it would lose the applicant's work rather than tell them
 * about it. Format is the form's job, at the control, where it can be shown
 * beside the field it is about.
 */

/* -------------------------------------------------------------------------
 * The step vocabulary
 * ---------------------------------------------------------------------- */

/**
 * The four steps of plan 05, in the order they are walked.
 *
 * These strings are already in the database -- `application.furthest_step`
 * holds 'financials' and 'request' on the seeded rows -- and they are the
 * `:step` segment of `/apply/:id/:step`. Renaming one strands every draft.
 */
export const APPLICATION_STEPS = ['borrower', 'farm', 'financials', 'request'] as const;

export const ApplicationStepSchema = z.enum(APPLICATION_STEPS);
export type ApplicationStep = z.infer<typeof ApplicationStepSchema>;

export function isApplicationStep(value: string): value is ApplicationStep {
  return (APPLICATION_STEPS as readonly string[]).includes(value);
}

/** Position in the walk, so a deep link can be compared against `furthest_step`. */
export function applicationStepIndex(step: ApplicationStep): number {
  return APPLICATION_STEPS.indexOf(step);
}

/* -------------------------------------------------------------------------
 * Closed vocabularies
 * ---------------------------------------------------------------------- */

/** Drives the conditional fields on step one: a corporation is asked more. */
export const ENTITY_TYPES = ['sole_trader', 'partnership', 'corporation'] as const;
export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityTypeSchema>;

/** Canada Post's provincial and territorial codes, which is what a criterion compares. */
export const PROVINCES = [
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
] as const;
export const ProvinceSchema = z.enum(PROVINCES);
export type Province = z.infer<typeof ProvinceSchema>;

export const COMMODITIES = [
  'grain', 'oilseed', 'pulse', 'forage', 'livestock', 'dairy', 'horticulture', 'mixed',
] as const;
export const CommoditySchema = z.enum(COMMODITIES);
export type Commodity = z.infer<typeof CommoditySchema>;

export const LAND_TENURES = ['owned', 'leased', 'share_cropped'] as const;
export const LandTenureSchema = z.enum(LAND_TENURES);
export type LandTenure = z.infer<typeof LandTenureSchema>;

export const IRRIGATION_LEVELS = ['none', 'partial', 'full'] as const;
export const IrrigationLevelSchema = z.enum(IRRIGATION_LEVELS);
export type IrrigationLevel = z.infer<typeof IrrigationLevelSchema>;

/** Which basis the statements on step three were prepared on. */
export const STATEMENT_BASES = ['accrual', 'cash'] as const;
export const StatementBasisSchema = z.enum(STATEMENT_BASES);
export type StatementBasis = z.infer<typeof StatementBasisSchema>;

/* -------------------------------------------------------------------------
 * Leaf schemas
 * ---------------------------------------------------------------------- */

/**
 * Text as a draft holds it: trimmed, with blank and whitespace-only read as
 * unanswered. Trailing whitespace out of a paste is not a difference anyone
 * meant, and it would make two otherwise identical drafts compare unequal.
 */
const AnsweredText = z
  .string()
  .nullable()
  .default(null)
  .transform((value) => {
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });

const AnsweredInteger = z.number().int().nullable().default(null);

/** Integer minor units, per the money rule. The `_minor` suffix is on the field name. */
const AnsweredMoney = MoneyMinorUnitsSchema.nullable().default(null);

const AnsweredFlag = z.boolean().nullable().default(null);

/**
 * A closed vocabulary as a draft holds it. Generic over the enum rather than
 * over its members so the literal union survives: widening it to `string` here
 * would take the exhaustiveness out of every `switch` downstream.
 */
function answeredChoice<TEnum extends z.ZodEnum<Record<string, string>>>(schema: TEnum) {
  return schema.nullable().default(null);
}

/* -------------------------------------------------------------------------
 * The sections
 * ---------------------------------------------------------------------- */

/**
 * One parcel of land. Kept as its own row rather than folded into a total
 * because tenure and commodity differ per parcel, and because a repeating
 * group is the state-management problem step two exists to pose.
 *
 * A partly filled parcel is kept, not discarded: it is a row the applicant is
 * part way through typing, and dropping it would delete their work under them.
 */
export const ApplicationParcelSchema = z.object({
  legal_description: AnsweredText,
  acres: AnsweredInteger,
  tenure: answeredChoice(LandTenureSchema),
  commodity: answeredChoice(CommoditySchema),
});
export type ApplicationParcel = z.infer<typeof ApplicationParcelSchema>;

export const ApplicationBorrowerSectionSchema = z.object({
  entity_type: answeredChoice(EntityTypeSchema),
  legal_name: AnsweredText,
  trade_name: AnsweredText,
  incorporation_year: AnsweredInteger,
  years_farming: AnsweredInteger,
  province: answeredChoice(ProvinceSchema),
  postal_code: AnsweredText,
  contact_email: AnsweredText,
  contact_phone: AnsweredText,
});
export type ApplicationBorrowerSection = z.infer<typeof ApplicationBorrowerSectionSchema>;

export const ApplicationFarmSectionSchema = z.object({
  primary_commodity: answeredChoice(CommoditySchema),
  secondary_commodity: answeredChoice(CommoditySchema),
  irrigation: answeredChoice(IrrigationLevelSchema),
  has_crop_insurance: AnsweredFlag,
  storage_capacity_tonnes: AnsweredInteger,
  parcels: z.array(ApplicationParcelSchema).default([]),
});
export type ApplicationFarmSection = z.infer<typeof ApplicationFarmSectionSchema>;

export const ApplicationFinancialsSectionSchema = z.object({
  fiscal_year_end: AnsweredText,
  statements_basis: answeredChoice(StatementBasisSchema),
  gross_revenue_minor: AnsweredMoney,
  operating_expenses_minor: AnsweredMoney,
  existing_debt_service_minor: AnsweredMoney,
  current_assets_minor: AnsweredMoney,
  current_liabilities_minor: AnsweredMoney,
  inventory_value_minor: AnsweredMoney,
  land_value_minor: AnsweredMoney,
  off_farm_income_minor: AnsweredMoney,
});
export type ApplicationFinancialsSection = z.infer<typeof ApplicationFinancialsSectionSchema>;

export const ApplicationRequestSectionSchema = z.object({
  product_id: AnsweredText,
  amount_requested_minor: AnsweredMoney,
  term_months: AnsweredInteger,
  purpose: AnsweredText,
  collateral_value_minor: AnsweredMoney,
  preferred_start_date: AnsweredText,
});
export type ApplicationRequestSection = z.infer<typeof ApplicationRequestSectionSchema>;

/**
 * The payload as a whole.
 *
 * Sections are optional on the way in and present on the way out, which is the
 * one asymmetry worth stating: a draft written after step one has no
 * `financials` key at all, and every reader downstream would otherwise have to
 * decide for itself what an absent section means.
 */
export const ApplicationDataSchema = z
  .object({
    borrower: ApplicationBorrowerSectionSchema.optional(),
    farm: ApplicationFarmSectionSchema.optional(),
    financials: ApplicationFinancialsSectionSchema.optional(),
    request: ApplicationRequestSectionSchema.optional(),
  })
  .transform((value) => ({
    borrower: value.borrower ?? ApplicationBorrowerSectionSchema.parse({}),
    farm: value.farm ?? ApplicationFarmSectionSchema.parse({}),
    financials: value.financials ?? ApplicationFinancialsSectionSchema.parse({}),
    request: value.request ?? ApplicationRequestSectionSchema.parse({}),
  }));

export type ApplicationData = z.infer<typeof ApplicationDataSchema>;

/** Nothing answered: what a fresh application starts from. Do not mutate. */
export const EMPTY_APPLICATION_DATA: ApplicationData = ApplicationDataSchema.parse({});

export type ApplicationDataParse =
  | { readonly ok: true; readonly data: ApplicationData }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Parse without throwing.
 *
 * A row that does not match takes a screen down if the parse throws inside a
 * template, and the applicant is shown a blank page rather than a message. The
 * caller decides what to do about it; this reports.
 */
export function parseApplicationData(value: unknown): ApplicationDataParse {
  const outcome = ApplicationDataSchema.safeParse(value);
  if (outcome.success) {
    return { ok: true, data: outcome.data };
  }
  return {
    ok: false,
    problems: outcome.error.issues.map(
      (issue) => (issue.path.length === 0 ? 'payload' : issue.path.join('.')) + ': ' + issue.message,
    ),
  };
}

/* -------------------------------------------------------------------------
 * Derived figures
 * ---------------------------------------------------------------------- */

/**
 * Everything computed from the payload rather than entered into it.
 *
 * Step three shows three of these as read-only fields and the eligibility
 * criteria compare two of them against thresholds. Deriving them once, here,
 * is what guarantees the figure the applicant reads and the figure the guard
 * compares are the same number (CLAUDE.md section 9).
 *
 * Every one is nullable, and null means "not enough has been entered" rather
 * than zero. `ratioBasisPoints` already draws that line for a zero denominator
 * and this carries it up.
 */
export interface ApplicationFigures {
  /** Summed from the parcels. Acres, not basis points. */
  readonly totalAcres: number | null;
  readonly netOperatingIncome: Money | null;
  readonly debtServiceCoverage: BasisPoints | null;
  readonly currentRatio: BasisPoints | null;
  readonly loanToValue: BasisPoints | null;
}

/**
 * The acreage the criteria read.
 *
 * Null while any parcel is missing its acres, rather than a sum of the ones
 * that have them: a partial total reported as the total is a wrong number that
 * gets believed, and the applicant is mid-way through typing a row. Null is
 * the honest answer and renders as "we need more information".
 */
function totalAcres(parcels: readonly ApplicationParcel[]): number | null {
  if (parcels.length === 0) {
    return null;
  }
  let total = 0;
  for (const parcel of parcels) {
    if (parcel.acres === null) {
      return null;
    }
    total += parcel.acres;
  }
  return total;
}

/**
 * Revenue less operating expenses, before debt service.
 *
 * Derived because the form asks for the two figures a farmer has on a
 * statement and not for their difference. It is an accounting identity, not a
 * policy -- no threshold, no judgement -- and it is computed with the money
 * arithmetic in money.ts so no float touches it. Null unless both sides are
 * present: a missing expense figure is not a zero expense.
 */
function netOperatingIncome(financials: ApplicationFinancialsSection): Money | null {
  const revenue = financials.gross_revenue_minor;
  const expenses = financials.operating_expenses_minor;
  return revenue === null || expenses === null ? null : subtractMoney(revenue, expenses);
}

function ratio(
  numerator: Money | null,
  denominator: Money | null,
  compute: (top: Money, bottom: Money) => BasisPoints | null,
): BasisPoints | null {
  return numerator === null || denominator === null ? null : compute(numerator, denominator);
}

export function deriveApplicationFigures(data: ApplicationData): ApplicationFigures {
  const income = netOperatingIncome(data.financials);
  return {
    totalAcres: totalAcres(data.farm.parcels),
    netOperatingIncome: income,
    debtServiceCoverage: ratio(
      income,
      data.financials.existing_debt_service_minor,
      debtServiceCoverageRatioBasisPoints,
    ),
    currentRatio: ratio(
      data.financials.current_assets_minor,
      data.financials.current_liabilities_minor,
      currentRatioBasisPoints,
    ),
    loanToValue: ratio(
      data.request.amount_requested_minor,
      data.request.collateral_value_minor,
      loanToValueBasisPoints,
    ),
  };
}

/* -------------------------------------------------------------------------
 * What each step has to answer
 * ---------------------------------------------------------------------- */

/**
 * One field a step needs before it counts as answered.
 *
 * Stated once here and read three times: packages/rules turns these into the
 * completeness RuleResults the `submit` guard reads, the form attaches its
 * required validators from them, and the resume guard uses them to decide
 * which step a deep link may land on. A required-ness restated in an Angular
 * validator would be the second copy CLAUDE.md section 9 exists to prevent.
 *
 * `appliesTo` is what makes the conditional fields on step one honest: a sole
 * trader has no incorporation year, so asking for one and then withdrawing the
 * question is worse than never asking. It answers false while the entity type
 * itself is unanswered, because nobody can say yet which fields apply.
 *
 * `path` addresses the control -- 'borrower.incorporation_year' -- so a form
 * can focus it and a RuleResult's `missing` array can carry it. `isAnswered`
 * is a closure rather than a lookup by that path so that the check is typed
 * against the section it reads, and a renamed field fails `tsc` rather than
 * silently never being required again.
 */
export interface ApplicationRequirement {
  readonly path: string;
  readonly label: string;
  readonly step: ApplicationStep;
  readonly appliesTo: (data: ApplicationData) => boolean;
  readonly isAnswered: (data: ApplicationData) => boolean;
}

const ALWAYS = (): boolean => true;

function forEntityTypes(...types: readonly EntityType[]): (data: ApplicationData) => boolean {
  return (data) => {
    const entityType = data.borrower.entity_type;
    return entityType !== null && types.includes(entityType);
  };
}

function borrowerField(
  key: keyof ApplicationBorrowerSection,
  label: string,
  appliesTo: (data: ApplicationData) => boolean = ALWAYS,
): ApplicationRequirement {
  return {
    path: 'borrower.' + key,
    label,
    step: 'borrower',
    appliesTo,
    isAnswered: (data) => data.borrower[key] !== null,
  };
}

function farmField(
  key: keyof Omit<ApplicationFarmSection, 'parcels'>,
  label: string,
): ApplicationRequirement {
  return {
    path: 'farm.' + key,
    label,
    step: 'farm',
    appliesTo: ALWAYS,
    isAnswered: (data) => data.farm[key] !== null,
  };
}

function financialsField(
  key: keyof ApplicationFinancialsSection,
  label: string,
): ApplicationRequirement {
  return {
    path: 'financials.' + key,
    label,
    step: 'financials',
    appliesTo: ALWAYS,
    isAnswered: (data) => data.financials[key] !== null,
  };
}

function requestField(
  key: keyof ApplicationRequestSection,
  label: string,
): ApplicationRequirement {
  return {
    path: 'request.' + key,
    label,
    step: 'request',
    appliesTo: ALWAYS,
    isAnswered: (data) => data.request[key] !== null,
  };
}

/**
 * The parcels list, as one requirement over the whole array.
 *
 * One requirement rather than four per row, because the number of rows is not
 * known until the applicant decides it: a per-row requirement list would have
 * to be rebuilt on every add and remove, and the path it produced would name a
 * row index that moves when a row above it is deleted. What the applicant has
 * to be told is one sentence -- describe at least one parcel, completely --
 * and step two's own field errors say which cell is short.
 */
const PARCELS_REQUIREMENT: ApplicationRequirement = {
  path: 'farm.parcels',
  label: 'At least one parcel, fully described',
  step: 'farm',
  appliesTo: ALWAYS,
  isAnswered: (data) =>
    data.farm.parcels.length > 0 &&
    data.farm.parcels.every(
      (parcel) =>
        parcel.legal_description !== null &&
        parcel.acres !== null &&
        parcel.tenure !== null &&
        parcel.commodity !== null,
    ),
};

export const APPLICATION_STEP_REQUIREMENTS: {
  readonly [K in ApplicationStep]: readonly ApplicationRequirement[];
} = {
  borrower: [
    borrowerField('entity_type', 'How the business is held'),
    borrowerField('legal_name', 'Legal name'),
    borrowerField('trade_name', 'Operating name', forEntityTypes('corporation')),
    borrowerField('incorporation_year', 'Year of incorporation', forEntityTypes('corporation')),
    borrowerField('years_farming', 'Years farming'),
    borrowerField('province', 'Province'),
    borrowerField('postal_code', 'Postal code'),
    borrowerField('contact_email', 'Contact email'),
    borrowerField('contact_phone', 'Contact phone'),
  ],
  farm: [
    farmField('primary_commodity', 'Main commodity'),
    farmField('irrigation', 'Irrigation'),
    farmField('has_crop_insurance', 'Crop insurance'),
    PARCELS_REQUIREMENT,
  ],
  financials: [
    financialsField('statements_basis', 'Statement basis'),
    financialsField('gross_revenue_minor', 'Gross revenue'),
    financialsField('operating_expenses_minor', 'Operating expenses'),
    financialsField('existing_debt_service_minor', 'Existing debt service'),
    financialsField('current_assets_minor', 'Current assets'),
    financialsField('current_liabilities_minor', 'Current liabilities'),
  ],
  request: [
    requestField('product_id', 'Product'),
    requestField('amount_requested_minor', 'Amount requested'),
    requestField('term_months', 'Term'),
    requestField('purpose', 'What the money is for'),
    requestField('collateral_value_minor', 'Value of the security'),
  ],
};

/** The requirements that apply to this applicant, given what they have said so far. */
export function requirementsForStep(
  step: ApplicationStep,
  data: ApplicationData,
): readonly ApplicationRequirement[] {
  return APPLICATION_STEP_REQUIREMENTS[step].filter((requirement) => requirement.appliesTo(data));
}

/** The requirements that apply and are still unanswered, in the order the form asks them. */
export function unmetRequirements(
  step: ApplicationStep,
  data: ApplicationData,
): readonly ApplicationRequirement[] {
  return requirementsForStep(step, data).filter((requirement) => !requirement.isAnswered(data));
}
