import {
  FormArray,
  FormControl,
  FormGroup,
  Validators,
  type AbstractControl,
  type ValidationErrors,
} from '@angular/forms';
import { ApplicationDataSchema, type ApplicationData } from '@lj/domain';

import {
  choiceFromValue,
  choiceToValue,
  flagFromValue,
  flagToValue,
  integerFromValue,
  integerToValue,
  isMalformedInteger,
  isMalformedMoney,
  moneyFromValue,
  moneyToValue,
  textFromValue,
  textToValue,
} from './form-fields.ts';

/**
 * The typed reactive form behind the four steps, and its mapping to the
 * payload.
 *
 * Two decisions here are the ones to read.
 *
 * **There is no `Validators.required` in this file, and there must never be
 * one.** Which fields a step needs is `APPLICATION_STEP_REQUIREMENTS` in
 * @lj/domain: it is conditional on the entity type, packages/rules turns it
 * into the completeness results the `submit` guard reads, and the server
 * re-evaluates the same list. A required validator here would be a second copy
 * of that policy (CLAUDE.md section 9), and the two would disagree the first
 * time a conditional field moved -- the form would let an applicant past a step
 * the server then refuses, or hold them at one the server would have accepted.
 * The form asks the domain whether a step is answered; see
 * `unmetRequirements`.
 *
 * What validators DO carry is **format**, which is not a policy and has no
 * second home: an email that is not an email, a postal code in the wrong
 * shape, an amount that is not a decimal literal. Each of them passes an empty
 * control, because empty is "not answered" and that is the requirement list's
 * question, not this one's.
 *
 * **Every control holds a string** (./form-fields.ts explains why), so the
 * form's raw value is uniform text and one function turns it into a payload.
 * That function ends in `ApplicationDataSchema.parse`, so the schema is the
 * single normaliser: blank becomes null once, in one place, rather than at
 * thirty call sites.
 */

/* ---------------------------------------------------------------- validators */

/** Canada Post's forward sortation area plus local delivery unit, space optional. */
const POSTAL_CODE = /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/;

function malformedMoney(control: AbstractControl<string>): ValidationErrors | null {
  return isMalformedMoney(control.value) ? { money: true } : null;
}

function malformedInteger(control: AbstractControl<string>): ValidationErrors | null {
  return isMalformedInteger(control.value) ? { integer: true } : null;
}

function text(): FormControl<string> {
  return new FormControl('', { nonNullable: true });
}

function email(): FormControl<string> {
  // Angular's email validator passes an empty control, which is what is wanted:
  // "not answered" is the requirement list's question, not this one's.
  return new FormControl('', { nonNullable: true, validators: [Validators.email] });
}

function postalCode(): FormControl<string> {
  return new FormControl('', {
    nonNullable: true,
    validators: [Validators.pattern(POSTAL_CODE)],
  });
}

function integer(): FormControl<string> {
  return new FormControl('', { nonNullable: true, validators: [malformedInteger] });
}

function money(): FormControl<string> {
  return new FormControl('', { nonNullable: true, validators: [malformedMoney] });
}

/* -------------------------------------------------------------- the controls */

export interface ParcelControls {
  legal_description: FormControl<string>;
  acres: FormControl<string>;
  tenure: FormControl<string>;
  commodity: FormControl<string>;
}

export type ParcelGroup = FormGroup<ParcelControls>;

export interface ApplicationFormControls {
  borrower: FormGroup<{
    entity_type: FormControl<string>;
    legal_name: FormControl<string>;
    trade_name: FormControl<string>;
    incorporation_year: FormControl<string>;
    years_farming: FormControl<string>;
    province: FormControl<string>;
    postal_code: FormControl<string>;
    contact_email: FormControl<string>;
    contact_phone: FormControl<string>;
  }>;
  farm: FormGroup<{
    primary_commodity: FormControl<string>;
    secondary_commodity: FormControl<string>;
    irrigation: FormControl<string>;
    has_crop_insurance: FormControl<string>;
    storage_capacity_tonnes: FormControl<string>;
    parcels: FormArray<ParcelGroup>;
  }>;
  financials: FormGroup<{
    fiscal_year_end: FormControl<string>;
    statements_basis: FormControl<string>;
    gross_revenue_minor: FormControl<string>;
    operating_expenses_minor: FormControl<string>;
    existing_debt_service_minor: FormControl<string>;
    current_assets_minor: FormControl<string>;
    current_liabilities_minor: FormControl<string>;
    inventory_value_minor: FormControl<string>;
    land_value_minor: FormControl<string>;
    off_farm_income_minor: FormControl<string>;
  }>;
  request: FormGroup<{
    product_id: FormControl<string>;
    amount_requested_minor: FormControl<string>;
    term_months: FormControl<string>;
    purpose: FormControl<string>;
    collateral_value_minor: FormControl<string>;
    preferred_start_date: FormControl<string>;
  }>;
}

