/**
 * queue.ts: decides what downloads next.
 *
 * Purpose:  Run three workers through the library's pending releases, skipping
 *           any the user ignored.
 * Flow:     pending -> active -> done, attention, or failed.
 *           Pausing or an interruption returns active releases to pending.
 * Saving:   Each status change is saved, so a closed tab loses little progress.
 * Stops:    Rate limits, security checks, logouts, a full disk, or lost folder
 *           access pause the entire queue with a reason for the user.
 * Why 3:    Spike S3 showed no speed gain over one download on the test
 *           connection, while three keeps short releases moving.
 */
import { QueueStop, type BandcampClient } from "./bandcamp.js";
import { cleanTempFolder, saveRelease } from "./files.js";
import { ignoredSet } from "./release-actions.js";
import type { Activity, Library, PauseReason, Release, Settings, WaitFunction } from "./types.js";

const WORKERS = 3;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

export interface QueueDeps {
  client: BandcampClient;
  root: FileSystemDirectoryHandle;
  library: Library;
  settings: Settings;
  save: (library: Library) => Promise<void>;
  onChange: () => void;
  wait: WaitFunction;
}

export interface QueueControls {
  /** Live progress for active releases. Never saved. */
  readonly activity: ReadonlyMap<string, Activity>;
  start(): Promise<void>;
  pause(): Promise<void>;
}

/** Maps file system errors that need the user's help to a pause reason. */
function fileStopReason(error: unknown): PauseReason | null {
  const name = (error as Error | null)?.name;
  if (name === "QuotaExceededError") return "disk_full";
  if (name === "NotAllowedError" || name === "NotFoundError") return "folder_access";
  return null;
}

/** Creates a queue for one library and backup folder. */
export function createQueue(deps: QueueDeps): QueueControls {
  const { client, root, library, settings, onChange, wait } = deps;
  const controllers = new Set<AbortController>();
  const activity = new Map<string, Activity>();
  // Row actions are locked during a run, so this list cannot change mid-run.
  const ignored = ignoredSet(library);
  let stopping = false;
  let current: Promise<void> | null = null;
  let saving: Promise<void> | null = null;
  let dirty = false;

  /** Coalesces rapid saves while guaranteeing the newest state is written. */
  function save(): Promise<void> {
    dirty = true;
    saving ??= (async () => {
      while (dirty) {
        dirty = false;
        await deps.save(library).catch(() => undefined);
      }
      saving = null;
    })();
    return saving;
  }

  /** Stops new work and aborts active transfers. */
  function stop(reason: PauseReason): void {
    if (library.phase !== "running") return;
    library.phase = "paused";
    library.pauseReason = reason;
    stopping = true;
    for (const controller of controllers) controller.abort();
  }

  /** Resolves, downloads, and saves one release. */
  async function processRelease(release: Release, signal: AbortSignal): Promise<void> {
    activity.set(release.key, { stage: "preparing", done: 0, total: 0 });
    onChange();

    const resolved = await client.resolveDownload(release, settings.formats, signal);
    if (resolved.outcome === "no_format") {
      release.status = "attention";
      release.note = "no_preferred_format";
      return;
    }

    const response = await client.fetchFile(resolved.url, signal);
    if (!response) {
      release.status = "attention";
      release.note = "needs_confirmation";
      return;
    }

    release.kind = resolved.kind;
    const savedAs = await saveRelease({
      root,
      release,
      format: resolved.choice.key,
      response,
      autoUnzip: settings.autoUnzip,
      signal,
      onActivity: (update) => {
        activity.set(release.key, update);
        onChange();
      },
    });

    release.format = resolved.choice.key;
    release.usedFallback = resolved.choice.usedFallback;
    release.status = "done";
    delete release.redownload;
    // A ZIP is only a problem to report when the user asked for unzipped files.
    release.note = savedAs === "zip" && settings.autoUnzip && release.kind === "album"
      ? "kept_zip"
      : null;
  }

  /** Decides what happens to a release after an error. */
  async function handleFailure(release: Release, error: unknown): Promise<void> {
    if (error instanceof QueueStop) {
      release.status = "pending";
      stop(error.reason);
      return;
    }
    if (stopping || (error as Error | null)?.name === "AbortError") {
      release.status = "pending";
      return;
    }
    const stopReason = fileStopReason(error);
    if (stopReason) {
      release.status = "pending";
      stop(stopReason);
      return;
    }

    release.attempts += 1;
    if (release.attempts >= MAX_ATTEMPTS) {
      release.status = "failed";
      release.note = "download_failed";
      return;
    }
    // Damaged downloads and brief network errors both get a delayed retry.
    release.status = "pending";
    await wait(RETRY_DELAY_MS * release.attempts).catch(() => undefined);
  }

  /** Processes releases until the queue is empty or stopped. */
  async function worker(): Promise<void> {
    while (!stopping) {
      const release = library.releases.find(
        (entry) => entry.status === "pending" && !ignored.has(entry.key),
      );
      if (!release) return;

      // Claiming is synchronous, so two workers can never take one release.
      release.status = "active";
      const controller = new AbortController();
      controllers.add(controller);
      await save();

      try {
        await processRelease(release, controller.signal);
      } catch (error) {
        await handleFailure(release, error);
      } finally {
        controllers.delete(controller);
        activity.delete(release.key);
        await save();
        onChange();
      }
    }
  }

  /** Runs all workers and records the outcome. */
  async function run(): Promise<void> {
    library.phase = "running";
    library.pauseReason = null;
    stopping = false;
    await save();
    onChange();

    await Promise.all(Array.from({ length: WORKERS }, worker));

    if (library.phase === "running") {
      await cleanTempFolder(root);
      library.phase = "finished";
    }
    await save();
    onChange();
  }

  return {
    activity,
    start() {
      current ??= run().finally(() => {
        current = null;
      });
      return current;
    },
    async pause() {
      stop("user");
      await current;
    },
  };
}
