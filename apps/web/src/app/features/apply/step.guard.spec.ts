import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import type { ActivatedRouteSnapshot } from '@angular/router';
import type { ApplicationStep } from '@lj/domain';

import { ApplicationStore } from './application.store.ts';
import { applyStepGuard } from './step.guard.ts';

interface FakeStore {
  furthestStep: ReturnType<typeof signal<ApplicationStep>>;
  status: ReturnType<typeof signal<string>>;
  opened: string[];
}

function snapshotFor(step: string | null, applicationId: string | null): ActivatedRouteSnapshot {
  return {
    paramMap: { get: (name: string) => (name === 'step' ? step : null) },
    parent: { paramMap: { get: (name: string) => (name === 'id' ? applicationId : null) } },
  } as unknown as ActivatedRouteSnapshot;
}

function decide(
  fake: FakeStore,
  step: string | null,
  applicationId: string | null = 'app-1',
): Promise<boolean | UrlTree> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: ApplicationStore,
        useValue: {
          furthestStep: fake.furthestStep,
          status: fake.status,
          open: (id: string) => {
            fake.opened.push(id);
            return Promise.resolve();
          },
        },
      },
    ],
  });
  return TestBed.runInInjectionContext(
    () =>
      applyStepGuard(snapshotFor(step, applicationId), {
        url: '',
      } as never) as Promise<boolean | UrlTree>,
  );
}

function newFake(furthest: ApplicationStep = 'financials'): FakeStore {
  return { furthestStep: signal(furthest), status: signal('ready'), opened: [] };
}

describe('applyStepGuard', () => {
  it('admits a step at or behind the furthest reached', async () => {
    const fake = newFake('financials');
    expect(await decide(fake, 'borrower')).toBe(true);
    expect(await decide(fake, 'financials')).toBe(true);
  });

  it('sends a deep link past the furthest step back to where the applicant is', async () => {
    const decision = await decide(newFake('farm'), 'request');
    expect(TestBed.inject(Router).serializeUrl(decision as UrlTree)).toBe('/apply/app-1/farm');
  });

  it('sends an unknown step to the first one', async () => {
    const decision = await decide(newFake(), 'financialz');
    expect(TestBed.inject(Router).serializeUrl(decision as UrlTree)).toBe('/apply/app-1/borrower');
  });

  it('sends a URL with no application back to the list', async () => {
    const decision = await decide(newFake(), 'borrower', null);
    expect(TestBed.inject(Router).serializeUrl(decision as UrlTree)).toBe('/apply');
  });

  it('reads the application before deciding, so the decision is made against the server', async () => {
    const fake = newFake();
    await decide(fake, 'farm');
    expect(fake.opened).toEqual(['app-1']);
  });

  // Redirecting on the default furthest step would bounce the applicant to
  // step one and hide the reason they could not be shown their own file.
  it('lets an unreadable application through so the failure can be rendered', async () => {
    const fake = newFake('borrower');
    fake.status.set('error');
    expect(await decide(fake, 'request')).toBe(true);
  });
});
