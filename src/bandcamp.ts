/**
 * bandcamp.ts: the only module that knows Bandcamp's data shapes.
 *
 * Purpose:  Read the fan, their collection, and each release's download link.
 * Session:  Uses the browser's normal login. It never reads cookies.
 * Pacing:   All requests share one queue with a gap between them.
 * Privacy:  Page data contains payment and gift fields, so this module copies
 *           only an explicit list of fields and never stores raw responses.
 * Safety:   A client challenge stops the queue for the user. It is never
 *           solved, bypassed, or spoofed.
 * Caution:  These endpoints are undocumented and may change without notice.
 */
import {
  asRecord,
  asText,
  isChallenge,
  isTrustedUrl,
  readBlob,
  retryDelayMs,
  toRelease,
  wasSentToLogin,
  type JsonRecord,
} from "./bandcamp-data.js";
import { chooseFormat, type FormatChoice } from "./formats.js";
import type { FormatPreference, PauseReason, Release, WaitFunction } from "./types.js";

const HOME_URL = "https://bandcamp.com/";
const COLLECTION_API = "https://bandcamp.com/api/fancollection/1";
const PAGE_SIZE = 100;
/** A safety limit that stops a broken pagination token from looping forever. */
const MAX_SCAN_PAGES = 1000;
const REQUEST_GAP_MS = 700;
const MAX_RATE_LIMIT_RETRIES = 5;
/** A longer requested wait pauses the queue instead of holding a worker. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** A condition that must pause the whole queue for the user. */
export class QueueStop extends Error {
  readonly reason: PauseReason;

  constructor(reason: PauseReason) {
    super(reason);
    this.name = "QueueStop";
    this.reason = reason;
  }
}

/** A temporary failure that may succeed on another attempt. */
export class RetryableError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "RetryableError";
  }
}

export interface Fan {
  fanId: number;
  username: string | null;
}

export type ResolvedDownload =
  | {
      outcome: "ready";
      url: string;
      choice: FormatChoice;
      kind: Release["kind"];
      artist: string;
      title: string;
    }
  | { outcome: "no_format" };

export interface BandcampClient {
  getFan(signal?: AbortSignal): Promise<Fan | null>;
  scanLibrary(
    fanId: number,
    includeHidden: boolean,
    onCount: (count: number) => void,
  ): Promise<Release[]>;
  resolveDownload(
    release: Release,
    preferences: readonly FormatPreference[],
    signal: AbortSignal,
  ): Promise<ResolvedDownload>;
  /** Returns the file response, or null if the link needs email confirmation. */
  fetchFile(url: string, signal: AbortSignal): Promise<Response | null>;
}

export interface BandcampDeps {
  fetchImpl: typeof fetch;
  parseHtml: (html: string) => Document;
  wait: WaitFunction;
}

