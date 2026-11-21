// Guard rails. See specs/08-safety.feature.

export const MASS_DELETE_COUNT = 25;
export const MASS_DELETE_FRACTION = 0.1;
/** The percentage rule only applies from this many deletions, so tiny vaults aren't nagged. */
export const MASS_DELETE_MIN_FOR_FRACTION = 5;

export function isMassDeletion(deletions: number, trackedFiles: number): boolean {
  if (deletions === 0) return false;
  if (deletions >= MASS_DELETE_COUNT) return true;
  return deletions >= MASS_DELETE_MIN_FOR_FRACTION && deletions > trackedFiles * MASS_DELETE_FRACTION;
}

/** The vault has no tracked files at all, but the index says it used to. */
export function vaultLooksWiped(indexedFiles: number, localTrackedFiles: number): boolean {
  return indexedFiles > 0 && localTrackedFiles === 0;
}
