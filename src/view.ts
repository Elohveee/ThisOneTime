/**
 * view.ts: draws the interface from the current app state.
 *
 * Purpose:  Keep all display decisions in one place.
 * Inputs:   An `AppState` object and references to page elements.
 * Outputs:  DOM updates only. It never changes app state or does network work.
 * Safety:   Bandcamp text is inserted with `textContent`, never `innerHTML`.
 * Lists:    Release rows are drawn by view-releases.ts, and format rows by
 *           view-lists.ts.
 */
import { FORMAT_LABELS } from "./formats.js";
import { summarize, type LibrarySummary } from "./library.js";
import type { Activity, Library, PauseReason, Settings } from "./types.js";
import { renderReleases } from "./view-releases.js";

export { renderFormats } from "./view-lists.js";

export type ReleaseFilter = "all" | "active" | "attention" | "ignored";
export type PrimaryActionId =
  | "none"
  | "login"
  | "scan"
  | "choose-folder"
  | "reconnect"
  | "start"
  | "pause"
  | "retry";

export interface AppState {
  stage: "loading" | "logged_out" | "scanning" | "ready" | "error" | "other_tab";
  username: string | null;
  settings: Settings;
  library: Library | null;
  folder: FileSystemDirectoryHandle | null;
  folderAccess: PermissionState | "none";
  scanCount: number;
  filter: ReleaseFilter;
  /** Text in the search box. Not saved between visits. */
  search: string;
  /** The requested list page, starting at 1. Not saved between visits. */
  page: number;
  activity: ReadonlyMap<string, Activity>;
  notice: string | null;
}

export interface Elements {
  account: HTMLElement;
  status: HTMLElement;
  progress: HTMLProgressElement;
  progressCount: HTMLElement;
  summary: HTMLElement;
  primary: HTMLButtonElement;
  settings: HTMLFieldSetElement;
  folderName: HTMLElement;
  chooseFolder: HTMLButtonElement;
  formats: HTMLOListElement;
  autoUnzip: HTMLInputElement;
  includeHidden: HTMLInputElement;
  filters: HTMLElement;
  search: HTMLInputElement;
  releases: HTMLUListElement;
  listNote: HTMLElement;
  pager: HTMLElement;
  pagePrevious: HTMLButtonElement;
  pageNext: HTMLButtonElement;
  pageText: HTMLElement;
}

const PAUSE_TEXT: Record<PauseReason, string> = {
  user: "Paused.",
  tab_closed: "The tab closed during the backup. Your progress is saved.",
  rate_limited: "Bandcamp asked us to slow down. Wait a few minutes, then resume.",
  client_challenge: "Bandcamp wants a security check. Open bandcamp.com, complete it, then resume.",
  logged_out: "You were logged out of Bandcamp. Log in, then resume.",
  disk_full: "Your disk is full. Free up space, then resume.",
  folder_access: "The backup folder is unavailable. Reconnect or choose it again.",
};

/** Chooses the single main action for the current state. */
export function getPrimaryAction(
  state: AppState,
  summary: LibrarySummary = summarize(state.library),
): { id: PrimaryActionId; label: string; disabled: boolean } {
  const action = (id: PrimaryActionId, label: string, disabled = false) => ({ id, label, disabled });
  if (state.stage === "other_tab") return action("none", "Open in another tab", true);
  if (state.stage === "logged_out") return action("login", "Log in to Bandcamp");
  if (state.stage === "error") return action("scan", "Try again");
  if (state.stage !== "ready") return action("none", "Scanning...", true);
  if (state.library?.phase === "running") return action("pause", "Pause");
  if (!state.folder) return action("choose-folder", "Choose backup folder");
  if (state.folderAccess !== "granted") return action("reconnect", "Reconnect folder");

  const canDownload = state.settings.formats.some((format) => format.enabled);
  if (summary.counts.pending > 0) {
    const onlyRedownloads = summary.redownloads === summary.counts.pending;
    const label = state.library?.phase === "paused"
      ? "Resume"
      : onlyRedownloads
        ? `Redownload ${summary.redownloads}`
        : "Download library";
    return action("start", label, !canDownload);
  }
  if (summary.counts.failed + summary.counts.attention > 0) {
    return action("retry", "Retry failed", !canDownload);
  }
  return action("none", summary.downloadable ? "Up to date" : "Nothing to download", true);
}

