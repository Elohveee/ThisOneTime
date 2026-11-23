/**
 * spike-core.js: the Spike S1 test flow.
 *
 * Question:  Can an extension page use the user's normal Bandcamp session to
 *            read the fan, page the collection, and reach one real file?
 *
 * Flow:      1. Read the logged-in fan from the homepage.
 *            2. Read one small collection page.
 *            3. Read a second page to prove pagination.
 *            4. Open a release's download page and list its formats.
 *            5. Request only the first 4 bytes of one file.
 *
 * Inputs:    fetchImpl, parseHtml, onProgress, and an optional wait function.
 *            Injecting them lets this file be rehearsed outside Chrome.
 * Output:    A report that always resolves, even when a step fails.
 *
 * Privacy:   The report may contain only counts, booleans, HTTP details,
 *            hostnames, format keys, and Bandcamp's field names. It must never
 *            contain names, titles, IDs, tokens, URLs, or raw response text.
 *
 * Safety:    Read-only and deliberately slow. If Bandcamp shows a client
 *            challenge or rate limit, the test stops. It never tries to solve,
 *            bypass, or retry around either one.
 *
 * Caution:   These Bandcamp endpoints are undocumented and may change.
 */

const HOME_URL = "https://bandcamp.com/";
const COLLECTION_URL = "https://bandcamp.com/api/fancollection/1/collection_items";

/** Items per test page. Small on purpose, to keep the test light. */
const PAGE_SIZE = 20;

/** Pause before each request, staying well below the 3 req/s other tools use. */
const REQUEST_GAP_MS = 700;

/** How many releases to try if one has no usable download. */
const MAX_CANDIDATES = 3;

/** The same preference order as the planned default setting. */
const FORMAT_ORDER = [
  "flac",
  "alac",
  "wav",
  "aiff-lossless",
  "mp3-320",
  "mp3-v0",
  "aac-hi",
  "vorbis",
];

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

/** Identifies a file from its first bytes without keeping the bytes. */
function detectFileType(bytes) {
  const text = String.fromCharCode(...bytes.slice(0, 4));
  if (text.startsWith("PK")) return "zip";
  if (text === "fLaC") return "flac";
  if (text.startsWith("ID3")) return "mp3";
  if (text === "RIFF") return "wav";
  if (text === "FORM") return "aiff";
  if (text === "OggS") return "ogg";
  if (text.startsWith("<")) return "html";
  return bytes.length ? "other" : "empty";
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
async function readSession(request, parseHtml, report) {
  const { response, text } = await requestText(request, HOME_URL);
  const blob = readBlob(parseHtml(text), "HomepageApp");
  const identity = blob?.pageContext?.identity;
  const fanId = identity?.fanId;

  report.steps.session = {
    httpStatus: response.status,
    foundHomepageData: Boolean(blob),
    isLoggedIn: identity?.isLoggedIn === true,
    hasFanId: Number.isInteger(fanId) && fanId > 0,
    identityFields: identity ? Object.keys(identity).sort() : [],
  };

  if (!blob) throw new SpikeStop("fail", "homepage_data_missing");
  if (!report.steps.session.hasFanId) throw new SpikeStop("blocked", "not_logged_in");
  return fanId;
}

/** Requests one collection page as JSON. */
async function readCollectionPage(request, fanId, token) {
  const { response, text } = await requestText(request, COLLECTION_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fan_id: fanId, count: PAGE_SIZE, older_than_token: token }),
  });
  if (!response.ok) throw new SpikeStop("fail", `collection_http_${response.status}`);

  try {
    const page = JSON.parse(text);
    if (!Array.isArray(page.items)) throw new Error("missing items");
    return page;
  } catch {
    throw new SpikeStop("fail", "collection_response_invalid");
  }
}

/** Builds Bandcamp's item key, such as `a123` or `p456`. */
const itemKey = (item) => `${item.sale_item_type}${item.sale_item_id}`;