/** Creates a client whose requests all share one pacing queue. */
export function createBandcampClient({ fetchImpl, parseHtml, wait }: BandcampDeps): BandcampClient {
  let gate: Promise<void> = Promise.resolve();

  /** Waits for this request's turn. */
  async function nextSlot(signal?: AbortSignal | null): Promise<void> {
    gate = gate.then(() => wait(REQUEST_GAP_MS));
    await gate;
    signal?.throwIfAborted();
  }

  /** Sends a paced request, honoring Bandcamp's rate-limit responses. */
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      await nextSlot(init.signal);
      const response = await fetchImpl(url, { credentials: "include", ...init });
      if (response.status !== 429) return response;

      await response.body?.cancel();
      const delay = retryDelayMs(response.headers.get("retry-after"));
      if (attempt >= MAX_RATE_LIMIT_RETRIES || delay > MAX_RETRY_AFTER_MS) {
        throw new QueueStop("rate_limited");
      }
      await wait(delay, init.signal ?? undefined);
    }
  }

  /** Fetches text and stops the queue on a challenge or logged-out redirect. */
  async function requestText(
    url: string,
    init?: RequestInit,
  ): Promise<{ response: Response; text: string }> {
    const response = await request(url, init);
    const text = await response.text();
    if (isChallenge(text)) throw new QueueStop("client_challenge");
    if (wasSentToLogin(response)) throw new QueueStop("logged_out");
    return { response, text };
  }

  return {
    async getFan(signal) {
      const { text } = await requestText(HOME_URL, signal ? { signal } : {});
      const context = asRecord(readBlob(parseHtml(text), "HomepageApp")?.pageContext);
      const identity = asRecord(context?.identity);
      const fanId = identity?.fanId;
      if (typeof fanId !== "number" || !Number.isInteger(fanId) || fanId <= 0) return null;
      return { fanId, username: asText(identity?.fanUsername) || null };
    },

    async scanLibrary(fanId, includeHidden, onCount) {
      const found = new Map<string, Release>();
      const endpoints = includeHidden ? ["collection_items", "hidden_items"] : ["collection_items"];

      for (const endpoint of endpoints) {
        // The token means "older than now", so results begin with the newest.
        let token = `${Math.floor(Date.now() / 1000)}:0:a::`;
        for (let pageNumber = 0; pageNumber < MAX_SCAN_PAGES; pageNumber += 1) {
          const { response, text } = await requestText(`${COLLECTION_API}/${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fan_id: fanId, count: PAGE_SIZE, older_than_token: token }),
          });
          if (!response.ok) throw new RetryableError(`collection_http_${response.status}`);

          let page: JsonRecord | null;
          try {
            page = asRecord(JSON.parse(text));
          } catch {
            throw new RetryableError("collection_invalid");
          }
          if (!page || !Array.isArray(page.items)) throw new RetryableError("collection_invalid");

          const urls = asRecord(page.redownload_urls) ?? {};
          for (const item of page.items) {
            const release = toRelease(item, urls, endpoint === "hidden_items");
            if (release && !found.has(release.key)) found.set(release.key, release);
          }
          onCount(found.size);

          const next = page.last_token;
          if (page.more_available !== true || typeof next !== "string" || next === token) break;
          token = next;
        }
      }
      return [...found.values()];
    },

    async resolveDownload(release, preferences, signal) {
      if (!release.redownloadUrl) return { outcome: "no_format" };
      const { response, text } = await requestText(release.redownloadUrl, { signal });
      if (!response.ok) throw new RetryableError(`page_http_${response.status}`);

      const blob = readBlob(parseHtml(text), "pagedata");
      const items = Array.isArray(blob?.digital_items) ? blob.digital_items.map(asRecord) : [];
      const digital =
        items.find((entry) => asText(entry?.item_id) === release.itemId) ??
        (items.length === 1 ? items[0] : null);
      if (!digital) throw new RetryableError("download_page_invalid");

      const downloads = asRecord(digital.downloads) ?? {};
      const available = new Set(
        Object.keys(downloads).filter((key) => isTrustedUrl(asRecord(downloads[key])?.url)),
      );
      const choice = chooseFormat(preferences, available);
      if (!choice) return { outcome: "no_format" };

      const isTrack =
        digital.download_type === "t" ||
        digital.download_type_str === "track" ||
        digital.item_type === "track";
      return {
        outcome: "ready",
        url: asRecord(downloads[choice.key])?.url as string,
        choice,
        kind: isTrack ? "track" : "album",
        artist: asText(digital.artist) || release.artist,
        title: asText(digital.title) || release.title,
      };
    },

    async fetchFile(url, signal) {
      const response = await request(url, { signal });
      const contentType = response.headers.get("content-type") ?? "";
      // Spike S1 proved the page's "expired" element is unreliable. An HTML
      // response where a file should be is the trustworthy signal.
      if (contentType.includes("html")) {
        const text = await response.text();
        if (isChallenge(text)) throw new QueueStop("client_challenge");
        if (wasSentToLogin(response)) throw new QueueStop("logged_out");
        return null;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new RetryableError(`file_http_${response.status}`);
      }
      return response;
    },
  };
}