/** Builds the main status sentence. */
function statusText(state: AppState, summary: LibrarySummary): string {
  if (state.notice) return state.notice;
  if (state.stage === "other_tab") return "ThisOneTime is already open in another tab. Use that tab.";
  if (state.stage === "loading") return "Checking your Bandcamp session...";
  if (state.stage === "logged_out") return "Log in to Bandcamp in this browser to begin.";
  if (state.stage === "scanning") return `Scanning your collection: ${state.scanCount} found.`;
  if (state.stage === "error") return "Could not read your Bandcamp collection.";

  const library = state.library;
  if (library?.phase === "running") return `Backing up: ${summary.counts.active} active.`;
  if (library?.phase === "paused") return PAUSE_TEXT[library.pauseReason ?? "user"];
  if (!state.settings.formats.some((format) => format.enabled)) return "Enable at least one format.";
  if (summary.redownloads && summary.redownloads === summary.counts.pending) {
    const count = summary.redownloads;
    return `${count} release${count === 1 ? "" : "s"} queued to redownload.`;
  }
  if (summary.counts.pending === 1) return "1 release ready to back up.";
  if (summary.counts.pending > 1) return `${summary.counts.pending} releases ready to back up.`;
  if (summary.counts.failed + summary.counts.attention > 0) return "Finished. Some releases need attention.";
  if (summary.downloadable) return "Your library is backed up.";
  return summary.ignored ? "Every release is ignored." : "No downloadable purchases found.";
}

/** Builds the completed-run summary. */
function summaryText(summary: LibrarySummary): string {
  const formats = Object.entries(summary.byFormat)
    .map(([key, count]) => `${count} ${FORMAT_LABELS[key as keyof typeof FORMAT_LABELS]}`)
    .join(", ");
  const parts = [formats];
  if (summary.fallbacks) parts.push(`${summary.fallbacks} used a fallback format`);
  if (summary.keptZips) parts.push(`${summary.keptZips} kept as ZIP`);
  if (summary.counts.preorder) {
    parts.push(`${summary.counts.preorder} pre-order${summary.counts.preorder === 1 ? "" : "s"}`);
  }
  if (summary.counts.unavailable) parts.push(`${summary.counts.unavailable} not downloadable`);
  if (summary.ignored) parts.push(`${summary.ignored} ignored`);
  return parts.filter(Boolean).join(" · ");
}

/** Redraws everything except the format rows. */
export function renderApp(el: Elements, state: AppState): void {
  const summary = summarize(state.library);
  const primary = getPrimaryAction(state, summary);

  el.account.textContent = state.username ? `Signed in as ${state.username}` : "";
  el.status.textContent = statusText(state, summary);
  el.progress.max = Math.max(summary.downloadable, 1);
  el.progress.value = summary.finished;
  el.progressCount.textContent = summary.downloadable
    ? `${summary.finished} of ${summary.downloadable}`
    : "";
  el.summary.textContent = summaryText(summary);
  el.summary.hidden = !el.summary.textContent;

  el.primary.textContent = primary.label;
  el.primary.disabled = primary.disabled;
  el.primary.dataset.action = primary.id;

  el.settings.disabled =
    state.library?.phase === "running" || state.stage === "scanning" || state.stage === "other_tab";
  el.folderName.textContent = state.folder ? state.folder.name : "No folder chosen";
  el.chooseFolder.textContent = state.folder ? "Change folder" : "Choose folder";
  el.autoUnzip.checked = state.settings.autoUnzip;
  el.includeHidden.checked = state.settings.includeHidden;

  for (const button of el.filters.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.filter === state.filter));
  }
  renderReleases(el, state);
}
