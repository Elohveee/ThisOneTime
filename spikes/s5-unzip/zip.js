/**
 * zip.js: a small, dependency-free ZIP reader for Bandcamp album downloads.
 *
 * Purpose:   Safely extract a ZIP that is already saved on disk.
 *
 * How ZIPs work:
 *            1. The End Of Central Directory (EOCD) record sits at the file's end.
 *            2. It points to the central directory, the ZIP's table of contents.
 *            3. Each table entry points to a local header followed by file data.
 *
 * Usage:     const entries = await readEntries(zipFile);
 *            await extractEntry(zipFile, entries[0], writableStream);
 *
 * Supports:  Stored (method 0) and Deflate (method 8) entries in a flat ZIP.
 * Refuses:   ZIP64, encryption, multi-disk archives, nested folders, unsafe
 *            paths, duplicate names, and anything inconsistent with the file.
 *            Refusals throw ZipError so the caller can keep the original ZIP.
 *
 * Safety:    ZIP contents are untrusted. Output names are sanitized, output is
 *            capped at the size the ZIP declared, and CRC-32 is checked before
 *            the writable closes. A failed check aborts the write, so a bad
 *            file never replaces the destination.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;

/** An EOCD comment can be at most 65,535 bytes, which bounds the search. */
const MAX_EOCD_SEARCH = EOCD_SIZE + 0xffff;

/** Sentinel values meaning the real number lives in a ZIP64 record. */
const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Refuses archives that would expand beyond a sane album size. */
const MAX_TOTAL_OUTPUT_BYTES = 16 * 1024 * 1024 * 1024;

/** Stays safely below the 255-byte filename limit of common file systems. */
const MAX_NAME_BYTES = 200;

/** A controlled ZIP failure with a fixed code that contains no file names. */
export class ZipError extends Error {
  /** @param {string} code A predefined failure code. */
  constructor(code) {
    super(code);
    this.name = "ZipError";
    this.code = code;
  }
}

/** Standard CRC-32 lookup table, built once when this module loads. */
const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value;
});

/** Starting value for a running CRC-32. */
export const CRC_START = 0xffffffff;

