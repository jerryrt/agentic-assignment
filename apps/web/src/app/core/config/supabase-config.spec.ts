import { SUPABASE_ANON_KEY_VAR, SUPABASE_URL_VAR } from '@lj/db';

import { readSupabaseConfig } from './supabase-config.ts';

/**
 * Two claims, and they matter for opposite reasons. A misconfigured build must
 * be diagnosable rather than a blank page, and a diagnosis must never quote the
 * key it is complaining about.
 */
describe('readSupabaseConfig', () => {
  it('accepts a complete environment', () => {
    const result = readSupabaseConfig({
      [SUPABASE_URL_VAR]: 'http://127.0.0.1:54321',
      [SUPABASE_ANON_KEY_VAR]: 'not-a-real-key',
    });

    expect(result).toEqual({
      ok: true,
      config: { url: 'http://127.0.0.1:54321', anonKey: 'not-a-real-key' },
    });
  });

  it('names the missing variable rather than throwing during bootstrap', () => {
    const result = readSupabaseConfig({ [SUPABASE_URL_VAR]: 'http://127.0.0.1:54321' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.missingVariable).toBe(SUPABASE_ANON_KEY_VAR);
  });

  // Turbo's strict environment mode hands a task it did not declare a blank
  // string rather than nothing, and an empty key builds a client that looks
  // configured and fails later as an opaque 401.
  it('treats a blank value as absent', () => {
    const result = readSupabaseConfig({
      [SUPABASE_URL_VAR]: '  ',
      [SUPABASE_ANON_KEY_VAR]: 'not-a-real-key',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.missingVariable).toBe(SUPABASE_URL_VAR);
  });

  it('carries no part of a key in the failure it reports', () => {
    const result = readSupabaseConfig({ [SUPABASE_ANON_KEY_VAR]: 'super-secret-value' });

    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });
});
