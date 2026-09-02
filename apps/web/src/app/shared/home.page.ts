import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { SupabaseAuthService } from '../core/auth/auth.service.ts';

/**
 * The landing screen each role reaches after signing in.
 *
 * A PLACEHOLDER, and named as one so nobody mistakes it for a dashboard. It
 * exists because "borrower and lender see different roots" has to be
 * demonstrable before either root's feature exists, and because a root that
 * renders nothing is indistinguishable from a root that is broken.
 *
 * A feature scope replaces it by registering its own route (see the comment
 * block in app.routes.ts) and removing the entry that points here. It holds no
 * business rules and reads no aggregate, so nothing is lost when it goes.
 *
 * One component serves both roots on purpose: the difference between them is
 * which routes are reachable, which is a routing fact, not a layout one.
 * Duplicating the shell of a placeholder to say two sentences differently would
 * be the wrong kind of thoroughness.
 */
@Component({
  selector: 'lj-home-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lj-page">
      <h1>{{ heading() }}</h1>
      <p>
        Signed in as <strong>{{ auth.displayName() }}</strong
        >{{ roleSuffix() }}.
      </p>

      <div class="lj-card">
        <h2>Nothing to show here yet</h2>
        <p>
          The application, document and servicing features are built by separate
          scopes and register their own routes. Until one of them lands, this is
          the whole of {{ rootLabel() }}.
        </p>
      </div>
    </div>
  `,
})
export class HomePage {
  protected readonly auth = inject(SupabaseAuthService);

  private readonly isLenderSide = computed(() => this.auth.audience() === 'lender');

  protected readonly heading = computed(() =>
    this.isLenderSide() ? 'Lending desk' : 'Your land loans',
  );

  protected readonly rootLabel = computed(() =>
    this.isLenderSide() ? 'the lending desk' : 'the borrower dashboard',
  );

  protected readonly roleSuffix = computed(() => {
    const role = this.auth.role();
    return role === null ? '' : ' (' + role + ')';
  });
}
