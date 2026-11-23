/**
 * spike.js: connects the page to the S3 queue.
 *
 * Purpose:      Prepare, start, pause, resume, and report on the queue.
 * Inputs:       Button clicks and the folder chosen in Chrome's picker.
 * Outputs:      Status text, a progress bar, and a formatted JSON report.
 * Recovery:     On load, saved state is repaired if the tab closed mid-run.
 * Failure mode: Setup errors show a fixed message. Queue errors go in the report.
 */
import { buildReport, createRunner, prepareRun, recoverAfterLoad } from "./spike-core.js";
import { store } from "./store.js";

const statusText = document.querySelector("#status");
const progressBar = document.querySelector("#progress");
const primaryButton = document.querySelector("#primary");
const copyButton = document.querySelector("#copy");
const resetButton = document.querySelector("#reset");
const reportBlock = document.querySelector("#report");

let state;
let folder;
let runner;

/** Parses downloaded HTML without running its scripts or loading its assets. */
const parseHtml = (html) => new DOMParser().parseFromString(html, "text/html");

/** Reads Chrome's JavaScript heap size when that diagnostic is available. */
const heapBytes = () => performance.memory?.usedJSHeapSize ?? 0;

/** Friendly explanations for fixed pause reasons. */
const PAUSE_TEXT = {
  user: "Paused.",
  tab_closed: "The tab closed during the run. Click Resume to continue.",
  rate_limited: "Bandcamp asked us to slow down. Wait a few minutes, then click Resume.",
  client_challenge: "Bandcamp wants a security check. Open bandcamp.com normally, then click Resume.",
};

/** Redraws the page from the current state. */
function render() {
  if (!state) {
    statusText.textContent = "Choose or create an empty folder, such as Music/TOT S3 Test.";
    progressBar.value = 0;
    primaryButton.textContent = "Choose folder and prepare";
    primaryButton.hidden = false;
    copyButton.hidden = true;
    resetButton.hidden = true;
    reportBlock.hidden = true;
    return;
  }

  const report = buildReport(state);
  const finished = report.counts.done + report.counts.attention + report.counts.failed;
  progressBar.max = report.totalItems;
  progressBar.value = finished;

  const progress = `${finished} of ${report.totalItems} albums finished.`;
  const labels = { ready: "Start", running: "Pause", paused: "Resume", finished: "" };
  const messages = {
    ready: `Ready. ${report.totalItems} albums are queued.`,
    running: `Running. ${progress} ${report.counts.active} active.`,
    paused: `${PAUSE_TEXT[state.pauseReason] ?? "Paused."} ${progress}`,
    finished: `Finished: ${report.result}. Copy the report below.`,
  };

  statusText.textContent = messages[state.phase];
  primaryButton.textContent = labels[state.phase];
  primaryButton.hidden = !labels[state.phase];
  resetButton.hidden = state.phase === "running";
  const showReport = state.phase !== "ready" && state.phase !== "running";
  copyButton.hidden = !showReport;
  reportBlock.hidden = !showReport;
  // textContent treats the report as plain text, never as markup.
  if (showReport) reportBlock.textContent = JSON.stringify(report, null, 2);
}

/** Makes sure Chrome still allows writing to the saved folder. */
async function ensureFolderAccess() {
  const options = { mode: "readwrite" };
  if ((await folder.queryPermission(options)) === "granted") return true;
  return (await folder.requestPermission(options)) === "granted";
}

/** Starts the queue without blocking the button handler. */
function startRunner() {
  runner ??= createRunner({
    fetchImpl: (...args) => globalThis.fetch(...args),
    parseHtml,
    root: folder,
    state,
    saveState: store.saveState,
    onUpdate: render,
    heapBytes,
  });
  runner.start().catch(() => {
    statusText.textContent = "The queue stopped unexpectedly. Reload this page to recover.";
  });
}

/** Chooses a folder and builds the queue. */
async function prepare() {
  const chosen = await window.showDirectoryPicker({ id: "thisonetime-s3", mode: "readwrite" });
  statusText.textContent = "Finding your 50 shortest albums...";
  const prepared = await prepareRun({
    fetchImpl: (...args) => globalThis.fetch(...args),
    parseHtml,
  });
  await store.saveHandle(chosen);
  await store.saveState(prepared);
  folder = chosen;
  state = prepared;
}

primaryButton.addEventListener("click", async () => {
  primaryButton.disabled = true;
  try {
    if (!state) {
      await prepare();
    } else if (state.phase === "running") {
      await runner.pause();
    } else {
      if (await ensureFolderAccess()) startRunner();
      else statusText.textContent = "Chrome needs folder access to continue.";
    }
    if (state?.phase !== "running") render();
  } catch (error) {
    if (error?.name !== "AbortError") {
      statusText.textContent = `Could not continue (${error?.code ?? error?.name ?? "error"}).`;
    } else {
      render();
    }
  } finally {
    primaryButton.disabled = false;
  }
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(reportBlock.textContent);
  statusText.textContent = "Report copied.";
});

resetButton.addEventListener("click", async () => {
  await store.clear();
  state = undefined;
  folder = undefined;
  runner = undefined;
  render();
});

/**
 * Claims the queue for this tab until the tab closes.
 *
 * Without this, a second tab would mistake a healthy run for a closed tab and
 * could process the same albums. Chrome releases the lock when the tab closes.
 */
const ownsQueue = await new Promise((resolve) => {
  navigator.locks.request("thisonetime-s3-queue", { ifAvailable: true }, (lock) => {
    resolve(Boolean(lock));
    return lock ? new Promise(() => {}) : undefined;
  });
});

if (ownsQueue) {
  state = await store.loadState();
  folder = await store.loadHandle();
  if (state && recoverAfterLoad(state)) await store.saveState(state);
  render();
} else {
  statusText.textContent = "The test is already open in another tab. Use that tab.";
  progressBar.hidden = true;
}