/** Adds bytes to a running CRC-32. */
export function crc32Update(crc, bytes) {
  let value = crc;
  for (let index = 0; index < bytes.length; index += 1) {
    value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

/** Converts a running CRC-32 into its final value. */
export const crc32Finish = (crc) => (crc ^ CRC_START) >>> 0;

/** Calculates the CRC-32 of a saved file without loading it all into memory. */
export async function crc32OfBlob(blob) {
  const reader = blob.stream().getReader();
  let crc = CRC_START;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc32Finish(crc);
    crc = crc32Update(crc, value);
  }
}

/** Shortens text to a UTF-8 byte limit without splitting a character. */
function truncateUtf8(text, maxBytes) {
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
 *
 * @param {unknown} value Untrusted text.
 * @param {number} [maxBytes] Maximum UTF-8 length.
 * @returns {string} A non-empty, single-segment name.
 */
export function safeName(value, maxBytes = 120) {
  const cleaned = String(value ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  const short = truncateUtf8(cleaned, maxBytes).replace(/[. ]+$/g, "");
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(short);
  return !short ? "Unknown" : reserved ? `${short}_` : short;
}

/** Sanitizes a file name while always preserving a simple extension. */
export function safeFileName(name) {
  const dot = name.lastIndexOf(".");
  const rawExtension = dot > 0 ? name.slice(dot + 1) : "";
  const hasExtension = /^[a-z0-9]{1,10}$/i.test(rawExtension);
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? `.${rawExtension.toLowerCase()}` : "";
  return `${safeName(stem, MAX_NAME_BYTES - extension.length)}${extension}`;
}

/** Rejects path tricks and folders before an entry name can be used. */
function assertFlatSafeName(name) {
  if (!name || name.includes("\0") || name.includes("\\")) throw new ZipError("unsafe_path");
  if (name.startsWith("/") || /^[a-z]:/i.test(name)) throw new ZipError("unsafe_path");
  if (name.split("/").some((part) => part === "..")) throw new ZipError("unsafe_path");
  if (name.includes("/")) throw new ZipError("nested_entry");
}

/** Reads a byte range into a DataView, rejecting ranges outside the file. */
async function readView(file, start, end) {
  if (start < 0 || end > file.size || start > end) throw new ZipError("corrupt_structure");
  return new DataView(await file.slice(start, end).arrayBuffer());
}

/** Searches backward for an EOCD whose comment length reaches the file's end. */
async function findEocd(file) {
  if (file.size < EOCD_SIZE) throw new ZipError("not_a_zip");
  const searchStart = Math.max(0, file.size - MAX_EOCD_SEARCH);
  const tail = await readView(file, searchStart, file.size);

  for (let offset = tail.byteLength - EOCD_SIZE; offset >= 0; offset -= 1) {
    if (tail.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.getUint16(offset + 20, true);
    if (offset + EOCD_SIZE + commentLength === tail.byteLength) {
      return new DataView(tail.buffer, tail.byteOffset + offset, EOCD_SIZE);
    }
  }
  throw new ZipError("not_a_zip");
}

/**
 * Reads and validates the ZIP's table of contents.
 *
 * @param {Blob} file The saved ZIP.
 * @returns {Promise<object[]>} Entries with safe, unique `outputName` values.
 * @throws {ZipError} When the archive is unsupported, unsafe, or damaged.
 */
export async function readEntries(file) {
  const eocd = await findEocd(file);
  const diskNumber = eocd.getUint16(4, true);
  const directoryDisk = eocd.getUint16(6, true);
  const entriesOnDisk = eocd.getUint16(8, true);
  const entryCount = eocd.getUint16(10, true);
  const directorySize = eocd.getUint32(12, true);
  const directoryOffset = eocd.getUint32(16, true);

  if (entryCount === ZIP64_U16 || directorySize === ZIP64_U32 || directoryOffset === ZIP64_U32) {
    throw new ZipError("zip64");
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipError("multi_disk");
  }

  const directory = await readView(file, directoryOffset, directoryOffset + directorySize);
  const decoder = new TextDecoder("utf-8");
  const usedNames = new Set();
  const entries = [];
  let totalOutput = 0;
  let position = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (position + CENTRAL_HEADER_SIZE > directory.byteLength) {
      throw new ZipError("corrupt_structure");
    }
    if (directory.getUint32(position, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError("corrupt_structure");
    }

    const flags = directory.getUint16(position + 8, true);
    const method = directory.getUint16(position + 10, true);
    const crc = directory.getUint32(position + 16, true);
    const compressedSize = directory.getUint32(position + 20, true);
    const uncompressedSize = directory.getUint32(position + 24, true);
    const nameLength = directory.getUint16(position + 28, true);
    const extraLength = directory.getUint16(position + 30, true);
    const commentLength = directory.getUint16(position + 32, true);
    const localOffset = directory.getUint32(position + 42, true);
    const nameStart = position + CENTRAL_HEADER_SIZE;
    const next = nameStart + nameLength + extraLength + commentLength;

    if (next > directory.byteLength) throw new ZipError("corrupt_structure");
    if ([compressedSize, uncompressedSize, localOffset].includes(ZIP64_U32)) {
      throw new ZipError("zip64");
    }
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipError("encrypted");
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError("unsupported_method");
    }
    if (method === METHOD_STORED && compressedSize !== uncompressedSize) {
      throw new ZipError("corrupt_structure");
    }

    const nameBytes = new Uint8Array(
      directory.buffer,
      directory.byteOffset + nameStart,
      nameLength,
    );
    const name = decoder.decode(nameBytes);
    assertFlatSafeName(name);

    const outputName = safeFileName(name);
    const uniqueKey = outputName.normalize("NFC").toLowerCase();
    // macOS and Windows commonly ignore case, so `A.flac` and `a.flac` collide.
    if (usedNames.has(uniqueKey)) throw new ZipError("duplicate_name");
    usedNames.add(uniqueKey);

    totalOutput += uncompressedSize;
    if (totalOutput > MAX_TOTAL_OUTPUT_BYTES) throw new ZipError("output_too_large");

    entries.push({
      outputName,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      usesUtf8Flag: Boolean(flags & FLAG_UTF8),
      hasReplacementCharacter: name.includes("�"),
      wasRenamed: outputName !== name,
    });
    position = next;
  }
  return entries;
}

/**
 * Extracts one entry into a writable stream.
 *
 * The checker runs before the destination closes. If size or CRC-32 is wrong,
 * it errors the pipe, Chrome aborts the writable, and no output file is committed.
 *
 * @param {Blob} file The saved ZIP.
 * @param {object} entry An entry from readEntries.
 * @param {WritableStream} writable The destination.
 * @param {(bytes: number) => void} [onBytes] Receives extracted byte counts.
 * @returns {Promise<{bytes: number, crc: number}>} Verified output details.
 */
export async function extractEntry(file, entry, writable, onBytes = () => {}) {
  const headerEnd = entry.localOffset + LOCAL_HEADER_SIZE;
  const header = await readView(file, entry.localOffset, headerEnd);
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) throw new ZipError("corrupt_structure");

  // Local name and extra lengths can differ from the central directory's.
  const dataStart = headerEnd + header.getUint16(26, true) + header.getUint16(28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > file.size) throw new ZipError("corrupt_structure");

  let bytes = 0;
  let crc = CRC_START;
  const checker = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      // Stop as soon as output exceeds its declared size, which blocks ZIP bombs.
      if (bytes > entry.uncompressedSize) throw new ZipError("size_mismatch");
      crc = crc32Update(crc, chunk);
      onBytes(bytes);
      controller.enqueue(chunk);
    },
    flush() {
      if (bytes !== entry.uncompressedSize) throw new ZipError("size_mismatch");
      if (crc32Finish(crc) !== entry.crc) throw new ZipError("crc_mismatch");
    },
  });

  let source = file.slice(dataStart, dataEnd).stream();
  if (entry.method === METHOD_DEFLATE) {
    source = source.pipeThrough(new DecompressionStream("deflate-raw"));
  }

  try {
    await source.pipeThrough(checker).pipeTo(writable);
  } catch (error) {
    if (error instanceof ZipError) throw error;
    // Browsers report malformed Deflate data as a TypeError.
    if (error?.name === "TypeError" || String(error?.code ?? "").startsWith("Z_")) {
      throw new ZipError("corrupt_data");
    }
    throw error;
  }
  return { bytes, crc: entry.crc };
}
