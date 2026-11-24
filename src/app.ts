/**
 * app.ts: the controller for the ThisOneTime tab.
 *
 * Purpose:  Connect clicks to the library, queue, storage, and view.
 * Startup:  1. Claim the single-tab lock.
 *           2. Load settings and the saved folder.
 *           3. Detect the Bandcamp fan and recover any interrupted run.
 *           4. Scan for new purchases.
 * Hidden:   A worker timer, the held lock, and disabled tab discarding help
 *           long backups continue while the tab is in the background.
 * Failure:  Problems appear as status text. Saved progress is never discarded.
 */
import { createBandcampClient, QueueStop, type Fan } from "./bandcamp.js";
import { getElements } from "./dom.js";
import { folderAccess, requestFolderAccess } from "./files.js";
import { moveFormat } from "./formats.js";
import { createLibrary, mergeScan, recoverInterrupted, retryProblems } from "./library.js";
import { connectReleaseList } from "./list-controls.js";
import { createQueue, type QueueControls } from "./queue.js";
import { loadFolder, loadLibrary, loadSettings, saveFolder, saveLibrary, saveSettings } from "./storage.js";
import { claimTab, preventTabDiscard } from "./tab.js";
import { createWorkerWait } from "./timer.js";
import type { FormatKey } from "./types.js";
import { renderApp, renderFormats, type AppState } from "./view.js";

const elements = getElements();
const wait = createWorkerWait();
const client = createBandcampClient({
  fetchImpl: (input, init) => globalThis.fetch(input, init),
  // DOMParser builds an inert document that cannot run scripts or load assets.
  parseHtml: (html) => new DOMParser().parseFromString(html, "text/html"),
  wait,
});

const state: AppState = {
  stage: "loading",
  username: null,
  settings: { formats: [], autoUnzip: true, includeHidden: false },
  library: null,
  folder: null,
  folderAccess: "none",
  scanCount: 0,
  filter: "all",
  search: "",
  page: 1,
  activity: new Map(),
  notice: null,
};

let fan: Fan | null = null;
let queue: QueueControls | null = null;
let renderTimer: ReturnType<typeof setTimeout> | null = null;

const render = (): void => renderApp(elements, state);

/** Limits redraws during fast download progress. */
function scheduleRender(): void {
  renderTimer ??= setTimeout(() => {
    renderTimer = null;
    render();
  }, 200);
}

/** Scans Bandcamp and merges the results with saved progress. */
async function scan(): Promise<void> {
  if (!fan) return;
  const hasSavedLibrary = Boolean(state.library?.releases.length);
  state.stage = "scanning";
  state.scanCount = 0;
  state.notice = null;
  render();

  try {
    const scanned = await client.scanLibrary(fan.fanId, state.settings.includeHidden, (count) => {
      state.scanCount = count;
      scheduleRender();
    });
    state.library ??= createLibrary(fan.fanId);
    mergeScan(state.library, scanned);
    await saveLibrary(state.library);
    state.stage = "ready";
  } catch (error) {
    state.stage = hasSavedLibrary ? "ready" : "error";
    state.notice =
      error instanceof QueueStop && error.reason === "client_challenge"
        ? "Bandcamp wants a security check. Open bandcamp.com, complete it, then reload this page."
        : hasSavedLibrary
          ? "Could not check for new purchases. Showing your saved library."
          : null;
  }
  render();
}

/** Starts or resumes the queue. */
function startQueue(): void {
  if (!state.library || !state.folder) return;
  const folder = state.folder;
  state.notice = null;
  queue = createQueue({
    client,
    root: folder,
    library: state.library,
    settings: state.settings,
    save: saveLibrary,
    onChange: scheduleRender,
    wait,
  });
  state.activity = queue.activity;
  void queue.start().finally(async () => {
    // A run can stop because access was revoked, so show Reconnect if needed.
    state.folderAccess = await folderAccess(folder).catch(() => "prompt" as const);
    render();
  });
}

