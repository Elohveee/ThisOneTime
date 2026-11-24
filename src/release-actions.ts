/**
 * release-actions.ts: pure rules for controlling individual releases.
 *
 * Purpose:  Decide what ignore, redownload, cancel, and search do.
 * Ignore:   Ignored keys live on the library rather than on each release, so
 *           the choice survives a release leaving and returning to a scan.
 * Redownload: A queued release remembers its earlier note. Its format stays in
 *           place until a new copy succeeds, so Cancel can restore it exactly.
 * Files:    Nothing here touches the disk. Ignoring never deletes music.
 * Testing:  Every function is pure apart from updating the given library.
 */
import type { Library, Release } from "./types.js";

export type RowActionId = "redownload" | "cancel-redownload" | "ignore" | "unignore";

/** One button shown on a release row. */
export interface RowAction {
  id: RowActionId;
  label: string;
  disabled: boolean;
  /** Why the action is unavailable, when the release itself prevents it. */
  reason: string;
}

/** Returns the ignored keys as a Set for fast lookups. */
export const ignoredSet = (library: Library): Set<string> => new Set(library.ignoredKeys ?? []);

/** True when a good earlier copy exists, including during a redownload. */
export const hasFinishedCopy = (release: Release): boolean =>
  release.status === "done" || Boolean(release.redownload);

/**
 * Keeps the queue phase truthful after the set of queued releases changes.
 *
 * A paused queue with nothing left is finished, and a finished queue that
 * gained work is ready to start again.
 */
export function settlePhase(library: Library): void {
  const ignored = ignoredSet(library);
  const hasQueued = library.releases.some(
    (release) => release.status === "pending" && !ignored.has(release.key),
  );
  if (library.phase === "paused" && !hasQueued) {
    library.phase = "finished";
    library.pauseReason = null;
  } else if (library.phase === "finished" && hasQueued) {
    library.phase = "idle";
  }
}

/** Restores a release to the finished state it had before its redownload. */
export function cancelRedownload(library: Library, release: Release): void {
  if (!release.redownload) return;
  release.status = "done";
  release.note = release.redownload.note;
  release.attempts = 0;
  delete release.redownload;
  settlePhase(library);
}

/**
 * Marks or unmarks a release as ignored.
 *
 * Its status is left alone, so a finished release stays finished and an
 * unfinished one rejoins the queue when it stops being ignored.
 */
export function setIgnored(library: Library, release: Release, ignored: boolean): void {
  if (ignored) cancelRedownload(library, release);
  const keys = ignoredSet(library);
  if (ignored) keys.add(release.key);
  else keys.delete(release.key);
  library.ignoredKeys = [...keys];
  settlePhase(library);
}

/** Explains why a finished release cannot be downloaded again, if so. */
function redownloadBlock(release: Release): string {
  if (release.missingFromScan) return "Not in your latest Bandcamp scan";
  if (!release.redownloadUrl) return "Bandcamp does not currently offer this download";
  return "";
}

/** Queues a finished release to be downloaded again. */
export function queueRedownload(library: Library, release: Release): void {
  if (release.status !== "done" || redownloadBlock(release)) return;
  release.redownload = { note: release.note };
  release.status = "pending";
  release.note = null;
  release.attempts = 0;
  settlePhase(library);
}

/** Lists the buttons for one release. `locked` disables all of them. */
export function rowActions(release: Release, ignored: boolean, locked: boolean): RowAction[] {
  const action = (id: RowActionId, label: string, reason = ""): RowAction => ({
    id,
    label,
    disabled: locked || Boolean(reason),
    reason,
  });
  if (ignored) return [action("unignore", "Stop ignoring")];
  const ignore = action("ignore", "Ignore");
  if (release.redownload) return [action("cancel-redownload", "Cancel"), ignore];
  if (release.status === "done") {
    return [action("redownload", "Redownload", redownloadBlock(release)), ignore];
  }
  return [ignore];
}

/** Applies a row button to the library. */
export function applyRowAction(library: Library, release: Release, id: RowActionId): void {
  if (id === "ignore") setIgnored(library, release, true);
  if (id === "unignore") setIgnored(library, release, false);
  if (id === "redownload") queueRedownload(library, release);
  if (id === "cancel-redownload") cancelRedownload(library, release);
}

/** Lowercases text and gives accented characters one consistent encoding. */
const normalize = (text: string): string => text.normalize("NFC").toLocaleLowerCase();

/** Basic search: a case-insensitive substring of "<artist> <title>". */
export function matchesSearch(release: Release, query: string): boolean {
  const needle = normalize(query.trim());
  return !needle || normalize(`${release.artist} ${release.title}`).includes(needle);
}
