/**
 * spike-core.js: the Spike S3 download queue.
 *
 * Question:  Does a long backup stay healthy through concurrency, pause, a
 *            closed tab, and resume?
 *
 * Flow:      1. prepareRun picks the 50 shortest multi-track albums.
 *            2. createRunner processes them with three workers.
 *            3. Every status change is saved before work continues.
 *            4. recoverAfterLoad returns interrupted albums to the queue.
 *            5. buildReport evaluates the run.
 *
 * Item path: pending -> active -> done, attention, or failed.
 *            Pausing or closing the tab returns active albums to pending.
 *
 * Inputs:    Browser functions are injected, so this runs outside Chrome too.
 * Privacy:   Reports contain only counts, booleans, rounded sizes, and fixed
 *            codes. They never contain names, titles, IDs, tokens, or URLs.
 * Safety:    Writes only inside `ThisOneTime S3 Test`, and deletes only its own
 *            temporary files. A client challenge or rate limit pauses the queue
 *            for the user. It is never solved, bypassed, or retried around.
 * Caution:   These Bandcamp endpoints are undocumented and may change.
 */
import { crc32OfBlob, extractEntry, readEntries, safeName, ZipError } from "./zip.js";

const HOME_URL = "https://bandcamp.com/";
const COLLECTION_URL = "https://bandcamp.com/api/fancollection/1/collection_items";
const TEST_FOLDER = "ThisOneTime S3 Test";
const TEMP_FOLDER = ".thisonetime-tmp";

const TARGET_ITEMS = 50;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const WORKERS = 3;
const REQUEST_GAP_MS = 700;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

/** Limits that keep this test bounded on any library. */
const MAX_ZIP_BYTES = 500 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024 * 1024;

/** Smallest-first on purpose, because S3 tests queue health, not audio quality. */
const TEST_FORMAT_ORDER = ["mp3-v0", "mp3-320", "vorbis", "aac-hi", "flac", "alac"];

/** A condition that must pause the whole queue for the user. */
class QueueStop extends Error {
  /** @param {string} code A fixed reason code. */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** A temporary failure that may succeed on another attempt. */
class RetryableError extends Error {
  /** @param {string} code A fixed reason code. */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toMb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Accepts only HTTPS URLs on Bandcamp's own hosts or its file CDN. */
function isTrustedUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return (
      url.protocol === "https:" &&
      (host === "bandcamp.com" ||
        host.endsWith(".bandcamp.com") ||
        host.endsWith(".bcbits.com"))
    );
  } catch {
    return false;
  }
}

/** Bandcamp's client challenge page, detected so the queue can pause. */
const isChallenge = (text) => text.includes("Client Challenge") && text.includes("_fs-ch-");

/** Reads and parses a JSON `data-blob` attribute, returning null if invalid. */
function readBlob(doc, id) {
  const raw = doc.getElementById(id)?.getAttribute("data-blob");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Creates the zeroed counters for a new run. */
function createMetrics() {
  return {
    starts: 0,
    resumes: 0,
    pauses: 0,
    tabInterruptions: 0,
    interruptedItems: 0,
    retries: 0,
    requests: 0,
    rateLimitStops: 0,
    challengeStops: 0,
    bytesDownloaded: 0,
    completedZipBytes: 0,
    bytesExtracted: 0,
    filesVerified: 0,
    activeMs: 0,
    maxConcurrent: 0,
    peakHeapBytes: 0,
    staleTempFilesRemoved: 0,
    unexpectedTempFiles: 0,
  };
}

/**
 * Finds the logged-in fan and builds a queue of short albums.
 *
 * @returns {Promise<object>} A new persistent run state.
 */
export async function prepareRun({ fetchImpl, parseHtml, wait = sleep }) {
  const get = async (url, options = {}) => {
    await wait(REQUEST_GAP_MS);
    const response = await fetchImpl(url, { credentials: "include", ...options });
    if (response.status === 429) throw new QueueStop("rate_limited");
    const text = await response.text();
    if (isChallenge(text)) throw new QueueStop("client_challenge");
    return { response, text };
  };

  const home = await get(HOME_URL);
  const fanId = readBlob(parseHtml(home.text), "HomepageApp")?.pageContext?.identity?.fanId;
  if (!Number.isInteger(fanId) || fanId <= 0) throw new QueueStop("not_logged_in");

  const found = new Map();
  let token = `${Math.floor(Date.now() / 1000)}:0:a::`;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const { response, text } = await get(COLLECTION_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fan_id: fanId, count: PAGE_SIZE, older_than_token: token }),
    });
    if (!response.ok) throw new QueueStop(`collection_http_${response.status}`);
    const page = JSON.parse(text);
    if (!Array.isArray(page.items)) throw new QueueStop("collection_response_invalid");

    for (const item of page.items) {
      const key = `${item.sale_item_type}${item.sale_item_id}`;
      const url = page.redownload_urls?.[key];
      const isTrack = item.tralbum_type === "t" || item.item_type === "track";
      if (isTrack || item.is_preorder === true || item.download_available === false) continue;
      if (!isTrustedUrl(url) || !(item.num_streamable_tracks >= 2)) continue;
      // Keep only what the queue needs. Page data also holds gift details.
      found.set(key, {
        key,
        itemId: item.item_id,
        url,
        artist: item.band_name,
        title: item.item_title,
        trackCount: item.num_streamable_tracks,
        status: "pending",
        attempts: 0,
        completions: 0,
        failure: null,
        keptZip: false,
      });
    }
    if (page.more_available !== true || !page.last_token || page.last_token === token) break;
    token = page.last_token;
  }

  const items = [...found.values()]
    .sort((a, b) => a.trackCount - b.trackCount)
    .slice(0, TARGET_ITEMS);
  if (!items.length) throw new QueueStop("no_eligible_album");
  return { version: 1, phase: "ready", pauseReason: null, items, metrics: createMetrics() };
}

