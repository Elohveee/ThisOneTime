/**
 * spike-core.js: the Spike S5 test flow.
 *
 * Question:  Can the dependency-free ZIP reader correctly unpack real Bandcamp
 *            albums, including a large lossless album?
 *
 * Flow:      1. Read the logged-in fan.
 *            2. Scan the collection for albums with two or more tracks.
 *            3. Pick the longest album in FLAC that fits the test limit. Short
 *               and medium albums already passed in version 1 of this report.
 *               Oversized albums are not downloaded. A tiny byte-range request
 *               reads the end of each one to learn whether it uses ZIP64.
 *            4. Stream each ZIP to a temporary file.
 *            5. Extract every entry, verifying size and CRC-32 while writing.
 *            6. Read every saved file back and verify its CRC-32 again.
 *            7. Delete the temporary ZIP only after every file passes.
 *
 * Inputs:    fetchImpl, parseHtml, root folder handle, onProgress, and an
 *            optional wait function. Injecting them allows rehearsal outside
 *            Chrome.
 * Output:    A report that always resolves, even when a step fails.
 *
 * Privacy:   The report may contain only counts, booleans, rounded sizes,
 *            allowlisted file types, and fixed reason codes. It must never
 *            contain names, titles, IDs, tokens, URLs, or file paths.
 *
 * Safety:    Writes only inside `ThisOneTime S5 Test`, and deletes only its own
 *            temporary ZIPs. If Bandcamp shows a client challenge or rate
 *            limit, the test stops and never works around it.
 *
 * Caution:   These Bandcamp endpoints are undocumented and may change.
 */
import { crc32OfBlob, extractEntry, readEntries, safeName, ZipError } from "./zip.js";

const HOME_URL = "https://bandcamp.com/";
const COLLECTION_URL = "https://bandcamp.com/api/fancollection/1/collection_items";
const TEST_FOLDER = "ThisOneTime S5 Test";
const TEMP_FOLDER = ".thisonetime-tmp";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const REQUEST_GAP_MS = 700;

/** Candidates to try before giving up. Long albums are often oversized. */
const MAX_TRIES = 12;

/** The groups this version tests. */
const TEST_GROUPS = ["long"];

/** Download limits that keep the test bounded on any library. */
const MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/** Enough bytes to hold a comment-free EOCD and the ZIP64 locator before it. */
const ZIP_END_PROBE_BYTES = 128;
const EOCD_SIZE = 22;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;

/** File types that may appear in the report. Others count as `other`. */
const REPORTABLE_TYPES = new Set(["flac", "jpg", "jpeg", "png", "gif", "txt", "pdf"]);

/** A controlled stop with a safe, predefined reason code. */
class SpikeStop extends Error {
  /**
   * @param {"fail"|"blocked"} result Whether the flow failed or was blocked.
   * @param {string} reason A fixed reason code that holds no response data.
   */
  constructor(result, reason) {
    super(reason);
    this.result = result;
    this.reason = reason;
  }
}

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

/** Bandcamp's client challenge page, detected so the test can stop politely. */
function isChallenge(text) {
  return text.includes("Client Challenge") && text.includes("_fs-ch-");
}

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

/** Creates a request helper that paces calls and stops on 429 responses. */
function createRequester(fetchImpl, wait) {
  return async function request(url, options = {}) {
    await wait(REQUEST_GAP_MS);
    const response = await fetchImpl(url, { credentials: "include", ...options });
    if (response.status === 429) throw new SpikeStop("blocked", "rate_limited");
    return response;
  };
}

/** Fetches text and stops immediately if Bandcamp returned a challenge. */
async function requestText(request, url, options) {
  const response = await request(url, options);
  const text = await response.text();
  if (isChallenge(text)) throw new SpikeStop("blocked", "client_challenge");
  return { response, text };
}

/** Step 1: find the logged-in fan through the browser's existing session. */
async function readFanId(request, parseHtml) {
  const { text } = await requestText(request, HOME_URL);
  const fanId = readBlob(parseHtml(text), "HomepageApp")?.pageContext?.identity?.fanId;
  if (!Number.isInteger(fanId) || fanId <= 0) throw new SpikeStop("blocked", "not_logged_in");
  return fanId;
}

