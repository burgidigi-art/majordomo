import type { CrewProfile, RuntimeId } from './types.ts';

/**
 * Whether a crew member may handle private work: work in a private project, and anything from the
 * user's email or calendar.
 *
 * A crew member's own switch decides. Where it has never been set, the answer is yes only for a
 * crew member on the same company's models as the manager, because the manager already sees
 * everything; work sent to any other company is a new recipient, so that takes a deliberate yes.
 */
export function crewCleared(
  crew: Pick<CrewProfile, 'trusted' | 'runtime'>,
  managerRuntime: RuntimeId,
  familyOf: (runtime: RuntimeId) => string,
): boolean {
  return crew.trusted ?? familyOf(crew.runtime) === familyOf(managerRuntime);
}