/**
 * Repairs saved state after the page loads.
 *
 * A saved `running` phase means the tab disappeared without pausing. Active
 * albums go back to pending because their transfers no longer exist.
 *
 * @returns {boolean} True when an interruption was recovered.
 */
export function recoverAfterLoad(state) {
  if (state.phase !== "running") return false;
  const active = state.items.filter((item) => item.status === "active");
  for (const item of active) item.status = "pending";
  state.metrics.tabInterruptions += 1;
  state.metrics.interruptedItems += active.length;
  state.phase = "paused";
  state.pauseReason = "tab_closed";
  return true;
}

/**
 * Creates a queue runner for one page lifetime.
 *
 * @param {object} deps Injected browser functions and persistent state.
 * @returns {{start: () => Promise<void>, pause: () => Promise<void>}}
 */
export function createRunner({
  fetchImpl,
  parseHtml,
  root,
  state,
  saveState,
  onUpdate = () => {},
  wait = sleep,
  heapBytes = () => 0,
}) {
  const controllers = new Set();
  const { metrics } = state;
  let stopping = false;
  let active = 0;
  let current = null;
  let requestGate = Promise.resolve();
  let saving = Promise.resolve();

  /** Saves in order, so an older snapshot can never overwrite a newer one. */
  function save() {
    saving = saving.catch(() => {}).then(() => saveState(state));
    return saving;
  }

  /** Spaces requests across all workers. */
  function nextRequestSlot() {
    requestGate = requestGate.then(() => wait(REQUEST_GAP_MS));
    return requestGate;
  }

  /** Performs one paced request and pauses the queue on a rate limit. */
  async function request(url, signal, options = {}) {
    await nextRequestSlot();
    signal.throwIfAborted();
    metrics.requests += 1;
    const response = await fetchImpl(url, { credentials: "include", ...options, signal });
    if (response.status === 429) {
      await response.body?.cancel();
      throw new QueueStop("rate_limited");
    }
    return response;
  }

  /** Streams a download to a temporary file. A failed pipe commits nothing. */
  async function streamToTemp(folder, name, response, signal) {
    const handle = await folder.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    let bytes = 0;
    const counter = new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        metrics.bytesDownloaded += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    await response.body.pipeThrough(counter).pipeTo(writable, { signal });
    return { handle, bytes };
  }

  /** Marks an album for the user without counting it as a queue failure. */
  function needsAttention(item, failure) {
    item.status = "attention";
    item.failure = failure;
  }

  /** Downloads, extracts, verifies, and finishes one album. */
  async function processItem(item, signal) {
    const pageResponse = await request(item.url, signal);
    const pageText = await pageResponse.text();
    if (isChallenge(pageText)) throw new QueueStop("client_challenge");
    if (!pageResponse.ok) throw new RetryableError(`page_http_${pageResponse.status}`);

    const blob = readBlob(parseHtml(pageText), "pagedata");
    const digitalItems = Array.isArray(blob?.digital_items) ? blob.digital_items : [];
    const digital =
      digitalItems.find((entry) => String(entry.item_id) === String(item.itemId)) ??
      (digitalItems.length === 1 ? digitalItems[0] : null);
    const downloads = digital?.downloads ?? {};
    const format = TEST_FORMAT_ORDER.find((key) => isTrustedUrl(downloads[key]?.url));
    if (!format) return needsAttention(item, "no_format");

    const response = await request(downloads[format].url, signal);
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new RetryableError(`file_http_${response.status}`);
    }
    if (contentType.includes("html")) {
      await response.body.cancel();
      return needsAttention(item, "needs_confirmation");
    }

    const expected = Number(response.headers.get("content-length")) || 0;
    const limitFailure = !expected
      ? "missing_size"
      : expected > MAX_ZIP_BYTES
        ? "over_album_limit"
        : metrics.completedZipBytes + expected > MAX_TOTAL_BYTES
          ? "over_total_limit"
          : null;
    if (limitFailure) {
      await response.body.cancel();
      return needsAttention(item, limitFailure);
    }

    const testFolder = await root.getDirectoryHandle(TEST_FOLDER, { create: true });
    const tempFolder = await testFolder.getDirectoryHandle(TEMP_FOLDER, { create: true });
    const tempName = `${safeName(item.key)}.zip`;
    const { handle, bytes } = await streamToTemp(tempFolder, tempName, response, signal);
    if (bytes !== expected) throw new RetryableError("download_size_mismatch");

    try {
      const zipFile = await handle.getFile();
      const entries = await readEntries(zipFile);
      const artistFolder = await testFolder.getDirectoryHandle(safeName(item.artist), {
        create: true,
      });
      // The key prevents two same-named releases from sharing a folder.
      const albumName = `${safeName(item.title, 100)} [${safeName(item.key)}]`;
      const albumFolder = await artistFolder.getDirectoryHandle(albumName, { create: true });
      let verified = 0;
      let extracted = 0;

      for (const entry of entries) {
        signal.throwIfAborted();
        const output = await albumFolder.getFileHandle(entry.outputName, { create: true });
        extracted += (await extractEntry(zipFile, entry, await output.createWritable())).bytes;
        const saved = await output.getFile();
        if (saved.size !== entry.uncompressedSize || (await crc32OfBlob(saved)) !== entry.crc) {
          throw new ZipError("read_back_mismatch");
        }
        verified += 1;
      }

      await tempFolder.removeEntry(tempName);
      metrics.completedZipBytes += expected;
      metrics.bytesExtracted += extracted;
      metrics.filesVerified += verified;
      item.completions += 1;
      item.status = "done";
      item.failure = null;
    } catch (error) {
      if (error instanceof ZipError) {
        item.keptZip = true;
        return needsAttention(item, error.code);
      }
      throw error;
    }
    return undefined;
  }

  /** Stops new work and aborts active transfers. */
  function stop(reason) {
    if (state.phase !== "running") return;
    state.phase = "paused";
    state.pauseReason = reason;
    stopping = true;
    for (const controller of controllers) controller.abort();
  }

  /** Decides what happens to an album after an error. */
  async function handleFailure(item, error) {
    if (error instanceof QueueStop) {
      item.status = "pending";
      if (error.code === "rate_limited") metrics.rateLimitStops += 1;
      if (error.code === "client_challenge") metrics.challengeStops += 1;
      stop(error.code);
      return;
    }
    if (stopping || error?.name === "AbortError") {
      item.status = "pending";
      return;
    }

    item.attempts += 1;
    // Error messages can include paths, so only fixed codes and names are saved.
    item.failure = error instanceof RetryableError ? error.code : `unexpected_${error?.name}`;
    if (item.attempts >= MAX_ATTEMPTS) {
      item.status = "failed";
      return;
    }
    metrics.retries += 1;
    item.status = "pending";
    await wait(RETRY_DELAY_MS * item.attempts);
  }

  /** Processes albums until the queue is empty or stopped. */
  async function worker() {
    while (!stopping) {
      const item = state.items.find((entry) => entry.status === "pending");
      if (!item) return;

      // Claiming happens synchronously, so two workers cannot take one album.
      item.status = "active";
      active += 1;
      metrics.maxConcurrent = Math.max(metrics.maxConcurrent, active);
      const controller = new AbortController();
      controllers.add(controller);
      await save();
      onUpdate();

      try {
        await processItem(item, controller.signal);
      } catch (error) {
        await handleFailure(item, error);
      } finally {
        active -= 1;
        controllers.delete(controller);
        metrics.peakHeapBytes = Math.max(metrics.peakHeapBytes, heapBytes() || 0);
        await save();
        onUpdate();
      }
    }
  }

  /** Removes stale temporary files after all albums are finished. */
  async function cleanTemp() {
    let testFolder;
    let tempFolder;
    try {
      testFolder = await root.getDirectoryHandle(TEST_FOLDER);
      tempFolder = await testFolder.getDirectoryHandle(TEMP_FOLDER);
    } catch {
      return;
    }

    const kept = new Set(
      state.items.filter((item) => item.keptZip).map((item) => `${safeName(item.key)}.zip`),
    );
    const names = [];
    for await (const [name] of tempFolder.entries()) names.push(name);
    for (const name of names) {
      if (kept.has(name)) continue;
      try {
        await tempFolder.removeEntry(name);
        metrics.staleTempFilesRemoved += 1;
      } catch {
        metrics.unexpectedTempFiles += 1;
      }
    }
    // This succeeds only when empty, so any kept ZIP is left in place.
    await testFolder.removeEntry(TEMP_FOLDER).catch(() => {});
  }

  /** Runs the workers and records the result. */
  async function run() {
    const startedAt = Date.now();
    if (metrics.starts > 0) metrics.resumes += 1;
    metrics.starts += 1;
    state.phase = "running";
    state.pauseReason = null;
    stopping = false;
    await save();
    onUpdate();

    await Promise.all(Array.from({ length: WORKERS }, worker));
    metrics.activeMs += Date.now() - startedAt;

    if (state.phase === "running") {
      await cleanTemp();
      state.phase = "finished";
    }
    await save();
    onUpdate();
  }

  return {
    /** Starts or resumes the queue. A second call joins the current run. */
    start() {
      current ??= run().finally(() => {
        current = null;
      });
      return current;
    },
    /** Pauses the queue and waits for active work to return to pending. */
    async pause() {
      if (state.phase !== "running") return;
      metrics.pauses += 1;
      stop("user");
      await current;
    },
  };
}

