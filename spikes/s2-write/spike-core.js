/**
 * spike-core.js: the Spike S2 test flow.
 *
 * Question:  Can an extension page stream real Bandcamp files into a folder the
 *            user chose, at predictable paths, with no save prompts?
 *
 * Flow:      1. Read the logged-in fan.
 *            2. Scan a few collection pages for one album and one track.
 *            3. Find each release's file, preferring a small format.
 *            4. Stream each file into the test folder.
 *            5. Read each saved file back and verify its size and signature.
 *
 * Inputs:    fetchImpl, parseHtml, root folder handle, onProgress, and an
 *            optional wait function. Injecting them allows rehearsal outside
 *            Chrome.
 * Output:    A report that always resolves, even when a step fails.
 *
 * Privacy:   The report may contain only counts, booleans, rounded sizes, HTTP
 *            details, hostnames, and format keys. It must never contain names,
 *            titles, IDs, tokens, URLs, paths, or raw response text.
 *
 * Safety:    Writes only inside `ThisOneTime S2 Test`. If Bandcamp shows a client
 *            challenge or rate limit, the test stops and never works around it.
 *
 * Caution:   These Bandcamp endpoints are undocumented and may change.
 */

const HOME_URL = "https://bandcamp.com/";
const COLLECTION_URL = "https://bandcamp.com/api/fancollection/1/collection_items";
const TEST_FOLDER = "ThisOneTime S2 Test";

/** Keeps the scan light while giving a good chance of finding a single track. */
const PAGE_SIZE = 50;
const MAX_PAGES = 5;
const REQUEST_GAP_MS = 700;
const MAX_CANDIDATES = 3;

/** Stops the test before saving anything unexpectedly large. */
const MAX_TEST_FILE_BYTES = 500 * 1024 * 1024;

/**
 * Smallest-first on purpose, because S2 tests saving rather than audio quality.
 * The real extension will use the user's saved preference list.
 */
const TEST_FORMAT_ORDER = [
  "mp3-v0",
  "mp3-320",
  "vorbis",
  "aac-hi",
  "flac",
  "alac",
  "aiff-lossless",
  "wav",
];

/** File extensions for single-track downloads. Albums always arrive as ZIPs. */
const TRACK_EXTENSIONS = {
  "mp3-v0": "mp3",
  "mp3-320": "mp3",
  vorbis: "ogg",
  "aac-hi": "m4a",
  flac: "flac",
  alac: "m4a",
  "aiff-lossless": "aiff",
  wav: "wav",
};

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

/** Returns a hostname only, because full download URLs contain signatures. */
function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * Makes one safe file or folder name.
 *
 * Removes path separators and characters that macOS, Windows, or Linux reject.
 * Trimming leading and trailing dots also neutralizes `.` and `..`.
 *
 * @param {unknown} value Text from Bandcamp, which is treated as untrusted.
 * @returns {string} A non-empty name of at most 80 characters.
 */