/** Summarizes a collection page with counts and field names only. */
function summarizePage(page) {
  const urls = page.redownload_urls ?? {};
  const saleItemTypes = {};
  for (const item of page.items) {
    const type = /^[a-z]$/.test(item.sale_item_type ?? "") ? item.sale_item_type : "unknown";
    saleItemTypes[type] = (saleItemTypes[type] ?? 0) + 1;
  }
  return {
    itemCount: page.items.length,
    moreAvailable: page.more_available === true,
    hasLastToken: typeof page.last_token === "string" && page.last_token.length > 0,
    joinedToRedownloadUrl: page.items.filter((item) => urls[itemKey(item)]).length,
    preorders: page.items.filter((item) => item.is_preorder === true).length,
    saleItemTypes,
    itemFields: page.items[0] ? Object.keys(page.items[0]).sort() : [],
  };
}

/** Step 2 and 3: read two collection pages and compare them for overlap. */
async function readCollection(request, fanId, report) {
  // Bandcamp's token format is `<time>:<offset>:a::`. "now" means newest first.
  const firstToken = `${Math.floor(Date.now() / 1000)}:0:a::`;
  const first = await readCollectionPage(request, fanId, firstToken);
  report.steps.collection = summarizePage(first);

  if (first.more_available !== true || !first.last_token) {
    report.steps.pagination = { tested: false, reason: "collection_fits_one_page" };
    return first;
  }

  const second = await readCollectionPage(request, fanId, first.last_token);
  const seen = new Set(first.items.map(itemKey));
  report.steps.pagination = {
    tested: true,
    itemCount: second.items.length,
    overlappingItems: second.items.filter((item) => seen.has(itemKey(item))).length,
    tokenAdvanced: second.last_token !== first.last_token,
  };
  return first;
}

/** Selects releases that look downloadable, in collection order. */
function chooseCandidates(page) {
  const urls = page.redownload_urls ?? {};
  return page.items
    .filter((item) => item.is_preorder !== true && item.download_available !== false)
    .map((item) => ({ item, url: urls[itemKey(item)] }))
    .filter(({ url }) => isTrustedUrl(url))
    .slice(0, MAX_CANDIDATES);
}

/** Finds this release on its download page and reports how it matched. */
function matchDigitalItem(digitalItems, item) {
  const exact = digitalItems.find((entry) => String(entry.item_id) === String(item.item_id));
  if (exact) return { digitalItem: exact, matchedBy: "item_id" };
  if (digitalItems.length === 1) return { digitalItem: digitalItems[0], matchedBy: "only_item" };
  return { digitalItem: null, matchedBy: "none" };
}

/** Step 4: read formats from a release's download page. */
async function readDownloadPage(request, parseHtml, candidate) {
  const { response, text } = await requestText(request, candidate.url);
  const doc = parseHtml(text);
  const blob = readBlob(doc, "pagedata");
  const digitalItems = Array.isArray(blob?.digital_items) ? blob.digital_items : [];
  const { digitalItem, matchedBy } = matchDigitalItem(digitalItems, candidate.item);
  const downloads = digitalItem?.downloads ?? {};
  const formats = Object.keys(downloads).sort();
  const format = FORMAT_ORDER.find((key) => downloads[key]?.url) ?? null;
  const reauth = doc.querySelector(".email-reauth-error");
  const reauthStyle = (reauth?.getAttribute("style") ?? "").replace(/\s/g, "").toLowerCase();

  return {
    fileUrl: format ? downloads[format].url : null,
    summary: {
      httpStatus: response.status,
      finalHost: hostOf(response.url),
      foundPageData: Boolean(blob),
      digitalItemCount: digitalItems.length,
      matchedBy,
      formats,
      chosenFormat: format,
      needsEmailConfirmation: Boolean(reauth) && !reauthStyle.includes("display:none"),
      digitalItemFields: digitalItem ? Object.keys(digitalItem).sort() : [],
    },
  };
}

