/**
 * filenames.ts: safe, predictable names for saved music.
 *
 * Purpose:  Turn untrusted Bandcamp text into names that work on any computer.
 * Layout:   Albums:  <Artist>/<Title>/<files>
 *           Tracks:  <Artist>/<Title>/<Title>.<ext>
 *           ZIPs:    <Artist>/<Artist> - <Title>.zip
 * Safety:   Output is always one path segment, so `../` cannot escape a folder.
 */
import { TRACK_EXTENSIONS } from "./formats.js";
import { hasFinishedCopy } from "./release-actions.js";
import type { FormatKey, Release } from "./types.js";

/** Stays safely below the 255-byte limit of common file systems. */
const MAX_NAME_BYTES = 200;
const MAX_FOLDER_BYTES = 120;

/** Shortens text to a UTF-8 byte limit without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  let used = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

/**
 * Makes one safe folder or file-stem name.
 *
 * Removes path separators and characters rejected by macOS, Windows, or Linux.
 * Trimming leading and trailing dots also neutralizes `.` and `..`.
 */
export function safeName(value: unknown, maxBytes = MAX_FOLDER_BYTES): string {
  const cleaned = String(value ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  const short = truncateUtf8(cleaned, maxBytes).replace(/[. ]+$/g, "");
  // Windows reserves these device names, even inside other folders.
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(short);
  if (!short) return "Unknown";
  return reserved ? `${short}_` : short;
}

/** Sanitizes a file name while always preserving a simple extension. */
export function safeFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  const rawExtension = dot > 0 ? name.slice(dot + 1) : "";
  const hasExtension = /^[a-z0-9]{1,10}$/i.test(rawExtension);
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? `.${rawExtension.toLowerCase()}` : "";
  return `${safeName(stem, MAX_NAME_BYTES - extension.length)}${extension}`;
}

/** Returns the artist and release folder names. */
export function releaseFolders(release: Release): [artist: string, title: string] {
  return [safeName(release.artist), `${safeName(release.title)}${release.folderSuffix}`];
}

/** Returns the file name used when an album stays zipped. */
export function albumZipName(release: Release): string {
  const stem = safeName(`${release.artist} - ${release.title}`, MAX_NAME_BYTES - 40);
  return `${stem}${release.folderSuffix}.zip`;
}

/** Returns the file name for a single-track download. */
export function trackFileName(release: Release, format: FormatKey): string {
  return `${safeName(release.title, MAX_NAME_BYTES - 10)}.${TRACK_EXTENSIONS[format]}`;
}

/**
 * Gives same-named releases separate folders.
 *
 * Finished releases, including those being redownloaded, go first and keep
 * their existing paths, so a newly bought release with the same name can never
 * redirect or overwrite them.
 */
export function assignFolderSuffixes(releases: Release[]): void {
  const used = new Set<string>();
  const pathKey = (release: Release): string =>
    releaseFolders(release).join("/").normalize("NFC").toLowerCase();
  const ordered = [...releases].sort(
    (a, b) => Number(hasFinishedCopy(b)) - Number(hasFinishedCopy(a)),
  );

  for (const release of ordered) {
    if (!hasFinishedCopy(release)) {
      release.folderSuffix = "";
      if (used.has(pathKey(release))) release.folderSuffix = ` [${safeName(release.key)}]`;
    }
    used.add(pathKey(release));
  }
}
