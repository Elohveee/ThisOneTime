/**
 * library.ts: pure rules for a fan's saved library.
 *
 * Purpose:  Merge fresh scans, recover interrupted runs, and summarize results.
 * Promise:  A finished release is queued again only when the user asks, never
 *           because settings changed or its files moved to another location.
 * Testing:  Every function is pure apart from updating the given library.
 */
import { assignFolderSuffixes } from "./filenames.js";
import { cancelRedownload, hasFinishedCopy, ignoredSet, settlePhase } from "./release-actions.js";
import type { FormatKey, Library, Release, ReleaseStatus } from "./types.js";

/** Totals shown in the interface. */
export interface LibrarySummary {
  counts: Record<ReleaseStatus, number>;
  /** Releases that can be, or have been, downloaded. Excludes ignored ones. */
  downloadable: number;
  /** Releases that have reached an outcome. */
  finished: number;
  byFormat: Partial<Record<FormatKey, number>>;
  fallbacks: number;
  keptZips: number;
  ignored: number;
  /** Queued releases that are replacing a finished copy. */
  redownloads: number;
}

/** Creates an empty library for a fan. */
export function createLibrary(fanId: number): Library {
  return { fanId, phase: "idle", pauseReason: null, releases: [] };
}

/**
 * Combines a fresh scan with saved progress.
 *
 * Saved outcomes are kept and links are refreshed. Finished releases keep
 * their saved names so a redownload lands in the same folder. Unfinished
 * releases missing from the scan are dropped, such as hidden items after the
 * hidden option is turned off. A queued redownload that Bandcamp no longer
 * offers returns to its finished state.
 */
export function mergeScan(library: Library, scanned: readonly Release[]): void {
  const saved = new Map(library.releases.map((release) => [release.key, release]));
  const scannedKeys = new Set(scanned.map((release) => release.key));
  const available = new Set(scanned.filter((r) => r.status === "pending").map((r) => r.key));
  for (const release of library.releases) {
    if (release.redownload && !available.has(release.key)) cancelRedownload(library, release);
  }

  const merged = scanned.map((fresh): Release => {
    const old = saved.get(fresh.key);
    if (!old) return fresh;
    if (hasFinishedCopy(old)) {
      return {
        ...old,
        redownloadUrl: available.has(fresh.key) ? fresh.redownloadUrl : null,
        hidden: fresh.hidden,
        missingFromScan: false,
      };
    }

    const keepsProblem =
      (old.status === "attention" || old.status === "failed") && fresh.status === "pending";
    if (keepsProblem) {
      return {
        ...old,
        redownloadUrl: fresh.redownloadUrl,
        artist: fresh.artist,
        title: fresh.title,
        hidden: fresh.hidden,
      };
    }
    return { ...fresh, attempts: old.attempts };
  });

  const keptDone = library.releases
    .filter((release) => release.status === "done" && !scannedKeys.has(release.key))
    .map((release) => ({ ...release, missingFromScan: true }));
  library.releases = [...merged, ...keptDone];
  assignFolderSuffixes(library.releases);
  settlePhase(library);
}

/**
 * Repairs a saved library after the page loads.
 *
 * A saved `running` phase means the tab closed without pausing. Active releases
 * return to pending because their transfers no longer exist.
 */
export function recoverInterrupted(library: Library): boolean {
  if (library.phase !== "running") return false;
  for (const release of library.releases) {
    if (release.status === "active") release.status = "pending";
  }
  library.phase = "paused";
  library.pauseReason = "tab_closed";
  return true;
}

/** Puts every release with a problem back in the queue, except ignored ones. */
export function retryProblems(library: Library): void {
  const ignored = ignoredSet(library);
  for (const release of library.releases) {
    if (release.status !== "failed" && release.status !== "attention") continue;
    if (ignored.has(release.key)) continue;
    release.status = "pending";
    release.note = null;
    release.attempts = 0;
  }
}

/** Calculates totals for the interface. */
export function summarize(library: Library | null): LibrarySummary {
  const counts: Record<ReleaseStatus, number> = {
    pending: 0,
    active: 0,
    done: 0,
    attention: 0,
    failed: 0,
    preorder: 0,
    unavailable: 0,
  };
  const byFormat: LibrarySummary["byFormat"] = {};
  let fallbacks = 0;
  let keptZips = 0;
  let ignored = 0;
  let redownloads = 0;
  const ignoredKeys = library ? ignoredSet(library) : new Set<string>();

  for (const release of library?.releases ?? []) {
    if (ignoredKeys.has(release.key)) {
      ignored += 1;
      continue;
    }
    counts[release.status] += 1;
    if (release.status === "pending" && release.redownload) redownloads += 1;
    if (release.status !== "done") continue;
    if (release.format) byFormat[release.format] = (byFormat[release.format] ?? 0) + 1;
    if (release.usedFallback) fallbacks += 1;
    if (release.note === "kept_zip") keptZips += 1;
  }

  const finished = counts.done + counts.attention + counts.failed;
  return {
    counts,
    downloadable: finished + counts.pending + counts.active,
    finished,
    byFormat,
    fallbacks,
    keptZips,
    ignored,
    redownloads,
  };
}