export function safeName(value) {
  const cleaned = String(value ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  const short = Array.from(cleaned).slice(0, 80).join("").replace(/[. ]+$/g, "");
  // Windows reserves these device names even when they have an extension.
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(short);
  return !short ? "Unknown" : reserved ? `${short}_` : short;
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

/** True when collection data marks the release as a single track. */
const isTrack = (item) => item.tralbum_type === "t" || item.item_type === "track";

/** Step 2: scan until the collection yields at least one album and one track. */
async function scanCollection(request, fanId, report) {
  const albums = [];
  const tracks = [];
  let token = `${Math.floor(Date.now() / 1000)}:0:a::`;
  let pagesRead = 0;

  while (pagesRead < MAX_PAGES && !(albums.length && tracks.length)) {
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
      if (item.is_preorder === true || item.download_available === false) continue;
      if (!isTrustedUrl(url)) continue;
      (isTrack(item) ? tracks : albums).push({ item, url });
    }

    // Stop if Bandcamp reports the end or fails to advance the page token.
    if (page.more_available !== true || !page.last_token || page.last_token === token) break;
    token = page.last_token;
  }

  // Prefer the shortest multi-track albums to keep the test download small.
  const trackCount = (entry) => entry.item.num_streamable_tracks ?? Number.MAX_SAFE_INTEGER;
  const multiTrack = albums.filter((entry) => trackCount(entry) >= 2);
  const albumPool = (multiTrack.length ? multiTrack : albums).sort(
    (a, b) => trackCount(a) - trackCount(b),
  );

  report.steps.scan = { pagesRead, albumsFound: albums.length, tracksFound: tracks.length };
  return { albums: albumPool, tracks };
}

/** Step 3: read a release's download page and choose a small format. */
async function resolveFile(request, parseHtml, candidate) {
  const { text } = await requestText(request, candidate.url);
  const blob = readBlob(parseHtml(text), "pagedata");
  const items = Array.isArray(blob?.digital_items) ? blob.digital_items : [];
  const digital =
    items.find((entry) => String(entry.item_id) === String(candidate.item.item_id)) ??
    (items.length === 1 ? items[0] : null);
  const downloads = digital?.downloads ?? {};
  const format = TEST_FORMAT_ORDER.find((key) => isTrustedUrl(downloads[key]?.url));
  if (!format) return null;

  // Copy only the fields needed. Page data also holds payment and gift details.
  return {
    url: downloads[format].url,
    format,
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

/**
 * Streams a response into a file.
 *
 * `createWritable` writes to a temporary swap file, and Chrome only replaces the
 * destination when the stream closes. A failed pipe aborts it, so a partial
 * transfer never appears as a finished file.
 */
async function streamToFile(folder, fileName, response, onBytes) {
  const handle = await folder.getFileHandle(fileName, { create: true });
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

/** Identifies a saved file from its first bytes. */
function detectSignature(bytes) {
  const text = String.fromCharCode(...bytes.slice(0, 4));
  if (text === "PK\u0003\u0004") return "zip";
  if (text === "fLaC") return "flac";
  if (text.startsWith("ID3")) return "mp3";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3";
  if (text === "OggS") return "ogg";
  if (text === "RIFF") return "wav";
  if (text === "FORM") return "aiff";
  if (String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") return "m4a";
  return bytes[0] === 0x3c ? "html" : "other";
}

/** Checks for a ZIP's end marker, which a truncated file would be missing. */
async function hasZipEnd(file) {
  const searchSize = Math.min(file.size, 66 * 1024);
  const tail = new Uint8Array(await file.slice(file.size - searchSize).arrayBuffer());
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) {
      return true;
    }
  }
  return false;
}

const toMb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Steps 3 to 5 for one kind of release. */
async function saveOne(kind, candidates, deps, testFolder) {
  const { request, parseHtml, onProgress } = deps;

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const file = await resolveFile(request, parseHtml, candidate);
    if (!file) continue;

    const response = await request(file.url);
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    // A web page here usually means the link needs confirmation. Never save it.
    if (!response.ok || contentType.includes("html") || !response.body) {
      await response.body?.cancel();
      continue;
    }

    const expected = Number(response.headers.get("content-length")) || null;
    if (expected && expected > MAX_TEST_FILE_BYTES) {
      await response.body.cancel();
      continue;
    }

    const artist = safeName(file.artist);
    const title = safeName(file.title);
    const isAlbum = kind === "album";
    const parts = isAlbum ? [artist] : [artist, title];
    const name = isAlbum
      ? `${safeName(`${artist} - ${title}`)}.zip`
      : `${title}.${TRACK_EXTENSIONS[file.format]}`;
    const folder = await openFolder(testFolder, parts);

    const startedAt = Date.now();
    const { handle, bytes } = await streamToFile(folder, name, response, (written) => {
      onProgress(`Saving ${kind}: ${toMb(written)} MB`);
    });
    const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);

    // Read through a fresh File object to prove the data really reached disk.
    const saved = await handle.getFile();
    const head = new Uint8Array(await saved.slice(0, 12).arrayBuffer());
    const signature = detectSignature(Array.from(head));
    const sizeMatches = expected === null ? null : saved.size === expected;
    const zipComplete = isAlbum ? await hasZipEnd(saved) : null;
    const typeMatches = isAlbum
      ? signature === "zip"
      : !["zip", "html", "other"].includes(signature);

    return {
      saved: true,
      format: file.format,
      httpStatus: response.status,
      finalHost: hostOf(response.url),
      contentType,
      sizeMb: toMb(saved.size),
      bytesMatchSavedFile: bytes === saved.size,
      sizeMatchesHeader: sizeMatches,
      signature,
      zipComplete,
      mbPerSecond: toMb(bytes / seconds),
      pathDepthInsideTestFolder: parts.length + 1,
      verified:
        typeMatches &&
        bytes === saved.size &&
        saved.size > 0 &&
        sizeMatches !== false &&
        zipComplete !== false,
    };
  }
  return { saved: false, verified: false, candidatesTried: Math.min(candidates.length, MAX_CANDIDATES) };
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
  const report = { spike: "S2", version: 1, result: "running", reason: null, steps: {} };
  const request = createRequester(fetchImpl, wait);
  const deps = { request, parseHtml, onProgress };

  try {
    onProgress("Checking your Bandcamp session...");
    const fanId = await readFanId(request, parseHtml);
    onProgress("Finding one album and one track...");
    const { albums, tracks } = await scanCollection(request, fanId, report);
    const testFolder = await root.getDirectoryHandle(TEST_FOLDER, { create: true });

    onProgress("Saving album...");
    report.steps.album = await saveOne("album", albums, deps, testFolder);
    onProgress("Saving track...");
    report.steps.track = tracks.length
      ? await saveOne("track", tracks, deps, testFolder)
      : { saved: false, verified: false, candidatesTried: 0 };

    if (report.steps.album.verified && report.steps.track.verified) {
      report.result = "pass";
    } else if (report.steps.album.verified && !tracks.length) {
      report.result = "partial";
      report.reason = "no_single_track_found";
    } else {
      report.result = "fail";
      report.reason = "file_not_verified";
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
