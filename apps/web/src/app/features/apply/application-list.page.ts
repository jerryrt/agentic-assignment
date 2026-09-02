import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  EMPTY_APPLICATION_DATA,
  isApplicationStep,
  type ApplicationStep,
} from '@lj/domain';
import type { BorrowerApplication, Organisation } from '@lj/db';
import { insertApplication, listBorrowerApplications, listOrganisations } from '@lj/db';
import { LjStateBadge } from '@lj/ui';

import { SupabaseAuthService } from '../../core/auth/auth.service.ts';
import { DATABASE_CLIENT } from '../../core/data/database-client.ts';

/**
 * The borrower's own applications, and the way to start another.
 *
 * It reads straight from Supabase under row-level security -- there is no API
 * call here and there should not be. `application_read_own` returns this
 * borrower's rows and nobody else's, so the list is filtered by the database
 * rather than by a `where` clause anyone could edit.
 *
 * Starting an application needs an organisation, because `application.org_id`
 * is not null and a borrower's `profile.org_id` is (that column is for
 * lenders). `0002_rls.sql` grants every authenticated user select on
 * `organisation` for exactly this reason: the counterparty has to be choosable.
 *
 * The row is inserted with an EMPTY payload and no state. `state` is not in the
 * insert grant at all, so the row can only take the 'draft' default -- the
 * client physically cannot create an application in any other state, which is
 * a stronger guarantee than a policy that merely checks one.
 */
@Component({
  selector: 'lj-application-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LjStateBadge],
  template: `
    <div class="lj-page list">
      <header class="list__header">
        <h1>Your applications</h1>
        <p class="list__lead">
          An application is saved as you go, so you can leave one part way through and
          come back to it.
        </p>
      </header>

      @if (problem(); as message) {
        <p class="list__problem" role="alert" data-testid="list-problem">{{ message }}</p>
      }

      @if (loading()) {
        <p role="status">Reading your applications...</p>
      } @else {
        @if (applications().length === 0) {
          <p class="list__empty" data-testid="no-applications">
            You have not started an application yet.
          </p>
        } @else {
          <ul class="list__items">
            @for (application of applications(); track application.id) {
              <li class="list__item">
                <a [routerLink]="resumeLink(application)" class="list__link">
                  <span class="list__name">{{ nameOf(application) }}</span>
                  <lj-state-badge
                    [subject]="{ machine: 'application', state: stateOf(application) }"
                    [audience]="auth.audience()"
                  />
                </a>
                <span class="list__updated">Last touched {{ application.updated_at }}</span>
              </li>
            }
          </ul>
        }

        <section class="list__start">
          <h2>Start a new application</h2>
          @if (organisations().length === 0) {
            <p class="list__empty">No lenders are available to apply to.</p>
          } @else {
            <ul class="list__lenders">
              @for (organisation of organisations(); track organisation.id) {
                <li>
                  <button
                    class="lj-button"
                    type="button"
                    [disabled]="starting()"
                    (click)="start(organisation)"
                    data-testid="start-application"
                  >
                    Apply to {{ organisation.name }}
                  </button>
                </li>
              }
            </ul>
          }
        </section>
      }
    </div>
  `,
  styles: `
    .list {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .list__header h1,
    .list__lead {
      margin: 0;
    }

    .list__lead,
    .list__empty,
    .list__updated {
      color: var(--lj-muted);
    }

    .list__problem {
      margin: 0;
      color: var(--lj-err);
    }

    .list__items,
    .list__lenders {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .list__item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 16px;
      border: 1px solid var(--lj-border);
      border-radius: 8px;
      background: var(--lj-surface);
    }

    .list__link {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
      color: var(--lj-text);
      font-weight: 600;
    }

    .list__updated {
      font-size: 12.5px;
      line-height: 18px;
    }

    .list__start h2 {
      margin: 0 0 12px;
      font-size: 20px;
      line-height: 28px;
    }
  `,
})
export class ApplicationListPage {
  private readonly client = inject(DATABASE_CLIENT);
  private readonly router = inject(Router);

  protected readonly auth = inject(SupabaseAuthService);

  private readonly rows = signal<readonly BorrowerApplication[]>([]);
  private readonly lenders = signal<readonly Organisation[]>([]);
  private readonly isLoading = signal(true);
  private readonly isStarting = signal(false);
  private readonly failure = signal<string | null>(null);

  protected readonly applications = this.rows.asReadonly();
  protected readonly organisations = this.lenders.asReadonly();
  protected readonly loading = this.isLoading.asReadonly();
  protected readonly starting = this.isStarting.asReadonly();
  protected readonly problem = computed(() => this.failure());

  constructor() {
    void this.read();
  }

  /** Resume where they left off, which is what `furthest_step` records. */
  protected resumeLink(application: BorrowerApplication): readonly string[] {
    const stored = application.furthest_step;
    const step: ApplicationStep =
      stored !== null && isApplicationStep(stored) ? stored : 'borrower';
    return ['/apply', application.id ?? '', step];
  }

  /**
   * The legal name out of the payload, or a stand-in.
   *
   * Read defensively rather than through the schema: this is a list, one row
   * of which failing to parse should cost that row its title and not the whole
   * screen.
   */
  protected nameOf(application: BorrowerApplication): string {
    const data = application.data;
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const borrower = (data as Record<string, unknown>)['borrower'];
      if (typeof borrower === 'object' && borrower !== null) {
        const name = (borrower as Record<string, unknown>)['legal_name'];
        if (typeof name === 'string' && name.trim() !== '') {
          return name;
        }
      }
    }
    return 'Untitled application';
  }

  protected stateOf(application: BorrowerApplication): 'draft' {
    // The view type makes every column nullable, because Postgres reports no
    // not-null constraint through a view. The column has a default and a check
    // behind it; 'draft' is the reading that cannot mislead.
    return (application.state ?? 'draft') as 'draft';
  }

  protected async start(organisation: Organisation): Promise<void> {
    const client = this.client;
    const borrowerId = this.auth.identity()?.userId ?? null;
    if (client === null || borrowerId === null) {
      this.failure.set('An application cannot be started until you are signed in.');
      return;
    }

    this.isStarting.set(true);
    this.failure.set(null);
    try {
      const created = await insertApplication(client, {
        borrower_id: borrowerId,
        org_id: organisation.id,
        data: EMPTY_APPLICATION_DATA,
        furthest_step: 'borrower',
      });
      if (created === null) {
        this.failure.set('The application could not be created.');
        return;
      }
      await this.router.navigate(['/apply', created.id, 'borrower']);
    } catch {
      this.failure.set('The application could not be created.');
    } finally {
      this.isStarting.set(false);
    }
  }

  private async read(): Promise<void> {
    const client = this.client;
    const borrowerId = this.auth.identity()?.userId ?? null;
    if (client === null) {
      this.failure.set('This deployment cannot reach the database.');
      this.isLoading.set(false);
      return;
    }
    try {
      const [applications, organisations] = await Promise.all([
        borrowerId === null
          ? Promise.resolve([])
          : listBorrowerApplications(client, borrowerId),
        listOrganisations(client),
      ]);
      this.rows.set(applications);
      this.lenders.set(organisations);
    } catch {
      this.failure.set('Your applications could not be read.');
    } finally {
      this.isLoading.set(false);
    }
  }
}
