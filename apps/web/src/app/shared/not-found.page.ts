import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * What a URL no route matches renders.
 *
 * This is the fix for the defect apps/web/e2e/system/shell.spec.ts records
 * against this scope. With `app.routes.ts` empty, every path but "/" reached the
 * shell through the SPA rewrite and then found no route: Angular raised
 * `NG04002: Cannot match any routes`, logged it, and rendered nothing. The page
 * looked broken and the console said why, which is the wrong way round.
 *
 * The wildcard route that renders this is the last entry in `app.routes.ts` and
 * must stay last -- Angular matches in order, so a wildcard above a real route
 * swallows it silently.
 */
@Component({
  selector: 'lj-not-found-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="lj-page">
      <h1>Page not found</h1>
      <p>
        There is nothing at this address. It may have moved, or the link that
        brought you here may be out of date.
      </p>
      <p><a routerLink="/">Back to your dashboard</a></p>
    </div>
  `,
})
export class NotFoundPage {}