export type ApplicationForm = FormGroup<ApplicationFormControls>;

export function newParcelGroup(): ParcelGroup {
  return new FormGroup<ParcelControls>({
    legal_description: text(),
    acres: integer(),
    tenure: text(),
    commodity: text(),
  });
}

export function buildApplicationForm(): ApplicationForm {
  return new FormGroup<ApplicationFormControls>({
    borrower: new FormGroup({
      entity_type: text(),
      legal_name: text(),
      trade_name: text(),
      incorporation_year: integer(),
      years_farming: integer(),
      province: text(),
      postal_code: postalCode(),
      contact_email: email(),
      contact_phone: text(),
    }),
    farm: new FormGroup({
      primary_commodity: text(),
      secondary_commodity: text(),
      irrigation: text(),
      has_crop_insurance: text(),
      storage_capacity_tonnes: integer(),
      parcels: new FormArray<ParcelGroup>([]),
    }),
    financials: new FormGroup({
      fiscal_year_end: text(),
      statements_basis: text(),
      gross_revenue_minor: money(),
      operating_expenses_minor: money(),
      existing_debt_service_minor: money(),
      current_assets_minor: money(),
      current_liabilities_minor: money(),
      inventory_value_minor: money(),
      land_value_minor: money(),
      off_farm_income_minor: money(),
    }),
    request: new FormGroup({
      product_id: text(),
      amount_requested_minor: money(),
      term_months: integer(),
      purpose: text(),
      collateral_value_minor: money(),
      preferred_start_date: text(),
    }),
  });
}

/* ------------------------------------------------------ payload <-> raw text */

/** The form's value, which is text throughout. */
export type RawApplicationValue = ReturnType<ApplicationForm['getRawValue']>;

/**
 * Load a payload into the form without dirtying it.
 *
 * `emitEvent: false` on the parcel rebuild, and only there: adding and removing
 * FormArray rows fires a value change per operation, and a load that emitted
 * them would look to the autosave effect exactly like an applicant typing --
 * which is the bug that silently writes an empty form over good server data.
 * The single patch at the end emits once, which is what the autosave gate then
 * reads and correctly ignores because the form is still pristine.
 */
export function loadApplicationForm(form: ApplicationForm, data: ApplicationData): void {
  const parcels = form.controls.farm.controls.parcels;
  parcels.clear({ emitEvent: false });
  for (const parcel of data.farm.parcels) {
    const group = newParcelGroup();
    group.setValue({
      legal_description: textFromValue(parcel.legal_description),
      acres: integerFromValue(parcel.acres),
      tenure: choiceFromValue(parcel.tenure),
      commodity: choiceFromValue(parcel.commodity),
    });
    parcels.push(group, { emitEvent: false });
  }

  form.patchValue({
    borrower: {
      entity_type: choiceFromValue(data.borrower.entity_type),
      legal_name: textFromValue(data.borrower.legal_name),
      trade_name: textFromValue(data.borrower.trade_name),
      incorporation_year: integerFromValue(data.borrower.incorporation_year),
      years_farming: integerFromValue(data.borrower.years_farming),
      province: choiceFromValue(data.borrower.province),
      postal_code: textFromValue(data.borrower.postal_code),
      contact_email: textFromValue(data.borrower.contact_email),
      contact_phone: textFromValue(data.borrower.contact_phone),
    },
    farm: {
      primary_commodity: choiceFromValue(data.farm.primary_commodity),
      secondary_commodity: choiceFromValue(data.farm.secondary_commodity),
      irrigation: choiceFromValue(data.farm.irrigation),
      has_crop_insurance: flagFromValue(data.farm.has_crop_insurance),
      storage_capacity_tonnes: integerFromValue(data.farm.storage_capacity_tonnes),
    },
    financials: {
      fiscal_year_end: textFromValue(data.financials.fiscal_year_end),
      statements_basis: choiceFromValue(data.financials.statements_basis),
      gross_revenue_minor: moneyFromValue(data.financials.gross_revenue_minor),
      operating_expenses_minor: moneyFromValue(data.financials.operating_expenses_minor),
      existing_debt_service_minor: moneyFromValue(data.financials.existing_debt_service_minor),
      current_assets_minor: moneyFromValue(data.financials.current_assets_minor),
      current_liabilities_minor: moneyFromValue(data.financials.current_liabilities_minor),
      inventory_value_minor: moneyFromValue(data.financials.inventory_value_minor),
      land_value_minor: moneyFromValue(data.financials.land_value_minor),
      off_farm_income_minor: moneyFromValue(data.financials.off_farm_income_minor),
    },
    request: {
      product_id: textFromValue(data.request.product_id),
      amount_requested_minor: moneyFromValue(data.request.amount_requested_minor),
      term_months: integerFromValue(data.request.term_months),
      purpose: textFromValue(data.request.purpose),
      collateral_value_minor: moneyFromValue(data.request.collateral_value_minor),
      preferred_start_date: textFromValue(data.request.preferred_start_date),
    },
  });
  form.markAsPristine();
}