/** Opens Chrome's folder picker and saves the choice. */
async function chooseFolder(): Promise<void> {
  try {
    const folder = await window.showDirectoryPicker({ id: "thisonetime", mode: "readwrite" });
    await saveFolder(folder);
    state.folder = folder;
    state.folderAccess = await folderAccess(folder);
    state.notice = null;
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      state.notice = "Chrome refused that folder. Try a subfolder inside Music.";
    }
  }
  render();
}

/** Restores folder access, then continues a paused backup. */
async function reconnect(): Promise<void> {
  if (!state.folder) return;
  try {
    state.folderAccess = await requestFolderAccess(state.folder);
  } catch {
    state.folderAccess = "prompt";
    state.notice = "The folder could not be reopened. Choose it again.";
  }
  if (state.folderAccess === "granted" && state.library?.phase === "paused") startQueue();
  render();
}

/** Saves settings after a change. */
async function updateSettings(): Promise<void> {
  await saveSettings(state.settings);
  render();
}

elements.primary.addEventListener("click", () => {
  const action = elements.primary.dataset.action;
  if (action === "login") void chrome.tabs.create({ url: "https://bandcamp.com/login" });
  if (action === "scan") void boot();
  if (action === "choose-folder") void chooseFolder();
  if (action === "reconnect") void reconnect();
  if (action === "start") startQueue();
  if (action === "pause") void queue?.pause().then(render);
  if (action === "retry" && state.library) {
    retryProblems(state.library);
    startQueue();
  }
});

elements.chooseFolder.addEventListener("click", () => void chooseFolder());

elements.autoUnzip.addEventListener("change", () => {
  state.settings.autoUnzip = elements.autoUnzip.checked;
  void updateSettings();
});

elements.includeHidden.addEventListener("change", () => {
  state.settings.includeHidden = elements.includeHidden.checked;
  void updateSettings().then(scan);
});

elements.formats.addEventListener("change", (event) => {
  const key = (event.target as HTMLElement).dataset.toggle;
  const format = state.settings.formats.find((entry) => entry.key === key);
  if (!format) return;
  format.enabled = (event.target as HTMLInputElement).checked;
  renderFormats(elements, state.settings);
  elements.formats.querySelector<HTMLElement>(`[data-toggle="${format.key}"]`)?.focus();
  void updateSettings();
});

elements.formats.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-move]");
  if (!button) return;
  const key = button.dataset.key as FormatKey;
  const direction = button.dataset.move as "up" | "down";
  state.settings.formats = moveFormat(state.settings.formats, key, direction === "up" ? -1 : 1);
  renderFormats(elements, state.settings);
  // Keep keyboard focus on the moved format, using the other arrow at a list edge.
  const buttons = [...elements.formats.querySelectorAll<HTMLButtonElement>(`[data-key="${key}"]:not(:disabled)`)];
  (buttons.find((candidate) => candidate.dataset.move === direction) ?? buttons[0])?.focus();
  void updateSettings();
});

connectReleaseList(elements, state, render);

/** Loads saved data, finds the fan, and scans for purchases. */
async function boot(): Promise<void> {
  state.stage = "loading";
  state.notice = null;
  render();
  try {
    fan = await client.getFan();
  } catch (error) {
    state.stage = "error";
    if (error instanceof QueueStop && error.reason === "client_challenge") {
      state.notice = "Bandcamp wants a security check. Open bandcamp.com, complete it, then try again.";
    }
    render();
    return;
  }
  if (!fan) {
    state.stage = "logged_out";
    render();
    return;
  }

  state.username = fan.username;
  state.library = (await loadLibrary(fan.fanId)) ?? state.library;
  if (state.library && recoverInterrupted(state.library)) await saveLibrary(state.library);
  await scan();
}

if (await claimTab()) {
  state.settings = await loadSettings();
  state.folder = (await loadFolder()) ?? null;
  if (state.folder) state.folderAccess = await folderAccess(state.folder);
  renderFormats(elements, state.settings);

  await preventTabDiscard();
  await boot();
} else {
  state.stage = "other_tab";
  renderFormats(elements, state.settings);
  render();
}
