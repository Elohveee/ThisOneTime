/**
 * bandcamp-data.ts: validates untrusted data from Bandcamp.
 *
 * Purpose:  Convert raw JSON and page data into safe, typed values.
 * Privacy:  `toRelease` copies an explicit list of fields, so payment and gift
 *           details in Bandcamp's data are never stored.
 * Caution:  These shapes are undocumented and may change. Keeping them here
 *           leaves one place to fix when Bandcamp changes its site.
 */
import type { Release } from "./types.js";

const DEFAULT_RETRY_AFTER_MS = 10_000;

export type JsonRecord = Record<string, unknown>;

export const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

/** Converts a JSON string or number to text. Anything else becomes empty. */
export const asText = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

/** Accepts only HTTPS URLs on Bandcamp's own hosts or its file CDN. */
export function isTrustedUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const { protocol, hostname } = new URL(value);
    return (
      protocol === "https:" &&
      (hostname === "bandcamp.com" ||
        hostname.endsWith(".bandcamp.com") ||
        hostname.endsWith(".bcbits.com"))
    );
  } catch {
    return false;
  }
}

/** Bandcamp's client challenge page. */
export const isChallenge = (text: string): boolean =>
  text.includes("Client Challenge") && text.includes("_fs-ch-");

/** Reads and parses a JSON `data-blob` attribute. */
export function readBlob(doc: Document, id: string): JsonRecord | null {
  const raw = doc.getElementById(id)?.getAttribute("data-blob");
  if (!raw) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Reads a Retry-After header, given in seconds or as an HTTP date. */
export function retryDelayMs(header: string | null): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - Date.now());
}

/** True when Bandcamp redirected a request to its login page. */
export function wasSentToLogin(response: Response): boolean {
  try {
    return new URL(response.url).pathname.startsWith("/login");
  } catch {
    return false;
  }
}

/** Converts one collection item, copying only the fields ThisOneTime needs. */
export function toRelease(raw: unknown, urls: JsonRecord, hidden: boolean): Release | null {
  const item = asRecord(raw);
  const type = asText(item?.sale_item_type);
  const id = asText(item?.sale_item_id);
  if (!item || !type || !id) return null;

  // Sale type alone cannot identify physical items, as Spike S1 showed.
  const key = `${type}${id}`;
  const url = urls[key];
  const redownloadUrl = isTrustedUrl(url) ? url : null;
  const blocked = item.download_available === false || item.download_available === null;
  const status: Release["status"] =
    item.is_preorder === true
      ? "preorder"
      : !redownloadUrl || blocked
        ? "unavailable"
        : "pending";

  return {
    key,
    itemId: asText(item.item_id),
    redownloadUrl,
    artist: asText(item.band_name) || "Unknown Artist",
    title: asText(item.item_title) || "Unknown Title",
    kind: item.tralbum_type === "t" || item.item_type === "track" ? "track" : "album",
    hidden,
    status,
    note: null,
    format: null,
    usedFallback: false,
    attempts: 0,
    folderSuffix: "",
  };
}
