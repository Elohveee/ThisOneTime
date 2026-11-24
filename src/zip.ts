/**
 * zip.ts: a small, dependency-free ZIP reader for Bandcamp album downloads.
 *
 * How ZIPs work:
 *   1. The End Of Central Directory (EOCD) record sits at the end of the file.
 *   2. It points to the central directory, the ZIP's table of contents.
 *   3. Each table entry points to a local header followed by file data.
 *
 * Usage:     const entries = await readEntries(zipFile);
 *            await extractEntry(zipFile, entries[0], writableStream);
 * Supports:  Stored and Deflate entries in a flat ZIP.
 * Refuses:   ZIP64, encryption, multi-disk archives, nested folders, unsafe
 *            paths, duplicate names, and inconsistent data.
 * Safety:    ZIP contents are untrusted. Output is capped at its declared size,
 *            and CRC-32 is checked before the writable closes. A failed check
 *            aborts the write, so a bad file never replaces the destination.
 */
import { CRC_START, crc32Finish, crc32Update } from "./crc32.js";
import { safeFileName } from "./filenames.js";
import { ZipError } from "./zip-errors.js";

export { ZipError };

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
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** Refuses archives that would expand beyond a sane album size. */
const MAX_TOTAL_OUTPUT_BYTES = 64 * 1024 * 1024 * 1024;

/** One validated file inside a ZIP. */
export interface ZipEntry {
  outputName: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Rejects path tricks and folders before an entry name can be used. */
function assertFlatSafeName(name: string): void {
  if (!name || name.includes("\0") || name.includes("\\")) throw new ZipError("unsafe_path");
  if (name.startsWith("/") || /^[a-z]:/i.test(name)) throw new ZipError("unsafe_path");
  if (name.split("/").includes("..")) throw new ZipError("unsafe_path");
  if (name.includes("/")) throw new ZipError("nested_entry");
}

/** Reads a byte range, rejecting ranges outside the file. */
async function readView(file: Blob, start: number, end: number): Promise<DataView> {
  if (start < 0 || end > file.size || start > end) throw new ZipError("corrupt_structure");
  return new DataView(await file.slice(start, end).arrayBuffer());
}

/** Searches backward for an EOCD whose comment reaches the end of the file. */
async function findEocd(file: Blob): Promise<DataView> {
  if (file.size < EOCD_SIZE) throw new ZipError("not_a_zip");
  const tail = await readView(file, Math.max(0, file.size - MAX_EOCD_SEARCH), file.size);

  for (let offset = tail.byteLength - EOCD_SIZE; offset >= 0; offset -= 1) {
    if (tail.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.getUint16(offset + 20, true);
    if (offset + EOCD_SIZE + commentLength === tail.byteLength) {
      return new DataView(tail.buffer, tail.byteOffset + offset, EOCD_SIZE);
    }
  }
  throw new ZipError("not_a_zip");
}

/** Parses and validates one central directory record. */
function parseEntry(
  directory: DataView,
  position: number,
  decoder: TextDecoder,
): { entry: ZipEntry; next: number } {
  if (position + CENTRAL_HEADER_SIZE > directory.byteLength) throw new ZipError("corrupt_structure");
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

  const nameBytes = new Uint8Array(directory.buffer, directory.byteOffset + nameStart, nameLength);
  const name = decoder.decode(nameBytes);
  assertFlatSafeName(name);
  return {
    entry: {
      outputName: safeFileName(name),
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    },
    next,
  };
}

/**
 * Reads and validates the ZIP's table of contents.
 *
 * @returns Entries with safe, unique output names.
 * @throws {ZipError} When the archive is unsupported, unsafe, or damaged.
 */
export async function readEntries(file: Blob): Promise<ZipEntry[]> {
  const eocd = await findEocd(file);
  const entryCount = eocd.getUint16(10, true);
  const directorySize = eocd.getUint32(12, true);
  const directoryOffset = eocd.getUint32(16, true);

  if (entryCount === ZIP64_U16 || directorySize === ZIP64_U32 || directoryOffset === ZIP64_U32) {
    throw new ZipError("zip64");
  }
  if (
    eocd.getUint16(4, true) !== 0 ||
    eocd.getUint16(6, true) !== 0 ||
    eocd.getUint16(8, true) !== entryCount
  ) {
    throw new ZipError("multi_disk");
  }

  const directory = await readView(file, directoryOffset, directoryOffset + directorySize);
  const decoder = new TextDecoder("utf-8");
  const usedNames = new Set<string>();
  const entries: ZipEntry[] = [];
  let totalOutput = 0;
  let position = 0;

  for (let index = 0; index < entryCount; index += 1) {
    const { entry, next } = parseEntry(directory, position, decoder);
    // macOS and Windows commonly ignore case, so `A.flac` and `a.flac` collide.
    const uniqueKey = entry.outputName.normalize("NFC").toLowerCase();
    if (usedNames.has(uniqueKey)) throw new ZipError("duplicate_name");
    usedNames.add(uniqueKey);

    totalOutput += entry.uncompressedSize;
    if (totalOutput > MAX_TOTAL_OUTPUT_BYTES) throw new ZipError("output_too_large");
    entries.push(entry);
    position = next;
  }
  return entries;
}

/**
 * Extracts one entry into a writable stream.
 *
 * The checker runs before the destination closes. If the size or CRC-32 is
 * wrong, the pipe errors, the writable aborts, and no output is committed.
 */
export async function extractEntry(
  file: Blob,
  entry: ZipEntry,
  writable: WritableStream<BufferSource>,
  signal?: AbortSignal,
): Promise<number> {
  const headerEnd = entry.localOffset + LOCAL_HEADER_SIZE;
  const header = await readView(file, entry.localOffset, headerEnd);
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) throw new ZipError("corrupt_structure");

  // Local name and extra lengths can differ from the central directory's.
  const dataStart = headerEnd + header.getUint16(26, true) + header.getUint16(28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > file.size) throw new ZipError("corrupt_structure");

  let bytes = 0;
  let crc = CRC_START;
  const checker = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      // Stop as soon as output exceeds its declared size, which blocks ZIP bombs.
      if (bytes > entry.uncompressedSize) throw new ZipError("size_mismatch");
      crc = crc32Update(crc, chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (bytes !== entry.uncompressedSize) throw new ZipError("size_mismatch");
      if (crc32Finish(crc) !== entry.crc) throw new ZipError("crc_mismatch");
    },
  });

  let source = file.slice(dataStart, dataEnd).stream() as ReadableStream<Uint8Array>;
  if (entry.method === METHOD_DEFLATE) {
    const inflater = new DecompressionStream("deflate-raw");
    source = source.pipeThrough(inflater as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  }

  try {
    await source
      .pipeThrough(checker)
      .pipeTo(writable as WritableStream<Uint8Array>, signal ? { signal } : {});
  } catch (error) {
    if (error instanceof ZipError) throw error;
    // Browsers report malformed Deflate data as a TypeError.
    const code = String((error as { code?: unknown } | null)?.code ?? "");
    if ((error as Error | null)?.name === "TypeError" || code.startsWith("Z_")) {
      throw new ZipError("corrupt_data");
    }
    throw error;
  }
  return bytes;
}
