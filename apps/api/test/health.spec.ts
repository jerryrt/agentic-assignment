import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../src/routes/health.ts';

/**
 * The route is a Web Handler, so the test calls it exactly as the Vercel
 * runtime does: hand it a `Request`, inspect the `Response` it returns. There
 * is no server, no port and no fixture in between, which is what makes these
 * assertions evidence about the deployed function rather than about a mock.
 */

const HEALTH_URL = 'https://lj-api.example/api/health';

function request(headers: Record<string, string> = {}): Request {
  return new Request(HEALTH_URL, { method: 'GET', headers });
}

async function body(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/health', () => {
  it('answers 200 with a JSON body', async () => {
    const response = GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('forbids caching, because a cached health check reports the past', () => {
    const response = GET(request());

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reports the service as up', async () => {
    const payload = await body(GET(request()));

    expect(payload).toMatchObject({ status: 'ok', service: 'lj-api' });
  });

  it('reports the deployment it is running, so a deploy can be verified', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'fa1eade47b73733d6312d5abfad33ce9e4068081');

    const payload = await body(GET(request()));

    expect(payload).toMatchObject({
      environment: 'preview',
      commit: 'fa1eade47b73733d6312d5abfad33ce9e4068081',
    });
  });

  it('names the absent case rather than reporting an empty string', async () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');

    const payload = await body(GET(request()));

    expect(payload).toMatchObject({ environment: 'local', commit: 'unknown' });
  });

  it('emits a timestamp, proving the function ran for this request', async () => {
    const before = Date.now();
    const payload = (await body(GET(request()))) as { time: string };

    expect(Date.parse(payload.time)).toBeGreaterThanOrEqual(before - 1000);
  });

  /**
   * The two tests below are the reason this route is allowed to read
   * `process.env` at all. A health endpoint is unauthenticated and internet
   * reachable, so anything it serialises is public. Asserting the exact key
   * set is deliberately stricter than asserting a secret is absent: it also
   * fails when a future edit adds a field nobody reviewed.
   */
  it('serialises only the agreed keys', async () => {
    const payload = (await body(GET(request()))) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      'commit',
      'environment',
      'service',
      'status',
      'time',
    ]);
  });

  it('never discloses a secret held in the function environment', async () => {
    const secret = 'sentinel-service-role-key-must-not-appear';
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', secret);
    vi.stubEnv('SUPABASE_ANON_KEY', 'sentinel-anon-key-must-not-appear');

    const response = GET(request());
    const serialised = await response.text();

    expect(serialised).not.toContain('sentinel');
    for (const [, value] of response.headers) {
      expect(value).not.toContain('sentinel');
    }
  });

  it('never echoes anything the caller sent', async () => {
    const response = GET(
      request({
        authorization: 'Bearer sentinel-bearer-token',
        cookie: 'session=sentinel-session-cookie',
        'x-forwarded-for': '203.0.113.9',
      }),
    );
    const serialised = await response.text();

    expect(serialised).not.toContain('sentinel');
    expect(serialised).not.toContain('203.0.113.9');
  });
});
