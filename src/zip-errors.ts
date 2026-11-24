/**
 * zip-errors.ts: the ways a ZIP can fail.
 *
 * Purpose:  Separate archives to keep from downloads to retry.
 * Refusal:  The archive may be valid but is unsupported or suspicious, so the
 *           original ZIP is kept for the user.
 * Damage:   The download is probably corrupt, so it is removed and retried.
 * Privacy:  Error codes are fixed strings and never contain file names.
 */

/** Failures that mean the file is valid or suspicious, so the ZIP is kept. */
export type ZipRefusal =
  | "zip64"
  | "multi_disk"
  | "encrypted"
  | "unsupported_method"
  | "unsafe_path"
  | "nested_entry"
  | "duplicate_name"
  | "output_too_large";

/** Failures that suggest a damaged download, so it should be retried. */
export type ZipDamage =
  | "not_a_zip"
  | "corrupt_structure"
  | "corrupt_data"
  | "size_mismatch"
  | "crc_mismatch"
  | "read_back_mismatch";

const REFUSALS: ReadonlySet<string> = new Set<ZipRefusal>([
  "zip64",
  "multi_disk",
  "encrypted",
  "unsupported_method",
  "unsafe_path",
  "nested_entry",
  "duplicate_name",
  "output_too_large",
]);

/** A controlled ZIP failure with a fixed code that contains no file names. */
export class ZipError extends Error {
  readonly code: ZipRefusal | ZipDamage;

  constructor(code: ZipRefusal | ZipDamage) {
    super(code);
    this.name = "ZipError";
    this.code = code;
  }

  /** True when the album should be kept as a ZIP instead of retried. */
  get shouldKeepZip(): boolean {
    return REFUSALS.has(this.code);
  }
}