/** Step 2: collect albums with at least two tracks, shortest first. */
async function scanAlbums(request, fanId, report) {
  const albums = [];
  let token = `${Math.floor(Date.now() / 1000)}:0:a::`;
  let pagesRead = 0;

  while (pagesRead < MAX_PAGES) {
    const { response, text } = await requestText(request, COLLECTION_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fan_id: fanId, count: PAGE_SIZE, older_than_token: token }),
    });
    if (!response.ok) throw new SpikeStop("fail", `collection_http_${response.status}`);

    let page;
    try {
      page = JSON.parse(text);
    } catch {
      throw new SpikeStop("fail", "collection_response_invalid");
    }
    if (!Array.isArray(page.items)) throw new SpikeStop("fail", "collection_response_invalid");
    pagesRead += 1;

    for (const item of page.items) {
      const url = page.redownload_urls?.[`${item.sale_item_type}${item.sale_item_id}`];
      const isTrack = item.tralbum_type === "t" || item.item_type === "track";
      if (isTrack || item.is_preorder === true || item.download_available === false) continue;
      if (!isTrustedUrl(url) || !(item.num_streamable_tracks >= 2)) continue;
      albums.push({ item, url });
    }

    if (page.more_available !== true || !page.last_token || page.last_token === token) break;
    token = page.last_token;
  }

  albums.sort((a, b) => a.item.num_streamable_tracks - b.item.num_streamable_tracks);
  report.steps.scan = { pagesRead, eligibleAlbums: albums.length };
  return albums;
}

/** Orders candidates for each group: shortest, around the middle, and longest. */
function candidateGroups(albums) {
  const middle = Math.floor(albums.length / 2);
  return {
    short: albums,
    medium: [...albums.slice(middle), ...albums.slice(0, middle).reverse()],
    long: [...albums].reverse(),
  };
}

/** Reads a release's FLAC URL, copying only the fields the test needs. */
async function resolveFlac(request, parseHtml, candidate) {
  const { text } = await requestText(request, candidate.url);
  const blob = readBlob(parseHtml(text), "pagedata");
  const items = Array.isArray(blob?.digital_items) ? blob.digital_items : [];
  const digital =
    items.find((entry) => String(entry.item_id) === String(candidate.item.item_id)) ??
    (items.length === 1 ? items[0] : null);
  const url = digital?.downloads?.flac?.url;
  if (!isTrustedUrl(url)) return null;
  return {
    url,
    artist: digital.artist ?? candidate.item.band_name,
    title: digital.title ?? candidate.item.item_title,
  };
}

/** Walks to a nested folder, creating each part when missing. */
async function openFolder(root, parts) {
  let folder = root;
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create: true });
  return folder;
}

/** Streams a response to a file through Chrome's atomic writable. */
async function streamToFile(folder, name, response, onBytes) {
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  let bytes = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      onBytes(bytes);
      controller.enqueue(chunk);
    },
  });
  await response.body.pipeThrough(counter).pipeTo(writable);
  return { handle, bytes };
}

/**
 * Checks whether a remote ZIP uses ZIP64 by reading only its final bytes.
 *
 * @returns {Promise<boolean|null>} True or false, or null if it cannot tell.
 */
async function probeZip64(request, url) {
  const response = await request(url, { headers: { range: `bytes=-${ZIP_END_PROBE_BYTES}` } });
  if (response.status !== 206) {
    await response.body?.cancel();
    return null;
  }

  const buffer = await response.arrayBuffer();
  const offset = buffer.byteLength - EOCD_SIZE;
  if (offset < 0) return null;
  const view = new DataView(buffer);
  if (view.getUint32(offset, true) !== EOCD_SIGNATURE) return null;

  const hasLocator =
    offset >= ZIP64_LOCATOR_SIZE &&
    view.getUint32(offset - ZIP64_LOCATOR_SIZE, true) === ZIP64_LOCATOR_SIGNATURE;
  return (
    hasLocator ||
    view.getUint16(offset + 10, true) === 0xffff ||
    view.getUint32(offset + 12, true) === 0xffffffff ||
    view.getUint32(offset + 16, true) === 0xffffffff
  );
}

