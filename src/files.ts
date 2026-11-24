/**
 * files.ts: saves releases into the user's chosen backup folder.
 *
 * Purpose:  Stream downloads to disk and unpack albums.
 * Atomic:   `createWritable` writes to a swap file and replaces the destination
 *           only on close, so interrupted transfers never look finished.
 * Unzip:    1. Stream the ZIP to a temporary file.
 *           2. Extract each entry with size and CRC-32 checks.
 *           3. Read each saved file back and check CRC-32 again.
 *           4. Delete the temporary ZIP only after every file passes.
 * Failure:  Unsupported ZIPs are kept. Damaged ZIPs are removed and retried.
 * Safety:   After a failure, deletes only files this attempt newly created and
 *           its own `.thisonetime-tmp` folder. Existing files are never removed,
 *           so a failed or paused redownload cannot lose a good copy.
 */
import { RetryableError } from "./bandcamp.js";
import { crc32OfBlob } from "./crc32.js";
import { albumZipName, releaseFolders, safeName, trackFileName } from "./filenames.js";
import type { Activity, FormatKey, Release } from "./types.js";
import { extractEntry, readEntries, ZipError } from "./zip.js";

const TEMP_FOLDER = ".thisonetime-tmp";
const READ_WRITE = { mode: "readwrite" } as const;

/** Everything needed to save one release. */
export interface SaveRequest {
  root: FileSystemDirectoryHandle;
  release: Release;
  format: FormatKey;
  response: Response;
  autoUnzip: boolean;
  signal: AbortSignal;
  onActivity: (activity: Activity) => void;
}

/** Reads folder permission without showing a prompt. */
export const folderAccess = (folder: FileSystemDirectoryHandle): Promise<PermissionState> =>
  folder.queryPermission(READ_WRITE);

/** Asks Chrome to restore folder access. Must run from a user click. */
export const requestFolderAccess = (folder: FileSystemDirectoryHandle): Promise<PermissionState> =>
  folder.requestPermission(READ_WRITE);

/** Walks to a nested folder, creating each part when missing. */
async function openFolder(
  root: FileSystemDirectoryHandle,
  parts: readonly string[],
): Promise<FileSystemDirectoryHandle> {
  let folder = root;
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create: true });
  return folder;
}

/**
 * Opens a file, reporting whether this call created it.
 *
 * Chrome creates an empty file immediately, so cleanup must know which files
 * are new and which were already the user's.
 */
async function openOutput(
  folder: FileSystemDirectoryHandle,
  name: string,
): Promise<{ handle: FileSystemFileHandle; isNew: boolean }> {
  try {
    return { handle: await folder.getFileHandle(name), isNew: false };
  } catch (error) {
    if ((error as Error).name !== "NotFoundError") throw error;
    return { handle: await folder.getFileHandle(name, { create: true }), isNew: true };
  }
}

/** Streams a response into a file, committing only when the size is right. */
async function streamToFile(
  folder: FileSystemDirectoryHandle,
  name: string,
  { response, signal, onActivity }: SaveRequest,
): Promise<FileSystemFileHandle> {
  const expected = Number(response.headers.get("content-length")) || 0;
  const { handle, isNew } = await openOutput(folder, name);
  let bytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      onActivity({ stage: "downloading", done: bytes, total: expected });
      controller.enqueue(chunk);
    },
    flush() {
      if (bytes === 0 || (expected > 0 && bytes !== expected)) {
        throw new RetryableError("download_size_mismatch");
      }
    },
  });

  const body = response.body as ReadableStream<Uint8Array>;
  try {
    const writable = await handle.createWritable();
    await body.pipeThrough(counter).pipeTo(writable as WritableStream<Uint8Array>, { signal });
  } catch (error) {
    if (isNew) await removeFiles(folder, [name]);
    throw error;
  }
  return handle;
}

/** Removes files from a failed attempt, ignoring any already gone. */
async function removeFiles(folder: FileSystemDirectoryHandle, names: readonly string[]): Promise<void> {
  for (const name of names) await folder.removeEntry(name).catch(() => undefined);
}

/** Extracts and doubly verifies every file in a saved ZIP. */
async function extractAlbum(zipFile: File, request: SaveRequest): Promise<void> {
  const { root, release, signal, onActivity } = request;
  const entries = await readEntries(zipFile);
  const destination = await openFolder(root, releaseFolders(release));
  const created: string[] = [];

  try {
    for (const [index, entry] of entries.entries()) {
      signal.throwIfAborted();
      onActivity({ stage: "unzipping", done: index, total: entries.length });
      const { handle: output, isNew } = await openOutput(destination, entry.outputName);
      if (isNew) created.push(entry.outputName);
      await extractEntry(zipFile, entry, await output.createWritable(), signal);

      // A fresh File object proves the bytes on disk are correct.
      const saved = await output.getFile();
      if (saved.size !== entry.uncompressedSize || (await crc32OfBlob(saved)) !== entry.crc) {
        throw new ZipError("read_back_mismatch");
      }
    }
  } catch (error) {
    await removeFiles(destination, created);
    throw error;
  }
}

/** Copies a temporary ZIP to its permanent location. */
async function keepZip(zipFile: File, request: SaveRequest): Promise<void> {
  const artistFolder = await openFolder(request.root, [safeName(request.release.artist)]);
  const output = await artistFolder.getFileHandle(albumZipName(request.release), { create: true });
  const source = zipFile.stream() as ReadableStream<Uint8Array>;
  await source.pipeTo((await output.createWritable()) as WritableStream<Uint8Array>, {
    signal: request.signal,
  });
}

/**
 * Saves one release.
 *
 * @returns `files` when saved ready to play, or `zip` when kept as a ZIP.
 * @throws RetryableError when a damaged download should be attempted again.
 */
export async function saveRelease(request: SaveRequest): Promise<"files" | "zip"> {
  const { root, release, format, autoUnzip } = request;

  if (release.kind === "track") {
    const folder = await openFolder(root, releaseFolders(release));
    await streamToFile(folder, trackFileName(release, format), request);
    return "files";
  }
  if (!autoUnzip) {
    const folder = await openFolder(root, [safeName(release.artist)]);
    await streamToFile(folder, albumZipName(release), request);
    return "zip";
  }

  const tempFolder = await root.getDirectoryHandle(TEMP_FOLDER, { create: true });
  const tempName = `${safeName(release.key)}.zip`;
  const tempHandle = await streamToFile(tempFolder, tempName, request);
  const zipFile = await tempHandle.getFile();
  let result: "files" | "zip" = "files";

  try {
    await extractAlbum(zipFile, request);
  } catch (error) {
    if (!(error instanceof ZipError)) throw error;
    if (!error.shouldKeepZip) {
      await tempFolder.removeEntry(tempName).catch(() => undefined);
      throw new RetryableError(error.code);
    }
    await keepZip(zipFile, request);
    result = "zip";
  }
  await tempFolder.removeEntry(tempName);
  return result;
}

/** Removes the temporary folder after a finished run. */
export async function cleanTempFolder(root: FileSystemDirectoryHandle): Promise<void> {
  await root.removeEntry(TEMP_FOLDER, { recursive: true }).catch(() => undefined);
}