/** Builds the privacy-safe report from saved state. */
export function buildReport(state) {
  const { metrics, items } = state;
  const counts = { pending: 0, active: 0, done: 0, attention: 0, failed: 0 };
  const attentionReasons = {};
  const failureReasons = {};
  for (const item of items) {
    counts[item.status] += 1;
    if (item.status === "attention") {
      attentionReasons[item.failure] = (attentionReasons[item.failure] ?? 0) + 1;
    }
    if (item.status === "failed") {
      failureReasons[item.failure] = (failureReasons[item.failure] ?? 0) + 1;
    }
  }

  const checks = {
    pausedAndResumed: metrics.pauses >= 1 && metrics.resumes >= 1,
    survivedTabClose: metrics.tabInterruptions >= 1 && metrics.interruptedItems >= 1,
    noDuplicateCompletions: items.every((item) => item.completions <= 1),
    concurrencyHeldAtThree: metrics.maxConcurrent === WORKERS,
    noUnexpectedTempFiles: metrics.unexpectedTempFiles === 0,
  };

  let result = "in_progress";
  if (state.phase === "finished") {
    if (counts.failed) result = "fail";
    else if (counts.attention || !Object.values(checks).every(Boolean)) result = "partial";
    else result = "pass";
  } else if (["rate_limited", "client_challenge"].includes(state.pauseReason)) {
    result = "blocked";
  }

  const seconds = Math.max(metrics.activeMs / 1000, 0.001);
  return {
    spike: "S3",
    version: 1,
    result,
    phase: state.phase,
    pauseReason: state.pauseReason,
    totalItems: items.length,
    counts,
    attentionReasons,
    failureReasons,
    checks,
    metrics: {
      starts: metrics.starts,
      resumes: metrics.resumes,
      pauses: metrics.pauses,
      tabInterruptions: metrics.tabInterruptions,
      interruptedItems: metrics.interruptedItems,
      retries: metrics.retries,
      requests: metrics.requests,
      rateLimitStops: metrics.rateLimitStops,
      challengeStops: metrics.challengeStops,
      downloadedMb: toMb(metrics.bytesDownloaded),
      completedZipMb: toMb(metrics.completedZipBytes),
      extractedMb: toMb(metrics.bytesExtracted),
      filesVerified: metrics.filesVerified,
      activeMinutes: Math.round((seconds / 60) * 10) / 10,
      averageMbPerSecond: toMb(metrics.bytesDownloaded / seconds),
      maxConcurrent: metrics.maxConcurrent,
      peakHeapMb: toMb(metrics.peakHeapBytes),
      staleTempFilesRemoved: metrics.staleTempFilesRemoved,
      unexpectedTempFiles: metrics.unexpectedTempFiles,
    },
  };
}