/** Requests the first 4 bytes of a file, then cancels the transfer. */
async function probeFile(request, url) {
  if (!isTrustedUrl(url)) return { usable: false, detectedType: "untrusted_url" };

  const response = await request(url, { headers: { range: "bytes=0-3" } });
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  const reader = response.body?.getReader();
  const chunk = reader ? await reader.read() : { value: new Uint8Array() };
  await reader?.cancel();

  const detectedType = detectFileType(Array.from(chunk.value ?? []));
  return {
    usable: response.ok && !contentType.includes("html") && !["html", "empty"].includes(detectedType),
    httpStatus: response.status,
    finalHost: hostOf(response.url),
    contentType,
    detectedType,
    supportsRange: response.status === 206,
    hasContentDisposition: response.headers.has("content-disposition"),
  };
}

/** Asks Bandcamp's status endpoint for a fresh link when the direct URL fails. */
async function resolveStatUrl(request, fileUrl) {
  const url = new URL(fileUrl);
  url.pathname = url.pathname.replace(/^\/download\//, "/statdownload/");
  url.searchParams.set(".vrs", "1");

  const { response, text } = await requestText(request, url.href, {
    headers: { accept: "application/json" },
  });
  // Tools have seen both JSON and JavaScript replies, so read the one field.
  const match = text.match(/"download_url"\s*:\s*"([^"]+)"/);
  const freshUrl = match ? match[1].replace(/\\\//g, "/") : fileUrl;
  return {
    freshUrl,
    summary: {
      httpStatus: response.status,
      returnedFreshUrl: Boolean(match),
      reportedExpiry: text.includes("ExpirationError"),
    },
  };
}

/** Steps 4 and 5: try a few releases until one real file is reachable. */
async function reachOneFile(request, parseHtml, page, report) {
  const candidates = chooseCandidates(page);
  report.steps.downloadPages = [];
  if (!candidates.length) throw new SpikeStop("fail", "no_downloadable_item_on_first_page");

  for (const candidate of candidates) {
    const { fileUrl, summary } = await readDownloadPage(request, parseHtml, candidate);
    report.steps.downloadPages.push(summary);
    if (!fileUrl) continue;

    const direct = await probeFile(request, fileUrl);
    report.steps.file = { direct, statRequired: false };
    if (direct.usable) return;

    const stat = await resolveStatUrl(request, fileUrl);
    const afterStat = await probeFile(request, stat.freshUrl);
    report.steps.file = { direct, statRequired: afterStat.usable, stat: stat.summary, afterStat };
    if (afterStat.usable) return;
  }
  throw new SpikeStop("fail", "no_file_reachable");
}

/**
 * Runs the full spike.
 *
 * @param {object} deps Browser functions, injected for testing.
 * @param {typeof fetch} deps.fetchImpl Performs network requests.
 * @param {(html: string) => Document} deps.parseHtml Parses inert HTML.
 * @param {(message: string) => void} deps.onProgress Receives safe status text.
 * @param {(ms: number) => Promise<void>} [deps.wait] Pauses between requests.
 * @returns {Promise<object>} A privacy-safe report.
 */
export async function runSpike({
  fetchImpl,
  parseHtml,
  onProgress,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const report = { spike: "S1", version: 1, result: "running", reason: null, steps: {} };
  const request = createRequester(fetchImpl, wait);

  try {
    onProgress("Checking your Bandcamp session...");
    const fanId = await readSession(request, parseHtml, report);
    onProgress("Reading a small part of your collection...");
    const page = await readCollection(request, fanId, report);
    onProgress("Checking one release's download...");
    await reachOneFile(request, parseHtml, page, report);
    report.result = "pass";
  } catch (error) {
    if (error instanceof SpikeStop) {
      report.result = error.result;
      report.reason = error.reason;
    } else {
      // Unknown error messages could echo a URL, so report only the error type.
      report.result = "fail";
      report.reason = `unexpected_${error?.name ?? "error"}`;
    }
  }
  return report;
}
