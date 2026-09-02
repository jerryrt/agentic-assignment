import { TestBed } from '@angular/core/testing';
import { SUPABASE_ANON_KEY_VAR, SUPABASE_URL_VAR } from '@lj/db';

import { provideSupabaseConfig } from '../config/supabase-config.ts';
import { DATABASE_CLIENT, provideDatabaseClient } from './database-client.ts';

/**
 * One client, one session, and a null that a feature can render.
 *
 * The second claim is the one worth a test. An unconfigured build has to stay
 * diagnosable rather than turn into a blank page, which is why the
 * configuration is carried as a value rather than thrown (see
 * ../config/supabase-config.ts). Moving the client construction out of
 * SupabaseAuthService must not lose that branch.
 */
function clientFrom(environment: Record<string, string | undefined>): unknown {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideSupabaseConfig(environment), provideDatabaseClient()],
  });
  return TestBed.inject(DATABASE_CLIENT);
}

const CONFIGURED = {
  [SUPABASE_URL_VAR]: 'http://127.0.0.1:54321',
  [SUPABASE_ANON_KEY_VAR]: 'not-a-real-key',
};

describe('the browser database client', () => {
  it('builds a client when the build carried a configuration', () => {
    expect(clientFrom(CONFIGURED)).not.toBeNull();
  });

  it('is null when the build carried none, rather than throwing during bootstrap', () => {
    expect(clientFrom({})).toBeNull();
  });

  // Two clients would persist two copies of one session, and the failure is
  // the one nobody reproduces: whichever of them refreshed last holds a token
  // the other has already replaced.
  it('is one client for the whole application', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideSupabaseConfig(CONFIGURED), provideDatabaseClient()],
    });
    expect(TestBed.inject(DATABASE_CLIENT)).toBe(TestBed.inject(DATABASE_CLIENT));
  });
});
