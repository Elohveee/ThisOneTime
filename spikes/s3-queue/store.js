/**
 * store.js: saves the queue and folder handle across tab closes.
 *
 * Purpose:   Keep one durable record of the run in IndexedDB.
 * Why IDB:   It can store folder handles, and it handles frequent small saves.
 * Privacy:   Saved data stays in this browser profile and includes signed
 *            redownload URLs. "Start over" deletes it, as does removing the
 *            extension. It never appears in the report.
 */

const DB_NAME = "thisonetime-s3";
const STORE_NAME = "run";
const STATE_KEY = "state";
const HANDLE_KEY = "folder";

/** Opens the database, creating its single object store on first use. */
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs one IndexedDB operation and waits until it is durably committed. */
async function withStore(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
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

export const store = {
  loadState: () => withStore("readonly", (objects) => objects.get(STATE_KEY)),
  saveState: (state) => withStore("readwrite", (objects) => objects.put(state, STATE_KEY)),
  loadHandle: () => withStore("readonly", (objects) => objects.get(HANDLE_KEY)),
  saveHandle: (handle) => withStore("readwrite", (objects) => objects.put(handle, HANDLE_KEY)),
  clear: () => withStore("readwrite", (objects) => objects.clear()),
};