/** Returns a privacy-safe type label for a sanitized file name. */
function reportableType(name) {
  const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return REPORTABLE_TYPES.has(extension) ? extension : "other";
}

/** Steps 5 to 7: extract, verify, and only then remove the temporary ZIP. */
async function extractAlbum({ zipHandle, tempFolder, tempName, destination, onProgress, label }) {
  const zipFile = await zipHandle.getFile();
  const entries = await readEntries(zipFile);
  const fileTypes = {};
  let extractedBytes = 0;
  let readBackPassed = 0;
  const startedAt = Date.now();

  for (const [index, entry] of entries.entries()) {
    onProgress(`Unzipping ${label} album: file ${index + 1} of ${entries.length}`);
    const output = await destination.getFileHandle(entry.outputName, { create: true });
    const writable = await output.createWritable();
    const { bytes } = await extractEntry(zipFile, entry, writable);
    extractedBytes += bytes;

    // Read through a fresh File object to prove the bytes on disk are correct.
    const saved = await output.getFile();
    if (saved.size !== entry.uncompressedSize || (await crc32OfBlob(saved)) !== entry.crc) {
      throw new ZipError("read_back_mismatch");
    }
    readBackPassed += 1;

    const type = reportableType(entry.outputName);
    fileTypes[type] = (fileTypes[type] ?? 0) + 1;
  }

  const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  await tempFolder.removeEntry(tempName);

  return {
    entries: entries.length,
    fileTypes,
    storedEntries: entries.filter((entry) => entry.method === 0).length,
    deflateEntries: entries.filter((entry) => entry.method === 8).length,
    utf8FlaggedNames: entries.filter((entry) => entry.usesUtf8Flag).length,
    namesWithReplacementCharacter: entries.filter((entry) => entry.hasReplacementCharacter).length,
    renamedEntries: entries.filter((entry) => entry.wasRenamed).length,
    extractedMb: toMb(extractedBytes),
    readBackPassed,
    verifyAndWriteMbPerSecond: toMb(extractedBytes / seconds),
    tempZipRemoved: true,
  };
}

/** Downloads and extracts one album from a size group. */
async function processGroup(label, candidates, deps, used, budget) {
  const { request, parseHtml, onProgress, testFolder, tempFolder } = deps;
  const skipped = {
    noFlac: 0,
    notAFile: 0,
    missingSize: 0,
    overLimit: 0,
    overLimitMb: [],
    overLimitUsingZip64: 0,
    overLimitStandardZip: 0,
    overLimitUnknownZip: 0,
  };
  let tries = 0;

  for (const candidate of candidates) {
    if (used.has(candidate.url)) continue;
    if (tries >= MAX_TRIES) break;
    tries += 1;

    const file = await resolveFlac(request, parseHtml, candidate);
    if (!file) {
      skipped.noFlac += 1;
      continue;
    }

    const response = await request(file.url);
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!response.ok || contentType.includes("html") || !response.body) {
      await response.body?.cancel();
      skipped.notAFile += 1;
      continue;
    }

    const expected = Number(response.headers.get("content-length")) || 0;
    if (!expected) {
      await response.body.cancel();
      skipped.missingSize += 1;
      continue;
    }
    if (expected > MAX_ZIP_BYTES || budget.used + expected > MAX_TOTAL_BYTES) {
      await response.body.cancel();
      skipped.overLimit += 1;
      skipped.overLimitMb.push(toMb(expected));
      const usesZip64 = await probeZip64(request, file.url);
      if (usesZip64 === true) skipped.overLimitUsingZip64 += 1;
      else if (usesZip64 === false) skipped.overLimitStandardZip += 1;
      else skipped.overLimitUnknownZip += 1;
      continue;
    }

    used.add(candidate.url);
    budget.used += expected;
    const tempName = `album-${label}.zip`;
    const result = {
      group: label,
      format: "flac",
      trackCount: candidate.item.num_streamable_tracks,
      zipMb: toMb(expected),
      skipped,
      passed: false,
      failure: null,
    };

    try {
      const startedAt = Date.now();
      const { handle, bytes } = await streamToFile(tempFolder, tempName, response, (written) => {
        onProgress(`Downloading ${label} album: ${toMb(written)} of ${toMb(expected)} MB`);
      });
      result.downloadMbPerSecond = toMb(bytes / Math.max((Date.now() - startedAt) / 1000, 0.001));
      if (bytes !== expected) throw new ZipError("download_size_mismatch");

      const destination = await openFolder(testFolder, [safeName(file.artist), safeName(file.title)]);
      Object.assign(
        result,
        await extractAlbum({
          zipHandle: handle,
          tempFolder,
          tempName,
          destination,
          onProgress,
          label,
        }),
      );
      result.passed = true;
    } catch (error) {
      if (error instanceof SpikeStop) throw error;
      // Unknown messages could echo a path, so report only fixed codes or names.
      result.failure =
        error instanceof ZipError ? error.code : `unexpected_${error?.name ?? "error"}`;
      result.originalZipKept = true;
    }
    return result;
  }

  return { group: label, skipped, passed: false, failure: "no_album_available", notAttempted: true };
}

