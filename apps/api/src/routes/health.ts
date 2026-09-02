/**
 * GET /api/health -- the liveness probe used to prove a deployment landed.
 *
 * Vercel deploys every file under this directory as one function addressed by
 * its path, and the handler is a Web Handler: a named export per HTTP method,
 * taking a standard `Request` and returning a standard `Response`. Confirmed
 * against the `framework=other` example in
 * https://vercel.com/docs/functions/functions-api-reference (an `api/*.ts`
 * file exporting `export function GET(request: Request)`).
 *
 * Exporting `GET` alone, rather than the single `fetch` export, is deliberate:
 * the runtime then rejects every other method for us, so the route cannot be
 * reached by a POST that this file never anticipated.
 */

/** Included so a caller can tell which service answered a shared hostname. */
const SERVICE_NAME = 'lj-api';

/**
 * Vercel populates these in the function's environment at request time, given
 * "Enable access to System Environment Variables" on the project. Reading them
 * here rather than inlining them during the build is not a style choice:
 * Turbo 2 runs tasks in strict env mode and `turbo.json` declares only
 * SUPABASE_URL, SUPABASE_ANON_KEY and VERCEL_ENV for `build`, so a value baked
 * in at build time would be blank. The serverless runtime is a separate
 * process with its own environment that Turbo never sees.
 *
 * Both are public: a deployment's environment name and the commit SHA of a
 * public repository. Nothing else from `process.env` is read, and the
 * environment is never enumerated -- see the key-set test in
 * `test/health.spec.ts`, which fails if that ever stops being true.
 */
function readEnvironmentName(): string {
  // `||` and not `??`: Vercel injects an empty string for a system variable
  // the project has not enabled, and "" is as absent as undefined here.
  return process.env['VERCEL_ENV'] || 'local';
}

function readCommitSha(): string {
  return process.env['VERCEL_GIT_COMMIT_SHA'] || 'unknown';
}

export function GET(_request: Request): Response {
  const report = {
    status: 'ok',
    service: SERVICE_NAME,
    environment: readEnvironmentName(),
    commit: readCommitSha(),
    // Distinguishes a live invocation from a cached or static 200.
    time: new Date().toISOString(),
  };

  // Serialised explicitly rather than through `Response.json` so that the
  // exact bytes leaving the function are visible in one place.
  return new Response(JSON.stringify(report), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // A health check answered from the CDN describes a past deployment,
      // which is the one thing it must never do.
      'cache-control': 'no-store',
    },
  });
}
