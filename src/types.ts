/**
 * types.ts: the shared vocabulary of ThisOneTime.
 *
 * Purpose:      Define the data every module passes around.
 * Interactions: Imported by all modules. Contains types only.
 * Persistence:  `Settings` and `Library` are saved in IndexedDB.
 */

/** Bandcamp's keys for downloadable formats, confirmed by Spike S1. */
export type FormatKey =
  | "flac"
  | "alac"
  | "wav"
  | "aiff-lossless"
  | "mp3-320"
  | "mp3-v0"
  | "aac-hi"
  | "vorbis";

/** One row in the user's ordered format preference list. */
export interface FormatPreference {
  key: FormatKey;
  enabled: boolean;
}

/** Everything the user can configure. */
export interface Settings {
  /** Highest preference first. */
  formats: FormatPreference[];
  /** When true, albums are extracted into their own folders. */
  autoUnzip: boolean;
  /** When true, items hidden on the Bandcamp profile are included. */
  includeHidden: boolean;
}

/**
 * Where a release is in its lifecycle.
 *
 * pending -> active -> done, attention, or failed.
 * `preorder` and `unavailable` are never queued.
 */
export type ReleaseStatus =
  | "pending"
  | "active"
  | "done"
  | "attention"
  | "failed"
  | "preorder"
  | "unavailable";

/** A fixed explanation shown beside a release. */
export type ReleaseNote =
  | "no_preferred_format"
  | "needs_confirmation"
  | "kept_zip"
  | "download_failed";

/** One purchased release and its backup progress. */
export interface Release {
  /** Bandcamp's sale type and ID, such as `a123`. Unique within a library. */
  key: string;
  itemId: string;
  /** Signed link to the release's download page. Stored locally only. */
  redownloadUrl: string | null;
  artist: string;
  title: string;
  kind: "album" | "track";
  hidden: boolean;
  status: ReleaseStatus;
  note: ReleaseNote | null;
  /** The format actually saved. */
  format: FormatKey | null;
  /** True when a lower-ranked format was used. */
  usedFallback: boolean;
  attempts: number;
  /** Added to folder names when two releases share an artist and title. */
  folderSuffix: string;
}

/** Why the queue is not currently running. */
export type PauseReason =
  | "user"
  | "tab_closed"
  | "rate_limited"
  | "client_challenge"
  | "logged_out"
  | "disk_full"
  | "folder_access";

export type QueuePhase = "idle" | "running" | "paused" | "finished";

/** One fan's saved library and queue. */
export interface Library {
  fanId: number;
  phase: QueuePhase;
  pauseReason: PauseReason | null;
  releases: Release[];
}

/** Live, unsaved progress for a release being processed. */
export interface Activity {
  stage: "preparing" | "downloading" | "unzipping";
  /** Bytes finished, or files finished while unzipping. */
  done: number;
  total: number;
}

/** A cancellable delay. Injected so tests never really wait. */
export type WaitFunction = (ms: number, signal?: AbortSignal) => Promise<void>;