/**
 * Runs the full spike.
 *
 * @param {object} deps Browser functions, injected for testing.
 * @param {typeof fetch} deps.fetchImpl Performs network requests.
 * @param {(html: string) => Document} deps.parseHtml Parses inert HTML.
 * @param {FileSystemDirectoryHandle} deps.root The folder the user chose.
 * @param {(message: string) => void} deps.onProgress Receives safe status text.
 * @param {(ms: number) => Promise<void>} [deps.wait] Pauses between requests.
 * @returns {Promise<object>} A privacy-safe report.
 */
export async function runSpike({
  fetchImpl,
  parseHtml,
  root,
  onProgress,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const report = { spike: "S5", version: 2, result: "running", reason: null, steps: {}, albums: [] };
  const request = createRequester(fetchImpl, wait);

  try {
    onProgress("Checking your Bandcamp session...");
    const fanId = await readFanId(request, parseHtml);
    onProgress("Finding albums...");
    const albums = await scanAlbums(request, fanId, report);
    if (!albums.length) throw new SpikeStop("fail", "no_eligible_album");

    const testFolder = await root.getDirectoryHandle(TEST_FOLDER, { create: true });
    const tempFolder = await testFolder.getDirectoryHandle(TEMP_FOLDER, { create: true });
    const deps = { request, parseHtml, onProgress, testFolder, tempFolder };
    const groups = candidateGroups(albums);
    const used = new Set();
    const budget = { used: 0 };

    for (const label of TEST_GROUPS) {
      report.albums.push(await processGroup(label, groups[label], deps, used, budget));
    }

    // This succeeds only when empty, so any kept ZIP is left in place.
    await testFolder.removeEntry(TEMP_FOLDER).catch(() => {});

    const attempted = report.albums.filter((album) => !album.notAttempted);
    const passed = attempted.filter((album) => album.passed);
    report.summary = {
      albumsAttempted: attempted.length,
      albumsPassed: passed.length,
      largestZipMb: Math.max(0, ...attempted.map((album) => album.zipMb)),
      totalExtractedMb: toMb(passed.reduce((sum, album) => sum + album.extractedMb * 1024 * 1024, 0)),
      totalFilesVerified: passed.reduce((sum, album) => sum + album.readBackPassed, 0),
    };

    if (attempted.length && passed.length === attempted.length) {
      report.result = attempted.length === TEST_GROUPS.length ? "pass" : "partial";
      report.reason = attempted.length === TEST_GROUPS.length ? null : "fewer_albums_than_planned";
    } else {
      report.result = "fail";
      report.reason = attempted.length ? "album_not_verified" : "no_album_downloaded";
    }
  } catch (error) {
    if (error instanceof SpikeStop) {
      report.result = error.result;
      report.reason = error.reason;
    } else {
      // Unknown error messages could echo a path or URL, so report only the type.
      report.result = "fail";
      report.reason = `unexpected_${error?.name ?? "error"}`;
    }
  }
  return report;
}
