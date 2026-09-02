import type { MachineShape } from '../types.ts';

import { applicationMachine } from './application.ts';
import { creditReleaseMachine } from './credit-release.ts';
import { documentSlotMachine } from './document-slot.ts';

export * from './application.ts';
export * from './credit-release.ts';
export * from './document-slot.ts';

/**
 * Every machine, seen without its context type.
 *
 * This is the list the code generator flattens and the reachability test walks.
 * It is `MachineShape[]` rather than a tuple of the three concrete types because
 * neither of those consumers ever calls a guard, and giving them the context
 * types would make one list impossible to type at all.
 *
 * Order follows WORKFLOW_MACHINES in packages/domain. Nothing depends on it --
 * the generator sorts by primary key -- but a reader comparing the two lists
 * should not have to.
 */
export const ALL_MACHINES: readonly MachineShape[] = [
  applicationMachine,
  documentSlotMachine,
  creditReleaseMachine,
];
