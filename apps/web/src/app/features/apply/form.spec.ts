import { ApplicationDataSchema, unmetRequirements, type ApplicationData } from '@lj/domain';

import {
  applicationDataFromForm,
  buildApplicationForm,
  loadApplicationForm,
  newParcelGroup,
} from './form.ts';

const SEEDED_DRAFT: unknown = {
  borrower: {
    entity_type: 'corporation',
    legal_name: 'Fenwick Grain Co.',
    trade_name: 'Fenwick Grain',
    incorporation_year: 2011,
    years_farming: 14,
    province: 'SK',
    postal_code: 'S7K 1A1',
    contact_email: 'borrower@example.test',
    contact_phone: '306-555-0142',
  },
  farm: {
    primary_commodity: 'grain',
    parcels: [
      { legal_description: 'NW-14-35-05-W3', acres: 1600, tenure: 'owned', commodity: 'grain' },
      { legal_description: 'SE-22-35-05-W3', acres: 800, tenure: 'leased', commodity: 'oilseed' },
    ],
  },
  financials: {
    gross_revenue_minor: 182000000,
    operating_expenses_minor: 121000000,
    existing_debt_service_minor: 34000000,
    current_assets_minor: 96000000,
    current_liabilities_minor: 41000000,
  },
};

function parsed(value: unknown): ApplicationData {
  return ApplicationDataSchema.parse(value);
}

describe('the application form', () => {
  // Every step of the demo walk-through starts by loading a payload and ends
  // by reading one back. If that is not the identity, the applicant loses work
  // on the first navigation, quietly.
  it('round-trips the seeded draft without changing a value', () => {
    const data = parsed(SEEDED_DRAFT);
    const form = buildApplicationForm();
    loadApplicationForm(form, data);

    expect(applicationDataFromForm(form.getRawValue())).toEqual(data);
  });

  it('round-trips a payload with nothing answered', () => {
    const form = buildApplicationForm();
    loadApplicationForm(form, parsed({}));

    expect(applicationDataFromForm(form.getRawValue())).toEqual(parsed({}));
  });

  // The load is the moment the pristine-form guard depends on: a form that
  // arrives dirty is a form the autosave will write back over the server's copy
  // before the applicant has typed anything.
  it('leaves the form pristine after a load', () => {
    const form = buildApplicationForm();
    loadApplicationForm(form, parsed(SEEDED_DRAFT));

    expect(form.dirty).toBe(false);
    expect(form.pristine).toBe(true);
  });

  it('rebuilds the parcels array to match the payload it loads', () => {
    const form = buildApplicationForm();
    loadApplicationForm(form, parsed(SEEDED_DRAFT));
    expect(form.controls.farm.controls.parcels.length).toBe(2);

    loadApplicationForm(form, parsed({ farm: { parcels: [{ acres: 40 }] } }));
    expect(form.controls.farm.controls.parcels.length).toBe(1);
  });

  it('carries a parcel row added by the applicant into the payload', () => {
    const form = buildApplicationForm();
    loadApplicationForm(form, parsed({}));

    const parcel = newParcelGroup();
    parcel.setValue({
      legal_description: 'NW-14-35-05-W3',
      acres: '1600',
      tenure: 'owned',
      commodity: 'grain',
    });
    form.controls.farm.controls.parcels.push(parcel);

    expect(applicationDataFromForm(form.getRawValue()).farm.parcels).toEqual([
      { legal_description: 'NW-14-35-05-W3', acres: 1600, tenure: 'owned', commodity: 'grain' },
    ]);
  });

  // The one rule this file exists to keep: required-ness is the domain's, and
  // the form must not carry a second copy of it. A form of empty controls is
  // therefore VALID, and it is `unmetRequirements` that says the step is not
  // answered. If a Validators.required is ever added, this test fails.
  it('holds no required validators, because required-ness is the domain rule', () => {
    const form = buildApplicationForm();
    loadApplicationForm(form, parsed({}));

    expect(form.valid).toBe(true);
    expect(unmetRequirements('borrower', applicationDataFromForm(form.getRawValue())).length)
      .toBeGreaterThan(0);
  });

  it('reports a format problem on the control it is about, and only when answered', () => {
    const form = buildApplicationForm();
    loadApplicationForm(form, parsed({}));
    const borrower = form.controls.borrower.controls;

    expect(borrower.contact_email.valid).toBe(true);
    borrower.contact_email.setValue('not-an-address');
    expect(borrower.contact_email.hasError('email')).toBe(true);
    borrower.contact_email.setValue('borrower@example.test');
    expect(borrower.contact_email.valid).toBe(true);

    borrower.postal_code.setValue('NOT A CODE');
    expect(borrower.postal_code.hasError('pattern')).toBe(true);
    borrower.postal_code.setValue('S7K1A1');
    expect(borrower.postal_code.valid).toBe(true);
  });

  it('reports a malformed amount without losing what was typed', () => {
    const form = buildApplicationForm();
    const revenue = form.controls.financials.controls.gross_revenue_minor;

    revenue.setValue('$182,000');
    expect(revenue.hasError('money')).toBe(true);
    expect(revenue.value).toBe('$182,000');
    // Unreadable is not zero: the payload records nothing rather than a figure
    // the applicant did not enter.
    expect(
      applicationDataFromForm(form.getRawValue()).financials.gross_revenue_minor,
    ).toBeNull();

    revenue.setValue('182,000.00');
    expect(revenue.valid).toBe(true);
    expect(applicationDataFromForm(form.getRawValue()).financials.gross_revenue_minor).toBe(
      18200000,
    );
  });
});
