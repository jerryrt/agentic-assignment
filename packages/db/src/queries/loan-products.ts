/**
 * Loan products, and the declarative rule sets hung off them.
 *
 * `criteria` and `required_docs` arrive as `Json` and stay that way here.
 * Parsing them is `packages/rules`' and `packages/domain`'s job: a shape
 * decided in the persistence layer would be a second definition of the rule
 * set for the first one to drift from (CLAUDE.md section 9).
 */

import type { DatabaseClient } from '../client.js';
import type { Database } from '../database.types.js';
import { unwrapList, unwrapMaybe } from '../errors.js';

export type LoanProduct = Database['public']['Tables']['loan_product']['Row'];

/**
 * The products an organisation is currently offering.
 *
 * Filtered to `active` because an inactive product must not appear in an
 * application form, while remaining readable by id: applications already
 * submitted against a withdrawn product still have to render.
 */
export async function listActiveLoanProducts(
  client: DatabaseClient,
  orgId: string,
): Promise<readonly LoanProduct[]> {
  return unwrapList(
    'loan_product.list-active',
    await client
      .from('loan_product')
      .select('*')
      .eq('org_id', orgId)
      .eq('active', true)
      .order('name'),
  );
}

/** One product by id, active or not. */
export async function getLoanProduct(
  client: DatabaseClient,
  productId: string,
): Promise<LoanProduct | null> {
  return unwrapMaybe(
    'loan_product.get',
    await client.from('loan_product').select('*').eq('id', productId).maybeSingle(),
  );
}
