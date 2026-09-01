import type { MachineShape } from '../types.js';

import { applicationMachine } from './application.js';
import { creditReleaseMachine } from './credit-release.js';
import { documentSlotMachine } from './document-slot.js';

export * from './application.js';
export * from './credit-release.js';
export * from './document-slot.js';

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
