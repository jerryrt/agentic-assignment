// Browser-suite harness.  The plan it implements is docs/02-browser-testing.md;
// this file is only the configuration half of it.  The fixtures that make a
// journey cheap to write live in apps/web/e2e/fixtures, and apps/web/e2e/README.md
// is the handoff for the scopes that will add journeys.
//
// The config lives at the repository root rather than under apps/web because the
// suite drives the whole local stack -- the Angular dev server, the Supabase
// containers and (later) the serverless API -- and none of those belong to one
// workspace package.  Running `playwright test` from the root is then the whole
// command, with no --config to remember.

/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

// Every path in this file is relative to the repository root, which is where
// Playwright resolves them from.
const E2E_DIR = './apps/web/e2e';

// 127.0.0.1 rather than localhost, deliberately.  On a machine with IPv6 enabled
// `localhost` may resolve to ::1 while the dev server binds 0.0.0.0, and the
// resulting ECONNREFUSED looks like a broken test rather than a broken address.
// The Supabase stack advertises 127.0.0.1 for the same reason.
const HOST = '127.0.0.1';

/**
 * An environment variable set to the empty string means "not set" here.
 * Wrappers pass variables through unconditionally (see
 * apps/web/e2e/run-in-container.sh), so `?? default` alone would hand Playwright
 * an empty baseURL and every goto('/') would fail on an unparseable address.
 */
function fromEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The Supabase URL and anon key, read at configuration time.
 *
 * Angular has no runtime environment, and `angular.json`'s `define` cannot
 * interpolate, so the values are compiled into the app by the dev server that
 * serves it. The fixtures read the same stack again at run time for their own
 * requests; this read exists only to configure the server below.
 *
 * The local keys are worthless off 127.0.0.1 and are never written to a file.
 */
function readStackConfig(): { url: string; anonKey: string } {
  const raw = execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8' });
  const status = JSON.parse(raw) as { API_URL?: string; ANON_KEY?: string };
  if (status.API_URL === undefined || status.ANON_KEY === undefined) {
    throw new Error('supabase status did not report API_URL and ANON_KEY; is the stack running?');
  }
  return { url: status.API_URL, anonKey: status.ANON_KEY };
}

const stack = readStackConfig();

const PORT = Number(fromEnv('E2E_PORT') ?? 4200);
const baseURL = fromEnv('E2E_BASE_URL') ?? `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: E2E_DIR,

  // Traces, videos and failure screenshots are written inside the owned e2e
  // directory instead of the repository root, so one .gitignore next to them
  // covers every artefact the suite produces.
  outputDir: `${E2E_DIR}/.artifacts/test-results`,

  // Visual baselines are committed, so their path has to be stable and readable.
  // {projectName} is in the template because a baseline is only valid for the
  // browser, viewport and colour scheme that produced it: light and dark are
  // different projects and must never share a file.
  snapshotPathTemplate: `${E2E_DIR}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}`,

  // One worker, and files run one after another.  See the isolation note in
  // apps/web/e2e/fixtures/database.ts: there is exactly one local Postgres, and
  // a second worker resetting it mid-test would corrupt the first worker's data
  // in a way that surfaces as an unrelated assertion failure.  The suite the
  // plan describes is deliberately small (three system tests), so the wall-clock
  // cost of serialising it is small and the debugging cost it removes is not.
  fullyParallel: false,
  workers: 1,

  // No retries, in CI or out of it.  docs/02-browser-testing.md is explicit that
  // a flake must not be papered over, and a retry does exactly that: it turns an
  // intermittent failure into a green run with a note nobody reads.  A flake
  // here is a bug in the test or in the app, and it should stop the pipeline
  // until one of them is fixed.
  retries: 0,

  forbidOnly: Boolean(process.env['CI']),

  timeout: 30_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Zero tolerance.  Determinism is bought with the container image, the
      // frozen clock and the mask option (see the plan), never by widening the
      // threshold, because a widened threshold hides the next real regression.
      maxDiffPixels: 0,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },

  reporter: process.env['CI']
    ? [
        // Annotates the failing line in the GitHub Actions log and on the PR,
        // which is where the failure is actually read.
        ['github'],
        ['html', { open: 'never', outputFolder: `${E2E_DIR}/.artifacts/report` }],
        ['list'],
      ]
    : [['list'], ['html', { open: 'never', outputFolder: `${E2E_DIR}/.artifacts/report` }]],

  use: {
    baseURL,

    // What makes a failure diagnosable rather than merely red.  All three are
    // failure-only: a trace of a passing test is 5 MB nobody opens.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // The app honours prefers-reduced-motion (design/00-foundations.md), so
    // asking for it here removes animation as a source of visual flake without
    // the test having to disable anything itself.
    //
    // Under contextOptions and not beside colorScheme, which reads as an
    // inconsistency and is not one: as of Playwright 1.62 reducedMotion is a
    // browser-context option with no top-level test option of its own. Written
    // at the top level it type-checks nowhere and is silently ignored at run
    // time, which is the worst of both -- the suite looks configured and the
    // animations still play.
    contextOptions: { reducedMotion: 'reduce' },
    colorScheme: 'light',

    // Saskatchewan does not observe daylight saving.  A suite pinned to a zone
    // that does would render a different local time for half the year, which is
    // the kind of failure that arrives on a Sunday in March with no code change
    // behind it.  en-CA matches the domain (Canadian agricultural lending) and
    // fixes number and date formatting.
    timezoneId: 'America/Regina',
    locale: 'en-CA',

    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      // Signs each seeded role in once per run and saves its storage state.
      // Everything else depends on this, so a broken stack fails here with a
      // message that names the problem, rather than 30 tests failing on a
      // redirect to a login page that nobody asked for.
      name: 'setup',
      testMatch: /auth\.setup\.ts$/,
    },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        // Pinned rather than inherited from devices, because a viewport change
        // invalidates every visual baseline and that should be a deliberate
        // edit to this line.
        viewport: { width: 1280, height: 800 },
      },
    },
    // Deferred, not forgotten: the plan calls for light and dark visual projects
    // over apps/web/e2e/visual/.  They are not declared yet because none of the
    // surfaces they photograph exist, and a project matching no files is a
    // project whose baselines nobody notices are missing.  Adding them is a
    // testDir plus a colorScheme, and they must run in the container image (see
    // apps/web/e2e/run-in-container.sh) or the baselines are unreproducible.
  ],

  webServer: {
    // The app under test.  Only the web app: the smoke journey does not call the
    // API, and starting the whole turbo dev graph would make a failure to boot
    // the API look like a failure of the browser suite.
    // The Supabase configuration is compiled in, because Angular has no runtime
    // env and `angular.json`'s `define` cannot interpolate. Passing it here
    // rather than through the package's `dev` script is deliberate: the CLI
    // rejects `--define` after the `--` separator that `pnpm run` inserts, so a
    // journey that signs in would fail against an app built with blank config.
    command:
      `pnpm --filter @lj/web exec ng serve --host ${HOST} --port ${PORT}` +
      ` --define "LJ_SUPABASE_URL='${stack.url}'"` +
      ` --define "LJ_SUPABASE_ANON_KEY='${stack.anonKey}'"`,
    url: baseURL,
    // Locally, reuse a dev server the developer already has running -- the inner
    // loop is the point.  In CI there is never one to reuse, and silently
    // testing against a stale server would be worse than starting a new one.
    reuseExistingServer: !process.env['CI'],
    // A cold Angular build with no .angular cache is slow; 30 s is not enough
    // and the resulting timeout reads as a hang.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
