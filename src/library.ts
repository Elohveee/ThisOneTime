/**
 * library.ts: pure rules for a fan's saved library.
 *
 * Purpose:  Merge fresh scans, recover interrupted runs, and summarize results.
 * Promise:  A finished release is never queued again, even after settings
 *           change or its files are moved to another backup location.
 * Testing:  Every function is pure apart from updating the given library.
 */
import { assignFolderSuffixes } from "./filenames.js";
import type { FormatKey, Library, Release, ReleaseStatus } from "./types.js";

/** Totals shown in the interface. */
export interface LibrarySummary {
  counts: Record<ReleaseStatus, number>;
  /** Releases that can be, or have been, downloaded. */
  downloadable: number;
  /** Releases that have reached an outcome. */
  finished: number;
  byFormat: Partial<Record<FormatKey, number>>;
  fallbacks: number;
  keptZips: number;
}

/** Creates an empty library for a fan. */
export function createLibrary(fanId: number): Library {
  return { fanId, phase: "idle", pauseReason: null, releases: [] };
}

/**
 * Combines a fresh scan with saved progress.
 *
 * Saved outcomes are kept, while links and names are refreshed. Unfinished
 * releases missing from the scan are dropped, such as hidden items after the
 * hidden option is turned off.
 */
export function mergeScan(library: Library, scanned: readonly Release[]): void {
  const saved = new Map(library.releases.map((release) => [release.key, release]));
  const scannedKeys = new Set(scanned.map((release) => release.key));

  const merged = scanned.map((fresh): Release => {
    const old = saved.get(fresh.key);
    if (!old) return fresh;
    if (old.status === "done") return { ...old, hidden: fresh.hidden };

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

  const keptDone = library.releases.filter(
    (release) => release.status === "done" && !scannedKeys.has(release.key),
  );
  library.releases = [...merged, ...keptDone];
  assignFolderSuffixes(library.releases);

  if (library.phase === "finished" && library.releases.some((r) => r.status === "pending")) {
    library.phase = "idle";
  }
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

/** Puts every release with a problem back in the queue. */
export function retryProblems(library: Library): void {
  for (const release of library.releases) {
    if (release.status !== "failed" && release.status !== "attention") continue;
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

  for (const release of library?.releases ?? []) {
    counts[release.status] += 1;
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
  };
}
