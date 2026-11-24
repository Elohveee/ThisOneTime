/**
 * formats.ts: the format preference list.
 *
 * Purpose:  Decide which single format to download for each release.
 * Rule:     Use the first enabled preference that Bandcamp offers.
 * Inputs:   The user's ordered preferences and a release's offered formats.
 * Outputs:  Pure results with no side effects, which keeps them easy to test.
 */
import type { FormatKey, FormatPreference } from "./types.js";

/** Default order: lossless first, then lossy from highest quality down. */
export const DEFAULT_FORMAT_ORDER: readonly FormatKey[] = [
  "flac",
  "alac",
  "wav",
  "aiff-lossless",
  "mp3-320",
  "mp3-v0",
  "aac-hi",
  "vorbis",
];

/** Names shown in the interface. */
export const FORMAT_LABELS: Readonly<Record<FormatKey, string>> = {
  flac: "FLAC",
  alac: "ALAC",
  wav: "WAV",
  "aiff-lossless": "AIFF",
  "mp3-320": "MP3 320",
  "mp3-v0": "MP3 V0",
  "aac-hi": "AAC",
  vorbis: "Ogg Vorbis",
};

/** File extensions for single-track downloads. Albums arrive as ZIPs. */
export const TRACK_EXTENSIONS: Readonly<Record<FormatKey, string>> = {
  flac: "flac",
  alac: "m4a",
  wav: "wav",
  "aiff-lossless": "aiff",
  "mp3-320": "mp3",
  "mp3-v0": "mp3",
  "aac-hi": "m4a",
  vorbis: "ogg",
};

/** The result of choosing a format for one release. */
export interface FormatChoice {
  key: FormatKey;
  /** True when a higher-ranked enabled format was not offered. */
  usedFallback: boolean;
}

/** Creates the default preference list with every format enabled. */
export function defaultPreferences(): FormatPreference[] {
  return DEFAULT_FORMAT_ORDER.map((key) => ({ key, enabled: true }));
}

/**
 * Repairs saved preferences.
 *
 * Unknown or duplicate keys are removed, and missing formats are appended, so
 * a future format change cannot leave the list broken.
 */
export function normalizePreferences(saved: readonly FormatPreference[] | undefined): FormatPreference[] {
  const seen = new Set<FormatKey>();
  const result: FormatPreference[] = [];
  for (const preference of saved ?? []) {
    if (!DEFAULT_FORMAT_ORDER.includes(preference.key) || seen.has(preference.key)) continue;
    seen.add(preference.key);
    result.push({ key: preference.key, enabled: Boolean(preference.enabled) });
  }
  for (const key of DEFAULT_FORMAT_ORDER) {
    if (!seen.has(key)) result.push({ key, enabled: true });
  }
  return result;
}

/**
 * Chooses exactly one format.
 *
 * @param preferences The user's ordered list.
 * @param available Format keys Bandcamp offers for this release.
 * @returns The chosen format, or null when no enabled format is offered.
 */
export function chooseFormat(
  preferences: readonly FormatPreference[],
  available: ReadonlySet<string>,
): FormatChoice | null {
  const enabled = preferences.filter((preference) => preference.enabled);
  const index = enabled.findIndex((preference) => available.has(preference.key));
  const chosen = enabled[index];
  return chosen ? { key: chosen.key, usedFallback: index > 0 } : null;
}

/** Returns a new list with one format moved up (-1) or down (+1). */
export function moveFormat(
  preferences: readonly FormatPreference[],
  key: FormatKey,
  direction: -1 | 1,
): FormatPreference[] {
  const result = [...preferences];
  const from = result.findIndex((preference) => preference.key === key);
  const to = from + direction;
  const moving = result[from];
  const other = result[to];
  if (from < 0 || !moving || !other) return result;
  result[from] = other;
  result[to] = moving;
  return result;
}
