// The one journey the app can support today.
//
// apps/web/src/app/app.routes.ts is an empty array and apps/web/src/app/app.html
// is a single <router-outlet />.  There is no navigation, no form and no screen,
// so a test claiming to walk an application would be a test of nothing dressed
// as coverage.  What IS assertable is the delivery path every later journey
// depends on, and each of these has failed in a real project:
//
//   - the shell boots at all, and boots clean
//   - a deep link reaches the shell instead of a 404, which is what the SPA
//     rewrite exists for and the first thing to break on a real deployment
//   - nothing the initial load asks for is missing
//
// When routes arrive, this file stays as it is: it is the smoke test, and its
// job is to tell you the difference between "the feature is broken" and "the
// application did not start".  New journeys are new files -- see the README.

import { expect, test } from '../fixtures/test';

// This file asserts nothing about data, so it does not pay for a reset.  The
// policy and the reason for it are in fixtures/database.ts.
test.use({ database: 'shared' });

test('the application shell boots without a browser error', async ({ page }) => {
  const response = await page.goto('/');

  expect(response?.status(), 'the dev server must serve the document').toBe(200);
  // app-root is the bootstrap target in apps/web/src/index.html. Attached only
  // proves the document; the router outlet below proves Angular ran.
  await expect(page.locator('app-root')).toBeAttached();
  // Angular replaces <router-outlet /> with a comment anchor once the router has
  // bootstrapped, so a rendered outlet is the cheapest honest evidence that the
  // framework started rather than that index.html was returned.
  await expect
    .poll(async () => page.locator('app-root').innerHTML(), {
      message: 'Angular did not bootstrap: app-root was never filled in',
    })
    .toContain('router-outlet');

  // Nothing is asserted about console output here on purpose: the fixture does
  // it for every test in the suite, so a journey cannot forget to.
});

test('the initial load fetches nothing that is missing', async ({ page }) => {
  // A 404 on a stylesheet or a chunk does not fail navigation and often does not
  // fail a test either; it just renders an unstyled page that a screenshot test
  // then adopts as its baseline.  Collect them instead.
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto('/');
  await expect(page.locator('app-root')).toBeAttached();

  expect(
    failures,
    `the initial load requested resources that failed:\n${failures.join('\n')}`,
  ).toEqual([]);
});

// A URL no route matches today, chosen because it is one the lender scope will
// own tomorrow.  The claim under test is the SPA fallback, not the route.
//
// Locally that fallback belongs to the Angular dev server; in production it is
// the rewrite in apps/web/vercel.json.  They are two implementations of one rule
// and this suite can only reach the first, so the deployment smoke check in
// plan/08-cicd.md is what covers the second.
const DEEP_LINK = '/lender/queue';

test.describe('a deep link', () => {
  // DEFECT, not an exemption.  With app.routes.ts empty, Angular's router raises
  // NG04002 ("Cannot match any routes") for any path but "/", and the browser
  // console records it.  qa owns no application source, so this file records the
  // behaviour and does not repair it; the fix belongs to whichever scope adds
  // routes, as a wildcard route rendering a not-found page.  The guard is off
  // for the reachability claim below so that the claim is tested on its own
  // merits, and the console error itself is asserted separately, immediately
  // after, so that turning the guard off cannot quietly swallow it.
  test.use({ failOnConsoleError: false });

  test('is served the application shell, not a 404', async ({ page }) => {
    const response = await page.goto(DEEP_LINK);

    expect(response?.status(), 'the SPA fallback must return the document, not 404').toBe(200);
    await expect(page.locator('app-root')).toBeAttached();
  });
});

// Expected to fail while the defect above stands, and that is the point: this
// records it in the suite instead of in a comment nobody runs.  The day someone
// adds a wildcard route, Playwright reports "expected to fail but passed" and
// this marker gets deleted -- which is a far better reminder than a TODO.
test.describe('the same deep link, with the console guard left on', () => {
  test.fail(true, 'app.routes.ts has no wildcard route, so a deep link logs NG04002');

  test('reaches the shell without an unhandled router error', async ({ page }) => {
    await page.goto(DEEP_LINK);
    await expect(page.locator('app-root')).toBeAttached();
    // The assertion is performed by the console guard in fixtures/test.ts during
    // teardown, which is why this body ends here.
  });
});
