/**
 * storage.ts: saves settings, progress, and the folder handle.
 *
 * Purpose:  Keep everything in one small IndexedDB database.
 * Why IDB:  It can store folder handles, which chrome.storage cannot.
 * Privacy:  Data stays in this Chrome profile. Libraries include signed
 *           redownload links, which are never logged or sent anywhere else.
 *           Removing the extension deletes this database.
 */
import { normalizePreferences } from "./formats.js";
import type { Library, Settings } from "./types.js";

const DB_NAME = "thisonetime";
const STORE_NAME = "data";
const SETTINGS_KEY = "settings";
const FOLDER_KEY = "folder";

/** Keeps each fan's progress separate if the Bandcamp account changes. */
const libraryKey = (fanId: number): string => `library:${fanId}`;

/** Opens the database, creating its single object store on first use. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs one operation and waits until it is durably committed. */
async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

const read = <T>(key: string): Promise<T | undefined> =>
  withStore("readonly", (store) => store.get(key) as IDBRequest<T | undefined>);

const write = async (key: string, value: unknown): Promise<void> => {
  await withStore("readwrite", (store) => store.put(value, key));
};

/** Loads settings, filling in defaults and repairing the format list. */
export async function loadSettings(): Promise<Settings> {
  const saved = await read<Partial<Settings>>(SETTINGS_KEY);
  return {
    formats: normalizePreferences(saved?.formats),
    autoUnzip: saved?.autoUnzip ?? true,
    includeHidden: saved?.includeHidden ?? false,
  };
}

export const saveSettings = (settings: Settings): Promise<void> => write(SETTINGS_KEY, settings);

export const loadLibrary = (fanId: number): Promise<Library | undefined> =>
  read<Library>(libraryKey(fanId));

export const saveLibrary = (library: Library): Promise<void> =>
  write(libraryKey(library.fanId), library);

export const loadFolder = (): Promise<FileSystemDirectoryHandle | undefined> =>
  read<FileSystemDirectoryHandle>(FOLDER_KEY);

export const saveFolder = (folder: FileSystemDirectoryHandle): Promise<void> =>
  write(FOLDER_KEY, folder);
