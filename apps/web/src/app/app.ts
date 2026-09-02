import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { SupabaseAuthService } from './core/auth/auth.service.ts';

/**
 * The application shell: the frame every screen renders inside.
 *
 * It carries the three things that must not be re-implemented per feature --
 * navigation, who is signed in, and how to sign out -- and nothing else. No
 * feature state, no business rule, no data read. A shell that knows about
 * applications is a shell every feature has to edit.
 *
 * Navigation differs by role, and the difference is derived from the role
 * rather than assembled per screen. `NAVIGATION` below is the single statement
 * of "what does this role get to see", so a feature scope adding a route adds
 * one row here and the menu is correct everywhere at once (CLAUDE.md section 9).
 *
 * Hiding a link is a courtesy, not a control. A borrower who types the lender
 * URL is stopped by `roleGuard` from rendering it and by row-level security
 * from reading anything through it; the menu is about not offering people
 * doors that will not open.
 */

interface NavigationItem {
  readonly label: string;
  readonly path: string;
  /** Which audience sees it. Keyed on the audience, not the role, so 'admin'
   *  reads the lender side without a third list (plan/02-domain-model.md). */
  readonly audience: 'borrower' | 'lender';
}

/**
 * FEATURE SCOPES: add your entry point here, in the same commit as the route.
 * A route with no menu entry is a feature reachable only by typing its URL.
 */
const NAVIGATION: readonly NavigationItem[] = [
  { label: 'Dashboard', path: '/', audience: 'borrower' },
  { label: 'Applications', path: '/apply', audience: 'borrower' },
  { label: 'Lending desk', path: '/lender', audience: 'lender' },
];

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly auth = inject(SupabaseAuthService);
  private readonly router = inject(Router);

  /**
   * Bound rather than written inline in the template: `routerLinkActive`'s
   * options object is compared by identity, and a fresh literal on every change
   * detection pass makes the directive re-evaluate for no reason.
   */
  protected readonly exact = { exact: true };

  protected readonly navigation = computed(() => {
    const audience = this.auth.audience();
    return NAVIGATION.filter((item) => item.audience === audience);
  });

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/signin');
  }
}
