import {
  COMMODITIES,
  ENTITY_TYPES,
  IRRIGATION_LEVELS,
  LAND_TENURES,
  PROVINCES,
  STATEMENT_BASES,
} from '@lj/domain';

import type { FieldOption } from './field.ts';

/**
 * The words shown for each member of the closed vocabularies in @lj/domain.
 *
 * They live here rather than in @lj/domain because @lj/domain owns what a value
 * IS and this is what it is CALLED on a screen -- the same split the state
 * label maps make, and the same reason `packages/ui` holds the badge tones. The
 * moment a second surface renders one of these -- the lender's queue showing a
 * commodity, say -- it moves down into @lj/domain as an audience-keyed map, and
 * not before: one caller is not two, and a map built for one caller is a guess
 * about the second.
 *
 * Written as a full mapped type over each union, so a value added to a
 * vocabulary and forgotten here is a compile error rather than an empty option
 * in a select.
 */

type Labels<T extends readonly string[]> = { readonly [K in T[number]]: string };

const ENTITY_TYPE_LABELS: Labels<typeof ENTITY_TYPES> = {
  sole_trader: 'Sole trader',
  partnership: 'Partnership',
  corporation: 'Corporation',
};

const COMMODITY_LABELS: Labels<typeof COMMODITIES> = {
  grain: 'Grain',
  oilseed: 'Oilseed',
  pulse: 'Pulse',
  forage: 'Forage',
  livestock: 'Livestock',
  dairy: 'Dairy',
  horticulture: 'Horticulture',
  mixed: 'Mixed',
};

const LAND_TENURE_LABELS: Labels<typeof LAND_TENURES> = {
  owned: 'Owned',
  leased: 'Leased',
  share_cropped: 'Share cropped',
};

const IRRIGATION_LABELS: Labels<typeof IRRIGATION_LEVELS> = {
  none: 'None -- dryland',
  partial: 'Some acres irrigated',
  full: 'Fully irrigated',
};

const STATEMENT_BASIS_LABELS: Labels<typeof STATEMENT_BASES> = {
  accrual: 'Accrual',
  cash: 'Cash',
};

function optionsFrom<T extends readonly string[]>(
  values: T,
  labels: Labels<T>,
): readonly FieldOption[] {
  return values.map((value) => ({ value, label: labels[value as T[number]] }));
}

export const ENTITY_TYPE_OPTIONS = optionsFrom(ENTITY_TYPES, ENTITY_TYPE_LABELS);
export const COMMODITY_OPTIONS = optionsFrom(COMMODITIES, COMMODITY_LABELS);
export const LAND_TENURE_OPTIONS = optionsFrom(LAND_TENURES, LAND_TENURE_LABELS);
export const IRRIGATION_OPTIONS = optionsFrom(IRRIGATION_LEVELS, IRRIGATION_LABELS);
export const STATEMENT_BASIS_OPTIONS = optionsFrom(STATEMENT_BASES, STATEMENT_BASIS_LABELS);

/**
 * Provinces are their own codes. Spelling them out would put thirteen more
 * strings in this file for no gain: 'SK' is what a criterion compares, what a
 * postal address carries, and what a farmer writes.
 */
export const PROVINCE_OPTIONS: readonly FieldOption[] = PROVINCES.map((code) => ({
  value: code,
  label: code,
}));

/** Yes / no, where neither has been chosen yet. See flagToValue in ../form-fields.ts. */
export const YES_NO_OPTIONS: readonly FieldOption[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];
