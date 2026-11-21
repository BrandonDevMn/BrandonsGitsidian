// Guard rails. See specs/08-safety.feature.

export const MASS_DELETE_COUNT = 25;
export const MASS_DELETE_FRACTION = 0.1;

export function isMassDeletion(deletions: number, trackedFiles: number): boolean {
  if (deletions === 0) return false;
  return deletions >= MASS_DELETE_COUNT || deletions > trackedFiles * MASS_DELETE_FRACTION;
}

/** The vault has no tracked files at all, but the index says it used to. */
export function vaultLooksWiped(indexedFiles: number, localTrackedFiles: number): boolean {
  return indexedFiles > 0 && localTrackedFiles === 0;
}
