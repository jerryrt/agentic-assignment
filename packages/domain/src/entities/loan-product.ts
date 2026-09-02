import { z } from 'zod';

import { MoneyFromNumericSchema } from '../money.ts';
import { JsonValueSchema, NonEmptyTextSchema, UuidSchema } from '../primitives.ts';

/**
 * A product a lender offers, with its criteria as data.
 *
 * `criteria` and `required_docs` stay opaque JSON here on purpose. They are
 * interpreted by packages/rules and by the document pack, both of which sit
 * above this package; giving them a shape here would put the schema for a rule
 * below the layer that owns the rule, and the threshold inside it would then
 * have two homes (CLAUDE.md sections 8 and 9). The consuming layer parses them
 * with its own schema.
 */
export const LoanProductSchema = z.object({
  id: UuidSchema,
  org_id: UuidSchema,
  name: NonEmptyTextSchema,
  min_amount: MoneyFromNumericSchema.nullable(),
  max_amount: MoneyFromNumericSchema.nullable(),
  criteria: JsonValueSchema,
  required_docs: JsonValueSchema,
  active: z.boolean(),
});

export type LoanProduct = z.infer<typeof LoanProductSchema>;