/**
 * The form's text, as a payload.
 *
 * The result goes through ApplicationDataSchema, which is what makes this a
 * conversion rather than a second definition of the shape: every "blank means
 * null" decision is already made there, and a field added to the schema and
 * forgotten here fails `tsc` at the object literal rather than being silently
 * dropped on the next autosave.
 *
 * Nothing here can fail. A half-typed amount converts to null and reads as
 * unanswered; the format validator on the control is what tells the applicant
 * about it, beside the field, once they have left it.
 */
export function applicationDataFromForm(raw: RawApplicationValue): ApplicationData {
  return ApplicationDataSchema.parse({
    borrower: {
      entity_type: choiceToValue(raw.borrower.entity_type),
      legal_name: textToValue(raw.borrower.legal_name),
      trade_name: textToValue(raw.borrower.trade_name),
      incorporation_year: integerToValue(raw.borrower.incorporation_year),
      years_farming: integerToValue(raw.borrower.years_farming),
      province: choiceToValue(raw.borrower.province),
      postal_code: textToValue(raw.borrower.postal_code),
      contact_email: textToValue(raw.borrower.contact_email),
      contact_phone: textToValue(raw.borrower.contact_phone),
    },
    farm: {
      primary_commodity: choiceToValue(raw.farm.primary_commodity),
      secondary_commodity: choiceToValue(raw.farm.secondary_commodity),
      irrigation: choiceToValue(raw.farm.irrigation),
      has_crop_insurance: flagToValue(raw.farm.has_crop_insurance),
      storage_capacity_tonnes: integerToValue(raw.farm.storage_capacity_tonnes),
      parcels: raw.farm.parcels.map((parcel) => ({
        legal_description: textToValue(parcel.legal_description),
        acres: integerToValue(parcel.acres),
        tenure: choiceToValue(parcel.tenure),
        commodity: choiceToValue(parcel.commodity),
      })),
    },
    financials: {
      fiscal_year_end: textToValue(raw.financials.fiscal_year_end),
      statements_basis: choiceToValue(raw.financials.statements_basis),
      gross_revenue_minor: moneyToValue(raw.financials.gross_revenue_minor),
      operating_expenses_minor: moneyToValue(raw.financials.operating_expenses_minor),
      existing_debt_service_minor: moneyToValue(raw.financials.existing_debt_service_minor),
      current_assets_minor: moneyToValue(raw.financials.current_assets_minor),
      current_liabilities_minor: moneyToValue(raw.financials.current_liabilities_minor),
      inventory_value_minor: moneyToValue(raw.financials.inventory_value_minor),
      land_value_minor: moneyToValue(raw.financials.land_value_minor),
      off_farm_income_minor: moneyToValue(raw.financials.off_farm_income_minor),
    },
    request: {
      product_id: textToValue(raw.request.product_id),
      amount_requested_minor: moneyToValue(raw.request.amount_requested_minor),
      term_months: integerToValue(raw.request.term_months),
      purpose: textToValue(raw.request.purpose),
      collateral_value_minor: moneyToValue(raw.request.collateral_value_minor),
      preferred_start_date: textToValue(raw.request.preferred_start_date),
    },
  });
}
